import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import GraphPanel from './components/GraphPanel';
import EvidencePanel from './components/EvidencePanel';
import {
  Upload,
  RefreshCw,
  Network,
  MessageSquare,
  Database,
  Settings as SettingsIcon,
  FileText,
  Loader2
} from 'lucide-react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import axios from 'axios';
import { getLayoutedElements } from './utils/layout';
import type { ChatMessage, Community } from './types';

type View = 'chat' | 'graph' | 'docs';

function App() {
  const [activeView, setActiveView] = useState<View>('chat');

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  // Graph state
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [yearFilter, setYearFilter] = useState(2026);

  // Filter state
  const [topK, setTopK] = useState(15);
  const [docTypeFilter, setDocTypeFilter] = useState('');
  const [personFilter, setPersonFilter] = useState('');
  const [orgFilter, setOrgFilter] = useState('');

  // Evidence panel state
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);
  const [isExtractingInsights, setIsExtractingInsights] = useState(false);
  const hasAutoTriggered = useRef(false);

  // --- Helpers ---

  /** Apply force layout to raw nodes/edges and persist positions */
  const applyForceLayout = useCallback((rawNodes: Node[], rawEdges: Edge[]) => {
    if (rawNodes.length === 0) {
      setNodes([]);
      setEdges(rawEdges);
      return;
    }

    // Enrich nodes with degree for sizing
    const degree = new Map<string, number>();
    for (const e of rawEdges) {
      degree.set(e.source, (degree.get(e.source) || 0) + 1);
      degree.set(e.target, (degree.get(e.target) || 0) + 1);
    }
    const enriched = rawNodes.map((n) => ({
      ...n,
      data: { ...n.data, degree: degree.get(n.id) || 0 },
    }));

    const { nodes: laid, edges: laidEdges } = getLayoutedElements(enriched, rawEdges);
    setNodes(laid);
    setEdges(laidEdges);

    // Persist positions to backend
    const updates = laid.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
    axios.post('/api/graph/positions', updates).catch(() => {});
  }, [setNodes, setEdges]);

  const loadGraph = async () => {
    try {
      const res = await axios.get('/api/graph');
      const rawNodes: Node[] = res.data.nodes || [];
      const rawEdges: Edge[] = res.data.edges || [];
      if (res.data.communities) {
        setCommunities(res.data.communities);
      }

      if (rawNodes.length > 0) {
        // Enrich with degree
        const degree = new Map<string, number>();
        for (const e of rawEdges) {
          degree.set(e.source, (degree.get(e.source) || 0) + 1);
          degree.set(e.target, (degree.get(e.target) || 0) + 1);
        }
        const enriched = rawNodes.map((n) => ({
          ...n,
          data: { ...n.data, degree: degree.get(n.id) || 0 },
        }));

        // Check if nodes already have spread positions (not all stacked)
        const positions = enriched.map((n) => `${Math.round(n.position.x)},${Math.round(n.position.y)}`);
        const uniquePositions = new Set(positions);
        const hasLayout = uniquePositions.size > Math.min(enriched.length * 0.5, 3);

        if (hasLayout) {
          setNodes(enriched);
          setEdges(rawEdges);
        } else {
          applyForceLayout(enriched, rawEdges);
        }
      } else {
        setNodes([]);
        setEdges(rawEdges);
      }
    } catch (err: any) {
      console.error("Failed to load graph:", err);
    }
  };

  useEffect(() => {
    loadGraph();
  }, [setNodes, setEdges]);

  const onNodeDragStop = async (_: any, node: Node) => {
    try {
      await axios.post('/api/graph/positions', [{
        id: node.id, x: node.position.x, y: node.position.y
      }]);
    } catch (err) {
      console.error("Failed to save position:", err);
    }
  };

  const onLayout = useCallback(() => {
    applyForceLayout(nodes, edges);
  }, [nodes, edges, applyForceLayout]);

  const triggerInsights = async () => {
    setIsSyncing(true);
    setIsExtractingInsights(true);
    try {
      const res = await axios.get('/api/insights');
      const rawNodes: Node[] = res.data.nodes || [];
      const rawEdges: Edge[] = res.data.edges || [];
      if (res.data.communities) {
        setCommunities(res.data.communities);
      }
      applyForceLayout(rawNodes, rawEdges);
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setIsSyncing(false);
      setIsExtractingInsights(false);
    }
  };

  // Auto-trigger insights when Graph tab is opened and graph is empty
  useEffect(() => {
    if (activeView === 'graph' && nodes.length === 0 && !hasAutoTriggered.current && !isSyncing) {
      hasAutoTriggered.current = true;
      triggerInsights();
    }
  }, [activeView, nodes.length]);

  // --- Year filter logic ---
  const filteredEdges = useMemo(() => {
    if (yearFilter >= 2026) return edges; // "All" — show everything
    return edges.filter((e) => {
      const dateMentioned = e.data?.date_mentioned;
      if (!dateMentioned) return true; // edges without dates always visible
      const year = parseInt(dateMentioned.slice(0, 4), 10);
      return !isNaN(year) && year <= yearFilter;
    });
  }, [edges, yearFilter]);

  const filteredNodes = useMemo(() => {
    if (yearFilter >= 2026) return nodes; // "All"
    const visibleNodeIds = new Set<string>();
    for (const e of filteredEdges) {
      visibleNodeIds.add(e.source);
      visibleNodeIds.add(e.target);
    }
    // Also show nodes with no edges (orphans) so they don't vanish
    const connectedNodeIds = new Set<string>();
    for (const e of edges) {
      connectedNodeIds.add(e.source);
      connectedNodeIds.add(e.target);
    }
    return nodes.filter((n) => visibleNodeIds.has(n.id) || !connectedNodeIds.has(n.id));
  }, [nodes, edges, filteredEdges, yearFilter]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('file', file);
    try {
      await axios.post('/api/upload', formData);
      triggerInsights();
    } catch (err) {
      console.error(err);
    }
  };

  const handleNodeClick = useCallback((node: Node) => {
    setSelectedEdge(null);
    setSelectedNode(node);
  }, []);

  const handleEdgeClick = useCallback((edge: Edge) => {
    setSelectedNode(null);
    setSelectedEdge(edge);
  }, []);

  const closePanel = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  const sendQuery = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      sources: [],
      timestamp: Date.now(),
      isStreaming: false,
    };

    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      sources: [],
      timestamp: Date.now(),
      isStreaming: true,
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInputValue('');
    setIsStreaming(true);

    try {
      const body: any = { query: text, top_k: topK, stream: true };
      if (docTypeFilter) body.doc_type = docTypeFilter;
      if (personFilter) body.person_filter = personFilter;
      if (orgFilter) body.org_filter = orgFilter;

      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let finalSources: any[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.error) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, error: data.error, isStreaming: false } : m
              ));
            } else if (data.text) {
              fullText += data.text;
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: fullText } : m
              ));
            }
            if (data.sources) {
              finalSources = data.sources;
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, isStreaming: false, sources: finalSources, content: fullText || m.content }
          : m
      ));

      if (!fullText) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, error: 'No response received from analysis.', isStreaming: false } : m
        ));
      }
    } catch (err: any) {
      console.error(err);
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, error: `Analysis failed: ${err.message}`, isStreaming: false } : m
      ));
    } finally {
      setIsStreaming(false);
    }
  };

  const handleSend = () => sendQuery(inputValue.trim());
  const handleSuggestedQuery = (query: string) => sendQuery(query);

  const tabs: { id: View; label: string; icon: typeof MessageSquare }[] = [
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'graph', label: 'Graph', icon: Network },
    { id: 'docs', label: 'Docs', icon: Database },
  ];

  return (
    <div className="h-screen flex flex-col bg-black text-white font-sans overflow-hidden">

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden">

        {activeView === 'chat' && (
          <>
            {/* iOS Large Title Header with Status Pill */}
            <header className="shrink-0 px-5 pt-4 pb-2 bg-black">
              <div className="flex items-center justify-between">
                <h1 className="text-[28px] font-bold tracking-tight text-white">Chat</h1>
                <button
                  onClick={triggerInsights}
                  disabled={isSyncing}
                  className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full text-[13px] font-medium border border-[rgba(84,84,88,0.65)]"
                >
                  <div className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-[#FF9F0A] animate-pulse' : 'bg-[#30D158]'}`} />
                  <span className="text-[rgba(235,235,245,0.6)]">
                    {isSyncing ? 'Syncing...' : `${nodes.length} entities`}
                  </span>
                  <RefreshCw size={12} className={`text-[rgba(235,235,245,0.3)] ${isSyncing ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </header>

            <ChatArea messages={messages} onSuggestedQuery={handleSuggestedQuery} />

            <InputBar
              value={inputValue}
              onChange={setInputValue}
              onSend={handleSend}
              isStreaming={isStreaming}
              topK={topK}
              onTopKChange={setTopK}
              docTypeFilter={docTypeFilter}
              onDocTypeFilterChange={setDocTypeFilter}
              personFilter={personFilter}
              onPersonFilterChange={setPersonFilter}
              orgFilter={orgFilter}
              onOrgFilterChange={setOrgFilter}
            />
          </>
        )}

        {activeView === 'graph' && (
          <div className="flex-1 flex flex-col h-full relative">
            <header className="shrink-0 px-5 pt-4 pb-2 bg-black flex items-center justify-between">
              <h1 className="text-[28px] font-bold tracking-tight text-white">Graph</h1>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full border border-[rgba(84,84,88,0.65)]">
                  <span className="text-[13px] font-mono text-[rgba(235,235,245,0.6)]">
                    {yearFilter >= 2026 ? 'All' : yearFilter}
                  </span>
                  <input
                    type="range" min="1980" max="2026" value={yearFilter}
                    onChange={(e) => setYearFilter(parseInt(e.target.value))}
                    className="w-20 h-1 bg-[#3A3A3C] rounded-lg appearance-none cursor-pointer accent-[#007AFF]"
                  />
                </div>
                <button
                  onClick={onLayout}
                  className="flex items-center gap-1.5 bg-[#1C1C1E] hover:bg-[#2C2C2E] px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.6)]"
                >
                  Web Layout
                </button>
              </div>
            </header>
            <div className="flex-1 relative">
              {/* Loading overlay */}
              {isExtractingInsights && (
                <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
                  <Loader2 size={40} className="text-[#007AFF] animate-spin mb-4" />
                  <p className="text-[15px] font-medium text-white">Extracting entities from your documents...</p>
                  <p className="text-[13px] text-[rgba(235,235,245,0.4)] mt-1">This may take a moment</p>
                </div>
              )}

              {/* Empty state */}
              {!isExtractingInsights && nodes.length === 0 && (
                <div className="absolute inset-0 z-40 flex flex-col items-center justify-center">
                  <Network size={48} className="text-[rgba(235,235,245,0.2)] mb-4" />
                  <p className="text-[15px] font-medium text-[rgba(235,235,245,0.6)]">No entities found</p>
                  <p className="text-[13px] text-[rgba(235,235,245,0.3)] mt-1">Upload PDFs in the Docs tab to build the graph</p>
                </div>
              )}

              <GraphPanel
                open={true}
                onClose={() => {}}
                nodes={filteredNodes}
                edges={filteredEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStop={onNodeDragStop}
                onNodeClick={handleNodeClick}
                onEdgeClick={handleEdgeClick}
                yearFilter={yearFilter}
                onYearFilterChange={setYearFilter}
                onLayout={onLayout}
                communities={communities}
              />
            </div>
          </div>
        )}

        {activeView === 'docs' && (
          <div className="flex-1 flex flex-col overflow-y-auto">
            <header className="shrink-0 px-5 pt-4 pb-2 bg-black">
              <h1 className="text-[28px] font-bold tracking-tight text-white">Docs</h1>
            </header>
            <div className="flex-1 px-5 pb-4">
              <div className="max-w-4xl mx-auto w-full">
                <div className="flex justify-between items-center mb-6">
                  <p className="text-[rgba(235,235,245,0.6)] text-[15px]">Upload and manage documents for analysis.</p>

                  <label className="flex items-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] px-4 py-2 rounded-full text-[15px] font-semibold cursor-pointer transition-colors active:scale-95">
                    <Upload size={16} />
                    Upload PDF
                    <input type="file" className="hidden" onChange={handleUpload} />
                  </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6 flex flex-col items-center justify-center text-center border-dashed min-h-[200px]">
                     <FileText size={40} className="text-[rgba(235,235,245,0.3)] mb-4" />
                     <h3 className="font-semibold text-white text-[15px]">No active files selected</h3>
                     <p className="text-[13px] text-[rgba(235,235,245,0.3)] mt-1 max-w-[200px]">Uploaded files will appear here once indexed by the GraphRAG engine.</p>
                  </div>

                  <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6">
                     <h3 className="font-semibold mb-4 text-[15px] flex items-center gap-2 text-white">
                       <SettingsIcon size={16} className="text-[rgba(235,235,245,0.3)]" />
                       Indexing Configuration
                     </h3>
                     <div className="space-y-4">
                       <div>
                         <label className="text-[13px] font-medium text-[rgba(235,235,245,0.6)] block mb-2">Chunk Size</label>
                         <div className="h-1.5 w-full bg-[#3A3A3C] rounded-full">
                           <div className="h-full w-[60%] bg-[#007AFF] rounded-full" />
                         </div>
                       </div>
                       <div>
                         <label className="text-[13px] font-medium text-[rgba(235,235,245,0.6)] block mb-2">Confidence Threshold</label>
                         <div className="h-1.5 w-full bg-[#3A3A3C] rounded-full">
                           <div className="h-full w-[85%] bg-[#007AFF] rounded-full" />
                         </div>
                       </div>
                     </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Evidence Panel (bottom sheet, works across views) */}
        <EvidencePanel
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          allEdges={edges}
          allNodes={nodes}
          onClose={closePanel}
        />
      </main>

      {/* iOS Bottom Tab Bar */}
      <nav className="ios-tab-bar-blur bg-[rgba(28,28,30,0.88)] border-t border-[rgba(84,84,88,0.65)] shrink-0 pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-[50px]">
          {tabs.map(({ id, label, icon: Icon }) => {
            const isActive = activeView === id;
            return (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className="flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors"
              >
                <Icon size={22} className={isActive ? 'text-[#007AFF]' : 'text-[rgba(235,235,245,0.3)]'} />
                <span className={`text-[10px] font-medium ${isActive ? 'text-[#007AFF]' : 'text-[rgba(235,235,245,0.3)]'}`}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export default App;

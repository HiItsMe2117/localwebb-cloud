import { useState, useEffect, useCallback } from 'react';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import GraphPanel from './components/GraphPanel';
import EvidencePanel from './components/EvidencePanel';
import { 
  Upload, 
  RefreshCw, 
  Shield, 
  Network, 
  MessageSquare, 
  Database,
  Settings as SettingsIcon,
  ChevronRight,
  FileText
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

  const loadGraph = async () => {
    try {
      const res = await axios.get('/api/graph');
      setNodes(res.data.nodes || []);
      setEdges(res.data.edges || []);
      if (res.data.communities) {
        setCommunities(res.data.communities);
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

  const onLayout = useCallback(
    (direction: string) => {
      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(nodes, edges, direction);
      setNodes([...layoutedNodes]);
      setEdges([...layoutedEdges]);
      const updates = layoutedNodes.map(n => ({ id: n.id, x: n.position.x, y: n.position.y }));
      axios.post('/api/graph/positions', updates);
    },
    [nodes, edges, setNodes, setEdges]
  );

  const triggerInsights = async () => {
    setIsSyncing(true);
    try {
      const res = await axios.get('/api/insights');
      setNodes(res.data.nodes || []);
      setEdges(res.data.edges || []);
      if (res.data.communities) {
        setCommunities(res.data.communities);
      }
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setIsSyncing(false);
    }
  };

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

  return (
    <div className="h-screen flex bg-[#09090b] text-zinc-100 font-sans overflow-hidden">
      {/* Sidebar Navigation */}
      <aside className="w-64 border-r border-zinc-800 flex flex-col bg-[#09090b] z-50">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Shield size={18} className="text-white" />
          </div>
          <span className="font-bold tracking-tight text-lg">LocalWebb</span>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          <button
            onClick={() => setActiveView('chat')}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeView === 'chat' 
                ? 'bg-zinc-800 text-white' 
                : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
            }`}
          >
            <MessageSquare size={18} />
            Investigation Chat
          </button>
          <button
            onClick={() => setActiveView('graph')}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeView === 'graph' 
                ? 'bg-zinc-800 text-white' 
                : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
            }`}
          >
            <Network size={18} />
            Connection Map
          </button>
          <button
            onClick={() => setActiveView('docs')}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeView === 'docs' 
                ? 'bg-zinc-800 text-white' 
                : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
            }`}
          >
            <Database size={18} />
            Knowledge Base
          </button>
        </nav>

        <div className="p-4 border-t border-zinc-800">
           <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">System Status</span>
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] text-zinc-400 flex justify-between">
                  <span>Entities:</span> <span>{nodes.length}</span>
                </p>
                <p className="text-[11px] text-zinc-400 flex justify-between">
                  <span>Links:</span> <span>{edges.length}</span>
                </p>
              </div>
           </div>
           
           <button
             onClick={triggerInsights}
             disabled={isSyncing}
             className="w-full mt-4 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white py-2 rounded-lg text-xs font-semibold transition-all"
           >
             <RefreshCw size={14} className={isSyncing ? "animate-spin" : ""} />
             {isSyncing ? "Syncing Engine..." : "Sync Insights"}
           </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-[#09090b]">
        
        {activeView === 'chat' && (
          <>
            <header className="h-16 border-b border-zinc-800 flex items-center px-8 shrink-0">
               <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                 Investigation <ChevronRight size={14} /> <span className="text-white">Active Case Analysis</span>
               </h2>
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
            <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-8 shrink-0 bg-[#09090b]">
               <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-widest">Nexus Map</h2>
               <div className="flex items-center gap-4">
                  <div className="flex items-center gap-3 bg-zinc-900/50 px-3 py-1.5 rounded-lg border border-zinc-800">
                    <span className="text-[11px] font-mono text-zinc-400">{yearFilter}</span>
                    <input
                      type="range" min="1980" max="2026" value={yearFilter}
                      onChange={(e) => setYearFilter(parseInt(e.target.value))} // Corrected: setYearFilter
                      className="w-24 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                  </div>
                  <button
                    onClick={() => onLayout('TB')}
                    className="flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border border-zinc-700 text-zinc-300"
                  >
                    Auto-Layout
                  </button>
               </div>
            </header>
            <div className="flex-1">
              <GraphPanel
                open={true}
                onClose={() => {}}
                nodes={nodes}
                edges={edges}
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
          <div className="flex-1 flex flex-col p-8 overflow-y-auto">
            <div className="max-w-4xl mx-auto w-full">
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h2 className="text-2xl font-bold mb-1">Knowledge Base</h2>
                  <p className="text-zinc-500 text-sm">Upload and manage documents for analysis.</p>
                </div>
                
                <label className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-all shadow-lg shadow-blue-500/20 active:scale-95">
                  <Upload size={16} />
                  Upload PDF
                  <input type="file" className="hidden" onChange={handleUpload} />
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 flex flex-col items-center justify-center text-center border-dashed min-h-[200px]">
                   <FileText size={40} className="text-zinc-700 mb-4" />
                   <h3 className="font-semibold text-zinc-300">No active files selected</h3>
                   <p className="text-xs text-zinc-500 mt-1 max-w-[200px]">Uploaded files will appear here once indexed by the GraphRAG engine.</p>
                </div>
                
                <div className="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-6">
                   <h3 className="font-semibold mb-4 text-sm flex items-center gap-2">
                     <SettingsIcon size={16} className="text-zinc-500" />
                     Indexing Configuration
                   </h3>
                   <div className="space-y-4">
                     <div>
                       <label className="text-[10px] font-bold text-zinc-500 uppercase block mb-2">Chunk Size</label>
                       <div className="h-1.5 w-full bg-zinc-800 rounded-full">
                         <div className="h-full w-[60%] bg-blue-600 rounded-full" />
                       </div>
                     </div>
                     <div>
                       <label className="text-[10px] font-bold text-zinc-500 uppercase block mb-2">Confidence Threshold</label>
                       <div className="h-1.5 w-full bg-zinc-800 rounded-full">
                         <div className="h-full w-[85%] bg-blue-600 rounded-full" />
                       </div>
                     </div>
                   </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Evidence Panel (overlay, works across views) */}
        <EvidencePanel
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          allEdges={edges}
          allNodes={nodes}
          onClose={closePanel}
        />
      </main>
    </div>
  );
}

export default App;

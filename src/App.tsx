import { useState, useEffect, useCallback } from 'react';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import GraphPanel from './components/GraphPanel';
import EvidencePanel from './components/EvidencePanel';
import { Upload, RefreshCw, Shield, Network } from 'lucide-react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import axios from 'axios';
import { getLayoutedElements } from './utils/layout';
import type { ChatMessage, Community } from './types';

function App() {
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  // Graph state
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [graphOpen, setGraphOpen] = useState(false);
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
    <div className="h-screen flex flex-col bg-[#050510] text-[#a4b9ef] font-mono selection:bg-[#4169E1] selection:text-white crt overflow-hidden">
      {/* Terminal Header / Status Bar */}
      <header className="flex justify-between items-center px-4 py-2 border-b border-[#4169E1] bg-[#050510] shrink-0 z-50">
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center border border-[#4169E1] px-2 py-1">
            <Shield size={16} className="text-[#4169E1]" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-widest text-[#4169E1] leading-none">
              LOCALWEBB_CLOUD <span className="text-[#a4b9ef] animate-pulse">v2.0</span>
            </h1>
            <p className="text-[10px] text-[#2b4a9c] uppercase tracking-wider">
              :: INTELLIGENCE_OS :: READY
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs">
          {/* Stats Line */}
          <div className="hidden sm:flex items-center gap-4 text-[#2b4a9c]">
            <span>ENTITIES: <span className="text-[#a4b9ef]">{nodes.length}</span></span>
            <span>LINKS: <span className="text-[#a4b9ef]">{edges.length}</span></span>
            <span>CLUSTERS: <span className="text-[#a4b9ef]">{communities.length}</span></span>
            <div className="w-2 h-2 bg-[#4169E1] animate-pulse" />
          </div>

          <div className="h-4 w-px bg-[#2b4a9c]" />

          {/* Controls */}
          <button
            onClick={() => setGraphOpen(!graphOpen)}
            className={`flex items-center gap-2 px-2 py-1 transition-colors border ${
              graphOpen
                ? 'bg-[#4169E1] text-[#050510] border-[#4169E1]'
                : 'bg-transparent text-[#4169E1] border-[#4169E1] hover:bg-[#4169E1]/10'
            }`}
          >
            <Network size={14} />
            <span className="hidden sm:inline">[ GRAPH: {graphOpen ? 'ON' : 'OFF'} ]</span>
          </button>

          <button
            onClick={triggerInsights}
            disabled={isSyncing}
            className="flex items-center gap-2 text-[#4169E1] hover:text-[#a4b9ef] disabled:text-[#2b4a9c] transition-colors"
          >
            <RefreshCw size={14} className={isSyncing ? "animate-spin" : ""} />
            <span className="hidden sm:inline">
              {isSyncing ? "[ SYNCING... ]" : "[ SYNC ]"}
            </span>
          </button>

          <label className="flex items-center gap-2 text-[#4169E1] hover:text-[#a4b9ef] cursor-pointer transition-colors">
            <Upload size={14} />
            <span className="hidden sm:inline">[ UPLOAD_PDF ]</span>
            <input type="file" className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </header>

      {/* Chat Area */}
      <ChatArea messages={messages} onSuggestedQuery={handleSuggestedQuery} />

      {/* Input Bar */}
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

      {/* Graph Panel */}
      <GraphPanel
        open={graphOpen}
        onClose={() => setGraphOpen(false)}
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

      {/* Evidence Panel */}
      <EvidencePanel
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        allEdges={edges}
        allNodes={nodes}
        onClose={closePanel}
      />
    </div>
  );
}

export default App;

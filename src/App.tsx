import React, { useState, useEffect, useCallback, useRef } from 'react';
import NexusCanvas from './components/NexusCanvas';
import EvidencePanel from './components/EvidencePanel';
import { Upload, MessageSquare, Layout, Clock, RefreshCw, Database, Shield, FileText, Settings2, Network } from 'lucide-react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import axios from 'axios';
import { getLayoutedElements } from './utils/layout';

interface Source {
  filename: string;
  page: number | string;
  score: number | null;
}

interface Community {
  id: number;
  color: string;
  members: string[];
  size: number;
}

function App() {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [yearFilter, setYearFilter] = useState(2026);
  const [topK, setTopK] = useState(15);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const responseRef = useRef<HTMLDivElement>(null);

  // Evidence panel state
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);

  // Filter state
  const [docTypeFilter, setDocTypeFilter] = useState('');
  const [personFilter, setPersonFilter] = useState('');
  const [orgFilter, setOrgFilter] = useState('');

  // Community state
  const [communities, setCommunities] = useState<Community[]>([]);

  const loadGraph = async () => {
    try {
      setError(null);
      const res = await axios.get('/api/graph');
      setNodes(res.data.nodes || []);
      setEdges(res.data.edges || []);
      if (res.data.communities) {
        setCommunities(res.data.communities);
      }
    } catch (err: any) {
      console.error("Failed to load graph:", err);
      setError(`Failed to load graph: ${err.response?.data?.detail || err.message}`);
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

  const handleQuery = async () => {
    setIsAnalyzing(true);
    setError(null);
    setResponse('');
    setSources([]);
    try {
      const body: any = { query, top_k: topK, stream: true };
      if (docTypeFilter) body.doc_type = docTypeFilter;
      if (personFilter) body.person_filter = personFilter;
      if (orgFilter) body.org_filter = orgFilter;

      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

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
              setError(data.error);
            } else if (data.text) {
              fullText += data.text;
              setResponse(fullText);
            }
            if (data.sources) {
              setSources(data.sources);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      if (!fullText && !error) {
        setError('No response received from analysis.');
      }
    } catch (err: any) {
      console.error(err);
      setError(`Analysis failed: ${err.message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const DOC_TYPES = [
    { value: '', label: 'All Documents' },
    { value: 'flight_log', label: 'Flight Logs' },
    { value: 'deposition', label: 'Depositions' },
    { value: 'financial_record', label: 'Financial Records' },
    { value: 'correspondence', label: 'Correspondence' },
    { value: 'legal_filing', label: 'Legal Filings' },
    { value: 'report', label: 'Reports' },
    { value: 'other', label: 'Other' },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-zinc-100 p-6 font-sans flex flex-col selection:bg-blue-500/30">
      {/* Header */}
      <header className="flex justify-between items-center mb-8 border-b border-white/5 pb-6">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-xl flex items-center justify-center shadow-lg shadow-blue-900/20">
            <Shield size={22} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tighter text-white">LOCALWEBB <span className="text-blue-500">CLOUD</span></h1>
            <p className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase">Investigative Intelligence OS</p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={triggerInsights}
            disabled={isSyncing}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all border border-blue-400/20 active:scale-95"
          >
            <RefreshCw size={16} className={isSyncing ? "animate-spin" : ""} />
            <span>{isSyncing ? "Syncing Cloud..." : "Sync with Cloud"}</span>
          </button>

          <button
            onClick={() => onLayout('TB')}
            className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 px-4 py-2 rounded-lg text-sm font-medium transition-all border border-white/5"
          >
            <Layout size={16} />
            <span>Auto-Layout</span>
          </button>

          <label className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all border border-white/5">
            <Upload size={16} />
            <span>Upload PDF</span>
            <input type="file" className="hidden" onChange={handleUpload} />
          </label>
        </div>
      </header>

      {/* Main Content */}
      <main className="grid grid-cols-12 gap-8 flex-grow">
        <div className="col-span-8 flex flex-col gap-4">
          <div className="flex justify-between items-end px-2">
            <div>
              <h2 className="text-zinc-500 uppercase text-[10px] font-bold tracking-[0.2em]">Relational Mapping</h2>
              <p className="text-white font-medium">Visual Nexus Canvas</p>
            </div>
            <div className="flex items-center gap-4 bg-zinc-900/50 backdrop-blur-md px-4 py-2 rounded-xl border border-white/5 shadow-2xl">
               <Clock size={14} className="text-blue-400" />
               <span className="text-xs font-mono text-zinc-400">Timeline: {yearFilter}</span>
               <input
                  type="range" min="1980" max="2026" value={yearFilter}
                  onChange={(e) => setYearFilter(parseInt(e.target.value))}
                  className="w-24 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
               />
            </div>
          </div>

          <div className="flex-grow rounded-2xl overflow-hidden border border-white/5 bg-[#0d0d0f] shadow-inner relative group">
            <div className="absolute inset-0 bg-[radial-gradient(#ffffff05_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none"></div>
            <NexusCanvas
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={handleNodeClick}
              onEdgeClick={handleEdgeClick}
            />
          </div>

          {/* Community Legend */}
          {communities.length > 0 && (
            <div className="flex items-center gap-3 px-2 py-2 bg-zinc-900/50 rounded-xl border border-white/5">
              <Network size={14} className="text-zinc-500" />
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Clusters:</span>
              <div className="flex flex-wrap gap-2">
                {communities.map((c) => (
                  <div key={c.id} className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: c.color }} />
                    <span className="text-[10px] text-zinc-400 font-mono">
                      {c.size} entities
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="col-span-4 flex flex-col gap-6">
          <div className="bg-[#0d0d0f] rounded-2xl p-6 border border-white/5 shadow-xl">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center">
                  <MessageSquare size={16} className="text-blue-400" />
                </div>
                <h2 className="text-white font-bold text-sm">Intelligence Query</h2>
              </div>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center transition-all"
                title="Query settings"
              >
                <Settings2 size={14} className="text-zinc-400" />
              </button>
            </div>

            {showSettings && (
              <div className="mb-4 p-3 bg-zinc-900/50 rounded-xl border border-white/5 flex flex-col gap-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Context Depth (top_k)</span>
                    <span className="text-xs font-mono text-blue-400">{topK}</span>
                  </div>
                  <input
                    type="range" min="5" max="50" value={topK}
                    onChange={(e) => setTopK(parseInt(e.target.value))}
                    className="w-full h-1 mt-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                </div>

                <div>
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Document Type</span>
                  <select
                    value={docTypeFilter}
                    onChange={(e) => setDocTypeFilter(e.target.value)}
                    className="w-full mt-1 bg-zinc-800 border border-white/5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
                  >
                    {DOC_TYPES.map(dt => (
                      <option key={dt.value} value={dt.value}>{dt.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Person Filter</span>
                  <input
                    type="text"
                    value={personFilter}
                    onChange={(e) => setPersonFilter(e.target.value)}
                    placeholder="e.g. Jeffrey Epstein"
                    className="w-full mt-1 bg-zinc-800 border border-white/5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
                  />
                </div>

                <div>
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Organization Filter</span>
                  <input
                    type="text"
                    value={orgFilter}
                    onChange={(e) => setOrgFilter(e.target.value)}
                    placeholder="e.g. JPMorgan Chase"
                    className="w-full mt-1 bg-zinc-800 border border-white/5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
                  />
                </div>

                <p className="text-[9px] text-zinc-600">Filters narrow search to matching document chunks only</p>
              </div>
            )}

            <div className="flex flex-col gap-4">
              <div className="relative group">
                <textarea
                  className="w-full bg-zinc-900/50 border border-white/5 rounded-xl p-4 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 min-h-[140px] transition-all"
                  placeholder="Ask about connections, financial trails, or hidden locations... Try: 'How is Person A connected to Organization B?'"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleQuery(); } }}
                />
                <div className="absolute bottom-3 right-3 text-[9px] font-mono text-zinc-600">GEMINI 2.5 PRO + GraphRAG</div>
              </div>

              <button
                onClick={handleQuery}
                disabled={isAnalyzing}
                className={`w-full font-bold py-3 rounded-xl transition-all shadow-lg active:scale-[0.98] ${
                  isAnalyzing
                    ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                    : 'bg-white text-black hover:shadow-white/10'
                }`}
              >
                {isAnalyzing ? (
                  <span className="flex items-center justify-center gap-2">
                    <RefreshCw size={16} className="animate-spin" /> Deep Analysis...
                  </span>
                ) : 'Run Analysis'}
              </button>
            </div>

            {error && (
              <div className="mt-4 p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm flex items-center gap-3">
                <Shield size={16} className="shrink-0" />
                <p>{error}</p>
              </div>
            )}

            {response && (
              <div ref={responseRef} className="mt-6">
                <div className="p-5 bg-blue-500/5 rounded-xl text-sm leading-relaxed border border-blue-500/10 text-zinc-300 relative whitespace-pre-wrap">
                  <div className="absolute top-0 left-0 w-1 h-full bg-blue-500 rounded-full"></div>
                  {response}
                </div>

                {sources.length > 0 && (
                  <div className="mt-3 p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                    <div className="flex items-center gap-2 mb-2">
                      <FileText size={12} className="text-zinc-500" />
                      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Sources ({sources.length})</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {sources.map((s, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-zinc-400 truncate max-w-[70%]">{s.filename}</span>
                          {s.score && (
                            <span className="text-[10px] font-mono text-zinc-600">{(s.score * 100).toFixed(0)}% match</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-[#0d0d0f] rounded-2xl p-6 border border-white/5 shadow-xl">
             <div className="flex items-center gap-3 mb-6">
                <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center">
                  <Database size={16} className="text-indigo-400" />
                </div>
                <h3 className="text-white font-bold text-sm">Cloud Index Status</h3>
             </div>

             <div className="grid grid-cols-3 gap-3">
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                   <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1">Entities</p>
                   <p className="text-2xl font-black text-white leading-none">{nodes.length}</p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                   <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1">Links</p>
                   <p className="text-2xl font-black text-blue-500 leading-none">{edges.length}</p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                   <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1">Clusters</p>
                   <p className="text-2xl font-black text-purple-500 leading-none">{communities.length}</p>
                </div>
             </div>

             <div className="mt-4 flex items-center justify-between p-3 bg-indigo-500/5 rounded-lg border border-indigo-500/10">
                <span className="text-[10px] text-indigo-300 font-mono uppercase">Provider: PINECONE DB + GraphRAG</span>
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
             </div>
          </div>
        </div>
      </main>

      {/* Evidence Panel (overlay) */}
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

import React, { useState, useEffect, useCallback } from 'react';
import NexusCanvas from './components/NexusCanvas';
import { Upload, MessageSquare, Search, Layout, Clock, RefreshCw, Database, Shield } from 'lucide-react';
import { useNodesState, useEdgesState } from 'reactflow';
import type { Node } from 'reactflow';
import axios from 'axios';
import { getLayoutedElements } from './utils/layout';

function App() {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [yearFilter, setYearFilter] = useState(2026);

  const loadGraph = async () => {
    try {
      const res = await axios.get('/api/graph');
      setNodes(res.data.nodes || []);
      setEdges(res.data.edges || []);
    } catch (err) {
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

  const handleQuery = async () => {
    setIsAnalyzing(true);
    try {
      const res = await axios.post('/api/query', { query });
      setResponse(res.data.response);
    } catch (err) {
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

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
            />
          </div>
        </div>

        {/* Sidebar */}
        <div className="col-span-4 flex flex-col gap-6">
          <div className="bg-[#0d0d0f] rounded-2xl p-6 border border-white/5 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center">
                <MessageSquare size={16} className="text-blue-400" />
              </div>
              <h2 className="text-white font-bold text-sm">Intelligence Query</h2>
            </div>
            
            <div className="flex flex-col gap-4">
              <div className="relative group">
                <textarea 
                  className="w-full bg-zinc-900/50 border border-white/5 rounded-xl p-4 text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 min-h-[140px] transition-all"
                  placeholder="Ask about connections, financial trails, or hidden locations..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div className="absolute bottom-3 right-3 text-[9px] font-mono text-zinc-600">GEMINI 2.5 PRO</div>
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
            
            {response && (
              <div className="mt-6 p-5 bg-blue-500/5 rounded-xl text-sm leading-relaxed border border-blue-500/10 text-zinc-300 relative">
                <div className="absolute top-0 left-0 w-1 h-full bg-blue-500 rounded-full"></div>
                {response}
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
             
             <div className="grid grid-cols-2 gap-3">
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                   <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1">Entities</p>
                   <p className="text-2xl font-black text-white leading-none">{nodes.length}</p>
                </div>
                <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                   <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-1">Links</p>
                   <p className="text-2xl font-black text-blue-500 leading-none">{edges.length}</p>
                </div>
             </div>
             
             <div className="mt-4 flex items-center justify-between p-3 bg-indigo-500/5 rounded-lg border border-indigo-500/10">
                <span className="text-[10px] text-indigo-300 font-mono uppercase">Provider: PINECONE DB</span>
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
             </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;

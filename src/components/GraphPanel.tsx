import { useCallback } from 'react';
import { X, Layout, Clock, Network } from 'lucide-react';
import NexusCanvas from './NexusCanvas';
import type { Node, Edge } from 'reactflow';
import type { Community } from '../types';

interface GraphPanelProps {
  open: boolean;
  onClose: () => void;
  nodes: Node[];
  edges: Edge[];
  onNodesChange: any;
  onEdgesChange: any;
  onNodeDragStop: (event: any, node: Node) => void;
  onNodeClick: (node: Node) => void;
  onEdgeClick: (edge: Edge) => void;
  yearFilter: number;
  onYearFilterChange: (v: number) => void;
  onLayout: (direction: string) => void;
  communities: Community[];
}

export default function GraphPanel({
  open, onClose,
  nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop,
  onNodeClick, onEdgeClick,
  yearFilter, onYearFilterChange,
  onLayout, communities,
}: GraphPanelProps) {
  const handleBackdropClick = useCallback(() => onClose(), [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-30 bg-black/60 transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleBackdropClick}
      />

      {/* Panel */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-40 bg-[#0a0a0c] border-t border-white/10 rounded-t-2xl shadow-2xl transition-transform duration-300 ease-out flex flex-col ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ height: '75vh' }}
      >
        {/* Header */}
        <div className="px-6 py-3 border-b border-white/5 shrink-0">
          <div className="w-10 h-1 bg-zinc-700 rounded-full mx-auto mb-3" />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <h2 className="text-white font-bold text-sm">Visual Nexus Canvas</h2>
                <p className="text-[10px] text-zinc-500 font-mono">
                  {nodes.length} entities &middot; {edges.length} links
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-3 bg-zinc-900/50 px-3 py-1.5 rounded-lg border border-white/5">
                <Clock size={12} className="text-blue-400" />
                <span className="text-[10px] font-mono text-zinc-400">{yearFilter}</span>
                <input
                  type="range" min="1980" max="2026" value={yearFilter}
                  onChange={(e) => onYearFilterChange(parseInt(e.target.value))}
                  className="w-20 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>

              <button
                onClick={() => onLayout('TB')}
                className="flex items-center gap-1.5 bg-zinc-900 hover:bg-zinc-800 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border border-white/5 text-zinc-300"
              >
                <Layout size={13} />
                <span>Auto-Layout</span>
              </button>

              <button
                onClick={onClose}
                className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center transition-all"
              >
                <X size={14} className="text-zinc-400" />
              </button>
            </div>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(#ffffff05_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none" />
          <NexusCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            height="100%"
          />
        </div>

        {/* Community legend */}
        {communities.length > 0 && (
          <div className="flex items-center gap-3 px-6 py-2 border-t border-white/5 shrink-0">
            <Network size={13} className="text-zinc-500" />
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Clusters:</span>
            <div className="flex flex-wrap gap-2">
              {communities.map((c) => (
                <div key={c.id} className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: c.color }} />
                  <span className="text-[10px] text-zinc-400 font-mono">{c.size} entities</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

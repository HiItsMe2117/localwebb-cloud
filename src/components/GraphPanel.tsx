import NexusCanvas from './NexusCanvas';
import type { Node, Edge } from 'reactflow';
import type { Community } from '../types';
import { Network } from 'lucide-react';

interface GraphPanelProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: any;
  onEdgesChange: any;
  onNodeDragStop: (event: any, node: Node) => void;
  onNodeClick: (node: Node) => void;
  onEdgeClick: (edge: Edge) => void;
  communities: Community[];
  // The following props are no longer used in the new layout, but kept for type consistency if needed elsewhere.
  // We can remove them if this becomes the only implementation.
  open: boolean;
  onClose: () => void;
  yearFilter: number;
  onYearFilterChange: (v: number) => void;
  onLayout: (direction: string) => void;
}

export default function GraphPanel({
  nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop,
  onNodeClick, onEdgeClick, communities
}: GraphPanelProps) {

  return (
    <div className="flex-1 h-full relative flex flex-col bg-zinc-950">
      {/* Canvas Area */}
      <div className="flex-1 relative overflow-hidden">
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

      {/* Modern Footer / Legend */}
      {communities.length > 0 && (
        <div className="flex items-center gap-4 px-6 py-3 border-t border-zinc-800 bg-[#09090b] shrink-0">
          <div className="flex items-center gap-2 text-zinc-500">
            <Network size={16} />
            <span className="text-xs font-bold uppercase tracking-wider">Detected Clusters:</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {communities.map((c) => (
              <div key={c.id} className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full border border-white/10" style={{ background: c.color }} />
                <span className="text-xs text-zinc-400 font-mono">
                  {c.size} <span className="text-zinc-500">nodes</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

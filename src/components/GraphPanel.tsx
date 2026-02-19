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
  open: boolean;
  onClose: () => void;
  yearFilter: number;
  onYearFilterChange: (v: number) => void;
  onLayout: () => void;
}

export default function GraphPanel({
  nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop,
  onNodeClick, onEdgeClick, communities
}: GraphPanelProps) {

  return (
    <div className="flex-1 h-full relative flex flex-col bg-black">
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
        <div className="flex items-center gap-4 px-5 py-3 border-t border-[rgba(84,84,88,0.65)] bg-[#1C1C1E] shrink-0">
          <div className="flex items-center gap-2 text-[rgba(235,235,245,0.3)]">
            <Network size={16} />
            <span className="text-[13px] font-semibold text-[rgba(235,235,245,0.6)]">Clusters:</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {communities.map((c) => (
              <div key={c.id} className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full border border-white/10" style={{ background: c.color }} />
                <span className="text-[13px] text-[rgba(235,235,245,0.6)]">
                  {c.size} <span className="text-[rgba(235,235,245,0.3)]">nodes</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
  
  if (!open) return null;

  return (
    <div className="fixed inset-x-2 bottom-2 top-[140px] z-40 bg-[#050510] border-2 border-[#4169E1] flex flex-col shadow-[0_0_20px_rgba(65,105,225,0.2)]">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-[#4169E1] text-[#050510] font-mono text-xs font-bold shrink-0">
            <span>:: NEXUS_VISUALIZER :: {nodes.length}_NODES :: {edges.length}_LINKS</span>
            <button onClick={onClose} className="hover:bg-[#050510] hover:text-[#4169E1] px-2">
                [X]
            </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[#4169E1] font-mono text-xs bg-[#050510]">
            <div className="flex items-center gap-4 text-[#4169E1]">
                <div className="flex items-center gap-2">
                    <span>FILTER_YEAR: {yearFilter}</span>
                    <input
                        type="range" min="1980" max="2026" value={yearFilter}
                        onChange={(e) => onYearFilterChange(parseInt(e.target.value))}
                        className="w-24 h-1 accent-[#4169E1] bg-[#2b4a9c]"
                    />
                </div>
            </div>

            <div className="flex items-center gap-2">
                <button
                    onClick={() => onLayout('TB')}
                    className="text-[#4169E1] hover:text-[#00ffff] hover:underline"
                >
                    [ AUTO_LAYOUT ]
                </button>
            </div>
        </div>

        {/* Canvas Area */}
        <div className="flex-1 relative overflow-hidden bg-[#050510]">
             {/* Grid Background */}
            <div className="absolute inset-0 pointer-events-none" 
                 style={{ 
                     backgroundImage: 'linear-gradient(rgba(43, 74, 156, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(43, 74, 156, 0.1) 1px, transparent 1px)',
                     backgroundSize: '20px 20px'
                 }} 
            />
            
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

        {/* Footer / Legend */}
        {communities.length > 0 && (
            <div className="px-4 py-1 border-t border-[#4169E1] bg-[#050510] font-mono text-[10px] text-[#2b4a9c] flex gap-4 overflow-x-auto">
                <span className="font-bold shrink-0">CLUSTERS_DETECTED:</span>
                {communities.map((c, i) => (
                    <span key={i} className="whitespace-nowrap flex items-center gap-1">
                        <span className="w-2 h-2 block" style={{ backgroundColor: c.color }}></span>
                        ID_{c.id} ({c.size})
                    </span>
                ))}
            </div>
        )}
    </div>
  );
}

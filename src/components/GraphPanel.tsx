import { memo } from 'react';
import NexusCanvas from './NexusCanvas';
import type { Node, Edge } from 'reactflow';
import type { Community } from '../types';

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
  minDegree: number;
  onMinDegreeChange: (v: number) => void;
  showEdgeLabels: boolean;
}

function GraphPanel({
  nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop,
  onNodeClick, onEdgeClick, communities: _communities, minDegree: _minDegree, onMinDegreeChange: _onMinDegreeChange,
  showEdgeLabels
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
          showEdgeLabels={showEdgeLabels}
        />
      </div>
    </div>
  );
}

export default memo(GraphPanel);

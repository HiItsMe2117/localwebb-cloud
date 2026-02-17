import { useCallback } from 'react';
import ReactFlow, { 
  addEdge, 
  Background, 
  Controls, 
} from 'reactflow';
import type { Connection, Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';

interface NexusProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: any;
  onEdgesChange: any;
  onNodeDragStop: any;
}

export default function NexusCanvas({ nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop }: NexusProps) {
  const onConnect = useCallback(
    (params: Connection) => onEdgesChange((eds: Edge[]) => addEdge(params, eds)),
    [onEdgesChange]
  );

  return (
    <div style={{ width: '100%', height: '70vh', border: '1px solid #333', borderRadius: '8px', background: '#050505' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        fitView
      >
        <Background color="#222" gap={20} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

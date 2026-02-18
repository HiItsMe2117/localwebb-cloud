import { useCallback, useMemo } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
} from 'reactflow';
import type { Connection, Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import EntityNode from './EntityNode';

const TYPE_COLORS: Record<string, string> = {
  PERSON: '#3b82f6',
  ORGANIZATION: '#f59e0b',
  LOCATION: '#10b981',
  EVENT: '#8b5cf6',
  DOCUMENT: '#f97316',
  FINANCIAL_ENTITY: '#ef4444',
};

interface NexusProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: any;
  onEdgesChange: any;
  onNodeDragStop: any;
  onNodeClick?: (node: Node) => void;
  onEdgeClick?: (edge: Edge) => void;
}

export default function NexusCanvas({ nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop, onNodeClick, onEdgeClick }: NexusProps) {
  const nodeTypes = useMemo(() => ({ entityNode: EntityNode }), []);

  const onConnect = useCallback(
    (params: Connection) => onEdgesChange((eds: Edge[]) => addEdge(params, eds)),
    [onEdgesChange]
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeClick?.(node);
    },
    [onNodeClick]
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      onEdgeClick?.(edge);
    },
    [onEdgeClick]
  );

  const styledEdges = useMemo(() => {
    return edges.map(e => ({
      ...e,
      labelStyle: { fill: '#a1a1aa', fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: '#0d0d0f', fillOpacity: 0.9 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      style: {
        stroke: e.data?.confidence === 'INFERRED' ? '#f59e0b' : '#3b82f6',
        strokeWidth: 1.5,
        strokeDasharray: e.data?.confidence === 'INFERRED' ? '5 5' : undefined,
        ...(e.style || {}),
      },
    }));
  }, [edges]);

  const miniMapNodeColor = useCallback((node: Node) => {
    const entityType = (node.data?.entityType || node.data?.type || '').toUpperCase();
    return TYPE_COLORS[entityType] || '#52525b';
  }, []);

  return (
    <div style={{ width: '100%', height: '70vh', border: '1px solid #333', borderRadius: '8px', background: '#050505' }}>
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: false,
        }}
      >
        <Background color="#222" gap={20} />
        <Controls />
        <MiniMap
          nodeColor={miniMapNodeColor}
          nodeStrokeWidth={2}
          style={{ background: '#0a0a0c', border: '1px solid #222' }}
          maskColor="rgba(0,0,0,0.7)"
        />
      </ReactFlow>
    </div>
  );
}

import { useCallback, useMemo } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType, // Import MarkerType
} from 'reactflow';
import type { Connection, Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import EntityNode from './EntityNode';

const TYPE_COLORS: Record<string, string> = {
  PERSON: '#60a5fa',
  ORGANIZATION: '#fbbf24',
  LOCATION: '#4ade80',
  EVENT: '#a78bfa',
  DOCUMENT: '#fb923c',
  FINANCIAL_ENTITY: '#f87171',
};

interface NexusProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: any;
  onEdgesChange: any;
  onNodeDragStop: any;
  onNodeClick?: (node: Node) => void;
  onEdgeClick?: (edge: Edge) => void;
  height?: string;
}

export default function NexusCanvas({ nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop, onNodeClick, onEdgeClick, height }: NexusProps) {
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
      labelStyle: { fill: '#a1a1aa', fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: '#18181b', fillOpacity: 0.8 },
      labelBgPadding: [8, 4] as [number, number],
      labelBgBorderRadius: 6,
      style: {
        stroke: e.selected ? '#3b82f6' : (e.data?.confidence === 'INFERRED' ? '#a1a1aa' : '#52525b'),
        strokeWidth: e.selected ? 2.5 : 1.5,
        strokeDasharray: e.data?.confidence === 'INFERRED' ? '4 4' : undefined,
        ...(e.style || {}),
      },
      markerEnd: {
        type: MarkerType.Arrow, // Use MarkerType.Arrow
        color: '#52525b',
      }
    }));
  }, [edges]);

  const miniMapNodeColor = useCallback((node: Node) => {
    const entityType = (node.data?.entityType || node.data?.type || '').toUpperCase();
    return TYPE_COLORS[entityType] || '#9ca3af';
  }, []);

  return (
    <div style={{ width: '100%', height: height || '100%', background: '#09090b' }}>
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
        <Background 
          color="#27272a" 
          variant={BackgroundVariant.Dots} 
          gap={24} 
          size={1} 
        />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={miniMapNodeColor}
          nodeStrokeWidth={2}
          maskColor="rgba(9, 9, 11, 0.6)"
        />
      </ReactFlow>
    </div>
  );
}

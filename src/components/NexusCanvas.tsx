import { useCallback, useMemo } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
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
      labelStyle: { fill: 'rgba(235,235,245,0.6)', fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: '#1C1C1E', fillOpacity: 0.9 },
      labelBgPadding: [8, 4] as [number, number],
      labelBgBorderRadius: 6,
      style: {
        stroke: e.selected ? '#007AFF' : (e.data?.confidence === 'INFERRED' ? 'rgba(235,235,245,0.3)' : 'rgba(84,84,88,0.65)'),
        strokeWidth: e.selected ? 2.5 : 1.5,
        strokeDasharray: e.data?.confidence === 'INFERRED' ? '4 4' : undefined,
        ...(e.style || {}),
      },
      markerEnd: {
        type: MarkerType.Arrow,
        color: 'rgba(84,84,88,0.65)',
      }
    }));
  }, [edges]);

  const miniMapNodeColor = useCallback((node: Node) => {
    const entityType = (node.data?.entityType || node.data?.type || '').toUpperCase();
    return TYPE_COLORS[entityType] || '#9ca3af';
  }, []);

  return (
    <div style={{ width: '100%', height: height || '100%', background: '#000000' }}>
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
          type: 'default',
          animated: false,
        }}
      >
        <Background
          color="rgba(84,84,88,0.3)"
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
        />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={miniMapNodeColor}
          nodeStrokeWidth={2}
          maskColor="rgba(0, 0, 0, 0.6)"
        />
      </ReactFlow>
    </div>
  );
}

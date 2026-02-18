import { useCallback, useMemo } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
} from 'reactflow';
import type { Connection, Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import EntityNode from './EntityNode';

const TYPE_COLORS: Record<string, string> = {
  PERSON: '#4169E1',
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
      // Retro Terminal Edge Style
      labelStyle: { fill: '#4169E1', fontSize: 10, fontFamily: 'monospace', fontWeight: 700 },
      labelBgStyle: { fill: '#050510', stroke: '#4169E1', strokeWidth: 1 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 0,
      style: {
        stroke: '#2b4a9c', // Dim blue for lines
        strokeWidth: 1,
        ...(e.style || {}),
      },
      animated: true, // Always animate data flow?
    }));
  }, [edges]);

  const miniMapNodeColor = useCallback((node: Node) => {
    const entityType = (node.data?.entityType || node.data?.type || '').toUpperCase();
    return TYPE_COLORS[entityType] || '#a4b9ef';
  }, []);

  return (
    <div style={{ width: '100%', height: height || '70vh', background: '#050510' }}>
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
          type: 'default', // Straight lines for retro feel? Or 'step'?
          animated: false,
        }}
      >
        <Background 
          color="#2b4a9c" 
          variant={BackgroundVariant.Lines} 
          gap={40} 
          size={1} 
          style={{ opacity: 0.2 }}
        />
        <Controls 
          style={{ 
            borderRadius: 0, 
            border: '1px solid #4169E1', 
            background: '#050510', 
            color: '#4169E1' 
          }} 
          showInteractive={false}
        />
        <MiniMap
          nodeColor={miniMapNodeColor}
          nodeStrokeWidth={2}
          maskColor="rgba(5, 5, 16, 0.8)"
          style={{ 
            background: '#050510', 
            border: '1px solid #4169E1', 
            borderRadius: 0 
          }}
        />
      </ReactFlow>
    </div>
  );
}

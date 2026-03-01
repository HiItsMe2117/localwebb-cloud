import { useCallback, useMemo, memo, useEffect } from 'react';
import ReactFlow, {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  useStore,
  useReactFlow,
  type ReactFlowState,
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

const EDGE_LABEL_STYLE = { fill: 'rgba(235,235,245,0.6)', fontSize: 11, fontWeight: 600 };
const EDGE_LABEL_BG_STYLE = { fill: '#1C1C1E', fillOpacity: 0.9 };
const EDGE_LABEL_BG_PADDING: [number, number] = [8, 4] as [number, number];
const EDGE_LABEL_BG_BORDER_RADIUS = 6;
const EDGE_MARKER_END = { type: MarkerType.Arrow, color: 'rgba(84,84,88,0.65)' };
const DEFAULT_EDGE_OPTIONS = { type: 'default', animated: false };

interface NexusProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: any;
  onEdgesChange: any;
  onNodeDragStop: any;
  onNodeClick?: (node: Node, event?: React.MouseEvent) => void;
  onEdgeClick?: (edge: Edge) => void;
  onPaneClick?: () => void;
  height?: string;
  showEdgeLabels?: boolean;
}

function NexusCanvas({ nodes, edges, onNodesChange, onEdgesChange, onNodeDragStop, onNodeClick, onEdgeClick, onPaneClick, height, showEdgeLabels = true }: NexusProps) {
  const nodeTypes = useMemo(() => ({ entityNode: EntityNode }), []);
  const zoom = useStore((s: ReactFlowState) => s.transform[2]);
  const { fitView } = useReactFlow();

  // Auto-fit whenever nodes are updated (like after a layout or filter change)
  useEffect(() => {
    if (nodes.length > 0) {
      fitView({ padding: 0.3, duration: 800 });
    }
  }, [nodes.length, fitView]);

  const onConnect = useCallback(
    (params: Connection) => onEdgesChange((eds: Edge[]) => addEdge(params, eds)),
    [onEdgesChange]
  );

  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      onNodeClick?.(node, event);
    },
    [onNodeClick]
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      onEdgeClick?.(edge);
    },
    [onEdgeClick]
  );

  const styledEdges = useMemo<Edge[]>(() => {
    // LOD: Hide edges completely when very zoomed out for ultimate panning speed
    if (zoom < 0.4) return [];

    const isHeavy = edges.length > 500;
    return edges.map(e => {
      const isCaseLocal = e.data?.isCaseLocal;
      return {
        ...e,
        label: (isHeavy || !showEdgeLabels) ? undefined : e.label,
        labelStyle: EDGE_LABEL_STYLE,
        labelBgStyle: EDGE_LABEL_BG_STYLE,
        labelBgPadding: EDGE_LABEL_BG_PADDING,
        labelBgBorderRadius: EDGE_LABEL_BG_BORDER_RADIUS,
        style: {
          stroke: e.selected
            ? (isCaseLocal ? '#FF453A' : '#007AFF')
            : isCaseLocal
              ? '#007AFF'
              : (e.data?.confidence === 'INFERRED' ? 'rgba(235,235,245,0.3)' : 'rgba(84,84,88,0.65)'),
          strokeWidth: e.selected ? 2.5 : (isCaseLocal ? 2 : 1.5),
          strokeDasharray: e.data?.confidence === 'INFERRED' ? '4 4' : undefined,
          pointerEvents: (isCaseLocal ? 'visibleStroke' : 'none') as 'visibleStroke' | 'none',
          ...(e.style || {}),
        },
        markerEnd: isCaseLocal ? undefined : EDGE_MARKER_END,
      };
    });
  }, [edges, zoom, showEdgeLabels]);

  const miniMapNodeColor = useCallback((node: Node) => {
    const entityType = (node.data?.entityType || node.data?.type || '').toUpperCase();
    return TYPE_COLORS[entityType] || '#9ca3af';
  }, []);

  return (
    <div style={{ width: '100%', height: height || '100%', background: '#000000', willChange: 'transform' }}>
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        onlyRenderVisibleElements={true}
        zoomOnDoubleClick={false}
      >
        <Background
          color="rgba(84,84,88,0.3)"
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
        />
        <Controls showInteractive={false} />
        {nodes.length < 1000 && (
          <MiniMap
            nodeColor={miniMapNodeColor}
            nodeStrokeWidth={2}
            maskColor="rgba(0, 0, 0, 0.6)"
          />
        )}
      </ReactFlow>
    </div>
  );
}

export default memo(NexusCanvas);

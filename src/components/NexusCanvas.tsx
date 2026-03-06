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
  useViewport,
  type ReactFlowState,
} from 'reactflow';
import type { Connection, Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import EntityNode from './EntityNode';

// Group ellipse overlay rendered inside the ReactFlow viewport
function GroupEllipses({ groups, nodes, onGroupClick }: {
  groups: GroupOverlay[];
  nodes: Node[];
  onGroupClick?: (group: GroupOverlay) => void;
}) {
  const { x: vx, y: vy, zoom } = useViewport();

  const ellipses = useMemo(() => {
    if (groups.length === 0) return [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    return groups.map(g => {
      const memberNodes = g.node_ids.map(id => nodeMap.get(id)).filter(Boolean) as Node[];
      if (memberNodes.length === 0) return null;
      const xs = memberNodes.map(n => n.position.x);
      const ys = memberNodes.map(n => n.position.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const pad = 80;
      const cx = (minX + maxX) / 2 + 60; // offset for node width
      const cy = (minY + maxY) / 2 + 25; // offset for node height
      const rx = Math.max((maxX - minX) / 2 + pad, 60);
      const ry = Math.max((maxY - minY) / 2 + pad, 50);
      return { ...g, cx, cy, rx, ry };
    }).filter(Boolean);
  }, [groups, nodes]);

  if (ellipses.length === 0) return null;

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      <g transform={`translate(${vx},${vy}) scale(${zoom})`}>
        {ellipses.map(e => e && (
          <g key={e.id}>
            <ellipse
              cx={e.cx}
              cy={e.cy}
              rx={e.rx}
              ry={e.ry}
              fill={e.color + '12'}
              stroke={e.color}
              strokeWidth={1.5 / zoom}
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              style={{ pointerEvents: 'auto', cursor: 'pointer' }}
              onClick={() => onGroupClick?.(e)}
            />
            {e.label && (
              <text
                x={e.cx}
                y={e.cy - e.ry - 8}
                textAnchor="middle"
                fill={e.color}
                fontSize={11 / zoom}
                fontWeight={600}
                style={{ pointerEvents: 'auto', cursor: 'pointer', userSelect: 'none' }}
                onClick={() => onGroupClick?.(e)}
              >
                {e.label}
              </text>
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}

const TYPE_COLORS: Record<string, string> = {
  PERSON: '#60a5fa',
  ORGANIZATION: '#fbbf24',
  LOCATION: '#4ade80',
  EVENT: '#a78bfa',
  DOCUMENT: '#fb923c',
  FINANCIAL_ENTITY: '#f87171',
};

const EDGE_LABEL_STYLE = { fill: 'rgba(235,235,245,0.5)', fontSize: 7, fontWeight: 500 };
const EDGE_LABEL_BG_STYLE = { fill: '#1C1C1E', fillOpacity: 0.85 };
const EDGE_LABEL_BG_PADDING: [number, number] = [4, 2] as [number, number];
const EDGE_LABEL_BG_BORDER_RADIUS = 3;
const EDGE_MARKER_END = { type: MarkerType.Arrow, color: 'rgba(84,84,88,0.65)' };
const DEFAULT_EDGE_OPTIONS = { type: 'default', animated: false };

interface GroupOverlay {
  id: string;
  label: string;
  color: string;
  node_ids: string[];
}

interface NexusProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: any;
  onEdgesChange: any;
  onNodeDragStart?: any;
  onNodeDragStop: any;
  onNodeClick?: (node: Node, event?: React.MouseEvent) => void;
  onEdgeClick?: (edge: Edge) => void;
  onEdgeUpdate?: (oldEdge: Edge, newConnection: Connection) => void;
  onPaneClick?: () => void;
  onGroupClick?: (group: GroupOverlay) => void;
  groups?: GroupOverlay[];
  height?: string;
  showEdgeLabels?: boolean;
  showMiniMap?: boolean;
}

function NexusCanvas({ nodes, edges, onNodesChange, onEdgesChange, onNodeDragStart, onNodeDragStop, onNodeClick, onEdgeClick, onEdgeUpdate, onPaneClick, onGroupClick, groups = [], height, showEdgeLabels = true, showMiniMap = true }: NexusProps) {
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

  const handleEdgeUpdate = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      onEdgeUpdate?.(oldEdge, newConnection);
    },
    [onEdgeUpdate]
  );

  const styledEdges = useMemo<Edge[]>(() => {
    // LOD: Hide edges completely when very zoomed out for ultimate panning speed
    if (zoom < 0.4) return [];

    const isHeavy = edges.length > 500;
    return edges.map(e => {
      const isCaseLocal = e.data?.isCaseLocal;
      return {
        ...e,
        label: isCaseLocal ? (e.label || undefined) : ((isHeavy || !showEdgeLabels) ? undefined : e.label),
        labelStyle: EDGE_LABEL_STYLE,
        labelBgStyle: EDGE_LABEL_BG_STYLE,
        labelBgPadding: EDGE_LABEL_BG_PADDING,
        labelBgBorderRadius: EDGE_LABEL_BG_BORDER_RADIUS,
        interactionWidth: 20,
        style: {
          ...(e.style || {}),
          stroke: e.selected
            ? (isCaseLocal ? '#FF453A' : '#007AFF')
            : isCaseLocal
              ? '#007AFF'
              : (e.data?.confidence === 'INFERRED' ? 'rgba(235,235,245,0.3)' : 'rgba(84,84,88,0.65)'),
          strokeWidth: e.selected ? 2.5 : (isCaseLocal ? 2 : 1.5),
          strokeDasharray: e.data?.confidence === 'INFERRED' ? '4 4' : undefined,
          cursor: 'pointer',
          pointerEvents: 'auto',
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
    <div style={{ width: '100%', height: height || '100%', background: '#000000', willChange: 'transform', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onEdgeUpdate={handleEdgeUpdate}
        onPaneClick={onPaneClick}
        reconnectRadius={30}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        edgesFocusable={true}
        edgesUpdatable={true}
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
        {showMiniMap && nodes.length < 1000 && (
          <MiniMap
            nodeColor={miniMapNodeColor}
            nodeStrokeWidth={2}
            maskColor="rgba(0, 0, 0, 0.6)"
          />
        )}
      </ReactFlow>
      {groups.length > 0 && (
        <GroupEllipses groups={groups} nodes={nodes} onGroupClick={onGroupClick} />
      )}
    </div>
  );
}

export default memo(NexusCanvas);

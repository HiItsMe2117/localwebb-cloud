import { useCallback, useMemo, memo, useEffect, useRef } from 'react';
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
import StickyNoteNode from './StickyNoteNode';
import DraggableLabelEdge from './DraggableLabelEdge';

// Group ellipse overlay rendered inside the ReactFlow viewport
function GroupEllipses({ groups, nodes, onGroupClick, onGroupDrag, onGroupDragEnd }: {
  groups: GroupOverlay[];
  nodes: Node[];
  onGroupClick?: (group: GroupOverlay) => void;
  onGroupDrag?: (group: GroupOverlay, dx: number, dy: number) => void;
  onGroupDragEnd?: (group: GroupOverlay) => void;
}) {
  const { x: vx, y: vy, zoom } = useViewport();

  // Drag state for group title dragging
  const dragState = useRef<{
    group: GroupOverlay;
    lastX: number;
    lastY: number;
    hasMoved: boolean;
  } | null>(null);
  const onGroupDragRef = useRef(onGroupDrag);
  const onGroupDragEndRef = useRef(onGroupDragEnd);
  const onGroupClickRef = useRef(onGroupClick);
  const zoomRef = useRef(zoom);
  onGroupDragRef.current = onGroupDrag;
  onGroupDragEndRef.current = onGroupDragEnd;
  onGroupClickRef.current = onGroupClick;
  zoomRef.current = zoom;

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const state = dragState.current;
    if (!state) return;
    const dx = e.clientX - state.lastX;
    const dy = e.clientY - state.lastY;
    if (!state.hasMoved && Math.abs(e.clientX - state.lastX) < 5 && Math.abs(e.clientY - state.lastY) < 5) return;
    state.hasMoved = true;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    document.body.style.cursor = 'grabbing';
    onGroupDragRef.current?.(state.group, dx / zoomRef.current, dy / zoomRef.current);
  }, []);

  const handlePointerUp = useCallback(() => {
    const state = dragState.current;
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', handlePointerUp);
    document.body.style.cursor = '';
    if (!state) return;
    if (state.hasMoved) {
      onGroupDragEndRef.current?.(state.group);
    } else {
      onGroupClickRef.current?.(state.group);
    }
    dragState.current = null;
  }, [handlePointerMove]);

  const handlePointerDown = useCallback((e: React.PointerEvent, group: GroupOverlay) => {
    e.stopPropagation();
    e.preventDefault();
    dragState.current = { group, lastX: e.clientX, lastY: e.clientY, hasMoved: false };
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove, handlePointerUp]);

  useEffect(() => {
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.body.style.cursor = '';
    };
  }, [handlePointerMove, handlePointerUp]);

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
            {/* Visual ellipse — no pointer events so nodes can be dragged */}
            <ellipse
              cx={e.cx}
              cy={e.cy}
              rx={e.rx}
              ry={e.ry}
              fill={e.color + '12'}
              stroke={e.color}
              strokeWidth={1.5 / zoom}
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
              style={{ pointerEvents: 'none' }}
            />
            {/* Invisible hit target — stroke only for group selection */}
            <ellipse
              cx={e.cx}
              cy={e.cy}
              rx={e.rx}
              ry={e.ry}
              fill="none"
              stroke="transparent"
              strokeWidth={12 / zoom}
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
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
                style={{ pointerEvents: 'auto', cursor: 'grab', userSelect: 'none', touchAction: 'none' }}
                onPointerDown={(ev) => handlePointerDown(ev, e)}
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
  onMoveEnd?: (event: any, viewport: { x: number; y: number; zoom: number }) => void;
  onGroupClick?: (group: GroupOverlay) => void;
  onGroupDrag?: (group: GroupOverlay, dx: number, dy: number) => void;
  onGroupDragEnd?: (group: GroupOverlay) => void;
  groups?: GroupOverlay[];
  panOnDrag?: boolean;
  skipInitialFitView?: boolean;
  height?: string;
  showEdgeLabels?: boolean;
  showMiniMap?: boolean;
  onEdgeLabelDrag?: (edgeId: string, labelPosition: number) => void;
  onEdgeLabelDragEnd?: (edgeId: string) => void;
}

function NexusCanvas({ nodes, edges, onNodesChange, onEdgesChange, onNodeDragStart, onNodeDragStop, onNodeClick, onEdgeClick, onEdgeUpdate, onPaneClick, onMoveEnd, onGroupClick, onGroupDrag, onGroupDragEnd, groups = [], panOnDrag = true, skipInitialFitView = false, height, showEdgeLabels = true, showMiniMap = true, onEdgeLabelDrag, onEdgeLabelDragEnd }: NexusProps) {
  const nodeTypes = useMemo(() => ({ entityNode: EntityNode, stickyNote: StickyNoteNode }), []);
  const edgeTypes = useMemo(() => ({ draggable: DraggableLabelEdge }), []);
  const zoom = useStore((s: ReactFlowState) => s.transform[2]);
  const { fitView } = useReactFlow();

  // Auto-fit only on initial load, not on every node change
  const hasFitInitial = useRef(false);
  useEffect(() => {
    if (nodes.length > 0 && !hasFitInitial.current) {
      hasFitInitial.current = true;
      if (!skipInitialFitView) {
        fitView({ padding: 0.3, duration: 800 });
      }
    }
  }, [nodes.length, fitView, skipInitialFitView]);

  // Listen for draggable label events from DraggableLabelEdge
  useEffect(() => {
    const handleDrag = (e: Event) => {
      const { edgeId, labelPosition } = (e as CustomEvent).detail;
      onEdgeLabelDrag?.(edgeId, labelPosition);
    };
    const handleDragEnd = (e: Event) => {
      const { edgeId } = (e as CustomEvent).detail;
      onEdgeLabelDragEnd?.(edgeId);
    };
    window.addEventListener('edge-label-drag', handleDrag);
    window.addEventListener('edge-label-drag-end', handleDragEnd);
    return () => {
      window.removeEventListener('edge-label-drag', handleDrag);
      window.removeEventListener('edge-label-drag-end', handleDragEnd);
    };
  }, [onEdgeLabelDrag, onEdgeLabelDragEnd]);

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
      const isHypothesis = e.data?.isHypothesis;
      const edgeLabel = isCaseLocal ? (e.label || undefined) : ((isHeavy || !showEdgeLabels) ? undefined : e.label);
      const useDraggable = isCaseLocal && edgeLabel;
      return {
        ...e,
        type: useDraggable ? 'draggable' : 'default',
        label: edgeLabel,
        labelStyle: useDraggable ? undefined : EDGE_LABEL_STYLE,
        labelBgStyle: useDraggable ? undefined : EDGE_LABEL_BG_STYLE,
        labelBgPadding: useDraggable ? undefined : EDGE_LABEL_BG_PADDING,
        labelBgBorderRadius: useDraggable ? undefined : EDGE_LABEL_BG_BORDER_RADIUS,
        interactionWidth: 20,
        style: {
          ...(e.style || {}),
          stroke: e.selected
            ? (isHypothesis ? '#FBBF24' : isCaseLocal ? '#FF453A' : '#007AFF')
            : isHypothesis
              ? '#FBBF24'
              : isCaseLocal
                ? '#007AFF'
                : (e.data?.confidence === 'INFERRED' ? 'rgba(235,235,245,0.3)' : 'rgba(84,84,88,0.65)'),
          strokeWidth: e.selected ? 2.5 : (isCaseLocal ? 2 : 1.5),
          strokeDasharray: isHypothesis ? '8 4' : (e.data?.confidence === 'INFERRED' ? '4 4' : undefined),
          cursor: 'pointer',
          pointerEvents: 'auto',
        },
        markerEnd: isCaseLocal ? undefined : EDGE_MARKER_END,
      };
    });
  }, [edges, zoom, showEdgeLabels]);

  const miniMapNodeColor = useCallback((node: Node) => {
    if (node.type === 'stickyNote') return node.data?.color || '#FBBF24';
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
        onMoveEnd={onMoveEnd}
        reconnectRadius={30}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        edgesFocusable={true}
        edgesUpdatable={true}
        panOnDrag={panOnDrag}
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
        <GroupEllipses groups={groups} nodes={nodes} onGroupClick={onGroupClick} onGroupDrag={onGroupDrag} onGroupDragEnd={onGroupDragEnd} />
      )}
    </div>
  );
}

export default memo(NexusCanvas);

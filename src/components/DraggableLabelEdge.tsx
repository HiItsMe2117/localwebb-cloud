import { useCallback, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from 'reactflow';
import type { EdgeProps } from 'reactflow';

/**
 * Custom edge with a label that can be dragged along the path.
 * Stores labelPosition (0–1) in edge.data.labelPosition.
 */
export default function DraggableLabelEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  style,
  markerEnd,
  data,
  interactionWidth,
}: EdgeProps) {
  const t = data?.labelPosition ?? 0.5;

  // Interpolate a point along the edge at parameter t (0–1)
  // For a bezier curve we approximate by lerping the control points
  const mx = sourceX + (targetX - sourceX) * t;
  const my = sourceY + (targetY - sourceY) * t;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startT: number;
  } | null>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startY: e.clientY, startT: t };
      setDragging(true);

      const dx = targetX - sourceX;
      const dy = targetY - sourceY;
      const len = Math.sqrt(dx * dx + dy * dy);

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Project mouse delta onto the source→target axis
        const deltaX = ev.clientX - dragRef.current.startX;
        const deltaY = ev.clientY - dragRef.current.startY;
        if (len < 1) return;
        const proj = (deltaX * dx + deltaY * dy) / (len * len);
        const newT = Math.max(0.05, Math.min(0.95, dragRef.current.startT + proj));

        // Fire a custom event so the parent can update edge data
        window.dispatchEvent(
          new CustomEvent('edge-label-drag', {
            detail: { edgeId: id, labelPosition: newT },
          })
        );
      };

      const onUp = () => {
        setDragging(false);
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);

        // Fire drag-end so position gets persisted
        window.dispatchEvent(
          new CustomEvent('edge-label-drag-end', { detail: { edgeId: id } })
        );
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [id, t, sourceX, sourceY, targetX, targetY]
  );

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={style}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            onMouseDown={onMouseDown}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${mx}px, ${my}px)`,
              pointerEvents: 'all',
              cursor: dragging ? 'grabbing' : 'grab',
              fontSize: 7,
              fontWeight: 500,
              color: 'rgba(235,235,245,0.5)',
              background: 'rgba(28,28,30,0.85)',
              padding: '2px 4px',
              borderRadius: 3,
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
            className="nodrag nopan"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

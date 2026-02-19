import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { Node, Edge } from 'reactflow';

const nodeWidth = 220;
const nodeHeight = 80;

interface SimNode extends SimulationNodeDatum {
  id: string;
}

export const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  if (nodes.length === 0) return { nodes, edges };

  // Build degree map so highly-connected nodes get placed centrally
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  // Circular initial positions to prevent d3 jitter artifacts
  const cx = 0;
  const cy = 0;
  const radius = Math.max(200, nodes.length * 30);

  const simNodes: SimNode[] = nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    return {
      id: n.id,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });

  const simLinks: SimulationLinkDatum<SimNode>[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(180)
    )
    .force('charge', forceManyBody().strength(-600))
    .force('center', forceCenter(cx, cy))
    .force('collide', forceCollide(Math.max(nodeWidth, nodeHeight) / 2 + 20))
    .stop();

  // Run 300 ticks synchronously (~50ms) to pre-compute positions
  simulation.tick(300);

  // Map computed positions back onto nodes
  const posMap = new Map(simNodes.map((sn) => [sn.id, { x: sn.x!, y: sn.y! }]));

  const layoutedNodes = nodes.map((node) => {
    const pos = posMap.get(node.id) || { x: 0, y: 0 };
    return {
      ...node,
      position: {
        x: pos.x - nodeWidth / 2,
        y: pos.y - nodeHeight / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

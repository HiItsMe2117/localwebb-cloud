import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceRadial,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { Node, Edge } from 'reactflow';

const nodeWidth = 160;
const nodeHeight = 60;

interface SimNode extends SimulationNodeDatum {
  id: string;
  degree: number;
}

export const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  if (nodes.length === 0) return { nodes, edges };

  // Build degree map so highly-connected nodes get placed centrally
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }

  const maxDegree = Math.max(1, ...Array.from(degree.values()));
  const baseRadius = Math.sqrt(nodes.length) * 40;

  // Golden angle for even spacing without radial stacking
  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~137.5 degrees

  // Concentric ring initial positions — high-degree near center, low-degree on outer rings
  const cx = 0;
  const cy = 0;

  const simNodes: SimNode[] = nodes.map((n, i) => {
    const deg = degree.get(n.id) || 0;
    // Normalized rank: 1.0 = highest degree (center), 0.0 = lowest (outer)
    const rank = maxDegree > 0 ? deg / maxDegree : 0;
    // Ring radius: hubs at ~10% of base, leaves at 100%
    const ringRadius = baseRadius * (0.1 + 0.9 * (1 - rank));
    const angle = goldenAngle * i;
    return {
      id: n.id,
      degree: deg,
      x: cx + ringRadius * Math.cos(angle),
      y: cy + ringRadius * Math.sin(angle),
    };
  });

  const simLinks: SimulationLinkDatum<SimNode>[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  // Compute target radial distance per node for the radial force
  const radialTarget = (d: SimNode) => {
    const rank = maxDegree > 0 ? d.degree / maxDegree : 0;
    return baseRadius * (0.1 + 0.9 * (1 - rank));
  };

  // Collision radius: hubs get more space, leaves pack tight
  const collisionRadius = (d: SimNode) => {
    if (d.degree >= 50) return 45;
    if (d.degree >= 5) return 25;
    return 15;
  };

  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(70)
        .strength(0.8)
    )
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength(-150)
        .distanceMax(500)
    )
    .force(
      'center',
      forceCenter(cx, cy).strength(0.05)
    )
    .force(
      'collide',
      forceCollide<SimNode>()
        .radius(collisionRadius)
    )
    .force(
      'radial',
      forceRadial<SimNode>(radialTarget, cx, cy)
        .strength(0.3)
    )
    .stop();

  // Run 450 ticks synchronously for convergence with 3k nodes
  simulation.tick(450);

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

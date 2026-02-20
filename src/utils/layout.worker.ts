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

interface SimNode extends SimulationNodeDatum {
  id: string;
  degree: number;
}

self.onmessage = (e: MessageEvent) => {
  const { nodes, edges } = e.data;

  if (nodes.length === 0) {
    self.postMessage({ positions: [] });
    return;
  }

  const maxDegree = Math.max(1, ...nodes.map((n: any) => n.degree));
  const baseRadius = Math.sqrt(nodes.length) * 60; // Massive increase from 25
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const cx = 0;
  const cy = 0;

  const simNodes: SimNode[] = nodes.map((n: any, i: number) => {
    const rank = maxDegree > 0 ? n.degree / maxDegree : 0;
    const ringRadius = baseRadius * (0.1 + 0.9 * (1 - rank));
    const angle = goldenAngle * i;
    return {
      id: n.id,
      degree: n.degree,
      x: cx + ringRadius * Math.cos(angle),
      y: cy + ringRadius * Math.sin(angle),
    };
  });

  const simLinks: SimulationLinkDatum<SimNode>[] = edges.map((e: any) => ({
    source: e.source,
    target: e.target,
  }));

  const radialTarget = (d: SimNode) => {
    const rank = maxDegree > 0 ? d.degree / maxDegree : 0;
    return baseRadius * (0.1 + 0.9 * (1 - rank));
  };

  const collisionRadius = (d: SimNode) => {
    if (d.degree >= 50) return 80; // Increased
    if (d.degree >= 5) return 50;  // Increased
    return 30;                    // Increased
  };

  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(150) // Doubled from 65
        .strength(0.8)
    )
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength(-800) // Quadrupled magnetism from -250
        .distanceMax(1200) // Increased range
    )
    .force(
      'center',
      forceCenter(cx, cy).strength(0.05) // Nearly zero gravity
    )
    .force(
      'collide',
      forceCollide<SimNode>()
        .radius(collisionRadius)
    )
    .force(
      'radial',
      forceRadial<SimNode>(radialTarget, cx, cy)
        .strength(0.1) // Let them spread freely
    )
    .stop();

  simulation.tick(450);

  const positions = simNodes.map((sn) => ({
    id: sn.id,
    x: sn.x!,
    y: sn.y!,
  }));

  self.postMessage({ positions });
};

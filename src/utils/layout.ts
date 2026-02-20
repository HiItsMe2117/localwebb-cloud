import type { Node, Edge } from 'reactflow';

const nodeWidth = 160;
const nodeHeight = 60;

let worker: Worker | null = null;

const getWorker = () => {
  if (!worker) {
    worker = new Worker(new URL('./layout.worker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return worker;
};

export const computeDegreeMap = (edges: Edge[]) => {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  return degree;
};

export const getLayoutedElements = async (nodes: Node[], edges: Edge[]): Promise<{ nodes: Node[]; edges: Edge[] }> => {
  if (nodes.length === 0) return { nodes, edges };

  const degree = computeDegreeMap(edges);
  const layoutWorker = getWorker();

  const workerNodes = nodes.map((n) => ({
    id: n.id,
    degree: degree.get(n.id) || 0,
  }));

  const workerEdges = edges.map((e) => ({
    source: e.source,
    target: e.target,
  }));

  return new Promise((resolve) => {
    const handleMessage = (e: MessageEvent) => {
      const { positions } = e.data;
      const posMap = new Map<string, { x: number; y: number }>(
        positions.map((p: any) => [p.id, { x: p.x, y: p.y }])
      );

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

      layoutWorker.removeEventListener('message', handleMessage);
      resolve({ nodes: layoutedNodes, edges });
    };

    layoutWorker.addEventListener('message', handleMessage);
    layoutWorker.postMessage({ nodes: workerNodes, edges: workerEdges });
  });
};

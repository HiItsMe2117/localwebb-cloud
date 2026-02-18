import { X, FileText, Link2, Quote, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Node, Edge } from 'reactflow';

interface EvidencePanelProps {
  selectedNode: Node | null;
  selectedEdge: Edge | null;
  allEdges: Edge[];
  allNodes: Node[];
  onClose: () => void;
}

export default function EvidencePanel({ selectedNode, selectedEdge, allEdges, allNodes, onClose }: EvidencePanelProps) {
  if (!selectedNode && !selectedEdge) return null;

  const nodeMap = Object.fromEntries(allNodes.map(n => [n.id, n]));

  // Edge detail view
  if (selectedEdge) {
    const d = selectedEdge.data || {};
    const sourceNode = nodeMap[selectedEdge.source];
    const targetNode = nodeMap[selectedEdge.target];

    return (
      <div className="fixed right-0 top-0 h-full w-[400px] bg-[#0d0d0f] border-l border-white/10 z-50 overflow-y-auto shadow-2xl">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Link2 size={16} className="text-blue-400" />
              <h3 className="text-white font-bold text-sm">Relationship Evidence</h3>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center">
              <X size={14} className="text-zinc-400" />
            </button>
          </div>

          <div className="mb-4 p-3 bg-zinc-900/50 rounded-xl border border-white/5">
            <div className="flex items-center gap-2 text-sm text-white font-medium mb-1">
              <span>{sourceNode?.data?.label || selectedEdge.source}</span>
              <span className="text-blue-400">→</span>
              <span>{targetNode?.data?.label || selectedEdge.target}</span>
            </div>
            <span className="text-xs font-mono text-blue-300 bg-blue-500/10 px-2 py-0.5 rounded">
              {d.predicate || selectedEdge.label || 'related_to'}
            </span>
          </div>

          {d.evidence_text && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Quote size={12} className="text-zinc-500" />
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Evidence</span>
              </div>
              <div className="p-3 bg-blue-500/5 border-l-2 border-blue-500 rounded-r-lg text-sm text-zinc-300 leading-relaxed italic">
                "{d.evidence_text}"
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {d.source_filename && (
              <div className="flex items-center gap-2 text-xs">
                <FileText size={12} className="text-zinc-500" />
                <span className="text-zinc-400">{d.source_filename}</span>
                {d.source_page > 0 && <span className="text-zinc-600">p.{d.source_page}</span>}
              </div>
            )}
            <div className="flex items-center gap-2 text-xs">
              {d.confidence === 'INFERRED' ? (
                <AlertTriangle size={12} className="text-amber-400" />
              ) : (
                <CheckCircle2 size={12} className="text-green-400" />
              )}
              <span className={d.confidence === 'INFERRED' ? 'text-amber-400' : 'text-green-400'}>
                {d.confidence || 'STATED'}
              </span>
            </div>
            {d.date_mentioned && (
              <div className="text-xs text-zinc-500">Date: {d.date_mentioned}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Node detail view
  if (selectedNode) {
    const nd = selectedNode.data || {};
    const connectedEdges = allEdges.filter(
      e => e.source === selectedNode.id || e.target === selectedNode.id
    );

    return (
      <div className="fixed right-0 top-0 h-full w-[400px] bg-[#0d0d0f] border-l border-white/10 z-50 overflow-y-auto shadow-2xl">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ background: nd.communityColor || '#3b82f6' }} />
              <h3 className="text-white font-bold text-sm">{nd.label}</h3>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center">
              <X size={14} className="text-zinc-400" />
            </button>
          </div>

          <div className="mb-4">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 bg-zinc-800 px-2 py-1 rounded">
              {nd.entityType || nd.type || 'UNKNOWN'}
            </span>
          </div>

          {nd.description && (
            <p className="text-sm text-zinc-300 leading-relaxed mb-4">{nd.description}</p>
          )}

          {nd.aliases && nd.aliases.length > 0 && (
            <div className="mb-4">
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Aliases</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {nd.aliases.map((a: string, i: number) => (
                  <span key={i} className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">{a}</span>
                ))}
              </div>
            </div>
          )}

          {connectedEdges.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Link2 size={12} className="text-zinc-500" />
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">
                  Connections ({connectedEdges.length})
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {connectedEdges.map((edge) => {
                  const d = edge.data || {};
                  const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
                  const otherNode = nodeMap[otherId];
                  const isOutgoing = edge.source === selectedNode.id;

                  return (
                    <div key={edge.id} className="p-3 bg-zinc-900/50 rounded-xl border border-white/5">
                      <div className="flex items-center gap-2 text-xs text-white mb-1">
                        <span className="text-zinc-500">{isOutgoing ? '→' : '←'}</span>
                        <span className="font-medium">{otherNode?.data?.label || otherId}</span>
                      </div>
                      <span className="text-[10px] font-mono text-blue-300">
                        {d.predicate || edge.label || 'related'}
                      </span>
                      {d.evidence_text && (
                        <p className="text-[11px] text-zinc-500 mt-1 italic line-clamp-2">
                          "{d.evidence_text}"
                        </p>
                      )}
                      {d.source_filename && (
                        <div className="flex items-center gap-1 mt-1">
                          <FileText size={10} className="text-zinc-600" />
                          <span className="text-[10px] text-zinc-600">{d.source_filename}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

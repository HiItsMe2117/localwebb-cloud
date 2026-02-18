import { X, FileText, Link2, Quote, AlertTriangle, CheckCircle2, ChevronRight, Share2 } from 'lucide-react';
import type { Node, Edge } from 'reactflow';

interface EvidencePanelProps {
  selectedNode: Node | null;
  selectedEdge: Edge | null;
  allEdges: Edge[];
  allNodes: Node[];
  onClose: () => void;
}

export default function EvidencePanel({ selectedNode, selectedEdge, allEdges, allNodes, onClose }: EvidencePanelProps) {
  const isOpen = !!selectedNode || !!selectedEdge;
  const nodeMap = Object.fromEntries(allNodes.map(n => [n.id, n]));

  const renderContent = () => {
    // Edge Detail View
    if (selectedEdge) {
      const d = selectedEdge.data || {};
      const sourceNode = nodeMap[selectedEdge.source];
      const targetNode = nodeMap[selectedEdge.target];

      return (
        <>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600/10 flex items-center justify-center border border-blue-500/20">
              <Share2 size={20} className="text-blue-400" />
            </div>
            <div>
              <h3 className="text-white font-bold">Relationship Details</h3>
              <p className="text-xs text-zinc-500">Evidence of a connection</p>
            </div>
          </div>
          
          <div className="mt-6 p-4 bg-zinc-900 rounded-xl border border-zinc-800/80">
            <div className="flex items-center justify-between text-sm text-white font-medium">
              <span className="truncate">{sourceNode?.data?.label || selectedEdge.source}</span>
              <ChevronRight size={16} className="text-zinc-600 shrink-0 mx-2" />
              <span className="truncate text-right">{targetNode?.data?.label || selectedEdge.target}</span>
            </div>
            <div className="text-center mt-2">
              <span className="text-xs font-semibold text-blue-400 bg-blue-500/10 px-3 py-1 rounded-full border border-blue-500/20 uppercase tracking-wider">
                {d.predicate || selectedEdge.label || 'related_to'}
              </span>
            </div>
          </div>

          {d.evidence_text && (
            <div className="mt-4 space-y-2">
              <h4 className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider flex items-center gap-2">
                <Quote size={12} /> Extracted Evidence
              </h4>
              <div className="p-4 bg-zinc-950/50 rounded-xl text-sm text-zinc-300 leading-relaxed italic border border-zinc-800">
                "{d.evidence_text}"
              </div>
            </div>
          )}

          <div className="mt-4 space-y-3 text-xs">
            {d.source_filename && (
              <div className="flex justify-between items-center text-zinc-400">
                <span className="flex items-center gap-2 text-zinc-500"><FileText size={14} /> Source File</span>
                <span>{d.source_filename} {d.source_page > 0 && `(p. ${d.source_page})`}</span>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="flex items-center gap-2 text-zinc-500">
                {d.confidence === 'INFERRED' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />} Confidence
              </span>
              <span className={d.confidence === 'INFERRED' ? 'text-amber-400' : 'text-green-400'}>
                {d.confidence || 'STATED'}
              </span>
            </div>
          </div>
        </>
      );
    }

    // Node Detail View
    if (selectedNode) {
      const nd = selectedNode.data || {};
      const connectedEdges = allEdges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id);

      return (
        <>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full mt-1" style={{ background: nd.communityColor || '#3b82f6' }} />
                <h3 className="text-white font-bold text-lg">{nd.label}</h3>
              </div>
              <span className="text-xs font-bold uppercase tracking-wider ml-5" style={{color: nd.communityColor || '#3b82f6'}}>
                {nd.entityType || nd.type || 'UNKNOWN'}
              </span>
            </div>
          </div>

          {nd.description && (
            <p className="text-sm text-zinc-400 leading-relaxed mt-4">{nd.description}</p>
          )}

          {nd.aliases && nd.aliases.length > 0 && (
            <div className="mt-4">
              <h4 className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-2">Aliases</h4>
              <div className="flex flex-wrap gap-2">
                {nd.aliases.map((a: string, i: number) => (
                  <span key={i} className="text-xs bg-zinc-800 text-zinc-300 px-2.5 py-1 rounded-md border border-zinc-700">{a}</span>
                ))}
              </div>
            </div>
          )}

          {connectedEdges.length > 0 && (
            <div className="mt-6">
              <h4 className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
                <Link2 size={12} /> Connections ({connectedEdges.length})
              </h4>
              <div className="space-y-2">
                {connectedEdges.map((edge) => {
                  const d = edge.data || {};
                  const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
                  const otherNode = nodeMap[otherId];
                  const isOutgoing = edge.source === selectedNode.id;

                  return (
                    <div key={edge.id} className="p-3 bg-zinc-900/70 rounded-xl border border-zinc-800 hover:border-zinc-700 transition-colors">
                      <div className="flex items-center gap-2 text-xs text-white mb-1">
                        <span className={`text-zinc-500 ${isOutgoing ? 'text-red-400' : 'text-green-400'}`}>{isOutgoing ? '→' : '←'}</span>
                        <span className="font-medium">{otherNode?.data?.label || otherId}</span>
                      </div>
                      <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider ml-5">
                        {d.predicate || edge.label || 'related'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      );
    }
    return null;
  };

  return (
    <div 
      className={`fixed top-0 right-0 h-full w-[450px] bg-[#09090b] border-l border-zinc-800 z-[100] shadow-2xl shadow-black/50 transition-transform duration-300 ease-out ${
        isOpen ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      {/* Panel Content */}
      <div className="h-full overflow-y-auto p-6 space-y-6 relative">
        {renderContent()}
      </div>

      {/* Close Button */}
      <button 
        onClick={onClose} 
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center text-zinc-400 hover:text-white transition-all"
      >
        <X size={16} />
      </button>
    </div>
  );
}

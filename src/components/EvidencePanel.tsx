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

  return (
    <div className="fixed right-4 top-[140px] bottom-4 w-96 bg-[#050510] border-2 border-[#4169E1] z-50 overflow-hidden flex flex-col shadow-[0_0_20px_rgba(65,105,225,0.2)] font-mono text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#4169E1] text-[#050510] font-bold shrink-0">
        <span>:: EVIDENCE_LOG :: {selectedNode ? 'ENTITY' : 'RELATION'}</span>
        <button onClick={onClose} className="hover:bg-[#050510] hover:text-[#4169E1] px-1">
          [X]
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 text-[#a4b9ef] space-y-4">
        {/* Edge Detail View */}
        {selectedEdge && (
          <>
            <div className="border-b border-[#2b4a9c] pb-2">
              <span className="text-[#4169E1] block mb-1">RELATIONSHIP_TYPE:</span>
              <span className="text-[#00ffff] font-bold uppercase">
                {selectedEdge.data?.predicate || selectedEdge.label || 'RELATED_TO'}
              </span>
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
              <span className="text-[#2b4a9c]">SOURCE:</span>
              <span className="truncate">{nodeMap[selectedEdge.source]?.data?.label || selectedEdge.source}</span>
              
              <span className="text-[#2b4a9c]">TARGET:</span>
              <span className="truncate">{nodeMap[selectedEdge.target]?.data?.label || selectedEdge.target}</span>
              
              <span className="text-[#2b4a9c]">CONFIDENCE:</span>
              <span className={selectedEdge.data?.confidence === 'INFERRED' ? 'text-amber-500' : 'text-green-500'}>
                {selectedEdge.data?.confidence || 'STATED'}
              </span>
            </div>

            {selectedEdge.data?.evidence_text && (
              <div className="mt-4">
                <span className="text-[#4169E1] block mb-1">EVIDENCE_EXTRACT:</span>
                <div className="border-l-2 border-[#2b4a9c] pl-2 text-[#a4b9ef] opacity-80 italic">
                  "{selectedEdge.data.evidence_text}"
                </div>
              </div>
            )}

            {selectedEdge.data?.source_filename && (
               <div className="mt-4 text-[10px] text-[#2b4a9c]">
                 REF: {selectedEdge.data.source_filename} (p.{selectedEdge.data.source_page})
               </div>
            )}
          </>
        )}

        {/* Node Detail View */}
        {selectedNode && (
          <>
            <div className="border-b border-[#2b4a9c] pb-2">
              <span className="text-[#4169E1] block mb-1">ENTITY_ID:</span>
              <span className="text-[#00ffff] font-bold text-sm">
                {selectedNode.data?.label || selectedNode.id}
              </span>
              <span className="block text-[10px] text-[#2b4a9c] mt-1">
                TYPE: {selectedNode.data?.entityType || 'UNKNOWN'}
              </span>
            </div>

            {selectedNode.data?.description && (
               <div>
                 <span className="text-[#4169E1] block mb-1">DESCRIPTION:</span>
                 <p className="opacity-90 leading-relaxed">
                   {selectedNode.data.description}
                 </p>
               </div>
            )}

            {/* Connections */}
            <div>
              <span className="text-[#4169E1] block mb-2">CONNECTIONS:</span>
              <div className="space-y-2">
                {allEdges
                  .filter(e => e.source === selectedNode.id || e.target === selectedNode.id)
                  .map(edge => {
                    const isSource = edge.source === selectedNode.id;
                    const otherId = isSource ? edge.target : edge.source;
                    const otherNode = nodeMap[otherId];
                    return (
                      <div key={edge.id} className="border border-[#2b4a9c] p-2 bg-[#050510] hover:bg-[#4169E1]/10">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[#2b4a9c]">{isSource ? '->' : '<-'}</span>
                          <span className="font-bold text-[#00ffff]">
                            {otherNode?.data?.label || otherId}
                          </span>
                        </div>
                        <div className="text-[10px] opacity-70">
                          REL: {edge.data?.predicate || edge.label || 'RELATED'}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

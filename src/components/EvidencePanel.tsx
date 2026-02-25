import { X, FileText, Link2, Quote, AlertTriangle, CheckCircle2, ChevronRight, Share2, MessageSquare, Info } from 'lucide-react';
import type { Node, Edge } from 'reactflow';
import { useState, useEffect } from 'react';
import EntityChat from './EntityChat';
import { getFileUrl } from '../utils/files';

interface EvidencePanelProps {
  selectedNode: Node | null;
  selectedEdge: Edge | null;
  allEdges: Edge[];
  allNodes: Node[];
  onClose: () => void;
  onNodeClick: (node: Node) => void;
}

export default function EvidencePanel({ selectedNode, selectedEdge, allEdges, allNodes, onClose, onNodeClick }: EvidencePanelProps) {
  const [activeTab, setActiveTab] = useState<'info' | 'chat'>('info');
  const isOpen = !!selectedNode || !!selectedEdge;
  const nodeMap = Object.fromEntries(allNodes.map(n => [n.id, n]));

  // Reset tab when node changes
  useEffect(() => {
    if (selectedNode) setActiveTab('info');
  }, [selectedNode?.id]);

  const renderNodeOverview = (selectedNode: Node) => {
    const nd = selectedNode.data || {};
    const connectedEdges = allEdges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id);

    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full mt-1" style={{ background: nd.communityColor || '#007AFF' }} />
              <h3 className="text-white font-bold text-[20px]">{nd.label}</h3>
            </div>
            <span className="text-[13px] font-semibold uppercase tracking-wider ml-5" style={{color: nd.communityColor || '#007AFF'}}>
              {nd.entityType || nd.type || 'UNKNOWN'}
            </span>
          </div>
        </div>

        {nd.description && (
          <p className="text-[15px] text-[rgba(235,235,245,0.6)] leading-relaxed mt-4">{nd.description}</p>
        )}

        {nd.aliases && nd.aliases.length > 0 && (
          <div className="mt-4">
            <h4 className="text-[13px] text-[rgba(235,235,245,0.3)] font-semibold mb-2">Aliases</h4>
            <div className="flex flex-wrap gap-2">
              {nd.aliases.map((a: string, i: number) => (
                <span key={i} className="text-[13px] bg-[#2C2C2E] text-[rgba(235,235,245,0.6)] px-2.5 py-1 rounded-lg border border-[rgba(84,84,88,0.65)]">{a}</span>
              ))}
            </div>
          </div>
        )}

        {connectedEdges.length > 0 && (
          <div className="mt-6">
            <h4 className="text-[13px] text-[rgba(235,235,245,0.3)] font-semibold mb-3 flex items-center gap-2">
              <Link2 size={12} /> Connections ({connectedEdges.length})
            </h4>
            <div className="space-y-2">
              {connectedEdges.map((edge) => {
                const d = edge.data || {};
                const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
                const otherNode = nodeMap[otherId];
                const isOutgoing = edge.source === selectedNode.id;

                return (
                  <button
                    key={edge.id}
                    onClick={() => otherNode && onNodeClick(otherNode)}
                    className="w-full text-left p-3 bg-[#2C2C2E] rounded-xl border border-[rgba(84,84,88,0.65)] hover:bg-[#3A3A3C] hover:border-[#007AFF]/40 transition-all group"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[13px] text-white">
                        <span className={isOutgoing ? 'text-[#FF453A]' : 'text-[#30D158]'}>{isOutgoing ? '\u2192' : '\u2190'}</span>
                        <span className="font-medium group-hover:text-[#007AFF] transition-colors">{otherNode?.data?.label || otherId}</span>
                      </div>
                      <ChevronRight size={14} className="text-[rgba(235,235,245,0.2)] group-hover:text-[#007AFF] transition-colors" />
                    </div>
                    <div className="flex items-center gap-2 mt-1 ml-5">
                      <span className="text-[11px] font-semibold text-[#007AFF] uppercase tracking-wider">
                        {d.predicate || edge.label || 'related'}
                      </span>
                      {d.confidence === 'INFERRED' && (
                        <span className="text-[10px] text-[#FF9F0A] font-bold tracking-tighter uppercase px-1.5 py-0.5 bg-[#FF9F0A]/10 rounded border border-[#FF9F0A]/20">Inferred</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderContent = () => {
    // Edge Detail View
    if (selectedEdge) {
      const d = selectedEdge.data || {};
      const sourceNode = nodeMap[selectedEdge.source];
      const targetNode = nodeMap[selectedEdge.target];

      return (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#007AFF]/10 flex items-center justify-center border border-[#007AFF]/20">
              <Share2 size={20} className="text-[#007AFF]" />
            </div>
            <div>
              <h3 className="text-white font-semibold text-[17px]">Relationship Details</h3>
              <p className="text-[13px] text-[rgba(235,235,245,0.3)]">Evidence of a connection</p>
            </div>
          </div>

          <div className="mt-5 p-4 bg-[#2C2C2E] rounded-xl border border-[rgba(84,84,88,0.65)]">
            <div className="flex items-center justify-between text-[15px] text-white font-medium">
              <span className="truncate">{sourceNode?.data?.label || selectedEdge.source}</span>
              <ChevronRight size={16} className="text-[rgba(235,235,245,0.3)] shrink-0 mx-2" />
              <span className="truncate text-right">{targetNode?.data?.label || selectedEdge.target}</span>
            </div>
            <div className="text-center mt-2">
              <span className="text-[11px] font-semibold text-[#007AFF] bg-[#007AFF]/10 px-3 py-1 rounded-full border border-[#007AFF]/20 uppercase tracking-wider">
                {d.predicate || selectedEdge.label || 'related_to'}
              </span>
            </div>
          </div>

          {d.evidence_text && (
            <div className="mt-4 space-y-2">
              <h4 className="text-[13px] text-[rgba(235,235,245,0.3)] font-semibold flex items-center gap-2">
                <Quote size={12} /> Extracted Evidence
              </h4>
              <div className="p-4 bg-[#2C2C2E] rounded-xl text-[15px] text-[rgba(235,235,245,0.6)] leading-relaxed italic border border-[rgba(84,84,88,0.65)]">
                "{d.evidence_text}"
              </div>
            </div>
          )}

          <div className="mt-4 space-y-3 text-[13px]">
            {d.source_filename && (
              <div className="flex justify-between items-center">
                <span className="flex items-center gap-2 text-[rgba(235,235,245,0.3)]"><FileText size={14} /> Source File</span>
                <a
                  href={getFileUrl(d.source_filename, d.source_page > 0 ? d.source_page : undefined)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[rgba(235,235,245,0.6)] hover:text-[rgba(235,235,245,0.8)] hover:underline cursor-pointer transition-colors"
                >{d.source_filename} {d.source_page > 0 && `(p. ${d.source_page})`}</a>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="flex items-center gap-2 text-[rgba(235,235,245,0.3)]">
                {d.confidence === 'INFERRED' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />} Confidence
              </span>
              <span className={d.confidence === 'INFERRED' ? 'text-[#FF9F0A]' : 'text-[#30D158]'}>
                {d.confidence || 'STATED'}
              </span>
            </div>
          </div>
        </div>
      );
    }

    // Node Detail View
    if (selectedNode) {
      return (
        <div className="flex flex-col h-full">
          {/* Tabs UI */}
          <div className="flex items-center gap-4 mb-4 border-b border-[rgba(84,84,88,0.3)]">
            <button
              onClick={() => setActiveTab('info')}
              className={`pb-2 px-1 text-[15px] font-semibold flex items-center gap-2 transition-all relative ${
                activeTab === 'info' ? 'text-white' : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
              }`}
            >
              <Info size={16} /> Overview
              {activeTab === 'info' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#007AFF] rounded-full" />}
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`pb-2 px-1 text-[15px] font-semibold flex items-center gap-2 transition-all relative ${
                activeTab === 'chat' ? 'text-white' : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
              }`}
            >
              <MessageSquare size={16} /> AI Chat
              {activeTab === 'chat' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#007AFF] rounded-full" />}
            </button>
          </div>

          <div className="overflow-y-auto pr-1">
            {activeTab === 'info' ? (
              renderNodeOverview(selectedNode)
            ) : (
              <EntityChat 
                entityId={selectedNode.id} 
                entityName={selectedNode.data?.label || selectedNode.id} 
              />
            )}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <>
      {/* Backdrop overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-[99] transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Bottom Sheet */}
      <div
        className={`fixed bottom-0 left-0 right-0 max-h-[85vh] bg-[#1C1C1E] rounded-t-[14px] z-[100] shadow-2xl shadow-black/60 transition-transform duration-300 ease-out ${
          isOpen ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* Pull Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-9 h-[5px] rounded-full bg-[rgba(235,235,245,0.3)]" />
        </div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-4 w-8 h-8 rounded-full bg-[#2C2C2E] hover:bg-[#3A3A3C] flex items-center justify-center text-[rgba(235,235,245,0.6)] hover:text-white transition-all"
        >
          <X size={14} />
        </button>

        {/* Panel Content */}
        <div className="overflow-y-auto px-5 pb-8 pt-2 max-h-[calc(85vh-40px)]">
          {renderContent()}
        </div>
      </div>
    </>
  );
}

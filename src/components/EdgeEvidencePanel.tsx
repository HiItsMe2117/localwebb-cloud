import { useState, useCallback, useEffect } from 'react';
import type { Edge, Node } from 'reactflow';
import { X, ExternalLink, Loader2, FileText, Search, CheckCircle, AlertTriangle, Trash2 } from 'lucide-react';
import { getFileUrl } from '../utils/files';
import axios from 'axios';

interface EdgeEvidencePanelProps {
  edge: Edge | null;
  allNodes: Node[];
  caseId: string;
  onClose: () => void;
  onPinEdge?: (edge: Edge) => void;
  onSolidify?: (edgeId: string) => void;
  onUpdateLabel?: (edgeId: string, newLabel: string) => Promise<void>;
  onDeleteEdge?: (edgeId: string) => Promise<void>;
}

const CONFIDENCE_COLORS: Record<string, string> = {
  STATED: '#30D158',
  INFERRED: '#FBBF24',
  SPECULATIVE: '#FF453A',
};

export default function EdgeEvidencePanel({ edge, allNodes, caseId, onClose, onPinEdge, onSolidify, onUpdateLabel, onDeleteEdge }: EdgeEvidencePanelProps) {
  const [editLabel, setEditLabel] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [evidenceResult, setEvidenceResult] = useState<{
    found: boolean;
    evidence_text: string;
    source_filename: string;
    source_page: number;
    ai_assessment: string;
  } | null>(null);

  const sourceNode = allNodes.find(n => n.id === edge?.source);
  const targetNode = allNodes.find(n => n.id === edge?.target);

  const findEvidence = useCallback(async () => {
    if (!edge || !sourceNode || !targetNode) return;
    setIsSearching(true);
    setEvidenceResult(null);
    try {
      const res = await axios.post(`/api/cases/${caseId}/graph/edges/${edge.id}/find-evidence`, {
        source_label: sourceNode.data?.label || edge.source,
        target_label: targetNode.data?.label || edge.target,
      });
      setEvidenceResult(res.data);
    } catch (err) {
      console.error('Failed to find evidence:', err);
      setEvidenceResult({ found: false, evidence_text: '', source_filename: '', source_page: 0, ai_assessment: 'Search failed. Please try again.' });
    } finally {
      setIsSearching(false);
    }
  }, [edge, sourceNode, targetNode, caseId]);

  const handleSolidify = useCallback(async () => {
    if (!edge) return;
    try {
      await axios.patch(`/api/cases/${caseId}/graph/edges/${edge.id}/solidify`);
      onSolidify?.(edge.id);
    } catch (err) {
      console.error('Failed to solidify edge:', err);
    }
  }, [edge, caseId, onSolidify]);

  // Sync edit label when edge changes
  useEffect(() => {
    setEditLabel((edge?.label as string) || '');
  }, [edge?.id, edge?.label]);

  const handleSaveLabel = useCallback(async () => {
    if (!edge || !onUpdateLabel) return;
    setIsSaving(true);
    try {
      await onUpdateLabel(edge.id, editLabel);
    } finally {
      setIsSaving(false);
    }
  }, [edge, editLabel, onUpdateLabel]);

  const handleDelete = useCallback(async () => {
    if (!edge || !onDeleteEdge) return;
    setIsDeleting(true);
    try {
      await onDeleteEdge(edge.id);
    } finally {
      setIsDeleting(false);
    }
  }, [edge, onDeleteEdge]);

  if (!edge) return null;

  const isCaseLocal = edge.data?.isCaseLocal;
  const isHypothesis = edge.data?.isHypothesis;
  const isGlobal = !isCaseLocal;
  const confidence = edge.data?.confidence || '';
  const evidenceText = edge.data?.evidence_text || '';
  const sourceFilename = edge.data?.source_filename || '';
  const sourcePage = edge.data?.source_page;
  const dateMentioned = edge.data?.date_mentioned;

  return (
    <div className="absolute top-0 right-0 bottom-0 w-80 z-30 bg-[#1C1C1E] border-l border-[rgba(84,84,88,0.65)] shadow-2xl flex flex-col transform transition-transform duration-300 translate-x-0 animate-in slide-in-from-right duration-300">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-[rgba(84,84,88,0.35)] flex items-center justify-between">
        <div className="overflow-hidden">
          <p className="text-[13px] font-semibold text-white truncate">
            {edge.label || edge.data?.predicate || 'Connection'}
          </p>
          <p className="text-[10px] text-[rgba(235,235,245,0.4)] mt-0.5">
            {sourceNode?.data?.label || edge.source} → {targetNode?.data?.label || edge.target}
          </p>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-[#2C2C2E] rounded-lg shrink-0">
          <X size={14} className="text-[rgba(235,235,245,0.4)]" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Edge type badge */}
        <div className="flex items-center gap-2">
          {isHypothesis && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FBBF24]/15 text-[#FBBF24] text-[10px] font-bold uppercase tracking-wider">
              <AlertTriangle size={10} />
              Hypothesis
            </span>
          )}
          {isCaseLocal && !isHypothesis && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#007AFF]/15 text-[#007AFF] text-[10px] font-bold uppercase tracking-wider">
              Manual Connection
            </span>
          )}
          {isGlobal && confidence && (
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider"
              style={{
                backgroundColor: `${CONFIDENCE_COLORS[confidence] || '#9ca3af'}15`,
                color: CONFIDENCE_COLORS[confidence] || '#9ca3af',
              }}
            >
              {confidence}
            </span>
          )}
        </div>

        {/* Global edge evidence */}
        {isGlobal && evidenceText && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">Evidence</p>
            <blockquote className="border-l-2 border-[rgba(84,84,88,0.65)] pl-3 py-1">
              <p className="text-[12px] text-[rgba(235,235,245,0.6)] leading-relaxed italic">
                "{evidenceText}"
              </p>
            </blockquote>
          </div>
        )}

        {/* Source file link */}
        {isGlobal && sourceFilename && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">Source Document</p>
            <a
              href={getFileUrl(sourceFilename, sourcePage)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 bg-[#2C2C2E] rounded-lg hover:bg-[#3A3A3C] transition-colors group"
            >
              <FileText size={14} className="text-[#007AFF] shrink-0" />
              <div className="flex-1 overflow-hidden">
                <p className="text-[12px] text-white truncate group-hover:text-[#007AFF] transition-colors">
                  {sourceFilename}
                </p>
                {sourcePage != null && sourcePage > 0 && (
                  <p className="text-[10px] text-[rgba(235,235,245,0.3)]">Page {sourcePage}</p>
                )}
              </div>
              <ExternalLink size={12} className="text-[rgba(235,235,245,0.3)] shrink-0" />
            </a>
          </div>
        )}

        {/* Date mentioned */}
        {dateMentioned && (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">Date Mentioned</p>
            <p className="text-[12px] text-[rgba(235,235,245,0.6)]">{dateMentioned}</p>
          </div>
        )}

        {/* Case-local: inline edit & delete */}
        {isCaseLocal && !isHypothesis && onUpdateLabel && onDeleteEdge && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">Edit Connection</p>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={editLabel}
                onChange={e => setEditLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveLabel(); }}
                placeholder="Label..."
                className="flex-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-lg px-2.5 py-1.5 text-[12px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors"
              />
              <button
                onClick={handleSaveLabel}
                disabled={isSaving}
                className="shrink-0 flex items-center gap-1 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-white transition-colors"
              >
                {isSaving ? <Loader2 size={11} className="animate-spin" /> : 'Save'}
              </button>
            </div>
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="w-full flex items-center justify-center gap-1.5 bg-[#FF453A] hover:bg-[#FF3B30] disabled:opacity-50 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white transition-colors"
            >
              {isDeleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
              Delete Connection
            </button>
          </div>
        )}

        {/* Pin (promote) button for global edges */}
        {isGlobal && onPinEdge && (
          <button
            onClick={() => onPinEdge(edge)}
            className="w-full flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] px-3 py-2 rounded-xl text-[12px] font-semibold text-white transition-colors"
          >
            <CheckCircle size={14} />
            Pin Connection
          </button>
        )}

        {/* Hypothesis: find evidence */}
        {isHypothesis && (
          <div className="space-y-3">
            <button
              onClick={findEvidence}
              disabled={isSearching}
              className="w-full flex items-center justify-center gap-2 bg-[#FBBF24] hover:bg-[#F5A623] disabled:opacity-50 px-3 py-2 rounded-xl text-[12px] font-semibold text-black transition-colors"
            >
              {isSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              Find Evidence
            </button>

            {evidenceResult && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">AI Assessment</p>
                <div className="bg-[#2C2C2E] rounded-lg px-3 py-2.5">
                  <p className="text-[12px] text-[rgba(235,235,245,0.6)] leading-relaxed whitespace-pre-wrap">
                    {evidenceResult.ai_assessment}
                  </p>
                </div>
                {evidenceResult.found && evidenceResult.evidence_text && (
                  <>
                    <blockquote className="border-l-2 border-[#FBBF24] pl-3 py-1">
                      <p className="text-[12px] text-[rgba(235,235,245,0.6)] leading-relaxed italic">
                        "{evidenceResult.evidence_text}"
                      </p>
                    </blockquote>
                    {evidenceResult.source_filename && (
                      <a
                        href={getFileUrl(evidenceResult.source_filename, evidenceResult.source_page)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-2 bg-[#2C2C2E] rounded-lg hover:bg-[#3A3A3C] transition-colors group"
                      >
                        <FileText size={14} className="text-[#FBBF24] shrink-0" />
                        <p className="text-[12px] text-white truncate flex-1">{evidenceResult.source_filename}</p>
                        <ExternalLink size={12} className="text-[rgba(235,235,245,0.3)] shrink-0" />
                      </a>
                    )}
                    <button
                      onClick={handleSolidify}
                      className="w-full flex items-center justify-center gap-2 bg-[#30D158] hover:bg-[#28B84C] px-3 py-2 rounded-xl text-[12px] font-semibold text-white transition-colors"
                    >
                      <CheckCircle size={14} />
                      Solidify — Mark as Confirmed
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

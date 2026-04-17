import { useState, useRef, useEffect, useMemo } from 'react';
import { Shield, Loader2, Check, X, Search, ChevronRight, Database, Plus, FlaskConical, ChevronDown, AlertTriangle, HelpCircle, Heart, Globe, FolderOpen, Folder, Merge, Trash2, CheckSquare, Square, CornerDownRight, Lightbulb } from 'lucide-react';
import { toast } from 'sonner';
import type { Case, ScanFinding, TheoryResult } from '../types';
import { CASE_CATEGORIES } from '../types';
import InvestigationSteps from './InvestigationSteps';
import axios from 'axios';

interface CasesPanelProps {
  cases: Case[];
  scanFindings: ScanFinding[];
  isScanning: boolean;
  onScan: () => void;
  onAccept: (finding: ScanFinding) => void;
  onDismiss: (finding: ScanFinding) => void;
  onAcceptAll: () => void;
  onOpenCase: (caseId: string) => void;
  onCreateCase: (title: string, category: string) => void;
  onTheoryInvestigate: (theory: string, caseIds: string[], mode: 'files_only' | 'files_web') => void;
  isTestingTheory: boolean;
  theoryResult: TheoryResult | null;
  onAcceptTheory: () => void;
  onDismissTheory: () => void;
  onRefresh?: () => void;
  readOnly?: boolean;
}

function CategoryBadge({ category }: { category: string }) {
  const config = CASE_CATEGORIES[category] || CASE_CATEGORIES.other;
  return (
    <span
      className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
      style={{ backgroundColor: config.color + '20', color: config.color }}
    >
      {config.label}
    </span>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.7 ? '#FF453A' : confidence >= 0.4 ? '#FF9F0A' : '#8E8E93';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-[#2C2C2E] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-[11px] font-mono" style={{ color }}>{pct}%</span>
    </div>
  );
}

function FindingCard({ finding, onAccept, onDismiss }: {
  finding: ScanFinding;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-[15px] font-semibold text-white truncate">{finding.title}</h3>
          <div className="mt-1">
            <CategoryBadge category={finding.category} />
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onDismiss}
            className="w-8 h-8 rounded-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center hover:bg-[#3A3A3C] transition-colors"
          >
            <X size={14} className="text-[rgba(235,235,245,0.4)]" />
          </button>
          <button
            onClick={onAccept}
            className="w-8 h-8 rounded-full bg-[#30D158]/20 border border-[#30D158]/30 flex items-center justify-center hover:bg-[#30D158]/30 transition-colors"
          >
            <Check size={14} className="text-[#30D158]" />
          </button>
        </div>
      </div>

      <ConfidenceBar confidence={finding.confidence} />

      <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed">
        {finding.summary}
      </p>

      {finding.entity_ids.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {finding.entity_ids.slice(0, 6).map((eid) => (
            <span key={eid} className="text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] px-2 py-0.5 rounded-lg">
              {eid.replace(/_/g, ' ')}
            </span>
          ))}
          {finding.entity_ids.length > 6 && (
            <span className="text-[11px] text-[rgba(235,235,245,0.3)]">
              +{finding.entity_ids.length - 6} more
            </span>
          )}
        </div>
      )}

      {finding.sources && finding.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {finding.sources.slice(0, 3).map((s, i) => (
            <span key={i} className="text-[10px] text-[rgba(235,235,245,0.3)] flex items-center gap-1">
              <Database size={10} />
              {s.filename} (p.{s.page})
            </span>
          ))}
          {finding.sources.length > 3 && (
            <span className="text-[10px] text-[rgba(235,235,245,0.2)]">
              +{finding.sources.length - 3} more sources
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const VERDICT_CONFIG: Record<string, { label: string; color: string; icon: typeof Check }> = {
  supported:           { label: 'Supported',           color: '#30D158', icon: Check },
  partially_supported: { label: 'Partially Supported', color: '#FF9F0A', icon: AlertTriangle },
  inconclusive:        { label: 'Inconclusive',        color: '#8E8E93', icon: HelpCircle },
  contradicted:        { label: 'Contradicted',        color: '#FF453A', icon: X },
};

function TheoryResultCard({ result, onAccept, onDismiss }: {
  result: TheoryResult;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const verdict = result.verdict;
  if (!verdict) return null;

  const config = VERDICT_CONFIG[verdict.verdict] || VERDICT_CONFIG.inconclusive;
  const VerdictIcon = config.icon;
  const pct = Math.round(verdict.confidence * 100);

  return (
    <div className="bg-[#1C1C1E] border border-[#AF52DE]/30 rounded-2xl p-4 space-y-3 mt-4 max-w-2xl mx-auto">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="flex items-center gap-1 text-[13px] font-bold px-2.5 py-0.5 rounded-full"
              style={{ backgroundColor: config.color + '20', color: config.color }}
            >
              <VerdictIcon size={12} />
              {config.label}
            </span>
            <span className="text-[11px] font-mono" style={{ color: config.color }}>{pct}%</span>
          </div>
          <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed line-clamp-3">
            {result.theory}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onDismiss}
            className="w-8 h-8 rounded-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center hover:bg-[#3A3A3C] transition-colors"
          >
            <X size={14} className="text-[rgba(235,235,245,0.4)]" />
          </button>
          <button
            onClick={onAccept}
            className="w-8 h-8 rounded-full bg-[#30D158]/20 border border-[#30D158]/30 flex items-center justify-center hover:bg-[#30D158]/30 transition-colors"
          >
            <Check size={14} className="text-[#30D158]" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[#30D158] font-medium">{verdict.supporting_count}</span>
          <span className="text-[10px] text-[rgba(235,235,245,0.3)]">supporting</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[#FF453A] font-medium">{verdict.contradicting_count}</span>
          <span className="text-[10px] text-[rgba(235,235,245,0.3)]">contradicting</span>
        </div>
      </div>

      {verdict.entities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {verdict.entities.slice(0, 8).map((ent) => (
            <span key={ent} className="text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] px-2 py-0.5 rounded-lg">
              {ent}
            </span>
          ))}
        </div>
      )}

      {verdict.claims.length > 0 && (
        <div className="space-y-1.5">
          {verdict.claims.slice(0, 5).map((claim, i) => {
            const claimConfig = VERDICT_CONFIG[claim.finding] || VERDICT_CONFIG.inconclusive;
            return (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: claimConfig.color }} />
                <span className="text-[rgba(235,235,245,0.5)] truncate flex-1">{claim.text}</span>
                <span className="text-[rgba(235,235,245,0.3)] shrink-0">{claim.strength}</span>
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[11px] text-[rgba(235,235,245,0.3)] hover:text-[rgba(235,235,245,0.5)] transition-colors"
      >
        <ChevronDown size={10} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        {expanded ? 'Hide report' : 'Show full report'}
      </button>

      {expanded && (
        <div className="border-t border-[rgba(84,84,88,0.35)] pt-3 mt-2">
          <div className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
            {result.reportText}
          </div>
        </div>
      )}
    </div>
  );
}

function CaseCard({ caseData, onOpen }: { 
  caseData: Case & { liked?: boolean, likes_count?: number, owner_username?: string }; 
  onOpen: () => void;
}) {
  const [liked, setLiked] = useState(caseData.liked || false);
  const [likesCount, setLikesCount] = useState(caseData.likes_count || 0);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (liked) {
        await axios.delete(`/api/cases/like/${caseData.id}`);
        setLiked(false);
        setLikesCount(prev => prev - 1);
      } else {
        await axios.post('/api/cases/like', { case_id: caseData.id });
        setLiked(true);
        setLikesCount(prev => prev + 1);
      }
    } catch (err) {
      console.error('Failed to toggle like:', err);
    }
  };

  return (
    <button
      onClick={onOpen}
      className="w-full bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4 text-left hover:bg-[#2C2C2E] transition-colors active:scale-[0.99] flex items-center justify-between"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-[15px] font-semibold text-white truncate">{caseData.title}</h3>
          {caseData.is_public && <Globe size={12} className="text-[rgba(235,235,245,0.3)]" />}
        </div>
        <div className="flex items-center gap-2">
          <CategoryBadge category={caseData.category} />
          <span className="text-[11px] text-[rgba(235,235,245,0.3)]">
            {caseData.owner_username ? `@${caseData.owner_username} • ` : ''}
            {new Date(caseData.updated_at).toLocaleDateString()}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <div 
          onClick={handleLike}
          className={`flex items-center gap-1.5 transition-colors cursor-pointer ${liked ? 'text-[#FF2D55]' : 'text-[rgba(235,235,245,0.3)] hover:text-white'}`}
        >
          <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
          <span className="text-[12px] font-mono">{likesCount}</span>
        </div>
        <ChevronRight size={18} className="text-[rgba(235,235,245,0.2)]" />
      </div>
    </button>
  );
}

interface CaseTreeNode {
  case: Case & { liked?: boolean; likes_count?: number; owner_username?: string };
  children: CaseTreeNode[];
}

function buildCaseTree(cases: Case[]): CaseTreeNode[] {
  const map = new Map<string, CaseTreeNode>();
  for (const c of cases) {
    map.set(c.id, { case: c, children: [] });
  }
  const roots: CaseTreeNode[] = [];
  for (const c of cases) {
    const node = map.get(c.id)!;
    if (c.parent_case_id && map.has(c.parent_case_id)) {
      map.get(c.parent_case_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function CaseTreeItem({ node, depth = 0, onOpen, selectedIds, onToggleSelect, selectMode }: {
  node: CaseTreeNode;
  depth?: number;
  onOpen: (id: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  selectMode: boolean;
}) {
  const selected = selectedIds.has(node.case.id);
  const [expanded, setExpanded] = useState(depth === 0 && node.children.length > 0);
  const hasChildren = node.children.length > 0;
  const c = node.case;
  const config = CASE_CATEGORIES[c.category] || CASE_CATEGORIES.other;
  const isRoot = depth === 0;

  // Count total descendants (recursive) for better badge
  const descendantCount = (n: CaseTreeNode): number =>
    n.children.reduce((sum, child) => sum + 1 + descendantCount(child), 0);
  const totalSubs = descendantCount(node);

  return (
    <div className={isRoot ? 'mt-1.5 first:mt-0' : ''}>
      <div
        className={`relative flex items-stretch group transition-all rounded-xl overflow-hidden ${
          selected
            ? 'bg-[#007AFF]/10 ring-1 ring-[#007AFF]/40'
            : isRoot
            ? 'bg-[#1C1C1E]/60 hover:bg-[#1C1C1E] border border-[rgba(84,84,88,0.35)] hover:border-[rgba(84,84,88,0.65)]'
            : 'hover:bg-[#1C1C1E]/60'
        }`}
        style={{ marginLeft: `${depth * 24}px` }}
      >
        {/* Category-colored left bar */}
        <div
          className="shrink-0 w-1"
          style={{ backgroundColor: config.color, opacity: isRoot ? 0.9 : 0.5 }}
        />

        {/* Tree connector for sub-items */}
        {!isRoot && (
          <div className="shrink-0 flex items-center pl-2 pr-1">
            <CornerDownRight size={12} className="text-[rgba(235,235,245,0.2)]" />
          </div>
        )}

        <div className="flex-1 flex items-center gap-2.5 px-3 py-2.5 min-w-0">
          {selectMode && (
            <button onClick={() => onToggleSelect(c.id)} className="shrink-0">
              {selected ? (
                <CheckSquare size={16} className="text-[#007AFF]" />
              ) : (
                <Square size={16} className="text-[rgba(235,235,245,0.3)]" />
              )}
            </button>
          )}

          {/* Folder / dot icon — category-tinted */}
          {hasChildren ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#2C2C2E] transition-colors"
              style={{ color: config.color }}
            >
              {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
            </button>
          ) : (
            <div className="shrink-0 w-7 h-7 flex items-center justify-center">
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: config.color, opacity: 0.7 }}
              />
            </div>
          )}

          {/* Title + summary */}
          <button
            onClick={() => onOpen(c.id)}
            className="flex-1 min-w-0 text-left"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`truncate text-white ${
                  isRoot ? 'text-[15px] font-semibold' : 'text-[13.5px] font-medium'
                }`}
              >
                {c.title}
              </span>
              <CategoryBadge category={c.category} />
              {c.status === 'closed' && (
                <span className="text-[10px] text-[rgba(235,235,245,0.35)] font-mono uppercase tracking-wide">
                  Closed
                </span>
              )}
            </div>
            {c.summary && (
              <div className="mt-0.5 text-[12px] text-[rgba(235,235,245,0.4)] line-clamp-1">
                {c.summary}
              </div>
            )}
          </button>

          {/* Stats: sub-case count */}
          {hasChildren && (
            <div
              className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#2C2C2E]/70"
              title={`${totalSubs} sub-cases total`}
            >
              <Folder size={10} className="text-[rgba(235,235,245,0.4)]" />
              <span className="text-[11px] font-mono text-[rgba(235,235,245,0.55)]">
                {node.children.length}
                {totalSubs !== node.children.length && (
                  <span className="text-[rgba(235,235,245,0.3)]"> / {totalSubs}</span>
                )}
              </span>
            </div>
          )}

          <ChevronRight
            size={14}
            className="shrink-0 text-[rgba(235,235,245,0.2)] opacity-0 group-hover:opacity-100 transition-opacity"
          />
        </div>
      </div>

      {expanded && hasChildren && (
        <div className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <CaseTreeItem
              key={child.case.id}
              node={child}
              depth={depth + 1}
              onOpen={onOpen}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
              selectMode={selectMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CasesPanel({
  cases, scanFindings, isScanning,
  onScan, onAccept, onDismiss, onAcceptAll, onOpenCase, onCreateCase,
  onTheoryInvestigate, isTestingTheory, theoryResult, onAcceptTheory, onDismissTheory,
  onRefresh,
  readOnly = false,
}: CasesPanelProps) {
  const [activeTab, setActiveTab] = useState<'my-cases' | 'explore' | 'ai-research'>('my-cases');
  const [exploreCases, setExploreCases] = useState<Case[]>([]);
  const [isExploreLoading, setIsExploreLoading] = useState(false);
  const [aiResearchCases, setAiResearchCases] = useState<Case[]>([]);
  const [isAiResearchLoading, setIsAiResearchLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('other');
  const [isCreating, setIsCreating] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [showTheoryForm, setShowTheoryForm] = useState(false);
  const [theoryText, setTheoryText] = useState('');
  const [theoryMode, setTheoryMode] = useState<'files_only' | 'files_web'>('files_only');
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const theoryTextareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Merge / select mode ──
  const [selectMode, setSelectMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<Set<string>>(new Set());
  const [isMerging, setIsMerging] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);

  const toggleMergeSelect = (id: string) => {
    setMergeSelection(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleMerge = async () => {
    if (!mergeTarget || mergeSelection.size < 1) return;
    const sourceIds = Array.from(mergeSelection).filter(id => id !== mergeTarget);
    if (sourceIds.length === 0) {
      toast.error('Select at least one case to merge into the target');
      return;
    }
    if (!window.confirm(`Merge ${sourceIds.length} case(s) into "${cases.find(c => c.id === mergeTarget)?.title}"? Source cases will be deleted.`)) return;
    setIsMerging(true);
    try {
      await axios.post(`/api/cases/${mergeTarget}/merge`, { source_case_ids: sourceIds });
      toast.success(`Merged ${sourceIds.length} case(s) successfully`);
      setSelectMode(false);
      setMergeSelection(new Set());
      setMergeTarget(null);
      // Trigger refresh via parent — cases prop will update
      onRefresh?.();
    } catch (err) {
      console.error('Merge failed:', err);
      toast.error('Merge failed');
    } finally {
      setIsMerging(false);
    }
  };

  // ── Build tree from flat case list ──
  const aiResearchIds = useMemo(() => new Set(aiResearchCases.map(c => c.id)), [aiResearchCases]);
  const myCases = useMemo(() => cases.filter(c => !aiResearchIds.has(c.id)), [cases, aiResearchIds]);
  const caseTree = useMemo(() => buildCaseTree(myCases), [myCases]);
  const aiResearchTree = useMemo(() => buildCaseTree(aiResearchCases), [aiResearchCases]);

  const loadExploreCases = async (query = '') => {
    setIsExploreLoading(true);
    try {
      const res = await axios.get(`/api/cases/trending${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      setExploreCases(res.data.cases || []);
    } catch (err) {
      console.error('Failed to load explore cases:', err);
    } finally {
      setIsExploreLoading(false);
    }
  };

  const loadAiResearchCases = async () => {
    setIsAiResearchLoading(true);
    try {
      const res = await axios.get('/api/cases/ai-research');
      setAiResearchCases(res.data.cases || []);
    } catch (err) {
      console.error('Failed to load AI research cases:', err);
    } finally {
      setIsAiResearchLoading(false);
    }
  };

  // Load AI research cases on mount so we can filter them out of My Cases
  useEffect(() => {
    loadAiResearchCases();
  }, []);

  useEffect(() => {
    if (activeTab === 'explore') {
      loadExploreCases(searchQuery);
    } else if (activeTab === 'ai-research') {
      loadAiResearchCases();
    }
  }, [activeTab, searchQuery]);

  const hasFindings = scanFindings.length > 0;
  const hasCases = myCases.length > 0;

  const handleBiggerPicture = async () => {
    setIsSynthesizing(true);
    try {
      const checkRes = await axios.get('/api/cases/bigger-picture');
      if (checkRes.data.case) {
        onOpenCase(checkRes.data.case.id);
      } else {
        const res = await axios.post('/api/cases/bigger-picture/synthesize');
        onOpenCase(res.data.case_id);
        onRefresh?.();
      }
    } catch (err) {
      console.error('Bigger picture failed:', err);
      toast.error('Failed to generate bigger picture');
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim() || isCreating) return;
    setIsCreating(true);
    await onCreateCase(newTitle.trim(), newCategory);
    setNewTitle('');
    setNewCategory('other');
    setShowCreateForm(false);
    setIsCreating(false);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="shrink-0 px-5 pt-4 pb-2 bg-black">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-[28px] font-bold tracking-tight text-white">Cases</h1>
          {!readOnly && <div className="flex items-center gap-2">
            {hasCases && (
              <button
                onClick={() => {
                  setSelectMode(v => !v);
                  if (selectMode) { setMergeSelection(new Set()); setMergeTarget(null); }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors ${
                  selectMode ? 'bg-[#FF9F0A] text-black' : 'bg-[#1C1C1E] text-[rgba(235,235,245,0.6)] border border-[rgba(84,84,88,0.65)] hover:bg-[#2C2C2E]'
                }`}
              >
                <Merge size={14} />
                {selectMode ? 'Cancel' : 'Manage'}
              </button>
            )}
            <button
              onClick={() => { setShowTheoryForm(v => !v); setShowCreateForm(false); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors ${
                showTheoryForm ? 'bg-[#AF52DE] text-white' : 'bg-[#AF52DE]/20 text-[#AF52DE] hover:bg-[#AF52DE]/30'
              }`}
            >
              <FlaskConical size={14} />
              Theory
            </button>
            <button
              onClick={handleBiggerPicture}
              disabled={isSynthesizing}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors ${
                isSynthesizing ? 'opacity-50' : ''
              } bg-[#FFD60A]/20 text-[#FFD60A] hover:bg-[#FFD60A]/30`}
            >
              {isSynthesizing ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />}
              Bigger Picture
            </button>
            <button
              onClick={() => { setShowCreateForm(v => !v); setShowTheoryForm(false); }}
              className="flex items-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors"
            >
              <Plus size={14} />
              New Case
            </button>
            {hasCases && (
              <button
                onClick={onScan}
                disabled={isScanning}
                className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full text-[13px] font-medium border border-[rgba(84,84,88,0.65)] hover:bg-[#2C2C2E] transition-colors disabled:opacity-50"
              >
                {isScanning ? (
                  <Loader2 size={12} className="animate-spin text-[#FF9F0A]" />
                ) : (
                  <Search size={12} className="text-[rgba(235,235,245,0.4)]" />
                )}
                <span className="text-[rgba(235,235,245,0.6)]">
                  {isScanning ? 'Scanning...' : 'Scan'}
                </span>
              </button>
            )}
          </div>}
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-6 border-b border-white/5">
          <button 
            onClick={() => setActiveTab('my-cases')}
            className={`pb-2 text-[13px] font-bold transition-colors relative ${activeTab === 'my-cases' ? 'text-white' : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'}`}
          >
            My Cases
            {activeTab === 'my-cases' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#007AFF] rounded-full" />}
          </button>
          <button
            onClick={() => setActiveTab('explore')}
            className={`pb-2 text-[13px] font-bold transition-colors relative ${activeTab === 'explore' ? 'text-white' : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'}`}
          >
            Explore Community
            {activeTab === 'explore' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#007AFF] rounded-full" />}
          </button>
          <button
            onClick={() => setActiveTab('ai-research')}
            className={`pb-2 text-[13px] font-bold transition-colors relative ${activeTab === 'ai-research' ? 'text-white' : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'}`}
          >
            AI Research
            {activeTab === 'ai-research' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#FF9F0A] rounded-full" />}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="max-w-4xl mx-auto">
        {/* Create case form */}
        {showCreateForm && (
          <div className="bg-[#1C1C1E] border border-[#007AFF]/30 rounded-2xl p-4 space-y-3 mt-4 max-w-2xl mx-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-white">New Case</h3>
              <button onClick={() => setShowCreateForm(false)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>
            <input
              type="text"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="Case title..."
              autoFocus
              className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
            />
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(CASE_CATEGORIES).map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => setNewCategory(key)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors ${
                    newCategory === key
                      ? 'ring-2 ring-offset-1 ring-offset-[#1C1C1E]'
                      : 'opacity-50 hover:opacity-80'
                  }`}
                  style={{
                    backgroundColor: cfg.color + '20',
                    color: cfg.color,
                    ...(newCategory === key ? { ringColor: cfg.color } : {}),
                  }}
                >
                  {cfg.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim() || isCreating}
              className="w-full flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-colors"
            >
              {isCreating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create Case
            </button>
          </div>
        )}

        {/* Theory form */}
        {showTheoryForm && !isTestingTheory && !theoryResult && (
          <div className="bg-[#1C1C1E] border border-[#AF52DE]/30 rounded-2xl p-4 space-y-3 mt-4 max-w-2xl mx-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-white flex items-center gap-2">
                <FlaskConical size={14} className="text-[#AF52DE]" />
                Test a Theory
              </h3>
              <button onClick={() => setShowTheoryForm(false)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>

            {/* Mode Toggle */}
            <div className="flex items-center gap-3 mb-2">
              <p className="text-[11px] text-[rgba(235,235,245,0.4)] font-medium">Source Scope</p>
              <div className="inline-flex bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-lg p-0.5">
                <button
                  onClick={() => setTheoryMode('files_only')}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
                    theoryMode === 'files_only'
                      ? 'bg-[#3A3A3C] text-white shadow-sm'
                      : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                  }`}
                >
                  <Database size={12} />
                  Files Only
                </button>
                <button
                  onClick={() => setTheoryMode('files_web')}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
                    theoryMode === 'files_web'
                      ? 'bg-[#AF52DE]/20 text-[#AF52DE] shadow-sm'
                      : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                  }`}
                >
                  <Globe size={12} />
                  Files + Web
                </button>
              </div>
            </div>

            <textarea
              ref={theoryTextareaRef}
              value={theoryText}
              onChange={e => setTheoryText(e.target.value)}
              placeholder="Describe your theory... e.g., 'Epstein was funneling money through Deutsche Bank to fund VI properties'"
              rows={3}
              className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#AF52DE] transition-colors placeholder:text-[rgba(235,235,245,0.2)] resize-none"
            />
            {cases.length > 0 && (
              <div>
                <p className="text-[11px] text-[rgba(235,235,245,0.4)] mb-2">Cross-reference with existing cases (optional)</p>
                <div className="flex flex-wrap gap-1.5">
                  {cases.slice(0, 10).map(c => {
                    const isSelected = selectedCaseIds.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        onClick={() => setSelectedCaseIds(prev =>
                          isSelected ? prev.filter(id => id !== c.id) : [...prev, c.id]
                        )}
                        className={`text-[11px] px-2.5 py-1 rounded-full transition-colors ${
                          isSelected
                            ? 'bg-[#AF52DE]/20 text-[#AF52DE] ring-1 ring-[#AF52DE]/50'
                            : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                        }`}
                      >
                        {c.title.length > 30 ? c.title.slice(0, 30) + '...' : c.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <button
              onClick={() => {
                if (theoryText.trim()) {
                  onTheoryInvestigate(theoryText.trim(), selectedCaseIds, theoryMode);
                }
              }}
              disabled={!theoryText.trim()}
              className="w-full flex items-center justify-center gap-2 bg-[#AF52DE] hover:bg-[#9B3DC8] disabled:opacity-30 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-colors"
            >
              <FlaskConical size={14} />
              Investigate Theory
            </button>
          </div>
        )}

        {/* Theory investigation progress */}
        {isTestingTheory && theoryResult && (
          <div className="mt-4 max-w-2xl mx-auto space-y-4">
            <div className="bg-[#1C1C1E] border border-[#AF52DE]/30 rounded-2xl p-4">
              <p className="text-[13px] text-[rgba(235,235,245,0.6)] mb-3 line-clamp-2">
                <span className="text-[#AF52DE] font-semibold">Testing:</span> {theoryResult.theory}
              </p>
              <InvestigationSteps steps={theoryResult.steps} />
              {theoryResult.reportText && (
                <div className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto mt-3 border-t border-[rgba(84,84,88,0.35)] pt-3">
                  {theoryResult.reportText}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Theory result */}
        {!isTestingTheory && theoryResult?.verdict && (
          <div className="max-w-2xl mx-auto">
            <TheoryResultCard result={theoryResult} onAccept={onAcceptTheory} onDismiss={onDismissTheory} />
          </div>
        )}

        {/* Scanning overlay */}
        {isScanning && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 size={40} className="text-[#007AFF] animate-spin mb-6" />
            <p className="text-[17px] font-bold text-white mb-2">Scanning for Suspicious Activity</p>
            <p className="text-[13px] text-[rgba(235,235,245,0.4)] text-center max-w-sm">
              Analyzing knowledge graph and documents for patterns of money laundering, fraud, and other suspicious activity...
            </p>
          </div>
        )}

        {/* Proposals view */}
        {!isScanning && hasFindings && (
          <div className="space-y-4 max-w-2xl mx-auto">
            <div className="flex items-center justify-between">
              <p className="text-[15px] font-medium text-white">
                {scanFindings.length} finding{scanFindings.length !== 1 ? 's' : ''} detected
              </p>
                          <button
                            onClick={() => {
                              if (window.confirm(`Are you sure you want to accept all ${scanFindings.length} findings and create cases for them?`)) {
                                onAcceptAll();
                              }
                            }}
                            className="text-[13px] font-medium text-[#007AFF] hover:text-[#0A84FF] transition-colors"
                          >
                            Accept All
                          </button>            </div>
            {scanFindings.map((f, i) => (
              <FindingCard
                key={`${f.title}-${i}`}
                finding={f}
                onAccept={() => {
                  if (window.confirm(`Create a new investigation case for "${f.title}"?`)) {
                    onAccept(f);
                  }
                }}
                onDismiss={() => onDismiss(f)}
              />
            ))}
          </div>
        )}

        {/* Cases list */}
        {!isScanning && !hasFindings && (
          <div className="space-y-6 max-w-2xl mx-auto mt-6">
            {activeTab === 'my-cases' ? (
              <>
                {!hasCases && !showCreateForm && !showTheoryForm && (
                  <div className="flex-1 flex flex-col items-center justify-center py-20">
                    <div className="w-16 h-16 bg-[#1C1C1E] rounded-full flex items-center justify-center mb-6 border border-[rgba(84,84,88,0.65)]">
                      <Shield size={32} className="text-[rgba(235,235,245,0.3)]" />
                    </div>
                    <h2 className="text-[22px] font-bold text-white mb-2">AI Case Builder</h2>
                    <p className="text-[rgba(235,235,245,0.6)] text-[15px] max-w-sm mx-auto text-center leading-relaxed mb-8">
                      Scan your knowledge graph and documents for suspicious patterns. The AI will propose investigation cases for your review.
                    </p>
                    <button
                      onClick={onScan}
                      className="flex items-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] px-6 py-3 rounded-full text-[15px] font-semibold transition-colors active:scale-95"
                    >
                      <Search size={18} />
                      Scan for Suspicious Activity
                    </button>
                  </div>
                )}

                {/* Merge toolbar */}
                {selectMode && mergeSelection.size > 0 && (
                  <div className="bg-[#1C1C1E] border border-[#FF9F0A]/30 rounded-2xl p-4 space-y-3 mb-4">
                    <div className="flex items-center justify-between">
                      <p className="text-[13px] font-semibold text-white">
                        {mergeSelection.size} case{mergeSelection.size !== 1 ? 's' : ''} selected
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            const ids = Array.from(mergeSelection);
                            if (ids.length < 1) return;
                            axios.patch('/api/cases/bulk-update', { case_ids: ids, is_public: true }).then(() => {
                              toast.success(`Made ${ids.length} case(s) public`);
                              setSelectMode(false);
                              setMergeSelection(new Set());
                              onRefresh?.();
                            }).catch(() => toast.error('Failed to update cases'));
                          }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold bg-[#30D158]/20 text-[#30D158] hover:bg-[#30D158]/30 transition-colors"
                        >
                          <Globe size={12} />
                          Make Public
                        </button>
                        <button
                          onClick={() => {
                            const ids = Array.from(mergeSelection);
                            if (ids.length < 1) return;
                            if (window.confirm(`Delete ${ids.length} selected case(s)? This cannot be undone.`)) {
                              Promise.all(ids.map(id => axios.delete(`/api/cases/${id}`))).then(() => {
                                toast.success(`Deleted ${ids.length} case(s)`);
                                setSelectMode(false);
                                setMergeSelection(new Set());
                                onRefresh?.();
                              }).catch(() => toast.error('Delete failed'));
                            }
                          }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold bg-[#FF453A]/20 text-[#FF453A] hover:bg-[#FF453A]/30 transition-colors"
                        >
                          <Trash2 size={12} />
                          Delete
                        </button>
                      </div>
                    </div>

                    {mergeSelection.size >= 2 && (
                      <div className="space-y-2 border-t border-[rgba(84,84,88,0.35)] pt-3">
                        <p className="text-[11px] text-[rgba(235,235,245,0.4)]">Merge into:</p>
                        <div className="flex flex-wrap gap-1.5">
                          {Array.from(mergeSelection).map(id => {
                            const c = cases.find(cc => cc.id === id);
                            if (!c) return null;
                            return (
                              <button
                                key={id}
                                onClick={() => setMergeTarget(id)}
                                className={`text-[12px] px-3 py-1 rounded-full transition-colors ${
                                  mergeTarget === id
                                    ? 'bg-[#30D158]/20 text-[#30D158] ring-1 ring-[#30D158]/50'
                                    : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] hover:text-white'
                                }`}
                              >
                                {c.title.length > 35 ? c.title.slice(0, 35) + '...' : c.title}
                              </button>
                            );
                          })}
                        </div>
                        {mergeTarget && (
                          <button
                            onClick={handleMerge}
                            disabled={isMerging}
                            className="w-full flex items-center justify-center gap-2 bg-[#FF9F0A] hover:bg-[#FF9F0A]/80 text-black px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors disabled:opacity-50"
                          >
                            {isMerging ? <Loader2 size={14} className="animate-spin" /> : <Merge size={14} />}
                            Merge {mergeSelection.size - 1} case{mergeSelection.size - 1 !== 1 ? 's' : ''} into selected
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Case tree */}
                {hasCases && (
                  <div className="space-y-1">
                    {caseTree.map(node => (
                      <CaseTreeItem
                        key={node.case.id}
                        node={node}
                        depth={0}
                        onOpen={onOpenCase}
                        selectedIds={mergeSelection}
                        onToggleSelect={toggleMergeSelect}
                        selectMode={selectMode}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : activeTab === 'explore' ? (
              <div className="space-y-6">
                <div className="relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[rgba(235,235,245,0.3)]" size={16} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search community investigations..."
                    className="w-full bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl pl-11 pr-4 py-3 text-[15px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
                  />
                </div>

                {isExploreLoading ? (
                  <div className="flex flex-col items-center justify-center py-20">
                    <Loader2 size={32} className="text-[#007AFF] animate-spin mb-4" />
                    <p className="text-[13px] text-[rgba(235,235,245,0.4)]">Loading community cases...</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {exploreCases.length > 0 ? (
                      exploreCases.map(c => (
                        <CaseCard key={c.id} caseData={c} onOpen={() => onOpenCase(c.id)} />
                      ))
                    ) : (
                      <div className="text-center py-20">
                        <Globe size={40} className="mx-auto text-[rgba(235,235,245,0.1)] mb-4" />
                        <p className="text-[rgba(235,235,245,0.4)]">No public cases found matching your search.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* AI Research tab */
              <div className="space-y-6">
                {isAiResearchLoading ? (
                  <div className="flex flex-col items-center justify-center py-20">
                    <Loader2 size={32} className="text-[#FF9F0A] animate-spin mb-4" />
                    <p className="text-[13px] text-[rgba(235,235,245,0.4)]">Loading AI research cases...</p>
                  </div>
                ) : aiResearchCases.length > 0 ? (
                  <div className="space-y-1">
                    {aiResearchTree.map(node => (
                      <CaseTreeItem
                        key={node.case.id}
                        node={node}
                        depth={0}
                        onOpen={onOpenCase}
                        selectedIds={new Set()}
                        onToggleSelect={() => {}}
                        selectMode={false}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center py-20">
                    <div className="w-16 h-16 bg-[#1C1C1E] rounded-full flex items-center justify-center mb-6 border border-[rgba(84,84,88,0.65)]">
                      <FlaskConical size={32} className="text-[rgba(235,235,245,0.3)]" />
                    </div>
                    <h2 className="text-[22px] font-bold text-white mb-2">AI Research Cases</h2>
                    <p className="text-[rgba(235,235,245,0.6)] text-[15px] max-w-sm mx-auto text-center leading-relaxed mb-8">
                      Cases generated by the AI scanner and theory investigations will appear here with their subcases.
                    </p>
                    <button
                      onClick={() => { setActiveTab('my-cases'); onScan(); }}
                      className="flex items-center gap-2 bg-[#FF9F0A] hover:bg-[#FF9F0A]/80 px-6 py-3 rounded-full text-[15px] font-semibold text-black transition-colors active:scale-95"
                    >
                      <Search size={18} />
                      Run AI Scan
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

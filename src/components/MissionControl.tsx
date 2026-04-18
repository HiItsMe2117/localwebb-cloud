import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Activity, Send, ChevronRight, ChevronDown,
  Loader2, CheckCircle2, XCircle, Zap, Target,
  Clock, FolderTree, Search,
  FileText, Link2, CircleDot, Lightbulb, Shield, ExternalLink, RefreshCw,
} from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentStatus {
  is_running: boolean;
  current_task: {
    id: string;
    type: string;
    description: string;
    started_at: string;
  } | null;
  tasks_completed: number;
  theories_tested: number;
  entities_added: number;
  cases_created: number;
  last_heartbeat: string | null;
  queue_stats: {
    queued: number;
    completed: number;
    failed: number;
  };
}

interface ActivityItem {
  id: string;
  action: string;
  description: string;
  task_id: string | null;
  case_id: string | null;
  entity_ids: string[];
  metadata: Record<string, any>;
  created_at: string;
}

interface DirectiveTask {
  id: string;
  type: string;
  description: string;
  priority: number;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  result_summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface DirectiveFindings {
  task: DirectiveTask;
  case_id: string | null;
  case_title: string | null;
  evidence: { id: string; type: string; content: string; created_at: string }[];
  entities: string[];
  timeline_events: { id: string; title: string; event_date: string | null; description: string }[];
}

interface CaseTreeNode {
  id: string;
  title: string;
  category: string;
  status: string;
  summary: string;
  parent_case_id: string | null;
  depth: number;
  operational_question: string | null;
  evidence_count: number;
  entity_count: number;
  timeline_event_count: number;
  children?: CaseTreeNode[];
}

interface Finding {
  id: string;
  action: string;
  description: string;
  metadata: Record<string, any>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  money_laundering: '#FF9F0A',
  fraud: '#FF453A',
  trafficking: '#AF52DE',
  tax_evasion: '#30D158',
  obstruction: '#5AC8FA',
  other: '#8E8E93',
};

const ACTION_ICONS: Record<string, typeof Activity> = {
  started_task: Loader2,
  completed_task: CheckCircle2,
  error: XCircle,
  tested_theory: Lightbulb,
  entity_deep_dive: Search,
  validated_entity: Shield,
  explored_connection: Link2,
  expanded_branch: FolderTree,
  created_case: FolderTree,
  added_entity: CircleDot,
  added_evidence: FileText,
  added_timeline_event: Clock,
  user_directive: Target,
  seeded_cases: Zap,
  seeded_tasks: Zap,
  bigger_picture_synthesis: Lightbulb,
};

const ACTION_COLORS: Record<string, string> = {
  started_task: '#007AFF',
  completed_task: '#30D158',
  error: '#FF453A',
  tested_theory: '#AF52DE',
  entity_deep_dive: '#5AC8FA',
  validated_entity: '#34C759',
  explored_connection: '#FF9F0A',
  expanded_branch: '#5E5CE6',
  created_case: '#30D158',
  added_entity: '#5AC8FA',
  added_evidence: '#FF9F0A',
  added_timeline_event: '#FFD60A',
  user_directive: '#FF6B6B',
  seeded_cases: '#007AFF',
  seeded_tasks: '#007AFF',
  bigger_picture_synthesis: '#FFD60A',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function buildCaseTree(cases: CaseTreeNode[]): CaseTreeNode[] {
  const map = new Map<string, CaseTreeNode>();
  const roots: CaseTreeNode[] = [];

  for (const c of cases) {
    map.set(c.id, { ...c, children: [] });
  }
  for (const c of cases) {
    const node = map.get(c.id)!;
    if (c.parent_case_id && map.has(c.parent_case_id)) {
      map.get(c.parent_case_id)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort: agent operational cases first (have operational_question), then others
  roots.sort((a, b) => {
    if (a.operational_question && !b.operational_question) return -1;
    if (!a.operational_question && b.operational_question) return 1;
    return 0;
  });

  return roots;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({ label, value, icon: Icon, color }: {
  label: string; value: number | string; icon: typeof Activity; color: string;
}) {
  return (
    <div className="bg-[#1C1C1E] rounded-2xl p-4 border border-[rgba(84,84,88,0.36)]">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} style={{ color }} />
        <span className="text-[11px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.4)]">{label}</span>
      </div>
      <div className="text-[24px] font-bold text-white tracking-tight">{value}</div>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = ACTION_ICONS[item.action] || Activity;
  const color = ACTION_COLORS[item.action] || '#8E8E93';
  const isRunning = item.action === 'started_task';

  return (
    <div className="flex gap-3 py-2.5 px-1 border-b border-[rgba(84,84,88,0.18)] last:border-0">
      <div className="shrink-0 mt-0.5">
        <Icon size={14} style={{ color }} className={isRunning ? 'animate-spin' : ''} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-[rgba(235,235,245,0.85)] leading-snug break-words">
          {item.description}
        </p>
        {item.metadata?.verdict && (
          <span
            className="inline-block mt-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
            style={{
              backgroundColor: item.metadata.verdict === 'supported' ? 'rgba(48,209,88,0.15)' :
                item.metadata.verdict === 'contradicted' ? 'rgba(255,69,58,0.15)' :
                  'rgba(255,159,10,0.15)',
              color: item.metadata.verdict === 'supported' ? '#30D158' :
                item.metadata.verdict === 'contradicted' ? '#FF453A' : '#FF9F0A',
            }}
          >
            {item.metadata.verdict.toUpperCase()}
            {item.metadata.confidence ? ` ${Math.round(item.metadata.confidence * 100)}%` : ''}
          </span>
        )}
      </div>
      <span className="text-[11px] text-[rgba(235,235,245,0.25)] shrink-0 tabular-nums">
        {formatTime(item.created_at)}
      </span>
    </div>
  );
}

function CaseTreeItem({ node, depth = 0, onSelect }: {
  node: CaseTreeNode; depth?: number; onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = node.children && node.children.length > 0;
  const catColor = CATEGORY_COLORS[node.category] || '#8E8E93';
  const totalItems = node.evidence_count + node.entity_count + node.timeline_event_count;

  return (
    <div>
      <button
        onClick={() => hasChildren ? setExpanded(!expanded) : onSelect(node.id)}
        className="w-full flex items-center gap-2 py-2 px-2 rounded-lg hover:bg-[rgba(255,255,255,0.04)] transition-colors text-left group"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          expanded
            ? <ChevronDown size={14} className="text-[rgba(235,235,245,0.3)] shrink-0" />
            : <ChevronRight size={14} className="text-[rgba(235,235,245,0.3)] shrink-0" />
        ) : (
          <div className="w-[14px] shrink-0" />
        )}

        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: catColor }} />

        <span className="text-[13px] text-[rgba(235,235,245,0.85)] truncate flex-1">
          {node.title}
        </span>

        {totalItems > 0 && (
          <span className="text-[11px] text-[rgba(235,235,245,0.25)] tabular-nums shrink-0">
            {totalItems}
          </span>
        )}
      </button>

      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <CaseTreeItem key={child.id} node={child} depth={depth + 1} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function DirectiveRowItem({ d, onNavigateToCase }: { d: DirectiveTask; onNavigateToCase: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [findings, setFindings] = useState<DirectiveFindings | null>(null);
  const [loadingFindings, setLoadingFindings] = useState(false);

  const statusColor =
    d.status === 'completed' ? '#30D158' :
    d.status === 'in_progress' ? '#007AFF' :
    d.status === 'failed' ? '#FF453A' :
    '#FF9F0A';
  const StatusIcon =
    d.status === 'completed' ? CheckCircle2 :
    d.status === 'in_progress' ? Loader2 :
    d.status === 'failed' ? XCircle :
    Clock;
  const displayDesc = d.description.replace(/^\[depth=\w+\]\s*/, '');
  const isClickable = d.status === 'completed' || d.status === 'failed';

  const toggleExpand = async () => {
    if (!isClickable) return;
    const next = !expanded;
    setExpanded(next);
    if (next && !findings && d.status === 'completed') {
      setLoadingFindings(true);
      try {
        const res = await axios.get(`/api/agent/directives/${d.id}/findings`);
        setFindings(res.data);
      } catch (err) {
        console.error('Failed to fetch findings:', err);
      } finally {
        setLoadingFindings(false);
      }
    }
  };

  return (
    <div className="px-4 py-3">
      <button
        onClick={toggleExpand}
        disabled={!isClickable}
        className={`w-full text-left flex items-start gap-3 ${isClickable ? 'cursor-pointer' : ''}`}
      >
        <div className="shrink-0 mt-0.5">
          <StatusIcon
            size={14}
            style={{ color: statusColor }}
            className={d.status === 'in_progress' ? 'animate-spin' : ''}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-[rgba(235,235,245,0.85)] leading-snug break-words flex-1">
              {displayDesc}
            </p>
            {isClickable && (
              expanded
                ? <ChevronDown size={14} className="text-[rgba(235,235,245,0.3)] shrink-0" />
                : <ChevronRight size={14} className="text-[rgba(235,235,245,0.3)] shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-3 mt-1.5">
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase"
              style={{ backgroundColor: statusColor + '20', color: statusColor }}
            >
              {d.status.replace(/_/g, ' ')}
            </span>
            <span className="text-[11px] text-[rgba(235,235,245,0.25)] tabular-nums">
              {formatTime(d.created_at)}
            </span>
            {d.completed_at && (
              <span className="text-[11px] text-[rgba(235,235,245,0.2)] tabular-nums">
                completed {formatTime(d.completed_at)}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Expanded findings */}
      {expanded && (
        <div className="mt-3 ml-[26px] space-y-3">
          {loadingFindings && (
            <div className="flex items-center gap-2 py-3">
              <Loader2 size={14} className="text-[#007AFF] animate-spin" />
              <span className="text-[12px] text-[rgba(235,235,245,0.4)]">Loading findings...</span>
            </div>
          )}

          {/* Result summary */}
          {d.result_summary && (
            <div className="bg-[rgba(0,0,0,0.25)] rounded-xl px-3 py-2.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.3)] block mb-1">Summary</span>
              <p className="text-[12px] text-[rgba(235,235,245,0.7)] leading-relaxed whitespace-pre-wrap">
                {d.result_summary}
              </p>
            </div>
          )}

          {findings && (
            <>
              {/* Case link */}
              {findings.case_title && findings.case_id && (
                <button
                  onClick={(e) => { e.stopPropagation(); onNavigateToCase(findings.case_id!); }}
                  className="flex items-center gap-2 bg-[rgba(0,122,255,0.1)] hover:bg-[rgba(0,122,255,0.2)] text-[#007AFF] rounded-xl px-3 py-2 text-[12px] font-medium transition-colors w-full text-left"
                >
                  <ExternalLink size={12} />
                  Routed to: {findings.case_title}
                </button>
              )}

              {/* Evidence entries */}
              {findings.evidence.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.3)]">
                    Evidence Collected ({findings.evidence.length})
                  </span>
                  {findings.evidence.map((ev) => (
                    <div key={ev.id} className="bg-[rgba(0,0,0,0.25)] rounded-xl px-3 py-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                          ev.type === 'investigation' ? 'bg-[#007AFF]/20 text-[#007AFF]' :
                          ev.type === 'note' ? 'bg-[#FF9F0A]/20 text-[#FF9F0A]' :
                          'bg-[#AF52DE]/20 text-[#AF52DE]'
                        }`}>
                          {ev.type === 'investigation' ? 'Investigation' : ev.type === 'note' ? 'Note' : 'Report'}
                        </span>
                        <span className="text-[10px] text-[rgba(235,235,245,0.2)] tabular-nums">
                          {formatTime(ev.created_at)}
                        </span>
                      </div>
                      <p className="text-[12px] text-[rgba(235,235,245,0.6)] leading-relaxed whitespace-pre-wrap">
                        {ev.content.length > 800 ? ev.content.slice(0, 800) + '...' : ev.content}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Timeline events */}
              {findings.timeline_events.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.3)]">
                    Timeline Events ({findings.timeline_events.length})
                  </span>
                  <div className="bg-[rgba(0,0,0,0.25)] rounded-xl px-3 py-2">
                    {findings.timeline_events.map((te) => (
                      <div key={te.id} className="flex items-baseline gap-2 py-1 border-b border-[rgba(84,84,88,0.12)] last:border-0">
                        <span className="text-[11px] text-[#FFD60A] font-mono shrink-0 w-[80px]">
                          {te.event_date || '???'}
                        </span>
                        <span className="text-[12px] text-[rgba(235,235,245,0.6)]">{te.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Entities */}
              {findings.entities.length > 0 && (
                <div>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.3)] block mb-1">
                    Entities on Case Graph ({findings.entities.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {findings.entities.slice(0, 20).map((eid) => (
                      <span key={eid} className="text-[11px] bg-[rgba(90,200,250,0.1)] text-[#5AC8FA] px-2 py-0.5 rounded-full">
                        {eid}
                      </span>
                    ))}
                    {findings.entities.length > 20 && (
                      <span className="text-[11px] text-[rgba(235,235,245,0.3)]">
                        +{findings.entities.length - 20} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Empty state — only if there's truly nothing at all */}
              {findings.evidence.length === 0 && findings.timeline_events.length === 0 && !findings.case_id && !d.result_summary && (
                <p className="text-[12px] text-[rgba(235,235,245,0.3)] py-2">
                  No findings were collected for this directive.
                </p>
              )}
            </>
          )}

          {/* Failed directive error */}
          {d.status === 'failed' && d.result_summary && (
            <div className="bg-[rgba(255,69,58,0.08)] rounded-xl px-3 py-2.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[#FF453A] block mb-1">Error</span>
              <p className="text-[12px] text-[rgba(255,69,58,0.8)] leading-relaxed">
                {d.result_summary}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MissionControlProps {
  onNavigateToCase: (caseId: string) => void;
}

export default function MissionControl({ onNavigateToCase }: MissionControlProps) {
  const { isAdmin, isPro, isElite } = useAuth();
  const canDirectAgent = isAdmin || isPro || isElite;

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [caseTree, setCaseTree] = useState<CaseTreeNode[]>([]);
  const [findings, setFindings] = useState<{ theories: Finding[]; discoveries: Finding[] }>({ theories: [], discoveries: [] });
  const [directives, setDirectives] = useState<DirectiveTask[]>([]);
  const [directive, setDirective] = useState('');
  const [sendingDirective, setSendingDirective] = useState(false);
  const [loading, setLoading] = useState(true);
  const [biggerPicture, setBiggerPicture] = useState<{ id: string; latest_evidence: { content: string; created_at: string } | null } | null>(null);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [bpExpanded, setBpExpanded] = useState(false);
  const activityRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, activityRes, casesRes, findingsRes, directivesRes, bpRes] = await Promise.all([
        axios.get('/api/agent/status'),
        axios.get('/api/agent/activity?limit=100'),
        axios.get('/api/agent/cases/tree'),
        axios.get('/api/agent/findings'),
        axios.get('/api/agent/directives'),
        axios.get('/api/cases/bigger-picture'),
      ]);
      setStatus(statusRes.data);
      setActivity(activityRes.data.items || []);
      setCaseTree(buildCaseTree(casesRes.data.cases || []));
      setFindings(findingsRes.data);
      setDirectives(directivesRes.data.directives || []);
      setBiggerPicture(bpRes.data.case || null);
    } catch (err) {
      console.error('Mission control fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    // Poll every 5 seconds
    pollRef.current = setInterval(fetchAll, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchAll]);

  const submitDirective = async () => {
    if (!directive.trim() || sendingDirective) return;
    const text = directive.trim();
    setSendingDirective(true);
    try {
      await axios.post('/api/agent/directive', { directive: text });
      setDirective('');
      toast.success(`Directive queued: "${text.length > 60 ? text.slice(0, 60) + '...' : text}"`, {
        description: 'Priority 1 — the agent will pick this up next cycle',
      });
      // Refresh immediately to show it in the feed
      await fetchAll();
    } catch (err) {
      console.error('Failed to submit directive:', err);
      toast.error('Failed to submit directive');
    } finally {
      setSendingDirective(false);
    }
  };

  const triggerSynthesis = async () => {
    if (isSynthesizing) return;
    setIsSynthesizing(true);
    try {
      await axios.post('/api/cases/bigger-picture/synthesize');
      toast.success('Bigger Picture updated');
      await fetchAll();
    } catch (err) {
      console.error('Synthesis failed:', err);
      toast.error('Failed to generate Bigger Picture');
    } finally {
      setIsSynthesizing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="text-[#007AFF] animate-spin" />
      </div>
    );
  }

  const isRunning = status?.is_running ?? false;
  const currentTask = status?.current_task;
  const queueStats = status?.queue_stats || { queued: 0, completed: 0, failed: 0 };

  // Split the operational root cases from user-created ones
  const operationalCases = caseTree.filter(c => c.operational_question);
  const otherCases = caseTree.filter(c => !c.operational_question);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-4 space-y-5">

          {/* Agent Status Banner */}
          <div className={`rounded-2xl p-4 border ${isRunning
            ? 'bg-[rgba(0,122,255,0.06)] border-[rgba(0,122,255,0.2)]'
            : 'bg-[#1C1C1E] border-[rgba(84,84,88,0.36)]'
          }`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full ${isRunning ? 'bg-[#30D158] animate-pulse' : 'bg-[rgba(235,235,245,0.2)]'}`} />
                <span className="text-[15px] font-semibold text-white">
                  {isRunning ? 'Agent Active' : 'Agent Offline'}
                </span>
              </div>
              {status?.last_heartbeat && (
                <span className="text-[11px] text-[rgba(235,235,245,0.3)]">
                  Last heartbeat: {timeAgo(status.last_heartbeat)}
                </span>
              )}
            </div>

            {isRunning && currentTask && (
              <div className="bg-[rgba(0,0,0,0.3)] rounded-xl px-3 py-2.5 mb-3">
                <div className="flex items-center gap-2 mb-1">
                  <Loader2 size={12} className="text-[#007AFF] animate-spin" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[#007AFF]">
                    {currentTask.type.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="text-[13px] text-[rgba(235,235,245,0.7)] leading-snug">
                  {currentTask.description}
                </p>
              </div>
            )}

            {/* Stats row */}
            <div className="grid grid-cols-4 gap-2">
              <StatCard label="Queued" value={queueStats.queued} icon={Clock} color="#FF9F0A" />
              <StatCard label="Completed" value={queueStats.completed} icon={CheckCircle2} color="#30D158" />
              <StatCard label="Theories" value={status?.theories_tested || 0} icon={Lightbulb} color="#AF52DE" />
              <StatCard label="Cases" value={status?.cases_created || 0} icon={FolderTree} color="#5AC8FA" />
            </div>
          </div>

          {/* Bigger Picture */}
          <div className="bg-[#1C1C1E] rounded-2xl border border-[rgba(84,84,88,0.36)] overflow-hidden">
            <div className="px-4 pt-3 pb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lightbulb size={14} className="text-[#FFD60A]" />
                <span className="text-[11px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.4)]">
                  The Bigger Picture
                </span>
              </div>
              <div className="flex items-center gap-2">
                {biggerPicture?.latest_evidence && (
                  <span className="text-[11px] text-[rgba(235,235,245,0.25)] tabular-nums">
                    {timeAgo(biggerPicture.latest_evidence.created_at)}
                  </span>
                )}
                {canDirectAgent && (
                  <button
                    onClick={triggerSynthesis}
                    disabled={isSynthesizing}
                    className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[#FFD60A]/15 text-[#FFD60A] hover:bg-[#FFD60A]/25 disabled:opacity-40 transition-colors"
                  >
                    {isSynthesizing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {isSynthesizing ? 'Synthesizing...' : 'Refresh'}
                  </button>
                )}
                {biggerPicture && (
                  <button
                    onClick={() => onNavigateToCase(biggerPicture.id)}
                    className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[rgba(0,122,255,0.1)] text-[#007AFF] hover:bg-[rgba(0,122,255,0.2)] transition-colors"
                  >
                    <ExternalLink size={11} />
                    Open Case
                  </button>
                )}
              </div>
            </div>

            {biggerPicture?.latest_evidence ? (
              <div className="px-4 pb-3">
                {/* Summary preview */}
                <button
                  onClick={() => setBpExpanded(!bpExpanded)}
                  className="w-full text-left group"
                >
                  <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed">
                    {bpExpanded
                      ? null
                      : biggerPicture.latest_evidence.content.slice(0, 250) + (biggerPicture.latest_evidence.content.length > 250 ? '...' : '')
                    }
                  </p>
                  <span className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-medium text-[#FFD60A] group-hover:underline">
                    {bpExpanded ? (
                      <><ChevronDown size={12} /> Collapse</>
                    ) : (
                      <><ChevronRight size={12} /> View Full Synthesis</>
                    )}
                  </span>
                </button>

                {/* Expanded full synthesis */}
                {bpExpanded && (
                  <div className="mt-3 bg-[rgba(0,0,0,0.25)] rounded-xl px-4 py-3 max-h-[500px] overflow-y-auto">
                    <p className="text-[13px] text-[rgba(235,235,245,0.7)] leading-relaxed whitespace-pre-wrap">
                      {biggerPicture.latest_evidence.content}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="px-4 pb-4">
                <p className="text-[13px] text-[rgba(235,235,245,0.3)] mb-3">
                  No synthesis yet. Generate a cross-case intelligence assessment to surface patterns and connections across all your investigations.
                </p>
                {canDirectAgent && (
                  <button
                    onClick={triggerSynthesis}
                    disabled={isSynthesizing}
                    className="flex items-center gap-2 text-[13px] font-semibold px-4 py-2 rounded-xl bg-[#FFD60A]/15 text-[#FFD60A] hover:bg-[#FFD60A]/25 disabled:opacity-40 transition-colors"
                  >
                    {isSynthesizing ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />}
                    {isSynthesizing ? 'Generating...' : 'Generate Now'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Two-column layout for desktop */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr] gap-5">

            {/* Left column: Case Tree + Directive */}
            <div className="space-y-5">

              {/* Directive Input */}
              <div className="bg-[#1C1C1E] rounded-2xl border border-[rgba(84,84,88,0.36)] overflow-hidden">
                <div className="px-4 pt-3 pb-2">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.4)]">
                    Direct the Agent
                  </span>
                </div>
                {canDirectAgent ? (
                  <div className="px-3 pb-3">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={directive}
                        onChange={(e) => setDirective(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && submitDirective()}
                        placeholder="e.g. Investigate the TerraMar Project..."
                        className="flex-1 bg-[rgba(0,0,0,0.3)] text-[14px] text-white placeholder:text-[rgba(235,235,245,0.2)] rounded-xl px-3 py-2.5 border border-[rgba(84,84,88,0.36)] focus:border-[#007AFF] focus:outline-none transition-colors"
                      />
                      <button
                        onClick={submitDirective}
                        disabled={!directive.trim() || sendingDirective}
                        className="bg-[#007AFF] hover:bg-[#0062CC] disabled:opacity-30 text-white rounded-xl px-3 py-2.5 transition-all active:scale-95"
                      >
                        {sendingDirective ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="px-4 pb-3">
                    <p className="text-[13px] text-[rgba(235,235,245,0.3)]">
                      Upgrade your plan to direct the agent.
                    </p>
                  </div>
                )}
              </div>

              {/* Case Tree */}
              <div className="bg-[#1C1C1E] rounded-2xl border border-[rgba(84,84,88,0.36)] overflow-hidden">
                <div className="px-4 pt-3 pb-2 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.4)]">
                    Investigation Branches
                  </span>
                  <span className="text-[11px] text-[rgba(235,235,245,0.25)]">
                    {caseTree.length} root cases
                  </span>
                </div>
                <div className="px-2 pb-2 max-h-[400px] overflow-y-auto">
                  {operationalCases.length > 0 && (
                    <>
                      {operationalCases.map((node) => (
                        <CaseTreeItem key={node.id} node={node} onSelect={onNavigateToCase} />
                      ))}
                    </>
                  )}
                  {otherCases.length > 0 && (
                    <>
                      <div className="px-3 pt-3 pb-1">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.2)]">
                          Other Cases
                        </span>
                      </div>
                      {otherCases.map((node) => (
                        <CaseTreeItem key={node.id} node={node} onSelect={onNavigateToCase} />
                      ))}
                    </>
                  )}
                  {caseTree.length === 0 && (
                    <p className="text-[13px] text-[rgba(235,235,245,0.3)] text-center py-6">
                      No cases yet. Start the agent to begin building.
                    </p>
                  )}
                </div>
              </div>

              {/* Recent Findings */}
              {findings.theories.length > 0 && (
                <div className="bg-[#1C1C1E] rounded-2xl border border-[rgba(84,84,88,0.36)] overflow-hidden">
                  <div className="px-4 pt-3 pb-2">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.4)]">
                      Theory Verdicts
                    </span>
                  </div>
                  <div className="px-3 pb-3 space-y-2">
                    {findings.theories.slice(0, 5).map((t) => {
                      const verdict = t.metadata?.verdict || 'unknown';
                      const confidence = t.metadata?.confidence;
                      return (
                        <div key={t.id} className="bg-[rgba(0,0,0,0.25)] rounded-xl px-3 py-2.5">
                          <p className="text-[12px] text-[rgba(235,235,245,0.7)] leading-snug mb-1.5">
                            {t.description}
                          </p>
                          <span
                            className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full uppercase"
                            style={{
                              backgroundColor: verdict === 'supported' ? 'rgba(48,209,88,0.15)' :
                                verdict === 'contradicted' ? 'rgba(255,69,58,0.15)' :
                                  verdict === 'partially_supported' ? 'rgba(255,159,10,0.15)' :
                                    'rgba(142,142,147,0.15)',
                              color: verdict === 'supported' ? '#30D158' :
                                verdict === 'contradicted' ? '#FF453A' :
                                  verdict === 'partially_supported' ? '#FF9F0A' : '#8E8E93',
                            }}
                          >
                            {verdict.replace(/_/g, ' ')}
                            {confidence ? ` ${Math.round(confidence * 100)}%` : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Right column: Activity Feed */}
            <div className="bg-[#1C1C1E] rounded-2xl border border-[rgba(84,84,88,0.36)] overflow-hidden flex flex-col" style={{ maxHeight: 'calc(100dvh - 220px)' }}>
              <div className="px-4 pt-3 pb-2 flex items-center justify-between shrink-0 border-b border-[rgba(84,84,88,0.18)]">
                <div className="flex items-center gap-2">
                  <Activity size={14} className="text-[#007AFF]" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.4)]">
                    Live Activity
                  </span>
                </div>
                <span className="text-[11px] text-[rgba(235,235,245,0.25)]">
                  {activity.length} events
                </span>
              </div>
              <div ref={activityRef} className="flex-1 overflow-y-auto px-3 py-1">
                {activity.length > 0 ? (
                  activity.map((item) => <ActivityRow key={item.id} item={item} />)
                ) : (
                  <p className="text-[13px] text-[rgba(235,235,245,0.3)] text-center py-8">
                    No activity yet. Start the agent to see live updates.
                  </p>
                )}
              </div>
            </div>

          </div>

          {/* Your Directives — below the two-column layout */}
          {directives.length > 0 && (
            <div className="bg-[#1C1C1E] rounded-2xl border border-[rgba(84,84,88,0.36)] overflow-hidden">
              <div className="px-4 pt-3 pb-2 flex items-center justify-between border-b border-[rgba(84,84,88,0.18)]">
                <div className="flex items-center gap-2">
                  <Target size={14} className="text-[#FF6B6B]" />
                  <span className="text-[11px] font-medium uppercase tracking-wider text-[rgba(235,235,245,0.4)]">
                    Your Directives
                  </span>
                </div>
                <span className="text-[11px] text-[rgba(235,235,245,0.25)]">
                  {directives.length} directive{directives.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="divide-y divide-[rgba(84,84,88,0.18)]">
                {directives.map((d) => (
                  <DirectiveRowItem key={d.id} d={d} onNavigateToCase={onNavigateToCase} />
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

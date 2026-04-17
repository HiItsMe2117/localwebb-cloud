import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Activity, Send, ChevronRight, ChevronDown,
  Loader2, CheckCircle2, XCircle, Zap, Target,
  Clock, FolderTree, Search,
  FileText, Link2, CircleDot, Lightbulb, Shield,
} from 'lucide-react';
import axios from 'axios';

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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MissionControlProps {
  onNavigateToCase: (caseId: string) => void;
}

export default function MissionControl({ onNavigateToCase }: MissionControlProps) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [caseTree, setCaseTree] = useState<CaseTreeNode[]>([]);
  const [findings, setFindings] = useState<{ theories: Finding[]; discoveries: Finding[] }>({ theories: [], discoveries: [] });
  const [directives, setDirectives] = useState<DirectiveTask[]>([]);
  const [directive, setDirective] = useState('');
  const [sendingDirective, setSendingDirective] = useState(false);
  const [loading, setLoading] = useState(true);
  const activityRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, activityRes, casesRes, findingsRes, directivesRes] = await Promise.all([
        axios.get('/api/agent/status'),
        axios.get('/api/agent/activity?limit=100'),
        axios.get('/api/agent/cases/tree'),
        axios.get('/api/agent/findings'),
        axios.get('/api/agent/directives'),
      ]);
      setStatus(statusRes.data);
      setActivity(activityRes.data.items || []);
      setCaseTree(buildCaseTree(casesRes.data.cases || []));
      setFindings(findingsRes.data);
      setDirectives(directivesRes.data.directives || []);
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
                {directives.map((d) => {
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
                  // Strip the [depth=deep] prefix for display
                  const displayDesc = d.description.replace(/^\[depth=\w+\]\s*/, '');

                  return (
                    <div key={d.id} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 mt-0.5">
                          <StatusIcon
                            size={14}
                            style={{ color: statusColor }}
                            className={d.status === 'in_progress' ? 'animate-spin' : ''}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] text-[rgba(235,235,245,0.85)] leading-snug break-words">
                            {displayDesc}
                          </p>
                          {d.result_summary && (
                            <p className="mt-1.5 text-[12px] text-[rgba(235,235,245,0.5)] leading-snug">
                              {d.result_summary}
                            </p>
                          )}
                          <div className="flex items-center gap-3 mt-1.5">
                            <span
                              className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase"
                              style={{
                                backgroundColor: statusColor + '20',
                                color: statusColor,
                              }}
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
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

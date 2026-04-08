import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import { useNodesState, useEdgesState, ReactFlowProvider, useReactFlow, useViewport } from 'reactflow';
import type { Node, Edge, NodeChange } from 'reactflow';
import { Plus, X, Loader2, Link2, Trash2, MousePointerClick, Map as MapIcon, Maximize2, Minimize2, Database, ChevronDown, ChevronUp, Check, Send, ExternalLink, Sparkles, LayoutGrid, List, Filter, MessageSquare, Users, Bot, Globe } from 'lucide-react';
import NexusCanvas from './NexusCanvas';
import EventNode, { EVENT_CATEGORIES, formatEventDate } from './EventNode';
import { TRACK_COLOR_PALETTE, type TimelineTrack } from '../types';
import axios from 'axios';

// ── Timeline auto-layout ────────────────────────────────────────────────────

const CARD_WIDTH = 240;
const ROW_HEIGHT = 170;
const YEAR_GAP = 140;
const MAX_STACK = 3; // max events stacked vertically before starting a new column
const BASE_Y = 0;
const LANE_HEIGHT = MAX_STACK * ROW_HEIGHT + 80; // vertical space reserved per swim lane
const LANE_LABEL_WIDTH = 140; // reserved left-edge space for lane labels

interface YearMarker {
  year: string;
  x: number;
  width: number;
}

interface LaneMarker {
  laneKey: string;
  label: string;
  color: string;
  y: number;
  height: number;
}

function parseEventSortKey(dateStr: string | null | undefined): string {
  if (!dateStr) return '9999-99-99'; // undated → end
  // Pad partial dates: "2024" → "2024-00-00", "2024-03" → "2024-03-00"
  const parts = dateStr.split('-');
  const y = parts[0] || '9999';
  const m = parts[1] || '00';
  const d = parts[2] || '00';
  return `${y}-${m}-${d}`;
}

function extractYear(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Undated';
  return dateStr.split('-')[0] || 'Undated';
}

function computeTimelineLayout(eventNodes: Node[]): { positions: Record<string, { x: number; y: number }>; yearMarkers: YearMarker[] } {
  if (eventNodes.length === 0) return { positions: {}, yearMarkers: [] };

  // Sort by date
  const sorted = [...eventNodes].sort((a, b) => {
    const ka = parseEventSortKey(a.data?.event_date);
    const kb = parseEventSortKey(b.data?.event_date);
    return ka.localeCompare(kb);
  });

  // Group by year
  const yearGroups: Map<string, Node[]> = new Map();
  for (const node of sorted) {
    const year = extractYear(node.data?.event_date);
    if (!yearGroups.has(year)) yearGroups.set(year, []);
    yearGroups.get(year)!.push(node);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  const yearMarkers: YearMarker[] = [];
  let currentX = 0;

  for (const [year, events] of yearGroups) {
    const yearStartX = currentX;

    // Within a year, group events that share the same month for vertical stacking
    const monthGroups: Map<string, Node[]> = new Map();
    for (const ev of events) {
      const date = ev.data?.event_date || '';
      const monthKey = date.length >= 7 ? date.slice(0, 7) : date.slice(0, 4) || 'none';
      if (!monthGroups.has(monthKey)) monthGroups.set(monthKey, []);
      monthGroups.get(monthKey)!.push(ev);
    }

    for (const [, monthEvents] of monthGroups) {
      let col = 0;
      let row = 0;
      for (let i = 0; i < monthEvents.length; i++) {
        positions[monthEvents[i].id] = {
          x: currentX + col * CARD_WIDTH,
          y: BASE_Y + row * ROW_HEIGHT,
        };
        row++;
        if (row >= MAX_STACK) {
          row = 0;
          col++;
        }
      }
      currentX += (col + 1) * CARD_WIDTH;
    }

    yearMarkers.push({
      year,
      x: yearStartX,
      width: currentX - yearStartX - CARD_WIDTH + 200, // approximate group width
    });

    currentX += YEAR_GAP;
  }

  return { positions, yearMarkers };
}

// ── Swim-lane layout: one horizontal row per track ──────────────────────────

function computeSwimLaneLayout(
  events: Node[],
  enabledTracks: TimelineTrack[],
): {
  virtualNodes: Node[];
  yearMarkers: YearMarker[];
  laneMarkers: LaneMarker[];
  totalWidth: number;
  totalHeight: number;
} {
  const enabledIds = new Set(enabledTracks.map(t => t.id));
  const lanes: { key: string; label: string; color: string }[] = [
    { key: 'main', label: 'Main', color: '#8E8E93' },
    ...enabledTracks.map(t => ({ key: t.id, label: t.label, color: t.color })),
  ];
  const laneIndex = new Map(lanes.map((l, i) => [l.key, i]));

  // Expand each event into one placement per lane it belongs to
  type Placement = { node: Node; laneKey: string; monthKey: string; sortKey: string };
  const placements: Placement[] = [];
  for (const n of events) {
    const tids: string[] = (n.data?.track_ids || []).filter((id: string) => enabledIds.has(id));
    const targetLanes = tids.length > 0 ? tids : ['main'];
    const date: string = n.data?.event_date || '';
    const monthKey = date.length >= 7 ? date.slice(0, 7) : (date.slice(0, 4) || 'none');
    const sortKey = parseEventSortKey(n.data?.event_date);
    for (const laneKey of targetLanes) {
      placements.push({ node: n, laneKey, monthKey, sortKey });
    }
  }

  placements.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey.localeCompare(b.sortKey);
    return (laneIndex.get(a.laneKey) ?? 0) - (laneIndex.get(b.laneKey) ?? 0);
  });

  // Ordered unique month keys in chronological order
  const monthOrder: string[] = [];
  const seenMonths = new Set<string>();
  for (const p of placements) {
    if (!seenMonths.has(p.monthKey)) {
      seenMonths.add(p.monthKey);
      monthOrder.push(p.monthKey);
    }
  }

  // Group placements: monthKey → laneKey → placements
  const monthLaneEvents = new Map<string, Map<string, Placement[]>>();
  for (const p of placements) {
    if (!monthLaneEvents.has(p.monthKey)) monthLaneEvents.set(p.monthKey, new Map());
    const byLane = monthLaneEvents.get(p.monthKey)!;
    if (!byLane.has(p.laneKey)) byLane.set(p.laneKey, []);
    byLane.get(p.laneKey)!.push(p);
  }

  // Assign shared x-range per month (max cols across all lanes wins)
  const monthXStart = new Map<string, number>();
  let currentX = LANE_LABEL_WIDTH;
  let prevYear: string | null = null;
  let yearStartX = currentX;
  const yearMarkers: YearMarker[] = [];

  for (const monthKey of monthOrder) {
    const year = monthKey.slice(0, 4);
    if (prevYear !== null && year !== prevYear) {
      yearMarkers.push({ year: prevYear, x: yearStartX, width: currentX - yearStartX - CARD_WIDTH + 200 });
      currentX += YEAR_GAP;
      yearStartX = currentX;
    }
    prevYear = year;

    const byLane = monthLaneEvents.get(monthKey)!;
    let maxCols = 1;
    for (const [, evs] of byLane) {
      const cols = Math.ceil(evs.length / MAX_STACK);
      if (cols > maxCols) maxCols = cols;
    }
    monthXStart.set(monthKey, currentX);
    currentX += maxCols * CARD_WIDTH;
  }
  if (prevYear !== null) {
    yearMarkers.push({ year: prevYear, x: yearStartX, width: currentX - yearStartX - CARD_WIDTH + 200 });
  }

  // Emit virtual nodes
  const virtualNodes: Node[] = [];
  for (const monthKey of monthOrder) {
    const byLane = monthLaneEvents.get(monthKey)!;
    const xStart = monthXStart.get(monthKey)!;
    for (const [laneKey, evs] of byLane) {
      const laneIdx = laneIndex.get(laneKey) ?? 0;
      const laneY = BASE_Y + laneIdx * LANE_HEIGHT;
      let col = 0;
      let row = 0;
      for (const p of evs) {
        virtualNodes.push({
          ...p.node,
          id: `${p.node.id}::${laneKey}`,
          data: { ...p.node.data, eventId: p.node.id, laneKey },
          position: { x: xStart + col * CARD_WIDTH, y: laneY + row * ROW_HEIGHT },
          draggable: false,
        });
        row++;
        if (row >= MAX_STACK) { row = 0; col++; }
      }
    }
  }

  const laneMarkers: LaneMarker[] = lanes.map((l, i) => ({
    laneKey: l.key,
    label: l.label,
    color: l.color,
    y: BASE_Y + i * LANE_HEIGHT,
    height: LANE_HEIGHT,
  }));

  return {
    virtualNodes,
    yearMarkers,
    laneMarkers,
    totalWidth: currentX,
    totalHeight: lanes.length * LANE_HEIGHT,
  };
}

// ── Year marker overlay ─────────────────────────────────────────────────────

function YearMarkers({ markers }: { markers: YearMarker[] }) {
  const { x: vx, y: vy, zoom } = useViewport();

  if (markers.length === 0) return null;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}>
      {markers.map(m => (
        <div key={m.year} style={{ position: 'absolute', left: vx + m.x * zoom, top: vy + (BASE_Y - 70) * zoom }}>
          <span style={{
            fontSize: Math.max(11, 16 * zoom),
            fontWeight: 800,
            color: 'rgba(235,235,245,0.15)',
            letterSpacing: '0.05em',
            whiteSpace: 'nowrap',
          }}>
            {m.year}
          </span>
          <div style={{
            position: 'absolute',
            left: -16 * zoom,
            top: 24 * zoom,
            width: 1,
            height: 600 * zoom,
            borderLeft: '1px dashed rgba(235,235,245,0.07)',
          }} />
        </div>
      ))}
    </div>
  );
}

// ── Lane label overlay (swim-lane mode) ─────────────────────────────────────

function LaneLabels({ markers, totalWidth }: { markers: LaneMarker[]; totalWidth: number }) {
  const { x: vx, y: vy, zoom } = useViewport();

  if (markers.length === 0) return null;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}>
      {markers.map(m => (
        <div key={m.laneKey}>
          {/* Lane background band */}
          <div style={{
            position: 'absolute',
            left: vx,
            top: vy + m.y * zoom,
            width: totalWidth * zoom,
            height: m.height * zoom,
            background: `${m.color}08`,
            borderTop: `1px solid ${m.color}22`,
            borderBottom: `1px solid ${m.color}22`,
          }} />
          {/* Left-side label */}
          <div style={{
            position: 'absolute',
            left: vx,
            top: vy + m.y * zoom,
            width: LANE_LABEL_WIDTH * zoom,
            height: m.height * zoom,
            borderLeft: `4px solid ${m.color}`,
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'flex-start',
            paddingTop: 12 * zoom,
            paddingLeft: 12 * zoom,
          }}>
            <span style={{
              fontSize: Math.max(10, 13 * zoom),
              fontWeight: 700,
              color: m.color,
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: (LANE_LABEL_WIDTH - 24) * zoom,
            }}>
              {m.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

interface CaseTimelineProps {
  caseId: string;
  readOnly?: boolean;
}

const nodeTypes = { eventNode: EventNode };

function CaseTimelineInner({ caseId, readOnly = false }: CaseTimelineProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Create form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newCategory, setNewCategory] = useState('general');
  const [isCreating, setIsCreating] = useState(false);

  // Selection & linking
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [linkLabel, setLinkLabel] = useState('');
  const [isLinking, setIsLinking] = useState(false);

  // Import from graph
  const [showImport, setShowImport] = useState(false);
  const [graphEvents, setGraphEvents] = useState<{ id: string; label: string; description?: string }[]>([]);
  const [selectedImports, setSelectedImports] = useState<Set<string>>(new Set());
  const [isLoadingGraphEvents, setIsLoadingGraphEvents] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // Year markers and layout animation
  const [yearMarkers, setYearMarkers] = useState<YearMarker[]>([]);
  const [laneMarkers, setLaneMarkers] = useState<LaneMarker[]>([]);
  const [laneTotalWidth, setLaneTotalWidth] = useState(0);
  const [isAnimatingLayout, setIsAnimatingLayout] = useState(false);

  // Research panel
  const [showResearch, setShowResearch] = useState(false);
  const [researchQuery, setResearchQuery] = useState('');
  const [isResearching, setIsResearching] = useState(false);
  const [researchMessages, setResearchMessages] = useState<{ role: 'user' | 'assistant'; content: string; events?: { title: string; date: string | null; description: string; category: string }[]; webSources?: { title: string; uri: string; domain: string }[] }[]>([]);
  const [addingEventIndex, setAddingEventIndex] = useState<string | null>(null);
  const researchEndRef = useRef<HTMLDivElement>(null);

  // Tracks (per-entity overlay tracks)
  const [tracks, setTracks] = useState<TimelineTrack[]>([]);
  const [disabledTrackIds, setDisabledTrackIds] = useState<Set<string>>(new Set()); // client-side toggle state
  const [showTrackModal, setShowTrackModal] = useState(false); // entity picker
  const [caseEntities, setCaseEntities] = useState<{ id: string; label: string; type: string }[]>([]);
  const [newTrackEntityId, setNewTrackEntityId] = useState<string>('');
  const [newTrackColor, setNewTrackColor] = useState<string>(TRACK_COLOR_PALETTE[0]);
  const [isCreatingTrack, setIsCreatingTrack] = useState(false);
  // Generate-track panel
  const [generateTrack, setGenerateTrack] = useState<TimelineTrack | null>(null);
  const [trackQuery, setTrackQuery] = useState('');
  const [isGeneratingTrack, setIsGeneratingTrack] = useState(false);
  const [trackMessages, setTrackMessages] = useState<{ role: 'user' | 'assistant'; content: string; events?: { title: string; date: string | null; description: string; category: string }[]; webSources?: { title: string; uri: string; domain: string }[] }[]>([]);
  const [addingTrackEventIndex, setAddingTrackEventIndex] = useState<string | null>(null);
  const trackEndRef = useRef<HTMLDivElement>(null);

  // Timeline AI chat
  const [timelineChatOpen, setTimelineChatOpen] = useState(false);
  const [timelineChatMessages, setTimelineChatMessages] = useState<{ role: 'user' | 'assistant'; content: string; webSources?: { title: string; uri: string; domain: string }[] }[]>([]);
  const [timelineChatInput, setTimelineChatInput] = useState('');
  const [isTimelineChatting, setIsTimelineChatting] = useState(false);
  const timelineChatEndRef = useRef<HTMLDivElement>(null);

  // UI
  const [showMiniMap, setShowMiniMap] = useState(() => window.innerWidth >= 768);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewMode, setViewMode] = useState<'canvas' | 'list'>('canvas');
  const [filterCategories, setFilterCategories] = useState<Set<string>>(new Set());
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Context menu for event editing
  const [contextEvent, setContextEvent] = useState<Node | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCategory, setEditCategory] = useState('general');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const contextRef = useRef<HTMLDivElement>(null);

  // Viewport persistence
  const viewportKey = `case-timeline-viewport-${caseId}`;
  const hasSavedViewport = useRef(false);
  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { getViewport, setViewport, fitView } = useReactFlow();

  // ── Load timeline ──────────────────────────────────────────────────────────

  const shouldAutoLayoutAfterLoad = useRef(false);

  const loadTimeline = useCallback(async () => {
    try {
      const res = await axios.get(`/api/cases/${caseId}/timeline`);
      const loadedNodes = res.data.nodes || [];
      setNodes(loadedNodes);
      setEdges(res.data.edges || []);
      setTracks(res.data.tracks || []);

      // Auto-layout if flagged, or if nodes are bunched into a tiny area (never properly laid out)
      const needsLayout = shouldAutoLayoutAfterLoad.current ||
        (loadedNodes.length > 1 && (() => {
          const xs = loadedNodes.map((n: Node) => n.position.x);
          const ys = loadedNodes.map((n: Node) => n.position.y);
          const spread = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
          return spread < CARD_WIDTH;
        })()) ||
        (loadedNodes.length === 1 && loadedNodes[0].position.x === 0 && loadedNodes[0].position.y === 0);
      if (needsLayout) {
        shouldAutoLayoutAfterLoad.current = false;
        const { positions, yearMarkers: markers } = computeTimelineLayout(loadedNodes);
        setYearMarkers(markers);
        setIsAnimatingLayout(true);
        setNodes(loadedNodes.map((n: Node) => ({
          ...n,
          position: positions[n.id] || n.position,
        })));
        setTimeout(() => setIsAnimatingLayout(false), 600);
        // Save positions
        const posList = Object.entries(positions).map(([id, pos]) => ({ event_id: id, x: pos.x, y: pos.y }));
        if (posList.length > 0) {
          axios.post(`/api/cases/${caseId}/timeline/positions`, { positions: posList }).catch(() => {});
        }
        setTimeout(() => fitView({ padding: 0.3, duration: 500 }), 50);
      }
    } catch (err: any) {
      console.error('Failed to load timeline:', err);
      const status = err?.response?.status;
      if (status === 403) toast.error('Permission denied');
      else if (status === 401) toast.error('Session expired — please log in again');
      else toast.error('Failed to load timeline');
    } finally {
      setIsLoading(false);
    }
  }, [caseId, setNodes, setEdges, fitView]);

  useEffect(() => { loadTimeline(); }, [loadTimeline]);

  // ── Viewport persistence ───────────────────────────────────────────────────

  useEffect(() => {
    try {
      const saved = localStorage.getItem(viewportKey);
      if (saved) hasSavedViewport.current = true;
    } catch {}
  }, [viewportKey]);

  useEffect(() => {
    if (isLoading || nodes.length === 0) return;
    if (!hasSavedViewport.current) {
      fitView({ padding: 0.3, duration: 800 });
      return;
    }
    try {
      const saved = localStorage.getItem(viewportKey);
      if (saved) setViewport(JSON.parse(saved), { duration: 0 });
    } catch {
      fitView({ padding: 0.3, duration: 800 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const onMoveEnd = useCallback((_event: any, viewport: { x: number; y: number; zoom: number }) => {
    clearTimeout(viewportSaveTimer.current);
    viewportSaveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(viewportKey, JSON.stringify(viewport));
        hasSavedViewport.current = true;
      } catch {}
    }, 300);
  }, [viewportKey]);

  // ── Auto-layout: sort chronologically with year grouping ────────────────

  const autoLayout = useCallback(async (targetNodes?: Node[]) => {
    const evts = targetNodes || nodes;
    if (evts.length === 0) return;

    const { positions, yearMarkers: markers } = computeTimelineLayout(evts);
    setYearMarkers(markers);

    // Enable transition animation, then apply positions
    setIsAnimatingLayout(true);
    const updated = evts.map(n => ({
      ...n,
      position: positions[n.id] || n.position,
    }));
    setNodes(updated);
    setTimeout(() => setIsAnimatingLayout(false), 600);

    // Save all positions to backend
    const posList = Object.entries(positions).map(([id, pos]) => ({
      event_id: id,
      x: pos.x,
      y: pos.y,
    }));
    if (posList.length > 0) {
      try {
        await axios.post(`/api/cases/${caseId}/timeline/positions`, { positions: posList });
      } catch (err) {
        console.error('Failed to save layout positions:', err);
      }
    }

    // Fit view to show all events after layout
    setTimeout(() => fitView({ padding: 0.3, duration: 500 }), 50);
  }, [caseId, nodes, setNodes, fitView]);

  // Compute year markers from current node positions (for freeform layout only;
  // lane-mode year markers are set by the swim-lane effect below)
  useEffect(() => {
    if (nodes.length === 0) return;
    if (tracks.length > 0 && tracks.some(t => !disabledTrackIds.has(t.id))) return;
    const { yearMarkers: markers } = computeTimelineLayout(nodes);
    setYearMarkers(markers);
  }, [nodes, tracks, disabledTrackIds]);

  // ── Display nodes with selection ───────────────────────────────────────────

  const trackById = useMemo(() => {
    const m: Record<string, TimelineTrack> = {};
    for (const t of tracks) m[t.id] = t;
    return m;
  }, [tracks]);

  // An event is track-visible if it has no tracks, OR at least one of its tracks is enabled.
  const isEventTrackVisible = useCallback((trackIds: string[] | undefined) => {
    if (!trackIds || trackIds.length === 0) return true;
    return trackIds.some(tid => !disabledTrackIds.has(tid));
  }, [disabledTrackIds]);

  // Enabled tracks (ordered by creation) — defines swim-lane order
  const enabledTracks = useMemo(
    () => tracks.filter(t => !disabledTrackIds.has(t.id)),
    [tracks, disabledTrackIds]
  );

  // Swim-lane mode is active whenever at least one track is enabled
  const laneMode = enabledTracks.length > 0;

  const displayNodes = useMemo(() => {
    let filtered = nodes;
    if (filterCategories.size > 0) {
      filtered = filtered.filter(n => filterCategories.has(n.data?.category || 'general'));
    }
    filtered = filtered.filter(n => isEventTrackVisible(n.data?.track_ids));

    // Enrich each event with trackDots
    const enriched = filtered.map(n => {
      const tids: string[] = n.data?.track_ids || [];
      const trackDots = tids
        .map(tid => trackById[tid])
        .filter(Boolean)
        .map(t => ({ id: t.id, color: t.color, label: t.label }));
      return { ...n, data: { ...n.data, trackDots } };
    });

    if (laneMode) {
      // Swim-lane layout: expand each event into one virtual node per lane it belongs to
      const { virtualNodes } = computeSwimLaneLayout(enriched, enabledTracks);
      const result = virtualNodes.map(vn => ({
        ...vn,
        selected: selectedNodeIds.has((vn.data as any).eventId || vn.id),
      }));
      return result;
    }

    // Freeform mode: preserve saved positions
    const result = enriched.map(n => ({
      ...n,
      selected: selectedNodeIds.has(n.id),
    }));
    return result;
  }, [nodes, selectedNodeIds, filterCategories, trackById, isEventTrackVisible, laneMode, enabledTracks]);

  // In lane mode, displayNodes have virtual IDs (e.g. "uuid::main") that don't exist
  // in useNodesState. ReactFlow fires onNodesChange with those virtual IDs (dimension
  // updates, selection, etc.) which useNodesState can't resolve, causing an infinite
  // render loop. In lane mode, positions are computed — so we only forward changes that
  // map to real node IDs (strip the "::lane" suffix).
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    if (!laneMode) {
      onNodesChange(changes);
      return;
    }
    // In lane mode, displayNodes contain virtual IDs (e.g. "uuid::main") that
    // don't exist in useNodesState. Forwarding ANY changes with those IDs causes
    // useNodesState to update → nodes changes → displayNodes recomputes → ReactFlow
    // re-measures → onNodesChange fires again → infinite loop. Since lane layout
    // is fully computed, we drop all changes in lane mode.
  }, [laneMode, onNodesChange]);

  // Keep lane overlay markers in sync with swim-lane layout
  useEffect(() => {
    if (!laneMode || nodes.length === 0) {
      setLaneMarkers([]);
      setLaneTotalWidth(0);
      return;
    }
    // Filter to visible events for marker computation (so lane width matches what's rendered)
    let visible = nodes;
    if (filterCategories.size > 0) {
      visible = visible.filter(n => filterCategories.has(n.data?.category || 'general'));
    }
    visible = visible.filter(n => isEventTrackVisible(n.data?.track_ids));
    const { laneMarkers: lm, yearMarkers: ym, totalWidth } = computeSwimLaneLayout(visible, enabledTracks);
    setLaneMarkers(lm);
    setLaneTotalWidth(totalWidth);
    setYearMarkers(ym);
  }, [laneMode, nodes, enabledTracks, filterCategories, isEventTrackVisible]);

  // ── Node click: select or show context menu ────────────────────────────────

  const onNodeClick = useCallback((node: Node, event?: React.MouseEvent) => {
    // Resolve virtual lane nodes back to their real event
    const realId: string = (node.data as any)?.eventId || node.id;
    const realNode = nodes.find(n => n.id === realId) || node;
    if (event?.shiftKey || selectMode) {
      setSelectedNodeIds(prev => {
        const next = new Set(prev);
        if (next.has(realId)) next.delete(realId);
        else next.add(realId);
        return next;
      });
      setContextEvent(null);
    } else {
      setContextEvent(prev => {
        const newNode = prev?.id === realId ? null : realNode;
        if (newNode) {
          setEditTitle(newNode.data.title || '');
          setEditDate(newNode.data.event_date || '');
          setEditDescription(newNode.data.description || '');
          setEditCategory(newNode.data.category || 'general');
        }
        return newNode;
      });
      setSelectedNodeIds(new Set());
    }
  }, [selectMode, nodes]);

  const clearSelection = useCallback(() => {
    setSelectedNodeIds(new Set());
    setSelectMode(false);
    setLinkLabel('');
    setContextEvent(null);
  }, []);

  // Close context on outside click
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as HTMLElement)) {
        setContextEvent(null);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  // ── Drag stop: save positions ──────────────────────────────────────────────

  const onNodeDragStop = useCallback(async (_: any, node: Node) => {
    // Virtual lane nodes (id contains "::") aren't real events — positions are computed
    if (node.id.includes('::')) return;
    try {
      await axios.post(`/api/cases/${caseId}/timeline/positions`, {
        positions: [{ event_id: node.id, x: node.position.x, y: node.position.y }],
      });
    } catch (err) {
      console.error('Failed to save position:', err);
    }
  }, [caseId]);

  // ── Create event ───────────────────────────────────────────────────────────

  const createEvent = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    setIsCreating(true);
    try {
      const vp = getViewport();
      const centerX = (-vp.x + window.innerWidth / 2) / vp.zoom;
      const centerY = (-vp.y + window.innerHeight / 2) / vp.zoom;
      await axios.post(`/api/cases/${caseId}/timeline/events`, {
        title,
        event_date: newDate || null,
        description: newDescription,
        category: newCategory,
        position_x: centerX,
        position_y: centerY,
      });
      setNewTitle('');
      setNewDate('');
      setNewDescription('');
      setNewCategory('general');
      setShowCreateForm(false);
      shouldAutoLayoutAfterLoad.current = true;
      await loadTimeline();
    } catch (err) {
      console.error('Failed to create event:', err);
      toast.error('Failed to create event');
    } finally {
      setIsCreating(false);
    }
  }, [caseId, newTitle, newDate, newDescription, newCategory, loadTimeline, getViewport]);

  // ── Update event ───────────────────────────────────────────────────────────

  const updateEvent = useCallback(async () => {
    if (!contextEvent) return;
    setIsSavingEdit(true);
    try {
      await axios.patch(`/api/cases/${caseId}/timeline/events/${contextEvent.id}`, {
        title: editTitle,
        event_date: editDate || null,
        description: editDescription,
        category: editCategory,
      });
      await loadTimeline();
      setContextEvent(null);
    } catch (err) {
      console.error('Failed to update event:', err);
      toast.error('Failed to update event');
    } finally {
      setIsSavingEdit(false);
    }
  }, [caseId, contextEvent, editTitle, editDate, editDescription, editCategory, loadTimeline]);

  // ── Delete event ───────────────────────────────────────────────────────────

  const deleteEvent = useCallback(async (eventId: string) => {
    try {
      await axios.delete(`/api/cases/${caseId}/timeline/events/${eventId}`);
      setContextEvent(null);
      await loadTimeline();
    } catch (err) {
      console.error('Failed to delete event:', err);
      toast.error('Failed to delete event');
    }
  }, [caseId, loadTimeline]);

  // ── Delete selected events ─────────────────────────────────────────────────

  const deleteSelected = useCallback(async () => {
    const ids = Array.from(selectedNodeIds);
    try {
      await Promise.all(ids.map(id => axios.delete(`/api/cases/${caseId}/timeline/events/${id}`)));
      clearSelection();
      await loadTimeline();
    } catch (err) {
      console.error('Failed to delete events:', err);
      toast.error('Failed to delete events');
    }
  }, [caseId, selectedNodeIds, clearSelection, loadTimeline]);

  // ── Link events ────────────────────────────────────────────────────────────

  const linkSelectedEvents = useCallback(async () => {
    if (selectedNodeIds.size !== 2) return;
    setIsLinking(true);
    const [sourceId, targetId] = Array.from(selectedNodeIds);
    try {
      await axios.post(`/api/cases/${caseId}/timeline/edges`, {
        source_event_id: sourceId,
        target_event_id: targetId,
        label: linkLabel,
      });
      setLinkLabel('');
      await loadTimeline();
      clearSelection();
    } catch (err) {
      console.error('Failed to create edge:', err);
      toast.error('Failed to create connection');
    } finally {
      setIsLinking(false);
    }
  }, [caseId, selectedNodeIds, linkLabel, loadTimeline, clearSelection]);

  // ── Edge click: delete edge ────────────────────────────────────────────────

  const onEdgeClick = useCallback(async (edge: Edge) => {
    // For now, simple confirm-to-delete
    if (!confirm('Delete this connection?')) return;
    try {
      await axios.delete(`/api/cases/${caseId}/timeline/edges/${edge.id}`);
      await loadTimeline();
    } catch (err) {
      console.error('Failed to delete edge:', err);
    }
  }, [caseId, loadTimeline]);

  // ── Import from graph ──────────────────────────────────────────────────────

  const loadGraphEvents = useCallback(async () => {
    setIsLoadingGraphEvents(true);
    try {
      const res = await axios.get(`/api/cases/${caseId}/graph`);
      const eventNodes = (res.data.nodes || []).filter(
        (n: any) => (n.data?.entityType || '').toUpperCase() === 'EVENT'
      );
      setGraphEvents(eventNodes.map((n: any) => ({
        id: n.id,
        label: n.data?.label || 'Unknown',
        description: n.data?.description || '',
      })));
      setSelectedImports(new Set());
    } catch (err) {
      console.error('Failed to load graph events:', err);
      toast.error('Failed to load graph events');
    } finally {
      setIsLoadingGraphEvents(false);
    }
  }, [caseId]);

  const importSelected = useCallback(async () => {
    if (selectedImports.size === 0) return;
    setIsImporting(true);
    try {
      const res = await axios.post(`/api/cases/${caseId}/timeline/import-graph-events`, {
        node_ids: Array.from(selectedImports),
      });
      const { imported, skipped } = res.data;
      if (imported > 0) toast.success(`Imported ${imported} event${imported !== 1 ? 's' : ''}`);
      if (skipped > 0) toast(`${skipped} already imported`);
      setShowImport(false);
      shouldAutoLayoutAfterLoad.current = true;
      await loadTimeline();
    } catch (err) {
      console.error('Failed to import events:', err);
      toast.error('Failed to import events');
    } finally {
      setIsImporting(false);
    }
  }, [caseId, selectedImports, loadTimeline]);

  // ── Research ────────────────────────────────────────────────────────────────

  const sendResearch = useCallback(async () => {
    const query = researchQuery.trim();
    if (!query || isResearching) return;

    const userMsg = { role: 'user' as const, content: query };
    setResearchMessages(prev => [...prev, userMsg]);
    setResearchQuery('');
    setIsResearching(true);
    setTimeout(() => researchEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

    try {
      // Build focused events from selection
      const focusedEvents = selectedNodeIds.size > 0
        ? nodes.filter(n => selectedNodeIds.has(n.id)).map(n => ({
            title: n.data?.title || '',
            date: n.data?.event_date || '',
            description: n.data?.description || '',
            category: n.data?.category || 'general',
          }))
        : [];

      const res = await axios.post(`/api/cases/${caseId}/timeline/research`, {
        query,
        messages: researchMessages.map(m => ({ role: m.role, content: m.content })),
        focused_events: focusedEvents,
      });

      const assistantMsg = {
        role: 'assistant' as const,
        content: res.data.narrative || res.data.response || 'No results found.',
        events: res.data.events || [],
        webSources: res.data.web_sources || [],
      };
      setResearchMessages(prev => [...prev, assistantMsg]);
      setTimeout(() => researchEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      console.error('Research failed:', err);
      toast.error('Research failed');
      setResearchMessages(prev => [...prev, { role: 'assistant', content: 'Research failed. Please try again.' }]);
    } finally {
      setIsResearching(false);
    }
  }, [caseId, researchQuery, isResearching, researchMessages, selectedNodeIds, nodes]);

  const addResearchEvent = useCallback(async (event: { title: string; date: string | null; description: string; category: string }, key: string) => {
    setAddingEventIndex(key);
    try {
      const vp = getViewport();
      const centerX = (-vp.x + window.innerWidth / 2) / vp.zoom;
      const centerY = (-vp.y + window.innerHeight / 2) / vp.zoom;
      // Offset each event slightly so they don't stack
      const offset = Math.random() * 200 - 100;
      await axios.post(`/api/cases/${caseId}/timeline/events`, {
        title: event.title,
        event_date: event.date || null,
        description: event.description,
        category: event.category || 'general',
        position_x: centerX + offset,
        position_y: centerY + offset,
      });
      shouldAutoLayoutAfterLoad.current = true;
      await loadTimeline();
      toast.success(`Added "${event.title}"`);
    } catch (err) {
      console.error('Failed to add event:', err);
      toast.error('Failed to add event');
    } finally {
      setAddingEventIndex(null);
    }
  }, [caseId, loadTimeline, getViewport]);

  // ── Tracks: load case entities for picker ─────────────────────────────────

  const loadCaseEntities = useCallback(async () => {
    try {
      const res = await axios.get(`/api/cases/${caseId}/graph`);
      const gnodes = (res.data.nodes || []).filter((n: any) => n.type === 'entityNode');
      setCaseEntities(gnodes.map((n: any) => ({
        id: n.id,
        label: n.data?.label || 'Unknown',
        type: n.data?.entityType || 'PERSON',
      })));
    } catch (err) {
      console.error('Failed to load case entities:', err);
      toast.error('Failed to load entities');
    }
  }, [caseId]);

  // ── Tracks: CRUD ──────────────────────────────────────────────────────────

  const createTrack = useCallback(async () => {
    if (!newTrackEntityId) return;
    const entity = caseEntities.find(e => e.id === newTrackEntityId);
    if (!entity) return;
    setIsCreatingTrack(true);
    try {
      const res = await axios.post(`/api/cases/${caseId}/timeline/tracks`, {
        entity_node_id: entity.id,
        label: entity.label,
        color: newTrackColor,
      });
      const track = res.data.track as TimelineTrack;
      setTracks(prev => [...prev, track]);
      setShowTrackModal(false);
      setNewTrackEntityId('');
      // Open generate panel for the new track
      setGenerateTrack(track);
      setTrackMessages([]);
    } catch (err: any) {
      console.error('Failed to create track:', err);
      const status = err?.response?.status;
      if (status === 409 || err?.response?.data?.error?.includes('duplicate')) {
        toast.error('A track for this entity already exists');
      } else {
        toast.error('Failed to create track');
      }
    } finally {
      setIsCreatingTrack(false);
    }
  }, [caseId, newTrackEntityId, newTrackColor, caseEntities]);

  const toggleTrackEnabled = useCallback((trackId: string) => {
    setDisabledTrackIds(prev => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }, []);

  const deleteTrack = useCallback(async (trackId: string) => {
    if (!confirm('Delete this track? Events themselves will be kept, but they will lose this track association.')) return;
    try {
      await axios.delete(`/api/cases/${caseId}/timeline/tracks/${trackId}`);
      setTracks(prev => prev.filter(t => t.id !== trackId));
      // Strip trackId from any events that had it (optimistic)
      setNodes(prev => prev.map(n => {
        const tids: string[] = n.data?.track_ids || [];
        if (!tids.includes(trackId)) return n;
        return { ...n, data: { ...n.data, track_ids: tids.filter(t => t !== trackId) } };
      }));
      if (generateTrack?.id === trackId) setGenerateTrack(null);
    } catch (err) {
      console.error('Failed to delete track:', err);
      toast.error('Failed to delete track');
    }
  }, [caseId, generateTrack, setNodes]);

  const updateTrackColor = useCallback(async (trackId: string, color: string) => {
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, color } : t));
    try {
      await axios.patch(`/api/cases/${caseId}/timeline/tracks/${trackId}`, { color });
    } catch (err) {
      console.error('Failed to update track color:', err);
    }
  }, [caseId]);

  // ── Tracks: generate AI events for this entity ────────────────────────────

  const sendGenerateTrack = useCallback(async (customQuery?: string) => {
    if (!generateTrack) return;
    const query = (customQuery !== undefined ? customQuery : trackQuery).trim();
    if (isGeneratingTrack) return;

    if (query) {
      const userMsg = { role: 'user' as const, content: query };
      setTrackMessages(prev => [...prev, userMsg]);
      setTrackQuery('');
      setTimeout(() => trackEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
    setIsGeneratingTrack(true);

    try {
      const res = await axios.post(`/api/cases/${caseId}/timeline/generate-track`, {
        entity_node_id: generateTrack.entity_node_id,
        entity_label: generateTrack.label,
        messages: trackMessages.map(m => ({ role: m.role, content: m.content })),
        query: query || null,
      });
      const assistantMsg = {
        role: 'assistant' as const,
        content: res.data.narrative || 'No results found.',
        events: res.data.events || [],
        webSources: res.data.web_sources || [],
      };
      setTrackMessages(prev => [...prev, assistantMsg]);
      setTimeout(() => trackEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      console.error('Generate track failed:', err);
      toast.error('Generating track failed');
      setTrackMessages(prev => [...prev, { role: 'assistant', content: 'Generation failed. Please try again.' }]);
    } finally {
      setIsGeneratingTrack(false);
    }
  }, [caseId, generateTrack, trackQuery, isGeneratingTrack, trackMessages]);

  const addTrackEvent = useCallback(async (event: { title: string; date: string | null; description: string; category: string }, key: string) => {
    if (!generateTrack) return;
    setAddingTrackEventIndex(key);
    try {
      const vp = getViewport();
      const centerX = (-vp.x + window.innerWidth / 2) / vp.zoom;
      const centerY = (-vp.y + window.innerHeight / 2) / vp.zoom;
      const offset = Math.random() * 200 - 100;
      await axios.post(`/api/cases/${caseId}/timeline/events`, {
        title: event.title,
        event_date: event.date || null,
        description: event.description,
        category: event.category || 'general',
        position_x: centerX + offset,
        position_y: centerY + offset,
        track_ids: [generateTrack.id],
      });
      shouldAutoLayoutAfterLoad.current = true;
      await loadTimeline();
      toast.success(`Added "${event.title}" to ${generateTrack.label}`);
    } catch (err) {
      console.error('Failed to add track event:', err);
      toast.error('Failed to add event');
    } finally {
      setAddingTrackEventIndex(null);
    }
  }, [caseId, generateTrack, loadTimeline, getViewport]);

  // ── Timeline AI Chat ───────────────────────────────────────────────────────

  const sendTimelineChatMessage = useCallback(async () => {
    const msg = timelineChatInput.trim();
    if (!msg || isTimelineChatting) return;
    const newMessages = [...timelineChatMessages, { role: 'user' as const, content: msg }];
    setTimelineChatMessages(newMessages);
    setTimelineChatInput('');
    setIsTimelineChatting(true);
    setTimeout(() => timelineChatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    try {
      const res = await axios.post(`/api/cases/${caseId}/timeline/chat`, {
        messages: newMessages.map(m => ({ role: m.role, content: m.content })),
      });
      setTimelineChatMessages(prev => [...prev, { role: 'assistant', content: res.data.response, webSources: res.data.web_sources }]);
      setTimeout(() => timelineChatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err) {
      console.error('Timeline chat failed:', err);
      setTimelineChatMessages(prev => [...prev, { role: 'assistant', content: 'Failed to get a response. Try again.' }]);
    } finally {
      setIsTimelineChatting(false);
    }
  }, [caseId, timelineChatInput, timelineChatMessages, isTimelineChatting]);

  // ── Fullscreen ─────────────────────────────────────────────────────────────

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // ── Edge label drag persistence ────────────────────────────────────────────

  const onEdgeLabelDrag = useCallback((edgeId: string, labelPosition: number) => {
    setEdges(eds => eds.map(e =>
      e.id === edgeId ? { ...e, data: { ...e.data, labelPosition } } : e
    ));
  }, [setEdges]);

  const onEdgeLabelDragEnd = useCallback((edgeId: string) => {
    const edge = edges.find(e => e.id === edgeId);
    const pos = edge?.data?.labelPosition ?? 0.5;
    axios.patch(`/api/cases/${caseId}/timeline/edges/${edgeId}`, {
      label_position: pos,
    }).catch(err => console.error('Failed to save label position:', err));
  }, [edges, caseId]);

  // ── Filter dropdown close on outside click ─────────────────────────────────

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as HTMLElement)) {
        setShowFilterDropdown(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  const toggleFilterCategory = useCallback((cat: string) => {
    setFilterCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // ── Filtered & sorted list for list view ──────────────────────────────────

  const sortedFilteredEvents = useMemo(() => {
    let filtered = [...nodes];
    if (filterCategories.size > 0) {
      filtered = filtered.filter(n => filterCategories.has(n.data?.category || 'general'));
    }
    filtered = filtered.filter(n => isEventTrackVisible(n.data?.track_ids));
    return filtered.sort((a, b) => {
      const ka = parseEventSortKey(a.data?.event_date);
      const kb = parseEventSortKey(b.data?.event_date);
      return ka.localeCompare(kb);
    });
  }, [nodes, filterCategories, isEventTrackVisible]);

  // Group events by category (for filtered list view)
  const groupedByCategory = useMemo(() => {
    if (filterCategories.size === 0) return null;
    const groups: { key: string; cat: typeof EVENT_CATEGORIES[string]; events: typeof sortedFilteredEvents }[] = [];
    const catMap = new Map<string, typeof sortedFilteredEvents>();
    for (const node of sortedFilteredEvents) {
      const catKey = node.data?.category || 'general';
      if (!catMap.has(catKey)) catMap.set(catKey, []);
      catMap.get(catKey)!.push(node);
    }
    // Maintain a stable order based on EVENT_CATEGORIES key order
    for (const key of Object.keys(EVENT_CATEGORIES)) {
      const events = catMap.get(key);
      if (events && events.length > 0) {
        groups.push({ key, cat: EVENT_CATEGORIES[key], events });
      }
    }
    return groups;
  }, [sortedFilteredEvents, filterCategories]);

  // Group events by track — each track is a section; multi-track events appear
  // in every section they belong to. Events without tracks go under "Main".
  const groupedByTrack = useMemo(() => {
    if (!laneMode) return null;
    const groups: { key: string; label: string; color: string; events: typeof sortedFilteredEvents }[] = [];
    const byLane = new Map<string, typeof sortedFilteredEvents>();
    byLane.set('main', []);
    for (const t of enabledTracks) byLane.set(t.id, []);
    const enabledIds = new Set(enabledTracks.map(t => t.id));
    for (const node of sortedFilteredEvents) {
      const tids: string[] = (node.data?.track_ids || []).filter((id: string) => enabledIds.has(id));
      const targets = tids.length > 0 ? tids : ['main'];
      for (const laneKey of targets) {
        byLane.get(laneKey)?.push(node);
      }
    }
    const mainEvents = byLane.get('main') || [];
    if (mainEvents.length > 0) {
      groups.push({ key: 'main', label: 'Main', color: '#8E8E93', events: mainEvents });
    }
    for (const t of enabledTracks) {
      const evs = byLane.get(t.id) || [];
      if (evs.length > 0) {
        groups.push({ key: t.id, label: t.label, color: t.color, events: evs });
      }
    }
    return groups;
  }, [sortedFilteredEvents, laneMode, enabledTracks]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="text-[#007AFF] animate-spin" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden relative bg-black">
      {/* Top toolbar: create + import */}
      {!readOnly && (
        <div className="shrink-0 px-4 py-3 border-b border-[rgba(84,84,88,0.65)] bg-black z-10">
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowCreateForm(prev => !prev); setShowImport(false); }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold transition-colors ${
                showCreateForm
                  ? 'bg-[#007AFF] text-white'
                  : 'bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.6)] hover:border-[#007AFF]'
              }`}
            >
              <Plus size={14} />
              Add Event
            </button>
            <button
              onClick={() => {
                setShowImport(prev => !prev);
                setShowCreateForm(false);
                if (!showImport) loadGraphEvents();
              }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold transition-colors ${
                showImport
                  ? 'bg-[#AF52DE] text-white'
                  : 'bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.6)] hover:border-[#AF52DE]'
              }`}
            >
              <Database size={14} />
              Import from Graph
            </button>
            <button
              onClick={() => { setShowResearch(prev => !prev); setShowCreateForm(false); setShowImport(false); }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold transition-colors ${
                showResearch
                  ? 'bg-[#FF9F0A] text-black'
                  : 'bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.6)] hover:border-[#FF9F0A]'
              }`}
            >
              <Sparkles size={14} />
              Research
            </button>
            <button
              onClick={() => { setShowTrackModal(true); loadCaseEntities(); }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold transition-colors bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.6)] hover:border-[#5AC8FA]"
            >
              <Users size={14} />
              Generate Track
            </button>
          </div>

          {/* Track pills row */}
          {tracks.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">Tracks</span>
              {tracks.map(t => {
                const isDisabled = disabledTrackIds.has(t.id);
                return (
                  <div
                    key={t.id}
                    className="group flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 rounded-full border transition-all"
                    style={{
                      background: isDisabled ? 'rgba(28,28,30,0.6)' : `${t.color}15`,
                      borderColor: isDisabled ? 'rgba(84,84,88,0.35)' : `${t.color}60`,
                    }}
                  >
                    <button
                      onClick={() => toggleTrackEnabled(t.id)}
                      className="flex items-center gap-1.5"
                      title={isDisabled ? 'Show this track' : 'Hide this track'}
                    >
                      <div
                        className="w-2.5 h-2.5 rounded-full transition-opacity"
                        style={{ background: t.color, opacity: isDisabled ? 0.3 : 1 }}
                      />
                      <span
                        className="text-[11px] font-medium transition-opacity"
                        style={{ color: isDisabled ? 'rgba(235,235,245,0.35)' : t.color, opacity: isDisabled ? 0.6 : 1 }}
                      >
                        {t.label}
                      </span>
                      <span className="text-[10px] font-mono text-[rgba(235,235,245,0.35)]">
                        {t.event_count ?? 0}
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        setGenerateTrack(t);
                        setTrackMessages([]);
                      }}
                      className="p-0.5 rounded hover:bg-[rgba(255,255,255,0.1)] transition-colors"
                      title="Generate more events for this track"
                    >
                      <Sparkles size={10} className="text-[rgba(235,235,245,0.5)]" />
                    </button>
                    <button
                      onClick={() => deleteTrack(t.id)}
                      className="p-0.5 rounded hover:bg-[#FF453A]/30 transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete track"
                    >
                      <X size={10} className="text-[#FF453A]" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Create form */}
          {showCreateForm && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') createEvent(); if (e.key === 'Escape') setShowCreateForm(false); }}
                  placeholder="Event title..."
                  autoFocus
                  className="flex-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors"
                />
                <input
                  type="text"
                  value={newDate}
                  onChange={e => setNewDate(e.target.value)}
                  placeholder="Date (YYYY-MM-DD)"
                  className="w-36 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newDescription}
                  onChange={e => setNewDescription(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') createEvent(); }}
                  placeholder="Description (optional)"
                  className="flex-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors"
                />
                <select
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value)}
                  className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white focus:outline-none transition-colors"
                >
                  {Object.entries(EVENT_CATEGORIES).map(([key, { label }]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
                <button
                  onClick={createEvent}
                  disabled={!newTitle.trim() || isCreating}
                  className="flex items-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-3 py-2 rounded-xl text-[13px] font-semibold text-white transition-colors shrink-0"
                >
                  {isCreating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  Add
                </button>
              </div>
            </div>
          )}

          {/* Import panel */}
          {showImport && (
            <div className="mt-3 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl overflow-hidden max-h-64">
              {isLoadingGraphEvents ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={20} className="text-[#AF52DE] animate-spin" />
                </div>
              ) : graphEvents.length === 0 ? (
                <div className="py-6 text-center text-[13px] text-[rgba(235,235,245,0.4)]">
                  No EVENT-typed entities in the network map
                </div>
              ) : (
                <>
                  <div className="overflow-y-auto max-h-48">
                    {graphEvents.map(ev => (
                      <button
                        key={ev.id}
                        onClick={() => setSelectedImports(prev => {
                          const next = new Set(prev);
                          if (next.has(ev.id)) next.delete(ev.id);
                          else next.add(ev.id);
                          return next;
                        })}
                        className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-[#2C2C2E] transition-colors ${
                          selectedImports.has(ev.id) ? 'bg-[#AF52DE]/10' : ''
                        }`}
                      >
                        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                          selectedImports.has(ev.id)
                            ? 'bg-[#AF52DE] border-[#AF52DE]'
                            : 'border-[rgba(84,84,88,0.65)]'
                        }`}>
                          {selectedImports.has(ev.id) && <Check size={12} className="text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] text-white font-medium truncate">{ev.label}</p>
                          {ev.description && (
                            <p className="text-[11px] text-[rgba(235,235,245,0.4)] truncate">{ev.description}</p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="px-3 py-2 border-t border-[rgba(84,84,88,0.35)] flex items-center justify-between">
                    <span className="text-[11px] text-[rgba(235,235,245,0.4)]">
                      {selectedImports.size} selected
                    </span>
                    <button
                      onClick={importSelected}
                      disabled={selectedImports.size === 0 || isImporting}
                      className="flex items-center gap-1.5 bg-[#AF52DE] hover:bg-[#9642C0] disabled:opacity-50 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-colors"
                    >
                      {isImporting ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />}
                      Import
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Canvas/List + Research panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas or List view */}
        {viewMode === 'canvas' ? (
          <div className={`flex-1 relative${isAnimatingLayout ? ' timeline-animating' : ''}`}>
            <NexusCanvas
              nodes={displayNodes}
              edges={edges}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={clearSelection}
              onMoveEnd={onMoveEnd}
              panOnDrag={true}
              skipInitialFitView={hasSavedViewport.current}
              showMiniMap={showMiniMap}
              customNodeTypes={nodeTypes}
              onEdgeLabelDrag={onEdgeLabelDrag}
              onEdgeLabelDragEnd={onEdgeLabelDragEnd}
            />
            {laneMode && <LaneLabels markers={laneMarkers} totalWidth={laneTotalWidth} />}
            <YearMarkers markers={yearMarkers} />

            {/* MiniMap toggle */}
            <button
              onClick={() => setShowMiniMap(v => !v)}
              className="absolute z-20 flex items-center gap-1 px-2 py-1 rounded-lg bg-[#1C1C1E]/90 border border-[rgba(84,84,88,0.65)] hover:bg-[#2C2C2E] transition-all backdrop-blur-sm text-[10px] font-medium text-[rgba(235,235,245,0.5)] hover:text-white"
              style={{ bottom: showMiniMap ? 160 : 14, right: 14 }}
              title={showMiniMap ? 'Collapse minimap' : 'Expand minimap'}
            >
              <MapIcon size={10} />
              {showMiniMap ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
            </button>

            {/* Timeline AI chat widget */}
            <div
              className="absolute z-20 flex flex-col transition-all"
              style={{ bottom: showMiniMap ? 165 : 14, right: showMiniMap ? 220 : 50, width: timelineChatOpen ? 340 : 'auto' }}
            >
              {timelineChatOpen ? (
                <div className="bg-[#1C1C1E]/95 backdrop-blur-md border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl flex flex-col" style={{ height: 380 }}>
                  {/* Header */}
                  <div className="shrink-0 px-3 py-2 flex items-center justify-between border-b border-[rgba(84,84,88,0.35)]">
                    <div className="flex items-center gap-2">
                      <Bot size={14} className="text-[#AF52DE]" />
                      <span className="text-[12px] font-semibold text-white">Timeline Analyst</span>
                      <span title="Web search enabled"><Globe size={10} className="text-[#30D158]" /></span>
                    </div>
                    <div className="flex items-center gap-1">
                      {timelineChatMessages.length > 0 && (
                        <button
                          onClick={() => setTimelineChatMessages([])}
                          className="p-1 hover:bg-[#2C2C2E] rounded-lg text-[rgba(235,235,245,0.3)] hover:text-white transition-colors"
                          title="Clear chat"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                      <button onClick={() => setTimelineChatOpen(false)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                        <X size={14} className="text-[rgba(235,235,245,0.4)]" />
                      </button>
                    </div>
                  </div>

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                    {timelineChatMessages.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full text-center gap-2 opacity-50">
                        <Bot size={24} className="text-[#AF52DE]" />
                        <p className="text-[11px] text-[rgba(235,235,245,0.4)] max-w-[200px]">
                          Ask about patterns, suspicious timing, gaps in the timeline, or leads worth investigating.
                        </p>
                      </div>
                    )}
                    {timelineChatMessages.map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                          msg.role === 'user'
                            ? 'bg-[#AF52DE] text-white'
                            : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.6)]'
                        }`}>
                          <p className="text-[12px] whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                          {msg.webSources && msg.webSources.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-[rgba(84,84,88,0.35)] flex flex-col gap-1">
                              {msg.webSources.map((source, idx) => (
                                <a
                                  key={idx}
                                  href={source.uri}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[11px] text-[#BF5AF2] hover:underline flex items-center gap-2 truncate"
                                >
                                  <span className="shrink-0 text-[10px] bg-[#BF5AF2]/10 px-1.5 py-0.5 rounded text-[#BF5AF2] font-mono">{idx + 1}</span>
                                  <span className="truncate">{source.title || source.domain}</span>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {isTimelineChatting && (
                      <div className="flex justify-start">
                        <div className="bg-[#2C2C2E] rounded-2xl px-3 py-2">
                          <Loader2 size={14} className="text-[#AF52DE] animate-spin" />
                        </div>
                      </div>
                    )}
                    <div ref={timelineChatEndRef} />
                  </div>

                  {/* Input */}
                  <div className="shrink-0 px-2.5 py-2 border-t border-[rgba(84,84,88,0.35)]">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={timelineChatInput}
                        onChange={e => setTimelineChatInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTimelineChatMessage(); } }}
                        placeholder="Ask about this timeline..."
                        disabled={isTimelineChatting}
                        className="flex-1 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-1.5 text-[12px] text-white focus:outline-none focus:border-[#AF52DE] transition-colors placeholder:text-[rgba(235,235,245,0.2)] disabled:opacity-50"
                      />
                      <button
                        onClick={sendTimelineChatMessage}
                        disabled={!timelineChatInput.trim() || isTimelineChatting}
                        className="w-8 h-8 rounded-xl bg-[#AF52DE] hover:bg-[#9B45C4] disabled:opacity-30 flex items-center justify-center transition-colors shrink-0"
                      >
                        <Send size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setTimelineChatOpen(true)}
                  className="w-9 h-9 rounded-xl bg-[#1C1C1E]/90 backdrop-blur-sm border border-[rgba(84,84,88,0.65)] hover:bg-[#2C2C2E] flex items-center justify-center transition-colors group"
                  title="Timeline Analyst"
                >
                  <Bot size={16} className="text-[#AF52DE] group-hover:scale-110 transition-transform" />
                </button>
              )}
            </div>

            {/* Context menu for event editing */}
            {contextEvent && !readOnly && (
              <div
                ref={contextRef}
                className="absolute top-4 right-4 z-30 w-72 bg-[#1C1C1E]/95 backdrop-blur-xl border border-[rgba(84,84,88,0.65)] rounded-2xl shadow-2xl overflow-hidden"
              >
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider">Edit Event</span>
                    <button onClick={() => setContextEvent(null)} className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors">
                      <X size={12} className="text-[rgba(235,235,245,0.4)]" />
                    </button>
                  </div>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    placeholder="Title"
                    className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors"
                  />
                  <input
                    type="text"
                    value={editDate}
                    onChange={e => setEditDate(e.target.value)}
                    placeholder="Date (YYYY-MM-DD)"
                    className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors font-mono"
                  />
                  <textarea
                    value={editDescription}
                    onChange={e => setEditDescription(e.target.value)}
                    placeholder="Description"
                    rows={3}
                    className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors resize-none"
                  />
                  <select
                    value={editCategory}
                    onChange={e => setEditCategory(e.target.value)}
                    className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white focus:outline-none transition-colors"
                  >
                    {Object.entries(EVENT_CATEGORIES).map(([key, { label }]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={updateEvent}
                      disabled={isSavingEdit || !editTitle.trim()}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-3 py-2 rounded-xl text-[12px] font-semibold text-white transition-colors"
                    >
                      {isSavingEdit ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      Save
                    </button>
                    <button
                      onClick={() => deleteEvent(contextEvent.id)}
                      className="flex items-center justify-center gap-1.5 bg-[#FF453A]/20 hover:bg-[#FF453A]/30 px-3 py-2 rounded-xl text-[12px] font-semibold text-[#FF453A] transition-colors"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ── List view ─────────────────────────────────────────────────── */
          <div className="flex-1 overflow-y-auto">
            {sortedFilteredEvents.length === 0 ? (
              <div className="flex items-center justify-center h-full text-[13px] text-[rgba(235,235,245,0.3)]">
                {filterCategories.size > 0 ? 'No events match the selected filters' : 'No events yet'}
              </div>
            ) : groupedByTrack ? (
              /* Grouped by track (swim-lane mode) */
              <div className="divide-y divide-[rgba(84,84,88,0.65)]">
                {groupedByTrack.map(({ key: trackKey, label, color, events }) => (
                  <div key={trackKey}>
                    {/* Track header */}
                    <div className="sticky top-0 z-10 bg-[#0A0A0A] px-4 py-2.5 flex items-center gap-2.5 border-b border-[rgba(84,84,88,0.35)]">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                      <span className="text-[13px] font-bold" style={{ color }}>{label}</span>
                      <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono">{events.length}</span>
                    </div>
                    {/* Events in this track */}
                    <table className="w-full">
                      <tbody>
                        {events.map((node) => {
                          const nodeCat = EVENT_CATEGORIES[node.data?.category] || EVENT_CATEGORIES.general;
                          const isSelected = selectedNodeIds.has(node.id);
                          return (
                            <tr
                              key={`${trackKey}::${node.id}`}
                              className={`group border-b border-[rgba(84,84,88,0.15)] hover:bg-[#1C1C1E] transition-colors cursor-pointer ${
                                isSelected ? 'bg-[#FF9F0A]/5' : contextEvent?.id === node.id ? 'bg-[#1C1C1E]' : ''
                              }`}
                              onClick={(e) => {
                                if (e.shiftKey || selectMode) {
                                  setSelectedNodeIds(prev => {
                                    const next = new Set(prev);
                                    if (next.has(node.id)) next.delete(node.id);
                                    else next.add(node.id);
                                    return next;
                                  });
                                } else if (!readOnly) {
                                  setContextEvent(prev => {
                                    const target = prev?.id === node.id ? null : node;
                                    if (target) {
                                      setEditTitle(target.data.title || '');
                                      setEditDate(target.data.event_date || '');
                                      setEditDescription(target.data.description || '');
                                      setEditCategory(target.data.category || 'general');
                                    }
                                    return target;
                                  });
                                }
                              }}
                            >
                              <td className="pl-4 pr-1 py-2.5 w-8">
                                <div
                                  onClick={e => {
                                    e.stopPropagation();
                                    setSelectedNodeIds(prev => {
                                      const next = new Set(prev);
                                      if (next.has(node.id)) next.delete(node.id);
                                      else next.add(node.id);
                                      return next;
                                    });
                                  }}
                                  className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                                    isSelected
                                      ? 'bg-[#FF9F0A] border-[#FF9F0A]'
                                      : 'border-[rgba(84,84,88,0.65)] opacity-0 group-hover:opacity-100'
                                  }`}
                                >
                                  {isSelected && <Check size={10} className="text-black" />}
                                </div>
                              </td>
                              <td className="pr-2 py-2.5 w-28">
                                <span className="text-[12px] font-mono font-medium" style={{ color: nodeCat.color }}>
                                  {formatEventDate(node.data?.event_date)}
                                </span>
                              </td>
                              <td className="px-2 py-2.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-[13px] font-semibold text-white">{node.data?.title}</span>
                                  {(node.data?.track_ids || []).length > 1 && (
                                    <div className="flex items-center gap-0.5 shrink-0">
                                      {(node.data.track_ids as string[]).slice(0, 6).map(tid => {
                                        const t = trackById[tid];
                                        if (!t || t.id === trackKey) return null;
                                        return (
                                          <div
                                            key={tid}
                                            className="w-1.5 h-1.5 rounded-full"
                                            style={{ background: t.color }}
                                            title={`Also in ${t.label}`}
                                          />
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              </td>
                              <td className="px-2 py-2.5">
                                <span className="text-[12px] text-[rgba(235,235,245,0.45)] line-clamp-2">{node.data?.description}</span>
                              </td>
                              {!readOnly && (
                                <td className="px-2 py-2.5 w-10">
                                  <button
                                    onClick={e => { e.stopPropagation(); deleteEvent(node.id); }}
                                    className="p-1.5 rounded-lg hover:bg-[#FF453A]/20 transition-colors opacity-0 group-hover:opacity-100"
                                    title="Delete"
                                  >
                                    <Trash2 size={12} className="text-[#FF453A]" />
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ) : groupedByCategory ? (
              /* Grouped by category when filters are active */
              <div className="divide-y divide-[rgba(84,84,88,0.65)]">
                {groupedByCategory.map(({ key: catKey, cat, events }) => {
                  const CatIcon = cat.icon;
                  return (
                    <div key={catKey}>
                      {/* Category header */}
                      <div className="sticky top-0 z-10 bg-[#0A0A0A] px-4 py-2.5 flex items-center gap-2.5 border-b border-[rgba(84,84,88,0.35)]">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: cat.color }} />
                        <CatIcon size={13} style={{ color: cat.color }} />
                        <span className="text-[13px] font-bold" style={{ color: cat.color }}>{cat.label}</span>
                        <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono">{events.length}</span>
                      </div>
                      {/* Events in this category */}
                      <table className="w-full">
                        <tbody>
                          {events.map((node) => {
                            const nodeCat = EVENT_CATEGORIES[node.data?.category] || EVENT_CATEGORIES.general;
                            const isSelected = selectedNodeIds.has(node.id);
                            return (
                              <tr
                                key={node.id}
                                className={`group border-b border-[rgba(84,84,88,0.15)] hover:bg-[#1C1C1E] transition-colors cursor-pointer ${
                                  isSelected ? 'bg-[#FF9F0A]/5' : contextEvent?.id === node.id ? 'bg-[#1C1C1E]' : ''
                                }`}
                                onClick={(e) => {
                                  if (e.shiftKey || selectMode) {
                                    setSelectedNodeIds(prev => {
                                      const next = new Set(prev);
                                      if (next.has(node.id)) next.delete(node.id);
                                      else next.add(node.id);
                                      return next;
                                    });
                                  } else if (!readOnly) {
                                    setContextEvent(prev => {
                                      const target = prev?.id === node.id ? null : node;
                                      if (target) {
                                        setEditTitle(target.data.title || '');
                                        setEditDate(target.data.event_date || '');
                                        setEditDescription(target.data.description || '');
                                        setEditCategory(target.data.category || 'general');
                                      }
                                      return target;
                                    });
                                  }
                                }}
                              >
                                <td className="pl-4 pr-1 py-2.5 w-8">
                                  <div
                                    onClick={e => {
                                      e.stopPropagation();
                                      setSelectedNodeIds(prev => {
                                        const next = new Set(prev);
                                        if (next.has(node.id)) next.delete(node.id);
                                        else next.add(node.id);
                                        return next;
                                      });
                                    }}
                                    className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                                      isSelected
                                        ? 'bg-[#FF9F0A] border-[#FF9F0A]'
                                        : 'border-[rgba(84,84,88,0.65)] opacity-0 group-hover:opacity-100'
                                    }`}
                                  >
                                    {isSelected && <Check size={10} className="text-black" />}
                                  </div>
                                </td>
                                <td className="pr-2 py-2.5 w-28">
                                  <span className="text-[12px] font-mono font-medium" style={{ color: nodeCat.color }}>
                                    {formatEventDate(node.data?.event_date)}
                                  </span>
                                </td>
                                <td className="px-2 py-2.5">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[13px] font-semibold text-white">{node.data?.title}</span>
                                    {(node.data?.track_ids || []).length > 0 && (
                                      <div className="flex items-center gap-0.5 shrink-0">
                                        {(node.data.track_ids as string[]).slice(0, 6).map(tid => {
                                          const t = trackById[tid];
                                          if (!t) return null;
                                          return (
                                            <div
                                              key={tid}
                                              className="w-1.5 h-1.5 rounded-full"
                                              style={{ background: t.color }}
                                              title={t.label}
                                            />
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="px-2 py-2.5">
                                  <span className="text-[12px] text-[rgba(235,235,245,0.45)] line-clamp-2">{node.data?.description}</span>
                                </td>
                                {!readOnly && (
                                  <td className="px-2 py-2.5 w-10">
                                    <button
                                      onClick={e => { e.stopPropagation(); deleteEvent(node.id); }}
                                      className="p-1.5 rounded-lg hover:bg-[#FF453A]/20 transition-colors opacity-0 group-hover:opacity-100"
                                      title="Delete"
                                    >
                                      <Trash2 size={12} className="text-[#FF453A]" />
                                    </button>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Flat table when no filters */
              <table className="w-full">
                <thead className="sticky top-0 z-10 bg-[#0A0A0A]">
                  <tr className="border-b border-[rgba(84,84,88,0.65)]">
                    <th className="text-left text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider px-4 py-2.5 w-10"></th>
                    <th className="text-left text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider px-4 py-2.5 w-32">Date</th>
                    <th className="text-left text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider px-4 py-2.5 w-28">Category</th>
                    <th className="text-left text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider px-4 py-2.5">Title</th>
                    <th className="text-left text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider px-4 py-2.5">Description</th>
                    {!readOnly && <th className="w-10"></th>}
                  </tr>
                </thead>
                <tbody>
                  {sortedFilteredEvents.map((node) => {
                    const cat = EVENT_CATEGORIES[node.data?.category] || EVENT_CATEGORIES.general;
                    const Icon = cat.icon;
                    const isSelected = selectedNodeIds.has(node.id);
                    return (
                      <tr
                        key={node.id}
                        className={`group border-b border-[rgba(84,84,88,0.25)] hover:bg-[#1C1C1E] transition-colors cursor-pointer ${
                          isSelected ? 'bg-[#FF9F0A]/5' : contextEvent?.id === node.id ? 'bg-[#1C1C1E]' : ''
                        }`}
                        onClick={(e) => {
                          if (e.shiftKey || selectMode) {
                            setSelectedNodeIds(prev => {
                              const next = new Set(prev);
                              if (next.has(node.id)) next.delete(node.id);
                              else next.add(node.id);
                              return next;
                            });
                          } else if (!readOnly) {
                            setContextEvent(prev => {
                              const target = prev?.id === node.id ? null : node;
                              if (target) {
                                setEditTitle(target.data.title || '');
                                setEditDate(target.data.event_date || '');
                                setEditDescription(target.data.description || '');
                                setEditCategory(target.data.category || 'general');
                              }
                              return target;
                            });
                          }
                        }}
                      >
                        <td className="px-2 py-2.5 w-8">
                          <div
                            onClick={e => {
                              e.stopPropagation();
                              setSelectedNodeIds(prev => {
                                const next = new Set(prev);
                                if (next.has(node.id)) next.delete(node.id);
                                else next.add(node.id);
                                return next;
                              });
                            }}
                            className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                              isSelected
                                ? 'bg-[#FF9F0A] border-[#FF9F0A]'
                                : 'border-[rgba(84,84,88,0.65)] opacity-0 group-hover:opacity-100'
                            }`}
                          >
                            {isSelected && <Check size={10} className="text-black" />}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <div
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: cat.color }}
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-[12px] font-mono font-medium" style={{ color: cat.color }}>
                            {formatEventDate(node.data?.event_date)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <Icon size={11} style={{ color: cat.color }} />
                            <span className="text-[11px] text-[rgba(235,235,245,0.5)]">{cat.label}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold text-white">{node.data?.title}</span>
                            {(node.data?.track_ids || []).length > 0 && (
                              <div className="flex items-center gap-0.5 shrink-0">
                                {(node.data.track_ids as string[]).slice(0, 6).map(tid => {
                                  const t = trackById[tid];
                                  if (!t) return null;
                                  return (
                                    <div
                                      key={tid}
                                      className="w-1.5 h-1.5 rounded-full"
                                      style={{ background: t.color }}
                                      title={t.label}
                                    />
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-[12px] text-[rgba(235,235,245,0.45)] line-clamp-2">{node.data?.description}</span>
                        </td>
                        {!readOnly && (
                          <td className="px-2 py-2.5">
                            <button
                              onClick={e => { e.stopPropagation(); deleteEvent(node.id); }}
                              className="p-1.5 rounded-lg hover:bg-[#FF453A]/20 transition-colors opacity-0 group-hover:opacity-100"
                              title="Delete"
                            >
                              <Trash2 size={12} className="text-[#FF453A]" />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Inline edit panel for list view */}
            {contextEvent && !readOnly && viewMode === 'list' && (
              <div className="sticky bottom-0 bg-[#1C1C1E]/95 backdrop-blur-xl border-t border-[rgba(84,84,88,0.65)] p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    placeholder="Title"
                    className="flex-1 min-w-[200px] bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors"
                  />
                  <input
                    type="text"
                    value={editDate}
                    onChange={e => setEditDate(e.target.value)}
                    placeholder="YYYY-MM-DD"
                    className="w-32 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors font-mono"
                  />
                  <select
                    value={editCategory}
                    onChange={e => setEditCategory(e.target.value)}
                    className="bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white focus:outline-none transition-colors"
                  >
                    {Object.entries(EVENT_CATEGORIES).map(([key, { label }]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                  <button
                    onClick={updateEvent}
                    disabled={isSavingEdit || !editTitle.trim()}
                    className="flex items-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-3 py-2 rounded-xl text-[12px] font-semibold text-white transition-colors"
                  >
                    {isSavingEdit ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Save
                  </button>
                  <button
                    onClick={() => setContextEvent(null)}
                    className="p-2 hover:bg-[#2C2C2E] rounded-xl transition-colors"
                  >
                    <X size={14} className="text-[rgba(235,235,245,0.4)]" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Generate-track side panel */}
        {generateTrack && (
          <div className="w-80 shrink-0 flex flex-col bg-[#0A0A0A] border-l border-[rgba(84,84,88,0.65)]">
            <div className="shrink-0 px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ background: generateTrack.color }} />
                  <span className="text-[13px] font-semibold text-white truncate">Track: {generateTrack.label}</span>
                </div>
                <button
                  onClick={() => { setGenerateTrack(null); setTrackMessages([]); setTrackQuery(''); }}
                  className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors shrink-0"
                >
                  <X size={14} className="text-[rgba(235,235,245,0.4)]" />
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                {TRACK_COLOR_PALETTE.map(c => (
                  <button
                    key={c}
                    onClick={() => updateTrackColor(generateTrack.id, c)}
                    className="w-4 h-4 rounded-full border-2 transition-transform hover:scale-110"
                    style={{ background: c, borderColor: c === generateTrack.color ? 'white' : 'transparent' }}
                    title={c}
                  />
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
              {trackMessages.length === 0 && !isGeneratingTrack && (
                <div className="text-center py-8">
                  <Users size={24} className="mx-auto mb-3" style={{ color: `${generateTrack.color}60` }} />
                  <p className="text-[13px] text-[rgba(235,235,245,0.4)] mb-1">Generate events for {generateTrack.label}</p>
                  <p className="text-[11px] text-[rgba(235,235,245,0.25)] leading-relaxed px-4 mb-4">
                    AI will use this person's network-graph connections + web research to suggest events.
                  </p>
                  <button
                    onClick={() => sendGenerateTrack('')}
                    disabled={isGeneratingTrack}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-semibold text-white transition-colors disabled:opacity-50"
                    style={{ background: generateTrack.color }}
                  >
                    <Sparkles size={12} />
                    Start generating
                  </button>
                </div>
              )}

              {trackMessages.map((msg, i) => (
                <div key={i}>
                  {msg.role === 'user' ? (
                    <div className="flex justify-end">
                      <div
                        className="rounded-2xl rounded-br-md px-3 py-2 max-w-[85%]"
                        style={{ background: generateTrack.color, color: 'black' }}
                      >
                        <p className="text-[12px] font-medium">{msg.content}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.35)] rounded-2xl rounded-bl-md px-3 py-2.5">
                        <p className="text-[12px] text-[rgba(235,235,245,0.8)] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                        {msg.webSources && msg.webSources.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-[rgba(84,84,88,0.25)] flex flex-wrap gap-1.5">
                            {msg.webSources.slice(0, 5).map((src, si) => (
                              <a
                                key={si}
                                href={src.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#2C2C2E] hover:bg-[#3A3A3C] transition-colors"
                                title={src.title}
                              >
                                <ExternalLink size={9} className="text-[#007AFF]" />
                                <span className="text-[10px] text-[#007AFF] truncate max-w-[120px]">{src.domain}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>

                      {msg.events && msg.events.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between px-1">
                            <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">
                              Suggested Events
                            </span>
                            <button
                              onClick={async () => {
                                for (let ei = 0; ei < (msg.events || []).length; ei++) {
                                  const ev = msg.events![ei];
                                  await addTrackEvent(ev, `${i}-${ei}`);
                                }
                              }}
                              className="text-[10px] font-semibold transition-colors"
                              style={{ color: generateTrack.color }}
                            >
                              + Add all
                            </button>
                          </div>
                          {msg.events.map((ev, ei) => {
                            const cat = EVENT_CATEGORIES[ev.category] || EVENT_CATEGORIES.general;
                            const key = `${i}-${ei}`;
                            return (
                              <div
                                key={ei}
                                className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.35)] rounded-xl overflow-hidden"
                              >
                                <div style={{ height: 3, backgroundColor: cat.color }} />
                                <div className="px-2.5 py-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-[12px] font-semibold text-white leading-tight">{ev.title}</p>
                                      {ev.date && (
                                        <span className="text-[10px] font-mono" style={{ color: cat.color }}>{ev.date}</span>
                                      )}
                                      {ev.description && (
                                        <p className="text-[10px] text-[rgba(235,235,245,0.4)] leading-snug mt-0.5">{ev.description}</p>
                                      )}
                                    </div>
                                    <button
                                      onClick={() => addTrackEvent(ev, key)}
                                      disabled={addingTrackEventIndex === key}
                                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold transition-colors disabled:opacity-50"
                                      style={{ background: `${generateTrack.color}30`, color: generateTrack.color }}
                                    >
                                      {addingTrackEventIndex === key ? (
                                        <Loader2 size={10} className="animate-spin" />
                                      ) : (
                                        <Plus size={10} />
                                      )}
                                      Add
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {isGeneratingTrack && (
                <div className="flex items-center gap-2 px-1">
                  <Loader2 size={14} className="animate-spin" style={{ color: generateTrack.color }} />
                  <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Generating...</span>
                </div>
              )}
              <div ref={trackEndRef} />
            </div>

            <div className="shrink-0 px-3 py-2.5 border-t border-[rgba(84,84,88,0.35)]">
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={trackQuery}
                  onChange={e => setTrackQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGenerateTrack(); } }}
                  placeholder="Refine (e.g. focus on 2005-2010)..."
                  disabled={isGeneratingTrack}
                  className="flex-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-2 text-[12px] text-white focus:outline-none transition-colors placeholder:text-[rgba(235,235,245,0.2)] disabled:opacity-50"
                  style={{ borderColor: isGeneratingTrack ? 'rgba(84,84,88,0.65)' : undefined }}
                />
                <button
                  onClick={() => sendGenerateTrack()}
                  disabled={isGeneratingTrack}
                  className="w-8 h-8 rounded-xl disabled:opacity-30 flex items-center justify-center transition-colors shrink-0"
                  style={{ background: generateTrack.color }}
                >
                  <Send size={12} className="text-black" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Research side panel */}
        {showResearch && (
          <div className="w-80 shrink-0 flex flex-col bg-[#0A0A0A] border-l border-[rgba(84,84,88,0.65)]">
            {/* Header */}
            <div className="shrink-0 px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)]">
              <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-[#FF9F0A]" />
                <span className="text-[13px] font-semibold text-white">Research</span>
              </div>
              <button
                onClick={() => setShowResearch(false)}
                className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors"
              >
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
              </div>
              {selectedNodeIds.size > 0 && (
                <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#FF9F0A]/10 border border-[#FF9F0A]/20">
                  <MessageSquare size={10} className="text-[#FF9F0A]" />
                  <span className="text-[10px] text-[#FF9F0A] font-medium">
                    {selectedNodeIds.size} event{selectedNodeIds.size !== 1 ? 's' : ''} focused — AI will use them as context
                  </span>
                </div>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
              {researchMessages.length === 0 && (
                <div className="text-center py-8">
                  <Sparkles size={24} className="text-[#FF9F0A]/30 mx-auto mb-3" />
                  <p className="text-[13px] text-[rgba(235,235,245,0.4)] mb-1">AI-powered research</p>
                  <p className="text-[11px] text-[rgba(235,235,245,0.25)] leading-relaxed px-4">
                    Ask about events, people, deals, court cases — results can be added directly to your timeline
                  </p>
                </div>
              )}

              {researchMessages.map((msg, i) => (
                <div key={i}>
                  {msg.role === 'user' ? (
                    <div className="flex justify-end">
                      <div className="bg-[#FF9F0A] text-black rounded-2xl rounded-br-md px-3 py-2 max-w-[85%]">
                        <p className="text-[12px] font-medium">{msg.content}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.35)] rounded-2xl rounded-bl-md px-3 py-2.5">
                        <p className="text-[12px] text-[rgba(235,235,245,0.8)] leading-relaxed whitespace-pre-wrap">{msg.content}</p>

                        {/* Web sources */}
                        {msg.webSources && msg.webSources.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-[rgba(84,84,88,0.25)] flex flex-wrap gap-1.5">
                            {msg.webSources.slice(0, 5).map((src, si) => (
                              <a
                                key={si}
                                href={src.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#2C2C2E] hover:bg-[#3A3A3C] transition-colors"
                                title={src.title}
                              >
                                <ExternalLink size={9} className="text-[#007AFF]" />
                                <span className="text-[10px] text-[#007AFF] truncate max-w-[120px]">{src.domain}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Event suggestions */}
                      {msg.events && msg.events.length > 0 && (
                        <div className="space-y-1.5">
                          <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider px-1">
                            Suggested Events
                          </span>
                          {msg.events.map((ev, ei) => {
                            const cat = EVENT_CATEGORIES[ev.category] || EVENT_CATEGORIES.general;
                            const key = `${i}-${ei}`;
                            return (
                              <div
                                key={ei}
                                className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.35)] rounded-xl overflow-hidden"
                              >
                                <div style={{ height: 3, backgroundColor: cat.color }} />
                                <div className="px-2.5 py-2">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-[12px] font-semibold text-white leading-tight">{ev.title}</p>
                                      {ev.date && (
                                        <span className="text-[10px] font-mono" style={{ color: cat.color }}>{ev.date}</span>
                                      )}
                                      {ev.description && (
                                        <p className="text-[10px] text-[rgba(235,235,245,0.4)] leading-snug mt-0.5">{ev.description}</p>
                                      )}
                                    </div>
                                    <button
                                      onClick={() => addResearchEvent(ev, key)}
                                      disabled={addingEventIndex === key}
                                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg bg-[#FF9F0A]/20 hover:bg-[#FF9F0A]/30 text-[#FF9F0A] text-[10px] font-semibold transition-colors disabled:opacity-50"
                                    >
                                      {addingEventIndex === key ? (
                                        <Loader2 size={10} className="animate-spin" />
                                      ) : (
                                        <Plus size={10} />
                                      )}
                                      Add
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {isResearching && (
                <div className="flex items-center gap-2 px-1">
                  <Loader2 size={14} className="text-[#FF9F0A] animate-spin" />
                  <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Researching...</span>
                </div>
              )}
              <div ref={researchEndRef} />
            </div>

            {/* Input */}
            <div className="shrink-0 px-3 py-2.5 border-t border-[rgba(84,84,88,0.35)]">
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={researchQuery}
                  onChange={e => setResearchQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendResearch(); } }}
                  placeholder="Research a topic..."
                  disabled={isResearching}
                  className="flex-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-2 text-[12px] text-white focus:outline-none focus:border-[#FF9F0A] transition-colors placeholder:text-[rgba(235,235,245,0.2)] disabled:opacity-50"
                />
                <button
                  onClick={sendResearch}
                  disabled={!researchQuery.trim() || isResearching}
                  className="w-8 h-8 rounded-xl bg-[#FF9F0A] hover:bg-[#E8900A] disabled:opacity-30 flex items-center justify-center transition-colors shrink-0"
                >
                  <Send size={12} className="text-black" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer toolbar */}
      <div className="shrink-0 px-4 py-2 bg-black border-t border-[rgba(84,84,88,0.65)] flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 shrink-0">
          {/* View mode toggle */}
          <div className="flex items-center bg-[#2C2C2E] rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('canvas')}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium transition-colors ${
                viewMode === 'canvas'
                  ? 'bg-[#007AFF] text-white'
                  : 'text-[rgba(235,235,245,0.5)] hover:text-white'
              }`}
              title="Canvas view"
            >
              <LayoutGrid size={11} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium transition-colors ${
                viewMode === 'list'
                  ? 'bg-[#007AFF] text-white'
                  : 'text-[rgba(235,235,245,0.5)] hover:text-white'
              }`}
              title="List view"
            >
              <List size={11} />
            </button>
          </div>

          {/* Category filter */}
          <div className="relative" ref={filterRef}>
            <button
              onClick={() => setShowFilterDropdown(v => !v)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                filterCategories.size > 0
                  ? 'bg-[#FF9F0A] text-black'
                  : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] hover:text-white'
              }`}
            >
              <Filter size={11} />
              Filter{filterCategories.size > 0 && ` (${filterCategories.size})`}
            </button>
            {showFilterDropdown && (
              <div className="absolute bottom-full mb-1 left-0 z-40 bg-[#1C1C1E]/95 backdrop-blur-xl border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl overflow-hidden min-w-[180px]">
                <div className="px-3 py-2 border-b border-[rgba(84,84,88,0.35)] flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider">Categories</span>
                  {filterCategories.size > 0 && (
                    <button
                      onClick={() => setFilterCategories(new Set())}
                      className="text-[10px] text-[#007AFF] hover:text-[#0071E3] font-medium"
                    >
                      Clear all
                    </button>
                  )}
                </div>
                {Object.entries(EVENT_CATEGORIES).map(([key, { label, color }]) => {
                  const count = nodes.filter(n => (n.data?.category || 'general') === key).length;
                  if (count === 0) return null;
                  return (
                    <button
                      key={key}
                      onClick={() => toggleFilterCategory(key)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-[#2C2C2E] transition-colors"
                    >
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                        filterCategories.has(key)
                          ? 'border-transparent'
                          : 'border-[rgba(84,84,88,0.65)]'
                      }`} style={filterCategories.has(key) ? { backgroundColor: color } : {}}>
                        {filterCategories.has(key) && <Check size={10} className="text-black" />}
                      </div>
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <span className="text-[12px] text-[rgba(235,235,245,0.8)] flex-1 text-left">{label}</span>
                      <span className="text-[10px] text-[rgba(235,235,245,0.3)] font-mono">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {nodes.length > 0 && !readOnly && (
            <button
              onClick={() => setSelectMode(m => !m)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                selectMode
                  ? 'bg-[#007AFF] text-white'
                  : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.5)]'
              }`}
            >
              <MousePointerClick size={11} />
              Select
            </button>
          )}
          {viewMode === 'canvas' && (
            <button
              onClick={() => setShowMiniMap(v => !v)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                showMiniMap
                  ? 'bg-[#007AFF] text-white'
                  : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.5)]'
              }`}
            >
              <MapIcon size={11} />
              Map
            </button>
          )}
          <button
            onClick={toggleFullscreen}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] hover:text-white"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
          {viewMode === 'canvas' && !readOnly && !laneMode && (
            <button
              onClick={() => autoLayout()}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] hover:text-white"
              title="Auto-layout by date"
            >
              <LayoutGrid size={11} />
              Sort
            </button>
          )}
          {viewMode === 'canvas' && laneMode && (
            <button
              onClick={() => fitView({ padding: 0.25, duration: 400 })}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] hover:text-white"
              title="Fit all lanes in view"
            >
              <LayoutGrid size={11} />
              Fit
            </button>
          )}
          <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono">
            {filterCategories.size > 0
              ? `${sortedFilteredEvents.length}/${nodes.length} events`
              : `${nodes.length} ${nodes.length === 1 ? 'event' : 'events'}`
            } · {edges.length} {edges.length === 1 ? 'connection' : 'connections'}
            {selectMode && selectedNodeIds.size === 0 && ' · Tap events to select'}
          </span>
        </div>

        {/* Selection actions */}
        {selectedNodeIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-[rgba(235,235,245,0.6)] font-medium">
              {selectedNodeIds.size} selected
            </span>
            {selectedNodeIds.size === 2 && (
              <>
                <input
                  type="text"
                  value={linkLabel}
                  onChange={e => setLinkLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') linkSelectedEvents(); }}
                  placeholder="Label (optional)"
                  className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-lg px-2 py-1 text-[11px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors w-28"
                />
                <button
                  onClick={() => linkSelectedEvents()}
                  disabled={isLinking}
                  className="flex items-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
                >
                  {isLinking ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
                  Link
                </button>
              </>
            )}
            <button
              onClick={() => {
                setShowResearch(true);
                setShowCreateForm(false);
                setShowImport(false);
              }}
              className="flex items-center gap-1.5 bg-[#FF9F0A]/20 hover:bg-[#FF9F0A]/30 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-[#FF9F0A] transition-colors"
            >
              <MessageSquare size={11} />
              Discuss
            </button>
            <button
              onClick={deleteSelected}
              className="flex items-center gap-1.5 bg-[#FF453A]/20 hover:bg-[#FF453A]/30 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-[#FF453A] transition-colors"
            >
              <Trash2 size={11} />
              Delete
            </button>
            <button
              onClick={clearSelection}
              className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors"
            >
              <X size={12} className="text-[rgba(235,235,245,0.4)]" />
            </button>
          </div>
        )}
      </div>

      {/* Entity picker modal for creating a new track */}
      {showTrackModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => { if (!isCreatingTrack) setShowTrackModal(false); }}
        >
          <div
            className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-[rgba(84,84,88,0.35)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users size={16} className="text-[#5AC8FA]" />
                <h3 className="text-[14px] font-semibold text-white">New Timeline Track</h3>
              </div>
              <button
                onClick={() => setShowTrackModal(false)}
                disabled={isCreatingTrack}
                className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors disabled:opacity-50"
              >
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>

            <div className="px-4 py-4 space-y-4">
              <div>
                <label className="block text-[11px] font-semibold text-[rgba(235,235,245,0.5)] uppercase tracking-wider mb-1.5">
                  Entity
                </label>
                {caseEntities.length === 0 ? (
                  <div className="text-[12px] text-[rgba(235,235,245,0.4)] italic py-2">
                    No entities found in this case's network graph.
                  </div>
                ) : (
                  <select
                    value={newTrackEntityId}
                    onChange={e => setNewTrackEntityId(e.target.value)}
                    className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#5AC8FA] rounded-xl px-3 py-2 text-[13px] text-white focus:outline-none transition-colors"
                  >
                    <option value="">Select a person or entity...</option>
                    {caseEntities
                      .filter(e => !tracks.some(t => t.entity_node_id === e.id))
                      .map(e => (
                        <option key={e.id} value={e.id}>
                          {e.label} {e.type && e.type !== 'PERSON' ? `(${e.type})` : ''}
                        </option>
                      ))}
                  </select>
                )}
                <p className="mt-1.5 text-[10px] text-[rgba(235,235,245,0.35)] leading-relaxed">
                  AI will use this entity's connections in your case graph plus web search to suggest timeline events.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[rgba(235,235,245,0.5)] uppercase tracking-wider mb-1.5">
                  Track Color
                </label>
                <div className="flex flex-wrap gap-2">
                  {TRACK_COLOR_PALETTE.map(c => (
                    <button
                      key={c}
                      onClick={() => setNewTrackColor(c)}
                      className="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        background: c,
                        borderColor: c === newTrackColor ? 'white' : 'transparent',
                      }}
                      title={c}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="px-4 py-3 border-t border-[rgba(84,84,88,0.35)] flex items-center justify-end gap-2">
              <button
                onClick={() => setShowTrackModal(false)}
                disabled={isCreatingTrack}
                className="px-3 py-2 rounded-xl text-[13px] font-semibold text-[rgba(235,235,245,0.6)] hover:bg-[#2C2C2E] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={createTrack}
                disabled={!newTrackEntityId || isCreatingTrack}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-semibold text-white transition-colors disabled:opacity-40"
                style={{ background: newTrackColor }}
              >
                {isCreatingTrack ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Plus size={12} />
                )}
                Create Track
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CaseTimeline(props: CaseTimelineProps) {
  return (
    <ReactFlowProvider>
      <CaseTimelineInner {...props} />
    </ReactFlowProvider>
  );
}

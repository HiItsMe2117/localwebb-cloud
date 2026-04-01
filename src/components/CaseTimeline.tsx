import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import { useNodesState, useEdgesState, ReactFlowProvider, useReactFlow } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import { Plus, X, Loader2, Link2, Trash2, MousePointerClick, Map as MapIcon, Maximize2, Minimize2, Database, ChevronDown, ChevronUp, Check, Send, ExternalLink, Sparkles } from 'lucide-react';
import NexusCanvas from './NexusCanvas';
import EventNode, { EVENT_CATEGORIES } from './EventNode';
import axios from 'axios';

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

  // Research panel
  const [showResearch, setShowResearch] = useState(false);
  const [researchQuery, setResearchQuery] = useState('');
  const [isResearching, setIsResearching] = useState(false);
  const [researchMessages, setResearchMessages] = useState<{ role: 'user' | 'assistant'; content: string; events?: { title: string; date: string | null; description: string; category: string }[]; webSources?: { title: string; uri: string; domain: string }[] }[]>([]);
  const [addingEventIndex, setAddingEventIndex] = useState<string | null>(null);
  const researchEndRef = useRef<HTMLDivElement>(null);

  // UI
  const [showMiniMap, setShowMiniMap] = useState(() => window.innerWidth >= 768);
  const [isFullscreen, setIsFullscreen] = useState(false);
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

  const loadTimeline = useCallback(async () => {
    try {
      const res = await axios.get(`/api/cases/${caseId}/timeline`);
      setNodes(res.data.nodes || []);
      setEdges(res.data.edges || []);
    } catch (err: any) {
      console.error('Failed to load timeline:', err);
      const status = err?.response?.status;
      if (status === 403) toast.error('Permission denied');
      else if (status === 401) toast.error('Session expired — please log in again');
      else toast.error('Failed to load timeline');
    } finally {
      setIsLoading(false);
    }
  }, [caseId, setNodes, setEdges]);

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

  // ── Display nodes with selection ───────────────────────────────────────────

  const displayNodes = useMemo(() =>
    nodes.map(n => ({ ...n, selected: selectedNodeIds.has(n.id) })),
    [nodes, selectedNodeIds]
  );

  // ── Node click: select or show context menu ────────────────────────────────

  const onNodeClick = useCallback((node: Node, event?: React.MouseEvent) => {
    if (event?.shiftKey || selectMode) {
      setSelectedNodeIds(prev => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      setContextEvent(null);
    } else {
      setContextEvent(prev => {
        const newNode = prev?.id === node.id ? null : node;
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
  }, [selectMode]);

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
      const res = await axios.post(`/api/cases/${caseId}/timeline/research`, {
        query,
        messages: researchMessages.map(m => ({ role: m.role, content: m.content })),
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
  }, [caseId, researchQuery, isResearching, researchMessages]);

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
      await loadTimeline();
      toast.success(`Added "${event.title}"`);
    } catch (err) {
      console.error('Failed to add event:', err);
      toast.error('Failed to add event');
    } finally {
      setAddingEventIndex(null);
    }
  }, [caseId, loadTimeline, getViewport]);

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
          </div>

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

      {/* Canvas + Research panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas */}
        <div className="flex-1 relative">
          <NexusCanvas
            nodes={displayNodes}
            edges={edges}
            onNodesChange={onNodesChange}
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

        {/* Research side panel */}
        {showResearch && (
          <div className="w-80 shrink-0 flex flex-col bg-[#0A0A0A] border-l border-[rgba(84,84,88,0.65)]">
            {/* Header */}
            <div className="shrink-0 px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)] flex items-center justify-between">
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
          <button
            onClick={toggleFullscreen}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] hover:text-white"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
          <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono">
            {nodes.length} {nodes.length === 1 ? 'event' : 'events'} · {edges.length} {edges.length === 1 ? 'connection' : 'connections'}
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

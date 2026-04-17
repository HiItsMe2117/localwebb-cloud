import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import { useNodesState, useEdgesState, ReactFlowProvider, useReactFlow } from 'reactflow';
import type { Node, Edge, Connection } from 'reactflow';
import { Search, Plus, Minus, X, Expand, Trash2, Loader2, Share2, Copy, Sparkles, Send, Link2, MessageCircle, FileText, Check, MousePointerClick, Map as MapIcon, ChevronDown, ChevronUp, Circle, Lasso, RotateCw, RotateCcw, Maximize2, Minimize2, Bot, AlertTriangle, Globe, Database, StickyNote, Paperclip, ExternalLink, Network } from 'lucide-react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';
import NexusCanvas from './NexusCanvas';
import EdgeEvidencePanel from './EdgeEvidencePanel';
import axios from 'axios';
import useIsMobile from '../hooks/useIsMobile';
import type { WebSource } from '../types';

interface CaseNetworkMapProps {
  caseId: string;
  caseEntities?: string[];
  readOnly?: boolean;
}

interface SearchResult {
  id: string;
  label: string;
  type: string;
  degree: number;
}

interface Neighbor {
  id: string;
  label: string;
  type: string;
  degree: number;
  relationships: string[];
}

interface GroupData {
  id: string;
  label: string;
  color: string;
  node_ids: string[];
}

const GROUP_COLORS = ['#007AFF', '#FF9500', '#AF52DE', '#30D158', '#FF453A', '#5AC8FA', '#FFD60A', '#FF375F'];

const TYPE_COLORS: Record<string, string> = {
  PERSON: '#60a5fa',
  ORGANIZATION: '#fbbf24',
  LOCATION: '#4ade80',
  EVENT: '#a78bfa',
  DOCUMENT: '#fb923c',
  FINANCIAL_ENTITY: '#f87171',
};

function CaseNetworkMapInner({ caseId, caseEntities = [], readOnly = false }: CaseNetworkMapProps) {
  const isMobile = useIsMobile();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Suggested entities from the case
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [isAddingSuggestions, setIsAddingSuggestions] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Expand state
  const [expandNode, setExpandNode] = useState<Node | null>(null);
  const [neighbors, setNeighbors] = useState<Neighbor[]>([]);
  const [selectedNeighbors, setSelectedNeighbors] = useState<Set<string>>(new Set());
  const [isExpanding, setIsExpanding] = useState(false);
  const [isAddingNeighbors, setIsAddingNeighbors] = useState(false);

  // Node selection + context menu
  const [selectMode, setSelectMode] = useState(false);
  const [lassoMode, setLassoMode] = useState(false);
  const [lassoPoints, setLassoPoints] = useState<{ x: number; y: number }[]>([]);
  const [isDrawingLasso, setIsDrawingLasso] = useState(false);
  const lassoRef = useRef<HTMLDivElement>(null);
  const [showMiniMap, setShowMiniMap] = useState(() => window.innerWidth >= 768);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [contextNode, setContextNode] = useState<Node | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);

  // Analysis + chat state
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisShared, setAnalysisShared] = useState<{ label: string; type: string; connected_to: string[] }[]>([]);
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string, webSources?: WebSource[] }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const analysisNodeIds = useRef<string[]>([]);

  // Edge linking state
  const [isLinking, setIsLinking] = useState(false);
  const [linkLabel, setLinkLabel] = useState('');

  // Create custom entity state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newEntityLabel, setNewEntityLabel] = useState('');
  const [newEntityType, setNewEntityType] = useState('PERSON');
  const [isCreatingEntity, setIsCreatingEntity] = useState(false);

  // Groups state
  const [groups, setGroups] = useState<GroupData[]>([]);
  const [editingGroup, setEditingGroup] = useState<GroupData | null>(null);
  const [groupLabel, setGroupLabel] = useState('');

  // Case chat (general AI chat about the whole case)
  const [caseChatOpen, setCaseChatOpen] = useState(false);
  const [caseChatMessages, setCaseChatMessages] = useState<{ role: 'user' | 'assistant', content: string, webSources?: WebSource[] }[]>([]);
  const [caseChatInput, setCaseChatInput] = useState('');
  const [isCaseChatting, setIsCaseChatting] = useState(false);
  const [caseChatMode, setCaseChatMode] = useState<'files_only' | 'files_web'>('files_only');
  const caseChatEndRef = useRef<HTMLDivElement>(null);

  // Per-node scale overrides
  const [nodeScales, setNodeScales] = useState<Record<string, number>>({});

  // Description panel state
  const [descriptionNode, setDescriptionNode] = useState<Node | null>(null);
  const [descriptionText, setDescriptionText] = useState('');
  const [isSavingDescription, setIsSavingDescription] = useState(false);
  const [descriptionSaved, setDescriptionSaved] = useState(false);

  // Evidence panel state (Phase 1)
  const [evidenceEdge, setEvidenceEdge] = useState<Edge | null>(null);

  // Research panel
  const [showResearch, setShowResearch] = useState(false);
  const [researchQuery, setResearchQuery] = useState('');
  const [isResearching, setIsResearching] = useState(false);
  const [researchMessages, setResearchMessages] = useState<{ role: 'user' | 'assistant'; content: string; entities?: { name: string; type: string; description: string; suggested_group: string | null }[]; webSources?: WebSource[] }[]>([]);
  const researchEndRef = useRef<HTMLDivElement>(null);
  const [addingEntityIdx, setAddingEntityIdx] = useState<string | null>(null);

  // Viewport persistence
  const viewportKey = `case-map-viewport-${caseId}`;
  const hasSavedViewport = useRef(false);
  const viewportSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Semantic layout state (Phase 4)
  const [layoutMode, setLayoutMode] = useState<'manual' | 'semantic'>('manual');
  const [isComputingLayout, setIsComputingLayout] = useState(false);
  const savedPositions = useRef<Record<string, { x: number; y: number }>>({});

  // Multi-case overlay: load child cases' graphs merged together
  const [showChildGraphs, setShowChildGraphs] = useState(false);
  const [childCases, setChildCases] = useState<{ id: string; title: string }[]>([]);
  const [isLoadingChildren, setIsLoadingChildren] = useState(false);
  const [baseNodes, setBaseNodes] = useState<Node[]>([]);
  const [baseEdges, setBaseEdges] = useState<Edge[]>([]);

  const toggleChildGraphs = useCallback(async () => {
    if (showChildGraphs) {
      // Revert to base graph
      setShowChildGraphs(false);
      setNodes(baseNodes);
      setEdges(baseEdges);
      setChildCases([]);
      return;
    }
    setIsLoadingChildren(true);
    try {
      // Save current state as base
      setBaseNodes([...nodes]);
      setBaseEdges([...edges]);
      const res = await axios.get(`/api/cases/${caseId}/children/graph`);
      if (!res.data.child_cases?.length) {
        toast('No child cases found');
        setIsLoadingChildren(false);
        return;
      }
      setChildCases(res.data.child_cases);
      setNodes(res.data.nodes || []);
      setEdges(res.data.edges || []);
      setShowChildGraphs(true);
    } catch (err) {
      console.error('Failed to load child graphs:', err);
      toast.error('Failed to load child case graphs');
    } finally {
      setIsLoadingChildren(false);
    }
  }, [showChildGraphs, caseId, nodes, edges, baseNodes, baseEdges, setNodes, setEdges]);

  // Track pinned node IDs for quick lookups
  const pinnedIds = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);

  // Calculate positions for new nodes — spread around the center of existing nodes
  const getNewNodePositions = useCallback((newIds: string[], anchorNodeId?: string) => {
    const positions: Record<string, { x: number; y: number }> = {};
    let cx = 0, cy = 0;
    if (anchorNodeId) {
      const anchor = nodes.find(n => n.id === anchorNodeId);
      if (anchor) { cx = anchor.position.x; cy = anchor.position.y; }
    } else if (nodes.length > 0) {
      for (const n of nodes) { cx += n.position.x; cy += n.position.y; }
      cx /= nodes.length;
      cy /= nodes.length;
    }
    const radius = 150 + newIds.length * 20;
    newIds.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / newIds.length - Math.PI / 2;
      positions[id] = {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      };
    });
    return positions;
  }, [nodes]);

  // Group lookup: node ID → group
  const nodeGroupMap = useMemo(() => {
    const map = new Map<string, GroupData>();
    for (const g of groups) {
      for (const nid of g.node_ids) map.set(nid, g);
    }
    return map;
  }, [groups]);

  // Apply selection styling, uniform sizing, and per-node scale to nodes
  // Copy selected node details
  const copySelectedNodes = useCallback(async () => {
    const selected = nodes.filter(n => selectedNodeIds.has(n.id));
    const text = selected.map(n => {
      const type = (n.data?.entityType || 'UNKNOWN').toUpperCase();
      const desc = n.data?.description ? `\n${n.data.description}` : '';
      return `${n.data?.label} (${type})${desc}`;
    }).join('\n\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [nodes, selectedNodeIds]);

  const clearSelection = useCallback(() => {
    setSelectedNodeIds(new Set());
    setContextNode(null);
    setCopied(false);
    setSelectMode(false);
    setAnalysisResult(null);
    setAnalysisShared([]);
    setChatMessages([]);
    setChatInput('');
    setLinkLabel('');
    setDescriptionNode(null);
    setEdges(eds => eds.map(e => ({ ...e, selected: false })));
  }, [setEdges]);

  // Lasso: convert screen coords to flow coords and select enclosed nodes
  const { getViewport, setViewport, fitView } = useReactFlow();

  const lassoScreenToFlow = useCallback((screenX: number, screenY: number) => {
    const bounds = lassoRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    const { x: vx, y: vy, zoom } = getViewport();
    return {
      x: (screenX - bounds.left - vx) / zoom,
      y: (screenY - bounds.top - vy) / zoom,
    };
  }, [getViewport]);

  const onLassoDown = useCallback((e: React.PointerEvent) => {
    if (!lassoMode || e.button !== 0) return;
    e.preventDefault();
    const pt = lassoScreenToFlow(e.clientX, e.clientY);
    setLassoPoints([pt]);
    setIsDrawingLasso(true);
  }, [lassoMode, lassoScreenToFlow]);

  const onLassoMove = useCallback((e: React.PointerEvent) => {
    if (!isDrawingLasso) return;
    const pt = lassoScreenToFlow(e.clientX, e.clientY);
    setLassoPoints(prev => [...prev, pt]);
  }, [isDrawingLasso, lassoScreenToFlow]);

  const onLassoUp = useCallback(() => {
    if (!isDrawingLasso) return;
    setIsDrawingLasso(false);

    // Point-in-polygon (ray casting) to find enclosed nodes
    const poly = lassoPoints;
    if (poly.length < 3) { setLassoPoints([]); return; }

    const inside = (px: number, py: number) => {
      let count = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const yi = poly[i].y, yj = poly[j].y;
        const xi = poly[i].x, xj = poly[j].x;
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
          count++;
        }
      }
      return count % 2 === 1;
    };

    const selected = new Set<string>();
    for (const n of nodes) {
      // Use node center (offset by approximate node width/height)
      if (inside(n.position.x + 60, n.position.y + 25)) {
        selected.add(n.id);
      }
    }

    if (selected.size > 0) {
      setSelectedNodeIds(selected);
      setSelectMode(true);
    }
    setLassoPoints([]);
  }, [isDrawingLasso, lassoPoints, nodes]);

  const analyzeSelected = useCallback(async () => {
    if (selectedNodeIds.size < 2) return;
    setIsAnalyzing(true);
    setAnalysisResult(null);
    setAnalysisShared([]);
    setChatMessages([]);
    const ids = Array.from(selectedNodeIds);
    analysisNodeIds.current = ids;
    try {
      const res = await axios.post(`/api/cases/${caseId}/graph/analyze`, { node_ids: ids });
      const analysis = res.data.analysis || 'No analysis returned.';
      setAnalysisResult(analysis);
      setAnalysisShared(res.data.shared_neighbors || []);

      const messages: { role: 'user' | 'assistant'; content: string }[] = [
        { role: 'assistant', content: analysis },
      ];

      // If the backend found follow-up leads, add them as a second message
      if (res.data.follow_up) {
        const newEntities = res.data.new_entities_found || 0;
        const searchTerms = res.data.search_terms || [];
        const prefix = newEntities > 0
          ? `I searched the graph for ${searchTerms.slice(0, 3).map((t: string) => `"${t}"`).join(', ')}${searchTerms.length > 3 ? ` and ${searchTerms.length - 3} more` : ''} and found ${newEntities} additional ${newEntities === 1 ? 'entity' : 'entities'}.\n\n`
          : '';
        messages.push({ role: 'assistant', content: prefix + res.data.follow_up });
      }

      setChatMessages(messages);
    } catch (err) {
      console.error('Analysis failed:', err);
      toast.error('Analysis failed');
      setAnalysisResult('Analysis failed. Please try again.');
    } finally {
      setIsAnalyzing(false);
    }
  }, [caseId, selectedNodeIds]);

  const sendChatMessage = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg || isChatting) return;
    const newMessages = [...chatMessages, { role: 'user' as const, content: msg }];
    setChatMessages(newMessages);
    setChatInput('');
    setIsChatting(true);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    try {
      const res = await axios.post(`/api/cases/${caseId}/graph/chat`, {
        node_ids: analysisNodeIds.current,
        messages: newMessages,
        mode: caseChatMode,
      });
      setChatMessages(prev => [...prev, { role: 'assistant', content: res.data.response, webSources: res.data.web_sources }]);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err) {
      console.error('Chat failed:', err);
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Failed to get a response. Try again.' }]);
    } finally {
      setIsChatting(false);
    }
  }, [caseId, chatInput, chatMessages, isChatting, caseChatMode]);

  // Case-level chat send
  const sendCaseChatMessage = useCallback(async () => {
    const msg = caseChatInput.trim();
    if (!msg || isCaseChatting) return;
    const newMessages = [...caseChatMessages, { role: 'user' as const, content: msg }];
    setCaseChatMessages(newMessages);
    setCaseChatInput('');
    setIsCaseChatting(true);
    setTimeout(() => caseChatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    try {
      const res = await axios.post(`/api/cases/${caseId}/graph/case-chat`, {
        messages: newMessages,
        mode: caseChatMode
      });
      setCaseChatMessages(prev => [...prev, { role: 'assistant', content: res.data.response, webSources: res.data.web_sources }]);
      setTimeout(() => caseChatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    } catch (err) {
      console.error('Case chat failed:', err);
      setCaseChatMessages(prev => [...prev, { role: 'assistant', content: 'Failed to get a response. Try again.' }]);
    } finally {
      setIsCaseChatting(false);
    }
  }, [caseId, caseChatInput, caseChatMessages, isCaseChatting, caseChatMode]);

  // Research panel: AI-powered web search for investigation
  const sendResearch = useCallback(async () => {
    const query = researchQuery.trim();
    if (!query || isResearching) return;

    const userMsg = { role: 'user' as const, content: query };
    setResearchMessages(prev => [...prev, userMsg]);
    setResearchQuery('');
    setIsResearching(true);
    setTimeout(() => researchEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

    try {
      const res = await axios.post(`/api/cases/${caseId}/graph/research`, {
        query,
        messages: researchMessages.map(m => ({ role: m.role, content: m.content })),
      });

      const assistantMsg = {
        role: 'assistant' as const,
        content: res.data.narrative || res.data.response || 'No results found.',
        entities: res.data.entities || [],
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

  // Filter out ReactFlow's built-in select changes — we manage selection ourselves
  const handleNodesChange = useCallback((changes: any[]) => {
    const filtered = changes.filter((c: any) => c.type !== 'select');
    if (filtered.length > 0) onNodesChange(filtered);
  }, [onNodesChange]);

  // Load the case subgraph
  const loadGraph = useCallback(async () => {
    try {
      const res = await axios.get(`/api/cases/${caseId}/graph`);
      const loadedNodes: Node[] = res.data.nodes || [];
      const loadedEdges: Edge[] = res.data.edges || [];
      setGroups(res.data.groups || []);

      // Auto-layout if most nodes are stacked at origin
      const atOrigin = loadedNodes.filter(n => Math.abs(n.position.x) < 1 && Math.abs(n.position.y) < 1).length;
      if (loadedNodes.length > 0 && atOrigin >= loadedNodes.length * 0.3) {
        // Run D3 force simulation inline
        const simNodes = loadedNodes.map(n => ({ id: n.id, x: Math.random() * 800 - 400, y: Math.random() * 800 - 400 }));
        const simEdges = loadedEdges.map(e => ({ source: e.source, target: e.target }));
        const radius = Math.sqrt(loadedNodes.length) * 80;
        const sim = forceSimulation(simNodes as any)
          .force('link', forceLink(simEdges as any).id((d: any) => d.id).distance(250))
          .force('charge', forceManyBody().strength(-2000))
          .force('center', forceCenter(0, 0).strength(0.05))
          .force('collide', forceCollide(60))
          .stop();
        for (let i = 0; i < 300; i++) sim.tick();
        const posMap = new Map(simNodes.map(n => [n.id, { x: n.x, y: n.y }]));
        const laid = loadedNodes.map(n => {
          const p = posMap.get(n.id);
          return p ? { ...n, position: { x: p.x, y: p.y } } : n;
        });
        setNodes(laid);
        setEdges(loadedEdges);
        // Persist positions
        const updates = laid.map(n => ({ node_id: n.id, x: n.position.x, y: n.position.y }));
        axios.post(`/api/cases/${caseId}/graph/positions`, { positions: updates }).catch(() => {});
      } else {
        setNodes(loadedNodes);
        setEdges(loadedEdges);
      }
    } catch (err: any) {
      console.error('Failed to load case graph:', err);
      const status = err?.response?.status;
      if (status === 403) {
        toast.error('Permission denied — try refreshing the page');
      } else if (status === 401) {
        toast.error('Session expired — please log in again');
      } else {
        toast.error('Failed to load network map');
      }
    } finally {
      setIsLoading(false);
    }
  }, [caseId, setNodes, setEdges]);

  // Edge click: open evidence panel for any edge
  const onEdgeClick = useCallback((edge: Edge) => {
    setEvidenceEdge(edge);
    setContextNode(null);
    setExpandNode(null);
    setEditingGroup(null);
    setDescriptionNode(null);
  }, []);

  // Reconnect: drag a case-local edge endpoint to a different node
  const handleEdgeUpdate = useCallback(async (oldEdge: Edge, newConnection: Connection) => {
    if (!oldEdge.data?.isCaseLocal) return;
    if (!newConnection.source || !newConnection.target) return;
    if (newConnection.source === newConnection.target) return;
    try {
      const label = (oldEdge.label as string) || '';
      await axios.delete(`/api/cases/${caseId}/graph/edges/${oldEdge.id}`);
      await axios.post(`/api/cases/${caseId}/graph/edges`, {
        source_node_id: newConnection.source,
        target_node_id: newConnection.target,
        label,
      });
      await loadGraph();
    } catch (err) {
      console.error('Failed to reconnect edge:', err);
      await loadGraph();
    }
  }, [caseId, loadGraph]);

  // Drag edge label along the connection line
  const onEdgeLabelDrag = useCallback((edgeId: string, labelPosition: number) => {
    setEdges(eds => eds.map(e =>
      e.id === edgeId ? { ...e, data: { ...e.data, labelPosition } } : e
    ));
  }, [setEdges]);

  const onEdgeLabelDragEnd = useCallback((edgeId: string) => {
    const edge = edges.find(e => e.id === edgeId);
    if (!edge?.data?.isCaseLocal) return;
    const pos = edge.data?.labelPosition ?? 0.5;
    axios.patch(`/api/cases/${caseId}/graph/edges/${edgeId}`, {
      label_position: pos,
    }).catch(err => console.error('Failed to save label position:', err));
  }, [edges, caseId]);

  // Link two selected entities with a case-local edge
  const linkSelectedNodes = useCallback(async (isHypothesis = false) => {
    if (selectedNodeIds.size !== 2) return;
    setIsLinking(true);
    const [sourceId, targetId] = Array.from(selectedNodeIds);
    try {
      await axios.post(`/api/cases/${caseId}/graph/edges`, {
        source_node_id: sourceId,
        target_node_id: targetId,
        label: linkLabel,
        is_hypothesis: isHypothesis,
      });
      setLinkLabel('');
      await loadGraph();
      clearSelection();
    } catch (err) {
      console.error('Failed to create edge:', err);
      toast.error('Failed to create connection');
    } finally {
      setIsLinking(false);
    }
  }, [caseId, selectedNodeIds, linkLabel, loadGraph, clearSelection]);

  // Create a custom case-local entity
  const createCustomNode = useCallback(async () => {
    const label = newEntityLabel.trim();
    if (!label) return;
    setIsCreatingEntity(true);
    try {
      await axios.post(`/api/cases/${caseId}/graph/custom-nodes`, {
        label,
        type: newEntityType,
      });
      setShowCreateForm(false);
      setNewEntityLabel('');
      setNewEntityType('PERSON');
      await loadGraph();
    } catch (err) {
      console.error('Failed to create custom entity:', err);
      toast.error('Failed to create entity');
    } finally {
      setIsCreatingEntity(false);
    }
  }, [caseId, newEntityLabel, newEntityType, loadGraph]);

  // --- Sticky Notes ---
  const [isCreatingSticky, setIsCreatingSticky] = useState(false);

  const createStickyNote = useCallback(async () => {
    setIsCreatingSticky(true);
    try {
      const { x, y, zoom } = getViewport();
      const centerX = (-x + window.innerWidth / 2) / zoom;
      const centerY = (-y + window.innerHeight / 2) / zoom;
      await axios.post(`/api/cases/${caseId}/graph/sticky-notes`, {
        position_x: centerX,
        position_y: centerY,
      });
      await loadGraph();
    } catch (err) {
      console.error('Failed to create sticky note:', err);
      toast.error('Failed to create note');
    } finally {
      setIsCreatingSticky(false);
    }
  }, [caseId, loadGraph, getViewport]);

  const updateStickyNote = useCallback(async (noteId: string, updates: Record<string, any>) => {
    // Optimistically update local node state so the sticky note reflects changes
    // immediately without waiting on a full graph reload. Without this, the blur
    // effect in StickyNoteNode resets localContent back to the stale content prop.
    setNodes(prev => prev.map(n => {
      if (n.id !== noteId || n.type !== 'stickyNote') return n;
      const dataPatch: Record<string, any> = {};
      if ('content' in updates) dataPatch.content = updates.content;
      if ('color' in updates) dataPatch.color = updates.color;
      if ('width' in updates) dataPatch.noteWidth = updates.width;
      if ('height' in updates) dataPatch.noteHeight = updates.height;
      const stylePatch: Record<string, any> = {};
      if ('width' in updates) stylePatch.width = updates.width;
      if ('height' in updates) stylePatch.height = updates.height;
      return {
        ...n,
        data: { ...n.data, ...dataPatch },
        ...(Object.keys(stylePatch).length ? { style: { ...n.style, ...stylePatch } } : {}),
      };
    }));
    try {
      await axios.patch(`/api/cases/${caseId}/graph/sticky-notes/${noteId}`, updates);
    } catch (err) {
      console.error('Failed to update sticky note:', err);
    }
  }, [caseId, setNodes]);

  const deleteStickyNote = useCallback(async (noteId: string) => {
    try {
      await axios.delete(`/api/cases/${caseId}/graph/sticky-notes/${noteId}`);
      await loadGraph();
    } catch (err) {
      console.error('Failed to delete sticky note:', err);
      toast.error('Failed to delete note');
    }
  }, [caseId, loadGraph]);

  const uploadStickyMedia = useCallback(async (noteId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      await axios.post(
        `/api/cases/${caseId}/graph/sticky-notes/${noteId}/media`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      await loadGraph();
    } catch (err) {
      console.error('Failed to upload media:', err);
      toast.error('Failed to upload file');
    }
  }, [caseId, loadGraph]);

  const deleteStickyMedia = useCallback(async (noteId: string, mediaId: string) => {
    try {
      await axios.delete(`/api/cases/${caseId}/graph/sticky-notes/${noteId}/media/${mediaId}`);
      await loadGraph();
    } catch (err) {
      console.error('Failed to delete media:', err);
    }
  }, [caseId, loadGraph]);

  // --- Entity Documents ---
  interface EntityDoc { id: string; url: string; note: string; created_at: string; }
  const [entityDocs, setEntityDocs] = useState<EntityDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [showAttachForm, setShowAttachForm] = useState(false);
  const [attachUrl, setAttachUrl] = useState('');
  const [attachNote, setAttachNote] = useState('');
  const [attachSaving, setAttachSaving] = useState(false);

  // Convert GCS signed URLs to permanent DOJ source links
  const normalizeDocUrl = useCallback((url: string) => {
    const gcsMatch = url.match(/storage\.googleapis\.com\/[^/]+\/uploads\/dataset-(\d+)\/([^?]+)/);
    if (gcsMatch) {
      const dataset = gcsMatch[1];
      const filename = gcsMatch[2];
      return `https://www.justice.gov/epstein/files/DataSet%20${dataset}/${encodeURIComponent(decodeURIComponent(filename))}`;
    }
    return url;
  }, []);

  const fetchEntityDocs = useCallback(async (nodeId: string) => {
    setDocsLoading(true);
    try {
      const res = await axios.get(`/api/cases/${caseId}/graph/entities/${nodeId}/documents`);
      setEntityDocs(res.data.documents || []);
    } catch {
      setEntityDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }, [caseId]);

  const attachDocument = useCallback(async (nodeId: string) => {
    if (!attachUrl.trim()) return;
    setAttachSaving(true);
    try {
      await axios.post(`/api/cases/${caseId}/graph/entities/${nodeId}/documents`, {
        url: attachUrl.trim(),
        note: attachNote.trim(),
      });
      setAttachUrl('');
      setAttachNote('');
      setShowAttachForm(false);
      await fetchEntityDocs(nodeId);
    } catch {
      toast.error('Failed to attach document');
    } finally {
      setAttachSaving(false);
    }
  }, [caseId, attachUrl, attachNote, fetchEntityDocs]);

  const detachDocument = useCallback(async (nodeId: string, docId: string) => {
    try {
      await axios.delete(`/api/cases/${caseId}/graph/entities/${nodeId}/documents/${docId}`);
      setEntityDocs(prev => prev.filter(d => d.id !== docId));
    } catch {
      toast.error('Failed to remove document');
    }
  }, [caseId]);

  const displayNodes = useMemo(() =>
    nodes.map(n => {
      if (n.type === 'stickyNote') {
        return {
          ...n,
          data: {
            ...n.data,
            caseId,
            onUpdate: updateStickyNote,
            onDelete: deleteStickyNote,
            onMediaUpload: uploadStickyMedia,
            onMediaDelete: deleteStickyMedia,
          },
          selected: selectedNodeIds.has(n.id),
        };
      }
      return {
        ...n,
        data: { ...n.data, degree: 10, scale: nodeScales[n.id] ?? 1 },
        selected: selectedNodeIds.has(n.id),
      };
    }),
    [nodes, selectedNodeIds, nodeScales, caseId, updateStickyNote, deleteStickyNote, uploadStickyMedia, deleteStickyMedia]
  );

  // Check for saved viewport on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(viewportKey);
      if (saved) {
        hasSavedViewport.current = true;
      }
    } catch {}
  }, [viewportKey]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // Restore saved viewport after initial graph load
  useEffect(() => {
    if (isLoading || nodes.length === 0) return;
    if (!hasSavedViewport.current) {
      fitView({ padding: 0.3, duration: 800 });
      return;
    }
    try {
      const saved = localStorage.getItem(viewportKey);
      if (saved) {
        const vp = JSON.parse(saved);
        setViewport(vp, { duration: 0 });
      }
    } catch {
      fitView({ padding: 0.3, duration: 800 });
    }
    // Only run once after initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  // Save viewport on pan/zoom (debounced)
  const onMoveEnd = useCallback((_event: any, viewport: { x: number; y: number; zoom: number }) => {
    clearTimeout(viewportSaveTimer.current);
    viewportSaveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(viewportKey, JSON.stringify(viewport));
        hasSavedViewport.current = true;
      } catch {}
    }, 300);
  }, [viewportKey]);

  // Load suggested entities from case when graph is empty
  useEffect(() => {
    if (isLoading || nodes.length > 0 || caseEntities.length === 0) return;
    setIsLoadingSuggestions(true);
    // Fetch details for each case entity via search (handles underscore IDs)
    Promise.all(
      caseEntities.slice(0, 10).map(async (entityId) => {
        try {
          const label = entityId.replace(/_/g, ' ');
          const res = await axios.get(`/api/nodes/search?q=${encodeURIComponent(label)}`);
          const results = res.data.results || [];
          // Best match: exact ID match, else first result
          return results.find((r: SearchResult) => r.id === entityId) || results[0] || null;
        } catch {
          return null;
        }
      })
    ).then((results) => {
      const unique = new Map<string, SearchResult>();
      for (const r of results) {
        if (r && !unique.has(r.id)) unique.set(r.id, r);
      }
      setSuggestions(Array.from(unique.values()));
      setIsLoadingSuggestions(false);
    });
  }, [isLoading, nodes.length, caseEntities]);

  // Add all suggested entities at once
  const addSuggestions = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setIsAddingSuggestions(true);
    try {
      const positions = getNewNodePositions(ids);
      await axios.post(`/api/cases/${caseId}/graph/entities`, { node_ids: ids, positions });
      setSuggestions([]);
      await loadGraph();
    } catch (err) {
      console.error('Failed to add suggested entities:', err);
    } finally {
      setIsAddingSuggestions(false);
    }
  }, [caseId, loadGraph, getNewNodePositions]);

  // Fullscreen toggle
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

  // Close dropdowns on outside click/tap
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as HTMLElement)) {
        setSearchResults([]);
      }
      if (contextRef.current && !contextRef.current.contains(e.target as HTMLElement)) {
        setContextNode(null);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  // Debounced entity search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await axios.get(`/api/nodes/search?q=${encodeURIComponent(searchQuery.trim())}`);
        // Filter out already-pinned nodes
        setSearchResults((res.data.results || []).filter((r: SearchResult) => !pinnedIds.has(r.id)));
        setSearchIndex(0);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 250);
  }, [searchQuery, pinnedIds]);

  // Add entity from search
  const addEntity = useCallback(async (result: SearchResult) => {
    setSearchQuery('');
    setSearchResults([]);
    try {
      const positions = getNewNodePositions([result.id]);
      await axios.post(`/api/cases/${caseId}/graph/entities`, { node_ids: [result.id], positions });
      await loadGraph();
    } catch (err) {
      console.error('Failed to add entity:', err);
      toast.error('Failed to add entity');
    }
  }, [caseId, loadGraph, getNewNodePositions]);

  // Node click: plain click → context menu (expand/remove). Shift+click or select mode → toggle multi-select.
  const onNodeClick = useCallback((node: Node, event?: React.MouseEvent) => {
    if (event?.shiftKey || selectMode) {
      // Shift+click or select mode: toggle selection
      setSelectedNodeIds(prev => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      setCopied(false);
      setContextNode(null);
    } else {
      // Plain click: show context menu for this node
      setContextNode(prev => {
        const newNode = prev?.id === node.id ? null : node;
        if (newNode && !newNode.data?.isStickyNote) {
          fetchEntityDocs(newNode.id);
          setShowAttachForm(false);
        }
        return newNode;
      });
      setSelectedNodeIds(new Set());
      setCopied(false);
      setExpandNode(null);
      setNeighbors([]);
      setSelectedNeighbors(new Set());
      setDescriptionNode(null);
      setEvidenceEdge(null);
    }
  }, [selectMode]);

  // Expand: fetch neighbors
  const handleExpand = useCallback(async (node: Node) => {
    setContextNode(null);
    setExpandNode(node);
    setIsExpanding(true);
    try {
      const res = await axios.get(`/api/cases/${caseId}/graph/expand/${node.id}`);
      setNeighbors(res.data.neighbors || []);
      setSelectedNeighbors(new Set());
    } catch (err) {
      console.error('Failed to expand node:', err);
    } finally {
      setIsExpanding(false);
    }
  }, [caseId]);

  // Add selected neighbors
  const addSelectedNeighbors = useCallback(async () => {
    if (selectedNeighbors.size === 0) return;
    setIsAddingNeighbors(true);
    try {
      const ids = Array.from(selectedNeighbors);
      const positions = getNewNodePositions(ids, expandNode?.id);
      await axios.post(`/api/cases/${caseId}/graph/entities`, { node_ids: ids, positions });
      setExpandNode(null);
      setNeighbors([]);
      setSelectedNeighbors(new Set());
      await loadGraph();
    } catch (err) {
      console.error('Failed to add neighbors:', err);
    } finally {
      setIsAddingNeighbors(false);
    }
  }, [caseId, selectedNeighbors, expandNode, loadGraph, getNewNodePositions]);

  // Remove entity (routes custom nodes to the custom-nodes endpoint)
  const handleRemove = useCallback(async (node: Node) => {
    setContextNode(null);
    try {
      if (node.data?.isStickyNote) {
        await axios.delete(`/api/cases/${caseId}/graph/sticky-notes/${node.id}`);
      } else if (node.data?.isCustom) {
        await axios.delete(`/api/cases/${caseId}/graph/custom-nodes/${node.id}`);
      } else {
        await axios.delete(`/api/cases/${caseId}/graph/entities/${node.id}`);
      }
      await loadGraph();
    } catch (err) {
      console.error('Failed to remove entity:', err);
      toast.error('Failed to remove');
    }
  }, [caseId, loadGraph]);

  // Chat about a single entity
  const chatAboutEntity = useCallback(async (node: Node) => {
    setContextNode(null);
    setAnalysisResult(null);
    setAnalysisShared([]);
    setChatMessages([]);
    setChatInput('');
    analysisNodeIds.current = [node.id];
    setIsAnalyzing(true);
    try {
      const initialMessage = { role: 'user' as const, content: `Tell me about ${node.data?.label} and their connections in the knowledge graph.` };
      const res = await axios.post(`/api/cases/${caseId}/graph/chat`, {
        node_ids: [node.id],
        messages: [initialMessage],
      });
      setChatMessages([
        initialMessage,
        { role: 'assistant', content: res.data.response },
      ]);
      setAnalysisResult(res.data.response);
    } catch (err) {
      console.error('Chat failed:', err);
      setChatMessages([{ role: 'assistant', content: 'Failed to start chat. Please try again.' }]);
      setAnalysisResult('Failed to start chat.');
    } finally {
      setIsAnalyzing(false);
    }
  }, [caseId]);

  // Open description panel for a node
  const openDescription = useCallback((node: Node) => {
    setContextNode(null);
    setDescriptionNode(node);
    setDescriptionText(node.data?.caseDescription || node.data?.description || '');
    setDescriptionSaved(false);
  }, []);

  // Save entity description
  const saveDescription = useCallback(async () => {
    if (!descriptionNode) return;
    setIsSavingDescription(true);
    try {
      await axios.patch(`/api/cases/${caseId}/graph/entities/${descriptionNode.id}/description`, {
        description: descriptionText,
      });
      // Update the node data locally so it persists without a full reload
      setNodes(prev => prev.map(n =>
        n.id === descriptionNode.id
          ? { ...n, data: { ...n.data, caseDescription: descriptionText } }
          : n
      ));
      setDescriptionSaved(true);
      setTimeout(() => setDescriptionSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save description:', err);
    } finally {
      setIsSavingDescription(false);
    }
  }, [caseId, descriptionNode, descriptionText, setNodes]);

  // Pin (promote) a global edge to case-local
  const pinEdge = useCallback(async (edge: Edge) => {
    try {
      const label = (edge.label as string) || edge.data?.predicate || '';
      await axios.post(`/api/cases/${caseId}/graph/edges`, {
        source_node_id: edge.source,
        target_node_id: edge.target,
        label,
      });
      setEvidenceEdge(null);
      await loadGraph();
    } catch (err) {
      console.error('Failed to pin edge:', err);
    }
  }, [caseId, loadGraph]);

  // Handle solidify from evidence panel
  const handleSolidify = useCallback(async () => {
    setEvidenceEdge(null);
    await loadGraph();
  }, [loadGraph]);

  // Semantic layout toggle
  const toggleSemanticLayout = useCallback(async () => {
    if (layoutMode === 'semantic') {
      // Restore manual positions
      setNodes(prev => prev.map(n => ({
        ...n,
        position: savedPositions.current[n.id] || n.position,
      })));
      setLayoutMode('manual');
      return;
    }

    // Save current positions
    nodes.forEach(n => {
      savedPositions.current[n.id] = { ...n.position };
    });

    setIsComputingLayout(true);
    try {
      const nodeIds = nodes.map(n => n.id);
      const nodeLabels = nodes.map(n => n.data?.label || n.id);

      const res = await axios.post(`/api/cases/${caseId}/graph/semantic-layout`, {
        node_ids: nodeIds,
        node_labels: nodeLabels,
      });

      const { similarities } = res.data;
      if (!similarities || similarities.length < 2) {
        toast.error('Not enough nodes for semantic layout');
        setIsComputingLayout(false);
        return;
      }

      // Build d3-force simulation
      const simNodes = nodeIds.map((id, i) => ({ id, index: i, x: nodes[i].position.x, y: nodes[i].position.y }));
      const simLinks: { source: number; target: number; distance: number }[] = [];

      for (let i = 0; i < similarities.length; i++) {
        for (let j = i + 1; j < similarities.length; j++) {
          const sim = similarities[i][j];
          if (sim > 0.3) {
            simLinks.push({ source: i, target: j, distance: Math.max(80, 400 * (1 - sim)) });
          }
        }
      }

      const simulation = forceSimulation(simNodes as any)
        .force('link', forceLink(simLinks as any).distance((d: any) => d.distance).strength(0.5))
        .force('charge', forceManyBody().strength(-200))
        .force('center', forceCenter(0, 0))
        .force('collide', forceCollide(80))
        .stop();

      for (let i = 0; i < 300; i++) simulation.tick();

      const posMap: Record<string, { x: number; y: number }> = {};
      (simNodes as any[]).forEach((sn: any) => { posMap[sn.id] = { x: sn.x, y: sn.y }; });

      setNodes(prev => prev.map(n => ({
        ...n,
        position: posMap[n.id] || n.position,
      })));
      setLayoutMode('semantic');
    } catch (err) {
      console.error('Semantic layout failed:', err);
      toast.error('Semantic layout failed');
    } finally {
      setIsComputingLayout(false);
    }
  }, [caseId, layoutMode, nodes, setNodes]);

  // Create a group from selected nodes
  const createGroup = useCallback(async () => {
    if (selectedNodeIds.size < 2) return;
    const ids = Array.from(selectedNodeIds);
    const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
    try {
      await axios.post(`/api/cases/${caseId}/graph/groups`, {
        label: '',
        color,
        node_ids: ids,
      });
      await loadGraph();
      clearSelection();
    } catch (err) {
      console.error('Failed to create group:', err);
      toast.error('Failed to create group');
    }
  }, [caseId, selectedNodeIds, groups.length, loadGraph, clearSelection]);

  // Update group (label, color, or members)
  const updateGroup = useCallback(async (groupId: string, updates: { label?: string; color?: string; node_ids?: string[] }) => {
    try {
      await axios.patch(`/api/cases/${caseId}/graph/groups/${groupId}`, updates);
      setGroups(prev => prev.map(g => g.id === groupId ? { ...g, ...updates } : g));
    } catch (err) {
      console.error('Failed to update group:', err);
    }
  }, [caseId]);

  // Delete a group
  const deleteGroup = useCallback(async (groupId: string) => {
    try {
      await axios.delete(`/api/cases/${caseId}/graph/groups/${groupId}`);
      setGroups(prev => prev.filter(g => g.id !== groupId));
      setEditingGroup(null);
    } catch (err) {
      console.error('Failed to delete group:', err);
    }
  }, [caseId]);

  // Add a suggested entity from research to the graph
  const addResearchEntity = useCallback(async (
    entity: { name: string; type: string; description: string; suggested_group: string | null },
    key: string,
    targetGroupId?: string
  ) => {
    setAddingEntityIdx(key);
    try {
      const res = await axios.post(`/api/cases/${caseId}/graph/custom-nodes`, {
        label: entity.name,
        type: entity.type,
      });
      const newNodeId = res.data.id;

      if (newNodeId && entity.description) {
        await axios.patch(`/api/cases/${caseId}/graph/entities/${newNodeId}/description`, {
          description: entity.description,
        });
      }

      if (targetGroupId && newNodeId) {
        const group = groups.find(g => g.id === targetGroupId);
        if (group) {
          await updateGroup(targetGroupId, { node_ids: [...group.node_ids, newNodeId] });
        }
      }

      await loadGraph();
      toast.success(`Added ${entity.name}`);
    } catch (err) {
      console.error('Failed to add research entity:', err);
      toast.error('Failed to add entity');
    } finally {
      setAddingEntityIdx(null);
    }
  }, [caseId, groups, updateGroup, loadGraph]);

  // Rotate a set of nodes by `degrees` around their centroid
  const rotateNodes = useCallback(async (nodeIds: string[], degrees: number) => {
    const rad = (degrees * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const positions: { node_id: string; x: number; y: number }[] = [];

    setNodes(prev => {
      const targets = prev.filter(n => nodeIds.includes(n.id));
      if (targets.length < 2) return prev;

      // Calculate centroid
      let cx = 0, cy = 0;
      for (const n of targets) { cx += n.position.x; cy += n.position.y; }
      cx /= targets.length;
      cy /= targets.length;

      return prev.map(n => {
        if (!nodeIds.includes(n.id)) return n;
        const dx = n.position.x - cx;
        const dy = n.position.y - cy;
        const newPos = {
          x: cx + dx * cos - dy * sin,
          y: cy + dx * sin + dy * cos,
        };
        positions.push({ node_id: n.id, x: newPos.x, y: newPos.y });
        return { ...n, position: newPos };
      });
    });

    // Save positions after state update
    setTimeout(async () => {
      if (positions.length > 0) {
        try {
          await axios.post(`/api/cases/${caseId}/graph/positions`, { positions });
        } catch (err) {
          console.error('Failed to save rotated positions:', err);
        }
      }
    }, 0);
  }, [caseId, setNodes]);

  // Track drag start for group dragging (hold Shift to move whole group)
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragWithGroup = useRef(false);

  const onNodeDragStart = useCallback((event: any, node: Node) => {
    dragStartPos.current = { x: node.position.x, y: node.position.y };
    dragWithGroup.current = event.shiftKey;
  }, []);

  // Save position on drag stop — hold Shift to move group siblings together
  const onNodeDragStop = useCallback(async (_: any, node: Node) => {
    // Skip saving positions in semantic layout mode
    if (layoutMode === 'semantic') return;

    const group = nodeGroupMap.get(node.id);
    const start = dragStartPos.current;
    const moveGroup = dragWithGroup.current;
    dragStartPos.current = null;
    dragWithGroup.current = false;

    if (group && start && moveGroup) {
      const dx = node.position.x - start.x;
      const dy = node.position.y - start.y;
      if (dx === 0 && dy === 0) return;

      const siblingIds = new Set(group.node_ids.filter(id => id !== node.id));

      // Move siblings and collect all positions in one pass
      const allPositions = [{ node_id: node.id, x: node.position.x, y: node.position.y }];
      setNodes(prev => prev.map(n => {
        if (siblingIds.has(n.id)) {
          const newPos = { x: n.position.x + dx, y: n.position.y + dy };
          allPositions.push({ node_id: n.id, x: newPos.x, y: newPos.y });
          return { ...n, position: newPos };
        }
        return n;
      }));

      try {
        await axios.post(`/api/cases/${caseId}/graph/positions`, { positions: allPositions });
      } catch (err) {
        console.error('Failed to save group positions:', err);
      }
    } else {
      try {
        await axios.post(`/api/cases/${caseId}/graph/positions`, {
          positions: [{ node_id: node.id, x: node.position.x, y: node.position.y }],
        });
      } catch (err) {
        console.error('Failed to save position:', err);
      }
    }
  }, [caseId, layoutMode, nodeGroupMap, setNodes]);

  // Group title drag — move all member nodes live
  const onGroupDrag = useCallback((group: { node_ids: string[] }, dx: number, dy: number) => {
    const ids = new Set(group.node_ids);
    setNodes(prev => prev.map(n =>
      ids.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n
    ));
  }, [setNodes]);

  // Group title drag end — save all member positions
  const onGroupDragEnd = useCallback(async (group: { node_ids: string[] }) => {
    const ids = new Set(group.node_ids);
    setNodes(prev => {
      const positions = prev
        .filter(n => ids.has(n.id))
        .map(n => ({ node_id: n.id, x: n.position.x, y: n.position.y }));
      if (positions.length > 0) {
        axios.post(`/api/cases/${caseId}/graph/positions`, { positions }).catch(err =>
          console.error('Failed to save group drag positions:', err)
        );
      }
      return prev;
    });
  }, [caseId, setNodes]);

  // Toggle neighbor selection
  const toggleNeighbor = (id: string) => {
    setSelectedNeighbors(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllNeighbors = () => {
    if (selectedNeighbors.size === neighbors.length) {
      setSelectedNeighbors(new Set());
    } else {
      setSelectedNeighbors(new Set(neighbors.map(n => n.id)));
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="text-[#007AFF] animate-spin" />
      </div>
    );
  }

  // Empty state (read-only: just show message)
  if (readOnly && nodes.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
        <Share2 size={28} className="text-[rgba(235,235,245,0.2)]" />
        <p className="text-[15px] font-semibold text-[rgba(235,235,245,0.6)]">No entities in this network map</p>
      </div>
    );
  }

  // Empty state
  if (nodes.length === 0 && !expandNode) {
    return (
      <div className="flex-1 flex flex-col">
        {/* Search bar */}
        <div className="px-4 py-3 border-b border-[rgba(84,84,88,0.65)]">
          <div ref={searchRef} className="relative">
            <div className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-2 rounded-xl border border-[rgba(84,84,88,0.65)] focus-within:border-[#007AFF] transition-colors">
              <Search size={14} className="text-[rgba(235,235,245,0.3)] shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSearchIndex(0); }}
                onKeyDown={e => {
                  if (e.key === 'Escape') { setSearchQuery(''); setSearchResults([]); }
                  if (!searchResults.length) return;
                  if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIndex(i => (i + 1) % searchResults.length); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIndex(i => (i - 1 + searchResults.length) % searchResults.length); }
                  if (e.key === 'Enter') { e.preventDefault(); addEntity(searchResults[searchIndex]); }
                }}
                placeholder="Search entities to add..."
                className="bg-transparent text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none w-full"
              />
              {isSearching && <Loader2 size={14} className="text-[rgba(235,235,245,0.3)] animate-spin" />}
            </div>
            {searchResults.length > 0 && <SearchDropdown results={searchResults} activeIndex={searchIndex} onSelect={addEntity} onHover={setSearchIndex} />}
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
          <div className="w-16 h-16 rounded-2xl bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center">
            <Share2 size={28} className="text-[rgba(235,235,245,0.2)]" />
          </div>
          <p className="text-[15px] font-semibold text-[rgba(235,235,245,0.6)]">No entities in this network map</p>
          <p className="text-[13px] text-[rgba(235,235,245,0.3)] max-w-[280px]">
            Search for an entity above to start building a focused network map for this case.
          </p>

          {/* Suggested entities from the case */}
          {isLoadingSuggestions ? (
            <div className="mt-4 flex items-center gap-2">
              <Loader2 size={14} className="text-[rgba(235,235,245,0.3)] animate-spin" />
              <span className="text-[12px] text-[rgba(235,235,245,0.3)]">Loading suggestions...</span>
            </div>
          ) : suggestions.length > 0 && (
            <div className="mt-5 w-full max-w-[340px]">
              <p className="text-[11px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider mb-2">
                Suggested from this case
              </p>
              <div className="flex flex-wrap gap-1.5 justify-center mb-3">
                {suggestions.map(s => {
                  const color = TYPE_COLORS[s.type.toUpperCase()] || '#9ca3af';
                  return (
                    <button
                      key={s.id}
                      onClick={() => addSuggestions([s.id])}
                      disabled={isAddingSuggestions}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] hover:border-[#007AFF]/50 transition-colors disabled:opacity-50"
                    >
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <span className="text-[12px] text-white font-medium">{s.label}</span>
                      <Plus size={10} className="text-[rgba(235,235,245,0.3)]" />
                    </button>
                  );
                })}
              </div>
              {suggestions.length > 1 && (
                <button
                  onClick={() => addSuggestions(suggestions.map(s => s.id))}
                  disabled={isAddingSuggestions}
                  className="flex items-center justify-center gap-2 mx-auto bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors"
                >
                  {isAddingSuggestions ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Plus size={14} />
                  )}
                  Add all {suggestions.length} entities
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden relative bg-black">
      {/* Search bar + create entity (admin only) */}
      {!readOnly && (
        <div className="shrink-0 px-4 py-3 border-b border-[rgba(84,84,88,0.65)] bg-black z-10">
          <div className="flex items-center gap-2">
            <div ref={searchRef} className="relative flex-1">
              <div className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-2 rounded-xl border border-[rgba(84,84,88,0.65)] focus-within:border-[#007AFF] transition-colors">
                <Search size={14} className="text-[rgba(235,235,245,0.3)] shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); setSearchIndex(0); }}
                  onKeyDown={e => {
                    if (e.key === 'Escape') { setSearchQuery(''); setSearchResults([]); }
                    if (!searchResults.length) return;
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIndex(i => (i + 1) % searchResults.length); }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIndex(i => (i - 1 + searchResults.length) % searchResults.length); }
                    if (e.key === 'Enter') { e.preventDefault(); addEntity(searchResults[searchIndex]); }
                  }}
                  placeholder="Search entities to add..."
                  className="bg-transparent text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none w-full"
                />
                {isSearching && <Loader2 size={14} className="text-[rgba(235,235,245,0.3)] animate-spin" />}
              </div>
              {searchResults.length > 0 && <SearchDropdown results={searchResults} activeIndex={searchIndex} onSelect={addEntity} onHover={setSearchIndex} />}
            </div>
            <button
              onClick={() => setShowCreateForm(prev => !prev)}
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                showCreateForm ? 'bg-[#007AFF] text-white' : 'bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.4)] hover:border-[#007AFF]'
              }`}
              title="Create custom entity"
            >
              <Plus size={16} />
            </button>
            <button
              onClick={createStickyNote}
              disabled={isCreatingSticky}
              className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.4)] hover:border-[#FBBF24]"
              title="Add sticky note"
            >
              {isCreatingSticky ? <Loader2 size={16} className="animate-spin" /> : <StickyNote size={16} />}
            </button>
            <button
              onClick={() => setShowResearch(prev => !prev)}
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                showResearch ? 'bg-[#FF9F0A] text-black' : 'bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.4)] hover:border-[#FF9F0A]'
              }`}
              title="Research"
            >
              <Sparkles size={16} />
            </button>
            <button
              onClick={toggleChildGraphs}
              disabled={isLoadingChildren}
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                showChildGraphs ? 'bg-[#30D158] text-black' : 'bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.4)] hover:border-[#30D158]'
              }`}
              title={showChildGraphs ? 'Hide child case graphs' : 'Show all child case graphs'}
            >
              {isLoadingChildren ? <Loader2 size={16} className="animate-spin" /> : <Network size={16} />}
            </button>
          </div>

          {showChildGraphs && childCases.length > 0 && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-[rgba(235,235,245,0.4)] font-medium">Showing:</span>
              <span className="text-[11px] bg-[#30D158]/20 text-[#30D158] px-2 py-0.5 rounded-full font-semibold">This case</span>
              {childCases.map(cc => (
                <span key={cc.id} className="text-[11px] bg-[#007AFF]/15 text-[#007AFF] px-2 py-0.5 rounded-full">
                  {cc.title.length > 25 ? cc.title.slice(0, 25) + '...' : cc.title}
                </span>
              ))}
            </div>
          )}

          {showCreateForm && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={newEntityLabel}
                onChange={e => setNewEntityLabel(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createCustomNode(); if (e.key === 'Escape') setShowCreateForm(false); }}
                placeholder="Entity name..."
                autoFocus
                className="flex-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-xl px-3 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors"
              />
              <select
                value={newEntityType}
                onChange={e => setNewEntityType(e.target.value)}
                className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl px-2 py-2 text-[12px] text-white focus:outline-none focus:border-[#007AFF] transition-colors appearance-none"
              >
                <option value="PERSON">Person</option>
                <option value="ORGANIZATION">Organization</option>
                <option value="LOCATION">Location</option>
                <option value="EVENT">Event</option>
                <option value="DOCUMENT">Document</option>
                <option value="FINANCIAL_ENTITY">Financial</option>
              </select>
              <button
                onClick={createCustomNode}
                disabled={!newEntityLabel.trim() || isCreatingEntity}
                className="bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 px-3 py-2 rounded-xl text-[13px] font-semibold transition-colors shrink-0"
              >
                {isCreatingEntity ? <Loader2 size={14} className="animate-spin" /> : 'Add'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ReactFlow canvas + research panel */}
      <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
      <div ref={lassoRef} className="flex-1 relative">
        <NexusCanvas
          nodes={displayNodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onEdgeUpdate={handleEdgeUpdate}
          onPaneClick={clearSelection}
          onMoveEnd={onMoveEnd}
          onGroupClick={(g) => { setEditingGroup(g); setGroupLabel(g.label); }}
          onGroupDrag={onGroupDrag}
          onGroupDragEnd={onGroupDragEnd}
          groups={groups}
          panOnDrag={!lassoMode}
          skipInitialFitView={hasSavedViewport.current}
          showEdgeLabels={false}
          showMiniMap={showMiniMap}
          onEdgeLabelDrag={onEdgeLabelDrag}
          onEdgeLabelDragEnd={onEdgeLabelDragEnd}
        />

        {/* Lasso drawing overlay */}
        {lassoMode && (
          <div
            className="absolute inset-0 z-10"
            style={{ cursor: 'crosshair', touchAction: 'none' }}
            onPointerDown={onLassoDown}
            onPointerMove={onLassoMove}
            onPointerUp={onLassoUp}
            onPointerLeave={onLassoUp}
          >
            {lassoPoints.length > 1 && (
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <g>
                  {(() => {
                    const { x: vx, y: vy, zoom } = getViewport();
                    const pts = lassoPoints.map(p => `${p.x * zoom + vx},${p.y * zoom + vy}`).join(' ');
                    return (
                      <>
                        <polygon
                          points={pts}
                          fill="rgba(0, 122, 255, 0.08)"
                          stroke="#007AFF"
                          strokeWidth={1.5}
                          strokeDasharray="6 3"
                          strokeLinejoin="round"
                        />
                      </>
                    );
                  })()}
                </g>
              </svg>
            )}
          </div>
        )}

        {/* Node context popover */}
        {contextNode && (
          <div
            ref={contextRef}
            className={
              isMobile
                ? "absolute bottom-0 left-0 right-0 rounded-t-2xl max-h-[60vh] bg-[#1C1C1E] border-t border-[rgba(84,84,88,0.65)] shadow-2xl overflow-hidden z-20"
                : "absolute top-3 right-3 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl overflow-hidden z-20 w-56"
            }
          >
            <div className="px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)]">
              <p className="text-[13px] font-semibold text-white truncate">
                {contextNode.data?.isStickyNote ? 'Sticky Note' : contextNode.data?.label}
              </p>
              {!contextNode.data?.isStickyNote && (
                <div className="flex items-center gap-1.5">
                  <p className="text-[10px] uppercase tracking-wider font-bold" style={{ color: TYPE_COLORS[(contextNode.data?.entityType || '').toUpperCase()] || '#9ca3af' }}>
                    {(contextNode.data?.entityType || 'unknown').toUpperCase()}
                  </p>
                  {contextNode.data?.isCustom && (
                    <span className="text-[8px] font-bold uppercase tracking-wider text-[rgba(235,235,245,0.3)]">CUSTOM</span>
                  )}
                </div>
              )}
            </div>
            {!contextNode.data?.isStickyNote && !contextNode.data?.isCustom && (
              <button
                onClick={() => handleExpand(contextNode)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[#2C2C2E] transition-colors"
              >
                <Expand size={14} className="text-[#007AFF]" />
                <span className="text-[13px] text-white">Expand neighbors</span>
              </button>
            )}
            {!contextNode.data?.isStickyNote && (
              <>
                <button
                  onClick={() => chatAboutEntity(contextNode)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[#2C2C2E] transition-colors"
                >
                  <MessageCircle size={14} className="text-[#AF52DE]" />
                  <span className="text-[13px] text-white">Chat about entity</span>
                </button>
                <button
                  onClick={() => openDescription(contextNode)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[#2C2C2E] transition-colors"
                >
                  <FileText size={14} className="text-[#30D158]" />
                  <span className="text-[13px] text-white">Description</span>
                </button>
              </>
            )}

            {/* Detach from group option */}
            {nodeGroupMap.has(contextNode.id) && (
              <button
                onClick={() => {
                  const group = nodeGroupMap.get(contextNode.id);
                  if (group) {
                    const newIds = group.node_ids.filter(id => id !== contextNode.id);
                    updateGroup(group.id, { node_ids: newIds });
                  }
                  setContextNode(null);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[#2C2C2E] transition-colors"
              >
                <X size={14} className="text-[#FF9500]" />
                <span className="text-[13px] text-white">Detach from group</span>
              </button>
            )}

            {/* Documents section */}
            {!contextNode.data?.isStickyNote && (
              <div className="border-t border-[rgba(84,84,88,0.35)]">
                <div className="px-3 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Paperclip size={12} className="text-[rgba(235,235,245,0.4)]" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[rgba(235,235,245,0.4)]">Documents</span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowAttachForm(!showAttachForm); }}
                    className="p-0.5 rounded hover:bg-[#2C2C2E] transition-colors"
                    title="Attach document"
                  >
                    <Plus size={12} className="text-[#007AFF]" />
                  </button>
                </div>

                {/* Attached documents list */}
                {docsLoading ? (
                  <div className="px-3 pb-2">
                    <Loader2 size={12} className="animate-spin text-[rgba(235,235,245,0.3)]" />
                  </div>
                ) : entityDocs.length > 0 ? (
                  <div className="px-2 pb-2 flex flex-col gap-1 max-h-[150px] overflow-y-auto">
                    {entityDocs.map(doc => {
                      let displayUrl = doc.url;
                      try { displayUrl = new URL(doc.url).hostname.replace('www.', '') + new URL(doc.url).pathname.split('/').pop()!; } catch {}
                      if (displayUrl.length > 40) displayUrl = displayUrl.slice(0, 37) + '...';
                      return (
                        <div key={doc.id} className="flex items-start gap-1.5 px-1.5 py-1.5 rounded-lg bg-[rgba(255,255,255,0.03)] group/doc">
                          <FileText size={12} className="text-[#30D158] shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <a
                              href={doc.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-[#5AC8FA] hover:underline truncate block"
                              onClick={e => e.stopPropagation()}
                            >
                              {displayUrl}
                              <ExternalLink size={9} className="inline ml-1 opacity-50" />
                            </a>
                            {doc.note && (
                              <p className="text-[10px] text-[rgba(235,235,245,0.4)] mt-0.5 leading-tight">{doc.note}</p>
                            )}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); detachDocument(contextNode.id, doc.id); }}
                            className="p-0.5 rounded hover:bg-[rgba(255,59,48,0.15)] opacity-0 group-hover/doc:opacity-100 transition-opacity shrink-0"
                          >
                            <X size={10} className="text-[#FF453A]" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : !showAttachForm ? (
                  <p className="px-3 pb-2 text-[10px] text-[rgba(235,235,245,0.2)] italic">No documents attached</p>
                ) : null}

                {/* Attach form */}
                {showAttachForm && (
                  <div className="px-3 pb-2 flex flex-col gap-1.5" onClick={e => e.stopPropagation()}>
                    <input
                      type="text"
                      value={attachUrl}
                      onChange={e => setAttachUrl(normalizeDocUrl(e.target.value))}
                      placeholder="Paste document URL (GCS links auto-convert to DOJ)"
                      className="w-full px-2 py-1.5 text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.8)] rounded-lg border border-[rgba(84,84,88,0.4)] outline-none focus:border-[#007AFF] placeholder-[rgba(235,235,245,0.2)]"
                      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') attachDocument(contextNode.id); }}
                    />
                    <input
                      type="text"
                      value={attachNote}
                      onChange={e => setAttachNote(e.target.value)}
                      placeholder="Note (optional)"
                      className="w-full px-2 py-1.5 text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.8)] rounded-lg border border-[rgba(84,84,88,0.4)] outline-none focus:border-[#007AFF] placeholder-[rgba(235,235,245,0.2)]"
                      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') attachDocument(contextNode.id); }}
                    />
                    <button
                      onClick={() => attachDocument(contextNode.id)}
                      disabled={!attachUrl.trim() || attachSaving}
                      className="w-full py-1.5 text-[11px] font-medium rounded-lg bg-[#007AFF] text-white disabled:opacity-30 hover:bg-[#0071E3] transition-colors flex items-center justify-center gap-1"
                    >
                      {attachSaving ? <Loader2 size={11} className="animate-spin" /> : <Paperclip size={11} />}
                      Attach
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => handleRemove(contextNode)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[#FF453A]/10 transition-colors"
            >
              <Trash2 size={14} className="text-[#FF453A]" />
              <span className="text-[13px] text-[#FF453A]">Remove from map</span>
            </button>
          </div>
        )}

        {/* Expand panel */}
        {expandNode && (
          <div className={
            isMobile
              ? "absolute bottom-0 left-0 right-0 rounded-t-2xl max-h-[60vh] bg-[#1C1C1E] border-t border-[rgba(84,84,88,0.65)] shadow-2xl z-20 flex flex-col"
              : "absolute top-3 right-3 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl z-20 w-72 max-h-[60vh] flex flex-col"
          }>
            <div className="px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)] flex items-center justify-between shrink-0">
              <div className="overflow-hidden">
                <p className="text-[13px] font-semibold text-white truncate">Neighbors of {expandNode.data?.label}</p>
                <p className="text-[11px] text-[rgba(235,235,245,0.3)]">
                  {isExpanding ? 'Loading...' : `${neighbors.length} not yet in map`}
                </p>
              </div>
              <button onClick={() => { setExpandNode(null); setNeighbors([]); }} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>

            {isExpanding ? (
              <div className="p-6 flex justify-center">
                <Loader2 size={20} className="text-[#007AFF] animate-spin" />
              </div>
            ) : neighbors.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-[13px] text-[rgba(235,235,245,0.3)]">All neighbors are already in the map.</p>
              </div>
            ) : (
              <>
                {/* Select all */}
                <button
                  onClick={selectAllNeighbors}
                  className="shrink-0 px-3 py-2 text-[11px] font-semibold text-[#007AFF] hover:bg-[#007AFF]/10 text-left transition-colors"
                >
                  {selectedNeighbors.size === neighbors.length ? 'Deselect all' : 'Select all'}
                </button>

                {/* Neighbor list */}
                <div className="overflow-y-auto flex-1 px-1">
                  {neighbors.map(n => {
                    const color = TYPE_COLORS[n.type.toUpperCase()] || '#9ca3af';
                    const selected = selectedNeighbors.has(n.id);
                    return (
                      <button
                        key={n.id}
                        onClick={() => toggleNeighbor(n.id)}
                        className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors mb-0.5 ${
                          selected ? 'bg-[#007AFF]/15' : 'hover:bg-[#2C2C2E]'
                        }`}
                      >
                        <div
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                            selected ? 'border-[#007AFF] bg-[#007AFF]' : 'border-[rgba(84,84,88,0.65)]'
                          }`}
                        >
                          {selected && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
                        </div>
                        <div className="flex-1 overflow-hidden">
                          <p className="text-[12px] font-medium text-white truncate">{n.label}</p>
                          <p className="text-[10px] uppercase tracking-wider font-bold" style={{ color }}>
                            {n.type} {n.relationships.length > 0 && `\u00B7 ${n.relationships[0]}`}
                          </p>
                        </div>
                        <span className="text-[10px] text-[rgba(235,235,245,0.2)] font-mono shrink-0">{n.degree}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Add button */}
                <div className="shrink-0 p-2 border-t border-[rgba(84,84,88,0.35)]">
                  <button
                    onClick={addSelectedNeighbors}
                    disabled={selectedNeighbors.size === 0 || isAddingNeighbors}
                    className="w-full flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 px-3 py-2 rounded-xl text-[13px] font-semibold transition-colors"
                  >
                    {isAddingNeighbors ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    Add {selectedNeighbors.size} {selectedNeighbors.size === 1 ? 'entity' : 'entities'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Group editing panel */}
        {editingGroup && (
          <div className={
            isMobile
              ? "absolute bottom-0 left-0 right-0 rounded-t-2xl max-h-[60vh] bg-[#1C1C1E] border-t border-[rgba(84,84,88,0.65)] shadow-2xl z-20 flex flex-col"
              : "absolute top-3 right-3 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl z-20 w-64 flex flex-col"
          }>
            <div className="px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)] flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: editingGroup.color }} />
                <p className="text-[13px] font-semibold text-white">
                  {editingGroup.label || 'Unnamed Group'}
                </p>
              </div>
              <button onClick={() => setEditingGroup(null)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>
            <div className="p-3 space-y-3">
              {/* Rename */}
              <div>
                <label className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">Label</label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="text"
                    value={groupLabel}
                    onChange={e => setGroupLabel(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') updateGroup(editingGroup.id, { label: groupLabel }); }}
                    placeholder="Group name..."
                    className="flex-1 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#30D158] rounded-lg px-2.5 py-1.5 text-[12px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors"
                  />
                  <button
                    onClick={() => updateGroup(editingGroup.id, { label: groupLabel })}
                    className="shrink-0 p-1.5 bg-[#30D158] hover:bg-[#28B84C] rounded-lg transition-colors"
                  >
                    <Check size={12} />
                  </button>
                </div>
              </div>

              {/* Color picker */}
              <div>
                <label className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">Color</label>
                <div className="flex items-center gap-1.5 mt-1">
                  {GROUP_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => {
                        updateGroup(editingGroup.id, { color: c });
                        setEditingGroup(prev => prev ? { ...prev, color: c } : null);
                      }}
                      className="w-6 h-6 rounded-full border-2 transition-all"
                      style={{
                        backgroundColor: c,
                        borderColor: editingGroup.color === c ? 'white' : 'transparent',
                        transform: editingGroup.color === c ? 'scale(1.15)' : 'scale(1)',
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Rotate group */}
              <div>
                <label className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider">Rotate</label>
                <div className="flex items-center gap-1.5 mt-1">
                  <button
                    onClick={() => rotateNodes(editingGroup.node_ids, -45)}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-[#2C2C2E] hover:bg-[#3A3A3C] rounded-lg text-[11px] text-[rgba(235,235,245,0.6)] transition-colors"
                  >
                    <RotateCcw size={11} /> 45°
                  </button>
                  <button
                    onClick={() => rotateNodes(editingGroup.node_ids, -15)}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-[#2C2C2E] hover:bg-[#3A3A3C] rounded-lg text-[11px] text-[rgba(235,235,245,0.6)] transition-colors"
                  >
                    <RotateCcw size={11} /> 15°
                  </button>
                  <button
                    onClick={() => rotateNodes(editingGroup.node_ids, 15)}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-[#2C2C2E] hover:bg-[#3A3A3C] rounded-lg text-[11px] text-[rgba(235,235,245,0.6)] transition-colors"
                  >
                    15° <RotateCw size={11} />
                  </button>
                  <button
                    onClick={() => rotateNodes(editingGroup.node_ids, 45)}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-[#2C2C2E] hover:bg-[#3A3A3C] rounded-lg text-[11px] text-[rgba(235,235,245,0.6)] transition-colors"
                  >
                    45° <RotateCw size={11} />
                  </button>
                </div>
              </div>

              {/* Member count */}
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-[rgba(235,235,245,0.3)] uppercase tracking-wider font-semibold">
                  Members ({editingGroup.node_ids.length})
                </p>
              </div>

              {/* Member list with detach option */}
              <div className="max-h-32 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                {editingGroup.node_ids.map(nid => {
                  const node = nodes.find(n => n.id === nid);
                  return (
                    <div key={nid} className="flex items-center justify-between gap-2 bg-[#2C2C2E]/50 rounded-lg px-2 py-1.5 group">
                      <span className="text-[11px] text-white truncate flex-1">
                        {node?.data?.label || nid.replace(/_/g, ' ')}
                      </span>
                      <button
                        onClick={() => {
                          const newIds = editingGroup.node_ids.filter(id => id !== nid);
                          updateGroup(editingGroup.id, { node_ids: newIds });
                          setEditingGroup(prev => prev ? { ...prev, node_ids: newIds } : null);
                        }}
                        className="p-1 hover:bg-[#FF453A]/20 rounded transition-colors"
                        title="Remove from group"
                      >
                        <X size={10} className="text-[#FF453A]" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Add selected nodes to group */}              {(() => {
                const newIds = [...selectedNodeIds].filter(id => !editingGroup.node_ids.includes(id));
                if (newIds.length === 0) return null;
                return (
                  <button
                    onClick={() => {
                      const merged = [...editingGroup.node_ids, ...newIds];
                      updateGroup(editingGroup.id, { node_ids: merged });
                      setEditingGroup(prev => prev ? { ...prev, node_ids: merged } : null);
                      clearSelection();
                    }}
                    className="w-full flex items-center justify-center gap-2 bg-[#007AFF]/10 hover:bg-[#007AFF]/20 text-[#007AFF] px-3 py-2 rounded-xl text-[12px] font-semibold transition-colors"
                  >
                    <Plus size={12} />
                    Add {newIds.length} selected {newIds.length === 1 ? 'entity' : 'entities'}
                  </button>
                );
              })()}

              {/* Delete group */}
              <button
                onClick={() => deleteGroup(editingGroup.id)}
                className="w-full flex items-center justify-center gap-2 bg-[#FF453A]/10 hover:bg-[#FF453A]/20 text-[#FF453A] px-3 py-2 rounded-xl text-[12px] font-semibold transition-colors"
              >
                <Trash2 size={12} />
                Dissolve Group
              </button>
            </div>
          </div>
        )}

        {/* Case AI chat widget */}
        <div
          className={
            isMobile && caseChatOpen
              ? "fixed inset-0 z-50 flex flex-col"
              : "absolute z-20 flex flex-col transition-all"
          }
          style={isMobile && caseChatOpen ? undefined : { bottom: showMiniMap ? 165 : 14, right: showMiniMap ? 220 : 50, width: caseChatOpen ? 340 : 'auto' }}
        >
          {caseChatOpen ? (
            <div className={
              isMobile
                ? "bg-[#1C1C1E] flex-1 flex flex-col"
                : "bg-[#1C1C1E]/95 backdrop-blur-md border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl flex flex-col"
            } style={isMobile ? undefined : { height: 360 }}>
              {/* Header */}
              <div className="shrink-0 px-3 py-2 flex items-center justify-between border-b border-[rgba(84,84,88,0.35)]">
                <div className="flex items-center gap-2">
                  <Bot size={14} className="text-[#5AC8FA]" />
                  <span className="text-[12px] font-semibold text-white">Case Assistant</span>
                </div>
                <div className="flex items-center gap-1">
                  {caseChatMessages.length > 0 && (
                    <button
                      onClick={() => setCaseChatMessages([])}
                      className="p-1 hover:bg-[#2C2C2E] rounded-lg text-[rgba(235,235,245,0.3)] hover:text-white transition-colors"
                      title="Clear chat"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                  <button onClick={() => setCaseChatOpen(false)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                    <X size={14} className="text-[rgba(235,235,245,0.4)]" />
                  </button>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                {caseChatMessages.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full text-center gap-2 opacity-50">
                    <Bot size={24} className="text-[#5AC8FA]" />
                    <p className="text-[11px] text-[rgba(235,235,245,0.4)] max-w-[200px]">
                      Ask anything about this case, its entities, connections, or investigation leads.
                    </p>
                  </div>
                )}
                {caseChatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                      msg.role === 'user'
                        ? 'bg-[#5AC8FA] text-white'
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
                              className="text-[11px] text-[#0A84FF] hover:underline flex items-center gap-2 truncate"
                            >
                              <span className="shrink-0 text-[10px] bg-[#0A84FF]/10 px-1.5 py-0.5 rounded text-[#0A84FF] font-mono">{idx + 1}</span>
                              <span className="truncate">{source.title || source.domain}</span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isCaseChatting && (
                  <div className="flex justify-start">
                    <div className="bg-[#2C2C2E] rounded-2xl px-3 py-2">
                      <Loader2 size={14} className="text-[#5AC8FA] animate-spin" />
                    </div>
                  </div>
                )}
                <div ref={caseChatEndRef} />
              </div>

              {/* Mode Toggle */}
              <div className="shrink-0 px-2.5 py-1.5 flex justify-center border-t border-[rgba(84,84,88,0.2)]">
                <div className="inline-flex bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-lg p-0.5">
                  <button
                    onClick={() => setCaseChatMode('files_only')}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${
                      caseChatMode === 'files_only'
                        ? 'bg-[#3A3A3C] text-white shadow-sm'
                        : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                    }`}
                  >
                    <Database size={10} />
                    Files
                  </button>
                  <button
                    onClick={() => setCaseChatMode('files_web')}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${
                      caseChatMode === 'files_web'
                        ? 'bg-[#007AFF]/20 text-[#007AFF] shadow-sm'
                        : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                    }`}
                  >
                    <Globe size={10} />
                    Web
                  </button>
                </div>
              </div>

              {/* Input */}
              <div className="shrink-0 px-2.5 py-2 border-t border-[rgba(84,84,88,0.35)]">
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={caseChatInput}
                    onChange={e => setCaseChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCaseChatMessage(); } }}
                    placeholder="Ask about this case..."
                    disabled={isCaseChatting}
                    className="flex-1 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-1.5 text-[12px] text-white focus:outline-none focus:border-[#5AC8FA] transition-colors placeholder:text-[rgba(235,235,245,0.2)] disabled:opacity-50"
                  />
                  <button
                    onClick={sendCaseChatMessage}
                    disabled={!caseChatInput.trim() || isCaseChatting}
                    className="w-8 h-8 rounded-xl bg-[#5AC8FA] hover:bg-[#4AB8EA] disabled:opacity-30 flex items-center justify-center transition-colors shrink-0"
                  >
                    <Send size={12} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCaseChatOpen(true)}
              className="w-9 h-9 rounded-xl bg-[#1C1C1E]/90 backdrop-blur-sm border border-[rgba(84,84,88,0.65)] hover:bg-[#2C2C2E] flex items-center justify-center transition-colors group"
              title="Case Assistant"
            >
              <Bot size={16} className="text-[#5AC8FA] group-hover:scale-110 transition-transform" />
            </button>
          )}
        </div>

        {/* MiniMap collapse/expand toggle */}
        <button
          onClick={() => setShowMiniMap(v => !v)}
          className="absolute z-20 flex items-center gap-1 px-2 py-1 rounded-lg bg-[#1C1C1E]/90 border border-[rgba(84,84,88,0.65)] hover:bg-[#2C2C2E] transition-all backdrop-blur-sm text-[10px] font-medium text-[rgba(235,235,245,0.5)] hover:text-white"
          style={{ bottom: showMiniMap ? 160 : 14, right: 14 }}
          title={showMiniMap ? 'Collapse minimap' : 'Expand minimap'}
        >
          <MapIcon size={10} />
          {showMiniMap ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
        </button>

        {/* Edge evidence panel */}
        {evidenceEdge && (
          <EdgeEvidencePanel
            edge={evidenceEdge}
            allNodes={nodes}
            caseId={caseId}
            onClose={() => setEvidenceEdge(null)}
            onPinEdge={!evidenceEdge.data?.isCaseLocal ? pinEdge : undefined}
            onSolidify={handleSolidify}
            onUpdateLabel={async (edgeId, newLabel) => {
              await axios.patch(`/api/cases/${caseId}/graph/edges/${edgeId}`, { label: newLabel });
              await loadGraph();
              setEvidenceEdge(null);
            }}
            onDeleteEdge={async (edgeId) => {
              await axios.delete(`/api/cases/${caseId}/graph/edges/${edgeId}`);
              await loadGraph();
              setEvidenceEdge(null);
            }}
          />
        )}



        {/* Description panel */}
        {descriptionNode && (
          <div className={
            isMobile
              ? "absolute bottom-0 left-0 right-0 rounded-t-2xl max-h-[60vh] bg-[#1C1C1E] border-t border-[rgba(84,84,88,0.65)] shadow-2xl z-20 flex flex-col"
              : "absolute top-3 right-3 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl z-20 w-72 flex flex-col"
          }>
            <div className="px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)] flex items-center justify-between shrink-0">
              <div className="overflow-hidden">
                <p className="text-[13px] font-semibold text-white truncate">{descriptionNode.data?.label}</p>
                <p className="text-[10px] uppercase tracking-wider font-bold" style={{ color: TYPE_COLORS[(descriptionNode.data?.entityType || '').toUpperCase()] || '#9ca3af' }}>
                  Description
                </p>
              </div>
              <button onClick={() => setDescriptionNode(null)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>
            <div className="p-3">
              <textarea
                value={descriptionText}
                onChange={e => { setDescriptionText(e.target.value); setDescriptionSaved(false); }}
                placeholder="Add a description or notes about this entity..."
                rows={5}
                className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] focus:border-[#30D158] rounded-xl px-3 py-2.5 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors resize-none leading-relaxed"
              />
              <div className="flex items-center justify-between mt-2">
                <p className="text-[10px] text-[rgba(235,235,245,0.2)]">
                  {descriptionNode.data?.description && !descriptionNode.data?.caseDescription ? 'Source: extracted from files' : ''}
                </p>
                <button
                  onClick={saveDescription}
                  disabled={isSavingDescription}
                  className="flex items-center gap-1.5 bg-[#30D158] hover:bg-[#28B84C] disabled:opacity-50 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-colors"
                >
                  {isSavingDescription ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : descriptionSaved ? (
                    <Check size={12} />
                  ) : null}
                  {descriptionSaved ? 'Saved' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Analysis + chat panel */}
      {(analysisResult || isAnalyzing) && (
        <div className="shrink-0 max-h-[30vh] sm:max-h-[50vh] flex flex-col border-t border-[rgba(84,84,88,0.65)] bg-[#1C1C1E]">
          {/* Header */}
          <div className="shrink-0 px-4 py-2.5 flex items-center justify-between border-b border-[rgba(84,84,88,0.35)]">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-[#AF52DE]" />
              <span className="text-[13px] font-semibold text-white">Similarity Analysis</span>
            </div>
            <button onClick={() => { setAnalysisResult(null); setAnalysisShared([]); setChatMessages([]); }} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
              <X size={14} className="text-[rgba(235,235,245,0.4)]" />
            </button>
          </div>

          {isAnalyzing ? (
            <div className="flex items-center gap-2 py-6 justify-center">
              <Loader2 size={16} className="text-[#AF52DE] animate-spin" />
              <span className="text-[13px] text-[rgba(235,235,245,0.4)]">Analyzing connections...</span>
            </div>
          ) : (
            <>
              {/* Chat messages */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${
                      msg.role === 'user'
                        ? 'bg-[#007AFF] text-white'
                        : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.6)]'
                    }`}>
                      <p className="text-[13px] whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      {msg.webSources && msg.webSources.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-[rgba(84,84,88,0.35)] flex flex-col gap-1">
                          {msg.webSources.map((source, idx) => (
                            <a
                              key={idx}
                              href={source.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-[#0A84FF] hover:underline flex items-center gap-2 truncate"
                            >
                              <span className="shrink-0 text-[10px] bg-[#0A84FF]/10 px-1.5 py-0.5 rounded text-[#0A84FF] font-mono">{idx + 1}</span>
                              <span className="truncate">{source.title || source.domain}</span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isChatting && (
                  <div className="flex justify-start">
                    <div className="bg-[#2C2C2E] rounded-2xl px-3.5 py-2.5">
                      <Loader2 size={14} className="text-[#AF52DE] animate-spin" />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Shared connections chips */}
              {analysisShared.length > 0 && chatMessages.length <= 1 && (
                <div className="shrink-0 px-4 pb-2">
                  <p className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider mb-1.5">Shared Connections</p>
                  <div className="flex flex-wrap gap-1">
                    {analysisShared.map(sn => {
                      const color = TYPE_COLORS[sn.type.toUpperCase()] || '#9ca3af';
                      return (
                        <span key={sn.label} className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#2C2C2E] text-[10px] text-[rgba(235,235,245,0.5)]">
                          <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                          {sn.label}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Chat input */}
              <div className="shrink-0 px-3 py-2 border-t border-[rgba(84,84,88,0.35)]">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } }}
                    placeholder="Ask about these entities..."
                    disabled={isChatting}
                    className="flex-1 bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-2 text-[13px] text-white focus:outline-none focus:border-[#AF52DE] transition-colors placeholder:text-[rgba(235,235,245,0.2)] disabled:opacity-50"
                  />
                  <button
                    onClick={sendChatMessage}
                    disabled={!chatInput.trim() || isChatting}
                    className="w-9 h-9 rounded-xl bg-[#AF52DE] hover:bg-[#9642C0] disabled:opacity-30 flex items-center justify-center transition-colors shrink-0"
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      </div>{/* end inner flex-col (canvas + analysis) */}

      {/* Research side panel */}
      {showResearch && (
        <div className="w-80 shrink-0 flex flex-col bg-[#0A0A0A] border-l border-[rgba(84,84,88,0.65)]">
          {/* Header */}
          <div className="shrink-0 px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-[#FF9F0A]" />
              <span className="text-[13px] font-semibold text-white">Research</span>
            </div>
            <div className="flex items-center gap-1">
              {researchMessages.length > 0 && (
                <button
                  onClick={() => setResearchMessages([])}
                  className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors"
                  title="Clear conversation"
                >
                  <Trash2 size={13} className="text-[rgba(235,235,245,0.4)]" />
                </button>
              )}
              <button
                onClick={() => setShowResearch(false)}
                className="p-1 hover:bg-[#2C2C2E] rounded-lg transition-colors"
              >
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {researchMessages.length === 0 && (
              <div className="text-center py-8">
                <Sparkles size={24} className="text-[#FF9F0A]/30 mx-auto mb-3" />
                <p className="text-[13px] text-[rgba(235,235,245,0.4)] mb-1">Entity Research</p>
                <p className="text-[11px] text-[rgba(235,235,245,0.25)] leading-relaxed px-4">
                  Search for people, organizations, locations, and connections to add to your network graph
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

                    {/* Entity suggestions */}
                    {msg.entities && msg.entities.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider px-1">
                          Suggested Entities
                        </span>
                        {msg.entities.map((ent, ei) => {
                          const key = `${i}-${ei}`;
                          const typeColor = TYPE_COLORS[ent.type] || '#8E8E93';
                          const isAdding = addingEntityIdx === key;
                          const suggestedGroup = ent.suggested_group
                            ? groups.find(g => g.label === ent.suggested_group)
                            : null;

                          return (
                            <div
                              key={ei}
                              className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.35)] rounded-xl overflow-hidden"
                            >
                              <div style={{ height: 3, backgroundColor: typeColor }} />
                              <div className="px-2.5 py-2">
                                <div className="flex items-center justify-between gap-1">
                                  <p className="text-[12px] font-semibold text-white leading-tight flex-1">{ent.name}</p>
                                  <span
                                    className="text-[9px] font-bold px-1.5 py-0.5 rounded-md shrink-0"
                                    style={{ backgroundColor: typeColor + '20', color: typeColor }}
                                  >
                                    {ent.type.replace('_', ' ')}
                                  </span>
                                </div>
                                {ent.description && (
                                  <p className="text-[10px] text-[rgba(235,235,245,0.4)] leading-snug mt-0.5">{ent.description}</p>
                                )}
                                <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-[rgba(84,84,88,0.2)]">
                                  {suggestedGroup ? (
                                    <span className="text-[9px] text-[rgba(235,235,245,0.3)] flex items-center gap-1">
                                      <Circle size={6} style={{ fill: suggestedGroup.color, color: suggestedGroup.color }} />
                                      {suggestedGroup.label}
                                    </span>
                                  ) : groups.length > 0 ? (
                                    <select
                                      className="text-[9px] bg-[#2C2C2E] border border-[rgba(84,84,88,0.35)] rounded px-1 py-0.5 text-[rgba(235,235,245,0.5)] max-w-[120px]"
                                      defaultValue=""
                                      id={`group-select-${key}`}
                                    >
                                      <option value="">No group</option>
                                      {groups.map(g => (
                                        <option key={g.id} value={g.id}>{g.label || 'Unnamed'}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span />
                                  )}
                                  <button
                                    onClick={() => {
                                      const groupId = suggestedGroup?.id
                                        || (document.getElementById(`group-select-${key}`) as HTMLSelectElement)?.value
                                        || undefined;
                                      addResearchEntity(ent, key, groupId);
                                    }}
                                    disabled={isAdding}
                                    className="flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-[#30D158] hover:bg-[#28B74C] text-black transition-colors disabled:opacity-50"
                                  >
                                    {isAdding ? <Loader2 size={9} className="animate-spin" /> : <Plus size={9} />}
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
                placeholder="Search for entities to add..."
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
      </div>{/* end outer flex row (canvas + research) */}

      {/* Footer stats + selection bar */}
      <div className="shrink-0 px-4 py-2 bg-black border-t border-[rgba(84,84,88,0.65)] flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 shrink-0">
          {nodes.length > 0 && !readOnly && (
            <>
              <button
                onClick={() => setSelectMode(m => !m)}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                  selectMode
                    ? 'bg-[#007AFF] text-white'
                    : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.5)]'
                }`}
              >
                <MousePointerClick size={11} />
                {!isMobile && 'Select'}
              </button>
              <button
                onClick={() => setLassoMode(m => !m)}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                  lassoMode
                    ? 'bg-[#FF9500] text-white'
                    : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.5)]'
                }`}
              >
                <Lasso size={11} />
                {!isMobile && 'Lasso'}
              </button>
              {selectedNodeIds.size > 0 && (
                <>
                  <div className="flex items-center bg-[#2C2C2E] rounded-lg overflow-hidden">
                    <button
                      onClick={() => setNodeScales(prev => {
                        const next = { ...prev };
                        selectedNodeIds.forEach(id => { next[id] = Math.max(0.4, (next[id] ?? 1) - 0.15); });
                        return next;
                      })}
                      className="px-1.5 py-1 text-[rgba(235,235,245,0.5)] hover:text-white hover:bg-[#3A3A3C] transition-colors"
                    >
                      <Minus size={11} />
                    </button>
                    <span className="text-[10px] text-[rgba(235,235,245,0.4)] font-mono px-1">
                      {Math.round(([...selectedNodeIds].reduce((sum, id) => sum + (nodeScales[id] ?? 1), 0) / selectedNodeIds.size) * 100)}%
                    </span>
                    <button
                      onClick={() => setNodeScales(prev => {
                        const next = { ...prev };
                        selectedNodeIds.forEach(id => { next[id] = Math.min(2, (next[id] ?? 1) + 0.15); });
                        return next;
                      })}
                      className="px-1.5 py-1 text-[rgba(235,235,245,0.5)] hover:text-white hover:bg-[#3A3A3C] transition-colors"
                    >
                      <Plus size={11} />
                    </button>
                  </div>
                  {selectedNodeIds.size >= 2 && !isMobile && (
                    <div className="flex items-center bg-[#2C2C2E] rounded-lg overflow-hidden" title="Rotate selected entities">
                      <button
                        onClick={() => rotateNodes(Array.from(selectedNodeIds), -15)}
                        className="px-1.5 py-1 text-[rgba(235,235,245,0.5)] hover:text-white hover:bg-[#3A3A3C] transition-colors"
                      >
                        <RotateCcw size={11} />
                      </button>
                      <span className="text-[10px] text-[rgba(235,235,245,0.4)] font-mono px-0.5">15°</span>
                      <button
                        onClick={() => rotateNodes(Array.from(selectedNodeIds), 15)}
                        className="px-1.5 py-1 text-[rgba(235,235,245,0.5)] hover:text-white hover:bg-[#3A3A3C] transition-colors"
                      >
                        <RotateCw size={11} />
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
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
            {!isMobile && 'Map'}
          </button>
          {!isMobile && (
            <button
              onClick={toggleFullscreen}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] hover:text-white"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
            </button>
          )}
          <button
            onClick={() => {
              if (nodes.length === 0) return;
              const simNodes = nodes.map(n => ({ id: n.id, x: Math.random() * 800 - 400, y: Math.random() * 800 - 400 }));
              const simEdges = edges.map(e => ({ source: e.source, target: e.target }));
              const sim = forceSimulation(simNodes as any)
                .force('link', forceLink(simEdges as any).id((d: any) => d.id).distance(250))
                .force('charge', forceManyBody().strength(-2000))
                .force('center', forceCenter(0, 0).strength(0.05))
                .force('collide', forceCollide(60))
                .stop();
              for (let i = 0; i < 300; i++) sim.tick();
              const posMap = new Map(simNodes.map(n => [n.id, { x: n.x, y: n.y }]));
              const laid = nodes.map(n => {
                const p = posMap.get(n.id);
                return p ? { ...n, position: { x: p.x, y: p.y } } : n;
              });
              setNodes(laid);
              const updates = laid.map(n => ({ node_id: n.id, x: n.position.x, y: n.position.y }));
              axios.post(`/api/cases/${caseId}/graph/positions`, { positions: updates }).catch(() => {});
              setTimeout(() => fitView({ padding: 0.3, duration: 500 }), 50);
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] hover:text-white"
            title="Force-spread all nodes"
          >
            <Network size={11} />
            Spread
          </button>
          {!isMobile && (
            <div className="flex items-center bg-[#2C2C2E] rounded-lg overflow-hidden">
              <button
                onClick={() => { if (layoutMode === 'semantic') toggleSemanticLayout(); }}
                className={`px-2 py-1 text-[11px] font-medium transition-colors ${
                  layoutMode === 'manual' ? 'bg-[#007AFF] text-white' : 'text-[rgba(235,235,245,0.5)] hover:text-white'
                }`}
              >
                Manual
              </button>
              <button
                onClick={() => { if (layoutMode === 'manual') toggleSemanticLayout(); }}
                disabled={isComputingLayout}
                className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                  layoutMode === 'semantic' ? 'bg-[#AF52DE] text-white' : 'text-[rgba(235,235,245,0.5)] hover:text-white'
                }`}
              >
                {isComputingLayout ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                Semantic
              </button>
            </div>
          )}
          {!isMobile && (
            <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono">
              {nodes.length} {nodes.length === 1 ? 'entity' : 'entities'} · {edges.length} {edges.length === 1 ? 'connection' : 'connections'}
              {selectMode && selectedNodeIds.size === 0 && ' · Tap entities to select'}
            </span>
          )}
        </div>
        {selectedNodeIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-[rgba(235,235,245,0.6)] font-medium">
              {selectedNodeIds.size} selected
            </span>
            {selectedNodeIds.size === 2 && (
              <>
                {!isMobile && (
                  <input
                    type="text"
                    value={linkLabel}
                    onChange={e => setLinkLabel(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') linkSelectedNodes(); }}
                    placeholder="Label (optional)"
                    className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] focus:border-[#007AFF] rounded-lg px-2 py-1 text-[11px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none transition-colors w-28"
                  />
                )}
                <button
                  onClick={() => linkSelectedNodes()}
                  disabled={isLinking}
                  className="flex items-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
                >
                  {isLinking ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
                  Link
                </button>
                <button
                  onClick={() => linkSelectedNodes(true)}
                  disabled={isLinking}
                  className="flex items-center gap-1.5 bg-[#FBBF24] hover:bg-[#F5A623] disabled:opacity-50 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-black transition-colors"
                  title="Hypothesize"
                >
                  {isLinking ? <Loader2 size={11} className="animate-spin" /> : <AlertTriangle size={11} />}
                  {!isMobile && 'Hypothesize'}
                </button>
              </>
            )}
            {selectedNodeIds.size >= 2 && (
              <>
                <button
                  onClick={analyzeSelected}
                  disabled={isAnalyzing}
                  className="flex items-center gap-1.5 bg-[#AF52DE] hover:bg-[#9642C0] disabled:opacity-50 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
                  title="Similarities"
                >
                  {isAnalyzing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  {!isMobile && 'Similarities'}
                </button>
                <button
                  onClick={createGroup}
                  className="flex items-center gap-1.5 bg-[#30D158] hover:bg-[#28B84C] px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
                  title="Group"
                >
                  <Circle size={11} />
                  {!isMobile && 'Group'}
                </button>
              </>
            )}
            <button
              onClick={copySelectedNodes}
              className="flex items-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
            >
              <Copy size={11} />
              {copied ? 'Copied!' : (!isMobile ? 'Copy' : '')}
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

function SearchDropdown({
  results,
  activeIndex,
  onSelect,
  onHover,
}: {
  results: SearchResult[];
  activeIndex: number;
  onSelect: (r: SearchResult) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className="absolute top-full left-0 right-0 mt-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl overflow-hidden shadow-2xl z-50 max-h-[320px] overflow-y-auto">
      {results.map((r, i) => {
        const color = TYPE_COLORS[r.type.toUpperCase()] || '#9ca3af';
        return (
          <button
            key={r.id}
            onClick={() => onSelect(r)}
            onMouseEnter={() => onHover(i)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
              i === activeIndex ? 'bg-[#007AFF]/20' : 'hover:bg-[#2C2C2E]'
            }`}
          >
            <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `${color}20` }}>
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="text-[13px] font-medium text-white truncate">{r.label}</p>
              <p className="text-[10px] uppercase tracking-wider font-bold" style={{ color }}>{r.type}</p>
            </div>
            <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono shrink-0">{r.degree}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function CaseNetworkMap(props: CaseNetworkMapProps) {
  return (
    <ReactFlowProvider>
      <CaseNetworkMapInner {...props} />
    </ReactFlowProvider>
  );
}

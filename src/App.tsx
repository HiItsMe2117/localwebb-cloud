import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import { toast } from 'sonner';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import GraphPanel from './components/GraphPanel';
import EvidencePanel from './components/EvidencePanel';
import DataPanel from './components/DataPanel';
import UrlsPanel from './components/UrlsPanel';
import {
  Upload,
  RefreshCw,
  Network,
  MessageSquare,
  Database,
  Settings as SettingsIcon,
  FileText,
  Loader2,
  HardDrive,
  Globe,
  Plus,
  Minus,
  Type,
  Shield,
  Search,
  CircleOff,
  Lock,
  SlidersHorizontal,
  Crosshair,
  X,
} from 'lucide-react';
import { useNodesState, useEdgesState, ReactFlowProvider, useReactFlow } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import axios from 'axios';
import { getLayoutedElements, computeDegreeMap } from './utils/layout';
import { getFileUrl } from './utils/files';
import CasesPanel from './components/CasesPanel';
import CaseDetail from './components/CaseDetail';
import LoginModal from './components/LoginModal';
import PasswordResetModal from './components/PasswordResetModal';
import UpgradeModal from './components/UpgradeModal';
import AccountPanel from './components/AccountPanel';
import { useAuth } from './contexts/AuthContext';
import type { ChatMessage, Community, Case, ScanFinding, TheoryResult, TheorySession, TheoryFollowUpMessage, TheoryEntitySuggestion, InvestigationStep, Source, WebSource } from './types';
import TheoryInvestigation from './components/TheoryInvestigation';

type View = 'chat' | 'graph' | 'docs' | 'data' | 'cases' | 'account' | 'urls';

function AppContent() {
  const { isAdmin, hasAIPrivileges, isRecovering, setIsRecovering, user, refreshSession } = useAuth();
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const readOnly = !hasAIPrivileges;

  const [activeView, setActiveView] = useState<View>('chat');

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  // Graph state
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [yearFilter, setYearFilter] = useState(2026);
  const [minDegree, setMinDegree] = useState(200);
  const [showOutliers, setShowOutliers] = useState(true);
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);
  const [showAllEdges, setShowAllEdges] = useState(false);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());  // empty = show all
  const [isLayouting, setIsLayouting] = useState(false);
  const [graphLoading, setGraphLoading] = useState(true);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncStatus, setSyncStatus] = useState('');
  const [focusTarget, setFocusTarget] = useState('');

  // Ego network focus state
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState(1);

  // Targeted keyword search state
  const [targetedResults, setTargetedResults] = useState<{chunks: {id: string; text: string; filename: string; page: number; score: number}[]; stats: {total_mentions: number; unique_files: number; page: number; page_size: number; total_pages: number}} | null>(null);
  const [isTargetedSearching, setIsTargetedSearching] = useState(false);
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());
  const [searchPage, setSearchPage] = useState(1);
  const [searchMode, setSearchMode] = useState<'fulltext' | 'exact'>('fulltext');

  const { setCenter } = useReactFlow();

  // Deferred filters for performance
  const deferredYearFilter = useDeferredValue(yearFilter);
  const deferredMinDegree = useDeferredValue(minDegree);

  // Filter state
  const [topK, setTopK] = useState(15);
  const [docTypeFilter, setDocTypeFilter] = useState('');
  const [personFilter, setPersonFilter] = useState('');
  const [orgFilter, setOrgFilter] = useState('');

  // Evidence panel state
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);
  const [isExtractingInsights, setIsExtractingInsights] = useState(false);
  const hasAttemptedInitialLoad = useRef(false);
  const hasAutoTriggered = useRef(false);

  // Cases state
  const [cases, setCases] = useState<Case[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanFindings, setScanFindings] = useState<ScanFinding[]>([]);
  const [isTestingTheory, setIsTestingTheory] = useState(false);
  const [theoryResult, setTheoryResult] = useState<TheoryResult | null>(null);
  const [activeTheorySession, setActiveTheorySession] = useState<TheorySession | null>(null);
  const [isFollowUpStreaming, setIsFollowUpStreaming] = useState(false);
  const theoryResultRef = useRef<TheoryResult | null>(null);

  // Graph search state
  const [graphSearch, setGraphSearch] = useState('');
  const [graphSearchIndex, setGraphSearchIndex] = useState(0);
  const graphSearchRef = useRef<HTMLDivElement>(null);
  const [graphFiltersOpen, setGraphFiltersOpen] = useState(false);

  // --- Helpers ---

  /** Apply force layout to raw nodes/edges and persist positions */
  const applyForceLayout = useCallback(async (rawNodes: Node[], rawEdges: Edge[]) => {
    if (rawNodes.length === 0) {
      setNodes([]);
      setEdges(rawEdges);
      return;
    }

    setIsLayouting(true);
    try {
      // Enrich nodes with degree for sizing
      const degree = computeDegreeMap(rawEdges);
      const enriched = rawNodes.map((n) => ({
        ...n,
        data: { ...n.data, degree: degree.get(n.id) || 0 },
      }));

      const { nodes: laid, edges: laidEdges } = await getLayoutedElements(enriched, rawEdges);
      setNodes(laid);
      setEdges(laidEdges);

      // Persist positions to backend
      const updates = laid.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
      axios.post('/api/graph/positions', updates).catch(() => {});
    } finally {
      setIsLayouting(false);
    }
  }, [setNodes, setEdges]);

  const loadGraph = async (degreeFilter?: number) => {
    setGraphLoading(true);
    try {
      const deg = degreeFilter ?? deferredMinDegree;
      console.log(`Fetching graph data from /api/graph?min_degree=${deg}...`);
      const res = await axios.get(`/api/graph?min_degree=${deg}`);
      const rawNodes: Node[] = res.data.nodes || [];
      const rawEdges: Edge[] = res.data.edges || [];
      console.log(`Loaded ${rawNodes.length} nodes and ${rawEdges.length} edges.`);
      
      if (res.data.communities) {
        setCommunities(res.data.communities);
      }

      if (rawNodes.length > 0) {
        const degree = computeDegreeMap(rawEdges);
        const enriched = rawNodes.map((n) => ({
          ...n,
          data: { ...n.data, degree: degree.get(n.id) || 0 },
        }));

        // Pre-filter to visible nodes for layout check (avoid running d3 on 8k+ nodes)
        const visibleNodes = enriched.filter((n) => (degree.get(n.id) || 0) >= deg);
        const visibleIds = new Set(visibleNodes.map((n) => n.id));
        const visibleEdges = rawEdges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

        const atOrigin = visibleNodes.filter((n) => Math.abs(n.position.x) < 1 && Math.abs(n.position.y) < 1).length;
        const hasLayout = visibleNodes.length === 0 || atOrigin < visibleNodes.length * 0.3;

        if (hasLayout) {
          setNodes(enriched);
          setEdges(rawEdges);
        } else {
          console.log(`No layout detected for ${visibleNodes.length} visible nodes, running auto-layout...`);
          // Layout only visible nodes, then merge positions back into full set
          setIsLayouting(true);
          try {
            const { nodes: laid } = await getLayoutedElements(visibleNodes, visibleEdges);
            const posMap = new Map(laid.map((n) => [n.id, n.position]));
            const merged = enriched.map((n) => posMap.has(n.id) ? { ...n, position: posMap.get(n.id)! } : n);
            setNodes(merged);
            setEdges(rawEdges);
            // Persist only the newly laid-out positions
            const updates = laid.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
            axios.post('/api/graph/positions', updates).catch(() => {});
          } finally {
            setIsLayouting(false);
          }
        }
      } else {
        setNodes([]);
        setEdges(rawEdges);
      }
    } catch (err: any) {
      console.error("Failed to load graph:", err);
    } finally {
      hasAttemptedInitialLoad.current = true;
      setGraphLoading(false);
    }
  };

  // Handle Stripe checkout return
  // Notify on site visit (fire once on load)
  useEffect(() => {
    axios.post('/api/ping').catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    if (!checkout) return;

    window.history.replaceState({}, '', window.location.pathname);

    if (checkout === 'success') {
      toast.success('Subscription activated!', {
        description: 'Your account has been upgraded.',
      });
      const PAID_ROLES = ['admin', 'pro', 'elite', 'basic'];
      const poll = async (n: number) => {
        const currentRole = await refreshSession();
        if (currentRole && PAID_ROLES.includes(currentRole)) return;
        if (n > 0) {
          setTimeout(() => poll(n - 1), 2000);
        } else {
          toast.info('Still syncing your subscription...', {
            description: 'This may take a moment. Try refreshing if features are still locked.',
          });
        }
      };
      poll(5);
    } else if (checkout === 'canceled') {
      toast('Checkout canceled', {
        description: 'No charges were made.',
      });
    }
  }, []);



  // Load cases first (fast), then graph (heavy) on mount
  useEffect(() => {
    loadCases().then(() => loadGraph());
  }, []);

  const onNodeDragStop = async (_: any, node: Node) => {
    try {
      await axios.post('/api/graph/positions', [{
        id: node.id, x: node.position.x, y: node.position.y
      }]);
    } catch (err) {
      console.error("Failed to save position:", err);
    }
  };

  const onLayout = useCallback(async () => {
    await applyForceLayout(nodes, edges);
  }, [nodes, edges, applyForceLayout]);

  const triggerInsights = async (depth: string = 'standard', focus?: string) => {
    setIsSyncing(true);
    setIsExtractingInsights(true);
    setSyncProgress(5);
    setSyncStatus(focus ? `Targeting: ${focus}...` : 'Connecting to Pinecone...');

    const interval = setInterval(() => {
      setSyncProgress(prev => (prev < 90 ? prev + Math.random() * 2 : prev));
    }, 1500);

    try {
      if (focus) {
        setSyncStatus(`Extracting deep connections for "${focus}"...`);
      } else {
        if (depth === 'standard') setSyncStatus('Sampling core investigative topics...');
        if (depth === 'deep') setSyncStatus('Performing deep theme sampling...');
        if (depth === 'full') setSyncStatus('Initiating exhaustive reconstruction sweep...');
      }

      let url = `/api/insights?depth=${depth}`;
      if (focus) url += `&focus=${encodeURIComponent(focus)}`;

      const res = await axios.get(url);
      
      setSyncStatus('Gemini analysis complete. Finalizing graph store...');
      setSyncProgress(95);

      const rawNodes: Node[] = res.data.nodes || [];
      const rawEdges: Edge[] = res.data.edges || [];
      if (res.data.communities) {
        setCommunities(res.data.communities);
      }
      await applyForceLayout(rawNodes, rawEdges);
    } catch (err) {
      console.error("Sync failed:", err);
      setSyncStatus('Sync failed. Please try again.');
    } finally {
      clearInterval(interval);
      setSyncProgress(100);
      setTimeout(() => {
        setIsSyncing(false);
        setIsExtractingInsights(false);
        setSyncProgress(0);
        setSyncStatus('');
      }, 1000);
    }
  };

  // Auto-trigger insights ONLY if graph is empty after a successful initial load attempt
  useEffect(() => {
    if (activeView === 'graph' && hasAttemptedInitialLoad.current && nodes.length === 0 && !hasAutoTriggered.current && !isSyncing) {
      hasAutoTriggered.current = true;
      triggerInsights();
    }
  }, [activeView, nodes.length, isSyncing]);

  // --- Ego network focus ---
  const egoNodeIds = useMemo(() => {
    if (!focusNodeId) return null;
    // BFS from focusNodeId up to focusDepth hops
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source)!.push(e.target);
      adj.get(e.target)!.push(e.source);
    }
    const visited = new Set<string>([focusNodeId]);
    let frontier = [focusNodeId];
    for (let d = 0; d < focusDepth; d++) {
      const next: string[] = [];
      for (const nid of frontier) {
        for (const neighbor of adj.get(nid) || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    return visited;
  }, [focusNodeId, focusDepth, edges]);

  const handleFocusNode = useCallback((nodeId: string) => {
    setFocusNodeId(nodeId);
    setFocusDepth(1);
  }, []);

  const exitFocus = useCallback(() => {
    setFocusNodeId(null);
  }, []);

  // --- Filtering pipeline ---
  // 1. Compute degreeMap from ALL edges (stable hub status regardless of filters)
  const degreeMap = useMemo(() => computeDegreeMap(edges), [edges]);

  // 2. Year-filter edges
  const yearFilteredEdges = useMemo(() => {
    if (deferredYearFilter >= 2026) return edges;
    return edges.filter((e) => {
      const dateMentioned = e.data?.date_mentioned;
      if (!dateMentioned) return true;
      const year = parseInt(dateMentioned.slice(0, 4), 10);
      return !isNaN(year) && year <= deferredYearFilter;
    });
  }, [edges, deferredYearFilter]);

  // 3. Filter nodes by degree slider, outlier toggle, and year, then prune edges
  const { filteredNodes, filteredEdges } = useMemo(() => {
    const visibleNodes = new Set<string>();
    for (const n of nodes) {
      const deg = degreeMap.get(n.id) || 0;
      // Degree slider filter
      if (deferredMinDegree > 0 && deg < deferredMinDegree) continue;
      // If outliers are hidden, node must have degree > 1
      if (!showOutliers && deg <= 1) continue;
      // Entity type filter
      if (activeTypes.size > 0 && !activeTypes.has((n.data?.entityType || n.data?.type || '').toUpperCase())) continue;
      visibleNodes.add(n.id);
    }

    // If year filter is active, also restrict to nodes touched by year-filtered edges
    let visibleIds: Set<string>;
    if (deferredYearFilter >= 2026) {
      visibleIds = visibleNodes;
    } else {
      const yearVisible = new Set<string>();
      for (const e of yearFilteredEdges) {
        yearVisible.add(e.source);
        yearVisible.add(e.target);
      }
      // Intersection: must pass both outlier AND year visibility
      visibleIds = new Set<string>();
      for (const id of visibleNodes) {
        if (yearVisible.has(id)) visibleIds.add(id);
      }
    }

    // Apply ego network focus filter
    if (egoNodeIds) {
      for (const id of Array.from(visibleIds)) {
        if (!egoNodeIds.has(id)) visibleIds.delete(id);
      }
    }

    // Remove edges where either endpoint was filtered out
    const fEdges = yearFilteredEdges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
    );

    // Final nodes: only those in visibleIds that still exist in node list
    const fNodes = nodes.filter((n) => visibleIds.has(n.id));

    return { filteredNodes: fNodes, filteredEdges: fEdges };
  }, [nodes, edges, yearFilteredEdges, deferredYearFilter, degreeMap, showOutliers, deferredMinDegree, activeTypes, egoNodeIds]);

  // 4. Only show edges connected to the active node (persists after closing panel)
  const displayEdges = useMemo(() => {
    if (showAllEdges) return filteredEdges;
    if (!activeNodeId) return [];
    return filteredEdges.filter(e => e.source === activeNodeId || e.target === activeNodeId);
  }, [filteredEdges, activeNodeId, showAllEdges]);

  // --- Graph search ---
  const graphSearchResults = useMemo(() => {
    const q = graphSearch.trim().toLowerCase();
    if (!q) return [];
    const qLower = q;
    return filteredNodes
      .filter((n) => n.data?.label?.toLowerCase().includes(qLower))
      .sort((a, b) => {
        const aLabel = (a.data?.label || '').toLowerCase();
        const bLabel = (b.data?.label || '').toLowerCase();
        const aPrefix = aLabel.startsWith(qLower) ? 0 : 1;
        const bPrefix = bLabel.startsWith(qLower) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return (b.data?.degree || 0) - (a.data?.degree || 0);
      })
      .slice(0, 8);
  }, [graphSearch, filteredNodes]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const file = e.target.files[0];
    const formData = new FormData();
    formData.append('file', file);
    try {
      await axios.post('/api/upload', formData);
      triggerInsights();
    } catch (err) {
      console.error(err);
    }
  };

  const handleNodeClick = useCallback((node: Node) => {
    setSelectedEdge(null);
    setSelectedNode(node);
    setActiveNodeId(node.id);
  }, []);

  const handleEvidenceNodeClick = useCallback((node: Node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
    setActiveNodeId(node.id);
    // Center the map on this node
    setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 800 });
  }, [setCenter]);

  const handleEdgeClick = useCallback((edge: Edge) => {
    setSelectedNode(null);
    setSelectedEdge(edge);
  }, []);

  const closePanel = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    // activeNodeId intentionally NOT cleared — edges stay visible
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    setActiveNodeId(null);
  }, []);

  const selectSearchResult = useCallback((node: Node) => {
    setGraphSearch('');
    setGraphSearchIndex(0);
    handleNodeClick(node);
    setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 800 });
  }, [handleNodeClick, setCenter]);

  // Click-outside to dismiss search
  useEffect(() => {
    if (!graphSearch) return;
    const handler = (e: MouseEvent) => {
      if (graphSearchRef.current && !graphSearchRef.current.contains(e.target as HTMLElement)) {
        setGraphSearch('');
        setGraphSearchIndex(0);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [graphSearch]);

  const sendQuery = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      sources: [],
      timestamp: Date.now(),
      isStreaming: false,
    };

    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      sources: [],
      timestamp: Date.now(),
      isStreaming: true,
      isInvestigation: true,
      steps: [],
      followUpQuestions: [],
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInputValue('');
    setIsStreaming(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const res = await fetch('/api/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let finalSources: any[] = [];
      let followUps: string[] = [];
      const stepsMap = new Map<string, any>();

      const processLines = (lines: string[]) => {
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            const eventType = data.type;

            if (eventType === 'step_status') {
              stepsMap.set(data.step, { step: data.step, label: data.label, status: data.status, detail: data.detail });
              const steps = Array.from(stepsMap.values());
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, steps } : m
              ));
            } else if (eventType === 'text' || (!eventType && data.text)) {
              fullText += data.text;
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: fullText } : m
              ));
            } else if (eventType === 'sources' || (!eventType && data.sources)) {
              finalSources = data.sources;
            } else if (eventType === 'follow_ups') {
              followUps = data.follow_ups || [];
            } else if (data.error) {
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, error: data.error, isStreaming: false } : m
              ));
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        processLines(lines);
      }

      // Flush any remaining data in the buffer after stream ends
      if (buffer.trim()) {
        processLines(buffer.split('\n'));
      }

      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, isStreaming: false, sources: finalSources, content: fullText || m.content, followUpQuestions: followUps }
          : m
      ));

      if (!fullText) {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, error: 'No response received from analysis.', isStreaming: false } : m
        ));
      }
    } catch (err: any) {
      console.error(err);
      const msg = err.name === 'AbortError' ? 'Investigation timed out' : `Analysis failed: ${err.message}`;
      toast.error(msg);
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, error: msg, isStreaming: false } : m
      ));
    } finally {
      clearTimeout(timeout);
      setIsStreaming(false);
    }
  };

  const handleSend = () => sendQuery(inputValue.trim());
  const handleSuggestedQuery = (query: string) => sendQuery(query);

  // --- Cases functions ---
  const loadCases = async () => {
    try {
      const res = await axios.get('/api/cases');
      setCases(res.data.cases || []);
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  };

  const runScan = async () => {
    setIsScanning(true);
    setScanFindings([]);
    try {
      const res = await axios.post('/api/cases/scan');
      setScanFindings(res.data.findings || []);
    } catch (err) {
      console.error('Scan failed:', err);
      toast.error('Scan failed');
    } finally {
      setIsScanning(false);
    }
  };

  const createCase = async (title: string, category: string) => {
    try {
      const res = await axios.post('/api/cases', {
        title,
        category,
        summary: '',
        confidence: 0,
        entities: [],
        suggested_questions: [],
        evidence_sources: [],
      });
      const newCase = res.data.case;
      setCases(prev => [newCase, ...prev]);
      setActiveCaseId(newCase.id);
    } catch (err) {
      console.error('Failed to create case:', err);
      toast.error('Failed to create case');
    }
  };

  const acceptFinding = async (finding: ScanFinding) => {
    try {
      const res = await axios.post('/api/cases', {
        title: finding.title,
        category: finding.category,
        summary: finding.summary,
        confidence: finding.confidence,
        entities: finding.entity_ids,
        suggested_questions: finding.suggested_questions,
        evidence_sources: finding.sources || [],
      });
      const newCase = res.data.case;
      setCases(prev => [newCase, ...prev]);
      setScanFindings(prev => prev.filter(f => f.title !== finding.title));
      setActiveCaseId(newCase.id);
    } catch (err) {
      console.error('Failed to create case:', err);
      toast.error('Failed to accept finding');
    }
  };

  const dismissFinding = (finding: ScanFinding) => {
    setScanFindings(prev => prev.filter(f => f.title !== finding.title));
  };

  const acceptAllFindings = async () => {
    for (const f of scanFindings) {
      await acceptFinding(f);
    }
  };

  const investigateTheory = async (theory: string, caseIds: string[], attachedCaseId?: string, mode: 'files_only' | 'files_web' = 'files_only') => {
    setIsTestingTheory(true);
    const initial: TheoryResult = { verdict: null, reportText: '', sources: [], steps: [], theory, entitySuggestions: [] };
    setTheoryResult(initial);
    theoryResultRef.current = initial;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000); // Increased timeout for web search
    try {
      const authToken = localStorage.getItem('auth_token');
      const res = await fetch('/api/theories/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ theory, case_ids: caseIds, mode }),
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No reader');
      const decoder = new TextDecoder();
      let buffer = '';
      let latestResult = initial;

      const updateResult = (updater: (prev: TheoryResult) => TheoryResult) => {
        latestResult = updater(latestResult);
        theoryResultRef.current = latestResult;
        setTheoryResult(latestResult);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'step_status') {
              updateResult(prev => {
                const existing = prev.steps.findIndex((s: InvestigationStep) => s.step === evt.step);
                const newStep: InvestigationStep = { step: evt.step, label: evt.label, status: evt.status, detail: evt.detail };
                const steps = existing >= 0
                  ? prev.steps.map((s: InvestigationStep, i: number) => i === existing ? newStep : s)
                  : [...prev.steps, newStep];
                return { ...prev, steps };
              });
            } else if (evt.type === 'text') {
              updateResult(prev => ({ ...prev, reportText: prev.reportText + (evt.text || '') }));
            } else if (evt.type === 'sources') {
              updateResult(prev => ({ ...prev, sources: (evt.sources || []) as Source[] }));
            } else if (evt.type === 'web_sources') {
              updateResult(prev => ({ ...prev, webSources: (evt.web_sources || []) as WebSource[] }));
            } else if (evt.type === 'entity_suggestions') {
              updateResult(prev => ({ ...prev, entitySuggestions: evt.entities || [] }));
            } else if (evt.type === 'theory_verdict') {
              const { type: _, entity_suggestions: es, ...verdictData } = evt;
              updateResult(prev => ({
                ...prev,
                verdict: verdictData,
                entitySuggestions: prev.entitySuggestions.length > 0 ? prev.entitySuggestions : (es || []),
              }));
            } else if (evt.type === 'done') {
              // stream finished, no-op
            }
          } catch { /* skip malformed */ }
        }
      }

      // Auto-transition to TheoryInvestigation view
      if (latestResult.verdict) {
        setActiveTheorySession({
          theory,
          result: latestResult,
          followUpMessages: [],
          attachedCaseId: attachedCaseId || null,
        });
      }
    } catch (err: any) {
      console.error('Theory investigation failed:', err);
      toast.error(err.name === 'AbortError' ? 'Theory investigation timed out' : 'Theory investigation failed');
    } finally {
      clearTimeout(timeout);
      setIsTestingTheory(false);
    }
  };

  const acceptTheory = async () => {
    const src = activeTheorySession?.result || theoryResult;
    if (!src?.verdict) return;
    const v = src.verdict;
    const attachedCaseId = activeTheorySession?.attachedCaseId;

    try {
      if (attachedCaseId) {
        // Save theory results as evidence to the existing case
        const theoryLabel = src.theory.length > 100 ? src.theory.slice(0, 100) + '...' : src.theory;
        const evidenceContent = `## Theory Investigation: ${theoryLabel}\n\n**Verdict:** ${v.verdict.replace('_', ' ')} (${Math.round(v.confidence * 100)}% confidence)\n**Supporting:** ${v.supporting_count} | **Contradicting:** ${v.contradicting_count}\n\n${src.reportText}`;
        await axios.post(`/api/cases/${attachedCaseId}/notes`, {
          content: evidenceContent,
        });
        toast.success('Theory results saved to case');
        setTheoryResult(null);
        setActiveTheorySession(null);
        // Stay on the case — activeCaseId is already set
      } else {
        // No attached case — create a new one
        const res = await axios.post('/api/cases', {
          title: `Theory: ${src.theory.slice(0, 80)}`,
          category: v.category || 'other',
          summary: src.reportText.slice(0, 2000),
          confidence: v.confidence,
          entities: v.entities,
          suggested_questions: v.suggested_questions,
          evidence_sources: [],
        });
        const newCase = res.data.case;
        setCases(prev => [newCase, ...prev]);
        setActiveCaseId(newCase.id);
        setTheoryResult(null);
        setActiveTheorySession(null);
      }
    } catch (err) {
      console.error('Failed to save theory:', err);
      toast.error(attachedCaseId ? 'Failed to save theory to case' : 'Failed to create case from theory');
    }
  };

  const dismissTheory = () => {
    setTheoryResult(null);
    setActiveTheorySession(null);
  };

  const sendTheoryFollowUp = async (message: string, mode: 'files_only' | 'files_web' = 'files_only') => {
    if (!activeTheorySession || isFollowUpStreaming) return;

    const userMsg: TheoryFollowUpMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      sources: [],
      isStreaming: false,
    };
    const assistantId = crypto.randomUUID();
    const assistantMsg: TheoryFollowUpMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      sources: [],
      isStreaming: true,
    };

    setActiveTheorySession(prev => prev ? {
      ...prev,
      followUpMessages: [...prev.followUpMessages, userMsg, assistantMsg],
    } : prev);
    setIsFollowUpStreaming(true);

    // Build context for the API
    const result = activeTheorySession.result;
    const verdictSummary = result.verdict
      ? `${result.verdict.verdict} (${Math.round(result.verdict.confidence * 100)}% confidence). ${result.verdict.supporting_count} supporting, ${result.verdict.contradicting_count} contradicting.`
      : 'No verdict available.';
    const entityContext = result.entitySuggestions
      .filter(e => e.on_graph)
      .map(e => `${e.name} (${e.type}, ${e.edge_count} connections)`)
      .join('; ');
    const evidenceSummary = result.reportText.slice(0, 3000);
    const allMessages = [
      ...activeTheorySession.followUpMessages
        .filter(m => !m.isStreaming)
        .map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: message },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const followUpAuthToken = localStorage.getItem('auth_token');
      const res = await fetch('/api/theories/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(followUpAuthToken ? { Authorization: `Bearer ${followUpAuthToken}` } : {}) },
        body: JSON.stringify({
          theory: activeTheorySession.theory,
          verdict_summary: verdictSummary,
          entity_context: entityContext,
          evidence_summary: evidenceSummary,
          messages: allMessages,
          mode
        }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No reader');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let finalSources: Source[] = [];
      let finalWebSources: WebSource[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'text') {
              fullText += evt.text || '';
              setActiveTheorySession(prev => prev ? {
                ...prev,
                followUpMessages: prev.followUpMessages.map(m =>
                  m.id === assistantId ? { ...m, content: fullText } : m
                ),
              } : prev);
            } else if (evt.type === 'sources') {
              finalSources = evt.sources || [];
            } else if (evt.type === 'web_sources') {
              finalWebSources = evt.web_sources || [];
            } else if (evt.type === 'entity_suggestions') {
              // Merge new entity suggestions
              const newEntities: TheoryEntitySuggestion[] = evt.entities || [];
              if (newEntities.length > 0) {
                setActiveTheorySession(prev => {
                  if (!prev) return prev;
                  const existing = new Set(prev.result.entitySuggestions.map(e => e.name.toLowerCase()));
                  const toAdd = newEntities.filter(e => !existing.has(e.name.toLowerCase()));
                  if (toAdd.length === 0) return prev;
                  return {
                    ...prev,
                    result: {
                      ...prev.result,
                      entitySuggestions: [...prev.result.entitySuggestions, ...toAdd],
                    },
                  };
                });
              }
            }
          } catch { /* skip malformed */ }
        }
      }

      // Finalize the assistant message
      setActiveTheorySession(prev => prev ? {
        ...prev,
        followUpMessages: prev.followUpMessages.map(m =>
          m.id === assistantId ? { ...m, isStreaming: false, content: fullText || m.content, sources: finalSources, webSources: finalWebSources } : m
        ),
      } : prev);
    } catch (err: any) {
      console.error('Follow-up failed:', err);
      const errMsg = err.name === 'AbortError' ? 'Follow-up timed out' : `Follow-up failed: ${err.message}`;
      toast.error(errMsg);
      setActiveTheorySession(prev => prev ? {
        ...prev,
        followUpMessages: prev.followUpMessages.map(m =>
          m.id === assistantId ? { ...m, isStreaming: false, content: errMsg } : m
        ),
      } : prev);
    } finally {
      clearTimeout(timeout);
      setIsFollowUpStreaming(false);
    }
  };

  const addTheoryEntity = (entity: TheoryEntitySuggestion) => {
    if (!entity.on_graph || !entity.id) {
      toast('This entity is not in the knowledge graph yet', { description: 'Discovered in documents — research it manually.' });
      return;
    }
    if (!activeTheorySession?.attachedCaseId) {
      toast('No case attached', { description: 'Accept this theory as a case first to add entities to it.' });
      return;
    }
    axios.post(`/api/cases/${activeTheorySession.attachedCaseId}/graph/entities`, {
      node_ids: [entity.id],
    }).then(() => {
      toast.success(`Added ${entity.name} to case graph`);
    }).catch(() => {
      toast.error(`Failed to add ${entity.name}`);
    });
  };

  const updateCaseStatus = async (caseId: string, status: string) => {
    try {
      await axios.patch(`/api/cases/${caseId}`, { status });
      setCases(prev => prev.map(c => c.id === caseId ? { ...c, status: status as Case['status'] } : c));
    } catch (err) {
      console.error('Failed to update case:', err);
      toast.error('Failed to update case');
    }
  };

  const updateCaseFields = async (caseId: string, fields: Partial<Pick<Case, 'title' | 'category' | 'summary' | 'is_public'>>) => {
    try {
      const res = await axios.patch(`/api/cases/${caseId}`, fields);
      const updated = res.data.case;
      setCases(prev => prev.map(c => c.id === caseId ? { ...c, ...updated } : c));
    } catch (err) {
      console.error('Failed to update case:', err);
      toast.error('Failed to update case');
    }
  };

  const deleteCase = async (caseId: string) => {
    try {
      await axios.delete(`/api/cases/${caseId}`);
      setCases(prev => prev.filter(c => c.id !== caseId));
      if (activeCaseId === caseId) setActiveCaseId(null);
    } catch (err) {
      console.error('Failed to delete case:', err);
      toast.error('Failed to delete case');
    }
  };

  // Refresh cases when switching to cases tab
  useEffect(() => {
    if (activeView === 'cases') loadCases();
  }, [activeView]);

  const tabs: { id: View; label: string; icon: typeof MessageSquare }[] = [
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'cases', label: 'Cases', icon: Shield },
    { id: 'graph', label: 'Graph', icon: Network },
    { id: 'urls', label: 'URLs', icon: Globe },
    ...(isAdmin ? [{ id: 'docs' as View, label: 'Docs', icon: Database }] : []),
    ...(isAdmin ? [{ id: 'data' as View, label: 'Data', icon: HardDrive }] : []),
  ];

  const SyncOverlay = () => (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm px-10 text-center">
      <Loader2 size={40} className="text-[#007AFF] animate-spin mb-6" />
      <p className="text-[17px] font-bold text-white mb-2">{syncStatus || 'Processing...'}</p>
      <p className="text-[13px] text-[rgba(235,235,245,0.4)] mb-8">This involves deep AI analysis and may take a moment</p>
      
      <div className="w-full max-w-md h-1.5 bg-[#1C1C1E] rounded-full overflow-hidden border border-white/5">
        <div 
          className="h-full bg-[#007AFF] transition-all duration-500 ease-out shadow-[0_0_10px_#007AFF]"
          style={{ width: `${syncProgress}%` }}
        />
      </div>
      <p className="mt-3 text-[11px] font-mono text-[#007AFF] uppercase tracking-widest">{Math.round(syncProgress)}% Complete</p>
    </div>
  );

  return (
    <div className="h-dvh flex flex-col bg-black text-white font-sans overflow-hidden" style={{ height: '100dvh' }}>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden">

        {activeView === 'chat' && (
          <>
            {/* iOS Large Title Header with Status Pill */}
            <header className="shrink-0 px-5 pt-4 pb-2 bg-black">
              <div className="flex items-center justify-between">
                <h1 className="text-[28px] font-bold tracking-tight text-white">Chat</h1>
                <button
                  onClick={() => triggerInsights('standard')}
                  disabled={isSyncing}
                  className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full text-[13px] font-medium border border-[rgba(84,84,88,0.65)]"
                >
                  <div className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-[#FF9F0A] animate-pulse' : graphLoading ? 'bg-[#007AFF] animate-pulse' : 'bg-[#30D158]'}`} />
                  <span className="text-[rgba(235,235,245,0.6)]">
                    {isSyncing ? 'Syncing...' : graphLoading ? 'Loading...' : `${nodes.length} entities`}
                  </span>
                  <RefreshCw size={12} className={`text-[rgba(235,235,245,0.3)] ${isSyncing || graphLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </header>

            <ChatArea messages={messages} onSuggestedQuery={handleSuggestedQuery} />

            <InputBar
              value={inputValue}
              onChange={setInputValue}
              onSend={handleSend}
              isStreaming={isStreaming}
              topK={topK}
              onTopKChange={setTopK}
              docTypeFilter={docTypeFilter}
              onDocTypeFilterChange={setDocTypeFilter}
              personFilter={personFilter}
              onPersonFilterChange={setPersonFilter}
              orgFilter={orgFilter}
              onOrgFilterChange={setOrgFilter}
              readOnly={readOnly}
              isLoggedIn={!!user}
              onUpgrade={() => setShowUpgradeModal(true)}
            />
          </>
        )}

        {activeView === 'graph' && (
          <div className="flex-1 flex flex-col h-full relative">
            <header className="shrink-0 bg-black">
              {/* Row 1: Title + Search + Filter toggle */}
              <div className="flex items-center gap-3 px-5 pt-4 pb-2">
                <h1 className="text-[28px] font-bold tracking-tight text-white shrink-0">Graph</h1>

                {/* Search */}
                <div ref={graphSearchRef} className="relative flex-1 min-w-0">
                  <div className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full border border-[rgba(84,84,88,0.65)] focus-within:border-[#007AFF] transition-colors">
                    <Search size={14} className="text-[rgba(235,235,245,0.3)] shrink-0" />
                    <input
                      type="text"
                      value={graphSearch}
                      onChange={(e) => { setGraphSearch(e.target.value); setGraphSearchIndex(0); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { setGraphSearch(''); setGraphSearchIndex(0); }
                        if (!graphSearchResults.length) return;
                        if (e.key === 'ArrowDown') { e.preventDefault(); setGraphSearchIndex(i => (i + 1) % graphSearchResults.length); }
                        if (e.key === 'ArrowUp') { e.preventDefault(); setGraphSearchIndex(i => (i - 1 + graphSearchResults.length) % graphSearchResults.length); }
                        if (e.key === 'Enter') { e.preventDefault(); selectSearchResult(graphSearchResults[graphSearchIndex]); }
                      }}
                      placeholder="Search entities..."
                      className="bg-transparent text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none w-full"
                    />
                  </div>

                  {/* Search results dropdown */}
                  {graphSearchResults.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl overflow-hidden shadow-2xl z-50 max-h-[320px] overflow-y-auto">
                      {graphSearchResults.map((node, i) => {
                        const entityType = (node.data?.entityType || '').toUpperCase();
                        const typeColors: Record<string, string> = {
                          PERSON: '#60a5fa', ORGANIZATION: '#fbbf24', LOCATION: '#4ade80',
                          EVENT: '#a78bfa', DOCUMENT: '#fb923c', FINANCIAL_ENTITY: '#f87171',
                        };
                        const color = typeColors[entityType] || '#9ca3af';
                        return (
                          <button
                            key={node.id}
                            onClick={() => selectSearchResult(node)}
                            onMouseEnter={() => setGraphSearchIndex(i)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                              i === graphSearchIndex ? 'bg-[#007AFF]/20' : 'hover:bg-[#2C2C2E]'
                            }`}
                          >
                            <div
                              className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                              style={{ backgroundColor: `${color}20` }}
                            >
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                            </div>
                            <div className="flex-1 overflow-hidden">
                              <p className="text-[13px] font-medium text-white truncate">{node.data?.label}</p>
                              <p className="text-[10px] uppercase tracking-wider font-bold" style={{ color }}>{entityType}</p>
                            </div>
                            <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono shrink-0">{node.data?.degree || 0}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <button
                  onClick={() => setGraphFiltersOpen(!graphFiltersOpen)}
                  className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                    graphFiltersOpen
                      ? 'bg-[#007AFF] text-white'
                      : 'bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.6)] hover:text-white'
                  }`}
                  title="Graph Filters"
                >
                  <SlidersHorizontal size={16} />
                </button>
              </div>

              {/* Collapsible filter drawer */}
              {graphFiltersOpen && (
                <div className="flex flex-wrap items-center gap-2 px-5 pb-3 pt-1 border-t border-[rgba(84,84,88,0.3)]">
                  <div className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full border border-[rgba(84,84,88,0.65)]">
                    <span className="text-[13px] font-mono text-[rgba(235,235,245,0.6)]">
                      {yearFilter >= 2026 ? 'All' : yearFilter}
                    </span>
                    <input
                      type="range" min="1980" max="2026" value={yearFilter}
                      onChange={(e) => setYearFilter(parseInt(e.target.value))}
                      className="w-20 h-1 bg-[#3A3A3C] rounded-lg appearance-none cursor-pointer accent-[#007AFF]"
                    />
                  </div>
                  <div className="flex items-center gap-1 bg-[#1C1C1E] px-2 py-1.5 rounded-full border border-[rgba(84,84,88,0.65)]">
                    <button
                      onClick={() => setMinDegree(Math.max(0, minDegree - 10))}
                      className="p-1 hover:bg-[#2C2C2E] rounded-full transition-colors text-[rgba(235,235,245,0.6)]"
                      title="Decrease connections threshold by 10"
                    >
                      <Minus size={14} />
                    </button>
                    <input
                      type="text"
                      defaultValue={minDegree === 0 ? 'All' : `${minDegree}+`}
                      key={minDegree}
                      onFocus={(e) => {
                        e.target.value = minDegree === 0 ? '' : String(minDegree);
                        e.target.select();
                      }}
                      onBlur={(e) => {
                        const raw = e.target.value.replace(/[^0-9]/g, '');
                        const val = raw === '' ? 0 : parseInt(raw, 10);
                        setMinDegree(val);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      className="text-[13px] font-mono text-[rgba(235,235,245,0.6)] min-w-[40px] w-[48px] text-center bg-transparent outline-none border-none"
                    />
                    <button
                      onClick={() => setMinDegree(minDegree + 10)}
                      className="p-1 hover:bg-[#2C2C2E] rounded-full transition-colors text-[rgba(235,235,245,0.6)]"
                      title="Increase connections threshold by 10"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <button
                    onClick={() => setShowOutliers(!showOutliers)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium transition-all border border-[rgba(84,84,88,0.65)] ${
                      showOutliers ? 'bg-[#1C1C1E] text-[rgba(235,235,245,0.6)] hover:bg-[#2C2C2E]' : 'bg-[#FF9F0A] text-white border-[#FF9F0A]'
                    }`}
                    title={showOutliers ? "Hide Outliers (1 connection)" : "Show All Outliers"}
                  >
                    <CircleOff size={14} />
                    {showOutliers ? 'Outliers On' : 'Outliers Off'}
                  </button>
                  <button
                    onClick={() => setShowEdgeLabels(!showEdgeLabels)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium transition-all border border-[rgba(84,84,88,0.65)] ${
                      showEdgeLabels ? 'bg-[#007AFF] text-white border-[#007AFF]' : 'bg-[#1C1C1E] text-[rgba(235,235,245,0.6)] hover:bg-[#2C2C2E]'
                    }`}
                    title={showEdgeLabels ? "Hide Relationship Labels" : "Show Relationship Labels"}
                  >
                    <Type size={14} />
                    {showEdgeLabels ? 'Labels On' : 'Labels Off'}
                  </button>
                  <button
                    onClick={() => setShowAllEdges(!showAllEdges)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium transition-all border border-[rgba(84,84,88,0.65)] ${
                      showAllEdges ? 'bg-[#007AFF] text-white border-[#007AFF]' : 'bg-[#1C1C1E] text-[rgba(235,235,245,0.6)] hover:bg-[#2C2C2E]'
                    }`}
                    title={showAllEdges ? "Hide All Edges" : "Show All Edges"}
                  >
                    <Network size={14} />
                    {showAllEdges ? 'All Edges' : 'Edges Off'}
                  </button>
                  {/* Entity type filter pills */}
                  {(() => {
                    const TYPE_COLORS: Record<string, string> = {
                      PERSON: '#60a5fa', ORGANIZATION: '#fbbf24', LOCATION: '#4ade80',
                      EVENT: '#a78bfa', DOCUMENT: '#fb923c', FINANCIAL_ENTITY: '#f87171',
                    };
                    const availableTypes = Array.from(new Set(
                      nodes.map(n => (n.data?.entityType || n.data?.type || '').toUpperCase()).filter(Boolean)
                    )).sort();
                    if (availableTypes.length === 0) return null;
                    return availableTypes.map(t => {
                      const active = activeTypes.has(t);
                      const color = TYPE_COLORS[t] || '#9ca3af';
                      return (
                        <button
                          key={t}
                          onClick={() => {
                            setActiveTypes(prev => {
                              const next = new Set(prev);
                              if (next.has(t)) next.delete(t); else next.add(t);
                              return next;
                            });
                          }}
                          className="px-3 py-1.5 rounded-full text-[13px] font-medium transition-all border"
                          style={{
                            backgroundColor: active ? color : '#1C1C1E',
                            borderColor: active ? color : 'rgba(84,84,88,0.65)',
                            color: active ? '#000' : 'rgba(235,235,245,0.6)',
                          }}
                        >
                          {t.charAt(0) + t.slice(1).toLowerCase().replace('_', ' ')}
                        </button>
                      );
                    });
                  })()}
                  <button
                    onClick={onLayout}
                    disabled={isLayouting}
                    className="flex items-center gap-1.5 bg-[#1C1C1E] hover:bg-[#2C2C2E] px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.6)] disabled:opacity-50"
                  >
                    {isLayouting && <Loader2 size={12} className="animate-spin" />}
                    Web Layout
                  </button>
                </div>
              )}
            </header>
            <div className="flex-1 relative">
              {/* Ego focus bar */}
              {focusNodeId && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-[#1C1C1E]/95 backdrop-blur-md border border-[#007AFF]/40 rounded-full px-4 py-2 shadow-lg shadow-black/40">
                  <Crosshair size={14} className="text-[#007AFF] shrink-0" />
                  <span className="text-[13px] font-semibold text-white max-w-[160px] truncate">
                    {nodes.find(n => n.id === focusNodeId)?.data?.label || 'Entity'}
                  </span>
                  <div className="w-px h-4 bg-[rgba(84,84,88,0.65)]" />
                  <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Depth</span>
                  <button
                    onClick={() => setFocusDepth(d => Math.max(1, d - 1))}
                    className="w-6 h-6 rounded-full bg-[#2C2C2E] flex items-center justify-center text-[rgba(235,235,245,0.6)] hover:bg-[#3A3A3C] transition-colors"
                    disabled={focusDepth <= 1}
                  >
                    <Minus size={12} />
                  </button>
                  <span className="text-[13px] font-mono text-[#007AFF] w-4 text-center">{focusDepth}</span>
                  <button
                    onClick={() => setFocusDepth(d => Math.min(5, d + 1))}
                    className="w-6 h-6 rounded-full bg-[#2C2C2E] flex items-center justify-center text-[rgba(235,235,245,0.6)] hover:bg-[#3A3A3C] transition-colors"
                    disabled={focusDepth >= 5}
                  >
                    <Plus size={12} />
                  </button>
                  <div className="w-px h-4 bg-[rgba(84,84,88,0.65)]" />
                  <span className="text-[11px] text-[rgba(235,235,245,0.4)]">{filteredNodes.length} nodes</span>
                  <button
                    onClick={exitFocus}
                    className="w-6 h-6 rounded-full bg-[#FF453A]/20 flex items-center justify-center text-[#FF453A] hover:bg-[#FF453A]/30 transition-colors"
                    title="Exit focus mode"
                  >
                    <X size={12} />
                  </button>
                </div>
              )}

              {/* Loading overlay */}
              {(isExtractingInsights || isLayouting) && (
                <SyncOverlay />
              )}

              {/* Graph loading indicator */}
              {graphLoading && !isExtractingInsights && !isLayouting && (
                <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
                  <Loader2 size={36} className="text-[#007AFF] animate-spin mb-4" />
                  <p className="text-[15px] font-medium text-white">Loading entities...</p>
                  <p className="text-[12px] text-[rgba(235,235,245,0.35)] mt-1.5">Building the knowledge graph</p>
                </div>
              )}

              {/* Empty state */}
              {!isExtractingInsights && !isLayouting && !graphLoading && nodes.length === 0 && (
                <div className="absolute inset-0 z-40 flex flex-col items-center justify-center">
                  <Network size={48} className="text-[rgba(235,235,245,0.2)] mb-4" />
                  <p className="text-[15px] font-medium text-[rgba(235,235,245,0.6)]">No entities found</p>
                  <p className="text-[13px] text-[rgba(235,235,245,0.3)] mt-1">Upload PDFs in the Docs tab to build the graph</p>
                </div>
              )}

              <GraphPanel
                open={true}
                onClose={() => {}}
                nodes={filteredNodes}
                edges={displayEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStop={onNodeDragStop}
                onNodeClick={handleNodeClick}
                onEdgeClick={handleEdgeClick}
                onPaneClick={handlePaneClick}
                yearFilter={yearFilter}
                onYearFilterChange={setYearFilter}
                onLayout={onLayout}
                communities={communities}
                minDegree={minDegree}
                onMinDegreeChange={setMinDegree}
                showEdgeLabels={showEdgeLabels}
              />
            </div>
          </div>
        )}

        {activeView === 'docs' && (
          <div className="flex-1 flex flex-col overflow-y-auto relative">
            {isExtractingInsights && <SyncOverlay />}
            <header className="shrink-0 px-5 pt-4 pb-2 bg-black">
              <h1 className="text-[28px] font-bold tracking-tight text-white">Docs</h1>
            </header>
            <div className="flex-1 px-5 pb-4">
              <div className="max-w-4xl mx-auto w-full">
                <div className="flex justify-between items-center mb-6">
                  <p className="text-[rgba(235,235,245,0.6)] text-[15px]">Upload and manage documents for analysis.</p>

                  <label className="flex items-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] px-4 py-2 rounded-full text-[15px] font-semibold cursor-pointer transition-colors active:scale-95">
                    <Upload size={16} />
                    Upload PDF
                    <input type="file" className="hidden" onChange={handleUpload} />
                  </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6">
                     <h3 className="font-semibold mb-4 text-[15px] flex items-center gap-2 text-white">
                       <Network size={16} className="text-[#007AFF]" />
                       Graph Builder
                     </h3>
                     <p className="text-[11px] text-[rgba(235,235,245,0.3)] mb-3 -mt-2">Extract entities and relationships from your documents to build the knowledge graph.</p>
                     <div className="space-y-3">
                       <button
                         onClick={() => triggerInsights('standard')}
                         disabled={isSyncing}
                         className="w-full flex flex-col items-start gap-1 p-3 rounded-xl bg-black/40 border border-white/5 hover:bg-black/60 transition-colors group text-left"
                       >
                         <span className="text-[13px] font-bold text-white group-hover:text-[#007AFF]">Standard Sync</span>
                         <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Samples 10 documents per topic (people, orgs, locations, finances, events, crimes, assets). Quick overview of key entities. ~1 min.</span>
                       </button>

                       <button
                         onClick={() => triggerInsights('deep')}
                         disabled={isSyncing}
                         className="w-full flex flex-col items-start gap-1 p-3 rounded-xl bg-black/40 border border-white/5 hover:bg-black/60 transition-colors group text-left"
                       >
                         <span className="text-[13px] font-bold text-white group-hover:text-[#FF9F0A]">Deep Sync</span>
                         <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Samples 25 documents per topic. Captures more entities, aliases, and nuanced relationships. ~3 min.</span>
                       </button>

                       <button
                         onClick={() => triggerInsights('full')}
                         disabled={isSyncing}
                         className="w-full flex flex-col items-start gap-1 p-3 rounded-xl bg-[#007AFF]/10 border border-[#007AFF]/30 hover:bg-[#007AFF]/20 transition-colors group text-left"
                       >
                         <span className="text-[13px] font-bold text-[#007AFF]">Full Reconstruction</span>
                         <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Samples 50 documents per topic for maximum entity density. Best for building an initial comprehensive graph. ~10 min.</span>
                       </button>

                       <button
                         onClick={async () => {
                           setIsExtractingInsights(true);
                           setIsSyncing(true);
                           setSyncProgress(5);
                           setSyncStatus('Deduplicating graph...');
                           const interval = setInterval(() => {
                             setSyncProgress(prev => (prev < 90 ? prev + Math.random() * 3 : prev));
                           }, 1500);
                           try {
                             const res = await axios.post('/api/graph/deduplicate');
                             const { merged, removed_nodes, removed_edges } = res.data;
                             if (merged === 0) {
                               setSyncStatus('No duplicates found');
                             } else {
                               setSyncStatus(`Merged ${merged} groups, removed ${removed_nodes} nodes, ${removed_edges} duplicate edges`);
                             }
                             setSyncProgress(95);
                             await loadGraph();
                             if (merged > 0) setActiveView('graph');
                           } catch (err) {
                             console.error('Deduplication failed:', err);
                             setSyncStatus('Deduplication failed. Please try again.');
                           } finally {
                             clearInterval(interval);
                             setSyncProgress(100);
                             setTimeout(() => {
                               setIsSyncing(false);
                               setIsExtractingInsights(false);
                               setSyncProgress(0);
                               setSyncStatus('');
                             }, 1500);
                           }
                         }}
                         disabled={isSyncing}
                         className="w-full flex flex-col items-start gap-1 p-3 rounded-xl bg-black/40 border border-white/5 hover:bg-black/60 transition-colors group text-left"
                       >
                         <span className="text-[13px] font-bold text-white group-hover:text-[#FF453A]">Deduplicate Graph</span>
                         <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Scans all entities for duplicates using AI fuzzy matching, merges them, and rewires their edges. Run after large extractions.</span>
                       </button>


                       <div className="pt-2 mt-2 border-t border-white/5">
                          <label className="text-[11px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider mb-1 block">
                            Keyword Search &amp; Network Builder
                          </label>
                          <p className="text-[10px] text-[rgba(235,235,245,0.25)] mb-2">Search documents by keyword, then extract entities from matching results into the graph.</p>
                          {/* Search mode toggle */}
                          <div className="flex gap-1 mb-2">
                            <button
                              onClick={() => { setSearchMode('fulltext'); setTargetedResults(null); setSearchPage(1); }}
                              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${searchMode === 'fulltext' ? 'bg-[#007AFF] text-white' : 'bg-white/5 text-[rgba(235,235,245,0.4)] hover:bg-white/10'}`}
                            >
                              Full Text
                            </button>
                            <button
                              onClick={() => { setSearchMode('exact'); setTargetedResults(null); setSearchPage(1); }}
                              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${searchMode === 'exact' ? 'bg-[#007AFF] text-white' : 'bg-white/5 text-[rgba(235,235,245,0.4)] hover:bg-white/10'}`}
                            >
                              Exact Match
                            </button>
                          </div>
                          <form
                            className="flex gap-2 mb-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (!focusTarget.trim() || isTargetedSearching) return;
                              setIsTargetedSearching(true);
                              setTargetedResults(null);
                              setExpandedChunks(new Set());
                              setSearchPage(1);
                              axios.post('/api/search/targeted', { keyword: focusTarget.trim(), page: 1, page_size: 50, search_mode: searchMode })
                                .then(res => setTargetedResults(res.data))
                                .catch(err => console.error('Targeted search failed:', err))
                                .finally(() => setIsTargetedSearching(false));
                            }}
                          >
                            <input
                              type="text"
                              value={focusTarget}
                              onChange={(e) => { setFocusTarget(e.target.value); setTargetedResults(null); setSearchPage(1); }}
                              placeholder="e.g. Trump, Epstein, Boeing..."
                              className="flex-1 bg-black/40 border border-[rgba(84,84,88,0.65)] rounded-lg px-3 py-2 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-white/20"
                            />
                            <button
                              type="submit"
                              disabled={!focusTarget.trim() || isTargetedSearching}
                              onTouchEnd={(e) => {
                                e.preventDefault();
                                if (!focusTarget.trim() || isTargetedSearching) return;
                                (e.target as HTMLElement).closest('form')?.requestSubmit();
                              }}
                              className="bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg font-medium text-[13px] transition-colors shadow-[0_0_10px_rgba(0,122,255,0.3)] flex items-center gap-1.5"
                            >
                              {isTargetedSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                              Search
                            </button>
                          </form>

                          {/* Results area */}
                          {targetedResults && (
                            <div className="mt-3 space-y-2">
                              {/* Stats bar */}
                              <div className="flex items-center gap-2 text-[12px]">
                                <span className="text-[rgba(235,235,245,0.6)]">
                                  Found <span className="font-bold text-white">{targetedResults.stats.total_mentions.toLocaleString()} mentions</span> across <span className="font-bold text-white">{targetedResults.stats.unique_files} files</span>
                                  {targetedResults.stats.total_pages > 1 && (
                                    <span className="ml-1 text-[rgba(235,235,245,0.3)]">
                                      — page {targetedResults.stats.page} of {targetedResults.stats.total_pages.toLocaleString()}
                                    </span>
                                  )}
                                </span>
                              </div>

                              {/* Chunk list */}
                              {targetedResults.chunks.length > 0 && (
                                <div className="max-h-[400px] overflow-y-auto rounded-lg border border-white/5 bg-black/30">
                                  {targetedResults.chunks.map((chunk) => {
                                    const isExpanded = expandedChunks.has(chunk.id);
                                    return (
                                      <button
                                        key={chunk.id}
                                        onClick={() => setExpandedChunks(prev => {
                                          const next = new Set(prev);
                                          if (next.has(chunk.id)) next.delete(chunk.id);
                                          else next.add(chunk.id);
                                          return next;
                                        })}
                                        className="w-full text-left px-3 py-2 border-b border-white/5 last:border-b-0 hover:bg-white/5 transition-colors"
                                      >
                                        <div className="flex items-center gap-2 mb-1">
                                          <a
                                            href={getFileUrl(chunk.filename, chunk.page)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={(e) => e.stopPropagation()}
                                            className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#007AFF]/20 text-[#007AFF] shrink-0 hover:underline transition-colors"
                                          >
                                            {chunk.filename}
                                          </a>
                                          <a
                                            href={getFileUrl(chunk.filename, chunk.page)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            onClick={(e) => e.stopPropagation()}
                                            className="text-[10px] text-[rgba(235,235,245,0.3)] font-mono hover:underline transition-colors"
                                          >
                                            p.{chunk.page}
                                          </a>
                                        </div>
                                        <p className="text-[11px] text-[rgba(235,235,245,0.5)] leading-relaxed">
                                          {isExpanded ? chunk.text : chunk.text.slice(0, 200) + (chunk.text.length > 200 ? '...' : '')}
                                        </p>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}

                              {/* Pagination controls */}
                              {targetedResults.stats.total_pages > 1 && (
                                <div className="flex items-center justify-between">
                                  <button
                                    onClick={() => {
                                      const newPage = searchPage - 1;
                                      setSearchPage(newPage);
                                      setIsTargetedSearching(true);
                                      setExpandedChunks(new Set());
                                      axios.post('/api/search/targeted', { keyword: focusTarget.trim(), page: newPage, page_size: 50, search_mode: searchMode })
                                        .then(res => setTargetedResults(res.data))
                                        .catch(err => console.error('Targeted search failed:', err))
                                        .finally(() => setIsTargetedSearching(false));
                                    }}
                                    disabled={searchPage <= 1 || isTargetedSearching}
                                    className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-white/5 text-[rgba(235,235,245,0.6)] hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                  >
                                    Prev
                                  </button>
                                  <span className="text-[11px] text-[rgba(235,235,245,0.4)]">
                                    Page {targetedResults.stats.page} of {targetedResults.stats.total_pages.toLocaleString()}
                                  </span>
                                  <button
                                    onClick={() => {
                                      const newPage = searchPage + 1;
                                      setSearchPage(newPage);
                                      setIsTargetedSearching(true);
                                      setExpandedChunks(new Set());
                                      axios.post('/api/search/targeted', { keyword: focusTarget.trim(), page: newPage, page_size: 50, search_mode: searchMode })
                                        .then(res => setTargetedResults(res.data))
                                        .catch(err => console.error('Targeted search failed:', err))
                                        .finally(() => setIsTargetedSearching(false));
                                    }}
                                    disabled={searchPage >= targetedResults.stats.total_pages || isTargetedSearching}
                                    className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-white/5 text-[rgba(235,235,245,0.6)] hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                  >
                                    Next
                                  </button>
                                </div>
                              )}

                              {/* Build Network button */}
                              {targetedResults.stats.total_mentions > 0 && (
                                <button
                                  onClick={async () => {
                                    setIsExtractingInsights(true);
                                    setIsSyncing(true);
                                    setSyncProgress(2);
                                    const kw = focusTarget.trim();
                                    const totalChunks = targetedResults.stats.total_mentions;
                                    const batchSize = 25;
                                    const totalBatches = Math.ceil(totalChunks / batchSize);
                                    setSyncStatus(`Extracting from ${totalChunks.toLocaleString()} chunks — 0/${totalBatches} batches`);
                                    let offset = 0;
                                    let batchNum = 0;
                                    let totalEntities = 0;
                                    let totalTriples = 0;
                                    try {
                                      let hasMore = true;
                                      while (hasMore) {
                                        const res = await axios.post('/api/search/targeted', {
                                          keyword: kw,
                                          extract: true,
                                          search_mode: searchMode,
                                          batch_offset: offset,
                                          batch_size: batchSize,
                                        });
                                        const data = res.data;
                                        batchNum++;
                                        totalEntities += data.batch_entities || 0;
                                        totalTriples += data.batch_triples || 0;
                                        hasMore = data.has_more;
                                        offset = data.next_offset || (offset + batchSize);
                                        const pct = Math.min(95, 5 + (batchNum / totalBatches) * 90);
                                        setSyncProgress(pct);
                                        setSyncStatus(`Batch ${batchNum}/${totalBatches} — ${totalEntities.toLocaleString()} entities, ${totalTriples.toLocaleString()} relationships`);
                                      }
                                      setSyncProgress(100);
                                      if (totalEntities === 0) {
                                        setSyncStatus('No entities extracted — try a different keyword.');
                                      } else {
                                        setSyncStatus(`Done! ${totalEntities.toLocaleString()} entities, ${totalTriples.toLocaleString()} relationships`);
                                        await loadGraph();
                                        setActiveView('graph');
                                      }
                                      setTargetedResults(null);
                                    } catch (err) {
                                      console.error('Build network failed:', err);
                                      setSyncStatus('Extraction failed. Please try again.');
                                    } finally {
                                      setSyncProgress(100);
                                      setTimeout(() => {
                                        setIsSyncing(false);
                                        setIsExtractingInsights(false);
                                        setSyncProgress(0);
                                        setSyncStatus('');
                                      }, 2000);
                                    }
                                  }}
                                  disabled={isSyncing}
                                  className="w-full py-2 rounded-lg bg-[#30D158] hover:bg-[#28b84c] disabled:opacity-50 text-white text-[13px] font-bold transition-colors flex items-center justify-center gap-2"
                                >
                                  <Network size={14} />
                                  Build Network from {targetedResults.stats.total_mentions.toLocaleString()} Chunks
                                </button>
                              )}
                            </div>
                          )}
                       </div>
                     </div>
                  </div>

                  <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6 flex flex-col items-center justify-center text-center border-dashed min-h-[200px]">
                     <FileText size={40} className="text-[rgba(235,235,245,0.3)] mb-4" />
                     <h3 className="font-semibold text-white text-[15px]">No active files selected</h3>
                     <p className="text-[13px] text-[rgba(235,235,245,0.3)] mt-1 max-w-[200px]">Uploaded files will appear here once indexed by the GraphRAG engine.</p>
                  </div>

                  <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-6">
                     <h3 className="font-semibold mb-4 text-[15px] flex items-center gap-2 text-white">
                       <SettingsIcon size={16} className="text-[rgba(235,235,245,0.3)]" />
                       Indexing Configuration
                     </h3>
                     <div className="space-y-4">
                       <div>
                         <label className="text-[13px] font-medium text-[rgba(235,235,245,0.6)] block mb-2">Chunk Size</label>
                         <div className="h-1.5 w-full bg-[#3A3A3C] rounded-full">
                           <div className="h-full w-[60%] bg-[#007AFF] rounded-full" />
                         </div>
                       </div>
                       <div>
                         <label className="text-[13px] font-medium text-[rgba(235,235,245,0.6)] block mb-2">Confidence Threshold</label>
                         <div className="h-1.5 w-full bg-[#3A3A3C] rounded-full">
                           <div className="h-full w-[85%] bg-[#007AFF] rounded-full" />
                         </div>
                       </div>
                     </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeView === 'cases' && (
          activeTheorySession ? (
            <TheoryInvestigation
              session={activeTheorySession}
              onBack={() => setActiveTheorySession(null)}
              onSendFollowUp={sendTheoryFollowUp}
              isFollowUpStreaming={isFollowUpStreaming}
              onAcceptAsCase={acceptTheory}
              onDismiss={dismissTheory}
              onAddEntity={addTheoryEntity}
              readOnly={readOnly}
            />
          ) : activeCaseId ? (
            <CaseDetail
              caseId={activeCaseId}
              onBack={() => setActiveCaseId(null)}
              onStatusChange={updateCaseStatus}
              onUpdate={updateCaseFields}
              onDelete={deleteCase}
              onTheoryInvestigate={(theory: string) => investigateTheory(theory, [activeCaseId], activeCaseId)}
              isTestingTheory={isTestingTheory}
              theorySteps={theoryResult?.steps || []}
              theoryReportText={theoryResult?.reportText || ''}
              readOnly={readOnly}
            />
          ) : (
            <CasesPanel
              cases={cases}
              scanFindings={scanFindings}
              isScanning={isScanning}
              onScan={runScan}
              onAccept={acceptFinding}
              onDismiss={dismissFinding}
              onAcceptAll={acceptAllFindings}
              onOpenCase={setActiveCaseId}
              onCreateCase={createCase}
              onTheoryInvestigate={investigateTheory}
              isTestingTheory={isTestingTheory}
              theoryResult={theoryResult}
              onAcceptTheory={acceptTheory}
              onDismissTheory={dismissTheory}
              readOnly={readOnly}
            />
          )
        )}

        {activeView === 'urls' && (
          <UrlsPanel />
        )}

        {activeView === 'data' && (
          <DataPanel />
        )}

        {activeView === 'account' && (
          <AccountPanel onUpgrade={() => setShowUpgradeModal(true)} />
        )}

        {/* Evidence Panel (bottom sheet, works across views) */}
        <EvidencePanel
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          allEdges={edges}
          allNodes={nodes}
          onClose={closePanel}
          onNodeClick={handleEvidenceNodeClick}
          onFocusNode={handleFocusNode}
          focusNodeId={focusNodeId}
        />
      </main>

      {/* iOS Bottom Tab Bar */}
      <nav className="ios-tab-bar-blur bg-[rgba(28,28,30,0.88)] border-t border-[rgba(84,84,88,0.65)] shrink-0 pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-[50px]">
          {tabs.map(({ id, label, icon: Icon }) => {
            const isActive = activeView === id;
            return (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className="flex flex-col items-center justify-center gap-0.5 flex-1 h-full transition-colors"
              >
                <Icon size={22} className={isActive ? 'text-[#007AFF]' : 'text-[rgba(235,235,245,0.3)]'} />
                <span className={`text-[10px] font-medium ${isActive ? 'text-[#007AFF]' : 'text-[rgba(235,235,245,0.3)]'}`}>
                  {label}
                </span>
              </button>
            );
          })}
          <button
            onClick={() => {
              if (user) setActiveView('account');
              else setShowLoginModal(true);
            }}
            className="flex flex-col items-center justify-center gap-0.5 w-12 h-full transition-colors"
          >
            {user ? (
              <>
                <SettingsIcon size={20} className={activeView === 'account' ? 'text-[#007AFF]' : 'text-[rgba(235,235,245,0.3)]'} />
                <span className={`text-[10px] font-medium ${activeView === 'account' ? 'text-[#007AFF]' : 'text-[rgba(235,235,245,0.3)]'}`}>Account</span>
              </>
            ) : (
              <>
                <Lock size={20} className="text-[rgba(235,235,245,0.3)]" />
                <span className="text-[10px] font-medium text-[rgba(235,235,245,0.3)]">Login</span>
              </>
            )}
          </button>
        </div>
      </nav>

      {showLoginModal && (
        <LoginModal
          onClose={() => setShowLoginModal(false)}
        />
      )}

      {isRecovering && (
        <PasswordResetModal
          onClose={() => setIsRecovering(false)}
        />
      )}

      {showUpgradeModal && (
        <UpgradeModal
          onClose={() => setShowUpgradeModal(false)}
        />
      )}

    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <AppContent />
    </ReactFlowProvider>
  );
}

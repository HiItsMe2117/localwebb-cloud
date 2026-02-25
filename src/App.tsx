import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import GraphPanel from './components/GraphPanel';
import EvidencePanel from './components/EvidencePanel';
import DataPanel from './components/DataPanel';
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
  Plus,
  Minus,
  Type,
  Shield,
  Search,
  CircleOff,
} from 'lucide-react';
import { useNodesState, useEdgesState, ReactFlowProvider, useReactFlow } from 'reactflow';
import type { Node, Edge } from 'reactflow';
import axios from 'axios';
import { getLayoutedElements, computeDegreeMap } from './utils/layout';
import { getFileUrl } from './utils/files';
import CasesPanel from './components/CasesPanel';
import CaseDetail from './components/CaseDetail';
import type { ChatMessage, Community, Case, ScanFinding } from './types';

type View = 'chat' | 'graph' | 'docs' | 'data' | 'cases';

function AppContent() {
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
  const [minDegree, setMinDegree] = useState(1);
  const [showOutliers, setShowOutliers] = useState(true);
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);
  const [isLayouting, setIsLayouting] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncStatus, setSyncStatus] = useState('');
  const [focusTarget, setFocusTarget] = useState('');

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

  // Graph search state
  const [graphSearch, setGraphSearch] = useState('');
  const [graphSearchIndex, setGraphSearchIndex] = useState(0);
  const graphSearchRef = useRef<HTMLDivElement>(null);

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

  const loadGraph = async () => {
    try {
      console.log("Fetching graph data from /api/graph...");
      const res = await axios.get('/api/graph');
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

        const uniquePositions = new Set(enriched.map((n) => `${Math.round(n.position.x)},${Math.round(n.position.y)}`));
        const hasLayout = uniquePositions.size > Math.min(enriched.length * 0.5, 3);

        if (hasLayout) {
          setNodes(enriched);
          setEdges(rawEdges);
        } else {
          console.log("No layout detected, running auto-layout...");
          await applyForceLayout(enriched, rawEdges);
        }
      } else {
        setNodes([]);
        setEdges(rawEdges);
      }
    } catch (err: any) {
      console.error("Failed to load graph:", err);
    } finally {
      hasAttemptedInitialLoad.current = true;
    }
  };

  useEffect(() => {
    loadGraph();
  }, [setNodes, setEdges]);

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

  // 3. Degree-filter nodes, then prune edges to visible nodes
  const { filteredNodes, filteredEdges } = useMemo(() => {
    // Nodes that pass the degree threshold and outlier toggle
    const degreeFiltered = new Set<string>();
    for (const n of nodes) {
      const deg = degreeMap.get(n.id) || 0;
      
      // If outliers are hidden, node must have degree > 1
      if (!showOutliers && deg <= 1) continue;
      
      // Apply existing minDegree filter
      if (deg >= deferredMinDegree) degreeFiltered.add(n.id);
    }

    // If year filter is active, also restrict to nodes touched by year-filtered edges
    let visibleIds: Set<string>;
    if (deferredYearFilter >= 2026) {
      visibleIds = degreeFiltered;
    } else {
      const yearVisible = new Set<string>();
      for (const e of yearFilteredEdges) {
        yearVisible.add(e.source);
        yearVisible.add(e.target);
      }
      // Intersection: must pass both degree AND year visibility
      visibleIds = new Set<string>();
      for (const id of degreeFiltered) {
        if (yearVisible.has(id)) visibleIds.add(id);
      }
    }

    // Remove edges where either endpoint was filtered out
    const fEdges = yearFilteredEdges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
    );

    // Final nodes: only those in visibleIds that still exist in node list
    const fNodes = nodes.filter((n) => visibleIds.has(n.id));

    return { filteredNodes: fNodes, filteredEdges: fEdges };
  }, [nodes, edges, yearFilteredEdges, deferredYearFilter, degreeMap, deferredMinDegree]);

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
  }, []);

  const handleEvidenceNodeClick = useCallback((node: Node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
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

    try {
      const res = await fetch('/api/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text }),
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
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, error: `Analysis failed: ${err.message}`, isStreaming: false } : m
      ));
    } finally {
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
    } finally {
      setIsScanning(false);
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
      });
      setCases(prev => [res.data.case, ...prev]);
      setScanFindings(prev => prev.filter(f => f.title !== finding.title));
    } catch (err) {
      console.error('Failed to create case:', err);
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

  const updateCaseStatus = async (caseId: string, status: string) => {
    try {
      await axios.patch(`/api/cases/${caseId}`, { status });
      setCases(prev => prev.map(c => c.id === caseId ? { ...c, status: status as Case['status'] } : c));
    } catch (err) {
      console.error('Failed to update case:', err);
    }
  };

  const deleteCase = async (caseId: string) => {
    try {
      await axios.delete(`/api/cases/${caseId}`);
      setCases(prev => prev.filter(c => c.id !== caseId));
      if (activeCaseId === caseId) setActiveCaseId(null);
    } catch (err) {
      console.error('Failed to delete case:', err);
    }
  };

  // Load cases when switching to cases tab
  useEffect(() => {
    if (activeView === 'cases') {
      loadCases();
    }
  }, [activeView]);

  const tabs: { id: View; label: string; icon: typeof MessageSquare }[] = [
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'cases', label: 'Cases', icon: Shield },
    { id: 'graph', label: 'Graph', icon: Network },
    { id: 'docs', label: 'Docs', icon: Database },
    { id: 'data', label: 'Data', icon: HardDrive },
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
    <div className="h-screen flex flex-col bg-black text-white font-sans overflow-hidden">

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
                  <div className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-[#FF9F0A] animate-pulse' : 'bg-[#30D158]'}`} />
                  <span className="text-[rgba(235,235,245,0.6)]">
                    {isSyncing ? 'Syncing...' : `${nodes.length} entities`}
                  </span>
                  <RefreshCw size={12} className={`text-[rgba(235,235,245,0.3)] ${isSyncing ? 'animate-spin' : ''}`} />
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
            />
          </>
        )}

        {activeView === 'graph' && (
          <div className="flex-1 flex flex-col h-full relative">
            <header className="shrink-0 px-5 pt-4 pb-2 bg-black flex items-center justify-between gap-3">
              <h1 className="text-[28px] font-bold tracking-tight text-white shrink-0">Graph</h1>

              {/* Search */}
              <div ref={graphSearchRef} className="relative max-w-[260px] flex-1">
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

              <div className="flex items-center gap-3 shrink-0">
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
                    onClick={() => setMinDegree(Math.max(0, minDegree - 1))}
                    className="p-1 hover:bg-[#2C2C2E] rounded-full transition-colors text-[rgba(235,235,245,0.6)]"
                    title="Decrease connections threshold"
                  >
                    <Minus size={14} />
                  </button>
                  <span className="text-[13px] font-mono text-[rgba(235,235,245,0.6)] min-w-[40px] text-center">
                    {minDegree === 0 ? 'All' : `${minDegree}+`}
                  </span>
                  <button
                    onClick={() => setMinDegree(minDegree + 1)}
                    className="p-1 hover:bg-[#2C2C2E] rounded-full transition-colors text-[rgba(235,235,245,0.6)]"
                    title="Increase connections threshold"
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
                  onClick={onLayout}
                  disabled={isLayouting}
                  className="flex items-center gap-1.5 bg-[#1C1C1E] hover:bg-[#2C2C2E] px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors border border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.6)] disabled:opacity-50"
                >
                  {isLayouting && <Loader2 size={12} className="animate-spin" />}
                  Web Layout
                </button>
              </div>
            </header>
            <div className="flex-1 relative">
              {/* Loading overlay */}
              {(isExtractingInsights || isLayouting) && (
                <SyncOverlay />
              )}

              {/* Empty state */}
              {!isExtractingInsights && !isLayouting && nodes.length === 0 && (
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
                edges={filteredEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStop={onNodeDragStop}
                onNodeClick={handleNodeClick}
                onEdgeClick={handleEdgeClick}
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
                       Sync Intelligence
                     </h3>
                     <div className="space-y-3">
                       <button 
                         onClick={() => triggerInsights('standard')}
                         disabled={isSyncing}
                         className="w-full flex flex-col items-start gap-1 p-3 rounded-xl bg-black/40 border border-white/5 hover:bg-black/60 transition-colors group text-left"
                       >
                         <span className="text-[13px] font-bold text-white group-hover:text-[#007AFF]">Standard Sync</span>
                         <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Topic-based sampling. Fast and lightweight extraction.</span>
                       </button>
                       
                       <button 
                         onClick={() => triggerInsights('deep')}
                         disabled={isSyncing}
                         className="w-full flex flex-col items-start gap-1 p-3 rounded-xl bg-black/40 border border-white/5 hover:bg-black/60 transition-colors group text-left"
                       >
                         <span className="text-[13px] font-bold text-white group-hover:text-[#FF9F0A]">Deep Sync</span>
                         <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Heavy sampling across all themes. Captures more nuances.</span>
                       </button>

                       <button
                         onClick={() => triggerInsights('full')}
                         disabled={isSyncing}
                         className="w-full flex flex-col items-start gap-1 p-3 rounded-xl bg-[#007AFF]/10 border border-[#007AFF]/30 hover:bg-[#007AFF]/20 transition-colors group text-left"
                       >
                         <span className="text-[13px] font-bold text-[#007AFF]">Full Reconstruction</span>
                         <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Exhaustive Pinecone sweep. Maximum entity density. (Expensive)</span>
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
                         <span className="text-[11px] text-[rgba(235,235,245,0.4)]">Merge duplicate entities and rewire edges. AI-assisted fuzzy matching.</span>
                       </button>

                       <div className="pt-2 mt-2 border-t border-white/5">
                          <label className="text-[11px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider mb-2 block">
                            Keyword Search &amp; Network Builder
                          </label>
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
                          <div className="flex gap-2 mb-2">
                            <input
                              type="text"
                              value={focusTarget}
                              onChange={(e) => { setFocusTarget(e.target.value); setTargetedResults(null); setSearchPage(1); }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && focusTarget.trim() && !isTargetedSearching) {
                                  setIsTargetedSearching(true);
                                  setTargetedResults(null);
                                  setExpandedChunks(new Set());
                                  setSearchPage(1);
                                  axios.post('/api/search/targeted', { keyword: focusTarget.trim(), page: 1, page_size: 50, search_mode: searchMode })
                                    .then(res => setTargetedResults(res.data))
                                    .catch(err => console.error('Targeted search failed:', err))
                                    .finally(() => setIsTargetedSearching(false));
                                }
                              }}
                              placeholder="e.g. Trump, Epstein, Boeing..."
                              className="flex-1 bg-black/40 border border-[rgba(84,84,88,0.65)] rounded-lg px-3 py-2 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-white/20"
                            />
                            <button
                              onClick={() => {
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
                              disabled={!focusTarget.trim() || isTargetedSearching}
                              className="bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg font-medium text-[13px] transition-colors shadow-[0_0_10px_rgba(0,122,255,0.3)] flex items-center gap-1.5"
                            >
                              {isTargetedSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                              Search
                            </button>
                          </div>

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
                                    setSyncProgress(5);
                                    setSyncStatus(`Extracting network for "${focusTarget}"...`);
                                    const interval = setInterval(() => {
                                      setSyncProgress(prev => (prev < 90 ? prev + Math.random() * 2 : prev));
                                    }, 1500);
                                    try {
                                      const res = await axios.post('/api/search/targeted', {
                                        keyword: focusTarget.trim(),
                                        extract: true,
                                        search_mode: searchMode,
                                      });
                                      const ext = res.data.extracted || { entities: 0, triples: 0 };
                                      if (ext.entities === 0) {
                                        setSyncStatus('No entities extracted — try a different keyword.');
                                        setSyncProgress(100);
                                      } else {
                                        setSyncStatus(`Extracted ${ext.entities} entities, ${ext.triples} relationships`);
                                        setSyncProgress(95);
                                        await loadGraph();
                                        setActiveView('graph');
                                      }
                                      setTargetedResults(null);
                                    } catch (err) {
                                      console.error('Build network failed:', err);
                                      setSyncStatus('Extraction failed. Please try again.');
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
          activeCaseId ? (
            <CaseDetail
              caseId={activeCaseId}
              onBack={() => setActiveCaseId(null)}
              onStatusChange={updateCaseStatus}
              onDelete={deleteCase}
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
            />
          )
        )}

        {activeView === 'data' && (
          <DataPanel />
        )}

        {/* Evidence Panel (bottom sheet, works across views) */}
        <EvidencePanel
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          allEdges={edges}
          allNodes={nodes}
          onClose={closePanel}
          onNodeClick={handleEvidenceNodeClick}
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
        </div>
      </nav>
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

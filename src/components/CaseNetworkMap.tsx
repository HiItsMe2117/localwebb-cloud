import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNodesState, useEdgesState, ReactFlowProvider } from 'reactflow';
import type { Node } from 'reactflow';
import { Search, Plus, X, Expand, Trash2, Loader2, Share2 } from 'lucide-react';
import NexusCanvas from './NexusCanvas';
import axios from 'axios';

interface CaseNetworkMapProps {
  caseId: string;
  caseEntities?: string[];
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

const TYPE_COLORS: Record<string, string> = {
  PERSON: '#60a5fa',
  ORGANIZATION: '#fbbf24',
  LOCATION: '#4ade80',
  EVENT: '#a78bfa',
  DOCUMENT: '#fb923c',
  FINANCIAL_ENTITY: '#f87171',
};

function CaseNetworkMapInner({ caseId, caseEntities = [] }: CaseNetworkMapProps) {
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

  // Node context menu
  const [contextNode, setContextNode] = useState<Node | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);

  // Track pinned node IDs for quick lookups
  const pinnedIds = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);

  // Load the case subgraph
  const loadGraph = useCallback(async () => {
    try {
      const res = await axios.get(`/api/cases/${caseId}/graph`);
      setNodes(res.data.nodes || []);
      setEdges(res.data.edges || []);
    } catch (err) {
      console.error('Failed to load case graph:', err);
    } finally {
      setIsLoading(false);
    }
  }, [caseId, setNodes, setEdges]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

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
      await axios.post(`/api/cases/${caseId}/graph/entities`, { node_ids: ids });
      setSuggestions([]);
      await loadGraph();
    } catch (err) {
      console.error('Failed to add suggested entities:', err);
    } finally {
      setIsAddingSuggestions(false);
    }
  }, [caseId, loadGraph]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as HTMLElement)) {
        setSearchResults([]);
      }
      if (contextRef.current && !contextRef.current.contains(e.target as HTMLElement)) {
        setContextNode(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
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
      await axios.post(`/api/cases/${caseId}/graph/entities`, { node_ids: [result.id] });
      await loadGraph();
    } catch (err) {
      console.error('Failed to add entity:', err);
    }
  }, [caseId, loadGraph]);

  // Node click → show context popover
  const onNodeClick = useCallback((node: Node) => {
    setContextNode(prev => prev?.id === node.id ? null : node);
    setExpandNode(null);
    setNeighbors([]);
    setSelectedNeighbors(new Set());
  }, []);

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
      await axios.post(`/api/cases/${caseId}/graph/entities`, { node_ids: Array.from(selectedNeighbors) });
      setExpandNode(null);
      setNeighbors([]);
      setSelectedNeighbors(new Set());
      await loadGraph();
    } catch (err) {
      console.error('Failed to add neighbors:', err);
    } finally {
      setIsAddingNeighbors(false);
    }
  }, [caseId, selectedNeighbors, loadGraph]);

  // Remove entity
  const handleRemove = useCallback(async (node: Node) => {
    setContextNode(null);
    try {
      await axios.delete(`/api/cases/${caseId}/graph/entities/${node.id}`);
      await loadGraph();
    } catch (err) {
      console.error('Failed to remove entity:', err);
    }
  }, [caseId, loadGraph]);

  // Save position on drag stop
  const onNodeDragStop = useCallback(async (_: any, node: Node) => {
    try {
      await axios.post(`/api/cases/${caseId}/graph/positions`, {
        positions: [{ node_id: node.id, x: node.position.x, y: node.position.y }],
      });
    } catch (err) {
      console.error('Failed to save position:', err);
    }
  }, [caseId]);

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
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Search bar */}
      <div className="shrink-0 px-4 py-3 border-b border-[rgba(84,84,88,0.65)] bg-black z-10">
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

      {/* ReactFlow canvas */}
      <div className="flex-1 relative">
        <NexusCanvas
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          showEdgeLabels={false}
        />

        {/* Node context popover */}
        {contextNode && (
          <div
            ref={contextRef}
            className="absolute top-3 right-3 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl overflow-hidden z-20 w-56"
          >
            <div className="px-3 py-2.5 border-b border-[rgba(84,84,88,0.35)]">
              <p className="text-[13px] font-semibold text-white truncate">{contextNode.data?.label}</p>
              <p className="text-[10px] uppercase tracking-wider font-bold" style={{ color: TYPE_COLORS[(contextNode.data?.entityType || '').toUpperCase()] || '#9ca3af' }}>
                {(contextNode.data?.entityType || 'unknown').toUpperCase()}
              </p>
            </div>
            <button
              onClick={() => handleExpand(contextNode)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[#2C2C2E] transition-colors"
            >
              <Expand size={14} className="text-[#007AFF]" />
              <span className="text-[13px] text-white">Expand neighbors</span>
            </button>
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
          <div className="absolute top-3 right-3 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl shadow-2xl z-20 w-72 max-h-[60vh] flex flex-col">
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
      </div>

      {/* Footer stats */}
      <div className="shrink-0 px-4 py-2 bg-black border-t border-[rgba(84,84,88,0.65)] flex items-center justify-between">
        <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono">
          {nodes.length} {nodes.length === 1 ? 'entity' : 'entities'} \u00B7 {edges.length} {edges.length === 1 ? 'connection' : 'connections'}
        </span>
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

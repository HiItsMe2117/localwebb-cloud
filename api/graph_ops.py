"""
Graph intelligence operations: multi-hop path finding, community detection,
fuzzy entity matching, connection query detection, and Supabase entity lookups.
"""

import re
from collections import deque
from typing import Optional, List

# --- Connection Query Detection ---

CONNECTION_PATTERNS = [
    re.compile(r"how (?:is|are) (.+?) (?:connected|related|linked) to (.+?)[\?\.]?$", re.IGNORECASE),
    re.compile(r"(?:connection|link|relationship) between (.+?) and (.+?)[\?\.]?$", re.IGNORECASE),
    re.compile(r"what (?:connects|links|ties) (.+?) (?:to|and|with) (.+?)[\?\.]?$", re.IGNORECASE),
    re.compile(r"trace (?:the )?(?:path|connection) (?:from|between) (.+?) (?:to|and) (.+?)[\?\.]?$", re.IGNORECASE),
    re.compile(r"(.+?) (?:connection|relationship|link) (?:to|with) (.+?)[\?\.]?$", re.IGNORECASE),
]


def detect_connection_query(query: str) -> Optional[tuple]:
    """
    Check if a query is asking about connections between two entities.
    Returns (entity_a, entity_b) if detected, None otherwise.
    """
    query = query.strip()
    for pattern in CONNECTION_PATTERNS:
        m = pattern.search(query)
        if m:
            a = m.group(1).strip().strip('"\'')
            b = m.group(2).strip().strip('"\'')
            if len(a) > 1 and len(b) > 1:
                return (a, b)
    return None


# --- Fuzzy Entity Matching ---

def _normalize(s: str) -> str:
    return re.sub(r'[^a-z0-9\s]', '', s.lower()).strip()


def find_entity_id(graph_data: dict, name: str) -> Optional[str]:
    """
    Find an entity ID by name using fuzzy matching.
    Priority: exact label match → partial label match → alias match → id match.
    """
    name_norm = _normalize(name)
    nodes = graph_data.get("nodes", [])

    # Exact label match
    for n in nodes:
        if _normalize(n.get("data", {}).get("label", "")) == name_norm:
            return n["id"]

    # Partial label match
    for n in nodes:
        label_norm = _normalize(n.get("data", {}).get("label", ""))
        if name_norm in label_norm or label_norm in name_norm:
            return n["id"]

    # Alias match
    for n in nodes:
        aliases = n.get("data", {}).get("aliases", [])
        for alias in aliases:
            if _normalize(alias) == name_norm or name_norm in _normalize(alias):
                return n["id"]

    # ID match
    for n in nodes:
        if _normalize(n["id"]) == name_norm.replace(" ", "_"):
            return n["id"]

    return None


# --- Multi-Hop Path Finding (BFS) ---

def _build_adjacency(graph_data: dict) -> dict:
    """Build adjacency list from graph edges. Each entry: {neighbor_id: [edge_data, ...]}"""
    adj = {}
    for edge in graph_data.get("edges", []):
        src = edge["source"]
        tgt = edge["target"]
        if src not in adj:
            adj[src] = {}
        if tgt not in adj:
            adj[tgt] = {}
        adj.setdefault(src, {}).setdefault(tgt, []).append(edge)
        adj.setdefault(tgt, {}).setdefault(src, []).append(edge)
    return adj


def find_paths(graph_data: dict, start_id: str, end_id: str, max_hops: int = 4, max_paths: int = 3) -> list:
    """
    BFS to find paths between two entities.
    Returns list of paths, where each path is a list of (node_id, edge_to_next) tuples.
    """
    adj = _build_adjacency(graph_data)
    if start_id not in adj or end_id not in adj:
        return []

    queue = deque()
    queue.append((start_id, [(start_id, None)]))
    visited_paths = []

    while queue and len(visited_paths) < max_paths:
        current, path = queue.popleft()

        if len(path) - 1 > max_hops:
            continue

        if current == end_id and len(path) > 1:
            visited_paths.append(path)
            continue

        visited_in_path = {node_id for node_id, _ in path}

        for neighbor, edges in adj.get(current, {}).items():
            if neighbor not in visited_in_path:
                edge = edges[0]  # take first edge between these nodes
                new_path = path + [(neighbor, edge)]
                queue.append((neighbor, new_path))

    return visited_paths


def find_paths_narrative(graph_data: dict, entity_a_name: str, entity_b_name: str) -> str:
    """
    Find paths between two entities by name and format as a narrative with evidence.
    """
    id_a = find_entity_id(graph_data, entity_a_name)
    id_b = find_entity_id(graph_data, entity_b_name)

    if not id_a or not id_b:
        missing = []
        if not id_a:
            missing.append(f"'{entity_a_name}'")
        if not id_b:
            missing.append(f"'{entity_b_name}'")
        return f"Could not find entities: {', '.join(missing)} in the knowledge graph."

    if id_a == id_b:
        return f"'{entity_a_name}' and '{entity_b_name}' refer to the same entity."

    paths = find_paths(graph_data, id_a, id_b)
    if not paths:
        return f"No connection found between '{entity_a_name}' and '{entity_b_name}' within 4 hops."

    node_map = {n["id"]: n.get("data", {}).get("label", n["id"]) for n in graph_data.get("nodes", [])}

    narratives = []
    for i, path in enumerate(paths):
        steps = []
        for j in range(len(path) - 1):
            node_id, _ = path[j]
            next_node_id, edge = path[j + 1]
            node_label = node_map.get(node_id, node_id)
            next_label = node_map.get(next_node_id, next_node_id)
            edge_data = edge.get("data", {}) if edge else {}
            predicate = edge_data.get("predicate", edge.get("label", "related to"))
            evidence = edge_data.get("evidence_text", "")
            source = edge_data.get("source_filename", "")
            confidence = edge_data.get("confidence", "STATED")

            step = f"  {node_label} --[{predicate}]--> {next_label}"
            if evidence:
                step += f'\n    Evidence: "{evidence}"'
            if source:
                step += f"\n    Source: {source}"
            if confidence == "INFERRED":
                step += " (inferred)"
            steps.append(step)

        hops = len(path) - 1
        narratives.append(f"Path {i+1} ({hops} hop{'s' if hops > 1 else ''}):\n" + "\n".join(steps))

    return "\n\n".join(narratives)


# --- Community Detection (Louvain) ---

COMMUNITY_COLORS = [
    '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
    '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1',
    '#14b8a6', '#e11d48', '#0ea5e9', '#a855f7', '#22c55e',
]


def compute_communities(graph_data: dict) -> dict:
    """
    Run Louvain community detection on the graph and assign community IDs + colors to nodes.
    Returns the modified graph_data with community info on each node.
    """
    try:
        import networkx as nx
        from networkx.algorithms.community import louvain_communities
    except ImportError:
        print("DEBUG: networkx not available, skipping community detection")
        return graph_data

    nodes = graph_data.get("nodes", [])
    edges = graph_data.get("edges", [])

    if len(nodes) < 2:
        return graph_data

    G = nx.Graph()
    for n in nodes:
        G.add_node(n["id"])
    for e in edges:
        if e["source"] in G and e["target"] in G:
            G.add_edge(e["source"], e["target"])

    try:
        communities = louvain_communities(G, seed=42)
    except Exception as e:
        print(f"DEBUG: Louvain community detection failed: {e}")
        return graph_data

    node_community = {}
    community_list = []
    for i, community in enumerate(communities):
        color = COMMUNITY_COLORS[i % len(COMMUNITY_COLORS)]
        community_info = {"id": i, "color": color, "members": list(community), "size": len(community)}
        community_list.append(community_info)
        for node_id in community:
            node_community[node_id] = {"id": i, "color": color}

    for node in nodes:
        comm = node_community.get(node["id"])
        if comm:
            node.setdefault("data", {})["communityId"] = comm["id"]
            node["data"]["communityColor"] = comm["color"]

    graph_data["communities"] = community_list
    print(f"DEBUG: Detected {len(community_list)} communities across {len(nodes)} nodes")
    return graph_data


# --- Supabase Direct Entity Lookups ---

def lookup_entity_intel(supabase_client, entity_name: str) -> dict:
    """
    Fuzzy-match an entity name against the Supabase `nodes` table, then fetch
    its edges and connected entities. Returns structured intel dict.
    """
    name_norm = _normalize(entity_name)
    if not name_norm:
        return {"found": False, "entity_name": entity_name}

    # Try exact label match first, then ilike partial match
    result = supabase_client.table("nodes").select("*").ilike("label", f"%{entity_name}%").limit(5).execute()
    rows = result.data or []

    # Score and pick best match
    best = None
    for row in rows:
        label_norm = _normalize(row.get("label", ""))
        if label_norm == name_norm:
            best = row
            break
        aliases = row.get("aliases", []) or []
        for alias in aliases:
            if _normalize(alias) == name_norm:
                best = row
                break
        if best:
            break

    if not best and rows:
        # Fall back to first partial match
        best = rows[0]

    if not best:
        return {"found": False, "entity_name": entity_name}

    entity_id = best["id"]

    # Fetch edges where this entity is source or target
    edges_as_source = supabase_client.table("edges").select("*").eq("source", entity_id).limit(100).execute()
    edges_as_target = supabase_client.table("edges").select("*").eq("target", entity_id).limit(100).execute()
    all_edges = (edges_as_source.data or []) + (edges_as_target.data or [])

    # Collect connected entity IDs
    connected_ids = set()
    for e in all_edges:
        connected_ids.add(e["source"])
        connected_ids.add(e["target"])
    connected_ids.discard(entity_id)

    # Fetch connected entity labels (batch query)
    connected_entities = []
    if connected_ids:
        ids_list = list(connected_ids)[:50]
        batch_res = supabase_client.table("nodes").select("id,label,type").in_("id", ids_list).execute()
        connected_entities = batch_res.data or []

    # Group edges by predicate
    relationship_types = {}
    for e in all_edges:
        pred = e.get("predicate", "related_to")
        relationship_types.setdefault(pred, []).append({
            "source": e["source"],
            "target": e["target"],
            "evidence_text": e.get("evidence_text", ""),
            "source_filename": e.get("source_filename", ""),
            "confidence": e.get("confidence", "STATED"),
        })

    return {
        "found": True,
        "entity_id": entity_id,
        "entity_name": best.get("label", entity_id),
        "entity_type": best.get("type", "UNKNOWN"),
        "description": best.get("description", ""),
        "aliases": best.get("aliases", []),
        "edge_count": len(all_edges),
        "connected_entities": connected_entities,
        "relationship_types": relationship_types,
    }


def keyword_search_evidence(supabase_client, names: List[str], limit: int = 10) -> list:
    """
    Search edges.evidence_text for exact name mentions using ilike.
    Returns list of edge dicts with matching evidence.
    """
    results = []
    seen_ids = set()
    for name in names:
        if not name or not name.strip():
            continue
        res = supabase_client.table("edges").select("*").ilike("evidence_text", f"%{name}%").limit(limit).execute()
        for row in (res.data or []):
            if row["id"] not in seen_ids:
                seen_ids.add(row["id"])
                results.append(row)
    return results[:limit * 2]


def bfs_collect_evidence(supabase_client, start_entity_id: str, max_hops: int = 2, max_edges: int = 50) -> list:
    """
    BFS from a starting entity via targeted Supabase edge queries.
    Collects evidence text from traversed edges. Returns list of edge dicts.
    """
    visited_nodes = {start_entity_id}
    frontier = [start_entity_id]
    collected_edges = []
    seen_edge_ids = set()

    for _hop in range(max_hops):
        if not frontier or len(collected_edges) >= max_edges:
            break
        next_frontier = []
        for node_id in frontier:
            if len(collected_edges) >= max_edges:
                break
            # Fetch edges for this node
            edges_src = supabase_client.table("edges").select("*").eq("source", node_id).limit(25).execute()
            edges_tgt = supabase_client.table("edges").select("*").eq("target", node_id).limit(25).execute()
            for e in (edges_src.data or []) + (edges_tgt.data or []):
                if e["id"] not in seen_edge_ids:
                    seen_edge_ids.add(e["id"])
                    collected_edges.append(e)
                    # Add neighbor to next frontier
                    neighbor = e["target"] if e["source"] == node_id else e["source"]
                    if neighbor not in visited_nodes:
                        visited_nodes.add(neighbor)
                        next_frontier.append(neighbor)
        frontier = next_frontier

    return collected_edges[:max_edges]

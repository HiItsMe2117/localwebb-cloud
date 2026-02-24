import os
import json
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Direct Cloud SDKs
from pinecone import Pinecone
from google import genai
from google.genai import types
from google.cloud import storage
from pypdf import PdfReader
from supabase import create_client, Client

load_dotenv()

app = FastAPI(title="LocalWebb Cloud API")

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print(f"GLOBAL ERROR: {exc}")
    return JSONResponse(
        status_code=500,
        content={"message": "Internal Server Error", "detail": str(exc)},
    )

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Configuration ---
GCS_BUCKET = os.getenv("GCS_BUCKET_NAME", "").strip()
PINECONE_API_KEY = (os.getenv("PINECONE_API_KEY") or os.getenv("PINCONE_API_KEY") or "").strip()
PINECONE_INDEX_NAME = (os.getenv("PINECONE_INDEX") or os.getenv("pinecone_index") or "").strip()
GOOGLE_API_KEY = (os.getenv("GOOGLE_API_KEY") or "").strip()
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip() # Added Supabase URL
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "").strip() # Added Supabase Key

# --- GCP Credentials Handling ---
gcp_json = os.getenv("GCP_SERVICE_ACCOUNT_JSON")
if gcp_json:
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json') as f:
        f.write(gcp_json)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = f.name

# --- Initialize Clients ---
def get_storage_client():
    try:
        return storage.Client()
    except Exception as e:
        print(f"Error initializing storage client: {e}")
        return None

storage_client = get_storage_client()

def get_bucket():
    if not storage_client or not GCS_BUCKET:
        return None
    try:
        # Bucket names must start/end with a number or letter
        if GCS_BUCKET[0].isalnum():
            return storage_client.bucket(GCS_BUCKET)
    except Exception as e:
        print(f"Invalid bucket name or access error: {e}")
    return None

bucket = get_bucket()

def get_pinecone_index():
    try:
        print(f"DEBUG: Pinecone Check - Key Present: {bool(PINECONE_API_KEY)}, Index Present: {bool(PINECONE_INDEX_NAME)}")
        if PINECONE_API_KEY and PINECONE_INDEX_NAME:
            pc = Pinecone(api_key=PINECONE_API_KEY)
            idx = pc.Index(PINECONE_INDEX_NAME)
            print(f"DEBUG: Pinecone Index '{PINECONE_INDEX_NAME}' initialized successfully")
            return idx
        else:
            missing = []
            if not PINECONE_API_KEY: missing.append("PINECONE_API_KEY")
            if not PINECONE_INDEX_NAME: missing.append("PINECONE_INDEX")
            print(f"DEBUG: Pinecone initialization skipped. Missing: {', '.join(missing)}")
    except Exception as e:
        print(f"Error initializing Pinecone: {e}")
    return None

index = get_pinecone_index()

def get_genai_client():
    try:
        if GOOGLE_API_KEY:
            return genai.Client(api_key=GOOGLE_API_KEY)
    except Exception as e:
        print(f"Error initializing GenAI client: {e}")
    return None

client = get_genai_client()

def get_supabase_client():
    try:
        if SUPABASE_URL and SUPABASE_KEY:
            return create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        print(f"Error initializing Supabase client: {e}")
    return None

supabase: Client = get_supabase_client()


# New SupabaseStore class
class SupabaseStore:
    def __init__(self):
        # Keep a reference to the GCS blob for migration/fallback
        self.gcs_blob = None
        if bucket:
            try:
                self.gcs_blob = bucket.blob("graph_store.json")
            except Exception as e:
                print(f"Error initializing GCS blob for SupabaseStore: {e}")

    def _fetch_all(self, table_name):
        """Fetch all rows from a Supabase table, paginating past the 1000-row default limit."""
        all_rows = []
        page_size = 1000
        offset = 0
        while True:
            res = supabase.table(table_name).select("*").range(offset, offset + page_size - 1).execute()
            all_rows.extend(res.data)
            if len(res.data) < page_size:
                break
            offset += page_size
        return all_rows

    def load(self):
        """Load full graph from Supabase for ReactFlow compatibility."""
        if not supabase:
            print("ERROR: Supabase client not initialized. Cannot load graph.")
            return {"nodes": [], "edges": []}

        try:
            nodes_data = self._fetch_all("nodes")
            edges_data = self._fetch_all("edges")
            
            # Format nodes for ReactFlow
            nodes = []
            for n in nodes_data:
                # Ensure 'data' and 'position' are always present
                node_data = n.get("metadata", {})
                position = n.get("position", {"x": 0, "y": 0}) 
                nodes.append({
                    "id": n["id"],
                    "type": "entityNode",
                    "data": {
                        "label": n.get("label", n["id"]),
                        "entityType": n.get("type", "UNKNOWN"),
                        "description": n.get("description", ""),
                        "aliases": n.get("aliases", []),
                        "degree": node_data.get("degree", 0),
                        "communityId": node_data.get("communityId"),
                        "communityColor": node_data.get("communityColor"),
                    },
                    "position": position
                })
            
            # Format edges for ReactFlow
            edges = []
            for e in edges_data:
                edges.append({
                    "id": e["id"],
                    "source": e["source"],
                    "target": e["target"],
                    "label": e.get("label", e["predicate"]),
                    "animated": e.get("confidence") == "INFERRED",
                    "style": {"strokeDasharray": "5 5"} if e.get("confidence") == "INFERRED" else {},
                    "data": {
                        "predicate": e["predicate"],
                        "evidence_text": e.get("evidence_text", ""),
                        "source_filename": e.get("source_filename", ""),
                        "source_page": e.get("source_page", 0),
                        "confidence": e.get("confidence", "STATED"),
                        "date_mentioned": e.get("date_mentioned"),
                    }
                })
            
            return {"nodes": nodes, "edges": edges}
        except Exception as e:
            print(f"CRITICAL: Error loading graph from Supabase: {e}")
            return {"nodes": [], "edges": []}

    def save(self, data):
        """This method is now primarily for GCS backup/migration if needed. 
        Supabase updates happen in add_elements and update_node_position."""
        if self.gcs_blob:
            try:
                self.gcs_blob.upload_from_string(json.dumps(data, indent=2))
            except Exception as e:
                print(f"Error saving graph to GCS backup: {e}")

    def update_node_position(self, node_id, x, y):
        if not supabase: return
        try:
            # Update only the position field for the given node
            supabase.table("nodes").update({"position": {"x": x, "y": y}}).eq("id", node_id).execute()
        except Exception as e:
            print(f"Failed to update node position in Supabase: {e}")

    def add_elements(self, new_nodes, new_edges):
        if not supabase:
            print("ERROR: Supabase client not initialized. Cannot add elements.")
            return

        try:
            # 1. Upsert Nodes
            node_records = []
            for n in new_nodes:
                # Ensure all fields expected by Supabase schema are present
                node_records.append({
                    "id": n["id"],
                    "label": n["data"].get("label", n["id"]),
                    "type": n["data"].get("entityType", "UNKNOWN"),
                    "description": n["data"].get("description", ""),
                    "aliases": n["data"].get("aliases", []),
                    "position": n.get("position", {"x": 0, "y": 0}),
                    "metadata": { # Store additional ReactFlow data in metadata JSONB
                        "degree": n["data"].get("degree", 0),
                        "communityId": n["data"].get("communityId"),
                        "communityColor": n["data"].get("communityColor"),
                    }
                })
            if node_records:
                # Using upsert to insert new nodes or update existing ones
                supabase.table("nodes").upsert(node_records, on_conflict="id").execute()

            # 2. Upsert Edges
            edge_records = []
            for e in new_edges:
                edge_records.append({
                    "id": e["id"],
                    "source": e["source"],
                    "target": e["target"],
                    "label": e.get("label", e["data"]["predicate"]),
                    "predicate": e["data"]["predicate"],
                    "evidence_text": e["data"].get("evidence_text", ""),
                    "source_filename": e["data"].get("source_filename", ""),
                    "source_page": e["data"].get("source_page", 0),
                    "confidence": e["data"].get("confidence", "STATED"),
                    "date_mentioned": e["data"].get("date_mentioned"),
                })
            if edge_records:
                # Using upsert to insert new edges or update existing ones
                supabase.table("edges").upsert(edge_records, on_conflict="id").execute()
                
        except Exception as e:
            print(f"Failed to upsert elements to Supabase: {e}")

graph_store = SupabaseStore()

# Endpoint to migrate GCS graph to Supabase
@app.post("/api/graph/migrate")
async def migrate_graph_to_supabase():
    if not supabase:
        return JSONResponse(status_code=500, content={"message": "Supabase client not initialized."})

    try:
        # Load legacy data from GCS
        temp_gcs_blob = None
        if bucket:
            try:
                temp_gcs_blob = bucket.blob("graph_store.json")
            except Exception as e:
                print(f"Error initializing temporary GCS blob for migration: {e}")
                return JSONResponse(status_code=500, content={"message": f"Migration failed: {e}"})

        gcs_data = {"nodes": [], "edges": []}
        if temp_gcs_blob and temp_gcs_blob.exists():
            try:
                content = temp_gcs_blob.download_as_text()
                if content:
                    gcs_data = json.loads(content)
            except Exception as e:
                print(f"Error loading GCS data for migration: {e}")
                return JSONResponse(status_code=500, content={"message": f"Migration failed: {e}"})

        if not gcs_data or (not gcs_data.get("nodes") and not gcs_data.get("edges")):
            return JSONResponse(status_code=200, content={"message": "No existing graph data found in GCS to migrate."})

        # Reformat GCS nodes for Supabase
        node_records = []
        for n in gcs_data.get("nodes", []):
            node_records.append({
                "id": n["id"],
                "label": n["data"].get("label", n["id"]),
                "type": n["data"].get("entityType", "UNKNOWN"),
                "description": n["data"].get("description", ""),
                "aliases": n["data"].get("aliases", []),
                "position": n.get("position", {"x": 0, "y": 0}),
                "metadata": {
                    "degree": n["data"].get("degree", 0),
                    "communityId": n["data"].get("communityId"),
                    "communityColor": n["data"].get("communityColor"),
                }
            })

        # Reformat GCS edges for Supabase
        edge_records = []
        for e in gcs_data.get("edges", []):
            edge_records.append({
                "id": e["id"],
                "source": e["source"],
                "target": e["target"],
                "label": e.get("label", e["data"].get("predicate")),
                "predicate": e["data"].get("predicate", "related_to"),
                "evidence_text": e["data"].get("evidence_text", ""),
                "source_filename": e["data"].get("source_filename", ""),
                "source_page": e["data"].get("source_page", 0),
                "confidence": e["data"].get("confidence", "STATED"),
                "date_mentioned": e["data"].get("date_mentioned"),
            })

        if node_records:
            supabase.table("nodes").upsert(node_records, on_conflict="id").execute()
        if edge_records:
            supabase.table("edges").upsert(edge_records, on_conflict="id").execute()

        return JSONResponse(status_code=200, content={
            "message": f"Migrated {len(node_records)} nodes and {len(edge_records)} edges to Supabase."
        })
    except Exception as e:
        print(f"Error during migration: {e}")
        return JSONResponse(status_code=500, content={"message": f"Migration failed: {e}"})

# --- Models ---
class QueryRequest(BaseModel):
    query: str
    top_k: int = 15
    stream: bool = False

class PositionUpdate(BaseModel):
    id: str
    x: float
    y: float

class Entity(BaseModel):
    id: str
    label: str
    type: str  # PERSON, ORGANIZATION, LOCATION, EVENT, DOCUMENT, FINANCIAL_ENTITY
    description: str
    aliases: List[str] = []

class Triple(BaseModel):
    subject_id: str
    predicate: str
    object_id: str
    evidence_text: str
    source_filename: str
    source_page: int = 0
    confidence: str = "STATED"
    date_mentioned: Optional[str] = None

class CaseMap(BaseModel):
    entities: List[Entity]
    triples: List[Triple]

class FilteredQueryRequest(BaseModel):
    query: str
    top_k: int = 15
    stream: bool = False
    doc_type: Optional[str] = None
    person_filter: Optional[str] = None
    org_filter: Optional[str] = None

class TargetedSearchRequest(BaseModel):
    keyword: str
    extract: bool = False

class InvestigateRequest(BaseModel):
    query: str

class CreateCaseRequest(BaseModel):
    title: str
    category: str
    summary: str
    confidence: float = 0.5
    entities: List[str] = []
    suggested_questions: List[str] = []

class UpdateCaseRequest(BaseModel):
    status: Optional[str] = None
    title: Optional[str] = None

class AddNoteRequest(BaseModel):
    content: str

# --- Endpoints ---

@app.get("/api")
async def api_health():
    return {"status": "LocalWebb Cloud API is active"}

@app.get("/api/graph")
async def get_graph():
    return graph_store.load()

@app.post("/api/graph/positions")
async def update_positions(updates: List[PositionUpdate]):
    for update in updates:
        graph_store.update_node_position(update.id, update.x, update.y)
    return {"status": "positions updated"}

@app.get("/api/insights")
async def get_insights(depth: str = "standard", focus: Optional[str] = None, strict: bool = False):
    try:
        if not index:
            return {"error": "Pinecone index not initialized. Please check environment variables."}
        if not client:
            return {"error": "GenAI client not initialized. Please check environment variables."}

        print(f"DEBUG: Starting {depth} extraction (Focus: {focus}, Strict: {strict})...")
        
        insight_topics = [
            "people persons individuals names",
            "organizations companies institutions",
            "locations places addresses travel",
            "financial transactions money payments",
            "events meetings dates timeline",
            "crimes allegations investigations legal",
            "assets properties aircraft vessels"
        ]

        if focus:
            # If a focus is provided, we prioritize it by adding it to the list
            # and potentially giving it its own dedicated high-recall pass
            print(f"DEBUG: Running targeted extraction for: '{focus}'")
            insight_topics.insert(0, focus)

        # Scalable sampling based on depth
        top_k_per_topic = 10
        if depth == "deep":
            top_k_per_topic = 25
        elif depth == "full":
            top_k_per_topic = 50
        
        # Boost recall for the focus topic if it exists
        if focus:
            top_k_per_topic = max(top_k_per_topic, 30)

        def extract_chunk_with_meta(metadata):
            text = ""
            if '_node_content' in metadata:
                try:
                    text = json.loads(metadata['_node_content']).get('text', '')
                except (json.JSONDecodeError, TypeError):
                    pass
            if not text:
                text = metadata.get('text', '')
            filename = metadata.get('filename', 'unknown')
            page = metadata.get('page', metadata.get('chunk_index', 0))
            return {"text": text, "filename": filename, "page": page}

        all_chunks = {}
        
        # If 'full', we also do a broad sweep of the most 'important' vectors
        if depth == "full":
            try:
                # Query for general importance
                broad_results = index.query(
                    vector=[0.0] * 1536, # Dummy vector for broad retrieval if supported, or just high top_k
                    top_k=100,
                    include_metadata=True
                )
                for r in broad_results.matches:
                    if r.metadata and r.id not in all_chunks:
                        all_chunks[r.id] = extract_chunk_with_meta(r.metadata)
            except: pass

        for topic in insight_topics:
            try:
                topic_emb = client.models.embed_content(
                    model="gemini-embedding-001", contents=[topic]
                )
                
                # Boost recall specifically for the user's focus topic
                current_top_k = top_k_per_topic
                if focus and topic == focus:
                    current_top_k = 60  # Significantly higher recall for the target entity
                    print(f"DEBUG: Running high-recall query (top_k={current_top_k}) for focus: '{focus}'")

                topic_results = index.query(
                    vector=topic_emb.embeddings[0].values,
                    top_k=current_top_k,
                    include_metadata=True
                )
                for r in topic_results.matches:
                    if r.metadata and r.id not in all_chunks:
                        chunk_data = extract_chunk_with_meta(r.metadata)
                        
                        # --- STRICT MODE: Denoise logic ---
                        if strict and focus and focus.lower() in chunk_data["text"].lower():
                            # If the text is garbled but contains our focus word, 
                            # we flag it for the LLM to perform a 'corrective' reading.
                            chunk_data["text"] = f"[STRICT_CLEANUP_REQUIRED] {chunk_data['text']}"
                            
                        all_chunks[r.id] = chunk_data
            except Exception as e:
                print(f"DEBUG: Topic query '{topic}' failed: {e}")

        print(f"DEBUG: {depth} sampling collected {len(all_chunks)} unique chunks")

        context_parts = []
        for chunk in all_chunks.values():
            if chunk["text"]:
                context_parts.append(
                    f"[Source: {chunk['filename']}, Page: {chunk['page']}]\n{chunk['text']}"
                )
        context = "\n\n---\n\n".join(context_parts)

        if not context:
            print("DEBUG: No context found in metadata!")
            return graph_store.load()

        prompt = (
            "You are an investigative intelligence analyst. Extract entities and their relationships from these documents.\n\n"
            "RULES:\n"
            "1. Every entity needs an id (lowercase_snake_case), a label (display name), a type (PERSON, ORGANIZATION, LOCATION, EVENT, DOCUMENT, FINANCIAL_ENTITY), a description, and aliases (alternate names).\n"
            "2. Every relationship (triple) MUST include:\n"
            "   - subject_id and object_id referencing entity ids\n"
            "   - predicate: a lowercase_snake_case verb phrase (e.g. 'flew_with', 'employed_by', 'transferred_funds_to', 'visited', 'owns')\n"
            "   - evidence_text: the EXACT verbatim quote from the document that proves this relationship\n"
            "   - source_filename: the filename from the [Source: ...] header\n"
            "   - source_page: the page number from the [Source: ...] header\n"
            "   - confidence: 'STATED' if directly stated in the text, 'INFERRED' if logically deduced from context\n"
            "   - date_mentioned: ISO date (YYYY-MM-DD) if a date is mentioned, null otherwise\n"
            "3. Do NOT invent relationships that aren't supported by the text.\n"
            "4. Extract as many entities and relationships as the documents support.\n\n"
            f"DOCUMENTS:\n{context}\n\n"
            "Return JSON with 'entities' and 'triples' keys."
        )

        print("DEBUG: Sending extraction prompt to Gemini...")
        res = client.models.generate_content(
            model="gemini-2.5-pro",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CaseMap
            )
        )

        output = res.parsed
        print(f"DEBUG: Gemini extracted {len(output.entities)} entities, {len(output.triples)} triples")

        entity_map = {ent.id: ent for ent in output.entities}

        import math
        new_nodes = []
        total = len(output.entities)
        cx, cy = 400, 400
        radius = max(200, total * 30)
        for i, ent in enumerate(output.entities):
            ent_type = ent.type.upper()
            angle = (2 * math.pi * i) / max(total, 1)
            new_nodes.append({
                "id": ent.id,
                "type": "entityNode",
                "data": {
                    "label": ent.label,
                    "entityType": ent_type,
                    "description": ent.description,
                    "aliases": ent.aliases,
                },
                "position": {
                    "x": cx + radius * math.cos(angle),
                    "y": cy + radius * math.sin(angle),
                },
            })

        seen_edge_ids = set()
        new_edges = []
        for triple in output.triples:
            edge_id = f"e-{triple.subject_id}-{triple.predicate}-{triple.object_id}"
            if edge_id in seen_edge_ids:
                continue
            seen_edge_ids.add(edge_id)
            new_edges.append({
                "id": edge_id,
                "source": triple.subject_id,
                "target": triple.object_id,
                "label": triple.predicate.replace("_", " "),
                "animated": triple.confidence == "INFERRED",
                "style": {"strokeDasharray": "5 5"} if triple.confidence == "INFERRED" else {},
                "data": {
                    "predicate": triple.predicate,
                    "evidence_text": triple.evidence_text,
                    "source_filename": triple.source_filename,
                    "source_page": triple.source_page,
                    "confidence": triple.confidence,
                    "date_mentioned": triple.date_mentioned,
                },
            })

        graph_store.add_elements(new_nodes, new_edges)

        # Run community detection if available
        try:
            from api.graph_ops import compute_communities
        except ImportError:
            try:
                from graph_ops import compute_communities
            except ImportError as e:
                print(f"DEBUG: graph_ops unavailable: {e}")
                compute_communities = None

        if compute_communities:
            graph_data = graph_store.load()
            graph_data = compute_communities(graph_data)
            # The community detection modifies the graph data directly, so we need to
            # update the nodes in Supabase. Edges remain unchanged by community detection.
            # We don't need to call graph_store.save(graph_data) as it's for GCS backup.
            
            # Instead, we directly update nodes in Supabase with community info
            updated_nodes_for_community = []
            for node in graph_data.get("nodes", []):
                if "communityId" in node["data"]:
                    updated_nodes_for_community.append({
                        "id": node["id"],
                        "metadata": { # Update only the metadata JSONB field
                            "degree": node["data"].get("degree", 0),
                            "communityId": node["data"]["communityId"],
                            "communityColor": node["data"]["communityColor"],
                        }
                    })
            if updated_nodes_for_community:
                supabase.table("nodes").upsert(updated_nodes_for_community, on_conflict="id").execute()

            return graph_store.load() # Reload from Supabase to get latest with communities

        return graph_store.load()
    except Exception as e:
        print(f"Insights failed: {e}")
        import traceback; traceback.print_exc()
        return graph_store.load()

def _get_rerank_fn():
    """Lazy-load the reranker function."""
    try:
        from api.reranker import rerank
        return rerank
    except ImportError:
        try:
            from reranker import rerank
            return rerank
        except ImportError:
            return None


def _semantic_search_pass(query_text, genai_client, pinecone_index, rerank_fn=None,
                          fetch_k=200, rerank_top_n=5, pinecone_filter=None) -> list:
    """
    Single semantic search pass: embed query → Pinecone similarity search → extract text → rerank.
    Returns list of dicts with keys: text, filename, page, score.
    """
    # 1. Embed query
    res = genai_client.models.embed_content(
        model="gemini-embedding-001",
        contents=[query_text]
    )
    embedding = res.embeddings[0].values

    # 2. Query Pinecone
    query_kwargs = dict(vector=embedding, top_k=fetch_k, include_metadata=True)
    if pinecone_filter:
        query_kwargs["filter"] = pinecone_filter
    results = pinecone_index.query(**query_kwargs)

    # 3. Extract text + metadata
    candidates = []
    for r in results.matches:
        if not r.metadata:
            continue
        text = ""
        if '_node_content' in r.metadata:
            try:
                node = json.loads(r.metadata['_node_content'])
                text = node.get('text', '')
            except (json.JSONDecodeError, TypeError):
                pass
        if not text:
            text = r.metadata.get('text', '')
        if text:
            filename = r.metadata.get('filename', 'unknown')
            page = r.metadata.get('page', '')
            if not page and page != 0:
                chunk_idx = r.metadata.get('chunk_index', '')
                page = f"Chunk {chunk_idx}" if chunk_idx != '' else ''
            candidates.append({
                "text": text, "filename": filename, "page": page,
                "score": r.score,
            })

    # 4. Cross-encoder reranking
    if rerank_fn and len(candidates) > rerank_top_n:
        try:
            candidates = rerank_fn(query_text, candidates, top_n=rerank_top_n)
        except Exception as e:
            print(f"DEBUG: Reranker failed, using Pinecone ordering: {e}")
            candidates = candidates[:rerank_top_n]
    else:
        candidates = candidates[:rerank_top_n]

    return candidates


def _build_query_context(request):
    """Shared logic: embed query, search Pinecone (with optional filters + reranking), build context + sources."""
    if not index:
        raise ValueError("Pinecone index not initialized. Please check environment variables.")
    if not client:
        raise ValueError("GenAI client not initialized. Please check environment variables.")

    top_k = max(1, min(request.top_k, 50))

    # Build metadata filter for filtered queries
    pinecone_filter = {}
    if hasattr(request, 'doc_type') and request.doc_type:
        pinecone_filter["doc_type"] = {"$eq": request.doc_type}
    if hasattr(request, 'person_filter') and request.person_filter:
        pinecone_filter["people"] = {"$in": [request.person_filter]}
    if hasattr(request, 'org_filter') and request.org_filter:
        pinecone_filter["organizations"] = {"$in": [request.org_filter]}

    fetch_k = 40 if top_k <= 20 else top_k
    rerank_fn = _get_rerank_fn()

    print(f"DEBUG: Embedding query (top_k={top_k})...")
    candidates = _semantic_search_pass(
        query_text=request.query,
        genai_client=client,
        pinecone_index=index,
        rerank_fn=rerank_fn,
        fetch_k=fetch_k,
        rerank_top_n=min(top_k, 8),
        pinecone_filter=pinecone_filter or None,
    )

    # Build context string and sources
    context_parts = []
    sources = []
    seen_files = set()
    for c in candidates:
        context_parts.append(f"[Source: {c['filename']}, Page: {c['page']}]\n{c['text'][:1200]}")
        if c["filename"] not in seen_files:
            seen_files.add(c["filename"])
            sources.append({"filename": c["filename"], "page": c["page"], "score": round(c["score"], 3) if c["score"] else None})

    context = "\n\n".join(context_parts)
    return context, sources


QUERY_PROMPT_TEMPLATE = (
    "You are an investigative research assistant. Answer based ONLY on the provided context.\n"
    "Cite your sources by referencing the [Source: filename] tags when making claims.\n\n"
    "Context:\n{context}\n\n"
    "Question: {query}\n\n"
    "Provide a thorough but concise answer. At the end, list the source documents you referenced."
)


@app.post("/api/query")
async def query_index(request: FilteredQueryRequest):
    try:
        print(f"DEBUG: Starting query for: {request.query}")

        # Check if this is a connection-style query
        graph_context = ""
        try:
            from api.graph_ops import detect_connection_query, find_paths_narrative
        except ImportError:
            try:
                from graph_ops import detect_connection_query, find_paths_narrative
            except ImportError as e:
                print(f"DEBUG: graph_ops unavailable: {e}")
                detect_connection_query = None
                find_paths_narrative = None

        if detect_connection_query and find_paths_narrative:
            conn_match = detect_connection_query(request.query)
            if conn_match:
                entity_a, entity_b = conn_match
                print(f"DEBUG: Connection query detected: '{entity_a}' <-> '{entity_b}'")
                graph_data = graph_store.load()
                graph_context = find_paths_narrative(graph_data, entity_a, entity_b)
                if graph_context:
                    graph_context = f"\n\nGRAPH CONNECTIONS FOUND:\n{graph_context}\n"

        context, sources = _build_query_context(request)

        if not context and not graph_context:
            print("DEBUG: No context found")
            return {"response": "No relevant info found in the database.", "sources": []}

        full_context = context
        if graph_context:
            full_context = graph_context + "\n\nDOCUMENT CONTEXT:\n" + context

        # Streaming path
        if request.stream:
            prompt = QUERY_PROMPT_TEMPLATE.format(context=full_context, query=request.query)

            async def event_stream():
                try:
                    stream = client.models.generate_content_stream(
                        model="gemini-2.5-pro",
                        contents=prompt
                    )
                    for chunk in stream:
                        if chunk.text:
                            yield f"data: {json.dumps({'text': chunk.text})}\n\n"
                    yield f"data: {json.dumps({'sources': sources, 'done': True})}\n\n"
                except Exception as e:
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"

            return StreamingResponse(event_stream(), media_type="text/event-stream")

        # Non-streaming path
        print("DEBUG: Generating Gemini response...")
        prompt = QUERY_PROMPT_TEMPLATE.format(context=full_context, query=request.query)

        response = client.models.generate_content(
            model="gemini-2.5-pro",
            contents=prompt
        )
        print("DEBUG: Query successful")
        return {"response": response.text, "sources": sources}
    except ValueError as e:
        print(f"ERROR: {e}")
        return {"response": f"Error: {e}", "sources": []}
    except Exception as e:
        print(f"CRITICAL ERROR in query_index: {str(e)}")
        return {"response": f"Analysis failed: {str(e)}", "sources": []}


@app.post("/api/investigate")
async def investigate(request: InvestigateRequest):
    """Multi-step agentic investigation pipeline. Returns SSE stream."""
    if not index:
        return JSONResponse(status_code=503, content={"error": "Pinecone index not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})

    try:
        from api.investigator import run_investigation
    except ImportError:
        from investigator import run_investigation

    # Skip reranker for investigation pipeline — multi-pass search provides
    # sufficient recall and the FlashRank model adds ~200MB memory overhead
    # which exceeds Vercel's serverless function limit.
    return StreamingResponse(
        run_investigation(
            query=request.query,
            genai_client=client,
            pinecone_index=index,
            supabase_client=supabase,
            semantic_search_fn=_semantic_search_pass,
            rerank_fn=None,
        ),
        media_type="text/event-stream",
    )


# ---- Cases endpoints ----

@app.post("/api/cases/scan")
async def scan_for_cases():
    """Run the suspicious activity scanner across graph + documents."""
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    if not index:
        return JSONResponse(status_code=503, content={"error": "Pinecone index not initialized."})

    try:
        try:
            from api.scanner import run_scan
        except ImportError:
            from scanner import run_scan

        import asyncio
        findings = await asyncio.to_thread(
            run_scan, client, supabase, index, _semantic_search_pass
        )
        return {"findings": findings}
    except Exception as e:
        print(f"CRITICAL: Scan failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": f"Scan failed: {str(e)}"})


@app.get("/api/cases")
async def list_cases():
    """List all cases, ordered by updated_at desc."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        res = supabase.table("cases").select("*").order("updated_at", desc=True).execute()
        return {"cases": res.data or []}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases")
async def create_case(request: CreateCaseRequest):
    """Accept a finding — insert into cases table."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        row = {
            "title": request.title,
            "category": request.category,
            "summary": request.summary,
            "status": "active",
            "confidence": request.confidence,
            "entities": request.entities,
            "suggested_questions": request.suggested_questions,
        }
        res = supabase.table("cases").insert(row).execute()
        return {"case": res.data[0] if res.data else row}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/cases/{case_id}")
async def get_case(case_id: str):
    """Get a case with its evidence."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        case_res = supabase.table("cases").select("*").eq("id", case_id).execute()
        if not case_res.data:
            return JSONResponse(status_code=404, content={"error": "Case not found"})

        evidence_res = supabase.table("case_evidence").select("*").eq("case_id", case_id).order("created_at", desc=True).execute()

        return {
            "case": case_res.data[0],
            "evidence": evidence_res.data or [],
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/investigate")
async def investigate_case(case_id: str):
    """Run scoped investigation for a case. Returns SSE stream."""
    if not index:
        return JSONResponse(status_code=503, content={"error": "Pinecone index not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})

    # Load case data
    case_res = supabase.table("cases").select("*").eq("id", case_id).execute()
    if not case_res.data:
        return JSONResponse(status_code=404, content={"error": "Case not found"})

    case_data = case_res.data[0]

    try:
        from api.investigator import run_investigation
    except ImportError:
        from investigator import run_investigation

    case_context = {
        "title": case_data["title"],
        "summary": case_data["summary"],
        "entities": case_data.get("entities", []),
        "suggested_questions": case_data.get("suggested_questions", []),
    }

    query = f"Investigate: {case_data['title']}"

    async def stream_and_save():
        full_text = ""
        all_sources = []
        async for event in run_investigation(
            query=query,
            genai_client=client,
            pinecone_index=index,
            supabase_client=supabase,
            semantic_search_fn=_semantic_search_pass,
            rerank_fn=None,
            case_context=case_context,
        ):
            yield event
            # Collect text and sources for saving
            try:
                if event.startswith("data: "):
                    data = json.loads(event[6:].strip())
                    if data.get("type") == "text":
                        full_text += data.get("text", "")
                    elif data.get("type") == "sources":
                        all_sources = data.get("sources", [])
                    elif data.get("type") == "done" and full_text:
                        # Save evidence
                        try:
                            supabase.table("case_evidence").insert({
                                "case_id": case_id,
                                "type": "investigation",
                                "content": full_text,
                                "sources": all_sources,
                            }).execute()
                            supabase.table("cases").update({"updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", case_id).execute()
                        except Exception as save_err:
                            print(f"DEBUG: Failed to save case evidence: {save_err}")
            except (json.JSONDecodeError, KeyError):
                pass

    return StreamingResponse(stream_and_save(), media_type="text/event-stream")


@app.post("/api/cases/{case_id}/notes")
async def add_case_note(case_id: str, request: AddNoteRequest):
    """Add a note to a case."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        # Verify case exists
        case_res = supabase.table("cases").select("id").eq("id", case_id).execute()
        if not case_res.data:
            return JSONResponse(status_code=404, content={"error": "Case not found"})

        res = supabase.table("case_evidence").insert({
            "case_id": case_id,
            "type": "note",
            "content": request.content,
            "sources": None,
        }).execute()

        # Update case timestamp
        supabase.table("cases").update({"updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", case_id).execute()

        return {"evidence": res.data[0] if res.data else {}}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}")
async def update_case(case_id: str, request: UpdateCaseRequest):
    """Update case status or title."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        updates = {}
        if request.status is not None:
            updates["status"] = request.status
        if request.title is not None:
            updates["title"] = request.title
        if not updates:
            return JSONResponse(status_code=400, content={"error": "No fields to update"})

        updates["updated_at"] = "now()"
        res = supabase.table("cases").update(updates).eq("id", case_id).execute()
        if not res.data:
            return JSONResponse(status_code=404, content={"error": "Case not found"})
        return {"case": res.data[0]}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}")
async def delete_case(case_id: str):
    """Delete a case and cascade evidence."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        supabase.table("cases").delete().eq("id", case_id).execute()
        return {"status": "deleted"}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/search/targeted")
async def targeted_search(request: TargetedSearchRequest):
    """Keyword search + optional network extraction."""
    if not index:
        return JSONResponse(status_code=503, content={"error": "Pinecone index not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})

    keyword = request.keyword.strip()
    if not keyword:
        return JSONResponse(status_code=400, content={"error": "keyword is required"})

    try:
        # 1. Embed the keyword once
        emb_res = client.models.embed_content(
            model="gemini-embedding-001", contents=[keyword]
        )
        embedding = emb_res.embeddings[0].values

        # 2. Three Pinecone queries: semantic + people filter + orgs filter
        sem_results = index.query(vector=embedding, top_k=200, include_metadata=True)
        people_results = index.query(
            vector=embedding, top_k=200, include_metadata=True,
            filter={"people": {"$in": [keyword]}}
        )
        org_results = index.query(
            vector=embedding, top_k=200, include_metadata=True,
            filter={"organizations": {"$in": [keyword]}}
        )

        # 3. Deduplicate by vector ID
        seen_ids = set()
        all_matches = []
        for result_set in [sem_results, people_results, org_results]:
            for r in result_set.matches:
                if r.id not in seen_ids and r.metadata:
                    seen_ids.add(r.id)
                    all_matches.append(r)

        # 4. Extract text and post-filter for literal keyword mentions
        keyword_lower = keyword.lower()
        chunks = []
        for r in all_matches:
            text = ""
            if '_node_content' in r.metadata:
                try:
                    text = json.loads(r.metadata['_node_content']).get('text', '')
                except (json.JSONDecodeError, TypeError):
                    pass
            if not text:
                text = r.metadata.get('text', '')
            if not text or keyword_lower not in text.lower():
                continue
            chunks.append({
                "id": r.id,
                "text": text,
                "filename": r.metadata.get('filename', 'unknown'),
                "page": r.metadata.get('page', r.metadata.get('chunk_index', 0)),
                "score": r.score,
            })

        unique_files = len(set(c["filename"] for c in chunks))
        stats = {"total_mentions": len(chunks), "unique_files": unique_files}

        # --- Search-only mode ---
        if not request.extract:
            return {"chunks": chunks, "stats": stats}

        # --- Extract mode ---
        if not chunks:
            return graph_store.load()

        context_parts = []
        for c in chunks:
            context_parts.append(f"[Source: {c['filename']}, Page: {c['page']}]\n{c['text']}")
        context = "\n\n---\n\n".join(context_parts)

        prompt = (
            "You are an investigative intelligence analyst. Extract entities and their relationships from these documents.\n\n"
            "RULES:\n"
            "1. Every entity needs an id (lowercase_snake_case), a label (display name), a type (PERSON, ORGANIZATION, LOCATION, EVENT, DOCUMENT, FINANCIAL_ENTITY), a description, and aliases (alternate names).\n"
            "2. Every relationship (triple) MUST include:\n"
            "   - subject_id and object_id referencing entity ids\n"
            "   - predicate: a lowercase_snake_case verb phrase (e.g. 'flew_with', 'employed_by', 'transferred_funds_to', 'visited', 'owns')\n"
            "   - evidence_text: the EXACT verbatim quote from the document that proves this relationship\n"
            "   - source_filename: the filename from the [Source: ...] header\n"
            "   - source_page: the page number from the [Source: ...] header\n"
            "   - confidence: 'STATED' if directly stated in the text, 'INFERRED' if logically deduced from context\n"
            "   - date_mentioned: ISO date (YYYY-MM-DD) if a date is mentioned, null otherwise\n"
            "3. Do NOT invent relationships that aren't supported by the text.\n"
            "4. Extract as many entities and relationships as the documents support.\n\n"
            f"DOCUMENTS:\n{context}\n\n"
            "Return JSON with 'entities' and 'triples' keys."
        )

        res = client.models.generate_content(
            model="gemini-2.5-pro",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CaseMap
            )
        )
        output = res.parsed

        import math
        new_nodes = []
        total = len(output.entities)
        cx, cy = 400, 400
        radius = max(200, total * 30)
        for i, ent in enumerate(output.entities):
            angle = (2 * math.pi * i) / max(total, 1)
            new_nodes.append({
                "id": ent.id,
                "type": "entityNode",
                "data": {
                    "label": ent.label,
                    "entityType": ent.type.upper(),
                    "description": ent.description,
                    "aliases": ent.aliases,
                },
                "position": {
                    "x": cx + radius * math.cos(angle),
                    "y": cy + radius * math.sin(angle),
                },
            })

        seen_edge_ids = set()
        new_edges = []
        for triple in output.triples:
            edge_id = f"e-{triple.subject_id}-{triple.predicate}-{triple.object_id}"
            if edge_id in seen_edge_ids:
                continue
            seen_edge_ids.add(edge_id)
            new_edges.append({
                "id": edge_id,
                "source": triple.subject_id,
                "target": triple.object_id,
                "label": triple.predicate.replace("_", " "),
                "animated": triple.confidence == "INFERRED",
                "style": {"strokeDasharray": "5 5"} if triple.confidence == "INFERRED" else {},
                "data": {
                    "predicate": triple.predicate,
                    "evidence_text": triple.evidence_text,
                    "source_filename": triple.source_filename,
                    "source_page": triple.source_page,
                    "confidence": triple.confidence,
                    "date_mentioned": triple.date_mentioned,
                },
            })

        graph_store.add_elements(new_nodes, new_edges)

        # Run community detection
        try:
            from api.graph_ops import compute_communities
        except ImportError:
            try:
                from graph_ops import compute_communities
            except ImportError:
                compute_communities = None

        if compute_communities:
            graph_data = graph_store.load()
            graph_data = compute_communities(graph_data)
            updated = []
            for node in graph_data.get("nodes", []):
                if "communityId" in node["data"]:
                    updated.append({
                        "id": node["id"],
                        "metadata": {
                            "degree": node["data"].get("degree", 0),
                            "communityId": node["data"]["communityId"],
                            "communityColor": node["data"]["communityColor"],
                        }
                    })
            if updated:
                supabase.table("nodes").upsert(updated, on_conflict="id").execute()

        return graph_store.load()
    except Exception as e:
        print(f"Targeted search failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/upload")
async def upload_file(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    temp_dir = tempfile.mkdtemp()
    file_path = os.path.join(temp_dir, file.filename)
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    background_tasks.add_task(process_upload, file_path, file.filename)
    return {"status": "Processing"}

def extract_text_from_pdf(file_path, filename):
    """Extract text from PDF, using Gemini vision for scanned/poor-quality pages."""
    reader = PdfReader(file_path)
    all_text = []

    # First pass: try standard text extraction
    has_good_text = False
    for page_num, page in enumerate(reader.pages):
        text = (page.extract_text() or "").strip()
        clean_words = [w for w in text.split() if len(w) > 2 and w.isalpha()]
        if len(clean_words) >= 10:
            has_good_text = True
            all_text.append({"text": text, "page": page_num + 1})

    # If standard extraction found good text, use it
    if has_good_text and len(all_text) > len(reader.pages) * 0.3:
        return all_text

    # Otherwise, use Gemini vision to read the scanned PDF directly
    print(f"DEBUG: Standard OCR insufficient for {filename}, using Gemini vision...")
    all_text = []
    try:
        with open(file_path, "rb") as f:
            pdf_bytes = f.read()
        response = client.models.generate_content(
            model="gemini-2.5-pro",
            contents=[
                types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"),
                "Extract ALL text from this document. Preserve the structure and content as faithfully as possible. Return only the extracted text."
            ]
        )
        full_text = response.text.strip()
        if full_text:
            all_text.append({"text": full_text, "page": 1})
    except Exception as e:
        print(f"DEBUG: Gemini vision OCR failed for {filename}: {e}")
        # Fall back to whatever pypdf got
        for page_num, page in enumerate(reader.pages):
            text = (page.extract_text() or "").strip()
            if text:
                all_text.append({"text": text, "page": page_num + 1})

    return all_text

def _extract_chunk_metadata(chunk_text):
    """Use Gemini Flash to extract structured metadata from a text chunk."""
    try:
        res = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=(
                "Extract metadata from this text. Return JSON with these keys:\n"
                '- "people": list of person names mentioned (empty list if none)\n'
                '- "organizations": list of organization names (empty list if none)\n'
                '- "dates": list of dates in ISO format YYYY-MM-DD (empty list if none)\n'
                '- "doc_type": one of "flight_log", "deposition", "financial_record", "correspondence", "legal_filing", "report", "other"\n\n'
                f"TEXT:\n{chunk_text[:1500]}"
            ),
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
            )
        )
        meta = json.loads(res.text)
        return {
            "people": meta.get("people", [])[:20],
            "organizations": meta.get("organizations", [])[:20],
            "dates": meta.get("dates", [])[:10],
            "doc_type": meta.get("doc_type", "other"),
        }
    except Exception as e:
        print(f"DEBUG: Metadata extraction failed for chunk: {e}")
        return {}


def process_upload(file_path, filename):
    try:
        if not bucket:
            print(f"Error: GCS bucket not initialized. Could not upload {filename}.")
            return
        if not client:
            print(f"Error: GenAI client not initialized. Could not index {filename}.")
            return
        if not index:
            print(f"Error: Pinecone index not initialized. Could not index {filename}.")
            return

        blob = bucket.blob(f"uploads/{filename}")
        blob.upload_from_filename(file_path)

        pages = extract_text_from_pdf(file_path, filename)
        print(f"DEBUG: Extracted {len(pages)} pages from {filename}")

        UPLOAD_CHUNK_SIZE = 1500
        UPLOAD_CHUNK_OVERLAP = 200
        UPSERT_BATCH_SIZE = 100

        batch = []
        for page_data in pages:
            text = page_data["text"]
            page_num = page_data["page"]
            start = 0
            i = 0
            while start < len(text):
                chunk = text[start:start + UPLOAD_CHUNK_SIZE].strip()
                if chunk:
                    vec_id = f"{filename}-p{page_num}-{i}"

                    # Extract enriched metadata
                    enriched = _extract_chunk_metadata(chunk)

                    for attempt in range(3):
                        try:
                            res = client.models.embed_content(model="gemini-embedding-001", contents=[chunk])
                            meta = {
                                "text": chunk, "filename": filename, "page": page_num,
                                "gcs_path": f"gs://{GCS_BUCKET}/uploads/{filename}",
                            }
                            meta.update(enriched)
                            batch.append((vec_id, res.embeddings[0].values, meta))
                            break
                        except Exception as e:
                            if attempt < 2:
                                wait = (attempt + 1) * 5
                                print(f"    Embed retry {attempt+1} for {vec_id} (waiting {wait}s): {e}")
                                import time; time.sleep(wait)
                            else:
                                print(f"    FAILED to embed {vec_id}: {e}")
                    if len(batch) >= UPSERT_BATCH_SIZE:
                        index.upsert(vectors=batch)
                        batch = []
                    i += 1
                start += UPLOAD_CHUNK_SIZE - UPLOAD_CHUNK_OVERLAP

        if batch:
            index.upsert(vectors=batch)
        print(f"DEBUG: Finished indexing {filename}")
    finally:
        shutil.rmtree(os.path.dirname(file_path), ignore_errors=True)

@app.get("/api/datasets")
async def get_datasets():
    """Return per-dataset pipeline stats from pipeline_status.json in GCS."""
    try:
        if not bucket:
            return JSONResponse(status_code=503, content={"error": "GCS bucket not initialized"})
        blob = bucket.blob("pipeline_status.json")
        if not blob.exists():
            return {"datasets": {}, "totals": {}, "last_updated": None}
        data = json.loads(blob.download_as_text())
        return data
    except Exception as e:
        print(f"Error reading pipeline status: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/graph/communities")
async def detect_communities():
    try:
        from api.graph_ops import compute_communities
    except ImportError:
        try:
            from graph_ops import compute_communities
        except ImportError as e:
            print(f"DEBUG: graph_ops unavailable: {e}")
            return {"error": f"networkx not installed: {e}"}
    try:
        graph_data = graph_store.load()
        graph_data = compute_communities(graph_data)
        # The community detection modifies the graph data directly, so we need to
        # update the nodes in Supabase. Edges remain unchanged by community detection.
        # We don't need to call graph_store.save(graph_data) as it's for GCS backup.
        
        # Instead, we directly update nodes in Supabase with community info
        updated_nodes_for_community = []
        for node in graph_data.get("nodes", []):
            if "communityId" in node["data"]:
                updated_nodes_for_community.append({
                    "id": node["id"],
                    "metadata": { # Update only the metadata JSONB field
                        "degree": node["data"].get("degree", 0),
                        "communityId": node["data"]["communityId"],
                        "communityColor": node["data"]["communityColor"],
                    }
                })
        if updated_nodes_for_community:
            supabase.table("nodes").upsert(updated_nodes_for_community, on_conflict="id").execute()

        return graph_store.load() # Reload from Supabase to get latest with communities
    except Exception as e:
        print(f"Community detection failed: {e}")
        return graph_store.load()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

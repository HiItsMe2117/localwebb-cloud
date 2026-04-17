import os
import re
import json
import shutil
import tempfile
import time
import platform
import uuid
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any
import jwt as pyjwt
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, Request, Query, Depends, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

try:
    from api.llm import generate, generate_stream
except ImportError:
    from llm import generate, generate_stream

# Direct Cloud SDKs
from pinecone import Pinecone
from google import genai
from google.genai import types
from google.cloud import storage
from pypdf import PdfReader
from supabase import create_client, Client

load_dotenv()

app = FastAPI(title="LocalWebb Cloud API")
_server_start_time = time.time()

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

# --- Auth Configuration ---
# Transitioned to Supabase Auth

async def require_user(authorization: str = Header(None)):
    """Dependency that ensures the user is authenticated via Supabase."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = authorization.split(" ", 1)[1]
    
    try:
        # Supabase client is initialized globally further down
        user_res = supabase.auth.get_user(token)
        if not user_res or not user_res.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        return user_res.user
    except Exception as e:
        print(f"Auth error: {e}")
        raise HTTPException(status_code=401, detail="Authentication failed")


async def optional_user(authorization: str = Header(None)):
    """Optional version of require_user."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        return await require_user(authorization)
    except Exception:
        return None


async def require_admin(user = Depends(require_user)):
    """Dependency that ensures the authenticated user is an admin."""
    try:
        profile_res = supabase.table("profiles").select("role").eq("id", user.id).execute()
        if not profile_res.data or profile_res.data[0].get("role") != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")
        return user
    except HTTPException:
        raise
    except Exception as e:
        print(f"Role check error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


async def require_paid(user = Depends(require_user)):
    """Dependency that ensures the user has a paid role (basic, pro, elite, or admin).
    Also checks that the subscription hasn't expired past current_period_end."""
    try:
        profile_res = supabase.table("profiles").select(
            "role, subscription_status, current_period_end"
        ).eq("id", user.id).execute()
        if not profile_res.data:
            raise HTTPException(status_code=403, detail="User profile not found")

        profile = profile_res.data[0]
        role = profile.get("role")

        # Admins always pass
        if role == "admin":
            return user

        if role not in ["pro", "elite", "basic"]:
            raise HTTPException(status_code=403, detail="Paid subscription required for this feature")

        # Check subscription hasn't expired (close the loophole)
        period_end = profile.get("current_period_end")
        if period_end:
            from datetime import datetime, timezone
            try:
                if isinstance(period_end, (int, float)):
                    expiry = datetime.fromtimestamp(period_end, tz=timezone.utc)
                else:
                    expiry = datetime.fromisoformat(str(period_end).replace("Z", "+00:00"))
                if datetime.now(timezone.utc) > expiry:
                    # Subscription expired — downgrade and reject
                    supabase.table("profiles").update({
                        "role": "standard",
                        "subscription_status": "expired",
                    }).eq("id", user.id).execute()
                    raise HTTPException(status_code=403, detail="Subscription expired")
            except HTTPException:
                raise
            except Exception:
                pass  # If date parsing fails, don't block — let them through

        return user
    except HTTPException:
        raise
    except Exception as e:
        print(f"Paid check error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")



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

# Import and include billing router (must be after supabase and require_user are defined)
try:
    from api.billing import router as billing_router
    app.include_router(billing_router)
except ImportError:
    try:
        from billing import router as billing_router
        app.include_router(billing_router)
    except ImportError:
        print("Warning: Billing router could not be loaded")

# --- SMS Notifications ---
try:
    from api.notify import send_sms
except ImportError:
    from notify import send_sms

@app.post("/api/ping")
async def site_visit():
    """Notify on every site visit."""
    send_sms("Someone just visited your site!")
    return {"ok": True}

@app.post("/api/notify/signup")
async def signup_notification(request: Request):
    """Notify when a new account is created."""
    body = await request.json()
    email = body.get("email", "unknown")
    username = body.get("username", "unknown")
    send_sms(f"New account created! {username} ({email})")
    return {"ok": True}


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

    def _fetch_nodes_filtered(self, min_degree: int):
        """Fetch nodes filtered by minimum degree from metadata->>degree."""
        if min_degree <= 1:
            return self._fetch_all("nodes")
        all_rows = []
        page_size = 1000
        offset = 0
        while True:
            res = (supabase.table("nodes")
                   .select("*")
                   .gte("metadata->>degree", min_degree)
                   .range(offset, offset + page_size - 1)
                   .execute())
            all_rows.extend(res.data)
            if len(res.data) < page_size:
                break
            offset += page_size
        return all_rows

    def load(self, min_degree: int = 1):
        """Load graph from Supabase for ReactFlow compatibility, with server-side degree filtering."""
        if not supabase:
            print("ERROR: Supabase client not initialized. Cannot load graph.")
            return {"nodes": [], "edges": [], "total_nodes": 0}

        try:
            # Fetch nodes with degree filter applied server-side
            nodes_data = self._fetch_nodes_filtered(min_degree)
            node_ids = {n["id"] for n in nodes_data}

            # Cheap unfiltered count of all entities (used for the chat-tab pill)
            try:
                total_res = supabase.table("nodes").select("id", count="estimated").limit(0).execute()
                total_nodes = total_res.count or 0
            except Exception as e:
                print(f"Warning: failed to fetch total node count: {e}")
                total_nodes = len(nodes_data)

            # Fetch all edges, then filter to only those between visible nodes
            edges_data = self._fetch_all("edges")
            edges_data = [e for e in edges_data if e.get("source") in node_ids and e.get("target") in node_ids]

            # Format nodes for ReactFlow
            nodes = []
            for n in nodes_data:
                node_data = n.get("metadata") or {}
                position = n.get("position") or {"x": 0, "y": 0}
                nodes.append({
                    "id": n["id"],
                    "type": "entityNode",
                    "data": {
                        "label": n.get("label") or n["id"],
                        "entityType": n.get("type") or "UNKNOWN",
                        "description": n.get("description") or "",
                        "aliases": n.get("aliases") or [],
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
                    "label": e.get("label") or e.get("predicate") or "",
                    "animated": e.get("confidence") == "INFERRED",
                    "style": {"strokeDasharray": "5 5"} if e.get("confidence") == "INFERRED" else {},
                    "data": {
                        "predicate": e.get("predicate") or "",
                        "evidence_text": e.get("evidence_text") or "",
                        "source_filename": e.get("source_filename") or "",
                        "source_page": e.get("source_page") or 0,
                        "confidence": e.get("confidence") or "STATED",
                        "date_mentioned": e.get("date_mentioned"),
                    }
                })

            return {"nodes": nodes, "edges": edges, "total_nodes": total_nodes}
        except Exception as e:
            print(f"CRITICAL: Error loading graph from Supabase: {e}")
            import traceback; traceback.print_exc()
            return {"nodes": [], "edges": [], "total_nodes": 0}

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
                    "date_mentioned": e["data"].get("date_mentioned") or None,
                })
            if edge_records:
                # Using upsert to insert new edges or update existing ones
                supabase.table("edges").upsert(edge_records, on_conflict="id").execute()
                
        except Exception as e:
            print(f"Failed to upsert elements to Supabase: {e}")

graph_store = SupabaseStore()

# Endpoint to migrate GCS graph to Supabase
@app.post("/api/graph/migrate", dependencies=[Depends(require_admin)])
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
    type: str  # PERSON, ORGANIZATION, LOCATION, EVENT, FINANCIAL_ENTITY
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
    date_mentioned: str = ""

class CaseMap(BaseModel):
    entities: List[Entity]
    triples: List[Triple]

EXTRACTION_PROMPT_TEMPLATE = (
    "You are an investigative intelligence analyst. Extract entities and their relationships from these documents.\n\n"
    "RULES:\n"
    "1. Every entity needs an id (lowercase_snake_case), a label (display name), a type (PERSON, ORGANIZATION, LOCATION, EVENT, FINANCIAL_ENTITY), a description, and aliases (alternate names).\n"
    "2. Every relationship (triple) MUST include:\n"
    "   - subject_id and object_id referencing entity ids\n"
    "   - predicate: a lowercase_snake_case verb phrase (e.g. 'flew_with', 'employed_by', 'transferred_funds_to', 'visited', 'owns')\n"
    "   - evidence_text: the EXACT verbatim quote from the document that proves this relationship\n"
    "   - source_filename: the filename from the [Source: ...] header\n"
    "   - source_page: the page number from the [Source: ...] header\n"
    "   - confidence: 'STATED' if directly stated in the text, 'INFERRED' if logically deduced from context\n"
    "   - date_mentioned: ISO date (YYYY-MM-DD) if a date is mentioned, empty string otherwise\n"
    "3. Do NOT use generic legal roles (e.g., 'THE WITNESS', 'THE DEFENDANT', 'THE AGENT', 'COUNSEL') as aliases. Instead, use the document context (headers, questions) to resolve these roles to the specific named entity they refer to.\n"
    "4. Do NOT invent relationships that aren't supported by the text.\n"
    "5. QUALITY OVER QUANTITY — only extract entities that are meaningful and identifiable:\n"
    "   - Do NOT create entities for document filenames or IDs (e.g., 'EFTA02341172', 'Exhibit A')\n"
    "   - Do NOT create entities for single initials or 1-2 character labels (e.g., 'G', 'JJ', 'MM') unless you can resolve them to a full name\n"
    "   - Do NOT create entities for generic or unidentifiable references (e.g., 'unknown person', 'a friend', 'the driver')\n"
    "   - Every entity MUST have a meaningful description that explains WHO/WHAT they are — not just 'mentioned in the document'\n"
    "   - Only create an entity if it has at least one meaningful relationship to another entity\n"
    "6. ENTITY TYPES — use only: PERSON, ORGANIZATION, LOCATION, EVENT, FINANCIAL_ENTITY. Do NOT use DOCUMENT, OBJECT, VEHICLE, DEVICE, or other types.\n"
    "7. PREFER EXISTING ENTITIES — if an entity likely refers to someone/something already well-known (e.g., a head of state, major company), use the most recognized full name as the label.\n\n"
    "DOCUMENTS:\n{context}\n\n"
    "Return JSON with 'entities' and 'triples' keys."
)

# --- Quality gate for extracted entities ---
_DOC_ID_RE = re.compile(r'^e[a-z]?[fpuh]?ta\d', re.IGNORECASE)
_GENERIC_DESC_RE = re.compile(
    r'^(a |an )?(person|individual|entity|organization|document|location|someone|something)?\s*'
    r'(mentioned|referenced|noted|found|listed|described)\s*(in|within)',
    re.IGNORECASE
)
_BAD_ENTITY_TYPES = {"DOCUMENT", "OBJECT", "VEHICLE", "DEVICE"}


def filter_quality_entities(entities: List[Entity]) -> List[Entity]:
    """Filter out junk entities that would pollute the knowledge graph."""
    quality = []
    for ent in entities:
        label = ent.label.strip()
        if len(label) <= 2:
            continue
        if _DOC_ID_RE.match(label) or _DOC_ID_RE.match(ent.id):
            continue
        if ent.type.upper() in _BAD_ENTITY_TYPES:
            continue
        if _GENERIC_DESC_RE.match(ent.description.strip()) and len(ent.description) < 60:
            continue
        quality.append(ent)
    return quality

class FilteredQueryRequest(BaseModel):
    query: str
    top_k: int = 15
    stream: bool = False
    doc_type: Optional[str] = None
    person_filter: Optional[str] = None
    org_filter: Optional[str] = None
    location_filter: Optional[str] = None

class TargetedSearchRequest(BaseModel):
    keyword: str
    extract: bool = False
    page: int = 1
    page_size: int = 50
    search_mode: str = "fulltext"  # "fulltext" or "exact"
    batch_offset: int = 0  # chunk offset for batched extraction
    batch_size: int = 25   # chunks per extraction batch

class InvestigateRequest(BaseModel):
    query: str
    entity_id: Optional[str] = None
    mode: str = "files_only"

class CreateCaseRequest(BaseModel):
    title: str
    category: str
    summary: str
    confidence: float = 0.5
    entities: List[str] = []
    suggested_questions: List[str] = []
    evidence_sources: List[Dict[str, Any]] = []
    is_public: bool = False
    source: str = "manual"

class UpdateCaseRequest(BaseModel):
    status: Optional[str] = None
    title: Optional[str] = None
    category: Optional[str] = None
    summary: Optional[str] = None
    is_public: Optional[bool] = None

class BulkUpdateCasesRequest(BaseModel):
    case_ids: List[str]
    is_public: bool

class AddNoteRequest(BaseModel):
    content: str

class UpdateNoteRequest(BaseModel):
    content: str

class AddGraphEntitiesRequest(BaseModel):
    node_ids: List[str]
    positions: Optional[Dict[str, Dict[str, float]]] = None  # {"node_id": {"x": 0, "y": 0}}

class SavePositionsRequest(BaseModel):
    positions: List[Dict[str, Any]]  # [{"node_id": "x", "x": 0.0, "y": 0.0}]

class AnalyzeEntitiesRequest(BaseModel):
    node_ids: List[str]

class GraphChatRequest(BaseModel):
    node_ids: List[str]
    messages: List[Dict[str, str]]
    mode: Optional[str] = "files_only"

class CaseChatRequest(BaseModel):
    messages: List[Dict[str, str]]
    mode: Optional[str] = "files_only"

class CreateCaseEdgeRequest(BaseModel):
    source_node_id: str
    target_node_id: str
    label: str = ""
    is_hypothesis: bool = False

class UpdateCaseEdgeRequest(BaseModel):
    label: Optional[str] = None
    label_position: Optional[float] = None

class CreateCustomNodeRequest(BaseModel):
    label: str
    type: str

class LikeCaseRequest(BaseModel):
    case_id: str

class FollowUserRequest(BaseModel):
    target_user_id: str

class UpdateEntityDescriptionRequest(BaseModel):
    description: str = ""

class CreateGroupRequest(BaseModel):
    label: str = ""
    color: str = "#007AFF"
    node_ids: List[str] = []

class UpdateGroupRequest(BaseModel):
    label: Optional[str] = None
    color: Optional[str] = None
    node_ids: Optional[List[str]] = None

class AttachDocumentRequest(BaseModel):
    url: str
    note: str = ""

class CreateStickyNoteRequest(BaseModel):
    content: str = ""
    color: str = "#FBBF24"
    position_x: float = 0
    position_y: float = 0
    width: float = 280
    height: float = 200

class UpdateStickyNoteRequest(BaseModel):
    content: Optional[str] = None
    color: Optional[str] = None
    width: Optional[float] = None
    height: Optional[float] = None

class TheoryInvestigateRequest(BaseModel):
    theory: str
    case_ids: List[str] = []
    mode: Optional[str] = "files_only"

class TheoryFollowUpRequest(BaseModel):
    theory: str
    verdict_summary: str
    entity_context: str
    evidence_summary: str
    messages: List[Dict[str, str]]
    mode: Optional[str] = "files_only"

# --- Endpoints ---

@app.get("/api")
async def api_health():
    return {"status": "LocalWebb Cloud API is active"}

@app.get("/api/files/{filename:path}")
async def get_file(filename: str, page: Optional[str] = Query(None)):
    if not bucket:
        return JSONResponse(status_code=503, content={"error": "Storage not available"})
    
    filename = filename.strip()
    # Handle common hallucination: double .pdf or missing .pdf
    if not filename.endswith(".pdf"):
        filename += ".pdf"
    filename = filename.replace(".pdf.pdf", ".pdf")

    blob = bucket.blob(f"uploads/{filename}")
    if not blob.exists():
        # Check subfolders (dataset-1, dataset-2, etc.)
        for ds_num in range(1, 15):
            candidate = bucket.blob(f"uploads/dataset-{ds_num}/{filename}")
            if candidate.exists():
                blob = candidate
                break

    if not blob.exists():
        print(f"ERROR: File not found in GCS: uploads/{filename} (or subfolders)")
        return JSONResponse(status_code=404, content={"error": f"File not found: {filename}"})
    
    signed_url = blob.generate_signed_url(
        version="v4",
        expiration=timedelta(minutes=15),
        method="GET",
        response_type="application/pdf",
    )
    if page:
        # Extract first number from potential string like "2, 3" or "page 5"
        import re
        m = re.search(r'(\d+)', str(page))
        if m:
            signed_url += f"#page={m.group(1)}"
    return RedirectResponse(url=signed_url, status_code=302)

@app.get("/api/graph")
async def get_graph(min_degree: int = 1):
    return graph_store.load(min_degree=min_degree)

@app.post("/api/graph/positions", dependencies=[Depends(require_admin)])
async def update_positions(updates: List[PositionUpdate]):
    for update in updates:
        graph_store.update_node_position(update.id, update.x, update.y)
    return {"status": "positions updated"}

@app.get("/api/insights")
async def get_insights(depth: str = "standard", focus: Optional[str] = None, strict: bool = False, user = Depends(require_admin)):
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

        prompt = EXTRACTION_PROMPT_TEMPLATE.format(context=context)

        print("DEBUG: Sending extraction prompt to Gemini...")
        res = generate(
            client,
            model="gemini-2.5-pro",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CaseMap
            )
        )

        output = res.parsed
        print(f"DEBUG: Gemini extracted {len(output.entities)} entities, {len(output.triples)} triples")

        quality_entities = filter_quality_entities(output.entities)
        print(f"DEBUG: After quality gate: {len(quality_entities)}/{len(output.entities)} entities kept")

        entity_map = {ent.id: ent for ent in quality_entities}

        import math
        new_nodes = []
        total = len(quality_entities)
        cx, cy = 400, 400
        radius = max(200, total * 30)
        for i, ent in enumerate(quality_entities):
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

        entity_ids = {ent.id for ent in quality_entities}
        seen_edge_ids = set()
        new_edges = []
        for triple in output.triples:
            if triple.subject_id not in entity_ids or triple.object_id not in entity_ids:
                continue
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
    if hasattr(request, 'location_filter') and request.location_filter:
        pinecone_filter["locations"] = {"$in": [request.location_filter]}

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
async def query_index(request: FilteredQueryRequest, user = Depends(require_paid)):
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
                    stream = generate_stream(
                        client,
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

        response = generate(
            client,
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
async def investigate(request: InvestigateRequest, user = Depends(require_paid)):
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

    # Fetch entity context if provided
    case_context = None
    if request.entity_id:
        try:
            res = supabase.table("nodes").select("*").eq("id", request.entity_id).execute()
            if res.data:
                ent = res.data[0]
                case_context = {
                    "title": ent.get("label", ent["id"]),
                    "summary": ent.get("description", ""),
                    "entities": [ent.get("label", ent["id"])] + (ent.get("aliases") or []),
                }
        except Exception as e:
            print(f"DEBUG: Failed to fetch entity context: {e}")

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
            case_context=case_context,
            mode=request.mode,
        ),
        media_type="text/event-stream",
    )


# ---- Cases endpoints ----

@app.post("/api/cases/scan", dependencies=[Depends(require_admin)])
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


@app.post("/api/theories/investigate", dependencies=[Depends(require_admin)])
async def investigate_theory(request: TheoryInvestigateRequest):
    """Test a theory against the evidence corpus. Returns SSE stream."""
    if not index:
        return JSONResponse(status_code=503, content={"error": "Pinecone index not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})

    # Load cross-reference case data if case_ids provided
    cross_ref_cases = []
    for cid in request.case_ids[:5]:
        try:
            case_res = supabase.table("cases").select("*").eq("id", cid).execute()
            if case_res.data:
                case_data = case_res.data[0]
                ev_res = supabase.table("case_evidence").select("content").eq("case_id", cid).limit(10).execute()
                evidence_texts = [e["content"][:500] for e in (ev_res.data or []) if e.get("content")]
                cross_ref_cases.append({
                    "id": cid,
                    "title": case_data["title"],
                    "summary": case_data.get("summary", ""),
                    "entities": case_data.get("entities", []),
                    "evidence_texts": evidence_texts,
                })
        except Exception as e:
            print(f"DEBUG: Failed to load cross-ref case {cid}: {e}")

    try:
        from api.theory import run_theory_investigation
    except ImportError:
        from theory import run_theory_investigation

    async def stream_and_log():
        async for event in run_theory_investigation(
            theory=request.theory,
            genai_client=client,
            pinecone_index=index,
            supabase_client=supabase,
            semantic_search_fn=_semantic_search_pass,
            rerank_fn=None,
            cross_ref_cases=cross_ref_cases if cross_ref_cases else None,
            mode=request.mode
        ):
            yield event
            if event.startswith("data: "):
                try:
                    data = json.loads(event[6:].strip())
                    if data.get("type") == "usage":
                        usage_dict = data.get("usage", {})
                        usage_meta = type('Usage', (), {
                            'prompt_token_count': usage_dict.get('prompt_token_count', 0),
                            'candidates_token_count': usage_dict.get('candidates_token_count', 0),
                            'total_token_count': usage_dict.get('total_token_count', 0)
                        })
                        log_usage(user, "/api/theories/investigate", "gemini-2.0-flash", usage_meta)
                except Exception: pass

    return StreamingResponse(stream_and_log(), media_type="text/event-stream")


@app.post("/api/theories/follow-up")
async def theory_follow_up(request: TheoryFollowUpRequest, user = Depends(require_paid)):
    """Follow-up conversation on a theory investigation. Returns SSE stream."""
    if not index:
        return JSONResponse(status_code=503, content={"error": "Pinecone index not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})

    try:
        from api.theory_followup import run_theory_followup
    except ImportError:
        from theory_followup import run_theory_followup

    async def stream_and_log():
        async for event in run_theory_followup(
            theory=request.theory,
            verdict_summary=request.verdict_summary,
            entity_context=request.entity_context,
            evidence_summary=request.evidence_summary,
            messages=request.messages,
            genai_client=client,
            pinecone_index=index,
            supabase_client=supabase,
            semantic_search_fn=_semantic_search_pass,
            rerank_fn=None,
            mode=request.mode
        ):
            yield event
            if event.startswith("data: "):
                try:
                    data = json.loads(event[6:].strip())
                    if data.get("type") == "usage":
                        usage_dict = data.get("usage", {})
                        usage_meta = type('Usage', (), {
                            'prompt_token_count': usage_dict.get('prompt_token_count', 0),
                            'candidates_token_count': usage_dict.get('candidates_token_count', 0),
                            'total_token_count': usage_dict.get('total_token_count', 0)
                        })
                        log_usage(user, "/api/theories/follow-up", "gemini-2.0-flash", usage_meta)
                except Exception: pass

    return StreamingResponse(stream_and_log(), media_type="text/event-stream")


@app.get("/api/cases")
async def list_cases(user = Depends(optional_user)):
    """List all cases viewable by the user (owned or public), ordered by updated_at desc."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        if user:
            # Show cases owned by the user OR public cases
            res = supabase.table("cases")\
                .select("*")\
                .or_(f"user_id.eq.{user.id},is_public.eq.true")\
                .order("updated_at", desc=True)\
                .execute()
        else:
            # Show ONLY public cases for anonymous users
            res = supabase.table("cases")\
                .select("*")\
                .eq("is_public", True)\
                .order("updated_at", desc=True)\
                .execute()
        
        return {"cases": res.data or []}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/cases/ai-research")
async def list_ai_research_cases(user = Depends(optional_user)):
    """List AI-generated cases (from scan or theory) with their subcases."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        # Get top-level AI cases
        if user:
            ai_res = supabase.table("cases")\
                .select("*")\
                .or_(f"user_id.eq.{user.id},is_public.eq.true")\
                .in_("source", ["scan", "theory"])\
                .order("updated_at", desc=True)\
                .execute()
        else:
            ai_res = supabase.table("cases")\
                .select("*")\
                .eq("is_public", True)\
                .in_("source", ["scan", "theory"])\
                .order("updated_at", desc=True)\
                .execute()

        ai_cases = ai_res.data or []
        ai_ids = [c["id"] for c in ai_cases]

        # Also fetch all subcases (any depth) parented under AI cases
        if ai_ids:
            all_cases = {c["id"]: c for c in ai_cases}
            # Iteratively find children until no new ones found
            parent_ids = ai_ids
            for _ in range(10):  # max depth guard
                if not parent_ids:
                    break
                children_res = supabase.table("cases")\
                    .select("*")\
                    .in_("parent_case_id", parent_ids)\
                    .execute()
                new_children = [c for c in (children_res.data or []) if c["id"] not in all_cases]
                if not new_children:
                    break
                for c in new_children:
                    all_cases[c["id"]] = c
                parent_ids = [c["id"] for c in new_children]
            return {"cases": list(all_cases.values())}

        return {"cases": ai_cases}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases")
async def create_case(request: CreateCaseRequest, user = Depends(require_user)):
    """Create a new case attached to the current user."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        row = {
            "user_id": user.id,
            "title": request.title,
            "category": request.category,
            "summary": request.summary,
            "status": "active",
            "confidence": request.confidence,
            "entities": request.entities,
            "suggested_questions": request.suggested_questions,
            "is_public": request.is_public,
            "source": request.source,
        }
        res = supabase.table("cases").insert(row).execute()
        
        if res.data:
            case_id = res.data[0]["id"]
            # Also create an initial evidence entry based on the finding
            evidence_row = {
                "case_id": case_id,
                "type": "investigation",
                "content": f"Initial AI Finding: {request.summary}",
                "sources": request.evidence_sources if request.evidence_sources else None
            }
            supabase.table("case_evidence").insert(evidence_row).execute()
            
        return {"case": res.data[0] if res.data else row}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


async def verify_case_ownership(case_id: str, user, write: bool = True):
    """Verify if the user can view or write to a case."""
    res = supabase.table("cases").select("user_id, is_public").eq("id", case_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Case not found")
    
    case = res.data[0]
    is_owner = user is not None and case.get("user_id") == str(user.id)
    is_public = case.get("is_public", False)

    is_unowned_public = is_public and case.get("user_id") is None
    if write and not is_owner and not is_unowned_public:
        raise HTTPException(status_code=403, detail="You do not have permission to modify this case")
    
    if not write and not (is_owner or is_public):
        raise HTTPException(status_code=403, detail="You do not have permission to view this case")
    
    return case


def log_usage(user, endpoint: str, model: str, usage_metadata, report_to_stripe: bool = False):
    """Log token usage for a user request to Supabase (non-blocking)."""
    if not usage_metadata:
        return
    try:
        total_tokens = getattr(usage_metadata, "total_token_count", 0)
        # Simple fire-and-forget logging.
        supabase.table("usage_logs").insert({
            "user_id": user.id if user else None,
            "endpoint": endpoint,
            "model": model,
            "prompt_tokens": getattr(usage_metadata, "prompt_token_count", 0),
            "completion_tokens": getattr(usage_metadata, "candidates_token_count", 0),
            "total_tokens": total_tokens,
        }).execute()

        # Report overage tokens to Stripe if requested
        if report_to_stripe and user and total_tokens > 0:
            try:
                from api.billing import report_usage_to_stripe
                report_usage_to_stripe(user.id, total_tokens)
            except ImportError:
                try:
                    from billing import report_usage_to_stripe
                    report_usage_to_stripe(user.id, total_tokens)
                except ImportError:
                    pass
    except Exception as e:
        print(f"Usage logging failed: {e}")


@app.get("/api/cases/trending")
async def get_trending_cases(q: Optional[str] = Query(None), user = Depends(optional_user)):
    """Fetch public cases, optionally filtered by a search query."""
    try:
        # Use service client to get all public cases regardless of who is asking
        query = supabase.table("cases").select("*").eq("is_public", True)
        if q:
            # Simple ilike search on title and summary
            query = query.or_(f"title.ilike.%{q}%,summary.ilike.%{q}%")
        
        res = query.order("updated_at", desc=True).limit(20).execute()
        return {"cases": res.data or []}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/cases/{case_id}")
async def get_case(case_id: str, user = Depends(optional_user)):
    """Get a case with its evidence, checking permissions."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=False)
        case_res = supabase.table("cases").select("*").eq("id", case_id).execute()
        if not case_res.data:
            return JSONResponse(status_code=404, content={"error": "Case not found"})

        case_data = case_res.data[0]
        evidence_res = supabase.table("case_evidence").select("*").eq("case_id", case_id).order("created_at", desc=True).execute()

        # Build breadcrumb trail (walk up parent_case_id, max 3 hops)
        breadcrumb = [{"id": case_data["id"], "title": case_data["title"]}]
        current = case_data
        for _ in range(3):
            pid = current.get("parent_case_id")
            if not pid:
                break
            parent_res = supabase.table("cases").select("id, title, parent_case_id").eq("id", pid).execute()
            if not parent_res.data:
                break
            current = parent_res.data[0]
            breadcrumb.insert(0, {"id": current["id"], "title": current["title"]})

        # Fetch child cases with counts
        children_res = supabase.table("cases").select("id, title, category, summary, status, depth").eq("parent_case_id", case_id).order("created_at").execute()
        children = []
        for child in (children_res.data or []):
            entity_count = supabase.table("case_graph_entities").select("id", count="exact").eq("case_id", child["id"]).execute()
            evidence_count = supabase.table("case_evidence").select("id", count="exact").eq("case_id", child["id"]).execute()
            timeline_count = supabase.table("case_timeline_events").select("id", count="exact").eq("case_id", child["id"]).execute()
            children.append({
                **child,
                "entity_count": entity_count.count or 0,
                "evidence_count": evidence_count.count or 0,
                "timeline_count": timeline_count.count or 0,
            })

        return {
            "case": case_data,
            "evidence": evidence_res.data or [],
            "breadcrumb": breadcrumb,
            "children": children,
        }
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/investigate")
async def investigate_case(case_id: str, user = Depends(require_paid)):
    """Run scoped investigation for a case. Returns SSE stream."""
    if not index:
        return JSONResponse(status_code=503, content={"error": "Pinecone index not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})

    # Verify ownership
    try:
        case_data = await verify_case_ownership(case_id, user, write=True)
    except HTTPException as e:
        return JSONResponse(status_code=e.status_code, content={"error": e.detail})

    try:
        from api.investigator import run_investigation
    except ImportError:
        from investigator import run_investigation

    # Fetch notes & prior evidence
    evidence_res = supabase.table("case_evidence").select("*").eq("case_id", case_id).order("created_at", desc=True).execute()
    notes = [e["content"] for e in (evidence_res.data or []) if e.get("type") == "note" and e.get("content")]

    # Fetch network map entities pinned to this case
    network_entities = []
    network_relationships = []
    graph_res = supabase.table("case_graph_entities").select("node_id").eq("case_id", case_id).execute()
    node_ids = [row["node_id"] for row in (graph_res.data or [])]
    if node_ids:
        # Get entity details from nodes table
        nodes_res = supabase.table("nodes").select("id,label,type,description,aliases").in_("id", node_ids).execute()
        network_entities = nodes_res.data or []

        # Get relationships between pinned entities
        edges_res = supabase.table("edges").select("source,target,label,predicate,evidence_text").in_("source", node_ids).in_("target", node_ids).execute()
        network_relationships = edges_res.data or []

    case_context = {
        "title": case_data["title"],
        "summary": case_data["summary"],
        "entities": case_data.get("entities", []),
        "suggested_questions": case_data.get("suggested_questions", []),
        "notes": notes,
        "network_entities": network_entities,
        "network_relationships": network_relationships,
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
                        # File-document sources (shape: {filename, page, score}) — merge into unified array
                        all_sources = all_sources + (data.get("sources", []) or [])
                    elif data.get("type") == "web_sources":
                        # Web sources (shape: {title, uri, domain}) — merge into unified array
                        all_sources = all_sources + (data.get("web_sources", []) or [])
                    elif data.get("type") == "usage":
                        # Log usage from stream
                        usage_dict = data.get("usage", {})
                        # Mock a usage metadata object for the helper
                        usage_meta = type('Usage', (), {
                            'prompt_token_count': usage_dict.get('prompt_token_count', 0),
                            'candidates_token_count': usage_dict.get('candidates_token_count', 0),
                            'total_token_count': usage_dict.get('total_token_count', 0)
                        })
                        log_usage(user, "/api/cases/investigate", "gemini-2.0-flash", usage_meta)
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


@app.post("/api/cases/{case_id}/consolidate")
async def consolidate_case_evidence(case_id: str, user = Depends(require_paid)):
    """Synthesize all evidence into a single master report."""
    if not supabase or not client:
        return JSONResponse(status_code=503, content={"error": "Cloud clients not initialized."})
    
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        # 1. Fetch all evidence
        ev_res = supabase.table("case_evidence").select("*").eq("case_id", case_id).execute()
        evidence = ev_res.data or []
        
        if not evidence:
            return JSONResponse(status_code=400, content={"error": "No evidence found to consolidate."})

        # 2. Build synthesis prompt
        context_parts = []
        all_sources = []
        for e in evidence:
            context_parts.append(f"--- Evidence Entry ({e['type']}, {e['created_at']}) ---\n{e['content']}")
            if e.get("sources"):
                all_sources.extend(e["sources"])

        # De-duplicate sources
        unique_sources = []
        seen_src = set()
        for s in all_sources:
            sig = f"{s.get('filename')}:{s.get('page')}"
            if sig not in seen_src:
                seen_src.add(sig)
                unique_sources.append(s)

        prompt = f"""You are a Lead Intelligence Analyst. You are tasked with synthesizing multiple investigative findings into a single, master "Consolidated Intelligence Report".

EXISTING EVIDENCE ENTRIES:
{"\n\n".join(context_parts)}

SYNTHESIS INSTRUCTIONS:
1. Combine all findings into a cohesive, highly-structured narrative.
2. REMOVE REDUNDANCIES: If multiple investigations found the same fact, state it once with all relevant context.
3. PRESERVE DETAIL: Do not lose specific names, dates, or dollar amounts.
4. STRUCTURE: Use Markdown. Include Executive Summary, Key Entities, Detailed Findings, and Remaining Gaps.
5. SOURCES: Maintain the integrity of evidence. You don't need to list them at the bottom, but ensure the narrative is derived from the provided entries.

Produce a professional, final investigative product."""

        # 3. Generate with Gemini (Groq fallback on rate limit)
        res = generate(
            client,
            model="gemini-2.5-pro",
            contents=prompt,
        )
        summary_text = res.text

        # Log usage
        log_usage(user, "/api/cases/consolidate", "gemini-2.5-pro", res.usage_metadata)

        # 4. Save as a new "Consolidated" evidence type

        new_ev = {
            "case_id": case_id,
            "type": "fact_check", # Using fact_check color/style for now or we can add a new one
            "content": summary_text,
            "sources": unique_sources[:20] # Keep a sample of the top sources
        }
        save_res = supabase.table("case_evidence").insert(new_ev).execute()
        
        return {"evidence": save_res.data[0]}
    except Exception as e:
        print(f"CRITICAL: Consolidation failed: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/notes")
async def add_case_note(case_id: str, request: AddNoteRequest, user = Depends(require_user)):
    """Add a note to a case."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

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


@app.patch("/api/cases/{case_id}/evidence/{evidence_id}")
async def update_evidence(case_id: str, evidence_id: str, request: UpdateNoteRequest, user = Depends(require_user)):
    """Update the content of a note."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        # Verify evidence exists and is a note
        ev_res = supabase.table("case_evidence").select("*").eq("id", evidence_id).eq("case_id", case_id).execute()
        if not ev_res.data:
            return JSONResponse(status_code=404, content={"error": "Evidence not found"})
        if ev_res.data[0]["type"] != "note":
            return JSONResponse(status_code=400, content={"error": "Only notes can be edited"})

        res = supabase.table("case_evidence").update({
            "content": request.content,
        }).eq("id", evidence_id).execute()

        # Update case timestamp
        supabase.table("cases").update({"updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", case_id).execute()

        return {"evidence": res.data[0] if res.data else {}}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/bulk-update")
async def bulk_update_cases(request: BulkUpdateCasesRequest, user = Depends(require_user)):
    """Bulk update is_public for multiple cases."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        # Verify ownership of all cases
        for case_id in request.case_ids:
            await verify_case_ownership(case_id, user, write=True)

        now = datetime.now(timezone.utc).isoformat()
        updated = []
        for case_id in request.case_ids:
            res = supabase.table("cases").update({
                "is_public": request.is_public,
                "updated_at": now,
            }).eq("id", case_id).execute()
            if res.data:
                updated.append(res.data[0])
        return {"cases": updated, "count": len(updated)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}")
async def update_case(case_id: str, request: UpdateCaseRequest, user = Depends(require_user)):
    """Update case status, title, or visibility."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        updates = {}
        if request.status is not None:
            updates["status"] = request.status
        if request.title is not None:
            updates["title"] = request.title
        if request.category is not None:
            updates["category"] = request.category
        if request.summary is not None:
            updates["summary"] = request.summary
        if request.is_public is not None:
            updates["is_public"] = request.is_public
        
        if not updates:
            return JSONResponse(status_code=400, content={"error": "No fields to update"})

        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        res = supabase.table("cases").update(updates).eq("id", case_id).execute()
        if not res.data:
            return JSONResponse(status_code=404, content={"error": "Case not found"})
        return {"case": res.data[0]}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}")
async def delete_case(case_id: str, user = Depends(require_user)):
    """Delete a case and cascade evidence."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        supabase.table("cases").delete().eq("id", case_id).execute()
        return {"status": "deleted"}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/merge")
async def merge_cases(case_id: str, request: Request, user = Depends(require_user)):
    """Merge one or more source cases INTO the target case_id.

    Copies all entities, edges, timeline events, timeline edges, tracks,
    evidence, and sticky notes from each source into the target.
    Source cases are then deleted.
    """
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        body = await request.json()
        source_ids: list = body.get("source_case_ids", [])
        if not source_ids:
            return JSONResponse(status_code=400, content={"error": "source_case_ids required"})

        # Verify ownership of target + all sources
        await verify_case_ownership(case_id, user, write=True)
        for sid in source_ids:
            await verify_case_ownership(sid, user, write=True)

        # ── Merge graph entities ──
        for sid in source_ids:
            rows = supabase.table("case_graph_entities").select("*").eq("case_id", sid).execute().data or []
            for r in rows:
                entry = {"case_id": case_id, "node_id": r["node_id"]}
                if r.get("position_x") is not None:
                    entry["position_x"] = r["position_x"]
                if r.get("position_y") is not None:
                    entry["position_y"] = r["position_y"]
                supabase.table("case_graph_entities").upsert(entry, on_conflict="case_id,node_id").execute()

        # ── Merge graph edges ──
        for sid in source_ids:
            rows = supabase.table("case_graph_edges").select("*").eq("case_id", sid).execute().data or []
            for r in rows:
                entry = {
                    "case_id": case_id,
                    "source_node_id": r["source_node_id"],
                    "target_node_id": r["target_node_id"],
                    "label": r.get("label", ""),
                }
                supabase.table("case_graph_edges").upsert(entry, on_conflict="case_id,source_node_id,target_node_id").execute()

        # ── Merge timeline tracks (create new ones in target) ──
        track_id_map: dict = {}  # old_track_id → new_track_id
        for sid in source_ids:
            tracks = supabase.table("case_timeline_tracks").select("*").eq("case_id", sid).execute().data or []
            for t in tracks:
                new_track = {
                    "case_id": case_id,
                    "label": t["label"],
                    "color": t.get("color", "#60a5fa"),
                }
                res = supabase.table("case_timeline_tracks").insert(new_track).execute()
                if res.data:
                    track_id_map[t["id"]] = res.data[0]["id"]

        # ── Merge timeline events ──
        event_id_map: dict = {}  # old_event_id → new_event_id
        for sid in source_ids:
            events = supabase.table("case_timeline_events").select("*").eq("case_id", sid).execute().data or []
            for ev in events:
                new_ev = {
                    "case_id": case_id,
                    "title": ev["title"],
                    "event_date": ev.get("event_date"),
                    "description": ev.get("description", ""),
                    "category": ev.get("category", "general"),
                    "source_graph_node_id": ev.get("source_graph_node_id"),
                    "position_x": ev.get("position_x", 0),
                    "position_y": ev.get("position_y", 0),
                    "sources": ev.get("sources"),
                }
                res = supabase.table("case_timeline_events").insert(new_ev).execute()
                if res.data:
                    event_id_map[ev["id"]] = res.data[0]["id"]
                    # Remap track assignments
                    old_mappings = supabase.table("case_timeline_event_tracks").select("track_id").eq("event_id", ev["id"]).execute().data or []
                    for m in old_mappings:
                        new_tid = track_id_map.get(m["track_id"])
                        if new_tid:
                            supabase.table("case_timeline_event_tracks").insert({"event_id": res.data[0]["id"], "track_id": new_tid}).execute()

        # ── Merge timeline edges ──
        for sid in source_ids:
            edges = supabase.table("case_timeline_edges").select("*").eq("case_id", sid).execute().data or []
            for ed in edges:
                new_src = event_id_map.get(ed["source_event_id"])
                new_tgt = event_id_map.get(ed["target_event_id"])
                if new_src and new_tgt:
                    supabase.table("case_timeline_edges").insert({
                        "case_id": case_id,
                        "source_event_id": new_src,
                        "target_event_id": new_tgt,
                        "label": ed.get("label", ""),
                    }).execute()

        # ── Merge evidence ──
        for sid in source_ids:
            rows = supabase.table("case_evidence").select("*").eq("case_id", sid).execute().data or []
            for r in rows:
                supabase.table("case_evidence").insert({
                    "case_id": case_id,
                    "type": r.get("type", "investigation"),
                    "content": r["content"],
                    "sources": r.get("sources"),
                }).execute()

        # ── Merge sticky notes ──
        try:
            for sid in source_ids:
                rows = supabase.table("case_graph_sticky_notes").select("*").eq("case_id", sid).execute().data or []
                for r in rows:
                    supabase.table("case_graph_sticky_notes").insert({
                        "case_id": case_id,
                        "content": r.get("content", ""),
                        "color": r.get("color", "#FFD60A"),
                        "position_x": r.get("position_x", 0),
                        "position_y": r.get("position_y", 0),
                        "width": r.get("width", 200),
                        "height": r.get("height", 150),
                    }).execute()
        except Exception:
            pass  # table may not exist

        # ── Re-parent child cases: point source children → target ──
        for sid in source_ids:
            supabase.table("cases").update({"parent_case_id": case_id}).eq("parent_case_id", sid).execute()

        # ── Delete source cases ──
        for sid in source_ids:
            supabase.table("cases").delete().eq("id", sid).execute()

        return {"status": "merged", "merged_count": len(source_ids)}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}/parent")
async def set_case_parent(case_id: str, request: Request, user = Depends(require_user)):
    """Move a case under a new parent (or to root by passing null)."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        body = await request.json()
        parent_id = body.get("parent_case_id")  # null = root

        await verify_case_ownership(case_id, user, write=True)
        if parent_id:
            await verify_case_ownership(parent_id, user, write=True)
            # Calculate new depth
            parent = supabase.table("cases").select("depth").eq("id", parent_id).execute()
            depth = ((parent.data[0].get("depth") or 0) + 1) if parent.data else 0
        else:
            depth = 0

        supabase.table("cases").update({"parent_case_id": parent_id, "depth": depth}).eq("id", case_id).execute()
        return {"status": "updated", "parent_case_id": parent_id, "depth": depth}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/cases/{case_id}/children/graph")
async def get_aggregated_child_graph(case_id: str, user = Depends(optional_user)):
    """Return the merged graph of the parent case + all direct child cases.

    Nodes from different child cases are tagged with source_case_id so the UI
    can color-code them.
    """
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=False)

        # Get child case ids
        children = supabase.table("cases").select("id, title").eq("parent_case_id", case_id).execute().data or []
        all_case_ids = [case_id] + [c["id"] for c in children]
        case_titles = {case_id: "(parent)"}
        for c in children:
            case_titles[c["id"]] = c["title"]

        all_nodes = []
        all_edges = []
        seen_node_ids: set = set()

        for cid in all_case_ids:
            pinned = supabase.table("case_graph_entities").select("*").eq("case_id", cid).execute().data or []
            node_ids = [r["node_id"] for r in pinned]
            position_map = {r["node_id"]: {"x": r.get("position_x"), "y": r.get("position_y")} for r in pinned}

            if node_ids:
                nodes_res = supabase.table("nodes").select("*").in_("id", node_ids).execute()
                for n in (nodes_res.data or []):
                    if n["id"] not in seen_node_ids:
                        meta = n.get("metadata") or {}
                        pos = position_map.get(n["id"], {})
                        all_nodes.append({
                            "id": n["id"],
                            "type": "entityNode",
                            "data": {
                                "label": n.get("label", n["id"]),
                                "entityType": n.get("type", "UNKNOWN"),
                                "description": n.get("description", ""),
                                "aliases": n.get("aliases", []),
                                "degree": meta.get("degree", 0),
                                "source_case_id": cid,
                                "source_case_title": case_titles.get(cid, ""),
                            },
                            "position": {"x": pos.get("x") or 0, "y": pos.get("y") or 0},
                        })
                        seen_node_ids.add(n["id"])

            edges_res = supabase.table("case_graph_edges").select("*").eq("case_id", cid).execute().data or []
            for e in edges_res:
                if e["source_node_id"] in seen_node_ids and e["target_node_id"] in seen_node_ids:
                    all_edges.append({
                        "id": e["id"],
                        "source": e["source_node_id"],
                        "target": e["target_node_id"],
                        "data": {
                            "label": e.get("label", ""),
                            "source_case_id": cid,
                            "source_case_title": case_titles.get(cid, ""),
                        },
                    })

        return {"nodes": all_nodes, "edges": all_edges, "child_cases": children}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/cases/{case_id}/children/timeline")
async def get_aggregated_child_timeline(case_id: str, user = Depends(optional_user)):
    """Return the merged timeline of the parent case + all direct child cases.

    Each child case's events are tagged with source_case_id for color-coding.
    """
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=False)

        children = supabase.table("cases").select("id, title").eq("parent_case_id", case_id).execute().data or []
        all_case_ids = [case_id] + [c["id"] for c in children]
        case_titles = {case_id: "(parent)"}
        for c in children:
            case_titles[c["id"]] = c["title"]

        all_nodes = []
        all_edges = []
        all_tracks = []

        for cid in all_case_ids:
            events = supabase.table("case_timeline_events").select("*").eq("case_id", cid).order("created_at").execute().data or []
            for ev in events:
                all_nodes.append({
                    "id": ev["id"],
                    "type": "eventNode",
                    "position": {"x": ev.get("position_x", 0), "y": ev.get("position_y", 0)},
                    "data": {
                        "title": ev["title"],
                        "event_date": ev.get("event_date"),
                        "description": ev.get("description", ""),
                        "category": ev.get("category", "general"),
                        "source_case_id": cid,
                        "source_case_title": case_titles.get(cid, ""),
                        "track_ids": [],
                        "sources": ev.get("sources"),
                    },
                })

            edges = supabase.table("case_timeline_edges").select("*").eq("case_id", cid).execute().data or []
            for ed in edges:
                all_edges.append({
                    "id": ed["id"],
                    "source": ed["source_event_id"],
                    "target": ed["target_event_id"],
                    "type": "draggable",
                    "data": {"label": ed.get("label", ""), "isCaseLocal": True},
                })

            tracks = supabase.table("case_timeline_tracks").select("*").eq("case_id", cid).execute().data or []
            for t in tracks:
                all_tracks.append({**t, "source_case_id": cid, "source_case_title": case_titles.get(cid, "")})

        return {"nodes": all_nodes, "edges": all_edges, "tracks": all_tracks, "child_cases": children}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─── Social Features ─────────────────────────────────────────────────────────

@app.post("/api/cases/like")
async def like_case(request: LikeCaseRequest, user = Depends(require_user)):
    """Like a public case."""
    try:
        res = supabase.table("case_likes").insert({
            "user_id": user.id,
            "case_id": request.case_id
        }).execute()
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/like/{case_id}")
async def unlike_case(case_id: str, user = Depends(require_user)):
    """Remove a like from a case."""
    try:
        supabase.table("case_likes").delete().eq("user_id", user.id).eq("case_id", case_id).execute()
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/users/follow")
async def follow_user(request: FollowUserRequest, user = Depends(require_user)):
    """Follow another user."""
    try:
        supabase.table("user_follows").insert({
            "follower_id": user.id,
            "target_user_id": request.target_user_id
        }).execute()
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/users/follow/{target_user_id}")
async def unfollow_user(target_user_id: str, user = Depends(require_user)):
    """Unfollow a user."""
    try:
        supabase.table("user_follows").delete().eq("follower_id", user.id).eq("target_user_id", target_user_id).execute()
        return {"ok": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─── Case Graph (Subgraph Builder) ───────────────────────────────────────────

@app.get("/api/nodes/search")
async def search_nodes(q: str = Query("", min_length=1), user = Depends(require_user)):
    """Search nodes by label for the case graph entity picker."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        term = q.strip().lower()
        res = supabase.table("nodes").select("id, label, type, metadata").ilike("label", f"%{term}%").limit(20).execute()
        results = []
        for n in res.data or []:
            meta = n.get("metadata") or {}
            results.append({
                "id": n["id"],
                "label": n.get("label", n["id"]),
                "type": n.get("type", "UNKNOWN"),
                "degree": meta.get("degree", 0),
            })
        results.sort(key=lambda x: x["degree"], reverse=True)
        return {"results": results}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/cases/{case_id}/graph")
async def get_case_graph(case_id: str, user = Depends(optional_user)):
    """Fetch subgraph: pinned nodes + all edges between them."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify permissions
        await verify_case_ownership(case_id, user, write=False)

        # Get pinned entities for this case
        pinned = supabase.table("case_graph_entities").select("*").eq("case_id", case_id).execute()
        pinned_rows = pinned.data or []

        # Also fetch custom case-local nodes
        custom_res = supabase.table("case_graph_custom_nodes").select("*").eq("case_id", case_id).execute()
        custom_rows = custom_res.data or []

        # Also fetch sticky notes (graceful if table doesn't exist yet)
        sticky_rows = []
        try:
            sticky_res = supabase.table("case_graph_sticky_notes").select("*").eq("case_id", case_id).execute()
            sticky_rows = sticky_res.data or []
        except Exception:
            pass

        if not pinned_rows and not custom_rows and not sticky_rows:
            return {"nodes": [], "edges": []}

        node_ids = [r["node_id"] for r in pinned_rows]
        position_map = {r["node_id"]: {"x": r.get("position_x"), "y": r.get("position_y")} for r in pinned_rows}

        # Fetch case-level description overrides
        desc_res = supabase.table("case_entity_descriptions").select("node_id, description").eq("case_id", case_id).execute()
        case_descriptions = {r["node_id"]: r["description"] for r in (desc_res.data or [])}

        # Fetch document counts per entity (graceful if table doesn't exist yet)
        doc_counts: dict = {}
        try:
            doc_res = supabase.table("case_entity_documents").select("node_id").eq("case_id", case_id).execute()
            for r in (doc_res.data or []):
                doc_counts[r["node_id"]] = doc_counts.get(r["node_id"], 0) + 1
        except Exception:
            pass

        # Fetch global node data
        nodes = []
        if node_ids:
            nodes_res = supabase.table("nodes").select("*").in_("id", node_ids).execute()
            for n in nodes_res.data or []:
                meta = n.get("metadata") or {}
                pos = position_map.get(n["id"], {})
                nodes.append({
                    "id": n["id"],
                    "type": "entityNode",
                    "data": {
                        "label": n.get("label", n["id"]),
                        "entityType": n.get("type", "UNKNOWN"),
                        "description": n.get("description", ""),
                        "caseDescription": case_descriptions.get(n["id"], ""),
                        "aliases": n.get("aliases", []),
                        "degree": meta.get("degree", 0),
                        "communityId": meta.get("communityId"),
                        "communityColor": meta.get("communityColor"),
                        "documentCount": doc_counts.get(n["id"], 0),
                    },
                    "position": {"x": pos.get("x") or 0, "y": pos.get("y") or 0},
                })

        # Append custom case-local nodes
        for cn in custom_rows:
            nodes.append({
                "id": cn["id"],
                "type": "entityNode",
                "data": {
                    "label": cn.get("label", "Untitled"),
                    "entityType": cn.get("type", "PERSON"),
                    "description": "",
                    "caseDescription": case_descriptions.get(cn["id"], ""),
                    "aliases": [],
                    "degree": 0,
                    "isCustom": True,
                    "documentCount": doc_counts.get(cn["id"], 0),
                },
                "position": {"x": cn.get("position_x") or 0, "y": cn.get("position_y") or 0},
            })

        # Append sticky notes as stickyNote-type nodes
        sticky_media_by_note = defaultdict(list)
        sticky_ids = [s["id"] for s in sticky_rows]
        if sticky_ids:
            media_res = supabase.table("case_graph_sticky_media").select("*").in_("sticky_note_id", sticky_ids).execute()
            for m in (media_res.data or []):
                sticky_media_by_note[m["sticky_note_id"]].append({
                    "id": m["id"],
                    "filename": m["filename"],
                    "media_type": m["media_type"],
                    "mime_type": m["mime_type"],
                })

        for sn in sticky_rows:
            nodes.append({
                "id": sn["id"],
                "type": "stickyNote",
                "data": {
                    "content": sn.get("content", ""),
                    "color": sn.get("color", "#FBBF24"),
                    "noteWidth": sn.get("width", 280),
                    "noteHeight": sn.get("height", 200),
                    "media": sticky_media_by_note.get(sn["id"], []),
                    "isStickyNote": True,
                },
                "position": {"x": sn.get("position_x") or 0, "y": sn.get("position_y") or 0},
                "style": {"width": sn.get("width", 280), "height": sn.get("height", 200)},
            })

        edges = []

        # Fetch case-local edges
        case_edges_res = supabase.table("case_graph_edges").select("*").eq("case_id", case_id).execute()
        for ce in case_edges_res.data or []:
            is_hyp = ce.get("is_hypothesis", False)
            edges.append({
                "id": ce["id"],
                "source": ce["source_node_id"],
                "target": ce["target_node_id"],
                "label": ce.get("label", "") or "",
                "animated": False,
                "data": {
                    "isCaseLocal": True,
                    "isHypothesis": is_hyp,
                    "evidence_text": ce.get("evidence_text", ""),
                    "source_filename": ce.get("source_filename", ""),
                    "source_page": ce.get("source_page"),
                    "confidence": ce.get("confidence", ""),
                    "labelPosition": ce.get("label_position", 0.5),
                },
            })

        # Fetch global KG edges between pinned entities (+ custom node IDs + sticky note IDs)
        all_node_ids = node_ids + [cn["id"] for cn in custom_rows] + [sn["id"] for sn in sticky_rows]
        if len(all_node_ids) >= 2:
            global_edges_res = supabase.table("edges").select(
                "id, source, target, label, predicate, evidence_text, source_filename, source_page, confidence, date_mentioned"
            ).in_("source", all_node_ids).in_("target", all_node_ids).execute()

            case_edge_pairs = {(ce["source_node_id"], ce["target_node_id"]) for ce in (case_edges_res.data or [])}
            case_edge_pairs |= {(ce["target_node_id"], ce["source_node_id"]) for ce in (case_edges_res.data or [])}

            for ge in (global_edges_res.data or []):
                if (ge["source"], ge["target"]) in case_edge_pairs:
                    continue
                edges.append({
                    "id": ge["id"],
                    "source": ge["source"],
                    "target": ge["target"],
                    "label": ge.get("label", ge.get("predicate", "")),
                    "data": {
                        "isCaseLocal": False,
                        "isHypothesis": False,
                        "predicate": ge.get("predicate", ""),
                        "evidence_text": ge.get("evidence_text", ""),
                        "source_filename": ge.get("source_filename", ""),
                        "source_page": ge.get("source_page", 0),
                        "confidence": ge.get("confidence", "STATED"),
                        "date_mentioned": ge.get("date_mentioned"),
                    },
                })

        # Fetch groups
        groups_res = supabase.table("case_graph_groups").select("*").eq("case_id", case_id).execute()
        groups = []
        for g in groups_res.data or []:
            groups.append({
                "id": g["id"],
                "label": g.get("label", ""),
                "color": g.get("color", "#007AFF"),
                "node_ids": g.get("node_ids", []),
            })

        return {"nodes": nodes, "edges": edges, "groups": groups}
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/entities")
async def add_case_graph_entities(case_id: str, request: AddGraphEntitiesRequest, user = Depends(require_user)):
    """Add entities to a case graph."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        pos_map = request.positions or {}
        records = []
        for nid in request.node_ids:
            rec = {"case_id": case_id, "node_id": nid}
            if nid in pos_map:
                rec["position_x"] = pos_map[nid]["x"]
                rec["position_y"] = pos_map[nid]["y"]
            records.append(rec)
        supabase.table("case_graph_entities").upsert(records, on_conflict="case_id,node_id").execute()
        return {"added": len(request.node_ids)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}/graph/entities/{node_id}")
async def remove_case_graph_entity(case_id: str, node_id: str, user = Depends(require_user)):
    """Remove an entity from a case graph."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        supabase.table("case_graph_entities").delete().eq("case_id", case_id).eq("node_id", node_id).execute()
        # Clean up any case-local edges referencing this node
        supabase.table("case_graph_edges").delete().eq("case_id", case_id).eq("source_node_id", node_id).execute()
        supabase.table("case_graph_edges").delete().eq("case_id", case_id).eq("target_node_id", node_id).execute()
        return {"removed": node_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/positions")
async def save_case_graph_positions(case_id: str, request: SavePositionsRequest, user = Depends(require_user)):
    """Save dragged node positions for a case graph."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        for pos in request.positions:
            # Try regular pinned node first
            result = supabase.table("case_graph_entities").update({
                "position_x": pos["x"],
                "position_y": pos["y"],
            }).eq("case_id", case_id).eq("node_id", pos["node_id"]).execute()
            # If no row updated, try custom nodes table
            if not result.data:
                result2 = supabase.table("case_graph_custom_nodes").update({
                    "position_x": pos["x"],
                    "position_y": pos["y"],
                }).eq("id", pos["node_id"]).eq("case_id", case_id).execute()
                # If still no row, try sticky notes table
                if not result2.data:
                    supabase.table("case_graph_sticky_notes").update({
                        "position_x": pos["x"],
                        "position_y": pos["y"],
                    }).eq("id", pos["node_id"]).eq("case_id", case_id).execute()
        return {"saved": len(request.positions)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/cases/{case_id}/graph/expand/{node_id}")
async def expand_case_graph_node(case_id: str, node_id: str):
    """Get neighbors of a node that are NOT already in the case graph."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Get already-pinned node IDs
        pinned = supabase.table("case_graph_entities").select("node_id").eq("case_id", case_id).execute()
        pinned_ids = set(r["node_id"] for r in (pinned.data or []))

        # Get edges involving this node
        out_edges = supabase.table("edges").select("target, label").eq("source", node_id).execute()
        in_edges = supabase.table("edges").select("source, label").eq("target", node_id).execute()

        neighbor_ids = set()
        edge_labels = {}
        for e in (out_edges.data or []):
            nid = e["target"]
            if nid not in pinned_ids:
                neighbor_ids.add(nid)
                edge_labels.setdefault(nid, []).append(e.get("label", ""))
        for e in (in_edges.data or []):
            nid = e["source"]
            if nid not in pinned_ids:
                neighbor_ids.add(nid)
                edge_labels.setdefault(nid, []).append(e.get("label", ""))

        if not neighbor_ids:
            return {"neighbors": []}

        # Fetch node details for neighbors
        nodes_res = supabase.table("nodes").select("id, label, type, metadata").in_("id", list(neighbor_ids)).execute()
        neighbors = []
        for n in (nodes_res.data or []):
            meta = n.get("metadata") or {}
            neighbors.append({
                "id": n["id"],
                "label": n.get("label", n["id"]),
                "type": n.get("type", "UNKNOWN"),
                "degree": meta.get("degree", 0),
                "relationships": edge_labels.get(n["id"], []),
            })
        neighbors.sort(key=lambda x: x["degree"], reverse=True)
        return {"neighbors": neighbors}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/edges")
async def create_case_graph_edge(case_id: str, request: CreateCaseEdgeRequest, user = Depends(require_user)):
    """Create a case-local edge between two entities."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        record = {
            "case_id": case_id,
            "source_node_id": request.source_node_id,
            "target_node_id": request.target_node_id,
            "label": request.label,
            "is_hypothesis": request.is_hypothesis,
        }
        result = supabase.table("case_graph_edges").upsert(
            record, on_conflict="case_id,source_node_id,target_node_id"
        ).execute()
        return {"id": result.data[0]["id"] if result.data else None}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}/graph/edges/{edge_id}")
async def delete_case_graph_edge(case_id: str, edge_id: str, user = Depends(require_user)):
    """Delete a case-local edge."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        supabase.table("case_graph_edges").delete().eq("id", edge_id).eq("case_id", case_id).execute()
        return {"deleted": edge_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}/graph/edges/{edge_id}")
async def update_case_graph_edge(case_id: str, edge_id: str, request: UpdateCaseEdgeRequest, user = Depends(require_user)):
    """Update a case-local edge's label and/or label position."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        updates = {}
        if request.label is not None:
            updates["label"] = request.label
        if request.label_position is not None:
            updates["label_position"] = request.label_position
        if not updates:
            return {"id": edge_id}
        result = supabase.table("case_graph_edges").update(
            updates
        ).eq("id", edge_id).eq("case_id", case_id).execute()
        if not result.data:
            return JSONResponse(status_code=404, content={"error": "Edge not found."})
        return {"id": edge_id, **updates}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


class FindEvidenceRequest(BaseModel):
    source_label: str
    target_label: str

class SemanticLayoutRequest(BaseModel):
    node_ids: List[str]
    node_labels: List[str]

class CreateTimelineEventRequest(BaseModel):
    title: str
    event_date: Optional[str] = None
    description: str = ""
    category: str = "general"
    position_x: float = 0
    position_y: float = 0
    track_ids: List[str] = []
    sources: Optional[List[dict]] = None

class UpdateTimelineEventRequest(BaseModel):
    title: Optional[str] = None
    event_date: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    track_ids: Optional[List[str]] = None

class CreateTimelineTrackRequest(BaseModel):
    entity_node_id: Optional[str] = None
    label: str
    color: str = "#5AC8FA"

class UpdateTimelineTrackRequest(BaseModel):
    label: Optional[str] = None
    color: Optional[str] = None
    enabled: Optional[bool] = None

class GenerateTrackRequest(BaseModel):
    entity_node_id: str
    entity_label: str
    messages: List[Dict[str, str]] = []
    query: Optional[str] = None

class TimelineChatRequest(BaseModel):
    messages: List[Dict[str, str]]

class SaveTimelinePositionsRequest(BaseModel):
    positions: List[Dict[str, Any]]

class CreateTimelineEdgeRequest(BaseModel):
    source_event_id: str
    target_event_id: str
    label: str = ""

class ImportGraphEventsRequest(BaseModel):
    node_ids: List[str]

class TimelineResearchRequest(BaseModel):
    query: str
    messages: List[Dict[str, str]] = []
    focused_events: List[Dict[str, str]] = []

class AuditRunRequest(BaseModel):
    checks: List[str] = ["categorize", "dates", "duplicates", "sources"]  # which steps to run

class AuditApplyRequest(BaseModel):
    suggestion_ids: List[str]
    exclusions: Optional[Dict[str, List[str]]] = None  # suggestion_id -> list of event IDs to exclude from merge

class AuditDismissRequest(BaseModel):
    suggestion_ids: List[str]

class GraphResearchRequest(BaseModel):
    query: str
    messages: List[Dict[str, str]] = []


@app.post("/api/cases/{case_id}/graph/edges/{edge_id}/find-evidence")
async def find_edge_evidence(case_id: str, edge_id: str, request: FindEvidenceRequest, user = Depends(require_paid)):
    """Search for evidence supporting a hypothesis edge."""
    if not supabase or not client or not index:
        return JSONResponse(status_code=503, content={"error": "Services not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        query = f"connection between {request.source_label} and {request.target_label}"
        rerank_fn = _get_rerank_fn()
        results = _semantic_search_pass(
            query_text=query,
            genai_client=client,
            pinecone_index=index,
            rerank_fn=rerank_fn,
            fetch_k=100,
            rerank_top_n=5,
        )
        if not results:
            return {"found": False, "evidence_text": "", "source_filename": "", "source_page": 0, "ai_assessment": "No relevant evidence found in the document corpus."}

        context = "\n\n".join([f"[{r['filename']} p.{r['page']}]: {r['text'][:500]}" for r in results[:3]])
        prompt = f"""Based on the following document excerpts, assess whether there is evidence of a connection between "{request.source_label}" and "{request.target_label}".

{context}

Respond with a brief assessment (2-3 sentences). If evidence supports a connection, describe it. If not, say so clearly."""

        assessment_res = generate(prompt)
        assessment = assessment_res.text
        log_usage(user, "/api/cases/graph/find-evidence", "gemini-2.0-flash", assessment_res.usage_metadata)
        
        best = results[0]
        return {
            "found": True,
            "evidence_text": best["text"][:500],
            "source_filename": best["filename"],
            "source_page": best.get("page", 0),
            "ai_assessment": assessment,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}/graph/edges/{edge_id}/solidify")
async def solidify_hypothesis_edge(case_id: str, edge_id: str, user = Depends(require_user)):
    """Convert a hypothesis edge to a confirmed edge with evidence."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        result = supabase.table("case_graph_edges").update({
            "is_hypothesis": False,
        }).eq("id", edge_id).eq("case_id", case_id).execute()
        if not result.data:
            return JSONResponse(status_code=404, content={"error": "Edge not found."})
        return {"id": edge_id, "solidified": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/semantic-layout")
async def compute_semantic_layout(case_id: str, request: SemanticLayoutRequest, user = Depends(require_paid)):
    """Compute semantic similarity matrix for layout clustering."""
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    try:
        # Verify permissions
        await verify_case_ownership(case_id, user, write=False)

        if len(request.node_labels) < 2:
            return {"node_ids": request.node_ids, "similarities": []}

        res = client.models.embed_content(
            model="gemini-embedding-001",
            contents=request.node_labels,
        )
        embeddings = [e.values for e in res.embeddings]

        # Compute pairwise cosine similarity (pure Python)
        def cosine_sim(a, b):
            dot = sum(x * y for x, y in zip(a, b))
            norm_a = sum(x * x for x in a) ** 0.5
            norm_b = sum(x * x for x in b) ** 0.5
            if norm_a == 0 or norm_b == 0:
                return 0.0
            return dot / (norm_a * norm_b)

        n = len(embeddings)
        similarities = [[0.0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j:
                    similarities[i][j] = 1.0
                elif j > i:
                    sim = cosine_sim(embeddings[i], embeddings[j])
                    similarities[i][j] = sim
                    similarities[j][i] = sim

        return {"node_ids": request.node_ids, "similarities": similarities}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/custom-nodes")
async def create_case_custom_node(case_id: str, request: CreateCustomNodeRequest, user = Depends(require_user)):
    """Create a custom case-local entity node."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        record = {
            "case_id": case_id,
            "label": request.label,
            "type": request.type,
            "position_x": 0,
            "position_y": 0,
        }
        result = supabase.table("case_graph_custom_nodes").insert(record).execute()
        return {"id": result.data[0]["id"] if result.data else None}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}/graph/custom-nodes/{node_id}")
async def delete_case_custom_node(case_id: str, node_id: str, user = Depends(require_user)):
    """Delete a custom case-local entity node and its edges."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        # Delete any case edges involving this custom node
        supabase.table("case_graph_edges").delete().eq("case_id", case_id).eq("source_node_id", node_id).execute()
        supabase.table("case_graph_edges").delete().eq("case_id", case_id).eq("target_node_id", node_id).execute()
        # Delete the custom node itself
        supabase.table("case_graph_custom_nodes").delete().eq("id", node_id).eq("case_id", case_id).execute()
        return {"deleted": node_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}/graph/entities/{node_id}/description")
async def update_entity_description(case_id: str, node_id: str, request: UpdateEntityDescriptionRequest, user = Depends(require_user)):
    """Upsert a case-level description for any entity (global or custom)."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        supabase.table("case_entity_descriptions").upsert({
            "case_id": case_id,
            "node_id": node_id,
            "description": request.description,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }, on_conflict="case_id,node_id").execute()
        return {"saved": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/groups")
async def create_case_graph_group(case_id: str, request: CreateGroupRequest, user = Depends(require_user)):
    """Create a visual group circle around entities."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        result = supabase.table("case_graph_groups").insert({
            "case_id": case_id,
            "label": request.label,
            "color": request.color,
            "node_ids": request.node_ids,
        }).execute()
        return {"id": result.data[0]["id"] if result.data else None}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}/graph/groups/{group_id}")
async def update_case_graph_group(case_id: str, group_id: str, request: UpdateGroupRequest, user = Depends(require_user)):
    """Update a group's label, color, or member nodes."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        updates = {}
        if request.label is not None:
            updates["label"] = request.label
        if request.color is not None:
            updates["color"] = request.color
        if request.node_ids is not None:
            updates["node_ids"] = request.node_ids
        if updates:
            supabase.table("case_graph_groups").update(updates).eq("id", group_id).eq("case_id", case_id).execute()
        return {"updated": True}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}/graph/groups/{group_id}")
async def delete_case_graph_group(case_id: str, group_id: str, user = Depends(require_user)):
    """Delete a group (does not remove the entities themselves)."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        # Verify ownership
        await verify_case_ownership(case_id, user, write=True)

        supabase.table("case_graph_groups").delete().eq("id", group_id).eq("case_id", case_id).execute()
        return {"deleted": group_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


## --- Entity Documents ---

@app.get("/api/cases/{case_id}/graph/entities/{node_id}/documents")
async def list_entity_documents(case_id: str, node_id: str, user = Depends(require_user)):
    """List documents attached to an entity in a case."""
    try:
        await verify_case_ownership(case_id, user, write=False)
        result = supabase.table("case_entity_documents").select("*").eq("case_id", case_id).eq("node_id", node_id).order("created_at", desc=False).execute()
        return {"documents": result.data or []}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/cases/{case_id}/graph/entities/{node_id}/documents")
async def attach_entity_document(case_id: str, node_id: str, request: AttachDocumentRequest, user = Depends(require_user)):
    """Attach a source document to an entity."""
    try:
        await verify_case_ownership(case_id, user, write=True)
        record = {
            "case_id": case_id,
            "node_id": node_id,
            "url": request.url,
            "note": request.note,
        }
        result = supabase.table("case_entity_documents").insert(record).execute()
        return {"id": result.data[0]["id"]}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.delete("/api/cases/{case_id}/graph/entities/{node_id}/documents/{doc_id}")
async def detach_entity_document(case_id: str, node_id: str, doc_id: str, user = Depends(require_user)):
    """Remove a document attachment from an entity."""
    try:
        await verify_case_ownership(case_id, user, write=True)
        supabase.table("case_entity_documents").delete().eq("id", doc_id).eq("case_id", case_id).execute()
        return {"deleted": doc_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


## --- Sticky Notes ---

@app.post("/api/cases/{case_id}/graph/sticky-notes")
async def create_sticky_note(case_id: str, request: CreateStickyNoteRequest, user = Depends(require_user)):
    """Create a sticky note on the case graph."""
    try:
        await verify_case_ownership(case_id, user, write=True)
        record = {
            "case_id": case_id,
            "content": request.content,
            "color": request.color,
            "position_x": request.position_x,
            "position_y": request.position_y,
            "width": request.width,
            "height": request.height,
        }
        result = supabase.table("case_graph_sticky_notes").insert(record).execute()
        return {"id": result.data[0]["id"]}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.patch("/api/cases/{case_id}/graph/sticky-notes/{note_id}")
async def update_sticky_note(case_id: str, note_id: str, request: UpdateStickyNoteRequest, user = Depends(require_user)):
    """Update a sticky note's content, color, or dimensions."""
    try:
        await verify_case_ownership(case_id, user, write=True)
        updates = {k: v for k, v in request.dict().items() if v is not None}
        if not updates:
            return {"updated": note_id}
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        supabase.table("case_graph_sticky_notes").update(updates).eq("id", note_id).eq("case_id", case_id).execute()
        return {"updated": note_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.delete("/api/cases/{case_id}/graph/sticky-notes/{note_id}")
async def delete_sticky_note(case_id: str, note_id: str, user = Depends(require_user)):
    """Delete a sticky note and its media."""
    try:
        await verify_case_ownership(case_id, user, write=True)
        # Delete media files from GCS
        media_res = supabase.table("case_graph_sticky_media").select("gcs_path").eq("sticky_note_id", note_id).execute()
        for m in (media_res.data or []):
            try:
                blob = bucket.blob(m["gcs_path"])
                blob.delete()
            except Exception:
                pass
        # Delete any case edges referencing this note
        supabase.table("case_graph_edges").delete().eq("case_id", case_id).eq("source_node_id", note_id).execute()
        supabase.table("case_graph_edges").delete().eq("case_id", case_id).eq("target_node_id", note_id).execute()
        # Cascade handles sticky_media rows
        supabase.table("case_graph_sticky_notes").delete().eq("id", note_id).eq("case_id", case_id).execute()
        return {"deleted": note_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/api/cases/{case_id}/graph/sticky-notes/{note_id}/media")
async def upload_sticky_media(case_id: str, note_id: str, file: UploadFile = File(...), user = Depends(require_user)):
    """Upload a photo or video to a sticky note."""
    try:
        await verify_case_ownership(case_id, user, write=True)
        safe_filename = os.path.basename(file.filename or "upload")
        ext = os.path.splitext(safe_filename)[1].lower()

        image_exts = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}
        video_exts = {'.mp4', '.webm', '.mov'}
        if ext in image_exts:
            media_type = 'image'
        elif ext in video_exts:
            media_type = 'video'
        else:
            return JSONResponse(status_code=400, content={"error": f"Unsupported file type: {ext}"})

        content = await file.read()
        if len(content) > 50 * 1024 * 1024:  # 50MB limit
            return JSONResponse(status_code=400, content={"error": "File too large (50MB max)"})

        unique_name = f"{uuid.uuid4().hex}_{safe_filename}"
        gcs_path = f"sticky-media/{case_id}/{note_id}/{unique_name}"
        blob = bucket.blob(gcs_path)
        blob.upload_from_string(content, content_type=file.content_type)

        record = {
            "sticky_note_id": note_id,
            "case_id": case_id,
            "filename": safe_filename,
            "gcs_path": gcs_path,
            "media_type": media_type,
            "mime_type": file.content_type or "application/octet-stream",
            "size_bytes": len(content),
        }
        result = supabase.table("case_graph_sticky_media").insert(record).execute()

        signed_url = blob.generate_signed_url(version="v4", expiration=timedelta(hours=1), method="GET")
        return {"id": result.data[0]["id"], "url": signed_url, "media_type": media_type, "filename": safe_filename}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.delete("/api/cases/{case_id}/graph/sticky-notes/{note_id}/media/{media_id}")
async def delete_sticky_media(case_id: str, note_id: str, media_id: str, user = Depends(require_user)):
    """Delete a media attachment from a sticky note."""
    try:
        await verify_case_ownership(case_id, user, write=True)
        media_res = supabase.table("case_graph_sticky_media").select("gcs_path").eq("id", media_id).execute()
        if media_res.data:
            try:
                blob = bucket.blob(media_res.data[0]["gcs_path"])
                blob.delete()
            except Exception:
                pass
        supabase.table("case_graph_sticky_media").delete().eq("id", media_id).execute()
        return {"deleted": media_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/api/cases/{case_id}/graph/sticky-notes/{note_id}/media/{media_id}/url")
async def get_sticky_media_url(case_id: str, note_id: str, media_id: str, user = Depends(optional_user)):
    """Get a signed URL for a sticky note media file."""
    try:
        await verify_case_ownership(case_id, user, write=False)
        media_res = supabase.table("case_graph_sticky_media").select("gcs_path").eq("id", media_id).execute()
        if not media_res.data:
            return JSONResponse(status_code=404, content={"error": "Media not found"})
        blob = bucket.blob(media_res.data[0]["gcs_path"])
        signed_url = blob.generate_signed_url(version="v4", expiration=timedelta(hours=1), method="GET")
        return {"url": signed_url}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/analyze")
async def analyze_case_graph_entities(case_id: str, request: AnalyzeEntitiesRequest, user = Depends(require_paid)):
    """Analyze a group of selected entities for similarities and patterns."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    if len(request.node_ids) < 2:
        return JSONResponse(status_code=400, content={"error": "Need at least 2 entities to analyze."})
    try:
        # Verify permissions
        await verify_case_ownership(case_id, user, write=False)

        node_ids = request.node_ids

        # Fetch node details
        nodes_res = supabase.table("nodes").select("id, label, type, description, aliases").in_("id", node_ids).execute()
        nodes_by_id = {n["id"]: n for n in (nodes_res.data or [])}

        # Fetch all edges between the selected nodes
        direct_edges = supabase.table("edges").select("source, target, label, predicate, evidence_text, confidence").in_("source", node_ids).in_("target", node_ids).execute()

        # Fetch shared neighbors: entities connected to 2+ of the selected nodes
        all_neighbor_edges = []
        for nid in node_ids:
            out = supabase.table("edges").select("source, target, label").eq("source", nid).execute()
            inc = supabase.table("edges").select("source, target, label").eq("target", nid).execute()
            all_neighbor_edges.extend(out.data or [])
            all_neighbor_edges.extend(inc.data or [])

        # Count how many selected nodes each neighbor connects to
        neighbor_connections = defaultdict(lambda: {"count": 0, "connected_to": set(), "labels": []})
        for e in all_neighbor_edges:
            other = e["target"] if e["source"] in node_ids else e["source"]
            if other in node_ids:
                continue  # skip direct edges between selected nodes
            selected_end = e["source"] if e["source"] in node_ids else e["target"]
            neighbor_connections[other]["count"] += 1
            neighbor_connections[other]["connected_to"].add(selected_end)
            neighbor_connections[other]["labels"].append(e.get("label", ""))

        # Keep neighbors connected to 2+ selected nodes
        shared_neighbor_ids = [nid for nid, info in neighbor_connections.items() if len(info["connected_to"]) >= 2]

        shared_neighbors_detail = []
        if shared_neighbor_ids:
            sn_res = supabase.table("nodes").select("id, label, type").in_("id", shared_neighbor_ids[:30]).execute()
            for sn in (sn_res.data or []):
                info = neighbor_connections[sn["id"]]
                connected_labels = [nodes_by_id[c]["label"] for c in info["connected_to"] if c in nodes_by_id]
                shared_neighbors_detail.append({
                    "label": sn.get("label", sn["id"]),
                    "type": sn.get("type", "UNKNOWN"),
                    "connected_to": connected_labels,
                    "relationships": list(set(info["labels"]))[:5],
                })

        # Build context for Gemini
        entity_descriptions = []
        for nid in node_ids:
            n = nodes_by_id.get(nid, {})
            desc = n.get("description", "") or ""
            entity_descriptions.append(f"- {n.get('label', nid)} ({n.get('type', 'UNKNOWN')}): {desc[:200]}")

        direct_edge_descriptions = []
        for e in (direct_edges.data or []):
            src = nodes_by_id.get(e["source"], {}).get("label", e["source"])
            tgt = nodes_by_id.get(e["target"], {}).get("label", e["target"])
            direct_edge_descriptions.append(f"- {src} → {e.get('label', e.get('predicate', '?'))} → {tgt}")

        shared_descriptions = []
        for sn in shared_neighbors_detail[:15]:
            shared_descriptions.append(f"- {sn['label']} ({sn['type']}) — connected to: {', '.join(sn['connected_to'])} via: {', '.join(sn['relationships'][:3])}")

        prompt = f"""You are a seasoned investigative journalist with decades of experience uncovering financial crimes, corruption, and hidden networks of power. You have a sharp eye for patterns that others miss — shell companies, intermediaries, recurring associates, and suspicious timing.

A researcher has selected the following entities from a knowledge graph built from court documents, financial records, flight logs, and depositions. Analyze them for patterns, similarities, and connections that would be relevant to an investigation.

SELECTED ENTITIES:
{chr(10).join(entity_descriptions)}

DIRECT CONNECTIONS BETWEEN THEM:
{chr(10).join(direct_edge_descriptions) if direct_edge_descriptions else "None found."}

SHARED CONNECTIONS (entities linked to 2+ of the selected):
{chr(10).join(shared_descriptions) if shared_descriptions else "None found."}

Provide a concise analysis (3-5 bullet points) covering:
1. What these entities have in common — shared roles, affiliations, locations, or time periods
2. Key relationships or patterns between them — financial flows, organizational ties, recurring co-appearances
3. Notable shared connections or intermediaries who bridge them
4. Investigative leads — what a journalist should dig into next based on these connections

Be specific, reference actual entity names, and flag anything that looks unusual or warrants further scrutiny. Keep each bullet to 1-2 sentences."""

        res = generate(
            client,
            model="gemini-2.0-flash",
            contents=prompt,
        )
        initial_analysis = res.text
        log_usage(user, "/api/cases/analyze", "gemini-2.0-flash", res.usage_metadata)

        # --- Pass 2: Auto-follow-up on investigative leads ---
        # Ask Gemini to extract search terms from its own leads
        extract_prompt = f"""From the following investigative analysis, extract 3-6 specific entity names, organization names, or person names that should be searched in the knowledge graph to follow up on the leads. Return ONLY a JSON array of search terms, nothing else.

Analysis:
{initial_analysis}

Example output: ["Knight Capital", "Cereplast management", "John Doe"]"""

        try:
            extract_res = generate(
                client,
                model="gemini-2.0-flash",
                contents=extract_prompt,
            )
            import re as _re
            # Parse the JSON array from the response
            match = _re.search(r'\[.*\]', extract_res.text, _re.DOTALL)
            search_terms = json.loads(match.group()) if match else []
        except Exception:
            search_terms = []

        # Search the graph for each term
        follow_up_findings = []
        found_entities = {}
        if search_terms and supabase:
            for term in search_terms[:6]:
                term_clean = term.strip()
                if not term_clean or len(term_clean) < 2:
                    continue
                try:
                    search_res = supabase.table("nodes").select("id, label, type, description").ilike("label", f"%{term_clean}%").limit(5).execute()
                    for n in (search_res.data or []):
                        if n["id"] not in node_ids and n["id"] not in found_entities:
                            found_entities[n["id"]] = n
                except Exception:
                    continue

            # For discovered entities, find how they connect to the original selection
            if found_entities:
                for eid, entity in list(found_entities.items())[:10]:
                    connections_to_selected = []
                    try:
                        out = supabase.table("edges").select("target, label").eq("source", eid).in_("target", node_ids).execute()
                        inc = supabase.table("edges").select("source, label").eq("target", eid).in_("source", node_ids).execute()
                        for e in (out.data or []):
                            tgt_label = nodes_by_id.get(e["target"], {}).get("label", e["target"])
                            connections_to_selected.append(f"{e.get('label', '?')} → {tgt_label}")
                        for e in (inc.data or []):
                            src_label = nodes_by_id.get(e["source"], {}).get("label", e["source"])
                            connections_to_selected.append(f"{src_label} → {e.get('label', '?')}")
                    except Exception:
                        pass

                    desc = (entity.get("description") or "")[:200]
                    finding = f"**{entity.get('label', eid)}** ({entity.get('type', 'UNKNOWN')})"
                    if desc:
                        finding += f": {desc}"
                    if connections_to_selected:
                        finding += f"\n  Connections to selected entities: {'; '.join(connections_to_selected[:5])}"
                    else:
                        finding += "\n  No direct connections to selected entities found in graph."
                    follow_up_findings.append(finding)

        # Generate follow-up analysis if we found anything
        follow_up = None
        if follow_up_findings:
            follow_up_prompt = f"""You are an investigative journalist following up on leads. You previously analyzed a group of entities and suggested investigative leads. Your research team searched the knowledge graph and found the following additional entities and connections.

YOUR ORIGINAL ANALYSIS:
{initial_analysis}

NEW FINDINGS FROM THE GRAPH:
{chr(10).join(follow_up_findings)}

Based on these new findings, provide a follow-up report:
1. Which of your leads panned out — what did the graph reveal?
2. New connections or patterns discovered
3. Any red flags or suspicious patterns in the newly found entities
4. Updated investigative priorities based on what you now know

Be specific, name names, and think like a journalist building a story. Keep it concise — 3-5 bullet points."""

            try:
                follow_up_res = generate(
                    client,
                    model="gemini-2.0-flash",
                    contents=follow_up_prompt,
                )
                follow_up = follow_up_res.text
                log_usage(user, "/api/cases/analyze-followup", "gemini-2.0-flash", follow_up_res.usage_metadata)
            except Exception as follow_err:
                print(f"Follow-up analysis failed: {follow_err}")

        return {
            "analysis": initial_analysis,
            "follow_up": follow_up,
            "search_terms": search_terms,
            "new_entities_found": len(found_entities),
            "direct_connections": len(direct_edges.data or []),
            "shared_connections": len(shared_neighbors_detail),
            "shared_neighbors": shared_neighbors_detail[:10],
        }
    except Exception as e:
        print(f"Analysis failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/chat")
async def chat_case_graph(case_id: str, request: GraphChatRequest, user = Depends(require_paid)):
    """Chat about a group of selected entities with full graph context."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    try:
        # Verify permissions
        await verify_case_ownership(case_id, user, write=False)

        node_ids = request.node_ids

        # Fetch node details (global nodes)
        nodes_res = supabase.table("nodes").select("id, label, type, description, aliases").in_("id", node_ids).execute()
        nodes_by_id = {n["id"]: n for n in (nodes_res.data or [])}

        # Also fetch custom case-local nodes that may not be in the global table
        missing_ids = [nid for nid in node_ids if nid not in nodes_by_id]
        if missing_ids:
            custom_res = supabase.table("case_graph_custom_nodes").select("id, label, type").in_("id", missing_ids).execute()
            for cn in (custom_res.data or []):
                nodes_by_id[cn["id"]] = {
                    "id": cn["id"],
                    "label": cn.get("label", "Untitled"),
                    "type": cn.get("type", "PERSON"),
                    "description": "",
                    "aliases": [],
                }

        # Fetch case-level description overrides
        case_desc_res = supabase.table("case_entity_descriptions").select("node_id, description").eq("case_id", case_id).in_("node_id", node_ids).execute()
        case_descriptions = {r["node_id"]: r["description"] for r in (case_desc_res.data or [])}

        # Fetch direct edges between selected nodes
        direct_edges = supabase.table("edges").select("source, target, label, predicate, evidence_text, confidence").in_("source", node_ids).in_("target", node_ids).execute()

        # Also include case-local edges
        case_edges = supabase.table("case_graph_edges").select("source_node_id, target_node_id, label").eq("case_id", case_id).execute()
        case_edge_lines = []
        for ce in (case_edges.data or []):
            src_id, tgt_id = ce["source_node_id"], ce["target_node_id"]
            if src_id in set(node_ids) and tgt_id in set(node_ids):
                src = nodes_by_id.get(src_id, {}).get("label", src_id)
                tgt = nodes_by_id.get(tgt_id, {}).get("label", tgt_id)
                case_edge_lines.append(f"- {src} → {ce.get('label', '?')} → {tgt} [case note]")

        # Fetch shared neighbors (for multi-entity chats)
        all_neighbor_edges = []
        for nid in node_ids:
            out = supabase.table("edges").select("source, target, label").eq("source", nid).execute()
            inc = supabase.table("edges").select("source, target, label").eq("target", nid).execute()
            all_neighbor_edges.extend(out.data or [])
            all_neighbor_edges.extend(inc.data or [])

        neighbor_connections = defaultdict(lambda: {"connected_to": set(), "labels": []})
        for e in all_neighbor_edges:
            other = e["target"] if e["source"] in node_ids else e["source"]
            if other in node_ids:
                continue
            selected_end = e["source"] if e["source"] in node_ids else e["target"]
            neighbor_connections[other]["connected_to"].add(selected_end)
            neighbor_connections[other]["labels"].append(e.get("label", ""))

        # For single-entity chat, show all direct connections (not just shared)
        single_entity = len(node_ids) == 1
        if single_entity:
            neighbor_threshold = 1
        else:
            neighbor_threshold = 2
        shared_neighbor_ids = [nid for nid, info in neighbor_connections.items() if len(info["connected_to"]) >= neighbor_threshold]
        shared_detail = []
        if shared_neighbor_ids:
            sn_res = supabase.table("nodes").select("id, label, type").in_("id", shared_neighbor_ids[:30]).execute()
            for sn in (sn_res.data or []):
                info = neighbor_connections[sn["id"]]
                connected_labels = [nodes_by_id[c]["label"] for c in info["connected_to"] if c in nodes_by_id]
                rel_labels = [l for l in info["labels"] if l][:3]
                rel_hint = f" via {', '.join(rel_labels)}" if rel_labels else ""
                shared_detail.append(f"{sn.get('label', sn['id'])} ({sn.get('type', '?')}){rel_hint}")

        # Build context block
        entity_lines = []
        for nid in node_ids:
            n = nodes_by_id.get(nid, {})
            # Prefer case-level description, fall back to global
            desc = case_descriptions.get(nid, "") or (n.get("description") or "")[:300]
            entity_lines.append(f"- {n.get('label', nid)} ({n.get('type', 'UNKNOWN')}): {desc}")

        edge_lines = []
        for e in (direct_edges.data or []):
            src = nodes_by_id.get(e["source"], {}).get("label", e["source"])
            tgt = nodes_by_id.get(e["target"], {}).get("label", e["target"])
            evidence = (e.get("evidence_text") or "")[:150]
            edge_lines.append(f"- {src} → {e.get('label', e.get('predicate', '?'))} → {tgt}" + (f" [{evidence}]" if evidence else ""))
        edge_lines.extend(case_edge_lines)

        connections_label = "DIRECT CONNECTIONS" if single_entity else "DIRECT CONNECTIONS BETWEEN THEM"
        neighbors_label = "CONNECTED ENTITIES" if single_entity else "SHARED CONNECTIONS (linked to 2+ of the selected)"

        system_context = f"""You are a seasoned investigative journalist with decades of experience uncovering financial crimes, corruption, and hidden power networks. You're having a conversation with a researcher about {"an entity" if single_entity else "a specific group of entities"} from a knowledge graph built from court documents, financial records, flight logs, and depositions.

ENTITIES UNDER DISCUSSION:
{chr(10).join(entity_lines)}

{connections_label}:
{chr(10).join(edge_lines) if edge_lines else "None found."}

{neighbors_label}:
{chr(10).join(shared_detail[:20]) if shared_detail else "None found."}

Answer the researcher's questions using this context. Be specific, cite entity names, and think like an investigative journalist — look for patterns, follow the money, identify intermediaries, and suggest leads. Keep responses concise and actionable."""

        # Build conversation for Gemini
        contents = [system_context]
        for msg in request.messages:
            contents.append(f"{'Researcher' if msg['role'] == 'user' else 'Journalist'}: {msg['content']}")

        config = None
        if request.mode == "files_web":
            config = types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )

        res = generate(
            client,
            model="gemini-2.0-flash",
            contents="\n\n".join(contents),
            config=config,
        )
        # Log usage (using a generic chat endpoint label for both)
        log_usage(user, "/api/cases/chat", "gemini-2.0-flash", res.usage_metadata)

        web_sources = []
        candidates = getattr(res, 'candidates', None)
        if candidates and len(candidates) > 0:
            gm = getattr(candidates[0], 'grounding_metadata', None)
            if gm and getattr(gm, 'grounding_chunks', None):
                import urllib.parse
                for gc in gm.grounding_chunks:
                    if gc.web:
                        uri = gc.web.uri or ""
                        if uri:
                            domain = urllib.parse.urlparse(uri).netloc.removeprefix('www.')
                            web_sources.append({
                                "title": gc.web.title or "",
                                "uri": uri,
                                "domain": domain
                            })

        return {"response": res.text, "web_sources": web_sources}
    except Exception as e:
        print(f"Graph chat failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/case-chat")
async def case_general_chat(case_id: str, request: CaseChatRequest, user = Depends(require_paid)):
    """General chat about the entire case and its network map."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    try:
        # Verify permissions
        await verify_case_ownership(case_id, user, write=False)

        # Load case metadata
        case_res = supabase.table("cases").select("title, summary, category").eq("id", case_id).execute()
        case_data = case_res.data[0] if case_res.data else {}

        # Load all entities on the map
        pinned = supabase.table("case_graph_entities").select("node_id").eq("case_id", case_id).execute()
        node_ids = [r["node_id"] for r in (pinned.data or [])]

        custom_res = supabase.table("case_graph_custom_nodes").select("id, label, type").eq("case_id", case_id).execute()
        custom_nodes = custom_res.data or []

        entity_lines = []
        nodes_by_id = {}
        if node_ids:
            nodes_res = supabase.table("nodes").select("id, label, type, description").in_("id", node_ids).execute()
            for n in (nodes_res.data or []):
                nodes_by_id[n["id"]] = n
                desc = (n.get("description") or "")[:200]
                entity_lines.append(f"- {n.get('label', n['id'])} ({n.get('type', '?')}): {desc}")
        for cn in custom_nodes:
            nodes_by_id[cn["id"]] = cn
            entity_lines.append(f"- {cn.get('label', 'Untitled')} ({cn.get('type', '?')}) [custom]")

        # Load case-level description overrides
        all_ids = node_ids + [cn["id"] for cn in custom_nodes]
        if all_ids:
            desc_res = supabase.table("case_entity_descriptions").select("node_id, description").eq("case_id", case_id).execute()
            for r in (desc_res.data or []):
                if r.get("description"):
                    n = nodes_by_id.get(r["node_id"], {})
                    label = n.get("label", r["node_id"])
                    entity_lines.append(f"  Note on {label}: {r['description'][:200]}")

        # Load case-local edges
        edge_lines = []
        case_edges_res = supabase.table("case_graph_edges").select("source_node_id, target_node_id, label").eq("case_id", case_id).execute()
        for ce in (case_edges_res.data or []):
            src = nodes_by_id.get(ce["source_node_id"], {}).get("label", ce["source_node_id"])
            tgt = nodes_by_id.get(ce["target_node_id"], {}).get("label", ce["target_node_id"])
            edge_lines.append(f"- {src} → {ce.get('label', '?')} → {tgt}")

        # Load groups
        groups_res = supabase.table("case_graph_groups").select("label, node_ids").eq("case_id", case_id).execute()
        group_lines = []
        for g in (groups_res.data or []):
            members = [nodes_by_id.get(nid, {}).get("label", nid) for nid in (g.get("node_ids") or [])]
            group_lines.append(f"- {g.get('label') or 'Unnamed group'}: {', '.join(members)}")

        system_context = f"""You are a seasoned investigative journalist with decades of experience uncovering financial crimes, corruption, and hidden power networks. You're having a conversation with a researcher about their case and its network map.

CASE: {case_data.get('title', 'Untitled')}
CATEGORY: {case_data.get('category', 'Unknown')}
SUMMARY: {case_data.get('summary', 'No summary.')}

ENTITIES ON THE MAP ({len(entity_lines)}):
{chr(10).join(entity_lines[:50]) if entity_lines else "None yet."}

CASE CONNECTIONS:
{chr(10).join(edge_lines[:30]) if edge_lines else "None yet."}

{"GROUPS:" + chr(10) + chr(10).join(group_lines) if group_lines else ""}

Answer the researcher's questions using this context. Be specific, cite entity names, and think like an investigative journalist — look for patterns, follow the money, identify intermediaries, and suggest leads. Use Google Search (if enabled) to supplement your knowledge about these entities, their backgrounds, and any recent news if the provided case context is insufficient. Keep responses concise and actionable."""

        contents = [system_context]
        for msg in request.messages:
            contents.append(f"{'Researcher' if msg['role'] == 'user' else 'Journalist'}: {msg['content']}")

        config = None
        if request.mode == "files_web":
            config = types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )

        res = generate(
            client,
            model="gemini-2.0-flash",
            contents="\n\n".join(contents),
            config=config,
        )
        # Log usage (using a generic chat endpoint label for both)
        log_usage(user, "/api/cases/chat", "gemini-2.0-flash", res.usage_metadata)

        web_sources = []
        candidates = getattr(res, 'candidates', None)
        if candidates and len(candidates) > 0:
            gm = getattr(candidates[0], 'grounding_metadata', None)
            if gm and getattr(gm, 'grounding_chunks', None):
                import urllib.parse
                for gc in gm.grounding_chunks:
                    if gc.web:
                        uri = gc.web.uri or ""
                        if uri:
                            domain = urllib.parse.urlparse(uri).netloc.removeprefix('www.')
                            web_sources.append({
                                "title": gc.web.title or "",
                                "uri": uri,
                                "domain": domain
                            })

        return {"response": res.text, "web_sources": web_sources}
    except Exception as e:
        print(f"Case chat failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/search/targeted")
async def targeted_search(request: TargetedSearchRequest, user = Depends(require_admin)):
    """Keyword search + optional network extraction using Supabase full-text search."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})

    keyword = request.keyword.strip()
    if not keyword:
        return JSONResponse(status_code=400, content={"error": "keyword is required"})

    try:
        page = max(1, request.page)
        page_size = max(1, min(200, request.page_size))
        offset = (page - 1) * page_size

        # Query Supabase via RPC
        if request.search_mode == "exact":
            rpc_result = supabase.rpc("search_chunks_exact", {
                "search_query": keyword,
                "result_limit": page_size,
                "result_offset": offset,
            }).execute()
        else:
            rpc_result = supabase.rpc("search_chunks", {
                "search_query": keyword,
                "result_limit": page_size,
                "result_offset": offset,
            }).execute()

        rows = rpc_result.data or []

        # Build chunks list
        chunks = []
        total_count = 0
        for row in rows:
            total_count = row.get("total_count", 0)
            chunks.append({
                "id": row["id"],
                "text": row["text"],
                "filename": row["filename"],
                "page": row["page"],
                "score": row.get("rank", 0),
            })

        unique_files = len(set(c["filename"] for c in chunks))
        total_pages = max(1, -(-total_count // page_size))  # ceil division
        stats = {
            "total_mentions": total_count,
            "unique_files": unique_files,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        }

        # --- Search-only mode ---
        if not request.extract:
            return {"chunks": chunks, "stats": stats}

        # --- Deep extract mode (one batch per request) ---
        import math
        batch_size = max(1, min(50, request.batch_size))
        batch_offset = max(0, request.batch_offset)

        # Fetch one batch of chunks at the given offset
        if request.search_mode == "exact":
            batch_result = supabase.rpc("search_chunks_exact", {
                "search_query": keyword,
                "result_limit": batch_size,
                "result_offset": batch_offset,
            }).execute()
        else:
            batch_result = supabase.rpc("search_chunks", {
                "search_query": keyword,
                "result_limit": batch_size,
                "result_offset": batch_offset,
            }).execute()

        batch_rows = batch_result.data or []

        if not batch_rows:
            return {"status": "done", "batch_entities": 0, "batch_triples": 0, "has_more": False}

        # Get total_count from first row (returned by the RPC)
        total_chunks = batch_rows[0].get("total_count", 0) if batch_rows else 0
        has_more = (batch_offset + batch_size) < total_chunks

        # Build context and run extraction
        context_parts = []
        for row in batch_rows:
            context_parts.append(f"[Source: {row['filename']}, Page: {row['page']}]\n{row['text']}")
        context = "\n\n---\n\n".join(context_parts)
        prompt = EXTRACTION_PROMPT_TEMPLATE.format(context=context)

        res = generate(
            client,
            model="gemini-2.5-pro",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CaseMap
            )
        )
        # Log usage
        log_usage(user, "/api/search/targeted", "gemini-2.5-pro", res.usage_metadata)

        output = res.parsed
        quality_ents = filter_quality_entities(output.entities)
        quality_ids = {e.id for e in quality_ents}

        # Build node records for upsert
        new_nodes = []
        for ent in quality_ents:
            new_nodes.append({
                "id": ent.id,
                "type": "entityNode",
                "data": {
                    "label": ent.label,
                    "entityType": ent.type.upper(),
                    "description": ent.description,
                    "aliases": ent.aliases,
                },
                "position": {"x": 400 + 300 * math.cos(hash(ent.id) % 100), "y": 400 + 300 * math.sin(hash(ent.id) % 100)},
            })

        # Build edge records for upsert
        new_edges = []
        for triple in output.triples:
            if triple.subject_id not in quality_ids or triple.object_id not in quality_ids:
                continue
            edge_id = f"e-{triple.subject_id}-{triple.predicate}-{triple.object_id}"
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

        # Upsert immediately
        if new_nodes or new_edges:
            graph_store.add_elements(new_nodes, new_edges)

        return {
            "status": "ok",
            "batch_entities": len(new_nodes),
            "batch_triples": len(new_edges),
            "has_more": has_more,
            "next_offset": batch_offset + batch_size,
            "total_chunks": total_chunks,
        }
    except Exception as e:
        print(f"Targeted search failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/upload", dependencies=[Depends(require_admin)])
async def upload_file(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    # Security: Sanitize filename to prevent directory traversal
    safe_filename = os.path.basename(file.filename)
    temp_dir = tempfile.mkdtemp()
    file_path = os.path.join(temp_dir, safe_filename)
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    background_tasks.add_task(process_upload, file_path, safe_filename)
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
        res = generate(
            client,
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


def _dual_write_chunks_to_supabase(batch):
    """Write a Pinecone batch [(id, embedding, meta), ...] to document_chunks. Non-blocking on failure."""
    if not supabase:
        return
    try:
        rows = []
        for vec_id, _emb, meta in batch:
            rows.append({
                "id": vec_id,
                "filename": meta.get("filename", "unknown"),
                "page": int(meta.get("page", 1)),
                "chunk_index": int(meta.get("chunk_index", 0)),
                "text": meta.get("text", ""),
                "gcs_path": meta.get("gcs_path"),
                "doc_type": meta.get("doc_type", "other"),
                "people": meta.get("people", []) or [],
                "organizations": meta.get("organizations", []) or [],
                "dates": meta.get("dates", []) or [],
            })
        if rows:
            supabase.table("document_chunks").upsert(rows).execute()
    except Exception as e:
        print(f"DEBUG: Supabase dual-write failed (non-fatal): {e}")


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
                        _dual_write_chunks_to_supabase(batch)
                        batch = []
                    i += 1
                start += UPLOAD_CHUNK_SIZE - UPLOAD_CHUNK_OVERLAP

        if batch:
            index.upsert(vectors=batch)
            _dual_write_chunks_to_supabase(batch)
        print(f"DEBUG: Finished indexing {filename}")
    finally:
        shutil.rmtree(os.path.dirname(file_path), ignore_errors=True)

@app.get("/api/scrape-progress")
async def get_scrape_progress(user = Depends(require_admin)):
    """Return live scraper progress from GCS."""
    try:
        if not bucket:
            return {"active": False}
        blob = bucket.blob("scrape_live_progress.json")
        if not blob.exists():
            return {"active": False}
        data = json.loads(blob.download_as_text())
        return data
    except Exception:
        return {"active": False}

@app.get("/api/reindex-progress")
async def get_reindex_progress(user = Depends(require_admin)):
    """Return live reindex/vectorization progress from GCS."""
    try:
        if not bucket:
            return {"active": False}
        blob = bucket.blob("reindex_live_progress.json")
        if not blob.exists():
            return {"active": False}
        data = json.loads(blob.download_as_text())
        # Include current control command so UI knows requested state
        try:
            ctrl_blob = bucket.blob("reindex_control.json")
            if ctrl_blob.exists():
                ctrl = json.loads(ctrl_blob.download_as_text())
                data["control_command"] = ctrl.get("command", "run")
                data["control_reason"] = ctrl.get("reason")
        except Exception:
            pass
        return data
    except Exception:
        return {"active": False}

@app.post("/api/reindex-control")
async def set_reindex_control(request: Request, _=Depends(require_admin)):
    """Set pause/resume command for the reindex job via GCS signal file."""
    try:
        if not bucket:
            return JSONResponse(status_code=503, content={"error": "GCS bucket not initialized"})
        body = await request.json()
        command = body.get("command")
        if command not in ("pause", "resume"):
            return JSONResponse(status_code=400, content={"error": "command must be 'pause' or 'resume'"})
        blob = bucket.blob("reindex_control.json")
        data = {
            "command": "pause" if command == "pause" else "run",
            "requested_at": datetime.now(timezone.utc).isoformat(),
            "requested_by": "ui",
        }
        if command == "pause":
            data["reason"] = "user_requested"
        blob.upload_from_string(json.dumps(data), content_type="application/json")
        return {"ok": True, "command": command}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/api/bulk-extract-progress")
async def get_bulk_extract_progress(user = Depends(require_admin)):
    """Return live bulk extraction progress from GCS."""
    try:
        if not bucket:
            return {"active": False}
        blob = bucket.blob("bulk_extract_live_progress.json")
        if not blob.exists():
            return {"active": False}
        data = json.loads(blob.download_as_text())
        try:
            ctrl_blob = bucket.blob("bulk_extract_control.json")
            if ctrl_blob.exists():
                ctrl = json.loads(ctrl_blob.download_as_text())
                data["control_command"] = ctrl.get("command", "run")
        except Exception:
            pass
        return data
    except Exception:
        return {"active": False}

@app.post("/api/bulk-extract-control")
async def set_bulk_extract_control(request: Request, _=Depends(require_admin)):
    """Set pause/resume command for the bulk extraction job."""
    try:
        if not bucket:
            return JSONResponse(status_code=503, content={"error": "GCS bucket not initialized"})
        body = await request.json()
        command = body.get("command")
        if command not in ("pause", "resume"):
            return JSONResponse(status_code=400, content={"error": "command must be 'pause' or 'resume'"})
        blob = bucket.blob("bulk_extract_control.json")
        data = {
            "command": "pause" if command == "pause" else "run",
            "requested_at": datetime.now(timezone.utc).isoformat(),
            "requested_by": "ui",
        }
        if command == "pause":
            data["reason"] = "user_requested"
        blob.upload_from_string(json.dumps(data), content_type="application/json")
        return {"ok": True, "command": command}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/api/datasets")
async def get_datasets(user = Depends(require_admin)):
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


@app.get("/api/urls/saved")
async def get_saved_urls(user = Depends(require_user)):
    """Return pre-extracted URLs from the database."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        res = supabase.table("extracted_urls")\
            .select("url, domain, mention_count, is_junk, sources, extracted_at")\
            .order("is_junk")\
            .order("mention_count", desc=True)\
            .execute()
        rows = res.data or []

        urls = [{
            "url": r["url"],
            "domain": r["domain"],
            "count": r["mention_count"],
            "junk": r["is_junk"],
            "sources": r["sources"] or [],
        } for r in rows]

        junk_count = sum(1 for u in urls if u["junk"])
        extracted_at = rows[0]["extracted_at"] if rows else None

        return {
            "urls": urls,
            "total": len(urls),
            "junk_count": junk_count,
            "clean_count": len(urls) - junk_count,
            "extracted_at": extracted_at,
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/urls/extract")
async def extract_and_save_urls(user = Depends(require_admin)):
    """Extract URLs from document_chunks and persist to extracted_urls table.

    Uses cursor-based pagination keyed on id to avoid full-table scans.
    Returns partial results after 45s to stay within Vercel limits.
    """
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        import re
        from urllib.parse import urlparse
        url_pattern = re.compile(r'https?://[^\s<>"\')\]},;]+')

        all_urls = {}  # url -> [{filename, page}]
        cursor = ""  # last seen id for keyset pagination
        page_size = 500
        chunks_scanned = 0
        t0 = time.time()
        timed_out = False

        while True:
            if time.time() - t0 > 45:
                timed_out = True
                break

            query = supabase.table("document_chunks")\
                .select("id, text, filename, page")\
                .order("id")\
                .limit(page_size)
            if cursor:
                query = query.gt("id", cursor)
            res = query.execute()
            rows = res.data or []
            if not rows:
                break
            cursor = rows[-1]["id"]
            chunks_scanned += len(rows)

            for row in rows:
                text = row.get("text") or ""
                if "http" not in text:
                    continue
                found = url_pattern.findall(text)
                for raw_url in found:
                    url = raw_url.rstrip(".,;:!?)")
                    if len(url) < 12:
                        continue
                    if url not in all_urls:
                        all_urls[url] = []
                    if len(all_urls[url]) < 3:
                        all_urls[url].append({
                            "filename": row.get("filename", ""),
                            "page": row.get("page"),
                        })

        # Junk detection heuristics
        JUNK_DOMAINS = {
            "protect2.fireeye.com", "protect2.fireeye.corn", "protect2.fireeye.coin",
            "photos.app.goo.gl", "goo.gl",
            "outlook.office365.us", "outlook.office365.com",
            "zoom.us", "us02web.zoom.us", "zoomgov.com",
            "webex.com", "usao.webex.com", "help.webex.com",
            "e2.gov.cwtsatotravel.com", "e2.gov.ewtsatotravel.com",
            "app.certify.me",
            "mail.google.com", "drive.google.com", "docs.google.com",
            "google.com", "www.google.com",
            "symanteccloud.com", "xerox.com", "office.com",
        }
        JUNK_PARTIALS = [
            "dojnet.doj.gov", "bop.tcp.doj.gov", "bop.tep.doj.gov",
            "bopicp.doj.gov", "bopacp.doj.gov",
            "sentinel.fbinet", "sentinelfbinet", "sentinelibi", "sentmel.",
            "sentinal", "senlineli", "sentinsl",
            "dlpe.nss.pae.com", "d1pe.nss.pae.com",
            "usanet.usa.do", "portal.doj.gov",
        ]
        OCR_TLDS = re.compile(
            r'\.(corn|coml|comi|comj|comt|comx|cotni|cotn|comk|cotre|corni|cornt)'
            r'|\.govijm|\.govisit|\.govicovid|\.goviusao|\.govifoia'
            r'|\.orginews|\.orgiortkle'
            r'|\.co\.ukjnews|\.co\.ukinews|\.co\.uldnews',
            re.IGNORECASE
        )
        INTERNAL_PATTERNS = re.compile(
            r'fbinet\.fbi|\.fbinet|domsrv|domsfv|foxhaven|crmln\d|\.atmil',
            re.IGNORECASE
        )

        def is_junk(url):
            try:
                host = urlparse(url).hostname or ""
            except Exception:
                return True
            if len(host) < 4 or "." not in host:
                return True
            if host in JUNK_DOMAINS or host.lstrip("www.") in JUNK_DOMAINS:
                return True
            for p in JUNK_PARTIALS:
                if p in host or p in url:
                    return True
            if OCR_TLDS.search(url):
                return True
            if INTERNAL_PATTERNS.search(url):
                return True
            return False

        # Build results with pre-computed domain
        results = []
        for url, sources in all_urls.items():
            try:
                domain = urlparse(url).hostname or ""
                if domain.startswith("www."):
                    domain = domain[4:]
            except Exception:
                domain = ""
            results.append({
                "url": url,
                "domain": domain,
                "mention_count": len(sources),
                "sources": sources,
                "is_junk": is_junk(url),
            })
        results.sort(key=lambda x: (-int(not x["is_junk"]), -x["mention_count"]))

        # Persist: clear old data, insert new in batches
        supabase.table("extracted_urls").delete().neq("id", 0).execute()
        batch_size = 200
        for i in range(0, len(results), batch_size):
            batch = results[i:i + batch_size]
            supabase.table("extracted_urls").insert(batch).execute()

        junk_count = sum(1 for r in results if r["is_junk"])
        return {
            "urls": [{
                "url": r["url"],
                "domain": r["domain"],
                "count": r["mention_count"],
                "junk": r["is_junk"],
                "sources": r["sources"],
            } for r in results],
            "total": len(results),
            "junk_count": junk_count,
            "clean_count": len(results) - junk_count,
            "chunks_scanned": chunks_scanned,
            "complete": not timed_out,
            "elapsed_s": round(time.time() - t0, 1),
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/infrastructure-health")
async def infrastructure_health(user = Depends(require_admin)):
    """Probe GCS, Pinecone, Supabase, and API server health in parallel."""
    import asyncio

    async def check_gcs():
        t0 = time.time()
        try:
            if not bucket:
                return {"service": "gcs", "status": "down", "latency_ms": 0, "error": "Bucket not initialized", "metrics": {}}

            def _check():
                blob = bucket.blob("pipeline_status.json")
                if not blob.exists():
                    return {"blob_count": 0, "size_mb": 0}
                data = json.loads(blob.download_as_text())
                totals = data.get("totals", {})
                return {"blob_count": totals.get("scraped", 0), "size_mb": totals.get("size_mb", 0)}

            metrics = await asyncio.wait_for(asyncio.to_thread(_check), timeout=5.0)
            return {"service": "gcs", "status": "healthy", "latency_ms": round((time.time() - t0) * 1000), "metrics": metrics}
        except asyncio.TimeoutError:
            return {"service": "gcs", "status": "down", "latency_ms": 5000, "error": "Timeout", "metrics": {}}
        except Exception as e:
            return {"service": "gcs", "status": "down", "latency_ms": round((time.time() - t0) * 1000), "error": str(e), "metrics": {}}

    async def check_pinecone():
        t0 = time.time()
        try:
            if not index:
                return {"service": "pinecone", "status": "down", "latency_ms": 0, "error": "Index not initialized", "metrics": {}}

            def _check():
                stats = index.describe_index_stats()
                return {
                    "total_vectors": stats.total_vector_count,
                    "index_fullness": round(stats.index_fullness * 100, 2),
                    "namespaces": {ns: {"vector_count": ns_stats.vector_count} for ns, ns_stats in (stats.namespaces or {}).items()},
                    "dimension": stats.dimension,
                }

            metrics = await asyncio.wait_for(asyncio.to_thread(_check), timeout=5.0)
            return {"service": "pinecone", "status": "healthy", "latency_ms": round((time.time() - t0) * 1000), "metrics": metrics}
        except asyncio.TimeoutError:
            return {"service": "pinecone", "status": "down", "latency_ms": 5000, "error": "Timeout", "metrics": {}}
        except Exception as e:
            return {"service": "pinecone", "status": "down", "latency_ms": round((time.time() - t0) * 1000), "error": str(e), "metrics": {}}

    async def check_supabase():
        t0 = time.time()
        try:
            if not supabase:
                return {"service": "supabase", "status": "down", "latency_ms": 0, "error": "Client not initialized", "metrics": {}}

            def _check():
                chunks_res = supabase.table("document_chunks").select("*", count="estimated").limit(0).execute()
                nodes_res = supabase.table("nodes").select("*", count="estimated").limit(0).execute()
                edges_res = supabase.table("edges").select("*", count="estimated").limit(0).execute()
                return {"document_chunks": chunks_res.count or 0, "nodes": nodes_res.count or 0, "edges": edges_res.count or 0}

            metrics = await asyncio.wait_for(asyncio.to_thread(_check), timeout=5.0)
            return {"service": "supabase", "status": "healthy", "latency_ms": round((time.time() - t0) * 1000), "metrics": metrics}
        except asyncio.TimeoutError:
            return {"service": "supabase", "status": "down", "latency_ms": 5000, "error": "Timeout", "metrics": {}}
        except Exception as e:
            return {"service": "supabase", "status": "down", "latency_ms": round((time.time() - t0) * 1000), "error": str(e), "metrics": {}}

    # API server info (instant, no thread needed)
    uptime_seconds = time.time() - _server_start_time
    if uptime_seconds < 3600:
        uptime_str = f"{uptime_seconds / 60:.0f}m"
    elif uptime_seconds < 86400:
        uptime_str = f"{uptime_seconds / 3600:.1f}h"
    else:
        uptime_str = f"{uptime_seconds / 86400:.1f}d"

    api_result = {
        "service": "api",
        "status": "healthy",
        "latency_ms": 0,
        "metrics": {
            "uptime": uptime_str,
            "uptime_seconds": round(uptime_seconds),
            "python_version": platform.python_version(),
            "server_time": datetime.now(timezone.utc).isoformat(),
        },
    }

    gcs_result, pinecone_result, supabase_result = await asyncio.gather(
        check_gcs(), check_pinecone(), check_supabase()
    )

    return {
        "services": [gcs_result, pinecone_result, supabase_result, api_result],
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/graph/bulk-extract-status", dependencies=[Depends(require_admin)])
async def bulk_extract_status():
    """Debug: check bulk extract readiness without actually extracting."""
    info = {"supabase": bool(supabase), "gemini_client": bool(client)}
    try:
        # Count processed files from edges
        processed_files = set()
        offset = 0
        while True:
            batch = supabase.table("edges").select("source_filename").neq("source_filename", "").range(offset, offset + 999).execute()
            for row in (batch.data or []):
                sf = row.get("source_filename")
                if sf:
                    processed_files.add(sf)
            if not batch.data or len(batch.data) < 1000:
                break
            offset += 1000
        info["processed_files"] = len(processed_files)

        # Count available files from document_chunks
        chunk_result = supabase.rpc("get_unique_filenames").execute()
        all_filenames = [row["filename"] for row in (chunk_result.data or []) if row.get("filename")]
        info["total_chunk_files"] = len(all_filenames)

        to_process = [f for f in all_filenames if f not in processed_files]
        info["to_process"] = len(to_process)
        info["sample_to_process"] = to_process[:5]
    except Exception as e:
        info["error"] = str(e)
        import traceback
        info["traceback"] = traceback.format_exc()
    return info

@app.post("/api/graph/bulk-extract")
async def bulk_extract_graph(user = Depends(require_admin)):
    """Extract entities and relationships from all vectorized documents not yet in the graph."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized"})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized"})

    try:
        # Single SQL query: get unprocessed filenames (chunks not yet in edges)
        BATCH_SIZE = 10
        rpc_result = supabase.rpc("get_unprocessed_filenames", {"batch_limit": BATCH_SIZE}).execute()
        batch = [row["filename"] for row in (rpc_result.data or []) if row.get("filename")]

        if not batch:
            return {"files_processed": 0, "entities_added": 0, "triples_added": 0, "files_skipped": 0,
                    "remaining_files": 0, "message": "All vectorized documents already in graph"}
        total_entities = 0
        total_triples = 0
        files_ok = 0
        files_skipped = 0
        files_errored = 0

        for filename in batch:
            try:
                # Get all chunks for this file
                chunks_res = supabase.table("document_chunks").select("text,page").eq("filename", filename).order("chunk_index").execute()
                if not chunks_res.data:
                    files_skipped += 1
                    continue

                context_parts = []
                for row in chunks_res.data:
                    page = row.get("page", "?")
                    context_parts.append(f"[Source: {filename}, Page: {page}]\n{row['text']}")
                context = "\n\n---\n\n".join(context_parts)

                if len(context.strip()) < 100:
                    files_skipped += 1
                    continue

                prompt = EXTRACTION_PROMPT_TEMPLATE.format(context=context[:100000])

                res = generate(
                    client,
                    model="gemini-2.5-pro",
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=CaseMap
                    )
                )
                log_usage(user, "/api/graph/bulk-extract", "gemini-2.5-pro", res.usage_metadata)
                output = res.parsed
                raw_ent_count = len(output.entities)
                raw_tri_count = len(output.triples)

                quality_entities = filter_quality_entities(output.entities)
                if len(quality_entities) < len(output.entities):
                    print(f"  Quality gate: kept {len(quality_entities)}/{raw_ent_count} entities")

                import math
                new_nodes = []
                total = len(quality_entities)
                cx, cy = 400, 400
                radius = max(200, total * 30)
                for i, ent in enumerate(quality_entities):
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

                entity_ids = {ent.id for ent in quality_entities}
                seen_edge_ids = set()
                new_edges = []
                for triple in output.triples:
                    if triple.subject_id not in entity_ids or triple.object_id not in entity_ids:
                        continue
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

                if new_nodes or new_edges:
                    graph_store.add_elements(new_nodes, new_edges)
                    total_entities += len(new_nodes)
                    total_triples += len(new_edges)

                files_ok += 1
                print(f"  Bulk extract: {filename} -> {len(new_nodes)}/{raw_ent_count} entities, {len(new_edges)}/{raw_tri_count} triples (after quality gate)")

            except Exception as e:
                print(f"  Bulk extract failed for {filename}: {e}")
                files_errored += 1
                continue

        # Count actual remaining unprocessed files
        next_check = supabase.rpc("get_unprocessed_filenames", {"batch_limit": 100000}).execute()
        remaining_count = len(next_check.data) if next_check.data else 0
        return {
            "files_processed": files_ok,
            "entities_added": total_entities,
            "triples_added": total_triples,
            "files_skipped": files_skipped,
            "files_errored": files_errored,
            "remaining_files": remaining_count,
        }

    except Exception as e:
        print(f"Bulk extract failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/graph/communities", dependencies=[Depends(require_admin)])
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


# ── Timeline endpoints ────────────────────────────────────────────────────────

@app.get("/api/cases/{case_id}/timeline")
async def get_case_timeline(case_id: str, user = Depends(optional_user)):
    """Load all timeline events and edges for a case."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=False)

        events_res = supabase.table("case_timeline_events").select("*").eq("case_id", case_id).order("created_at").execute()
        edges_res = supabase.table("case_timeline_edges").select("*").eq("case_id", case_id).execute()

        # Load tracks + event→track mappings
        tracks_res = supabase.table("case_timeline_tracks").select("*").eq("case_id", case_id).order("created_at").execute()
        tracks = tracks_res.data or []
        valid_track_ids = {t["id"] for t in tracks}
        event_tracks: Dict[str, List[str]] = {}
        if tracks:
            map_res = supabase.table("case_timeline_event_tracks").select("event_id, track_id").in_("track_id", list(valid_track_ids)).execute()
            for row in (map_res.data or []):
                event_tracks.setdefault(row["event_id"], []).append(row["track_id"])
        # Count events per track for the panel
        track_counts: Dict[str, int] = {}
        for tids in event_tracks.values():
            for tid in tids:
                track_counts[tid] = track_counts.get(tid, 0) + 1
        for t in tracks:
            t["event_count"] = track_counts.get(t["id"], 0)

        nodes = []
        for ev in (events_res.data or []):
            nodes.append({
                "id": ev["id"],
                "type": "eventNode",
                "position": {"x": ev.get("position_x", 0), "y": ev.get("position_y", 0)},
                "data": {
                    "title": ev["title"],
                    "event_date": ev.get("event_date"),
                    "description": ev.get("description", ""),
                    "category": ev.get("category", "general"),
                    "sourceGraphNodeId": ev.get("source_graph_node_id"),
                    "track_ids": event_tracks.get(ev["id"], []),
                    "sources": ev.get("sources"),
                },
            })

        edges = []
        for ed in (edges_res.data or []):
            edges.append({
                "id": ed["id"],
                "source": ed["source_event_id"],
                "target": ed["target_event_id"],
                "type": "draggable",
                "data": {
                    "label": ed.get("label", ""),
                    "labelPosition": ed.get("label_position", 0.5),
                    "isCaseLocal": True,
                },
            })

        return {"nodes": nodes, "edges": edges, "tracks": tracks}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/events")
async def create_timeline_event(case_id: str, request: CreateTimelineEventRequest, user = Depends(require_user)):
    """Create a new timeline event."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        record = {
            "case_id": case_id,
            "title": request.title,
            "event_date": request.event_date,
            "description": request.description,
            "category": request.category,
            "position_x": request.position_x,
            "position_y": request.position_y,
            "sources": request.sources,
        }
        result = supabase.table("case_timeline_events").insert(record).execute()
        ev = result.data[0] if result.data else None
        # Associate with tracks if provided
        if ev and request.track_ids:
            junction = [{"event_id": ev["id"], "track_id": tid} for tid in request.track_ids]
            supabase.table("case_timeline_event_tracks").insert(junction).execute()
        return {"id": ev["id"] if ev else None, "event": ev, "track_ids": request.track_ids}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}/timeline/events/{event_id}")
async def update_timeline_event(case_id: str, event_id: str, request: UpdateTimelineEventRequest, user = Depends(require_user)):
    """Update a timeline event's fields."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        updates = {}
        if request.title is not None:
            updates["title"] = request.title
        if request.event_date is not None:
            updates["event_date"] = request.event_date
        if request.description is not None:
            updates["description"] = request.description
        if request.category is not None:
            updates["category"] = request.category

        if updates:
            result = supabase.table("case_timeline_events").update(updates).eq("id", event_id).eq("case_id", case_id).execute()
            if not result.data:
                return JSONResponse(status_code=404, content={"error": "Event not found."})

        # Replace track associations if provided
        if request.track_ids is not None:
            supabase.table("case_timeline_event_tracks").delete().eq("event_id", event_id).execute()
            if request.track_ids:
                junction = [{"event_id": event_id, "track_id": tid} for tid in request.track_ids]
                supabase.table("case_timeline_event_tracks").insert(junction).execute()

        if not updates and request.track_ids is None:
            return {"id": event_id}
        return {"id": event_id, **updates, "track_ids": request.track_ids}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}/timeline/events/{event_id}")
async def delete_timeline_event(case_id: str, event_id: str, user = Depends(require_user)):
    """Delete a timeline event (edges cascade)."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        supabase.table("case_timeline_events").delete().eq("id", event_id).eq("case_id", case_id).execute()
        return {"deleted": event_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/positions")
async def save_timeline_positions(case_id: str, request: SaveTimelinePositionsRequest, user = Depends(require_user)):
    """Save dragged event positions."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        for pos in request.positions:
            supabase.table("case_timeline_events").update({
                "position_x": pos["x"],
                "position_y": pos["y"],
            }).eq("id", pos["event_id"]).eq("case_id", case_id).execute()
        return {"saved": len(request.positions)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/edges")
async def create_timeline_edge(case_id: str, request: CreateTimelineEdgeRequest, user = Depends(require_user)):
    """Create an edge between two timeline events."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        record = {
            "case_id": case_id,
            "source_event_id": request.source_event_id,
            "target_event_id": request.target_event_id,
            "label": request.label,
        }
        result = supabase.table("case_timeline_edges").upsert(
            record, on_conflict="case_id,source_event_id,target_event_id"
        ).execute()
        return {"id": result.data[0]["id"] if result.data else None}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}/timeline/edges/{edge_id}")
async def delete_timeline_edge(case_id: str, edge_id: str, user = Depends(require_user)):
    """Delete a timeline edge."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        supabase.table("case_timeline_edges").delete().eq("id", edge_id).eq("case_id", case_id).execute()
        return {"deleted": edge_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ── Timeline tracks (per-entity overlay tracks) ───────────────────────────────

@app.get("/api/cases/{case_id}/timeline/tracks")
async def list_timeline_tracks(case_id: str, user = Depends(optional_user)):
    """List all entity tracks for this case, each with event count."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=False)

        tracks_res = supabase.table("case_timeline_tracks").select("*").eq("case_id", case_id).order("created_at").execute()
        tracks = tracks_res.data or []
        # Count events per track
        if tracks:
            track_ids = [t["id"] for t in tracks]
            counts_res = supabase.table("case_timeline_event_tracks").select("track_id").in_("track_id", track_ids).execute()
            counts: Dict[str, int] = {}
            for row in (counts_res.data or []):
                counts[row["track_id"]] = counts.get(row["track_id"], 0) + 1
            for t in tracks:
                t["event_count"] = counts.get(t["id"], 0)
        return {"tracks": tracks}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/tracks")
async def create_timeline_track(case_id: str, request: CreateTimelineTrackRequest, user = Depends(require_user)):
    """Create a new entity track on the timeline."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        record = {
            "case_id": case_id,
            "entity_node_id": request.entity_node_id,
            "label": request.label,
            "color": request.color,
        }
        result = supabase.table("case_timeline_tracks").insert(record).execute()
        track = result.data[0] if result.data else None
        if track:
            track["event_count"] = 0
        return {"track": track}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.patch("/api/cases/{case_id}/timeline/tracks/{track_id}")
async def update_timeline_track(case_id: str, track_id: str, request: UpdateTimelineTrackRequest, user = Depends(require_user)):
    """Update a track's label, color, or enabled state."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        updates = {}
        if request.label is not None:
            updates["label"] = request.label
        if request.color is not None:
            updates["color"] = request.color
        if request.enabled is not None:
            updates["enabled"] = request.enabled
        if not updates:
            return {"id": track_id}

        result = supabase.table("case_timeline_tracks").update(updates).eq("id", track_id).eq("case_id", case_id).execute()
        if not result.data:
            return JSONResponse(status_code=404, content={"error": "Track not found."})
        return {"id": track_id, **updates}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/api/cases/{case_id}/timeline/tracks/{track_id}")
async def delete_timeline_track(case_id: str, track_id: str, user = Depends(require_user)):
    """Delete a track (junction rows cascade; events themselves are preserved)."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        supabase.table("case_timeline_tracks").delete().eq("id", track_id).eq("case_id", case_id).execute()
        return {"deleted": track_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/import-graph-events")
async def import_graph_events(case_id: str, request: ImportGraphEventsRequest, user = Depends(require_user)):
    """Import EVENT-typed nodes from the knowledge graph into the timeline."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        # Check which graph nodes are already imported
        existing = supabase.table("case_timeline_events").select("source_graph_node_id").eq("case_id", case_id).not_.is_("source_graph_node_id", "null").execute()
        already_imported = set(r["source_graph_node_id"] for r in (existing.data or []))

        new_ids = [nid for nid in request.node_ids if nid not in already_imported]
        if not new_ids:
            return {"imported": 0, "skipped": len(request.node_ids)}

        # Fetch node details from the nodes table
        nodes_res = supabase.table("nodes").select("id, label, type, description").in_("id", new_ids).execute()
        node_map = {n["id"]: n for n in (nodes_res.data or [])}

        # Sort by label for a rough left-to-right layout
        sorted_ids = sorted(new_ids, key=lambda nid: node_map.get(nid, {}).get("label", ""))
        imported = []
        for i, nid in enumerate(sorted_ids):
            node = node_map.get(nid)
            if not node:
                continue
            record = {
                "case_id": case_id,
                "title": node.get("label", "Unknown Event"),
                "description": node.get("description", ""),
                "category": "legal" if "court" in (node.get("label", "") or "").lower() else "general",
                "position_x": i * 280,
                "position_y": 0,
                "source_graph_node_id": nid,
            }
            result = supabase.table("case_timeline_events").insert(record).execute()
            if result.data:
                imported.append(result.data[0])

        return {"imported": len(imported), "skipped": len(request.node_ids) - len(new_ids)}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/research")
async def timeline_research(case_id: str, request: TimelineResearchRequest, user = Depends(require_paid)):
    """AI-powered research for the timeline — uses Google Search to find events, people, dates."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        # Load case context
        case_res = supabase.table("cases").select("title, summary, category").eq("id", case_id).execute()
        case_data = case_res.data[0] if case_res.data else {}

        # Load existing timeline events for context
        events_res = supabase.table("case_timeline_events").select("title, event_date, category").eq("case_id", case_id).execute()
        existing_events = events_res.data or []
        events_context = ""
        if existing_events:
            event_lines = [f"- {e['title']}" + (f" ({e.get('event_date', '')})" if e.get('event_date') else "") for e in existing_events]
            events_context = f"\n\nEXISTING TIMELINE EVENTS:\n" + "\n".join(event_lines[:30])

        # Build focused events context if any are selected
        focused_context = ""
        if request.focused_events:
            focused_lines = []
            for fe in request.focused_events:
                line = f"- [{fe.get('category', 'general')}] {fe.get('date', 'No date')} — {fe.get('title', '')}"
                if fe.get('description'):
                    line += f": {fe['description']}"
                focused_lines.append(line)
            focused_context = f"\n\nFOCUSED EVENTS (the user has selected these to discuss):\n" + "\n".join(focused_lines)

        system_prompt = f"""You are a seasoned investigative researcher helping build a timeline of events for a case investigation. Your job is to research the user's question using web search and return findings as structured events that can be added to an investigation timeline.

CASE: {case_data.get('title', 'Untitled')}
CATEGORY: {case_data.get('category', 'Unknown')}
SUMMARY: {case_data.get('summary', 'No summary.')}{focused_context}{events_context}

IMPORTANT: After your narrative response, you MUST include a structured section at the very end formatted EXACTLY like this:

---EVENTS---
[
  {{"title": "Event title", "date": "YYYY-MM-DD or YYYY-MM or YYYY or null", "description": "Brief description", "category": "property|epstein-link|regulatory|political|corporate|financial|legal|crime|general"}}
]
---END---

Guidelines:
- Search the web thoroughly to find accurate dates, names, and details
- Include 2-8 events per response depending on the question
- Use precise dates when available, partial dates (YYYY-MM or YYYY) when exact date unknown, null if no date can be determined
- Choose the most appropriate category for each event
- Keep descriptions concise (1-2 sentences)
- Do NOT include events that are already on the timeline
- Think like an investigative journalist — follow the money, identify key players, find the pivotal moments"""

        contents = [system_prompt]
        for msg in request.messages:
            contents.append(f"{'Researcher' if msg['role'] == 'user' else 'Assistant'}: {msg['content']}")
        contents.append(f"Researcher: {request.query}")

        config = types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())]
        )

        res = generate(
            client,
            model="gemini-2.0-flash",
            contents="\n\n".join(contents),
            config=config,
        )

        log_usage(user, "/api/cases/timeline/research", "gemini-2.0-flash", res.usage_metadata)

        # Extract web sources (may be absent when Groq fallback is used)
        web_sources = []
        candidates = getattr(res, 'candidates', None)
        if candidates and len(candidates) > 0:
            gm = getattr(candidates[0], 'grounding_metadata', None)
            if gm and getattr(gm, 'grounding_chunks', None):
                import urllib.parse
                for gc in gm.grounding_chunks:
                    if gc.web:
                        uri = gc.web.uri or ""
                        if uri:
                            domain = urllib.parse.urlparse(uri).netloc.removeprefix('www.')
                            web_sources.append({
                                "title": gc.web.title or "",
                                "uri": uri,
                                "domain": domain,
                            })

        # Parse structured events from response
        full_text = res.text or ""
        events = []
        narrative = full_text

        if "---EVENTS---" in full_text and "---END---" in full_text:
            parts = full_text.split("---EVENTS---")
            narrative = parts[0].strip()
            events_json = parts[1].split("---END---")[0].strip()
            try:
                events = json.loads(events_json)
            except json.JSONDecodeError:
                # Try to fix common issues
                try:
                    # Sometimes the model wraps in markdown code blocks
                    cleaned = events_json.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
                    events = json.loads(cleaned)
                except json.JSONDecodeError:
                    pass

        return {
            "narrative": narrative,
            "events": events,
            "web_sources": web_sources,
        }
    except Exception as e:
        print(f"Timeline research failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/generate-track")
async def generate_timeline_track(case_id: str, request: GenerateTrackRequest, user = Depends(require_paid)):
    """AI generates a timeline of events for a specific entity, drawing on network-graph connections + web search."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        # 1. Load case context
        case_res = supabase.table("cases").select("title, summary, category").eq("id", case_id).execute()
        case_data = case_res.data[0] if case_res.data else {}

        # 2. Resolve entity info (could be a global node OR a case_graph_custom_node)
        entity_label = request.entity_label
        entity_type = "PERSON"
        entity_description = ""
        entity_aliases: List[str] = []

        global_node_res = supabase.table("nodes").select("label, type, description, aliases").eq("id", request.entity_node_id).execute()
        if global_node_res.data:
            node = global_node_res.data[0]
            entity_label = node.get("label") or entity_label
            entity_type = node.get("type") or entity_type
            entity_description = node.get("description") or ""
            entity_aliases = node.get("aliases") or []
        else:
            custom_res = supabase.table("case_graph_custom_nodes").select("label, type").eq("id", request.entity_node_id).eq("case_id", case_id).execute()
            if custom_res.data:
                node = custom_res.data[0]
                entity_label = node.get("label") or entity_label
                entity_type = node.get("type") or entity_type

        # 3. Case-specific description override
        case_desc_res = supabase.table("case_entity_descriptions").select("description").eq("case_id", case_id).eq("node_id", request.entity_node_id).execute()
        case_description = ""
        if case_desc_res.data:
            case_description = case_desc_res.data[0].get("description", "") or ""

        # 4. Pull network-graph connections for this entity (both global and case-local edges)
        connections: List[Dict[str, Any]] = []
        try:
            global_out = supabase.table("edges").select("source, target, label, predicate, evidence_text, source_filename, date_mentioned").eq("source", request.entity_node_id).limit(20).execute()
            global_in = supabase.table("edges").select("source, target, label, predicate, evidence_text, source_filename, date_mentioned").eq("target", request.entity_node_id).limit(20).execute()
            for row in (global_out.data or []) + (global_in.data or []):
                connections.append({
                    "neighbor_id": row["target"] if row["source"] == request.entity_node_id else row["source"],
                    "label": row.get("label") or row.get("predicate") or "related_to",
                    "evidence": (row.get("evidence_text") or "")[:220],
                    "source_filename": row.get("source_filename") or "",
                    "date_mentioned": row.get("date_mentioned") or "",
                    "is_case_local": False,
                })
        except Exception:
            pass
        try:
            case_out = supabase.table("case_graph_edges").select("source_node_id, target_node_id, label, evidence_text, source_filename").eq("case_id", case_id).eq("source_node_id", request.entity_node_id).limit(20).execute()
            case_in = supabase.table("case_graph_edges").select("source_node_id, target_node_id, label, evidence_text, source_filename").eq("case_id", case_id).eq("target_node_id", request.entity_node_id).limit(20).execute()
            for row in (case_out.data or []) + (case_in.data or []):
                connections.append({
                    "neighbor_id": row["target_node_id"] if row["source_node_id"] == request.entity_node_id else row["source_node_id"],
                    "label": row.get("label") or "related_to",
                    "evidence": (row.get("evidence_text") or "")[:220],
                    "source_filename": row.get("source_filename") or "",
                    "date_mentioned": "",
                    "is_case_local": True,
                })
        except Exception:
            pass
        # Cap connections
        connections = connections[:30]

        # 5. Resolve neighbor labels
        neighbor_ids = list({c["neighbor_id"] for c in connections if c.get("neighbor_id")})
        neighbor_labels: Dict[str, str] = {}
        if neighbor_ids:
            try:
                nbr_res = supabase.table("nodes").select("id, label").in_("id", neighbor_ids).execute()
                for n in (nbr_res.data or []):
                    neighbor_labels[n["id"]] = n.get("label") or n["id"]
            except Exception:
                pass
            try:
                custom_nbr_res = supabase.table("case_graph_custom_nodes").select("id, label").in_("id", neighbor_ids).execute()
                for n in (custom_nbr_res.data or []):
                    neighbor_labels.setdefault(n["id"], n.get("label") or n["id"])
            except Exception:
                pass

        connections_block = ""
        if connections:
            lines = []
            for c in connections:
                nbr = neighbor_labels.get(c["neighbor_id"], c["neighbor_id"])
                line = f"- {nbr} — {c['label']}"
                if c["evidence"]:
                    line += f": {c['evidence']}"
                if c["source_filename"]:
                    line += f" [{c['source_filename']}]"
                if c["date_mentioned"]:
                    line += f" ({c['date_mentioned']})"
                lines.append(line)
            connections_block = "\n\nNETWORK-GRAPH CONNECTIONS (from existing case evidence):\n" + "\n".join(lines)

        # 6. Existing timeline events for dedup
        events_res = supabase.table("case_timeline_events").select("title, event_date").eq("case_id", case_id).execute()
        existing_events = events_res.data or []
        events_context = ""
        if existing_events:
            event_lines = [f"- {e.get('event_date', 'no date')} — {e['title']}" for e in existing_events]
            events_context = "\n\nEXISTING TIMELINE EVENTS (do not duplicate):\n" + "\n".join(event_lines[:40])

        aliases_str = ", ".join(entity_aliases) if entity_aliases else "(none)"
        extra_guidance = f"\n\nUSER GUIDANCE: {request.query}" if request.query else ""

        system_prompt = f"""You are an investigative researcher building a timeline of events for {entity_label} ({entity_type}) within the case "{case_data.get('title', 'Untitled')}".

CASE CATEGORY: {case_data.get('category', 'Unknown')}
CASE SUMMARY: {case_data.get('summary', 'No summary.')}

ENTITY: {entity_label}
Description: {entity_description or '(none)'}
Aliases: {aliases_str}
Case-specific note: {case_description or '(none)'}{connections_block}{events_context}{extra_guidance}

Use web search to find 4–10 events where {entity_label} was personally involved. Prefer events that illuminate the listed connections above, but also include independent milestones (education, marriage, career moves, major legal/financial/public events).

Dates:
- Confirmed precise dates: return as YYYY-MM-DD or YYYY-MM.
- Year-only confirmed: return as YYYY.
- Approximate/inferred (e.g. "early 2010s", "circa 2005"): return best-guess YYYY and prefix the description with "(approx.)".
- Never invent precision you don't have.

After your narrative response, you MUST include a structured section at the very end formatted EXACTLY like this:

---EVENTS---
[
  {{"title": "Event title", "date": "YYYY-MM-DD or YYYY-MM or YYYY or null", "description": "Brief description", "category": "property|epstein-link|regulatory|political|corporate|financial|legal|crime|general"}}
]
---END---

Guidelines:
- Keep descriptions concise (1-2 sentences).
- Do NOT repeat events already on the timeline.
- Cite sources via web search grounding (handled automatically).
- Think like an investigative journalist."""

        default_query = f"Build a timeline of significant events in {entity_label}'s life, especially those relevant to the case and the connections listed."
        user_query = request.query or default_query

        contents = [system_prompt]
        for msg in request.messages:
            contents.append(f"{'Researcher' if msg['role'] == 'user' else 'Assistant'}: {msg['content']}")
        contents.append(f"Researcher: {user_query}")

        config = types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())]
        )

        res = generate(
            client,
            model="gemini-2.0-flash",
            contents="\n\n".join(contents),
            config=config,
        )

        log_usage(user, "/api/cases/timeline/generate-track", "gemini-2.0-flash", res.usage_metadata)

        # Extract web sources (may be absent when Groq fallback is used)
        web_sources = []
        candidates = getattr(res, 'candidates', None)
        if candidates and len(candidates) > 0:
            gm = getattr(candidates[0], 'grounding_metadata', None)
            if gm and getattr(gm, 'grounding_chunks', None):
                import urllib.parse
                for gc in gm.grounding_chunks:
                    if gc.web:
                        uri = gc.web.uri or ""
                        if uri:
                            domain = urllib.parse.urlparse(uri).netloc.removeprefix('www.')
                            web_sources.append({
                                "title": gc.web.title or "",
                                "uri": uri,
                                "domain": domain,
                            })

        # Parse structured events
        full_text = res.text or ""
        events = []
        narrative = full_text
        if "---EVENTS---" in full_text and "---END---" in full_text:
            parts = full_text.split("---EVENTS---")
            narrative = parts[0].strip()
            events_json = parts[1].split("---END---")[0].strip()
            try:
                events = json.loads(events_json)
            except json.JSONDecodeError:
                try:
                    cleaned = events_json.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
                    events = json.loads(cleaned)
                except json.JSONDecodeError:
                    pass

        return {
            "narrative": narrative,
            "events": events,
            "web_sources": web_sources,
            "entity_label": entity_label,
            "entity_node_id": request.entity_node_id,
        }
    except Exception as e:
        print(f"Generate track failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/chat")
async def timeline_chat(case_id: str, request: TimelineChatRequest, user = Depends(require_paid)):
    """AI chat about the case timeline — has full context of events, tracks, and connections, plus web search."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=False)

        # Load case metadata
        case_res = supabase.table("cases").select("title, summary, category").eq("id", case_id).execute()
        case_data = case_res.data[0] if case_res.data else {}

        # Load all timeline events (include id for edge lookup)
        events_res = supabase.table("case_timeline_events").select("id, title, description, event_date, category").eq("case_id", case_id).execute()
        events = sorted(events_res.data or [], key=lambda e: e.get("event_date") or "9999")

        event_lines = []
        for e in events:
            date_str = e.get("event_date") or "undated"
            cat = e.get("category") or "general"
            desc = (e.get("description") or "")[:300]
            line = f"- [{date_str}] ({cat}) {e['title']}"
            if desc:
                line += f": {desc}"
            event_lines.append(line)

        # Load timeline tracks (entity-based lanes)
        track_lines = []
        try:
            tracks_res = supabase.table("case_timeline_tracks").select("id, label, entity_node_id, color").eq("case_id", case_id).execute()
            tracks = tracks_res.data or []
            # Count events per track via junction table
            track_event_counts: Dict[str, int] = {}
            if tracks:
                junc_res = supabase.table("case_timeline_event_tracks").select("track_id").in_("track_id", [t["id"] for t in tracks]).execute()
                for j in (junc_res.data or []):
                    track_event_counts[j["track_id"]] = track_event_counts.get(j["track_id"], 0) + 1
            for t in tracks:
                count = track_event_counts.get(t["id"], 0)
                track_lines.append(f"- {t['label']} ({count} events)")
        except Exception:
            pass

        # Load timeline edges (connections between events)
        edge_lines = []
        try:
            edges_res = supabase.table("case_timeline_edges").select("source_event_id, target_event_id, label").eq("case_id", case_id).execute()
            edge_data = edges_res.data or []
            event_titles = {e["id"]: e["title"] for e in events}
            for ed in edge_data:
                src = event_titles.get(ed["source_event_id"], ed["source_event_id"][:8])
                tgt = event_titles.get(ed["target_event_id"], ed["target_event_id"][:8])
                lbl = ed.get("label") or "related"
                edge_lines.append(f"- {src} → {lbl} → {tgt}")
        except Exception:
            pass

        system_context = f"""You are a seasoned investigative journalist and timeline analyst with decades of experience uncovering patterns in criminal cases — following the money, identifying when key players met, and spotting gaps in official narratives. You're having a conversation with a researcher about their case timeline.

CASE: {case_data.get('title', 'Untitled')}
CATEGORY: {case_data.get('category', 'Unknown')}
SUMMARY: {case_data.get('summary', 'No summary.')}

TIMELINE EVENTS ({len(event_lines)}):
{chr(10).join(event_lines[:60]) if event_lines else "No events yet."}

{"TRACKS (entity lanes):" + chr(10) + chr(10).join(track_lines) if track_lines else ""}

{"EVENT CONNECTIONS:" + chr(10) + chr(10).join(edge_lines[:30]) if edge_lines else ""}

Use web search to supplement your knowledge. Help the researcher analyze their timeline — identify patterns, suspicious timing, gaps in the record, correlations between events, and suggest new leads or events they may be missing. Be specific, cite dates and event names, and think like an investigative journalist. Keep responses concise and actionable."""

        contents = [system_context]
        for msg in request.messages:
            contents.append(f"{'Researcher' if msg['role'] == 'user' else 'Journalist'}: {msg['content']}")

        config = types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())]
        )

        res = generate(
            client,
            model="gemini-2.0-flash",
            contents="\n\n".join(contents),
            config=config,
        )

        log_usage(user, "/api/cases/timeline/chat", "gemini-2.0-flash", res.usage_metadata)

        # Extract web sources (may be absent when Groq fallback is used)
        web_sources = []
        candidates = getattr(res, 'candidates', None)
        if candidates and len(candidates) > 0:
            gm = getattr(candidates[0], 'grounding_metadata', None)
            if gm and getattr(gm, 'grounding_chunks', None):
                import urllib.parse
                for gc in gm.grounding_chunks:
                    if gc.web:
                        uri = gc.web.uri or ""
                        if uri:
                            domain = urllib.parse.urlparse(uri).netloc.removeprefix('www.')
                            web_sources.append({
                                "title": gc.web.title or "",
                                "uri": uri,
                                "domain": domain,
                            })

        return {"response": res.text, "web_sources": web_sources}
    except Exception as e:
        print(f"Timeline chat failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/graph/research")
async def graph_research(case_id: str, request: GraphResearchRequest, user = Depends(require_paid)):
    """AI-powered research for the network graph — suggests entities to add based on web search."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        # Load case context
        case_res = supabase.table("cases").select("title, summary, category").eq("id", case_id).execute()
        case_data = case_res.data[0] if case_res.data else {}

        # Load existing graph nodes (pinned global + custom)
        pinned = supabase.table("case_graph_entities").select("node_id").eq("case_id", case_id).execute()
        node_ids = [r["node_id"] for r in (pinned.data or [])]

        custom_res = supabase.table("case_graph_custom_nodes").select("id, label, type").eq("case_id", case_id).execute()
        custom_nodes = custom_res.data or []

        entity_lines = []
        nodes_by_id = {}
        if node_ids:
            nodes_res = supabase.table("nodes").select("id, label, type").in_("id", node_ids).execute()
            for n in (nodes_res.data or []):
                nodes_by_id[n["id"]] = n
                entity_lines.append(f"- {n.get('label', n['id'])} ({n.get('type', '?')})")
        for cn in custom_nodes:
            nodes_by_id[cn["id"]] = cn
            entity_lines.append(f"- {cn.get('label', 'Untitled')} ({cn.get('type', '?')})")

        # Load groups with member labels
        groups_res = supabase.table("case_graph_groups").select("label, node_ids").eq("case_id", case_id).execute()
        group_lines = []
        for g in (groups_res.data or []):
            members = [nodes_by_id.get(nid, {}).get("label", nid) for nid in (g.get("node_ids") or [])]
            group_label = g.get("label") or "Unnamed group"
            group_lines.append(f"- {group_label}: {', '.join(members)}")

        entities_context = ""
        if entity_lines:
            entities_context = f"\n\nEXISTING ENTITIES ON THE GRAPH ({len(entity_lines)}):\n" + "\n".join(entity_lines[:50])

        groups_context = ""
        if group_lines:
            groups_context = f"\n\nGRAPH GROUPS (thematic clusters in the investigation):\n" + "\n".join(group_lines)

        system_prompt = f"""You are an expert criminal investigator and intelligence analyst working on a research platform dedicated to organizing and mapping information from criminal case files — including court documents, witness depositions, financial records, flight logs, and public reporting. Investigators use this platform to build network graphs that visualize relationships between people, organizations, locations, and financial entities involved in criminal cases.

Your role is to help expand the investigator's network graph by researching their query using web search and suggesting NEW entities that are relevant to their case. The investigator has already begun mapping key figures and has organized them into thematic groups. Your suggestions should help them uncover the full picture — intermediaries who facilitated activity, co-conspirators, victims, witnesses, legal representatives, financial vehicles used to move money, properties and locations tied to key events, government agencies and regulatory bodies involved, and any other entities that connect to the existing network.

CASE: {case_data.get('title', 'Untitled')}
CATEGORY: {case_data.get('category', 'Unknown')}
SUMMARY: {case_data.get('summary', 'No summary.')}{entities_context}{groups_context}

IMPORTANT: After your narrative response, you MUST include a structured section at the very end formatted EXACTLY like this:

---ENTITIES---
[
  {{"name": "Entity name", "type": "PERSON|ORGANIZATION|LOCATION|EVENT|DOCUMENT|FINANCIAL_ENTITY", "description": "Brief description of who/what this is and their relevance to the case", "suggested_group": "Exact group label or null"}}
]
---END---

Guidelines:
- Search the web thoroughly for accurate, sourced information — prioritize court records, DOJ filings, investigative journalism, and public records over speculation
- Suggest 2-8 entities per response depending on the query
- Use the correct entity type: PERSON for individuals, ORGANIZATION for companies/agencies/nonprofits/law firms, LOCATION for properties/addresses/jurisdictions, FINANCIAL_ENTITY for funds/accounts/trusts/shell companies, EVENT for significant incidents/arrests/hearings, DOCUMENT for key legal filings/reports
- Do NOT suggest entities that are already on the graph
- For suggested_group: if an entity clearly fits one of the existing groups based on the group's label and members, use that group's exact label; otherwise use null
- Prioritize entities that bridge gaps in the existing network — people or organizations that connect existing groups to each other, or fill in missing links within a group
- When suggesting financial entities, include the jurisdiction or structure type when known (e.g. "Delaware LLC", "Virgin Islands trust")
- Keep descriptions concise (1-2 sentences) focusing on the entity's specific role or relevance to the case"""

        contents = [system_prompt]
        for msg in request.messages:
            contents.append(f"{'Researcher' if msg['role'] == 'user' else 'Assistant'}: {msg['content']}")
        contents.append(f"Researcher: {request.query}")

        config = types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())]
        )

        res = generate(
            client,
            model="gemini-2.0-flash",
            contents="\n\n".join(contents),
            config=config,
        )

        log_usage(user, "/api/cases/graph/research", "gemini-2.0-flash", res.usage_metadata)

        # Extract web sources from grounding metadata
        web_sources = []
        candidates = getattr(res, 'candidates', None)
        if candidates and len(candidates) > 0:
            gm = getattr(candidates[0], 'grounding_metadata', None)
            if gm and getattr(gm, 'grounding_chunks', None):
                import urllib.parse
                for gc in gm.grounding_chunks:
                    if gc.web:
                        uri = gc.web.uri or ""
                        if uri:
                            domain = urllib.parse.urlparse(uri).netloc.removeprefix('www.')
                            web_sources.append({
                                "title": gc.web.title or "",
                                "uri": uri,
                                "domain": domain,
                            })

        # Parse structured entities from response
        full_text = res.text or ""
        entities = []
        narrative = full_text

        if "---ENTITIES---" in full_text and "---END---" in full_text:
            parts = full_text.split("---ENTITIES---")
            narrative = parts[0].strip()
            entities_json = parts[1].split("---END---")[0].strip()
            try:
                entities = json.loads(entities_json)
            except json.JSONDecodeError:
                try:
                    cleaned = entities_json.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
                    entities = json.loads(cleaned)
                except json.JSONDecodeError:
                    pass

        return {
            "narrative": narrative,
            "entities": entities,
            "web_sources": web_sources,
        }
    except Exception as e:
        print(f"Graph research failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/graph/deduplicate")
async def deduplicate_graph(user = Depends(require_admin)):
    """Two-pass entity deduplication: heuristic merge then Gemini fuzzy merge."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase client not initialized."})

    try:
        # Load raw nodes and edges from Supabase
        raw_nodes = graph_store._fetch_all("nodes")
        raw_edges = graph_store._fetch_all("edges")

        if not raw_nodes:
            return {"merged": 0, "removed_nodes": 0, "removed_edges": 0, **graph_store.load()}

        # --- Pass 1: Heuristic merge by (normalized_label, type) ---
        def normalize(s):
            return re.sub(r'[^a-z0-9\s]', '', s.lower()).strip()

        groups = defaultdict(list)
        for n in raw_nodes:
            key = (normalize(n.get("label", n["id"])), (n.get("type") or "UNKNOWN").upper())
            groups[key].append(n)

        merged_entities = {}  # canonical_id -> node dict
        id_remap = {}         # old_id -> canonical_id

        for (_norm_label, _etype), group in groups.items():
            group.sort(key=lambda e: len(e.get("description", "") or ""), reverse=True)
            canonical = group[0]

            all_aliases = set()
            all_ids = set()
            for ent in group:
                all_aliases.add(ent.get("label", ent["id"]))
                all_aliases.update(ent.get("aliases") or [])
                all_ids.add(ent["id"])

            all_aliases.discard(canonical.get("label", canonical["id"]))
            canonical["aliases"] = sorted(all_aliases)

            for old_id in all_ids:
                id_remap[old_id] = canonical["id"]

            merged_entities[canonical["id"]] = canonical

        heuristic_removed = len(raw_nodes) - len(merged_entities)

        # --- Pass 2: Gemini fuzzy merge ---
        gemini_merges = 0
        if client and len(merged_entities) > 10:
            entity_list = []
            for ent in merged_entities.values():
                aliases_str = ", ".join((ent.get("aliases") or [])[:5])
                entity_list.append(
                    f"{ent['id']} | {ent.get('label', ent['id'])} | {ent.get('type', 'UNKNOWN')} | aliases: {aliases_str}"
                )

            batch_size = 500
            all_merge_groups = []

            for i in range(0, len(entity_list), batch_size):
                batch = entity_list[i:i + batch_size]
                batch_text = "\n".join(batch)

                merge_prompt = (
                    "You are deduplicating a knowledge graph. Below is a list of entities "
                    "(id | label | type | aliases).\n"
                    "Identify groups of entities that refer to the SAME real-world entity "
                    "and should be merged.\n"
                    "Only group entities that are clearly the same (e.g., 'FBI' and "
                    "'Federal Bureau of Investigation', 'Les Wexner' and 'Leslie Wexner').\n"
                    "Do NOT merge entities that are merely related.\n\n"
                    f"ENTITIES:\n{batch_text}\n\n"
                    "Return a JSON array of merge groups. Each group is an array of entity "
                    "IDs to merge.\n"
                    "Example: [[\"id_1\", \"id_2\"], [\"id_3\", \"id_4\", \"id_5\"]]\n"
                    "If no merges needed, return an empty array: []"
                )

                try:
                    res = generate(
                        client,
                        model="gemini-2.0-flash",
                        contents=merge_prompt,
                        config=types.GenerateContentConfig(
                            response_mime_type="application/json",
                        )
                    )
                    # Note: deduplicate_graph doesn't have 'user' yet, I'll add it to the signature in next step
                    log_usage(user, "/api/graph/deduplicate", "gemini-2.0-flash", res.usage_metadata)
                    merge_groups = json.loads(res.text)
                    if isinstance(merge_groups, list):
                        all_merge_groups.extend(merge_groups)
                except Exception as e:
                    print(f"Dedup Gemini batch {i // batch_size + 1} failed: {e}")

            for group in all_merge_groups:
                if not isinstance(group, list) or len(group) < 2:
                    continue
                valid_ids = [eid for eid in group if eid in merged_entities]
                if len(valid_ids) < 2:
                    continue

                valid_ids.sort(
                    key=lambda eid: len(merged_entities[eid].get("description", "") or ""),
                    reverse=True,
                )
                canonical_id = valid_ids[0]
                canonical = merged_entities[canonical_id]

                for other_id in valid_ids[1:]:
                    other = merged_entities.pop(other_id)

                    aliases = set(canonical.get("aliases") or [])
                    aliases.add(other.get("label", other["id"]))
                    aliases.update(other.get("aliases") or [])
                    aliases.discard(canonical.get("label", canonical["id"]))
                    canonical["aliases"] = sorted(aliases)

                    if len(other.get("description", "") or "") > len(canonical.get("description", "") or ""):
                        canonical["description"] = other["description"]

                    for k, v in list(id_remap.items()):
                        if v == other_id:
                            id_remap[k] = canonical_id
                    id_remap[other_id] = canonical_id
                    gemini_merges += 1

        # Collect IDs that need remapping (old_id != canonical_id)
        remap_pairs = [(old, new) for old, new in id_remap.items() if old != new]
        duplicate_ids = [old for old, _ in remap_pairs]

        if not duplicate_ids:
            return {"merged": 0, "removed_nodes": 0, "removed_edges": 0, **graph_store.load()}

        # --- Edge rewiring in Supabase (before deleting nodes due to FK) ---
        CHUNK = 100
        for i in range(0, len(remap_pairs), CHUNK):
            chunk = remap_pairs[i:i + CHUNK]
            for old_id, canonical_id in chunk:
                supabase.table("edges").update({"source": canonical_id}).eq("source", old_id).execute()
                supabase.table("edges").update({"target": canonical_id}).eq("target", old_id).execute()

        # Delete self-loop edges
        self_loops = supabase.table("edges").select("id, source, target").execute()
        self_loop_ids = [e["id"] for e in (self_loops.data or []) if e["source"] == e["target"]]
        for i in range(0, len(self_loop_ids), CHUNK):
            chunk = self_loop_ids[i:i + CHUNK]
            supabase.table("edges").delete().in_("id", chunk).execute()

        # Delete duplicate edges (same source+predicate+target, keep first)
        all_edges_now = graph_store._fetch_all("edges")
        seen_edge_keys = {}
        dup_edge_ids = []
        for e in all_edges_now:
            key = (e["source"], e["predicate"], e["target"])
            if key in seen_edge_keys:
                dup_edge_ids.append(e["id"])
            else:
                seen_edge_keys[key] = e["id"]
        for i in range(0, len(dup_edge_ids), CHUNK):
            chunk = dup_edge_ids[i:i + CHUNK]
            supabase.table("edges").delete().in_("id", chunk).execute()

        removed_edges = len(self_loop_ids) + len(dup_edge_ids)

        # --- Node cleanup: upsert canonical nodes, delete duplicates ---
        canonical_records = []
        for ent in merged_entities.values():
            canonical_records.append({
                "id": ent["id"],
                "label": ent.get("label", ent["id"]),
                "type": ent.get("type", "UNKNOWN"),
                "description": ent.get("description", ""),
                "aliases": ent.get("aliases", []),
            })
        for i in range(0, len(canonical_records), CHUNK):
            chunk = canonical_records[i:i + CHUNK]
            supabase.table("nodes").upsert(chunk, on_conflict="id").execute()

        for i in range(0, len(duplicate_ids), CHUNK):
            chunk = duplicate_ids[i:i + CHUNK]
            supabase.table("edges").delete().in_("source", chunk).execute()
            supabase.table("edges").delete().in_("target", chunk).execute()
            supabase.table("nodes").delete().in_("id", chunk).execute()

        merge_count = heuristic_removed + gemini_merges
        print(f"Dedup complete: {merge_count} merges, {len(duplicate_ids)} nodes removed, {removed_edges} edges cleaned")

        return {
            "merged": merge_count,
            "removed_nodes": len(duplicate_ids),
            "removed_edges": removed_edges,
            **graph_store.load()
        }
    except Exception as e:
        print(f"Deduplication failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": f"Deduplication failed: {str(e)}"})


# ---------------------------------------------------------------------------
# Agent endpoints — Mission Control
# ---------------------------------------------------------------------------

@app.get("/api/agent/status")
async def get_agent_status(user=Depends(optional_user)):
    """Get current agent status (running state, stats, current task)."""
    status = supabase.table("agent_status").select("*").eq("id", 1).execute()
    if not status.data:
        return {"is_running": False, "tasks_completed": 0, "theories_tested": 0,
                "entities_added": 0, "cases_created": 0}

    row = status.data[0]

    # Get current task info if running
    current_task = None
    if row.get("current_task_id"):
        task_res = supabase.table("agent_tasks").select("*").eq("id", row["current_task_id"]).execute()
        if task_res.data:
            current_task = task_res.data[0]

    # Queue stats
    queued = supabase.table("agent_tasks").select("id", count="exact").eq("status", "queued").execute()
    completed = supabase.table("agent_tasks").select("id", count="exact").eq("status", "completed").execute()
    failed = supabase.table("agent_tasks").select("id", count="exact").eq("status", "failed").execute()

    return {
        **row,
        "current_task": current_task,
        "queue_stats": {
            "queued": queued.count or 0,
            "completed": completed.count or 0,
            "failed": failed.count or 0,
        },
    }


@app.get("/api/agent/activity")
async def get_agent_activity(user=Depends(optional_user), limit: int = 50, offset: int = 0):
    """Get agent activity feed for mission control."""
    res = (
        supabase.table("agent_activity")
        .select("*")
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    total = supabase.table("agent_activity").select("id", count="exact").execute()
    return {"items": res.data or [], "total": total.count or 0}


@app.get("/api/agent/queue")
async def get_agent_queue(user=Depends(optional_user), status: str = "queued", limit: int = 50):
    """Get agent task queue."""
    query = supabase.table("agent_tasks").select("*").eq("status", status)
    if status == "queued":
        query = query.order("priority", desc=False).order("created_at", desc=False)
    else:
        query = query.order("completed_at", desc=True)
    res = query.limit(limit).execute()
    return {"items": res.data or []}


@app.post("/api/agent/directive")
async def submit_agent_directive(request: Request, user=Depends(optional_user)):
    """Submit a user directive to the agent's priority queue."""
    body = await request.json()
    directive = body.get("directive", "").strip()
    if not directive:
        return JSONResponse(status_code=400, content={"error": "directive is required"})

    # Tag user directives as "deep" research_depth so strategies pick the
    # PRIMARY_MODEL, enable web search, and run one follow-up round. Depth is
    # encoded as a `[depth=X] ` prefix on the description — no schema change.
    task = {
        "type": "user_directive",
        "description": f"[depth=deep] {directive}",
        "priority": 1,  # highest priority
        "status": "queued",
    }
    res = supabase.table("agent_tasks").insert(task).execute()

    # Log it
    supabase.table("agent_activity").insert({
        "action": "user_directive",
        "description": f"User directive: {directive[:200]}",
        "metadata": {"user_id": user.id if user else None},
    }).execute()

    return {"task": res.data[0] if res.data else task}


def _fetch_all_case_ids(table: str, chunk: int = 1000) -> list[str]:
    """Fetch case_id column from a table with pagination (handles >1000 rows)."""
    out: list[str] = []
    offset = 0
    while True:
        resp = (
            supabase.table(table)
            .select("case_id")
            .range(offset, offset + chunk - 1)
            .execute()
        )
        rows = resp.data or []
        out.extend(r["case_id"] for r in rows if r.get("case_id"))
        if len(rows) < chunk:
            break
        offset += chunk
    return out


@app.get("/api/agent/cases/tree")
async def get_case_tree(user=Depends(optional_user)):
    """Get hierarchical case tree for mission control.

    Optimized: 4 queries total (cases + 3 count aggregations), regardless of case count.
    Previous implementation did 1 + N*3 queries, which timed out at scale.
    """
    from collections import Counter

    # 1 query: all cases
    cases = (
        supabase.table("cases")
        .select("id, title, category, status, summary, parent_case_id, depth, operational_question, created_at, updated_at")
        .order("created_at", desc=False)
        .execute()
    )
    all_cases = cases.data or []

    # 3 queries: case_id columns from related tables, count client-side
    ev_counts = Counter(_fetch_all_case_ids("case_evidence"))
    entity_counts = Counter(_fetch_all_case_ids("case_graph_entities"))
    timeline_counts = Counter(_fetch_all_case_ids("case_timeline_events"))

    for case in all_cases:
        cid = case["id"]
        case["evidence_count"] = ev_counts.get(cid, 0)
        case["entity_count"] = entity_counts.get(cid, 0)
        case["timeline_event_count"] = timeline_counts.get(cid, 0)

    return {"cases": all_cases, "_version": "tree-v2-batched"}


@app.get("/api/agent/findings")
async def get_recent_findings(user=Depends(optional_user), limit: int = 10):
    """Get recent notable findings (theory verdicts, high-significance discoveries)."""
    # Get recent theory tests
    theories = (
        supabase.table("agent_activity")
        .select("*")
        .eq("action", "tested_theory")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    # Get recent evidence additions
    evidence = (
        supabase.table("agent_activity")
        .select("*")
        .in_("action", ["explored_connection", "entity_deep_dive", "validated_entity"])
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return {
        "theories": theories.data or [],
        "discoveries": evidence.data or [],
    }


# ── Timeline Audit endpoints ──────────────────────────────────────────────────

def _extract_web_sources(res) -> list:
    """Pull grounding web sources from a Gemini response."""
    web_sources = []
    candidates = getattr(res, 'candidates', None)
    if candidates and len(candidates) > 0:
        gm = getattr(candidates[0], 'grounding_metadata', None)
        if gm and getattr(gm, 'grounding_chunks', None):
            import urllib.parse
            for gc in gm.grounding_chunks:
                if gc.web:
                    uri = gc.web.uri or ""
                    if uri:
                        domain = urllib.parse.urlparse(uri).netloc.removeprefix('www.')
                        web_sources.append({"title": gc.web.title or "", "uri": uri, "domain": domain})
    return web_sources


def _safe_text(res) -> str:
    """Safely extract text from a Gemini response, handling edge cases."""
    try:
        t = res.text
        return str(t) if t else ""
    except Exception:
        # Fallback: manually extract text from parts
        try:
            parts = []
            for candidate in (res.candidates or []):
                for part in (candidate.content.parts or []):
                    if hasattr(part, 'text') and isinstance(part.text, str):
                        parts.append(part.text)
            return "\n".join(parts)
        except Exception:
            return ""


@app.post("/api/cases/{case_id}/timeline/audit")
async def timeline_audit(case_id: str, request: AuditRunRequest = AuditRunRequest(), user = Depends(require_paid)):
    """Run AI audit on timeline events: categorize, find dates, detect duplicates, find sources."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    if not client:
        return JSONResponse(status_code=503, content={"error": "GenAI client not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        # Load case context
        case_res = supabase.table("cases").select("title, summary, category").eq("id", case_id).execute()
        case_data = case_res.data[0] if case_res.data else {}

        # Load all events
        events_res = supabase.table("case_timeline_events").select("*").eq("case_id", case_id).execute()
        all_events = events_res.data or []

        if not all_events:
            return {"auto_applied": {"categories": 0, "sources": 0}, "suggestions": [], "duplicate_groups": []}

        # Clear any previous pending suggestions for this case
        supabase.table("case_timeline_audit_suggestions").delete().eq("case_id", case_id).eq("status", "pending").execute()

        auto_applied_categories = 0
        auto_applied_sources = 0
        suggestions = []
        duplicate_groups = []

        case_context = f"Case: {case_data.get('title', 'Untitled')} — {case_data.get('category', 'Unknown')}\nSummary: {case_data.get('summary', 'No summary.')}"

        # ─── Step 1: Categorize uncategorized events ───────────────────────
        uncategorized = [e for e in all_events if (e.get("category") or "general") == "general"]
        if uncategorized and "categorize" in request.checks:
            event_list = json.dumps([{"id": e["id"], "title": e["title"], "description": (e.get("description") or "")[:200], "event_date": e.get("event_date")} for e in uncategorized], indent=2)
            cat_prompt = f"""You are an investigative researcher categorizing timeline events.

{case_context}

AVAILABLE CATEGORIES:
- property: Real estate transactions, property records, building permits
- epstein-link: Connections to Jeffrey Epstein or associates
- regulatory: Government oversight, regulatory actions, inspections
- political: Political activities, campaigns, government positions
- corporate: Business dealings, corporate filings, mergers
- financial: Financial transactions, investments, banking
- legal: Court cases, lawsuits, legal filings, depositions
- crime: Criminal activity, arrests, indictments, convictions
- general: Only if none of the above fit at all

EVENTS TO CATEGORIZE:
{event_list}

For each event, determine the most appropriate category based on the title and description.
Return a JSON array:
[{{"id": "event-uuid", "category": "legal", "confidence": 0.95, "rationale": "Event describes a court filing..."}}]

Be specific. Choose the most fitting category — avoid "general" unless nothing else applies."""

            try:
                res = generate(
                    client,
                    model="gemini-2.0-flash",
                    contents=cat_prompt,
                    config=types.GenerateContentConfig(response_mime_type="application/json"),
                )
                log_usage(user, "/api/cases/timeline/audit/categorize", "gemini-2.0-flash", res.usage_metadata)
                cat_results = json.loads(_safe_text(res))

                for cr in cat_results:
                    if not isinstance(cr, dict) or "id" not in cr:
                        continue
                    conf = cr.get("confidence", 0)
                    cat = cr.get("category", "general")
                    if cat == "general":
                        continue

                    if conf >= 0.9:
                        # Auto-apply high-confidence
                        supabase.table("case_timeline_events").update({"category": cat}).eq("id", cr["id"]).eq("case_id", case_id).execute()
                        auto_applied_categories += 1
                        supabase.table("case_timeline_audit_suggestions").insert({
                            "case_id": case_id, "event_id": cr["id"],
                            "suggestion_type": "missing_category",
                            "current_value": json.dumps("general"),
                            "suggested_value": json.dumps(cat),
                            "confidence": conf,
                            "ai_rationale": cr.get("rationale", ""),
                            "status": "auto_applied",
                        }).execute()
                    else:
                        # Queue for review
                        result = supabase.table("case_timeline_audit_suggestions").insert({
                            "case_id": case_id, "event_id": cr["id"],
                            "suggestion_type": "missing_category",
                            "current_value": json.dumps("general"),
                            "suggested_value": json.dumps(cat),
                            "confidence": conf,
                            "ai_rationale": cr.get("rationale", ""),
                            "status": "pending",
                        }).execute()
                        ev = next((e for e in all_events if e["id"] == cr["id"]), None)
                        if result.data and ev:
                            suggestions.append({
                                "id": result.data[0]["id"],
                                "event_id": cr["id"],
                                "suggestion_type": "missing_category",
                                "event_title": ev["title"],
                                "current_value": "general",
                                "suggested_value": cat,
                                "confidence": conf,
                                "ai_rationale": cr.get("rationale", ""),
                            })
            except Exception as e:
                print(f"Audit categorize step failed: {e}")

        # ─── Step 2: Find missing dates ────────────────────────────────────
        # NOTE: Cannot combine response_mime_type with google_search tools.
        # Use marker-based JSON extraction like the research endpoint.
        undated = [e for e in all_events if not e.get("event_date")]
        if undated and "dates" in request.checks:
            BATCH_SIZE = 15
            for i in range(0, len(undated), BATCH_SIZE):
                batch = undated[i:i + BATCH_SIZE]
                event_list = "\n".join(
                    f"- [{e['id']}] {e['title']}: {(e.get('description') or '')[:200]}"
                    for e in batch
                )
                date_prompt = f"""You are an investigative researcher. Use web search to find accurate dates for timeline events that are currently missing dates.

{case_context}

EVENTS MISSING DATES:
{event_list}

Search the web for each event. After your research notes, you MUST include a structured section at the very end formatted EXACTLY like this:

---DATES---
[
  {{"id": "event-uuid", "date": "YYYY-MM-DD or YYYY-MM or YYYY", "confidence": 0.8, "rationale": "Found court record dated March 12, 2015..."}}
]
---END---

Guidelines:
- Use YYYY-MM-DD when an exact date is confirmed.
- Use YYYY-MM or YYYY for partial dates.
- Set confidence based on source reliability (court records = high, news articles = medium, inference = low).
- Only include events where you found a date. Skip the rest.
- Never invent dates — only report what you can verify."""

                try:
                    res = generate(
                        client,
                        model="gemini-2.0-flash",
                        contents=date_prompt,
                        config=types.GenerateContentConfig(
                            tools=[types.Tool(google_search=types.GoogleSearch())],
                        ),
                    )
                    log_usage(user, "/api/cases/timeline/audit/dates", "gemini-2.0-flash", res.usage_metadata)
                    web_sources = _extract_web_sources(res)

                    # Parse structured dates from markers
                    full_text = _safe_text(res)
                    date_results = []
                    if "---DATES---" in full_text and "---END---" in full_text:
                        dates_json = full_text.split("---DATES---")[1].split("---END---")[0].strip()
                        try:
                            date_results = json.loads(dates_json)
                        except json.JSONDecodeError:
                            cleaned = dates_json.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
                            try:
                                date_results = json.loads(cleaned)
                            except json.JSONDecodeError:
                                pass

                    for dr in date_results:
                        if not isinstance(dr, dict) or "id" not in dr or not dr.get("date"):
                            continue
                        result = supabase.table("case_timeline_audit_suggestions").insert({
                            "case_id": case_id, "event_id": dr["id"],
                            "suggestion_type": "missing_date",
                            "current_value": None,
                            "suggested_value": json.dumps(dr["date"]),
                            "confidence": dr.get("confidence", 0.5),
                            "ai_rationale": dr.get("rationale", ""),
                            "status": "pending",
                            "web_sources": web_sources,
                        }).execute()
                        ev = next((e for e in all_events if e["id"] == dr["id"]), None)
                        if result.data and ev:
                            suggestions.append({
                                "id": result.data[0]["id"],
                                "event_id": dr["id"],
                                "suggestion_type": "missing_date",
                                "event_title": ev["title"],
                                "current_value": None,
                                "suggested_value": dr["date"],
                                "confidence": dr.get("confidence", 0.5),
                                "ai_rationale": dr.get("rationale", ""),
                                "web_sources": web_sources,
                            })
                except Exception as e:
                    print(f"Audit date batch {i // BATCH_SIZE + 1} failed: {e}")
                    import traceback; traceback.print_exc()

        # ─── Step 3: Detect duplicates ─────────────────────────────────────
        if len(all_events) >= 2 and "duplicates" in request.checks:
            event_summary = json.dumps([{
                "id": e["id"],
                "title": e["title"],
                "date": e.get("event_date"),
                "description": (e.get("description") or "")[:150],
                "category": e.get("category", "general"),
            } for e in all_events], indent=2)

            dedup_prompt = f"""You are deduplicating timeline events for an investigation. Below is a list of events. Identify ONLY events that are true duplicates — the exact same real-world occurrence described with different wording.

{case_context}

EVENTS:
{event_summary}

STRICT RULES — read carefully:
1. A duplicate means the EXACT SAME singular occurrence: same specific date, same specific actors, same specific action/outcome. Two events are duplicates ONLY if a historian would say "these are two records of one thing that happened once."
2. Do NOT group events that are merely related, thematically similar, or part of the same topic/saga.
3. Do NOT group events from different years — "FII 2017" and "FII 2018" are separate annual events, not duplicates.
4. Do NOT group sequential events — an invitation, the event itself, and a follow-up are three separate events even if they concern the same subject.
5. Do NOT group different financial transactions just because they involve the same account or institution.
6. Do NOT group an arrest with unrelated transactions, legal actions, or biographical events.
7. Keep groups small — typically 2-3 events. If you have a group larger than 4, you are almost certainly being too loose.
8. When in doubt, do NOT merge. False negatives (missing a duplicate) are far less harmful than false positives (merging distinct events).

EXAMPLES OF TRUE DUPLICATES:
- "Haze Trust Transfer to Southern Financial LLC" (2019-02-07) and "Haze Trust Checking to Southern Financial LLC Checking" (2/7/2019) — same transfer, same date, same parties, same amount
- "Epstein found in SHU" (7/23/2019) and "Inmate Epstein found on floor" (7/23/2019) — same incident, same date

EXAMPLES OF NON-DUPLICATES (do NOT merge these):
- "FII event in Riyadh" (Oct 2017) and "FII event in Riyadh" (Oct 2018) — different years = different events
- "Invitation to FII" (June 2017) and "FII event in Riyadh" (Oct 2017) — invitation vs the event itself
- "Epstein Arrested" (July 2019) and "Wire transfer" (June 2018) — completely different events
- "Gratitude America Donations" (2016) and "Noam Chomsky Trust Distributions" (2015) — different entities, different transactions

For each group, pick the best event to keep as "target" — prefer the most specific title, longest description, and most precise date.

Return a JSON array of duplicate groups:
[{{"target_id": "best-event-uuid", "duplicate_ids": ["dup-uuid-1", "dup-uuid-2"], "rationale": "Both describe the same property transfer on 2015-03-12..."}}]

If no duplicates found, return an empty array: []"""

            try:
                res = generate(
                    client,
                    model="gemini-2.0-flash",
                    contents=dedup_prompt,
                    config=types.GenerateContentConfig(response_mime_type="application/json"),
                )
                log_usage(user, "/api/cases/timeline/audit/duplicates", "gemini-2.0-flash", res.usage_metadata)
                dedup_results = json.loads(_safe_text(res))

                for group in dedup_results:
                    if not isinstance(group, dict) or "target_id" not in group:
                        continue
                    dup_ids = group.get("duplicate_ids", [])
                    if not dup_ids:
                        continue
                    all_ids = [group["target_id"]] + dup_ids
                    result = supabase.table("case_timeline_audit_suggestions").insert({
                        "case_id": case_id,
                        "event_id": None,
                        "suggestion_type": "duplicate",
                        "current_value": None,
                        "suggested_value": None,
                        "confidence": group.get("confidence", 0.8),
                        "ai_rationale": group.get("rationale", ""),
                        "status": "pending",
                        "merge_target_id": group["target_id"],
                        "related_event_ids": all_ids,
                    }).execute()
                    if result.data:
                        events_in_group = [{"id": e["id"], "title": e["title"], "event_date": e.get("event_date"), "description": (e.get("description") or "")[:200]} for e in all_events if e["id"] in all_ids]
                        duplicate_groups.append({
                            "id": result.data[0]["id"],
                            "events": events_in_group,
                            "merge_target_id": group["target_id"],
                            "ai_rationale": group.get("rationale", ""),
                        })
            except Exception as e:
                print(f"Audit duplicate detection failed: {e}")

        # ─── Step 4: Find missing sources ──────────────────────────────────
        # Strategy: process events individually (or small batches) with Google Search
        # grounding, then extract REAL grounded URLs from grounding_metadata — not
        # LLM-hallucinated URLs. Cannot combine response_mime_type with google_search.
        unsourced = [e for e in all_events if not e.get("sources")]
        if unsourced and "sources" in request.checks:
            BATCH_SIZE = 10
            for i in range(0, len(unsourced), BATCH_SIZE):
                batch = unsourced[i:i + BATCH_SIZE]
                event_list = "\n".join(
                    f"- [{e['id']}] {e.get('event_date') or 'undated'} — {e['title']}: {(e.get('description') or '')[:150]}"
                    for e in batch
                )
                source_prompt = f"""You are an investigative researcher. Search the web to find authoritative sources for each of these timeline events.

{case_context}

EVENTS NEEDING SOURCES:
{event_list}

For each event, search the web and describe what sources you found. Reference the event by its ID in brackets like [event-uuid].
Focus on finding: court records, news articles, SEC filings, government documents, property records.
If you cannot find a source for an event, skip it."""

                try:
                    res = generate(
                        client,
                        model="gemini-2.0-flash",
                        contents=source_prompt,
                        config=types.GenerateContentConfig(
                            tools=[types.Tool(google_search=types.GoogleSearch())],
                        ),
                    )
                    log_usage(user, "/api/cases/timeline/audit/sources", "gemini-2.0-flash", res.usage_metadata)

                    # Extract REAL web sources from grounding metadata
                    web_sources = _extract_web_sources(res)

                    if web_sources:
                        # Assign grounded sources to all events in this batch
                        # The grounding sources cover the whole batch, so attach all to each event
                        # that was mentioned in the response
                        response_text = _safe_text(res)
                        for ev in batch:
                            # Check if this event's ID is referenced in the response
                            if ev["id"] in response_text or ev["title"][:30] in response_text:
                                supabase.table("case_timeline_events").update({"sources": web_sources}).eq("id", ev["id"]).eq("case_id", case_id).execute()
                                auto_applied_sources += 1
                                supabase.table("case_timeline_audit_suggestions").insert({
                                    "case_id": case_id, "event_id": ev["id"],
                                    "suggestion_type": "missing_source",
                                    "current_value": None,
                                    "suggested_value": json.dumps(web_sources),
                                    "confidence": 0.9,
                                    "ai_rationale": f"Found {len(web_sources)} grounded source(s) via web search",
                                    "status": "auto_applied",
                                    "web_sources": web_sources,
                                }).execute()
                except Exception as e:
                    print(f"Audit source batch {i // BATCH_SIZE + 1} failed: {e}")
                    import traceback; traceback.print_exc()

        return {
            "auto_applied": {"categories": auto_applied_categories, "sources": auto_applied_sources},
            "suggestions": suggestions,
            "duplicate_groups": duplicate_groups,
        }
    except Exception as e:
        print(f"Timeline audit failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/audit/apply")
async def timeline_audit_apply(case_id: str, request: AuditApplyRequest, user = Depends(require_paid)):
    """Apply accepted audit suggestions — updates events, merges duplicates."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        applied = 0
        for sid in request.suggestion_ids:
            sug_res = supabase.table("case_timeline_audit_suggestions").select("*").eq("id", sid).eq("case_id", case_id).execute()
            sug = sug_res.data[0] if sug_res.data else None
            if not sug or sug["status"] != "pending":
                continue

            stype = sug["suggestion_type"]

            if stype == "missing_date" and sug.get("event_id"):
                date_val = json.loads(sug["suggested_value"]) if sug.get("suggested_value") else None
                if date_val:
                    supabase.table("case_timeline_events").update({"event_date": date_val}).eq("id", sug["event_id"]).eq("case_id", case_id).execute()

            elif stype == "missing_category" and sug.get("event_id"):
                cat_val = json.loads(sug["suggested_value"]) if sug.get("suggested_value") else None
                if cat_val:
                    supabase.table("case_timeline_events").update({"category": cat_val}).eq("id", sug["event_id"]).eq("case_id", case_id).execute()

            elif stype == "duplicate":
                target_id = sug.get("merge_target_id")
                related = sug.get("related_event_ids") or []
                # Filter out any events the user excluded from this merge
                excluded_ids = set((request.exclusions or {}).get(sid, []))
                losers = [eid for eid in related if eid != target_id and eid not in excluded_ids]

                if target_id and losers:
                    # Load target to merge descriptions
                    target_res = supabase.table("case_timeline_events").select("*").eq("id", target_id).execute()
                    target_ev = target_res.data[0] if target_res.data else None

                    if target_ev:
                        # Merge: keep longest description, union sources
                        best_desc = target_ev.get("description") or ""
                        merged_sources = list(target_ev.get("sources") or [])

                        for lid in losers:
                            loser_res = supabase.table("case_timeline_events").select("*").eq("id", lid).execute()
                            loser_ev = loser_res.data[0] if loser_res.data else None
                            if loser_ev:
                                if len(loser_ev.get("description") or "") > len(best_desc):
                                    best_desc = loser_ev["description"]
                                merged_sources.extend(loser_ev.get("sources") or [])
                                # If target has no date but loser does, take it
                                if not target_ev.get("event_date") and loser_ev.get("event_date"):
                                    supabase.table("case_timeline_events").update({"event_date": loser_ev["event_date"]}).eq("id", target_id).execute()

                        # Update target
                        update_data: Dict[str, Any] = {"description": best_desc}
                        if merged_sources:
                            # Deduplicate sources by URI
                            seen_uris: set = set()
                            unique_sources = []
                            for s in merged_sources:
                                uri = s.get("uri", "")
                                if uri and uri not in seen_uris:
                                    seen_uris.add(uri)
                                    unique_sources.append(s)
                                elif not uri:
                                    unique_sources.append(s)
                            update_data["sources"] = unique_sources
                        supabase.table("case_timeline_events").update(update_data).eq("id", target_id).execute()

                        # Rewire edges from losers to target
                        for lid in losers:
                            supabase.table("case_timeline_edges").update({"source_event_id": target_id}).eq("source_event_id", lid).eq("case_id", case_id).execute()
                            supabase.table("case_timeline_edges").update({"target_event_id": target_id}).eq("target_event_id", lid).eq("case_id", case_id).execute()

                        # Rewire track associations
                        for lid in losers:
                            existing_tracks = supabase.table("case_timeline_event_tracks").select("track_id").eq("event_id", lid).execute()
                            target_tracks = supabase.table("case_timeline_event_tracks").select("track_id").eq("event_id", target_id).execute()
                            target_track_ids = {t["track_id"] for t in (target_tracks.data or [])}
                            for et in (existing_tracks.data or []):
                                if et["track_id"] not in target_track_ids:
                                    supabase.table("case_timeline_event_tracks").insert({"event_id": target_id, "track_id": et["track_id"]}).execute()
                            supabase.table("case_timeline_event_tracks").delete().eq("event_id", lid).execute()

                        # Delete loser events (edges cascade)
                        for lid in losers:
                            supabase.table("case_timeline_events").delete().eq("id", lid).eq("case_id", case_id).execute()

            # Mark accepted
            supabase.table("case_timeline_audit_suggestions").update({"status": "accepted"}).eq("id", sid).execute()
            applied += 1

        return {"applied": applied}
    except Exception as e:
        print(f"Audit apply failed: {e}")
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/cases/{case_id}/timeline/audit/dismiss")
async def timeline_audit_dismiss(case_id: str, request: AuditDismissRequest, user = Depends(require_paid)):
    """Dismiss (reject) audit suggestions."""
    if not supabase:
        return JSONResponse(status_code=503, content={"error": "Supabase not initialized."})
    try:
        await verify_case_ownership(case_id, user, write=True)

        dismissed = 0
        for sid in request.suggestion_ids:
            supabase.table("case_timeline_audit_suggestions").update({"status": "rejected"}).eq("id", sid).eq("case_id", case_id).execute()
            dismissed += 1

        return {"dismissed": dismissed}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

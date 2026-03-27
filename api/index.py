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
            return {"nodes": [], "edges": []}

        try:
            # Fetch nodes with degree filter applied server-side
            nodes_data = self._fetch_nodes_filtered(min_degree)
            node_ids = {n["id"] for n in nodes_data}

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

            return {"nodes": nodes, "edges": edges}
        except Exception as e:
            print(f"CRITICAL: Error loading graph from Supabase: {e}")
            import traceback; traceback.print_exc()
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

class UpdateCaseRequest(BaseModel):
    status: Optional[str] = None
    title: Optional[str] = None
    category: Optional[str] = None
    summary: Optional[str] = None
    is_public: Optional[bool] = None

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
async def get_graph():
    return graph_store.load()

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

    if write and not is_owner:
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

        evidence_res = supabase.table("case_evidence").select("*").eq("case_id", case_id).order("created_at", desc=True).execute()

        return {
            "case": case_res.data[0],
            "evidence": evidence_res.data or [],
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
                        all_sources = data.get("sources", [])
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
        if res.candidates and res.candidates[0].grounding_metadata:
            gm = res.candidates[0].grounding_metadata
            if gm.grounding_chunks:
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
        if res.candidates and res.candidates[0].grounding_metadata:
            gm = res.candidates[0].grounding_metadata
            if gm.grounding_chunks:
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

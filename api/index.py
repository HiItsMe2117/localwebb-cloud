import os
import json
import shutil
import tempfile
import uuid
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

class GraphStore:
    def __init__(self):
        self.blob = None
        if bucket:
            try:
                self.blob = bucket.blob("graph_store.json")
                if not self.blob.exists():
                    self.save({"nodes": [], "edges": []})
            except Exception as e:
                print(f"Error initializing GraphStore blob: {e}")

    def load(self):
        if not self.blob:
            return {"nodes": [], "edges": []}
        try:
            if self.blob.exists():
                return json.loads(self.blob.download_as_text())
        except Exception as e:
            print(f"Error loading graph: {e}")
        return {"nodes": [], "edges": []}

    def save(self, data):
        if not self.blob:
            return
        try:
            self.blob.upload_from_string(json.dumps(data, indent=2))
        except Exception as e:
            print(f"Error saving graph: {e}")

    def update_node_position(self, node_id, x, y):
        data = self.load()
        for node in data["nodes"]:
            if node["id"] == node_id:
                node["position"] = {"x": x, "y": y}
                break
        self.save(data)

    def add_elements(self, new_nodes, new_edges):
        data = self.load()
        existing_ids = {n["id"] for n in data["nodes"]}
        for node in new_nodes:
            if node["id"] not in existing_ids: data["nodes"].append(node)

        existing_edge_ids = {e["id"] for e in data["edges"] if "id" in e}
        for edge in new_edges:
            if edge.get("id") not in existing_edge_ids: data["edges"].append(edge)
        self.save(data)

graph_store = GraphStore()

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
    predicate: str           # "flew_with", "employed_by", "transferred_funds_to"
    object_id: str
    evidence_text: str       # exact quote from the document
    source_filename: str
    source_page: int = 0
    confidence: str = "STATED"  # STATED | INFERRED
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
async def get_insights():
    try:
        if not index:
            return {"error": "Pinecone index not initialized. Please check environment variables."}
        if not client:
            return {"error": "GenAI client not initialized. Please check environment variables."}

        print("DEBUG: Fetching sampling vectors from Pinecone using topic-based queries...")
        insight_topics = [
            "people persons individuals names",
            "organizations companies institutions",
            "locations places addresses travel",
            "financial transactions money payments",
            "events meetings dates timeline",
        ]

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
        for topic in insight_topics:
            try:
                topic_emb = client.models.embed_content(
                    model="gemini-embedding-001", contents=[topic]
                )
                topic_results = index.query(
                    vector=topic_emb.embeddings[0].values,
                    top_k=10,
                    include_metadata=True
                )
                for r in topic_results.matches:
                    if r.metadata and r.id not in all_chunks:
                        all_chunks[r.id] = extract_chunk_with_meta(r.metadata)
            except Exception as e:
                print(f"DEBUG: Topic query '{topic}' failed: {e}")

        print(f"DEBUG: Topic sampling collected {len(all_chunks)} unique chunks")

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

        new_edges = []
        for triple in output.triples:
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
            graph_store.save(graph_data)
            return graph_data

        return graph_store.load()
    except Exception as e:
        print(f"Insights failed: {e}")
        import traceback; traceback.print_exc()
        return graph_store.load()

def _build_query_context(request):
    """Shared logic: embed query, search Pinecone (with optional filters + reranking), build context + sources."""
    if not index:
        raise ValueError("Pinecone index not initialized. Please check environment variables.")
    if not client:
        raise ValueError("GenAI client not initialized. Please check environment variables.")

    top_k = max(1, min(request.top_k, 50))

    # 1. Embed query
    print(f"DEBUG: Embedding query (top_k={top_k})...")
    res = client.models.embed_content(
        model="gemini-embedding-001",
        contents=[request.query]
    )
    embedding = res.embeddings[0].values

    # 2. Build metadata filter for filtered queries
    pinecone_filter = {}
    if hasattr(request, 'doc_type') and request.doc_type:
        pinecone_filter["doc_type"] = {"$eq": request.doc_type}
    if hasattr(request, 'person_filter') and request.person_filter:
        pinecone_filter["people"] = {"$in": [request.person_filter]}
    if hasattr(request, 'org_filter') and request.org_filter:
        pinecone_filter["organizations"] = {"$in": [request.org_filter]}

    # 3. Over-fetch for reranking (40 if reranker available, else top_k)
    fetch_k = 40 if top_k <= 20 else top_k
    print("DEBUG: Querying Pinecone...")
    query_kwargs = dict(vector=embedding, top_k=fetch_k, include_metadata=True)
    if pinecone_filter:
        query_kwargs["filter"] = pinecone_filter
        print(f"DEBUG: Applying filter: {pinecone_filter}")
    results = index.query(**query_kwargs)

    # 4. Extract text + metadata from results
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
                # Legacy vectors without page numbers — show chunk index
                chunk_idx = r.metadata.get('chunk_index', '')
                page = f"Chunk {chunk_idx}" if chunk_idx != '' else ''
            candidates.append({
                "text": text, "filename": filename, "page": page,
                "score": r.score,
            })

    # 5. Cross-encoder reranking
    try:
        from api.reranker import rerank
    except ImportError:
        try:
            from reranker import rerank
        except ImportError:
            rerank = None
    try:
        if rerank and len(candidates) > top_k:
            print(f"DEBUG: Reranking {len(candidates)} candidates down to {min(top_k, 8)}...")
            candidates = rerank(request.query, candidates, top_n=min(top_k, 8))
    except Exception as e:
        print(f"DEBUG: Reranker unavailable, using Pinecone ordering: {e}")
        candidates = candidates[:top_k]

    # 6. Build context string and sources
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
        graph_store.save(graph_data)
        return graph_data
    except Exception as e:
        print(f"Community detection failed: {e}")
        return graph_store.load()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

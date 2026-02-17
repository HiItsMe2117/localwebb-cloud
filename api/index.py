import os
import json
import shutil
import tempfile
import uuid
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, BackgroundTasks, Request
from fastapi.responses import JSONResponse
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
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

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
        if PINECONE_API_KEY and PINECONE_INDEX_NAME:
            pc = Pinecone(api_key=PINECONE_API_KEY)
            return pc.Index(PINECONE_INDEX_NAME)
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
        
        existing_edges = {(e["source"], e["target"]) for e in data["edges"]}
        for edge in new_edges:
            if (edge["source"], edge["target"]) not in existing_edges: data["edges"].append(edge)
        self.save(data)

graph_store = GraphStore()

# --- Models ---
class QueryRequest(BaseModel):
    query: str

class PositionUpdate(BaseModel):
    id: str
    x: float
    y: float

class Entity(BaseModel):
    id: str
    label: str
    type: str
    description: str

class Connection(BaseModel):
    source_id: str
    target_id: str
    label: str

class CaseMap(BaseModel):
    entities: List[Entity]
    connections: List[Connection]

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

        print("DEBUG: Fetching sampling vectors from Pinecone...")
        # 1. Get sample data for extraction
        results = index.query(
            vector=[0.0] * 3072, 
            top_k=20, 
            include_metadata=True
        )
        print(f"DEBUG: Pinecone returned {len(results.matches)} matches for insights")
        context = "\n".join([r.metadata.get('text', '') for r in results.matches if r.metadata])
        
        if not context:
            print("DEBUG: No context found in metadata!")
            return graph_store.load()

        # 2. Structured Extraction with Gemini
        prompt = (
            "Extract entities (PERSON, ORGANIZATION, LOCATION, EVENT) and their connections from these investigative documents.\n"
            f"DOCUMENTS:\n{context}\n"
            "Return JSON with 'entities' and 'connections' keys."
        )
        
        print("DEBUG: Sending extraction prompt to Gemini...")
        res = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CaseMap
            )
        )
        
        output = res.parsed 
        print(f"DEBUG: Gemini extracted {len(output.entities)} entities")
        
        new_nodes = []
        type_colors = {
            "PERSON": "#1e40af", "ORGANIZATION": "#92400e", "LOCATION": "#065f46",
            "CASE_ID": "#991b1b", "EVENT": "#374151"
        }
        
        for ent in output.entities:
            ent_type = ent.type.upper()
            new_nodes.append({
                "id": ent.id,
                "data": {
                    "label": ent.label, 
                    "type": ent_type, 
                    "description": ent.description
                },
                "position": {"x": 100 + (len(new_nodes) * 20), "y": 100},
                "style": { "background": type_colors.get(ent_type, "#3f3f46"), "color": "white", "padding": "10px", "borderRadius": "5px" }
            })
            
        new_edges = []
        for conn in output.connections:
            new_edges.append({
                "id": f"e-{conn.source_id}-{conn.target_id}",
                "source": conn.source_id, "target": conn.target_id,
                "label": conn.label
            })
            
        graph_store.add_elements(new_nodes, new_edges)
        return graph_store.load()
    except Exception as e:
        print(f"Insights failed: {e}")
        return graph_store.load()

@app.post("/api/query")
async def query_index(request: QueryRequest):
    try:
        print(f"DEBUG: Starting query for: {request.query}")
        if not index:
            print("ERROR: Pinecone index not initialized")
            return {"response": "Error: Pinecone index not initialized. Please check environment variables."}
        if not client:
            print("ERROR: GenAI client not initialized")
            return {"response": "Error: GenAI client not initialized. Please check environment variables."}

        # 1. Embed query
        print("DEBUG: Embedding query...")
        res = client.models.embed_content(
            model="models/text-embedding-004",
            contents=[request.query]
        )
        embedding = res.embeddings[0].values

        # 2. Query Pinecone
        print("DEBUG: Querying Pinecone...")
        results = index.query(vector=embedding, top_k=2, include_metadata=True)
        
        context_parts = []
        for r in results.matches:
            if r.metadata and 'text' in r.metadata:
                context_parts.append(r.metadata['text'][:800])
        
        context = "\n\n".join(context_parts)
        if not context:
            print("DEBUG: No context found")
            return {"response": "No relevant info found in the database."}

        # 3. Generate response
        print("DEBUG: Generating Gemini response...")
        prompt = f"Context: {context}\n\nQuestion: {request.query}\n\nAnswer briefly based ONLY on the context."
        
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt
        )
        print("DEBUG: Query successful")
        return {"response": response.text}
    except Exception as e:
        print(f"CRITICAL ERROR in query_index: {str(e)}")
        return {"response": f"Analysis failed: {str(e)}"}

@app.post("/api/upload")
async def upload_file(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    temp_dir = tempfile.mkdtemp()
    file_path = os.path.join(temp_dir, file.filename)
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    background_tasks.add_task(process_upload, file_path, file.filename)
    return {"status": "Processing"}

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

        reader = PdfReader(file_path)
        text = ""
        for page in reader.pages:
            text += page.extract_text() + "\n"

        chunks = [text[i:i+2000] for i in range(0, len(text), 2000)]
        for i, chunk in enumerate(chunks):
            res = client.models.embed_content(model="text-embedding-004", contents=[chunk])
            index.upsert(vectors=[(
                f"{filename}-{i}", 
                res.embeddings[0].values, 
                {"text": chunk, "filename": filename, "gcs_path": f"gs://{GCS_BUCKET}/uploads/{filename}"}
            )])
    finally:
        shutil.rmtree(os.path.dirname(file_path), ignore_errors=True)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

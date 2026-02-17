import os
import json
import shutil
import tempfile
import uuid
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, BackgroundTasks
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

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Configuration ---
GCS_BUCKET = os.getenv("GCS_BUCKET_NAME")
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
storage_client = storage.Client()
bucket = storage_client.bucket(GCS_BUCKET)
pc = Pinecone(api_key=PINECONE_API_KEY)
index = pc.Index(PINECONE_INDEX_NAME)
client = genai.Client(api_key=GOOGLE_API_KEY)

class GraphStore:
    def __init__(self):
        self.blob = bucket.blob("graph_store.json")
        if not self.blob.exists():
            self.save({"nodes": [], "edges": []})

    def load(self):
        try:
            if self.blob.exists():
                return json.loads(self.blob.download_as_text())
        except Exception:
            pass
        return {"nodes": [], "edges": []}

    def save(self, data):
        try:
            self.blob.upload_from_string(json.dumps(data, indent=2))
        except Exception:
            pass

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
        # 1. Get sample data for extraction
        results = index.query(
            vector=[0.0] * 3072, # Zero vector for random-ish sampling or use a real query
            top_k=20, 
            include_metadata=True
        )
        context = "\n".join([r.metadata.get('text', '') for r in results.matches if r.metadata])

        # 2. Structured Extraction with Gemini
        prompt = (
            "Extract entities (PERSON, ORGANIZATION, LOCATION, EVENT) and their connections from these investigative documents.\n"
            f"DOCUMENTS:\n{context}\n"
            "Return JSON with 'entities' and 'connections' keys."
        )
        
        res = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CaseMap
            )
        )
        
        output = res.parsed # Gemini SDK automatically parses JSON based on response_schema
        
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
        # 1. Embed Query
        res = client.models.embed_content(
            model="text-embedding-004",
            contents=[request.query]
        )
        embedding = res.embeddings[0].values

        # 2. Query Pinecone
        results = index.query(vector=embedding, top_k=10, include_metadata=True)
        
        context_parts = []
        for r in results.matches:
            if not r.metadata: continue
            # Handle different metadata keys (LlamaIndex uses 'text', our direct upload uses 'text')
            text = r.metadata.get('text') or r.metadata.get('content') or ""
            if text:
                context_parts.append(text)
        
        context = "\n\n---\n\n".join(context_parts)
        
        # 3. Generate Answer
        prompt = (
            "You are a master investigative analyst. Use the following context to answer the user's question.\n"
            "If the information is not in the context, say so.\n\n"
            f"CONTEXT:\n{context}\n\n"
            f"QUESTION: {request.query}\n\n"
            "DETAILED RESPONSE:"
        )
        
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt
        )
        return {"response": response.text}
    except Exception as e:
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

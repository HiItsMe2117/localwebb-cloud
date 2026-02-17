import os
import json
import shutil
import tempfile
import uuid
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# Direct Cloud SDKs (Much lighter than LlamaIndex)
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
GRAPH_FILE = "graph_store.json"

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

class QueryRequest(BaseModel):
    query: str

@app.get("/")
async def root():
    return {"status": "LocalWebb Cloud API is active"}

@app.get("/api")
async def api_health():
    return {"status": "LocalWebb Cloud API is active"}

@app.get("/api/graph")
async def get_graph():
    return graph_store.load()

@app.post("/api/query")
async def query_index(request: QueryRequest):
    # 1. Embed Query
    res = client.models.embed_content(
        model="text-embedding-004",
        contents=[request.query]
    )
    embedding = res.embeddings[0].values

    # 2. Query Pinecone
    results = index.query(vector=embedding, top_k=5, include_metadata=True)
    
    context = "\n\n".join([r.metadata.get('text', '') for r in results.matches])
    
    # 3. Generate Answer
    prompt = f"Context:\n{context}\n\nQuestion: {request.query}\n\nAnswer based on context:"
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=prompt
    )
    return {"response": response.text}

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
        # Upload to GCS
        blob = bucket.blob(f"uploads/{filename}")
        blob.upload_from_filename(file_path)

        # Extract Text
        reader = PdfReader(file_path)
        text = ""
        for page in reader.pages:
            text += page.extract_text() + "\n"

        # Chunk and Embed (Simple chunking for lightness)
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

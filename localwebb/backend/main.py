import os
import json
import shutil
import tempfile
from typing import List, Optional
from fastapi import FastAPI, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# Cloud & LlamaIndex imports
from pinecone import Pinecone
from llama_index.core import VectorStoreIndex, StorageContext
from llama_index.vector_stores.pinecone import PineconeVectorStore
from llama_index.embeddings.google_genai import GeminiEmbedding
from llama_index.llms.google_genai import Gemini
from google.cloud import storage

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
    # Create a temporary file for the credentials if provided as a string
    with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json') as f:
        f.write(gcp_json)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = f.name
elif not os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
    # Fallback to local file for development if exists
    local_creds = "/Users/cody/Desktop/Investigator Tools/epsteinfiles-487701-fad3618ad671.json"
    if os.path.exists(local_creds):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = local_creds

# --- Initialize Clients ---
storage_client = storage.Client()
bucket = storage_client.bucket(GCS_BUCKET)
pc = Pinecone(api_key=PINECONE_API_KEY)
pinecone_index = pc.Index(PINECONE_INDEX_NAME)

# Use Gemini for everything - updated to latest llama-index-llms-google and llama-index-embeddings-google
llm = Gemini(model="models/gemini-2.0-flash", api_key=GOOGLE_API_KEY)
embed_model = GeminiEmbedding(model_name="models/gemini-embedding-001", api_key=GOOGLE_API_KEY)
vector_store = PineconeVectorStore(pinecone_index=pinecone_index)

from rapidfuzz import fuzz

class GraphStore:
    def __init__(self, filename):
        self.filename = filename
        if not os.path.exists(self.filename):
            self.save({"nodes": [], "edges": []})

    def load(self):
        try:
            if os.path.exists(self.filename):
                with open(self.filename, 'r') as f:
                    return json.load(f)
        except Exception as e:
            print(f"Error loading graph: {e}")
        return {"nodes": [], "edges": []}

    def save(self, data):
        try:
            with open(self.filename, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            print(f"Error saving graph: {e}")

    def update_node_position(self, node_id, x, y):
        data = self.load()
        for node in data["nodes"]:
            if node["id"] == node_id:
                node["position"] = {"x": x, "y": y}
                break
        self.save(data)

    def resolve_entities(self):
        data = self.load()
        nodes = data["nodes"]
        if len(nodes) < 2: return

        to_merge = {}
        for i in range(len(nodes)):
            for j in range(i + 1, len(nodes)):
                n1, n2 = nodes[i], nodes[j]
                if fuzz.token_sort_ratio(n1["data"]["label"], n2["data"]["label"]) > 85:
                    to_merge[n2["id"]] = n1["id"]

        if not to_merge: return

        new_nodes = [n for n in nodes if n["id"] not in to_merge]
        new_edges = data["edges"]
        for edge in new_edges:
            if edge["source"] in to_merge: edge["source"] = to_merge[edge["source"]]
            if edge["target"] in to_merge: edge["target"] = to_merge[edge["target"]]
        
        unique_edges = []
        seen = set()
        for edge in new_edges:
            key = (edge["source"], edge["target"])
            if key not in seen and edge["source"] != edge["target"]:
                unique_edges.append(edge)
                seen.add(key)
        self.save({"nodes": new_nodes, "edges": unique_edges})

    def add_elements(self, new_nodes, new_edges):
        data = self.load()
        existing_ids = {n["id"] for n in data["nodes"]}
        for node in new_nodes:
            if node["id"] not in existing_ids: data["nodes"].append(node)
        
        existing_edges = {(e["source"], e["target"]) for e in data["edges"]}
        for edge in new_edges:
            if (edge["source"], edge["target"]) not in existing_edges: data["edges"].append(edge)
        
        self.save(data)
        self.resolve_entities()

graph_store = GraphStore(GRAPH_FILE)

class QueryRequest(BaseModel):
    query: str

class PositionUpdate(BaseModel):
    id: str
    x: float
    y: float

@app.get("/")
async def root():
    return {"status": "LocalWebb Cloud API is active"}

@app.get("/graph")
async def get_graph():
    return graph_store.load()

@app.post("/graph/positions")
async def update_positions(updates: List[PositionUpdate]):
    for update in updates:
        graph_store.update_node_position(update.id, update.x, update.y)
    return {"status": "positions updated"}

from pydantic import BaseModel, Field

class Entity(BaseModel):
    id: str = Field(description="Unique ID for the entity")
    label: str = Field(description="Name of the person, org, or location")
    type: str = Field(description="PERSON, ORGANIZATION, LOCATION, or EVENT")
    description: str = Field(description="Brief context about why they are mentioned")

class Connection(BaseModel):
    source_id: str = Field(description="ID of the starting entity")
    target_id: str = Field(description="ID of the ending entity")
    label: str = Field(description="Relationship type (e.g. MEMBER_OF)")

class CaseMap(BaseModel):
    entities: List[Entity]
    connections: List[Connection]

@app.get("/insights")
async def get_insights():
    from llama_index.core.program import LLMTextCompletionProgram
    
    # Use Pinecone + Gemini
    index = VectorStoreIndex.from_vector_store(vector_store, embed_model=embed_model)
    # We use a smaller top_k for the structured program to keep it fast and accurate
    retriever = index.as_retriever(similarity_top_k=20)
    nodes = retriever.retrieve("Identify key people, organizations, locations and their connections.")
    context_str = "\n".join([n.get_content() for n in nodes])

    prompt_template_str = (
        "You are an investigative analyst. Extract entities and connections from the following documents.\n"
        "DOCUMENTS:\n{context_str}\n"
        "Return the findings as structured data."
    )
    
    program = LLMTextCompletionProgram.from_defaults(
        output_cls=CaseMap,
        prompt_template_str=prompt_template_str,
        llm=llm,
        verbose=True
    )

    try:
        output = program(context_str=context_str)
        
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
                "position": {"x": 100 + (len(new_nodes) * 10), "y": 100},
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
        print(f"Cloud Insights failed: {e}")
        return graph_store.load()

@app.post("/query")
async def query_index(request: QueryRequest):
    index = VectorStoreIndex.from_vector_store(vector_store, embed_model=embed_model)
    query_engine = index.as_query_engine(llm=llm)
    response = query_engine.query(request.query)
    return {"response": str(response)}

@app.post("/upload")
async def upload_file(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    # Save file locally temporarily
    temp_dir = tempfile.mkdtemp()
    file_path = os.path.join(temp_dir, file.filename)
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)
    
    # Background task to process and ingest
    background_tasks.add_task(process_and_ingest_cloud, file_path, file.filename)
    
    return {"status": "Upload successful, processing in background", "filename": file.filename}

def process_and_ingest_cloud(file_path, filename):
    try:
        # Upload to GCS
        blob = bucket.blob(f"uploads/{filename}")
        blob.upload_from_filename(file_path)
        
        # Index to Pinecone
        documents = SimpleDirectoryReader(input_files=[file_path]).load_data()
        for doc in documents:
            doc.metadata["gcs_path"] = f"gs://{GCS_BUCKET}/uploads/{filename}"
            doc.metadata["source"] = "user_upload"
            
        index = VectorStoreIndex.from_vector_store(vector_store, embed_model=embed_model)
        for doc in documents:
            index.insert(doc)
            
    except Exception as e:
        print(f"Error processing upload {filename}: {e}")
    finally:
        # Cleanup
        if os.path.exists(file_path):
            os.remove(file_path)
        shutil.rmtree(os.path.dirname(file_path), ignore_errors=True)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

import os
import shutil
import time
import base64
import requests
import fitz
import asyncio
from tqdm import tqdm
from llama_index.core import VectorStoreIndex, SimpleDirectoryReader, StorageContext
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.embeddings.ollama import OllamaEmbedding
from llama_index.llms.ollama import Ollama
import chromadb

# Configuration (Matches main.py)
QUEUE_DIR = "./data/queue"
PROCESSED_DIR = "./data/processed"
CHROMA_DIR = "./chroma_db"
os.makedirs(QUEUE_DIR, exist_ok=True)
os.makedirs(PROCESSED_DIR, exist_ok=True)

# Initialize Ollama
llm = Ollama(model="llama3", request_timeout=120.0)
vision_llm = Ollama(model="llava", request_timeout=120.0)
embed_model = OllamaEmbedding(model_name="nomic-embed-text")

# Initialize Chroma
db = chromadb.PersistentClient(path=CHROMA_DIR)
chroma_collection = db.get_or_create_collection("research_notes")
vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
storage_context = StorageContext.from_defaults(vector_store=vector_store)

async def process_file(file_path):
    filename = os.path.basename(file_path)
    
    # 1. Vision Analysis for Scans
    description_path = None
    if filename.lower().endswith('.pdf'):
        try:
            doc = fitz.open(file_path)
            if not any(page.get_text().strip() for page in doc) and len(doc) > 0:
                pix = doc[0].get_pixmap()
                img_data = pix.tobytes("png")
                
                resp = requests.post("http://localhost:11434/api/generate", 
                    json={
                        "model": "llava",
                        "prompt": "Describe this scanned document or photo for an investigation. What are the key details?",
                        "images": [base64.b64encode(img_data).decode('utf-8')],
                        "stream": False
                    }
                )
                description = resp.json().get("response", "")
                description_path = file_path + ".desc.txt"
                with open(description_path, "w") as f:
                    f.write(f"VISUAL_DESCRIPTION: {description}")
            doc.close()
        except Exception as e:
            pass

    # 2. Vectorize
    try:
        input_files = [file_path]
        if description_path:
            input_files.append(description_path)
            
        documents = SimpleDirectoryReader(input_files=input_files).load_data()
        VectorStoreIndex.from_documents(
            documents, 
            storage_context=storage_context,
            embed_model=embed_model
        )
    except Exception as e:
        print(f"\n[Error] Vectorization failed for {filename}: {e}")

def start_overnight_ingest():
    print("\n" + "="*50)
    print("   LOCAL WEBB NIGHT-WATCH INGESTOR v1.0")
    print("="*50)
    print(f"[*] Queue:     {QUEUE_DIR}")
    print(f"[*] Database:  {CHROMA_DIR}")
    print("[*] Controls:  Press Ctrl+C to safely exit")
    print("="*50 + "\n")
    
    while True:
        files = [f for f in os.listdir(QUEUE_DIR) if not f.startswith('.')]
        if not files:
            print(f"\r[{time.strftime('%H:%M:%S')}] Queue empty. Sleeping... ", end="")
            time.sleep(10)
            continue
            
        print(f"\n[!] Found {len(files)} files. Starting batch processing...")
        
        pbar = tqdm(total=len(files), desc="Progress", unit="file")
        
        for filename in files:
            source = os.path.join(QUEUE_DIR, filename)
            dest = os.path.join(PROCESSED_DIR, filename)
            
            pbar.set_postfix_str(f"Working on: {filename[:20]}...")
            
            try:
                asyncio.run(process_file(source))
                shutil.move(source, dest)
                if os.path.exists(source + ".desc.txt"):
                    os.remove(source + ".desc.txt")
                pbar.update(1)
            except Exception as e:
                print(f"\n[Error] Failed on {filename}: {e}")
                time.sleep(1)
        
        pbar.close()
        print(f"\n[SUCCESS] Batch complete at {time.strftime('%H:%M:%S')}")

if __name__ == "__main__":
    start_overnight_ingest()

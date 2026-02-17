#!/usr/bin/env python3
import os
import json
import time
import base64
import logging
import zipfile
import requests
import io
import shutil
from pathlib import Path
from datetime import datetime
from tqdm import tqdm
from dotenv import load_dotenv

# Cloud Imports
from google.cloud import storage
from pinecone import Pinecone
from llama_index.core import VectorStoreIndex, StorageContext, SimpleDirectoryReader
from llama_index.vector_stores.pinecone import PineconeVectorStore
from llama_index.embeddings.gemini import GeminiEmbedding
from llama_index.llms.gemini import Gemini

load_dotenv()

# --- Config ---
GCS_BUCKET = os.getenv("GCS_BUCKET_NAME")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# --- Initialize Clients ---
storage_client = storage.Client()
bucket = storage_client.bucket(GCS_BUCKET)
pc = Pinecone(api_key=PINECONE_API_KEY)
pinecone_index = pc.Index(PINECONE_INDEX_NAME)

llm = Gemini(model="models/gemini-2.5-pro", api_key=GOOGLE_API_KEY)
embed_model = GeminiEmbedding(model_name="models/gemini-embedding-001", api_key=GOOGLE_API_KEY)
vector_store = PineconeVectorStore(pinecone_index=pinecone_index)
storage_context = StorageContext.from_defaults(vector_store=vector_store)

def upload_to_gcs(file_path, blob_name):
    """Uploads a local file to the GCS bucket."""
    blob = bucket.blob(blob_name)
    blob.upload_from_filename(file_path)
    logging.info(f"Uploaded {blob_name} to GCS.")
    return f"gs://{GCS_BUCKET}/{blob_name}"

def process_and_ingest(file_path, dataset_id):
    """Vectors a file into Pinecone and uploads to GCS."""
    filename = os.path.basename(file_path)
    gcs_path = f"dataset_{dataset_id}/{filename}"
    
    # Upload to GCS
    upload_to_gcs(file_path, gcs_path)
    
    # Load and index
    logging.info(f"Indexing {filename}...")
    documents = SimpleDirectoryReader(input_files=[file_path]).load_data()
    for doc in documents:
        doc.metadata["gcs_path"] = f"gs://{GCS_BUCKET}/{gcs_path}"
        doc.metadata["dataset_id"] = dataset_id
        
    VectorStoreIndex.from_documents(
        documents,
        storage_context=storage_context,
        embed_model=embed_model,
        show_progress=False
    )
    logging.info(f"Successfully indexed {filename}.")

def run_ingest(dataset_id=4, limit=None):
    """Downloads dataset 4, extracts files, and uploads/indexes them."""
    from dataset_registry import DATASETS
    ds = DATASETS[dataset_id - 1]
    url = ds["sources"][0]
    
    tmp_zip = "dataset_4.zip"
    extract_dir = "tmp_extract_4"
    os.makedirs(extract_dir, exist_ok=True)
    
    if not os.path.exists(tmp_zip):
        logging.info(f"Downloading {ds['name']} (~350MB)...")
        resp = requests.get(url, stream=True)
        total_size = int(resp.headers.get('content-length', 0))
        with open(tmp_zip, "wb") as f, tqdm(
            desc=tmp_zip,
            total=total_size,
            unit='iB',
            unit_scale=True,
            unit_divisor=1024,
        ) as bar:
            for chunk in resp.iter_content(chunk_size=8192):
                size = f.write(chunk)
                bar.update(size)
    else:
        logging.info(f"{tmp_zip} already exists, skipping download.")
            
    logging.info("Extracting PDFs...")
    with zipfile.ZipFile(tmp_zip, "r") as zf:
        pdfs = [n for n in zf.namelist() if n.lower().endswith(".pdf")]
        if limit:
            pdfs = pdfs[:limit]
            
        logging.info(f"Found {len(pdfs)} PDFs to process.")
        
        for pdf in tqdm(pdfs, desc="Processing PDFs"):
            # Flatten path
            base_pdf = os.path.basename(pdf)
            if not base_pdf: continue
            
            # Extract to temporary file
            with zf.open(pdf) as source, open(os.path.join(extract_dir, base_pdf), "wb") as target:
                shutil.copyfileobj(source, target)
            
            full_path = os.path.join(extract_dir, base_pdf)
            try:
                process_and_ingest(full_path, dataset_id)
            except Exception as e:
                logging.error(f"Error processing {base_pdf}: {e}")
            finally:
                if os.path.exists(full_path):
                    os.remove(full_path)
                    
    # Cleanup
    if os.path.exists(tmp_zip):
        os.remove(tmp_zip)
    if os.path.exists(extract_dir):
        shutil.rmtree(extract_dir)
    logging.info("Dataset 4 ingestion complete. Local storage is clean.")

if __name__ == "__main__":
    # Process all files in Dataset 4
    run_ingest(dataset_id=4, limit=None)

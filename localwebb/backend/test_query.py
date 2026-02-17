import time
import logging
import sys
import os

os.environ["ANONYMIZED_TELEMETRY"] = "False"

from llama_index.core import VectorStoreIndex, StorageContext
from llama_index.vector_stores.chroma import ChromaVectorStore
from llama_index.embeddings.ollama import OllamaEmbedding
from llama_index.llms.ollama import Ollama
import chromadb

# Enable debug logging
# logging.basicConfig(stream=sys.stdout, level=logging.DEBUG)

CHROMA_DIR = "./chroma_db"

def test():
    print("Initializing...", flush=True)
    db = chromadb.PersistentClient(path=CHROMA_DIR)
    chroma_collection = db.get_or_create_collection("research_notes")
    vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
    
    # Increase timeout for this test to see if it EVER finishes
    llm = Ollama(model="llama3", request_timeout=1200.0)
    embed_model = OllamaEmbedding(model_name="nomic-embed-text")
    
    index = VectorStoreIndex.from_vector_store(
        vector_store,
        embed_model=embed_model
    )

    query_engine = index.as_query_engine(llm=llm, similarity_top_k=2, streaming=True)
    
    prompt = (
        "You are an investigative analyst. Analyze the following documents to build a high-fidelity 'Case Map'.\n"
        "Identify the following entity types:\n"
        "- PERSON: Individual names.\n"
        "- ORGANIZATION: Companies, government agencies (e.g., FBI, USAO), or groups.\n"
        "- CASE_ID: Reference numbers (e.g., 91A1040).\n"
        "- LOCATION: Physical addresses, cities, or countries (e.g., Israel).\n"
        "- EVENT: Specific occurrences (e.g., 'death of Jeffrey Epstein').\n"
        "- IMAGE_EVIDENCE: Visual data or photos described in the text.\n\n"
        "Identify connections with specific labels: 'REPRESENTS', 'MEMBER_OF', 'ALLEGED_CONNECTION', 'LOCATED_IN', 'MENTIONED_WITH'.\n\n"
        "Return ONLY a JSON object with:\n"
        "'entities': list of {id, label, type, date, description}\n"
        "'connections': list of {source_id, target_id, label, date}\n"
        "Ensure consistent IDs. If a person is linked to a country like 'Israel', create a 'LOCATION' node for Israel and connect them."
    )
    
    print(f"Starting query on {chroma_collection.count()} chunks...", flush=True)
    start_time = time.time()
    try:
        streaming_response = query_engine.query(prompt)
        print("Response: ", end="", flush=True)
        for text in streaming_response.response_gen:
            print(text, end="", flush=True)
        
        end_time = time.time()
        print(f"\n\nQuery completed in {end_time - start_time:.2f} seconds", flush=True)
    except Exception as e:
        print(f"\nQuery failed: {e}", flush=True)

if __name__ == "__main__":
    test()

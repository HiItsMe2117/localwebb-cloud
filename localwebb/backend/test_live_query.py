import os
import json
from pinecone import Pinecone
from llama_index.core import VectorStoreIndex, StorageContext
from llama_index.vector_stores.pinecone import PineconeVectorStore
from llama_index.embeddings.gemini import GeminiEmbedding
from llama_index.llms.gemini import Gemini
from dotenv import load_dotenv

load_dotenv()

# --- Config ---
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

def test_query():
    print("Initializing Live Cloud Query...")
    pc = Pinecone(api_key=PINECONE_API_KEY)
    pinecone_index = pc.Index(PINECONE_INDEX_NAME)
    
    # Corrected model name
    llm = Gemini(model="models/gemini-2.5-pro", api_key=GOOGLE_API_KEY)
    embed_model = GeminiEmbedding(model_name="models/gemini-embedding-001", api_key=GOOGLE_API_KEY)
    vector_store = PineconeVectorStore(pinecone_index=pinecone_index)
    
    index = VectorStoreIndex.from_vector_store(vector_store, embed_model=embed_model)
    query_engine = index.as_query_engine(llm=llm, similarity_top_k=20)

    print("Sending Analysis Request...")
    # More specific query to get real data
    prompt = "Extract all mentioned people and organizations from the documents. Return JSON with 'entities' and 'connections'."
    
    try:
        response = query_engine.query(prompt)
        print("\n--- GEMINI RESPONSE ---")
        print(response)
        print("------------------------")
    except Exception as e:
        print(f"Query failed: {e}")

if __name__ == "__main__":
    test_query()

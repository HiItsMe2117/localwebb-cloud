import os
import json
from pinecone import Pinecone
from google import genai
from dotenv import load_dotenv

load_dotenv(".env.prod")

PINECONE_API_KEY = (os.getenv("PINECONE_API_KEY") or os.getenv("PINCONE_API_KEY") or "").strip()
PINECONE_INDEX_NAME = (os.getenv("PINECONE_INDEX") or os.getenv("pinecone_index") or "localwebb").strip()
GOOGLE_API_KEY = (os.getenv("GOOGLE_API_KEY") or "").strip()

def search_israel():
    if not PINECONE_API_KEY or not GOOGLE_API_KEY:
        print("Missing API keys.")
        return

    pc = Pinecone(api_key=PINECONE_API_KEY)
    index = pc.Index(PINECONE_INDEX_NAME)
    client = genai.Client(api_key=GOOGLE_API_KEY)

    query = "Israel"
    print(f"Searching for '{query}' in Pinecone...")
    
    res = client.models.embed_content(
        model="gemini-embedding-001",
        contents=[query]
    )
    embedding = res.embeddings[0].values

    results = index.query(
        vector=embedding,
        top_k=10,
        include_metadata=True
    )

    if not results.matches:
        print("No results found for 'Israel'.")
        return

    print(f"\nFound {len(results.matches)} matches for 'Israel':")
    for r in results.matches:
        filename = r.metadata.get('filename', 'unknown')
        page = r.metadata.get('page', 'unknown')
        text = r.metadata.get('text', '').replace('\n', ' ')[:300]
        print(f"\n--- File: {filename} (Page: {page}) ---")
        print(f"Text: {text}...")

if __name__ == "__main__":
    search_israel()

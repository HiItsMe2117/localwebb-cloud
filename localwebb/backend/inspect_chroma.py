import chromadb
CHROMA_DIR = "./chroma_db"

def inspect():
    db = chromadb.PersistentClient(path=CHROMA_DIR)
    collection = db.get_or_create_collection("research_notes")
    results = collection.get(limit=5, include=["documents", "metadatas"])
    
    print(f"Total count: {collection.count()}")
    for i in range(len(results["documents"])):
        doc = results["documents"][i]
        meta = results["metadatas"][i]
        print(f"\n--- Document {i} (Length: {len(doc)}) ---")
        print(doc[:500] + "...")
        print(f"Metadata: {meta}")

if __name__ == "__main__":
    inspect()

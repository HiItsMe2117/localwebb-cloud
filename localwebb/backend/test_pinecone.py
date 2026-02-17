import os
from pinecone import Pinecone
from dotenv import load_dotenv

load_dotenv()

def test_connection():
    api_key = os.getenv("PINECONE_API_KEY")
    pc = Pinecone(api_key=api_key)
    
    print(f"Connecting to Pinecone...")
    indexes = pc.list_indexes()
    print(f"Available Indexes: {[idx.name for idx in indexes]}")
    
    if "localwebb" in [idx.name for idx in indexes]:
        index_info = pc.Index("localwebb").describe_index_stats()
        print(f"Successfully connected to 'localwebb' index.")
        print(f"Index Stats: {index_info}")
    else:
        print("Index 'localwebb' not found. Please ensure it is created with 768 dimensions.")

if __name__ == "__main__":
    test_connection()

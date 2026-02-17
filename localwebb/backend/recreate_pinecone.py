import os
import time
from pinecone import Pinecone, ServerlessSpec
from dotenv import load_dotenv

load_dotenv()

def recreate_index():
    api_key = os.getenv("PINECONE_API_KEY")
    index_name = os.getenv("PINECONE_INDEX")
    
    pc = Pinecone(api_key=api_key)
    
    print(f"Checking for existing index '{index_name}'...")
    if index_name in [idx.name for idx in pc.list_indexes()]:
        print(f"Deleting existing 768-dim index...")
        pc.delete_index(index_name)
        # Wait for deletion to propagate
        time.sleep(10)
    
    print(f"Creating new 3072-dim index...")
    pc.create_index(
        name=index_name,
        dimension=3072,
        metric='cosine',
        spec=ServerlessSpec(
            cloud='aws',
            region='us-east-1'
        )
    )
    
    print("Waiting for index to be ready...")
    while not pc.describe_index(index_name).status['ready']:
        time.sleep(2)
    
    print(f"Index '{index_name}' is now READY with 3072 dimensions.")

if __name__ == "__main__":
    recreate_index()

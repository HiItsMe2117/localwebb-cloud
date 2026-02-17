"""
Dataset registry for DOJ Epstein case files.

Each dataset has tiered download sources (Archive.org → DOJ → community mirror),
file sizes, and SHA256 hashes for verification.
"""

DATASETS = {
    1: {
        "name": "DataSet 1",
        "filename": "DataSet 1.zip",
        "size_gb": 2.1,
        "sha256": None,  # Hash not yet verified
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%201.zip",
            "https://www.justice.gov/epstein/files/DataSet%201.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%201.zip",
        ],
    },
    2: {
        "name": "DataSet 2",
        "filename": "DataSet 2.zip",
        "size_gb": 2.5,
        "sha256": None,
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%202.zip",
            "https://www.justice.gov/epstein/files/DataSet%202.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%202.zip",
        ],
    },
    3: {
        "name": "DataSet 3",
        "filename": "DataSet 3.zip",
        "size_gb": 3.0,
        "sha256": None,
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%203.zip",
            "https://www.justice.gov/epstein/files/DataSet%203.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%203.zip",
        ],
    },
    4: {
        "name": "DataSet 4",
        "filename": "DataSet 4.zip",
        "size_gb": 0.35,
        "sha256": None,
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%204.zip",
            "https://www.justice.gov/epstein/files/DataSet%204.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%204.zip",
        ],
    },
    5: {
        "name": "DataSet 5",
        "filename": "DataSet 5.zip",
        "size_gb": 1.2,
        "sha256": None,
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%205.zip",
            "https://www.justice.gov/epstein/files/DataSet%205.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%205.zip",
        ],
    },
    6: {
        "name": "DataSet 6",
        "filename": "DataSet 6.zip",
        "size_gb": 1.8,
        "sha256": None,
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%206.zip",
            "https://www.justice.gov/epstein/files/DataSet%206.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%206.zip",
        ],
    },
    7: {
        "name": "DataSet 7",
        "filename": "DataSet 7.zip",
        "size_gb": 2.0,
        "sha256": None,
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%207.zip",
            "https://www.justice.gov/epstein/files/DataSet%207.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%207.zip",
        ],
    },
    8: {
        "name": "DataSet 8",
        "filename": "DataSet 8.zip",
        "size_gb": 3.5,
        "sha256": None,
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%208.zip",
            "https://www.justice.gov/epstein/files/DataSet%208.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%208.zip",
        ],
    },
    9: {
        "name": "DataSet 9",
        "filename": "DataSet 9.zip",
        "size_gb": 95.0,
        "sha256": None,
        "skip": True,  # Too large for 58 GB disk
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%209.zip",
            "https://www.justice.gov/epstein/files/DataSet%209.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%209.zip",
        ],
    },
    10: {
        "name": "DataSet 10",
        "filename": "DataSet 10.zip",
        "size_gb": 95.0,
        "sha256": None,
        "skip": True,  # Too large for 58 GB disk
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%2010.zip",
            "https://www.justice.gov/epstein/files/DataSet%2010.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%2010.zip",
        ],
    },
    11: {
        "name": "DataSet 11",
        "filename": "DataSet 11.zip",
        "size_gb": 96.0,
        "sha256": None,
        "skip": True,  # Too large for 58 GB disk
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%2011.zip",
            "https://www.justice.gov/epstein/files/DataSet%2011.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%2011.zip",
        ],
    },
    12: {
        "name": "DataSet 12",
        "filename": "DataSet 12.zip",
        "size_gb": 4.0,
        "sha256": None,
        "skip": False,
        "sources": [
            "https://archive.org/download/data-set-1/DataSet%2012.zip",
            "https://www.justice.gov/epstein/files/DataSet%2012.zip",
            "https://copyparty.vvv.systems/DOJ%20Epstein%20Files/justice.gov/DataSet%2012.zip",
        ],
    },
}

# Processing order: Dataset 4 first (smallest, good for testing), then chronological
PROCESSING_ORDER = [4, 5, 6, 7, 8, 12, 1, 2, 3]


def get_dataset(dataset_id):
    """Get dataset metadata by ID."""
    return DATASETS.get(dataset_id)


def get_processing_queue(single_dataset=None):
    """Return list of dataset IDs to process, respecting skip flags."""
    if single_dataset is not None:
        ds = DATASETS.get(single_dataset)
        if ds and not ds["skip"]:
            return [single_dataset]
        return []
    return [d for d in PROCESSING_ORDER if not DATASETS[d]["skip"]]

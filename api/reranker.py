"""
Cross-encoder reranker using FlashRank.
Lazy-loads the model on first use and caches it in module scope.
Model stored in /tmp/flashrank (Vercel-writable directory).
"""

import os

_ranker = None


def _get_ranker():
    global _ranker
    if _ranker is not None:
        return _ranker
    try:
        from flashrank import Ranker, RerankRequest  # noqa: F401
        cache_dir = os.path.join("/tmp", "flashrank")
        os.makedirs(cache_dir, exist_ok=True)
        _ranker = Ranker(
            model_name="ms-marco-MiniLM-L-12-v2",
            cache_dir=cache_dir,
        )
        print("DEBUG: FlashRank reranker loaded successfully")
        return _ranker
    except Exception as e:
        print(f"DEBUG: Failed to load FlashRank reranker: {e}")
        return None


def rerank(query: str, candidates: list, top_n: int = 8) -> list:
    """
    Rerank candidates using FlashRank cross-encoder.

    Args:
        query: The user's search query.
        candidates: List of dicts with at least a 'text' key.
        top_n: Number of top results to return.

    Returns:
        Reranked list of candidate dicts (top_n items).
        Falls back to original ordering if reranker unavailable.
    """
    ranker = _get_ranker()
    if ranker is None:
        return candidates[:top_n]

    try:
        from flashrank import RerankRequest

        passages = [{"id": i, "text": c["text"][:1500]} for i, c in enumerate(candidates)]
        request = RerankRequest(query=query, passages=passages)
        results = ranker.rerank(request)

        reranked = []
        for r in results[:top_n]:
            idx = int(r["id"])
            reranked.append(candidates[idx])
        return reranked
    except Exception as e:
        print(f"DEBUG: Reranking failed, falling back: {e}")
        return candidates[:top_n]

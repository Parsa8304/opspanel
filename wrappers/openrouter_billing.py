"""
OpenRouter → Panel billing wrapper (Django / Python).

HONESTY: this wrapper only forwards the REAL `usage` object OpenRouter put
inside the chat-completion response. It does NOT compute price (the panel
does that from versioned ProviderPricing). It is fire-and-forget and MUST
NEVER raise into the calling request path.

Dependency-light: standard library only (urllib + threading). If you already
have `requests`, you can swap the _post implementation.

Usage (non-streaming)::

    from openrouter_billing import report_openrouter_usage

    resp = openrouter_client.chat.completions.create(...)
    report_openrouter_usage(
        resp,                       # the full response object / dict
        model="openai/gpt-4o",
        module="lead_enrichment",
        user_id=str(request.user.id),
        project_id=str(project.id),
        is_byok=False,
    )

Usage (streaming): consume the FULL stream first; OpenRouter only emits the
`usage` object in the LAST SSE chunk. Helper provided::

    final_usage = accumulate_stream_usage(stream_chunks)
    report_openrouter_usage({"usage": final_usage, "id": gen_id}, model=...)

Configure once (env or settings)::

    PANEL_BILLING_URL   = "http://panel.internal/api/billing/events"
    PANEL_INGEST_TOKEN  = "bilg_..."   # from Panel → Billing → Config
"""

from __future__ import annotations

import json
import os
import threading
import urllib.request
from typing import Any, Dict, Iterable, Optional

PANEL_BILLING_URL = os.environ.get("PANEL_BILLING_URL", "")
PANEL_INGEST_TOKEN = os.environ.get("PANEL_INGEST_TOKEN", "")
_TIMEOUT_SEC = 5


def _as_dict(resp: Any) -> Dict[str, Any]:
    """Best-effort: accept dicts, OpenAI/OpenRouter SDK objects, or JSON str."""
    if isinstance(resp, dict):
        return resp
    if isinstance(resp, (bytes, str)):
        try:
            return json.loads(resp)
        except Exception:
            return {}
    # SDK objects often expose .model_dump() / .to_dict() / .__dict__
    for attr in ("model_dump", "to_dict", "dict"):
        fn = getattr(resp, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    return getattr(resp, "__dict__", {}) or {}


def _post(payload: Dict[str, Any]) -> None:
    if not PANEL_BILLING_URL or not PANEL_INGEST_TOKEN:
        return
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            PANEL_BILLING_URL,
            data=data,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-billing-ingest-token": PANEL_INGEST_TOKEN,
            },
        )
        # Block only this background thread, never the caller.
        urllib.request.urlopen(req, timeout=_TIMEOUT_SEC).read()
    except Exception:
        # Billing telemetry must never break the product. Swallow everything.
        pass


def report_openrouter_usage(
    response: Any,
    *,
    model: Optional[str] = None,
    module: str = "unknown",
    user_id: Optional[str] = None,
    project_id: Optional[str] = None,
    is_byok: bool = False,
    is_free_tier: Optional[bool] = None,
    endpoint: str = "/chat/completions",
    request_meta: Optional[Dict[str, Any]] = None,
) -> None:
    """Fire-and-forget: POST the real captured usage to the panel.

    Never raises. Returns immediately (work happens on a daemon thread).
    """
    try:
        body = _as_dict(response)
        usage = body.get("usage") or {}
        gen_id = body.get("id") or body.get("generation_id")
        resolved_model = model or body.get("model")
        payload = {
            "provider": "openrouter",
            "model": resolved_model,
            "endpoint": endpoint,
            "generationId": gen_id,
            "module": module,
            "userId": user_id,
            "projectId": project_id,
            "isByok": bool(is_byok),
            "usage": usage,
            "requestMeta": request_meta,
        }
        if is_free_tier is not None:
            payload["isFreeTier"] = bool(is_free_tier)
        threading.Thread(target=_post, args=(payload,), daemon=True).start()
    except Exception:
        pass


def accumulate_stream_usage(chunks: Iterable[Any]) -> Dict[str, Any]:
    """Consume the FULL stream and return the usage object from the last
    chunk that carries one. Incomplete/aborted streams → {} (enrich later
    via the panel's /generation backfill)."""
    last_usage: Dict[str, Any] = {}
    for ch in chunks:
        d = _as_dict(ch)
        u = d.get("usage")
        if u:
            last_usage = u
    return last_usage

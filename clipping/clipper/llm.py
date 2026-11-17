"""Thin wrapper around the Claude API for schema-constrained JSON responses."""

from __future__ import annotations

import json
import os
import time

import anthropic

DEFAULT_MODEL = os.environ.get("CLIPPER_MODEL", "claude-opus-5-5")


class LLMError(RuntimeError):
    pass


def structured_call(
    *,
    system: str,
    user: str | list,
    schema: dict,
    model: str = DEFAULT_MODEL,
    effort: str = "high",
    max_tokens: int = 64000,
    batch: bool = False,
    progress=None,
) -> dict:
    """Run a request whose final text block is JSON matching `schema`.

    `user` may be a string or a list of content blocks (for prompt caching).
    Default: streamed, with server-side refusal fallbacks (`fallbacks="default"`),
    which re-run a policy-declined request on Anthropic's recommended fallback
    model inside the same call. `batch=True` sends it through the Message
    Batches API instead: half price, usually done within minutes but can take
    up to 24 hours; fallbacks aren't available there.
    """
    client = anthropic.Anthropic()
    params = dict(
        model=model,
        max_tokens=max_tokens,
        thinking={"type": "adaptive"},
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    try:
        if batch:
            msg = _run_batch(client, params, progress)
        else:
            with client.beta.messages.stream(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **params
            ) as stream:
                msg = stream.get_final_message()
    except anthropic.AuthenticationError as e:
        raise LLMError("Claude API authentication failed. Set ANTHROPIC_API_KEY or run `ant auth login`.") from e
    except anthropic.RateLimitError as e:
        raise LLMError(f"Rate limited by the Claude API: {e.message}") from e
    except anthropic.APIStatusError as e:
        raise LLMError(f"Claude API error {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise LLMError(f"Could not reach the Claude API: {e}") from e

    if msg.stop_reason == "refusal":
        cat = getattr(msg.stop_details, "category", None) if msg.stop_details else None
        raise LLMError(f"Request declined by the model (category: {cat}).")
    if msg.stop_reason == "max_tokens":
        raise LLMError("Response hit max_tokens before finishing; raise max_tokens.")
    text = next((b.text for b in msg.content if b.type == "text"), None)
    if text is None:
        raise LLMError("No text block in model response.")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(f"Model returned invalid JSON: {e}") from e


def _run_batch(client: anthropic.Anthropic, params: dict, progress=None):
    batch = client.messages.batches.create(requests=[{"custom_id": "req", "params": params}])
    t0 = time.time()
    while True:
        b = client.messages.batches.retrieve(batch.id)
        if b.processing_status == "ended":
            break
        if progress:
            progress(f"waiting for Claude (economy mode, {int(time.time() - t0) // 60} min)")
        time.sleep(20)
    for r in client.messages.batches.results(batch.id):
        if r.result.type == "succeeded":
            return r.result.message
        if r.result.type == "errored":
            raise LLMError(f"Batch request failed: {r.result.error}")
        raise LLMError(f"Batch request {r.result.type}")
    raise LLMError("Batch returned no result")

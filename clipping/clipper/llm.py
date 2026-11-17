"""Thin wrapper around the Claude API for schema-constrained JSON responses."""

from __future__ import annotations

import json
import os

import anthropic

DEFAULT_MODEL = os.environ.get("CLIPPER_MODEL", "claude-opus-5-5")


class LLMError(RuntimeError):
    pass


def structured_call(
    *,
    system: str,
    user: str,
    schema: dict,
    model: str = DEFAULT_MODEL,
    effort: str = "high",
    max_tokens: int = 64000,
) -> dict:
    """Stream a request whose final text block is JSON matching `schema`.

    Uses adaptive thinking, structured outputs, and server-side refusal
    fallbacks (`fallbacks="default"`), which re-runs a policy-declined request
    on Anthropic's recommended fallback model inside the same call.
    """
    client = anthropic.Anthropic()
    kwargs = dict(
        model=model,
        max_tokens=max_tokens,
        thinking={"type": "adaptive"},
        output_config={
            "effort": effort,
            "format": {"type": "json_schema", "schema": schema},
        },
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    try:
        with client.beta.messages.stream(
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            **kwargs,
        ) as stream:
            msg = stream.get_final_message()
    except anthropic.AuthenticationError as e:
        raise LLMError(
            "Claude API authentication failed. Set ANTHROPIC_API_KEY or run `ant auth login`."
        ) from e
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

"""Anthropic Claude OAuth Provider Profile.

Enables Anthropic Claude Opus 4.8 / 5, Sonnet 3.7, and Haiku models via
Claude Code OAuth tokens (~/.claude/.credentials.json, Keychain, and
CLAUDE_CODE_OAUTH_TOKEN).
"""

from __future__ import annotations

import json
import logging
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from hermes_cli.urllib_security import open_credentialed_url
from providers import register_provider
from providers.base import ProviderProfile

from .token_store import ClaudeOAuthTokenStore

logger = logging.getLogger(__name__)

_DEFAULT_CLAUDE_BETAS = (
    "prompt-caching-2024-07-31",
    "output-128k-2025-02-19",
    "thinking-2025-01-24",
    "interleaved-thinking-2025-05-14",
)


class ClaudeOAuthProfile(ProviderProfile):
    """Native Anthropic Messages API over Claude Code OAuth."""

    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        self.token_store = ClaudeOAuthTokenStore()

    def get_token(self) -> Optional[str]:
        return self.token_store.get_token()

    def fetch_models(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 8.0,
    ) -> Optional[List[str]]:
        token = api_key or self.get_token()
        if not token:
            return list(self.fallback_models)
        try:
            url = f"{(base_url or self.base_url).rstrip('/')}/v1/models"
            req = urllib.request.Request(url)
            req.add_header("Authorization", f"Bearer {token}")
            req.add_header("anthropic-version", "2023-06-01")
            req.add_header("anthropic-beta", ",".join(_DEFAULT_CLAUDE_BETAS))
            req.add_header("user-agent", "claude-code/2.1.74 (external, cli)")
            req.add_header("x-app", "cli")
            req.add_header("Accept", "application/json")
            with open_credentialed_url(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode())
            models = [
                m["id"]
                for m in data.get("data", [])
                if isinstance(m, dict) and "id" in m
            ]
            return models or list(self.fallback_models)
        except Exception as exc:
            logger.debug("fetch_models(claude-oauth): %s", exc)
            return list(self.fallback_models)

    def build_api_kwargs_extras(
        self,
        *,
        reasoning_config: Optional[Dict[str, Any]] = None,
        **context: Any,
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """Translate reasoning_config to Anthropic thinking format."""
        top_level: Dict[str, Any] = {}
        extra_body: Dict[str, Any] = {}

        if isinstance(reasoning_config, dict):
            effort = str(reasoning_config.get("effort") or "").lower()
            budget = reasoning_config.get("budget_tokens") or reasoning_config.get("max_thinking_tokens")

            if effort in {"high", "max"}:
                top_level["thinking"] = {"type": "enabled", "budget_tokens": int(budget or 32768)}
            elif effort in {"medium", "auto"}:
                top_level["thinking"] = {"type": "enabled", "budget_tokens": int(budget or 16384)}
            elif effort in {"low"}:
                top_level["thinking"] = {"type": "enabled", "budget_tokens": int(budget or 4096)}
            elif isinstance(budget, (int, float)) and budget > 0:
                top_level["thinking"] = {"type": "enabled", "budget_tokens": int(budget)}

        return extra_body, top_level


claude_oauth = ClaudeOAuthProfile(
    name="claude-oauth",
    display_name="Claude (Claude Code OAuth)",
    description="Anthropic Claude via Claude Code OAuth (~/.claude/.credentials.json)",
    aliases=("claude-code-oauth", "anthropic-oauth", "claude-max"),
    api_mode="anthropic_messages",
    env_vars=("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_TOKEN"),
    base_url="https://api.anthropic.com",
    auth_type="oauth_external",
    supports_vision=True,
    supports_vision_tool_messages=True,
    default_max_tokens=65536,
    fallback_models=(
        "claude-3-7-sonnet-20250219",
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-opus-4-8",
        "claude-opus-5",
    ),
    default_aux_model="claude-3-5-haiku-20241022",
    default_headers={
        "anthropic-beta": ",".join(_DEFAULT_CLAUDE_BETAS),
        "user-agent": "claude-code/2.1.74 (external, cli)",
        "x-app": "cli",
    },
)

register_provider(claude_oauth)

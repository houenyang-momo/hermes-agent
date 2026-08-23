"""Google Gemini OAuth Provider Profile (Antigravity & Cloud Code).

Enables Google Gemini 3.7 Flash High / Pro, Gemini 3.6 Flash, and 2.5 Pro
via Google OAuth tokens (~/.config/antigravity/tokens.json, ADC, and GEMINI_OAUTH_TOKEN).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from providers import register_provider
from providers.base import ProviderProfile

from .token_store import GeminiOAuthTokenStore

logger = logging.getLogger(__name__)


class GeminiOAuthProfile(ProviderProfile):
    """Google Gemini native REST API over OAuth Bearer authentication."""

    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        self.token_store = GeminiOAuthTokenStore()

    def get_token(self) -> Optional[str]:
        return self.token_store.get_token()

    def prepare_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Sanitize tool calls and inject thoughtSignature to prevent Gemini 3 400 crashes."""
        if not messages:
            return []

        prepared: List[Dict[str, Any]] = []
        for msg in messages:
            if not isinstance(msg, dict):
                prepared.append(msg)
                continue

            msg_copy = dict(msg)
            role = msg_copy.get("role")

            # For tool results / function responses, ensure thoughtSignature is handled
            if role == "tool" or role == "function":
                # Ensure tool content is safe
                content = msg_copy.get("content")
                if isinstance(content, list):
                    content_copied = []
                    for part in content:
                        if isinstance(part, dict):
                            p = dict(part)
                            if "thoughtSignature" not in p:
                                p["thoughtSignature"] = "skip_thought_signature_validator"
                            content_copied.append(p)
                        else:
                            content_copied.append(part)
                    msg_copy["content"] = content_copied

            prepared.append(msg_copy)
        return prepared

    def build_extra_body(
        self, *, session_id: Optional[str] = None, **context: Any
    ) -> Dict[str, Any]:
        """Translate reasoning_config to thinking_config in extra_body."""
        reasoning_config = context.get("reasoning_config")
        model = str(context.get("model") or "").lower()

        if not isinstance(reasoning_config, dict):
            # Default thinking config for 3.7 models if unspecified
            if "3.7" in model or "3-7" in model:
                return {
                    "thinking_config": {
                        "thinkingBudget": 8192,
                        "includeThoughts": True,
                    }
                }
            return {}

        effort = str(reasoning_config.get("effort") or "").lower()
        budget = reasoning_config.get("budget_tokens") or reasoning_config.get("max_thinking_tokens")

        thinking_config: Dict[str, Any] = {"includeThoughts": True}
        if effort in {"high", "max"}:
            thinking_config["thinkingBudget"] = int(budget or 32768)
            thinking_config["thinkingLevel"] = "high"
        elif effort in {"medium", "auto"}:
            thinking_config["thinkingBudget"] = int(budget or 16384)
            thinking_config["thinkingLevel"] = "medium"
        elif effort in {"low"}:
            thinking_config["thinkingBudget"] = int(budget or 4096)
            thinking_config["thinkingLevel"] = "low"
        elif isinstance(budget, (int, float)) and budget > 0:
            thinking_config["thinkingBudget"] = int(budget)

        return {"thinking_config": thinking_config}


gemini_oauth = GeminiOAuthProfile(
    name="gemini-oauth",
    display_name="Gemini (Google OAuth / Antigravity)",
    description="Google Gemini via Antigravity OAuth (~/.config/antigravity/tokens.json)",
    aliases=("google-oauth", "gemini-cloudcode", "antigravity-gemini"),
    api_mode="chat_completions",
    env_vars=("GEMINI_OAUTH_TOKEN", "GOOGLE_OAUTH_TOKEN"),
    base_url="https://daily-cloudcode-pa.googleapis.com",
    auth_type="oauth_external",
    supports_vision=True,
    supports_vision_tool_messages=True,
    default_max_tokens=65535,
    fallback_models=(
        "gemini-3.7-flash-high",
        "gemini-3.7-flash",
        "gemini-3.7-pro",
        "gemini-3.6-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
    ),
    default_aux_model="gemini-3.6-flash",
)

register_provider(gemini_oauth)

"""Contract tests for the Gemini OAuth provider profile."""

from __future__ import annotations

import json
import pytest
from providers import get_provider_profile
from plugins.model_providers.gemini_oauth.token_store import GeminiOAuthTokenStore


@pytest.fixture
def gemini_oauth_profile():
    profile = get_provider_profile("gemini-oauth")
    assert profile is not None, "gemini-oauth provider profile must be registered"
    return profile


def test_gemini_oauth_profile_contract(gemini_oauth_profile):
    assert gemini_oauth_profile.name == "gemini-oauth"
    assert gemini_oauth_profile.api_mode == "chat_completions"
    assert gemini_oauth_profile.auth_type == "oauth_external"
    assert gemini_oauth_profile.supports_vision is True
    assert "gemini-3.7-flash-high" in gemini_oauth_profile.fallback_models


def test_gemini_oauth_thinking_config_translation(gemini_oauth_profile):
    extra_body = gemini_oauth_profile.build_extra_body(
        model="gemini-3.7-flash",
        reasoning_config={"effort": "high", "budget_tokens": 32000}
    )
    assert "thinking_config" in extra_body
    assert extra_body["thinking_config"]["thinkingBudget"] == 32000
    assert extra_body["thinking_config"]["thinkingLevel"] == "high"


def test_gemini_oauth_prepare_messages_thought_signature(gemini_oauth_profile):
    messages = [
        {"role": "user", "content": "hello"},
        {"role": "tool", "content": [{"type": "text", "text": "result"}]},
    ]
    prepared = gemini_oauth_profile.prepare_messages(messages)
    tool_msg = prepared[1]
    assert tool_msg["content"][0]["thoughtSignature"] == "skip_thought_signature_validator"


def test_gemini_oauth_token_store(tmp_path, monkeypatch):
    tokens_file = tmp_path / "tokens.json"
    tokens_file.write_text(
        json.dumps({
            "token": {
                "access_token": "ya29.test_access_token",
                "refresh_token": "1//test_refresh",
                "expiry": "2099-01-01T00:00:00.000Z",
            }
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(GeminiOAuthTokenStore, "get_antigravity_tokens_path", classmethod(lambda cls: tokens_file))
    monkeypatch.delenv("GEMINI_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("GOOGLE_OAUTH_TOKEN", raising=False)

    store = GeminiOAuthTokenStore()
    token = store.get_token()
    assert token == "ya29.test_access_token"

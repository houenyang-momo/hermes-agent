"""Contract tests for the Claude OAuth provider profile."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from providers import get_provider_profile
from plugins.model_providers.claude_oauth.token_store import ClaudeOAuthTokenStore


@pytest.fixture
def claude_oauth_profile():
    profile = get_provider_profile("claude-oauth")
    assert profile is not None, "claude-oauth provider profile must be registered"
    return profile


def test_claude_oauth_profile_contract(claude_oauth_profile):
    assert claude_oauth_profile.name == "claude-oauth"
    assert claude_oauth_profile.api_mode == "anthropic_messages"
    assert claude_oauth_profile.auth_type == "oauth_external"
    assert claude_oauth_profile.supports_vision is True
    assert claude_oauth_profile.supports_vision_tool_messages is True
    assert "claude-3-7-sonnet-20250219" in claude_oauth_profile.fallback_models
    assert "user-agent" in claude_oauth_profile.default_headers
    assert "anthropic-beta" in claude_oauth_profile.default_headers


def test_claude_oauth_thinking_config_translation(claude_oauth_profile):
    extra_body, top_level = claude_oauth_profile.build_api_kwargs_extras(
        reasoning_config={"effort": "high", "budget_tokens": 32000}
    )
    assert top_level.get("thinking") == {"type": "enabled", "budget_tokens": 32000}

    _, top_level_low = claude_oauth_profile.build_api_kwargs_extras(
        reasoning_config={"effort": "low"}
    )
    assert top_level_low.get("thinking") == {"type": "enabled", "budget_tokens": 4096}


def test_claude_oauth_token_store(tmp_path, monkeypatch):
    creds_file = tmp_path / ".credentials.json"
    creds_file.write_text(
        json.dumps({
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat-test-access",
                "refreshToken": "sk-ant-ort-test-refresh",
                "expiresAt": 9999999999999,
            }
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(ClaudeOAuthTokenStore, "get_credentials_path", classmethod(lambda cls: creds_file))
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("ANTHROPIC_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("ANTHROPIC_TOKEN", raising=False)

    store = ClaudeOAuthTokenStore()
    token = store.get_token()
    assert token == "sk-ant-oat-test-access"

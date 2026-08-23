"""Token store and credential resolver for Claude Code OAuth.

Provides thread-safe access to Claude Code OAuth tokens with an in-flight
refresh mutex to prevent race conditions that invalidate single-use
refresh tokens.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_REFRESH_MUTEX = threading.Lock()


class ClaudeOAuthTokenStore:
    """Thread-safe token store for Anthropic / Claude Code OAuth credentials."""

    def __init__(self, explicit_token: Optional[str] = None):
        self._explicit_token = explicit_token

    @staticmethod
    def get_credentials_path() -> Path:
        return Path.home() / ".claude" / ".credentials.json"

    @staticmethod
    def get_hermes_oauth_path() -> Path:
        return Path.home() / ".hermes" / ".anthropic_oauth.json"

    @classmethod
    def read_claude_credentials_file(cls) -> Optional[Dict[str, Any]]:
        path = cls.get_credentials_path()
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            oauth = data.get("claudeAiOauth")
            if isinstance(oauth, dict) and oauth.get("accessToken"):
                return {
                    "access_token": oauth["accessToken"],
                    "refresh_token": oauth.get("refreshToken"),
                    "expires_at_ms": oauth.get("expiresAt", 0),
                    "source": "claude_credentials_file",
                }
        except Exception as exc:
            logger.debug("Failed reading %s: %s", path, exc)
        return None

    @classmethod
    def read_keychain_credentials(cls) -> Optional[Dict[str, Any]]:
        """Read credentials from macOS Keychain with a bounded 4s timeout."""
        try:
            res = subprocess.run(
                [
                    "security",
                    "find-generic-password",
                    "-s",
                    "Claude Code-credentials",
                    "-w",
                ],
                capture_output=True,
                text=True,
                timeout=4.0,
            )
            if res.returncode == 0 and res.stdout.strip():
                data = json.loads(res.stdout.strip())
                oauth = data.get("claudeAiOauth") or data
                if isinstance(oauth, dict) and oauth.get("accessToken"):
                    return {
                        "access_token": oauth["accessToken"],
                        "refresh_token": oauth.get("refreshToken"),
                        "expires_at_ms": oauth.get("expiresAt", 0),
                        "source": "keychain",
                    }
        except Exception as exc:
            logger.debug("Keychain lookup skipped: %s", exc)
        return None

    @classmethod
    def read_hermes_oauth_file(cls) -> Optional[Dict[str, Any]]:
        path = cls.get_hermes_oauth_path()
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("access_token") or data.get("accessToken"):
                return {
                    "access_token": data.get("access_token") or data.get("accessToken"),
                    "refresh_token": data.get("refresh_token") or data.get("refreshToken"),
                    "expires_at_ms": data.get("expires_at_ms") or data.get("expiresAt", 0),
                    "source": "hermes_oauth_file",
                }
        except Exception as exc:
            logger.debug("Failed reading %s: %s", path, exc)
        return None

    @classmethod
    def refresh_token_if_needed(cls, creds: Dict[str, Any]) -> Optional[str]:
        """Refresh token under a global mutex to prevent single-use race conditions."""
        expires_at_ms = creds.get("expires_at_ms") or 0
        now_ms = time.time() * 1000
        # If token is still valid (with 5-min skew buffer), return active access token
        if expires_at_ms > (now_ms + 300 * 1000):
            return creds.get("access_token")

        with _REFRESH_MUTEX:
            # Re-read
            latest = cls.read_claude_credentials_file() or creds
            latest_exp = latest.get("expires_at_ms") or 0
            if latest_exp > (now_ms + 300 * 1000):
                return latest.get("access_token")

            try:
                from agent.anthropic_adapter import _refresh_oauth_token
                refreshed = _refresh_oauth_token(latest)
                if refreshed:
                    return refreshed
            except Exception as exc:
                logger.debug("Claude OAuth refresh exception: %s", exc)

        return creds.get("access_token")

    def get_token(self) -> Optional[str]:
        """Resolve valid OAuth access token."""
        if self._explicit_token:
            return self._explicit_token

        # 1. Environment variables
        env_token = (
            os.getenv("CLAUDE_CODE_OAUTH_TOKEN")
            or os.getenv("ANTHROPIC_OAUTH_TOKEN")
            or os.getenv("ANTHROPIC_TOKEN")
        )
        if env_token and (env_token.startswith("sk-ant-oat") or env_token.startswith("cc-") or env_token.startswith("eyJ")):
            return env_token.strip()

        # 2. ~/.claude/.credentials.json
        file_creds = self.read_claude_credentials_file()
        if file_creds:
            token = self.refresh_token_if_needed(file_creds)
            if token:
                return token

        # 3. Keychain
        kc_creds = self.read_keychain_credentials()
        if kc_creds:
            token = self.refresh_token_if_needed(kc_creds)
            if token:
                return token

        # 4. Hermes PKCE
        hermes_creds = self.read_hermes_oauth_file()
        if hermes_creds:
            token = self.refresh_token_if_needed(hermes_creds)
            if token:
                return token

        return None

"""Token store and credential resolver for Google Gemini OAuth (Antigravity & Cloud Code).

Provides access to Google OAuth access tokens (~/.config/antigravity/tokens.json,
Google Cloud ADC, and GEMINI_OAUTH_TOKEN).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_REFRESH_MUTEX = threading.Lock()
_GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
_REFRESH_SKEW_SECONDS = 300  # Refresh 5 minutes before expiry


class GeminiOAuthTokenStore:
    """Token store for Google Gemini / Antigravity OAuth credentials."""

    def __init__(self, explicit_token: Optional[str] = None):
        self._explicit_token = explicit_token

    @staticmethod
    def get_antigravity_tokens_path() -> Path:
        return Path.home() / ".config" / "antigravity" / "tokens.json"

    @staticmethod
    def get_gcloud_adc_path() -> Path:
        return Path.home() / ".config" / "gcloud" / "application_default_credentials.json"

    @classmethod
    def read_antigravity_tokens(cls) -> Optional[Dict[str, Any]]:
        path = cls.get_antigravity_tokens_path()
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            tok = data.get("token") or data
            if isinstance(tok, dict) and tok.get("access_token"):
                return {
                    "access_token": tok["access_token"],
                    "refresh_token": tok.get("refresh_token"),
                    "expiry": tok.get("expiry"),
                    "source": "antigravity",
                }
        except Exception as exc:
            logger.debug("Failed reading %s: %s", path, exc)
        return None

    @classmethod
    def read_adc_tokens(cls) -> Optional[Dict[str, Any]]:
        path = cls.get_gcloud_adc_path()
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("access_token") or data.get("refresh_token"):
                return {
                    "access_token": data.get("access_token", ""),
                    "refresh_token": data.get("refresh_token"),
                    "client_id": data.get("client_id"),
                    "client_secret": data.get("client_secret"),
                    "source": "adc",
                }
        except Exception as exc:
            logger.debug("Failed reading %s: %s", path, exc)
        return None

    @classmethod
    def write_antigravity_tokens(cls, access_token: str, refresh_token: Optional[str] = None, expiry: Optional[str] = None) -> bool:
        path = cls.get_antigravity_tokens_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            existing_data: Dict[str, Any] = {}
            if path.exists():
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        existing_data = json.load(f)
                except Exception:
                    existing_data = {}

            existing_data.setdefault("token", {})
            existing_data["token"]["access_token"] = access_token
            if refresh_token:
                existing_data["token"]["refresh_token"] = refresh_token
            if expiry:
                existing_data["token"]["expiry"] = expiry
            existing_data["token"]["token_type"] = "Bearer"

            tmp_path = path.with_suffix(".tmp")
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(existing_data, f, indent=2)
            tmp_path.replace(path)
            return True
        except Exception as exc:
            logger.warning("Failed writing %s: %s", path, exc)
            return False

    @classmethod
    def refresh_antigravity_token(cls, creds: Dict[str, Any]) -> Optional[str]:
        refresh_token = creds.get("refresh_token")
        if not refresh_token:
            return creds.get("access_token")

        expiry_str = creds.get("expiry")
        if expiry_str:
            try:
                # e.g. 2026-08-23T19:00:00.377Z
                clean_expiry = expiry_str.replace("Z", "+00:00")
                exp_dt = datetime.fromisoformat(clean_expiry)
                now_dt = datetime.now(timezone.utc)
                if (exp_dt.timestamp() - now_dt.timestamp()) > _REFRESH_SKEW_SECONDS:
                    return creds.get("access_token")
            except Exception:
                pass

        with _REFRESH_MUTEX:
            # Re-read
            latest = cls.read_antigravity_tokens() or creds
            latest_expiry = latest.get("expiry")
            if latest_expiry:
                try:
                    clean_expiry = latest_expiry.replace("Z", "+00:00")
                    exp_dt = datetime.fromisoformat(clean_expiry)
                    now_dt = datetime.now(timezone.utc)
                    if (exp_dt.timestamp() - now_dt.timestamp()) > _REFRESH_SKEW_SECONDS:
                        return latest.get("access_token")
                except Exception:
                    pass

            try:
                import httpx
                # Antigravity uses Google OAuth refresh
                resp = httpx.post(
                    _GOOGLE_OAUTH_TOKEN_URL,
                    data={
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token,
                        "client_id": os.getenv("GOOGLE_OAUTH_CLIENT_ID", ""),
                        "client_secret": os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", ""),
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
                    timeout=15.0,
                )
                if resp.status_code == 200:
                    payload = resp.json()
                    new_access = payload.get("access_token")
                    expires_in = payload.get("expires_in", 3600)
                    new_exp_dt = datetime.fromtimestamp(time.time() + expires_in, timezone.utc)
                    new_expiry_str = new_exp_dt.isoformat().replace("+00:00", "Z")
                    cls.write_antigravity_tokens(new_access, refresh_token, new_expiry_str)
                    logger.info("Google Gemini OAuth token refreshed successfully")
                    return new_access
                else:
                    logger.debug("Google OAuth refresh response (HTTP %s): %s", resp.status_code, resp.text[:200])
            except Exception as exc:
                logger.debug("Google OAuth refresh exception: %s", exc)

        return creds.get("access_token")

    def get_token(self) -> Optional[str]:
        if self._explicit_token:
            return self._explicit_token

        # 1. Environment variables
        env_token = os.getenv("GEMINI_OAUTH_TOKEN") or os.getenv("GOOGLE_OAUTH_TOKEN")
        if env_token and (env_token.startswith("ya29.") or env_token.startswith("Bearer ")):
            return env_token.replace("Bearer ", "").strip()

        # 2. Antigravity tokens
        anti_creds = self.read_antigravity_tokens()
        if anti_creds:
            token = self.refresh_antigravity_token(anti_creds)
            if token:
                return token

        # 3. ADC tokens
        adc_creds = self.read_adc_tokens()
        if adc_creds and adc_creds.get("access_token"):
            return adc_creds["access_token"]

        return None

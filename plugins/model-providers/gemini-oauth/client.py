"""Antigravity / Google Cloud Code OAuth client for Gemini models.

Provides a full OpenAI-compatible facade over Google Cloud Code / Antigravity's
v1internal REST and SSE streaming endpoints (daily-cloudcode-pa.googleapis.com).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from types import SimpleNamespace
from typing import Any, Dict, Iterator, List, Optional

import httpx

from agent.bounded_response import read_streaming_error_body
from agent.gemini_native_adapter import (
    _GeminiStreamChunk,
    _make_stream_chunk,
    _map_gemini_finish_reason,
    _tool_call_extra_from_part,
    build_gemini_request,
    gemini_http_error,
    GeminiAPIError,
)

logger = logging.getLogger(__name__)

DEFAULT_ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com"


class AntigravityGeminiClient:
    """OpenAI-compatible facade over Antigravity / Google Cloud Code v1internal API."""

    def __init__(
        self,
        *,
        access_token: str,
        base_url: Optional[str] = None,
        default_headers: Optional[Dict[str, str]] = None,
        timeout: Any = None,
        http_client: Optional[httpx.Client] = None,
        **_: Any,
    ):
        self.access_token = access_token
        self.base_url = (base_url or DEFAULT_ANTIGRAVITY_BASE_URL).rstrip("/")
        self._default_headers = dict(default_headers or {})
        self.chat = _AntigravityChatNamespace(self)
        self.is_closed = False
        self._http = http_client or httpx.Client(
            timeout=timeout or httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=30.0)
        )

    def close(self) -> None:
        self.is_closed = True
        try:
            self._http.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {self.access_token}",
            "User-Agent": "Antigravity/2.8.0",
            "X-Goog-Api-Client": "antigravity/2.8.0",
        }
        headers.update(self._default_headers)
        return headers

    def _create_chat_completion(
        self,
        *,
        model: str = "gemini-3.7-flash-high",
        messages: Optional[List[Dict[str, Any]]] = None,
        stream: bool = False,
        tools: Any = None,
        tool_choice: Any = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        top_p: Optional[float] = None,
        stop: Any = None,
        extra_body: Optional[Dict[str, Any]] = None,
        timeout: Any = None,
        **_: Any,
    ) -> Any:
        thinking_config = None
        if isinstance(extra_body, dict):
            thinking_config = extra_body.get("thinking_config") or extra_body.get("thinkingConfig")

        effective_max = max(max_tokens or 65535, 4096) if max_tokens is not None else 65535
        gemini_req = build_gemini_request(
            messages=messages or [],
            tools=tools,
            tool_choice=tool_choice,
            temperature=temperature,
            max_tokens=effective_max,
            top_p=top_p,
            stop=stop,
            thinking_config=thinking_config,
            model=model,
        )

        clean_model = model
        for prefix in ("google/", "antigravity/", "gemini/"):
            if clean_model.lower().startswith(prefix):
                clean_model = clean_model[len(prefix):]

        payload = {
            "model": clean_model,
            "request": gemini_req,
        }

        if stream:
            return self._stream_completion(model=clean_model, payload=payload, timeout=timeout)

        url = f"{self.base_url}/v1internal:generateContent"
        response = self._http.post(url, json=payload, headers=self._headers(), timeout=timeout)
        if response.status_code != 200:
            raise gemini_http_error(response)

        try:
            raw_data = response.json()
            resp_data = raw_data.get("response") or raw_data
        except ValueError as exc:
            raise GeminiAPIError(
                f"Antigravity Gemini response was not valid JSON: {exc}",
                code="gemini_invalid_json",
            ) from exc

        return self._translate_response(resp_data, clean_model)

    def _translate_response(self, resp: Dict[str, Any], model: str) -> SimpleNamespace:
        candidates = resp.get("candidates") or []
        if not candidates:
            return SimpleNamespace(
                id=f"chatcmpl-{uuid.uuid4().hex[:12]}",
                object="chat.completion",
                created=int(time.time()),
                model=model,
                choices=[SimpleNamespace(index=0, message=SimpleNamespace(role="assistant", content=""), finish_reason="stop")],
                usage=SimpleNamespace(prompt_tokens=0, completion_tokens=0, total_tokens=0),
            )

        cand = candidates[0] if isinstance(candidates[0], dict) else {}
        parts = ((cand.get("content") or {}).get("parts") or []) if isinstance(cand, dict) else []

        text_pieces: List[str] = []
        reasoning_pieces: List[str] = []
        tool_calls: List[SimpleNamespace] = []

        for index, part in enumerate(parts):
            if not isinstance(part, dict):
                continue
            if part.get("thought") is True and isinstance(part.get("text"), str):
                reasoning_pieces.append(part["text"])
                continue
            if isinstance(part.get("text"), str):
                text_pieces.append(part["text"])
                continue
            fc = part.get("functionCall")
            if isinstance(fc, dict) and fc.get("name"):
                try:
                    args_str = json.dumps(fc.get("args") or {}, ensure_ascii=False)
                except Exception:
                    args_str = "{}"
                tool_call = SimpleNamespace(
                    id=str(fc.get("id") or f"call_{uuid.uuid4().hex[:12]}"),
                    type="function",
                    index=index,
                    function=SimpleNamespace(name=str(fc["name"]), arguments=args_str),
                )
                extra = _tool_call_extra_from_part(part)
                if extra:
                    tool_call.extra_content = extra
                tool_calls.append(tool_call)

        finish_reason = "tool_calls" if tool_calls else _map_gemini_finish_reason(str(cand.get("finishReason") or "STOP"))
        usage_meta = resp.get("usageMetadata") or {}
        usage = SimpleNamespace(
            prompt_tokens=int(usage_meta.get("promptTokenCount") or 0),
            completion_tokens=int(usage_meta.get("candidatesTokenCount") or 0),
            total_tokens=int(usage_meta.get("totalTokenCount") or 0),
        )

        message = SimpleNamespace(
            role="assistant",
            content="".join(text_pieces) if text_pieces else None,
            tool_calls=tool_calls or None,
            reasoning="".join(reasoning_pieces) if reasoning_pieces else None,
            reasoning_content="".join(reasoning_pieces) if reasoning_pieces else None,
        )

        return SimpleNamespace(
            id=f"chatcmpl-{uuid.uuid4().hex[:12]}",
            object="chat.completion",
            created=int(time.time()),
            model=model,
            choices=[SimpleNamespace(index=0, message=message, finish_reason=finish_reason)],
            usage=usage,
        )

    def _stream_completion(self, *, model: str, payload: Dict[str, Any], timeout: Any = None) -> Iterator[_GeminiStreamChunk]:
        url = f"{self.base_url}/v1internal:streamGenerateContent?alt=sse"
        stream_headers = self._headers()
        stream_headers["Accept"] = "text/event-stream"

        def _generator() -> Iterator[_GeminiStreamChunk]:
            try:
                with self._http.stream("POST", url, json=payload, headers=stream_headers, timeout=timeout) as response:
                    if response.status_code != 200:
                        body_text = read_streaming_error_body(response)
                        raise gemini_http_error(response, body_text=body_text)

                    tool_call_indices: Dict[str, Dict[str, Any]] = {}
                    buffer = ""
                    for chunk in response.iter_text():
                        if not chunk:
                            continue
                        buffer += chunk
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            line = line.rstrip("\r")
                            if not line.startswith("data: "):
                                continue
                            data = line[6:]
                            if data == "[DONE]":
                                return
                            try:
                                event = json.loads(data)
                            except json.JSONDecodeError:
                                continue

                            resp_obj = event.get("response") or event
                            candidates = resp_obj.get("candidates") or []
                            if not candidates:
                                continue
                            cand = candidates[0] if isinstance(candidates[0], dict) else {}
                            parts = ((cand.get("content") or {}).get("parts") or []) if isinstance(cand, dict) else []

                            for part_index, part in enumerate(parts):
                                if not isinstance(part, dict):
                                    continue
                                if part.get("thought") is True and isinstance(part.get("text"), str):
                                    yield _make_stream_chunk(model=model, reasoning=part["text"])
                                    continue
                                if isinstance(part.get("text"), str) and part["text"]:
                                    yield _make_stream_chunk(model=model, content=part["text"])
                                fc = part.get("functionCall")
                                if isinstance(fc, dict) and fc.get("name"):
                                    name = str(fc["name"])
                                    try:
                                        args_str = json.dumps(fc.get("args") or {}, ensure_ascii=False)
                                    except Exception:
                                        args_str = "{}"
                                    thought_sig = str(part.get("thoughtSignature") or "")
                                    call_key = f"{part_index}:{name}:{thought_sig}"
                                    slot = tool_call_indices.get(call_key)
                                    if slot is None:
                                        slot = {
                                            "index": len(tool_call_indices),
                                            "id": str(fc.get("id") or f"call_{uuid.uuid4().hex[:12]}"),
                                            "last_arguments": "",
                                        }
                                        tool_call_indices[call_key] = slot

                                    emitted_args = args_str
                                    last_args = slot["last_arguments"]
                                    if last_args:
                                        if args_str == last_args:
                                            emitted_args = ""
                                        elif args_str.startswith(last_args):
                                            emitted_args = args_str[len(last_args):]
                                    slot["last_arguments"] = args_str

                                    yield _make_stream_chunk(
                                        model=model,
                                        tool_call_delta={
                                            "index": slot["index"],
                                            "id": slot["id"],
                                            "name": name,
                                            "arguments": emitted_args,
                                            "extra_content": _tool_call_extra_from_part(part),
                                        },
                                    )

                            finish_raw = str(cand.get("finishReason") or "")
                            if finish_raw:
                                mapped = "tool_calls" if tool_call_indices else _map_gemini_finish_reason(finish_raw)
                                finish_chunk = _make_stream_chunk(model=model, finish_reason=mapped)
                                usage_meta = resp_obj.get("usageMetadata") or {}
                                if usage_meta:
                                    finish_chunk.usage = SimpleNamespace(
                                        prompt_tokens=int(usage_meta.get("promptTokenCount") or 0),
                                        completion_tokens=int(usage_meta.get("candidatesTokenCount") or 0),
                                        total_tokens=int(usage_meta.get("totalTokenCount") or 0),
                                    )
                                yield finish_chunk

            except httpx.HTTPError as exc:
                raise GeminiAPIError(
                    f"Antigravity Gemini streaming request failed: {exc}",
                    code="gemini_stream_error",
                ) from exc

        return _generator()

    @staticmethod
    def _advance_stream_iterator(iterator: Iterator[_GeminiStreamChunk]) -> tuple[bool, Optional[_GeminiStreamChunk]]:
        try:
            return False, next(iterator)
        except StopIteration:
            return True, None


class _AntigravityChatCompletions:
    def __init__(self, client: AntigravityGeminiClient):
        self._client = client

    def create(self, **kwargs: Any) -> Any:
        return self._client._create_chat_completion(**kwargs)


class _AntigravityChatNamespace:
    def __init__(self, client: AntigravityGeminiClient):
        self.completions = _AntigravityChatCompletions(client)


class AsyncAntigravityGeminiClient:
    """Async facade for Antigravity Gemini client."""

    def __init__(self, sync_client: AntigravityGeminiClient):
        self._sync = sync_client
        self.access_token = sync_client.access_token
        self.base_url = sync_client.base_url
        self.chat = _AsyncAntigravityChatNamespace(self)
        self._real_client = sync_client

    async def _create_chat_completion(self, **kwargs: Any) -> Any:
        stream = bool(kwargs.get("stream"))
        result = await asyncio.to_thread(self._sync.chat.completions.create, **kwargs)
        if not stream:
            return result

        async def _async_stream() -> Any:
            while True:
                done, chunk = await asyncio.to_thread(self._sync._advance_stream_iterator, result)
                if done:
                    break
                yield chunk

        return _async_stream()

    async def close(self) -> None:
        await asyncio.to_thread(self._sync.close)


class _AsyncAntigravityChatCompletions:
    def __init__(self, client: AsyncAntigravityGeminiClient):
        self._client = client

    async def create(self, **kwargs: Any) -> Any:
        return await self._client._create_chat_completion(**kwargs)


class _AsyncAntigravityChatNamespace:
    def __init__(self, client: AsyncAntigravityGeminiClient):
        self.completions = _AsyncAntigravityChatCompletions(client)

from __future__ import annotations

import json
import os
import time
from typing import Any
from urllib import error, request

from .settings import load_dotenv
from .phase1 import phase1_system_prompt

MAX_INLINE_PARTS = 8


class GeminiPhase1Client:
    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        timeout_seconds: int = 30,
        max_attempts: int | None = None,
    ) -> None:
        load_dotenv()
        self.api_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY", "")
        self.model = model or os.getenv("GEMINI_MODEL", "gemini-2.5-pro")
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max_attempts or int(os.getenv("GEMINI_MAX_ATTEMPTS", "3"))

    def is_configured(self) -> bool:
        return bool(self.api_key and not self.api_key.startswith("replace_"))

    def generate_phase1(self, prompt: str, project_context: dict[str, Any]) -> dict[str, Any]:
        if not self.is_configured():
            raise RuntimeError("Gemini API key is not configured.")

        clean_context, inline_parts = _prepare_multimodal_context(project_context)
        return self._generate_json(
            phase1_system_prompt(
                user_prompt=prompt,
                project_context=clean_context,
            ),
            inline_parts=inline_parts,
        )

    def generate_phase2(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.is_configured():
            raise RuntimeError("Gemini API key is not configured.")

        clean_payload, inline_parts = _prepare_multimodal_payload(payload)
        return self._generate_json(json.dumps(clean_payload), inline_parts=inline_parts)

    def _generate_json(self, text_prompt: str, inline_parts: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        endpoint = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent?key={self.api_key}"
        )
        parts = [{"text": text_prompt}]
        parts.extend(inline_parts or [])
        body = {
            "contents": [
                {
                    "role": "user",
                    "parts": parts,
                }
            ],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json",
            },
        }
        encoded = json.dumps(body).encode("utf-8")
        http_request = request.Request(
            endpoint,
            data=encoded,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        last_error: Exception | None = None
        for attempt in range(1, max(1, self.max_attempts) + 1):
            try:
                with request.urlopen(http_request, timeout=self.timeout_seconds) as response:
                    payload = json.loads(response.read().decode("utf-8"))

                text = (
                    payload.get("candidates", [{}])[0]
                    .get("content", {})
                    .get("parts", [{}])[0]
                    .get("text", "")
                )
                if not text:
                    raise RuntimeError("Gemini response did not contain text.")
                return _parse_json_text(text)
            except (error.URLError, json.JSONDecodeError, RuntimeError) as exc:
                last_error = exc
                if attempt >= max(1, self.max_attempts):
                    break
                time.sleep(min(0.4 * attempt, 1.2))

        raise RuntimeError(f"Gemini request failed after {self.max_attempts} attempts: {last_error}") from last_error


def _parse_json_text(text: str) -> dict[str, Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            cleaned = cleaned.removeprefix("json").strip()
        return json.loads(cleaned)


def _prepare_multimodal_payload(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    clean_payload = _strip_inline_content(payload)
    _, inline_parts = _prepare_multimodal_context(payload.get("project_context", {}))
    if inline_parts:
        clean_payload["attachment_delivery"] = {
            "inline_parts_sent_to_model": len(inline_parts) // 2,
            "instruction": "Use inline image/PDF parts as primary evidence for visual or document-specific claims. Distinguish facts by file name when multiple files are attached.",
        }
    return clean_payload, inline_parts


def _prepare_multimodal_context(project_context: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    clean_context = _strip_inline_content(project_context)
    inline_parts = _inline_parts_from_attachments(project_context.get("attachments", []))
    if inline_parts:
        clean_context["attachment_delivery"] = {
            "inline_parts_sent_to_model": len(inline_parts) // 2,
            "instruction": "Image and PDF bytes are attached as Gemini inline parts outside this JSON. Inspect them directly before answering.",
        }
    return clean_context, inline_parts


def _inline_parts_from_attachments(attachments: Any) -> list[dict[str, Any]]:
    if not isinstance(attachments, list):
        return []

    parts: list[dict[str, Any]] = []
    sent_count = 0
    for attachment in attachments:
        if sent_count >= MAX_INLINE_PARTS or not isinstance(attachment, dict):
            break

        data = str(attachment.get("content_base64", ""))
        mime_type = str(attachment.get("inline_mime_type") or attachment.get("type") or "")
        if not data or not mime_type:
            continue

        name = str(attachment.get("name") or f"attachment_{sent_count + 1}")
        kind = str(attachment.get("attachment_kind") or "attachment")
        size = attachment.get("size")
        parts.append(
            {
                "text": (
                    f"Inline {kind} attachment {sent_count + 1}: {name} "
                    f"({mime_type}, {size or 'unknown'} bytes)."
                )
            }
        )
        parts.append(
            {
                "inline_data": {
                    "mime_type": mime_type,
                    "data": data,
                }
            }
        )
        sent_count += 1
    return parts


def _strip_inline_content(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            if key == "content_base64":
                cleaned["content_base64"] = "[sent as inline Gemini part]"
                continue
            cleaned[key] = _strip_inline_content(item)
        return cleaned
    if isinstance(value, list):
        return [_strip_inline_content(item) for item in value]
    return value

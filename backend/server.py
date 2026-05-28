from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from typing import Any
from urllib.parse import urlparse

from . import db
from .gemini_client import GeminiPhase1Client
from .phase1 import Phase1Request, analyze_phase1
from .phase2 import Phase2Request, generate_phase2
from .settings import load_dotenv


load_dotenv()
DEFAULT_DB_PATH = os.getenv("SQLITE_DB_PATH", "./data/claude_chat_prototype.sqlite")
DEFAULT_HOST = os.getenv("PHASE1_HOST") or ("0.0.0.0" if os.getenv("PORT") else "127.0.0.1")
DEFAULT_PORT = int(os.getenv("PORT") or os.getenv("PHASE1_PORT", "8501"))
DEFAULT_CORS_ALLOW_ORIGIN = os.getenv("CORS_ALLOW_ORIGIN", "*")
MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", str(15 * 1024 * 1024)))


class BadRequest(ValueError):
    pass


class PayloadTooLarge(ValueError):
    pass


def make_model_client() -> GeminiPhase1Client | None:
    client = GeminiPhase1Client()
    return client if client.is_configured() else None


class Phase1Handler(BaseHTTPRequestHandler):
    db_path = DEFAULT_DB_PATH
    model_client = make_model_client()
    cors_allow_origin = DEFAULT_CORS_ALLOW_ORIGIN
    max_request_bytes = MAX_REQUEST_BYTES

    def do_OPTIONS(self) -> None:
        self._send_json({"ok": True})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(
                {
                    "ok": True,
                    "service": "phase1",
                    "model_configured": bool(self.model_client and self.model_client.is_configured()),
                }
            )
            return
        self._send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in {"/phase1", "/phase1/clarify", "/phase2"}:
            self._send_json({"error": "Not found"}, status=404)
            return

        try:
            payload = self._read_json()
            if parsed.path == "/phase2":
                phase2_request = Phase2Request(
                    prompt=str(payload.get("prompt", "")),
                    phase1_result=_as_dict(payload.get("phase1_result")),
                    clarification_answers=_as_dict(payload.get("clarification_answers")),
                    selected_output_format=str(payload.get("selected_output_format", "")),
                    project_id=str(payload.get("project_id", "local-project")),
                    session_id=str(payload.get("session_id", "local-session")),
                    attachments=_as_list(payload.get("attachments")),
                    mounted_paths=_as_list(payload.get("mounted_paths")),
                    answer_variant=str(payload.get("answer_variant", "primary")),
                    previous_answer=str(payload.get("previous_answer", "")),
                    judgment_direction=str(payload.get("judgment_direction", "")),
                    answer_history=_as_list(payload.get("answer_history")),
                )
                result = generate_phase2(phase2_request, model_client=self.model_client)
                connection = db.connect(self.db_path)
                try:
                    db.initialize(connection)
                    db.persist_phase2(connection, phase2_request, result)
                finally:
                    connection.close()
                self._send_json(result.to_dict())
                return

            phase_request = Phase1Request(
                prompt=str(payload.get("prompt", "")),
                project_id=str(payload.get("project_id", "local-project")),
                session_id=str(payload.get("session_id", "local-session")),
                attachments=_as_list(payload.get("attachments")),
                mounted_paths=_as_list(payload.get("mounted_paths")),
                current_transaction_id=payload.get("current_transaction_id"),
                clarification_answers=_as_dict(payload.get("clarification_answers")),
                latest_clarification=payload.get("latest_clarification"),
                previous_context=payload.get("previous_context"),
            )
            result = analyze_phase1(phase_request, model_client=self.model_client)
            connection = db.connect(self.db_path)
            try:
                db.initialize(connection)
                db.persist_phase1(connection, phase_request, result)
            finally:
                connection.close()
            self._send_json(result.to_dict())
        except PayloadTooLarge as exc:
            self._send_json({"error": str(exc)}, status=413)
        except BadRequest as exc:
            self._send_json({"error": str(exc)}, status=400)
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=500)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > self.max_request_bytes:
            raise PayloadTooLarge("Request body is too large.")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(body or "{}")
        except json.JSONDecodeError as exc:
            raise BadRequest("Request body must be valid JSON.") from exc
        if not isinstance(payload, dict):
            raise BadRequest("Request body must be a JSON object.")
        return payload

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Access-Control-Allow-Origin", self.cors_allow_origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(encoded)


def run(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, db_path: str = DEFAULT_DB_PATH) -> None:
    Phase1Handler.db_path = db_path
    server = ThreadingHTTPServer((host, port), Phase1Handler)
    print(f"Phase 1 backend listening on http://{host}:{port}")
    server.serve_forever()


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


if __name__ == "__main__":
    run()

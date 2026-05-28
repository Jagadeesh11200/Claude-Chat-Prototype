from __future__ import annotations

import base64
import os
from typing import Any

from backend.gemini_client import GeminiPhase1Client
from backend.phase1 import Phase1Request, analyze_phase1
from backend.phase2 import Phase2Request, generate_phase2
from backend.settings import load_dotenv, load_streamlit_secrets


MAX_PREVIEW_CHARS = 12000
MAX_INLINE_BYTES = 7 * 1024 * 1024


def main() -> None:
    import streamlit as st

    load_dotenv()
    load_streamlit_secrets()

    st.set_page_config(page_title="Guided Claude Backend", layout="wide")
    st.title("Guided Claude Backend Console")
    st.caption("Deployment console for the Python/Gemini orchestration used by the Vercel frontend.")

    configured = bool(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"))
    use_gemini = st.toggle("Use Gemini when configured", value=configured)
    model_client = GeminiPhase1Client() if use_gemini else None
    if model_client and not model_client.is_configured():
        model_client = None
        st.warning("Gemini is not configured. Add GEMINI_API_KEY or GOOGLE_API_KEY in Streamlit secrets.")

    prompt = st.text_area("User prompt", placeholder="Describe a task or ask a question", height=110)
    uploaded_files = st.file_uploader("Optional files", accept_multiple_files=True)
    attachments = [_attachment_from_upload(file) for file in uploaded_files]

    phase1_tab, phase2_tab = st.tabs(["Phase 1 context", "Phase 2 answer"])

    with phase1_tab:
        if st.button("Run Phase 1", type="primary"):
            result = analyze_phase1(
                Phase1Request(prompt=prompt, attachments=attachments),
                model_client=model_client,
            )
            st.session_state["latest_phase1"] = result.to_dict()
            st.json(result.to_dict())

    with phase2_tab:
        phase1_result = st.session_state.get("latest_phase1") or {}
        if not phase1_result:
            st.info("Run Phase 1 first, or paste a Phase 1 result below.")
        pasted_phase1 = st.text_area("Optional Phase 1 JSON override", height=120)
        selected_format = st.text_input("Selected output format", value=phase1_result.get("recommended_output_format", ""))
        if st.button("Run Phase 2", type="primary"):
            if pasted_phase1.strip():
                import json

                phase1_result = json.loads(pasted_phase1)
            result = generate_phase2(
                Phase2Request(
                    prompt=prompt,
                    phase1_result=phase1_result,
                    selected_output_format=selected_format,
                    attachments=attachments,
                ),
                model_client=model_client,
            )
            st.json(result.to_dict())


def _attachment_from_upload(file: Any) -> dict[str, Any]:
    data = file.getvalue()
    mime_type = file.type or _infer_mime(file.name)
    is_text = mime_type.startswith("text/") or _looks_text_like(file.name)
    is_inline = (mime_type.startswith("image/") or mime_type == "application/pdf") and len(data) <= MAX_INLINE_BYTES

    if is_text:
        preview = data[:MAX_PREVIEW_CHARS].decode("utf-8", errors="replace")
    elif mime_type.startswith("image/"):
        preview = f"Image file attached: {file.name} ({mime_type}, {len(data)} bytes)."
    elif mime_type == "application/pdf":
        preview = f"PDF file attached: {file.name} ({len(data)} bytes)."
    else:
        preview = f"File attached: {file.name} ({mime_type}, {len(data)} bytes). Metadata only."

    return {
        "name": file.name,
        "type": mime_type,
        "attachment_kind": "image" if mime_type.startswith("image/") else "pdf" if mime_type == "application/pdf" else "text" if is_text else "binary",
        "size": len(data),
        "last_modified": None,
        "content_preview": preview,
        "image_metadata": {},
        "content_base64": base64.b64encode(data).decode("ascii") if is_inline else "",
        "inline_mime_type": mime_type if is_inline else "",
    }


def _infer_mime(file_name: str) -> str:
    extension = str(file_name or "").rsplit(".", 1)[-1].lower()
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "pdf": "application/pdf",
        "json": "text/plain",
        "md": "text/plain",
        "txt": "text/plain",
        "py": "text/plain",
        "js": "text/plain",
        "jsx": "text/plain",
        "ts": "text/plain",
        "tsx": "text/plain",
        "css": "text/plain",
        "html": "text/plain",
    }.get(extension, "application/octet-stream")


def _looks_text_like(file_name: str) -> bool:
    return _infer_mime(file_name).startswith("text/")


if __name__ == "__main__":
    main()

from __future__ import annotations

import os
from pathlib import Path


def load_dotenv(path: str = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_streamlit_secrets() -> None:
    try:
        import streamlit as st
    except Exception:
        return

    try:
        secrets = st.secrets
    except Exception:
        return

    for key in [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_MODEL",
        "SQLITE_DB_PATH",
        "MAX_REQUEST_BYTES",
    ]:
        try:
            value = secrets.get(key)
        except Exception:
            value = None
        if value is not None and key not in os.environ:
            os.environ[key] = str(value)

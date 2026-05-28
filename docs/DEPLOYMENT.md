# Deployment Guide

## Recommended Topology

- Vercel hosts the React/Vite frontend.
- A Python web host runs `python -m backend.server` for `/phase1`, `/phase1/clarify`, `/phase2`, and `/health`.
- Streamlit Community Cloud hosts `backend/streamlit_app.py` as the Python/Gemini backend console and smoke-test surface.

## Required Secrets

Never commit `.env`.

Backend and Streamlit secrets:

```text
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-pro
SQLITE_DB_PATH=./data/claude_code_prototype.sqlite
MAX_REQUEST_BYTES=15728640
```

Python API host:

```text
PHASE1_HOST=0.0.0.0
PORT=<platform-provided-port>
CORS_ALLOW_ORIGIN=https://your-vercel-app.vercel.app
```

Vercel frontend:

```text
VITE_API_BASE_URL=https://your-python-api-host.example.com
```

## Local Run

```bash
npm install
pip install -r requirements.txt
python -m backend.server
npm run dev
```

Open `http://127.0.0.1:5173`.

## Python API Deployment

Use a Python web service on Render, Railway, Fly.io, Cloud Run, or a similar host.

Build command:

```bash
pip install -r requirements.txt
```

Start command:

```bash
python -m backend.server
```

Health check:

```text
/health
```

## Streamlit Deployment

Deploy `backend/streamlit_app.py` from the repo in Streamlit Community Cloud.

Add secrets in Streamlit app settings:

```toml
GEMINI_API_KEY = "..."
GEMINI_MODEL = "gemini-2.5-pro"
SQLITE_DB_PATH = "./data/claude_code_prototype.sqlite"
```

The Streamlit app is a backend console for running Phase 1 and Phase 2 directly. It is not the REST API consumed by Vercel.

## Vercel Deployment

Connect the repo to Vercel.

Settings:

```text
Framework preset: Vite
Build command: npm run build
Output directory: dist
```

Environment variable:

```text
VITE_API_BASE_URL=https://your-python-api-host.example.com
```

## Persistence Note

SQLite is fine for local demos and prototype API hosts with stable disks. Streamlit Community Cloud local file storage is not guaranteed to persist forever. For production user history, move the DB layer to Postgres, Supabase, Neon, or another managed database.

from __future__ import annotations

from pathlib import Path
import json
import sqlite3
from typing import Any

from .phase1 import Phase1Request, Phase1Result
from .phase2 import Phase2Request, Phase2Result


SCHEMA = """
CREATE TABLE IF NOT EXISTS context_acquisitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  goal TEXT NOT NULL,
  scenario TEXT NOT NULL,
  answer_form TEXT NOT NULL,
  ambiguity_score INTEGER NOT NULL,
  exit_state TEXT NOT NULL,
  reliability_nudge TEXT NOT NULL,
  input_warnings TEXT NOT NULL DEFAULT '[]',
  impact_notes TEXT NOT NULL DEFAULT '[]',
  output_format_options TEXT NOT NULL DEFAULT '[]',
  recommended_output_format TEXT NOT NULL DEFAULT '',
  refined_prompt TEXT NOT NULL,
  model_source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clarifying_questions (
  id TEXT PRIMARY KEY,
  context_acquisition_id TEXT NOT NULL,
  question TEXT NOT NULL,
  user_answer TEXT,
  is_decision_changing INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (context_acquisition_id) REFERENCES context_acquisitions(id)
);

CREATE TABLE IF NOT EXISTS assumptions (
  id TEXT PRIMARY KEY,
  context_acquisition_id TEXT NOT NULL,
  assumption TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (context_acquisition_id) REFERENCES context_acquisitions(id)
);

CREATE TABLE IF NOT EXISTS answer_bundles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  phase1_context_id TEXT,
  answer TEXT NOT NULL,
  reasoning_trace TEXT NOT NULL,
  self_critique TEXT NOT NULL,
  reasoning_confidence TEXT NOT NULL,
  verifiability TEXT NOT NULL,
  model_source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def connect(db_path: str) -> sqlite3.Connection:
    path = Path(db_path)
    if path.parent:
        path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA)
    _ensure_columns(
        connection,
        "context_acquisitions",
        {
            "input_warnings": "TEXT NOT NULL DEFAULT '[]'",
            "impact_notes": "TEXT NOT NULL DEFAULT '[]'",
            "output_format_options": "TEXT NOT NULL DEFAULT '[]'",
            "recommended_output_format": "TEXT NOT NULL DEFAULT ''",
        },
    )
    connection.commit()


def _ensure_columns(
    connection: sqlite3.Connection,
    table_name: str,
    columns: dict[str, str],
) -> None:
    existing = {
        row["name"]
        for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    for column, definition in columns.items():
        if column not in existing:
            connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {column} {definition}")


def persist_phase1(
    connection: sqlite3.Connection,
    request: Phase1Request,
    result: Phase1Result,
) -> None:
    connection.execute(
        """
        INSERT INTO context_acquisitions (
          id, project_id, session_id, prompt, goal, scenario, answer_form,
          ambiguity_score, exit_state, reliability_nudge, input_warnings,
          impact_notes, output_format_options, recommended_output_format,
          refined_prompt, model_source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            result.id,
            request.project_id,
            request.session_id,
            request.prompt,
            result.goal,
            result.scenario,
            result.answer_form,
            result.ambiguity_score,
            result.exit_state,
            result.reliability_nudge,
            json.dumps(result.input_warnings),
            json.dumps(result.impact_notes),
            json.dumps(result.output_format_options),
            result.recommended_output_format,
            result.refined_prompt,
            result.model_source,
        ),
    )
    connection.executemany(
        """
        INSERT INTO clarifying_questions (
          id, context_acquisition_id, question, is_decision_changing
        )
        VALUES (?, ?, ?, ?)
        """,
        [
            (
                f"{result.id}_{question.id}",
                result.id,
                question.question,
                1 if question.is_decision_changing else 0,
            )
            for question in result.questions
        ],
    )
    connection.executemany(
        """
        INSERT INTO assumptions (id, context_acquisition_id, assumption, status)
        VALUES (?, ?, ?, ?)
        """,
        [
            (
                f"{result.id}_{assumption.id}",
                result.id,
                assumption.text,
                assumption.status,
            )
            for assumption in result.assumptions
        ],
    )
    connection.commit()


def count_rows(connection: sqlite3.Connection, table_name: str) -> int:
    row = connection.execute(f"SELECT COUNT(*) AS total FROM {table_name}").fetchone()
    return int(row["total"])


def latest_context(connection: sqlite3.Connection) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT * FROM context_acquisitions
        ORDER BY created_at DESC
        LIMIT 1
        """
    ).fetchone()
    return dict(row) if row else None


def persist_phase2(
    connection: sqlite3.Connection,
    request: Phase2Request,
    result: Phase2Result,
) -> None:
    connection.execute(
        """
        INSERT INTO answer_bundles (
          id, project_id, session_id, prompt, phase1_context_id, answer,
          reasoning_trace, self_critique, reasoning_confidence, verifiability,
          model_source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            result.id,
            request.project_id,
            request.session_id,
            request.prompt,
            request.phase1_result.get("id"),
            result.answer,
            result.reasoning_trace,
            result.self_critique,
            result.reasoning_confidence,
            result.verifiability,
            result.model_source,
        ),
    )
    connection.commit()

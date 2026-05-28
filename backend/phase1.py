from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
import re
from typing import Any, Protocol
from uuid import uuid4


MAX_QUESTIONS = 3
MAX_ASSUMPTIONS = 3
MAX_WARNINGS = 2
MAX_IMPACT_NOTES = 3
PROMPT_CONTRACT_PATH = Path(__file__).with_name("prompts") / "phase1_orchestrator.md"
STOPWORDS = {
    "about",
    "after",
    "also",
    "before",
    "below",
    "could",
    "does",
    "from",
    "have",
    "into",
    "should",
    "that",
    "their",
    "there",
    "these",
    "this",
    "those",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
    "your",
}


class Phase1ModelClient(Protocol):
    def generate_phase1(self, prompt: str, project_context: dict[str, Any]) -> dict[str, Any]:
        """Return structured Phase 1 analysis from a model provider."""


@dataclass
class Phase1Request:
    prompt: str
    project_id: str = "local-project"
    session_id: str = "local-session"
    attachments: list[dict[str, Any]] = field(default_factory=list)
    mounted_paths: list[str] = field(default_factory=list)
    current_transaction_id: str | None = None
    clarification_answers: dict[str, str] = field(default_factory=dict)
    latest_clarification: dict[str, Any] | None = None
    previous_context: dict[str, Any] | None = None


@dataclass
class ClarifyingQuestion:
    id: str
    question: str
    is_decision_changing: bool = True


@dataclass
class Assumption:
    id: str
    text: str
    status: str = "active"


@dataclass
class Phase1Result:
    id: str
    phase: str
    exit_state: str
    goal: str
    scenario: str
    answer_form: str
    ambiguity_score: int
    reliability_nudge: str
    questions: list[ClarifyingQuestion]
    assumptions: list[Assumption]
    input_warnings: list[str]
    impact_notes: list[str]
    output_format_options: list[str]
    recommended_output_format: str
    refined_prompt: str
    model_source: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def analyze_phase1(
    request: Phase1Request,
    model_client: Phase1ModelClient | None = None,
) -> Phase1Result:
    prompt = normalize_prompt(request.prompt)

    if not prompt:
        return _result_from_payload(
            {
                "exit_state": "insufficient_context",
                "goal": "Unknown until the user provides a task.",
                "scenario": "Unknown",
                "answer_form": "clarification",
                "ambiguity_score": 5,
                "reliability_nudge": "I need the intended outcome before I can prepare a useful prompt.",
                "questions": [
                    "What should the agent help you produce, change, explain, or decide?"
                ],
                "assumptions": [],
                "input_warnings": [],
                "impact_notes": [],
                "output_format_options": ["Brief answer", "Step-by-step answer", "Implementation plan"],
                "recommended_output_format": "Brief answer",
                "refined_prompt": "",
            },
            model_source="heuristic",
        )

    if model_client is not None:
        try:
            model_payload = model_client.generate_phase1(
                prompt=prompt,
                project_context=build_project_context(request),
            )
            model_payload = _prepare_payload_for_request(model_payload, request)
            return _result_from_payload(model_payload, model_source="gemini")
        except Exception:
            # Local development and tests should remain usable if the provider is unavailable.
            return _heuristic_phase1(prompt, request, model_source="heuristic_fallback")

    return _heuristic_phase1(prompt, request)


def normalize_prompt(prompt: str) -> str:
    return re.sub(r"\s+", " ", prompt or "").strip()


def build_refined_prompt(
    original_prompt: str,
    answers: dict[str, str] | None = None,
    assumptions: list[str] | None = None,
) -> str:
    parts = [normalize_prompt(original_prompt)]
    cleaned_answers = {
        key: normalize_prompt(value)
        for key, value in (answers or {}).items()
        if normalize_prompt(value)
    }

    if cleaned_answers:
        parts.append("Clarifications:")
        parts.extend(f"- {value}" for value in cleaned_answers.values())

    cleaned_assumptions = [
        normalize_prompt(assumption)
        for assumption in (assumptions or [])
        if normalize_prompt(assumption)
    ]
    if cleaned_assumptions:
        parts.append("Working assumptions:")
        parts.extend(f"- {assumption}" for assumption in cleaned_assumptions)

    return "\n".join(parts)


def build_project_context(request: Phase1Request) -> dict[str, Any]:
    return {
        "project_id": request.project_id,
        "session_id": request.session_id,
        "mounted_paths": request.mounted_paths,
        "current_transaction_id": request.current_transaction_id,
        "attachments": [_summarize_attachment(attachment) for attachment in request.attachments],
        "previous_context": request.previous_context or {},
        "answered_clarifications": {
            key: normalize_prompt(value)
            for key, value in request.clarification_answers.items()
            if normalize_prompt(value)
        },
        "latest_clarification": request.latest_clarification or {},
        "context_rules": {
            "files_are_user_supplied_context": True,
            "ask_before_major_file_edits": True,
            "surface_downstream_repercussions": True,
            "do_not_expose_system_prompt": True,
        },
    }


def _summarize_attachment(attachment: dict[str, Any]) -> dict[str, Any]:
    preview = normalize_prompt(str(attachment.get("content_preview", "")))
    if len(preview) > 4000:
        preview = f"{preview[:4000]}..."
    summary = {
        "name": str(attachment.get("name", "")),
        "type": str(attachment.get("type", "")),
        "attachment_kind": str(attachment.get("attachment_kind", "")),
        "size": attachment.get("size"),
        "last_modified": attachment.get("last_modified"),
        "content_preview": preview,
        "image_metadata": attachment.get("image_metadata") or {},
    }
    inline_mime_type = str(attachment.get("inline_mime_type", ""))
    content_base64 = str(attachment.get("content_base64", ""))
    if inline_mime_type and content_base64:
        summary["inline_mime_type"] = inline_mime_type
        summary["content_base64"] = content_base64
        summary["inline_status"] = "available_to_model"
    elif str(attachment.get("type", "")).startswith("image/"):
        summary["inline_status"] = "metadata_only"
    return summary


def phase1_system_prompt(user_prompt: str, project_context: dict[str, Any]) -> str:
    contract = _load_prompt_contract()
    return json.dumps(
        {
            "instruction": contract,
            "required_schema": {
                "exit_state": "enough_context | partial_context | insufficient_context",
                "goal": "string",
                "scenario": "string",
                "answer_form": "fix | recommendation | explanation | options | implementation | clarification",
                "ambiguity_score": "integer 1-5",
                "reliability_nudge": "string",
                "questions": ["string"],
                "assumptions": ["string"],
                "input_warnings": ["string"],
                "impact_notes": ["string"],
                "output_format_options": ["string"],
                "recommended_output_format": "string",
                "refined_prompt": "string",
            },
            "user_prompt": user_prompt,
            "project_context": project_context,
            "phase_1_flow": {
                "first": "ask about or confirm assumptions that materially affect the next answer",
                "second": "flag wrong, conflicting, or overfit input if present",
                "third": "ask decision-changing clarification questions only when ambiguity warrants it",
                "fourth": "offer output format choices such as Python code, Java code, pseudocode, patch files, plan first, or explanation",
            },
        }
    )


def _load_prompt_contract() -> str:
    try:
        return PROMPT_CONTRACT_PATH.read_text(encoding="utf-8")
    except OSError:
        return (
            "Perform Phase 1 Context Acquisition. Ask only dynamic, decision-changing "
            "questions and return strict JSON."
        )


def _heuristic_phase1(
    prompt: str,
    request: Phase1Request,
    model_source: str = "heuristic",
) -> Phase1Result:
    ambiguity_score = _score_ambiguity(prompt, request)
    answer_form = _infer_answer_form(prompt)
    scenario = _infer_scenario(prompt)
    goal = _infer_goal(prompt, answer_form)
    exit_state = _exit_state(ambiguity_score)
    questions = _decision_questions(prompt, answer_form, ambiguity_score)
    questions = _filter_answered_questions(questions, request.clarification_answers)
    assumptions = _assumptions(prompt, request, questions)
    input_warnings = _input_warnings(prompt)
    impact_notes = _impact_notes(prompt, request)
    output_format_options = _output_format_options(prompt, answer_form)
    assumptions = _filter_resolved_items(assumptions, request)
    input_warnings = _filter_resolved_items(input_warnings, request)
    impact_notes = _filter_resolved_items(impact_notes, request)
    if input_warnings and exit_state == "enough_context":
        ambiguity_score = max(3, ambiguity_score)
        exit_state = "partial_context"
    reliability_nudge = _nudge(exit_state, answer_form)

    payload = {
        "exit_state": exit_state,
        "goal": goal,
        "scenario": scenario,
        "answer_form": answer_form,
        "ambiguity_score": ambiguity_score,
        "reliability_nudge": reliability_nudge,
        "questions": questions,
        "assumptions": assumptions,
        "input_warnings": input_warnings,
        "impact_notes": impact_notes,
        "output_format_options": output_format_options,
        "recommended_output_format": output_format_options[0],
        "refined_prompt": build_refined_prompt(
            prompt,
            answers=request.clarification_answers,
            assumptions=assumptions,
        ),
    }
    return _result_from_payload(
        _prepare_payload_for_request(payload, request),
        model_source=model_source,
    )


def _prepare_payload_for_request(
    payload: dict[str, Any],
    request: Phase1Request,
) -> dict[str, Any]:
    prepared = dict(payload)
    prepared["assumptions"] = _filter_resolved_items(
        _as_string_list(prepared.get("assumptions")),
        request,
    )[:MAX_ASSUMPTIONS]
    prepared["input_warnings"] = _filter_resolved_items(
        _as_string_list(prepared.get("input_warnings")),
        request,
    )[:MAX_WARNINGS]
    prepared["impact_notes"] = _filter_resolved_items(
        _as_string_list(prepared.get("impact_notes")),
        request,
    )[:MAX_IMPACT_NOTES]
    prepared["questions"] = _filter_resolved_items(
        _as_string_list(prepared.get("questions")),
        request,
    )[:MAX_QUESTIONS]
    prepared["output_format_options"] = _as_string_list(
        prepared.get("output_format_options")
    )[:3]

    _apply_segment_budgets(prepared, request)

    if request.clarification_answers:
        _cap_unresolved_items(prepared, request)
        _apply_segment_budgets(prepared, request)

    return prepared


def _apply_segment_budgets(payload: dict[str, Any], request: Phase1Request) -> None:
    has_file_context = bool(request.attachments or request.mounted_paths)

    assumption_question_budget = 4 if has_file_context else 3
    question_cap = 3 if has_file_context else 2
    impact_cap = 2 if has_file_context else 0

    assumptions = list(payload.get("assumptions") or [])
    questions = list(payload.get("questions") or [])

    if questions and assumptions:
        kept_questions = questions[: min(question_cap, max(1, assumption_question_budget - 1))]
        kept_assumptions = assumptions[: max(0, assumption_question_budget - len(kept_questions))]
    elif questions:
        kept_questions = questions[: min(question_cap, assumption_question_budget)]
        kept_assumptions = []
    else:
        kept_questions = []
        kept_assumptions = assumptions[:assumption_question_budget]

    payload["assumptions"] = kept_assumptions
    payload["questions"] = kept_questions
    payload["input_warnings"] = list(payload.get("input_warnings") or [])[:MAX_WARNINGS]
    payload["impact_notes"] = list(payload.get("impact_notes") or [])[:impact_cap]


def _as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [normalize_prompt(_payload_item_text(item)) for item in value if normalize_prompt(_payload_item_text(item))]


def _payload_item_text(value: Any) -> str:
    if isinstance(value, dict):
        return str(
            value.get("question")
            or value.get("prompt")
            or value.get("text")
            or value.get("assumption")
            or value.get("body")
            or ""
        )
    return str(value)


def _cap_unresolved_items(payload: dict[str, Any], request: Phase1Request) -> None:
    previous_count = _count_previous_unresolved(request.previous_context or {})
    if previous_count <= 0:
        return

    max_next_count = max(0, previous_count - 1)
    ordered_keys = ["assumptions", "input_warnings", "impact_notes", "questions"]
    remaining = max_next_count

    for key in ordered_keys:
        items = list(payload.get(key) or [])
        payload[key] = items[:remaining]
        remaining -= len(payload[key])
        if remaining <= 0:
            for later_key in ordered_keys[ordered_keys.index(key) + 1:]:
                payload[later_key] = []
            break


def _count_previous_unresolved(previous_context: dict[str, Any]) -> int:
    return (
        len(previous_context.get("assumptions") or [])
        + len(previous_context.get("input_warnings") or [])
        + len(previous_context.get("impact_notes") or [])
        + len(previous_context.get("questions") or [])
    )


def _filter_resolved_items(items: list[str], request: Phase1Request) -> list[str]:
    if not request.clarification_answers and not request.latest_clarification:
        return items

    resolved_text = _resolved_answer_text(request)
    if not resolved_text:
        return items

    return [
        item
        for item in items
        if not _item_is_resolved_by_answer(item, resolved_text)
    ]


def _resolved_answer_text(request: Phase1Request) -> str:
    values = [
        normalize_prompt(str(value))
        for value in request.clarification_answers.values()
        if normalize_prompt(str(value))
    ]
    latest = request.latest_clarification or {}
    for key in ("body", "value", "type", "title"):
        if normalize_prompt(str(latest.get(key, ""))):
            values.append(normalize_prompt(str(latest[key])))
    return " ".join(values).lower()


def _item_is_resolved_by_answer(item: str, answer_text: str) -> bool:
    lowered_item = item.lower()
    if lowered_item and lowered_item in answer_text:
        return True

    answered_paths = set(
        match.group(0).lower()
        for match in re.finditer(r"\b[\w./-]+\.(py|js|jsx|ts|tsx|md|json|css|html)\b", answer_text)
    )
    if answered_paths and any(path in lowered_item for path in answered_paths):
        return True

    target_question = any(
        token in lowered_item
        for token in [
            "which file",
            "which function",
            "which folder",
            "project area",
            "target file",
            "target function",
            "should be changed",
        ]
    )
    if target_question:
        if re.search(r"\b[\w./-]+\.(py|js|jsx|ts|tsx|md|json|css|html)\b", answer_text):
            return True
        if any(token in answer_text for token in ["function", "folder", "src/", "backend", "frontend"]):
            return True

    if any(token in lowered_item for token in ["caller", "test", "import", "doc", "dependent"]):
        if any(token in answer_text for token in ["caller", "callers", "test", "tests", "import", "imports", "doc", "docs", "include"]):
            return True

    if any(token in lowered_item for token in ["range", "number", "input", "value"]):
        if re.search(r"\b\d+\s*[-to]+\s*\d+\b", answer_text) or any(token in answer_text for token in ["range", "numbers", "integers", "floats"]):
            return True

    item_tokens = _meaningful_tokens(lowered_item)
    answer_tokens = _meaningful_tokens(answer_text)
    if not item_tokens or not answer_tokens:
        return False

    overlap = item_tokens & answer_tokens
    return len(overlap) >= 3 or (len(overlap) / max(1, len(item_tokens))) >= 0.45


def _meaningful_tokens(text: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-zA-Z0-9_./-]+", text.lower())
        if len(token) > 3 and token not in STOPWORDS
    }


def _score_ambiguity(prompt: str, request: Phase1Request) -> int:
    lowered = prompt.lower()
    score = 2

    vague_phrases = [
        "fix this",
        "make it better",
        "improve it",
        "help me",
        "do this",
        "review this",
        "what do you think",
        "optimize this",
        "create something",
    ]
    if any(phrase in lowered for phrase in vague_phrases):
        score += 2

    if len(prompt.split()) < 6:
        score += 2
    elif len(prompt.split()) < 12:
        score += 1

    if _is_named_algorithm_request(lowered):
        score -= 2

    if not request.attachments and not request.mounted_paths and any(
        token in lowered for token in ["this", "it", "file", "code", "project"]
    ):
        score += 1

    if any(token in lowered for token in ["using", "because", "so that", "for ", "deploy", "test"]):
        score -= 1

    if any(token in lowered for token in ["must", "only", "exactly", "phase", "sqlite", "react", "python"]):
        score -= 1

    if request.attachments:
        score -= 1

    return max(1, min(5, score))


def _infer_answer_form(prompt: str) -> str:
    lowered = prompt.lower()
    if any(token in lowered for token in ["code", "algorithm", "function", "bucket sort"]):
        return "implementation"
    if any(token in lowered for token in ["implement", "build", "develop", "create", "add", "wire"]):
        return "implementation"
    if any(token in lowered for token in ["fix", "bug", "error", "failing", "broken"]):
        return "fix"
    if any(token in lowered for token in ["choose", "recommend", "best", "should we"]):
        return "recommendation"
    if any(token in lowered for token in ["explain", "understand", "why", "how does"]):
        return "explanation"
    if any(token in lowered for token in ["options", "compare", "tradeoff"]):
        return "options"
    return "clarification"


def _infer_scenario(prompt: str) -> str:
    lowered = prompt.lower()
    if any(token in lowered for token in ["bucket sort", "algorithm", "data structure", "leetcode"]):
        return "Algorithm and code generation"
    if any(token in lowered for token in ["react", "frontend", "vercel", "ui", "component"]):
        return "Frontend application development"
    if any(token in lowered for token in ["python", "streamlit", "sqlite", "backend", "api"]):
        return "Backend and local data workflow"
    if any(token in lowered for token in ["agent", "gemini", "model", "prompt"]):
        return "Agentic prompt and reasoning workflow"
    if any(token in lowered for token in ["deploy", "deployment"]):
        return "Deployment planning"
    return "General project assistance"


def _infer_goal(prompt: str, answer_form: str) -> str:
    if answer_form == "implementation":
        return f"Implement the requested change: {prompt}"
    if answer_form == "fix":
        return f"Find and fix the issue described by the user: {prompt}"
    if answer_form == "recommendation":
        return f"Recommend a path forward for: {prompt}"
    if answer_form == "explanation":
        return f"Explain the requested topic: {prompt}"
    if answer_form == "options":
        return f"Compare viable options for: {prompt}"
    return f"Clarify the user's intended task: {prompt}"


def _exit_state(ambiguity_score: int) -> str:
    if ambiguity_score <= 2:
        return "enough_context"
    if ambiguity_score <= 4:
        return "partial_context"
    return "insufficient_context"


def _decision_questions(prompt: str, answer_form: str, ambiguity_score: int) -> list[str]:
    if ambiguity_score <= 2:
        return []

    lowered = prompt.lower()
    questions: list[str] = []

    if _is_file_modification_request(lowered):
        questions.append("Which file, function, or project area should be changed?")
        questions.append("Should I update affected callers, tests, imports, and docs when they depend on this change?")

    if not questions and any(token in lowered for token in ["this", "it", "file", "code", "project"]) and not any(
        token in lowered for token in ["attached", "mounted", "current repo", "current project"]
    ):
        questions.append("Which file, folder, or project area should I treat as the target?")

    if answer_form in {"implementation", "fix"} and not any(
        token in lowered for token in ["test", "acceptance", "done", "expected", "so that"]
    ):
        questions.append("What outcome would make this done or correct?")

    if answer_form == "recommendation":
        questions.append("What constraint matters most: speed, reliability, cost, or user experience?")

    if not questions:
        questions.append("What specific output do you want from the agent for this request?")

    return questions[:MAX_QUESTIONS]


def _filter_answered_questions(
    questions: list[str],
    answers: dict[str, str],
) -> list[str]:
    answer_text = " ".join(normalize_prompt(value).lower() for value in answers.values())
    if not answer_text:
        return questions[:MAX_QUESTIONS]

    filtered: list[str] = []
    for question in questions:
        lowered = question.lower()
        if "which file" in lowered and any(token in answer_text for token in ["file", ".py", ".js", "function", "folder", "src/"]):
            continue
        if "affected callers" in lowered and any(token in answer_text for token in ["yes", "include", "tests", "imports", "docs", "callers"]):
            continue
        if "outcome" in lowered and len(answer_text.split()) > 4:
            continue
        filtered.append(question)

    return filtered[:MAX_QUESTIONS]


def _assumptions(
    prompt: str,
    request: Phase1Request,
    questions: list[str],
) -> list[str]:
    lowered = prompt.lower()
    assumptions: list[str] = []

    if request.mounted_paths:
        assumptions.append("I'm assuming the mounted project folders are the source of truth.")
    elif request.attachments:
        names = ", ".join(
            str(attachment.get("name", "attached file"))
            for attachment in request.attachments[:3]
        )
        assumptions.append(f"I'm assuming the attached file context is relevant: {names}.")
    else:
        assumptions.append("I'm assuming the current local project is the source of truth.")

    if "bucket sort" in lowered:
        assumptions.append("I'm assuming bucket sort should handle numeric inputs with a known value range unless you specify otherwise.")

    if "gemini" not in lowered and "model" not in lowered:
        assumptions.append("I'm assuming Phase 1 should prepare a better prompt before answer generation.")

    if questions:
        assumptions.append("I'm assuming no file edits should be proposed until these clarifications are resolved.")

    return assumptions


def _input_warnings(prompt: str) -> list[str]:
    lowered = prompt.lower()
    warnings: list[str] = []

    if "bucket sort" in lowered and any(token in lowered for token in ["o(1)", "constant time"]):
        warnings.append("Bucket sort cannot generally guarantee constant-time sorting; that constraint looks incorrect unless the data is extremely bounded.")

    if "bucket sort" in lowered and any(token in lowered for token in ["no extra memory", "in-place", "in place"]):
        warnings.append("Bucket sort normally uses auxiliary buckets, so an in-place or no-extra-memory requirement may conflict with the algorithm.")

    if any(token in lowered for token in ["always best", "all cases", "never fails"]):
        warnings.append("The wording sounds over-broad; the next answer should avoid treating it as universally true without constraints.")

    return warnings


def _impact_notes(prompt: str, request: Phase1Request) -> list[str]:
    lowered = prompt.lower()
    if not _is_file_modification_request(lowered):
        return []

    notes = [
        "Changing an existing function can affect its callers, tests, imports, type contracts, and documentation."
    ]

    if request.mounted_paths or request.attachments:
        notes.append("I can inspect the provided project context before proposing edits so dependent files are included upfront.")
    else:
        notes.append("I need the target file or mounted project context before I can list exact dependent functions or files.")

    return notes


def _output_format_options(prompt: str, answer_form: str) -> list[str]:
    lowered = prompt.lower()
    if _is_file_modification_request(lowered):
        return ["Patch files", "Plan first", "Code explanation"]
    if any(token in lowered for token in ["bucket sort", "algorithm", "code"]):
        return ["Python code", "Java code", "Pseudocode"]
    if answer_form in {"implementation", "fix"}:
        return ["Patch files", "Plan first", "Code explanation"]
    if answer_form == "recommendation":
        return ["Recommendation", "Options table", "Pros and cons"]
    if answer_form == "explanation":
        return ["Concise explanation", "Step-by-step explanation", "Example-driven explanation"]
    return ["Brief answer", "Step-by-step answer", "Options"]


def _is_named_algorithm_request(lowered_prompt: str) -> bool:
    return any(token in lowered_prompt for token in ["bucket sort", "merge sort", "quick sort", "binary search"])


def _is_file_modification_request(lowered_prompt: str) -> bool:
    return any(token in lowered_prompt for token in ["change this function", "modify this function", "refactor this function", "change this file", "modify this file"])


def _nudge(exit_state: str, answer_form: str) -> str:
    if exit_state == "enough_context":
        return "I have enough context to prepare the prompt for the answering phase."
    if answer_form in {"implementation", "fix"}:
        return "Target area and success criteria would make the implementation prompt reliable."
    return "Goal, constraints, and desired output format would make the next answer more reliable."


def _result_from_payload(payload: dict[str, Any], model_source: str) -> Phase1Result:
    ambiguity = int(payload.get("ambiguity_score", 5))
    ambiguity = max(1, min(5, ambiguity))
    exit_state = payload.get("exit_state") or _exit_state(ambiguity)

    raw_questions = payload.get("questions") or []
    questions = [
        ClarifyingQuestion(id=f"q_{index + 1}", question=normalize_prompt(_question_text(question)))
        for index, question in enumerate(raw_questions[:MAX_QUESTIONS])
        if normalize_prompt(_question_text(question))
    ]

    raw_assumptions = payload.get("assumptions") or []
    assumptions = [
        Assumption(id=f"a_{index + 1}", text=normalize_prompt(_assumption_text(assumption)))
        for index, assumption in enumerate(raw_assumptions)
        if normalize_prompt(_assumption_text(assumption))
    ]

    input_warnings = [
        normalize_prompt(str(warning))
        for warning in (payload.get("input_warnings") or [])
        if normalize_prompt(str(warning))
    ]
    impact_notes = [
        normalize_prompt(str(note))
        for note in (payload.get("impact_notes") or [])
        if normalize_prompt(str(note))
    ]
    output_format_options = [
        normalize_prompt(str(option))
        for option in (payload.get("output_format_options") or [])
        if normalize_prompt(str(option))
    ]
    if not output_format_options:
        output_format_options = ["Brief answer", "Step-by-step answer", "Options"]

    recommended_output_format = normalize_prompt(
        str(payload.get("recommended_output_format") or output_format_options[0])
    )

    refined_prompt = str(payload.get("refined_prompt") or "").strip()
    if not refined_prompt:
        refined_prompt = build_refined_prompt(
            str(payload.get("goal") or ""),
            assumptions=[assumption.text for assumption in assumptions],
        )

    return Phase1Result(
        id=f"ctx_{uuid4().hex[:12]}",
        phase="context_acquisition",
        exit_state=exit_state,
        goal=normalize_prompt(str(payload.get("goal") or "Clarify the user's task.")),
        scenario=normalize_prompt(str(payload.get("scenario") or "General project assistance")),
        answer_form=normalize_prompt(str(payload.get("answer_form") or "clarification")),
        ambiguity_score=ambiguity,
        reliability_nudge=normalize_prompt(str(payload.get("reliability_nudge") or "")),
        questions=questions,
        assumptions=assumptions,
        input_warnings=input_warnings,
        impact_notes=impact_notes,
        output_format_options=output_format_options,
        recommended_output_format=recommended_output_format,
        refined_prompt=refined_prompt,
        model_source=model_source,
    )


def _question_text(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("question") or value.get("prompt") or value.get("body") or value.get("text") or "")
    return str(value)


def _assumption_text(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("text") or value.get("assumption") or value.get("body") or value.get("question") or "")
    return str(value)

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from .phase1 import build_project_context, normalize_prompt, Phase1Request


PROMPT_CONTRACT_PATH = Path(__file__).with_name("prompts") / "phase2_answer_bundle.md"


class Phase2ModelClient(Protocol):
    def generate_phase2(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Return structured Phase 2 answer bundle from a model provider."""


@dataclass
class Phase2Request:
    prompt: str
    phase1_result: dict[str, Any]
    clarification_answers: dict[str, str] = field(default_factory=dict)
    selected_output_format: str = ""
    project_id: str = "local-project"
    session_id: str = "local-session"
    attachments: list[dict[str, Any]] = field(default_factory=list)
    mounted_paths: list[str] = field(default_factory=list)
    answer_variant: str = "primary"
    previous_answer: str = ""
    judgment_direction: str = ""
    answer_history: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Phase2Result:
    id: str
    phase: str
    answer: str
    reasoning_trace: str
    self_critique: str
    reasoning_confidence: str
    verifiability: str
    model_source: str
    why_claims: list[dict[str, str]] = field(default_factory=list)
    uncertainty_claims: list[dict[str, str]] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    change_factors: list[str] = field(default_factory=list)
    verifiable_claims: list[dict[str, str]] = field(default_factory=list)
    alternative_summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def generate_phase2(
    request: Phase2Request,
    model_client: Phase2ModelClient | None = None,
) -> Phase2Result:
    if not normalize_prompt(request.prompt):
        return _heuristic_phase2(
            Phase2Request(
                prompt=request.prompt,
                phase1_result={
                    **(request.phase1_result or {}),
                    "exit_state": "insufficient_context",
                },
                clarification_answers=request.clarification_answers,
                selected_output_format=request.selected_output_format,
                project_id=request.project_id,
                session_id=request.session_id,
                attachments=request.attachments,
                mounted_paths=request.mounted_paths,
                answer_history=request.answer_history,
            )
        )

    if model_client is not None:
        payload = build_phase2_model_payload(request)
        last_payload: dict[str, Any] | None = None
        for attempt in range(1, 4):
            try:
                model_payload = model_client.generate_phase2(payload)
                last_payload = model_payload
                issues = _phase2_payload_issues(model_payload)
                if not issues:
                    return _result_from_payload(model_payload, model_source="gemini", request=request)
                payload = {
                    **payload,
                    "retry_feedback": {
                        "attempt": attempt,
                        "issues": issues,
                        "instruction": (
                            "Regenerate the full strict JSON answer bundle. The answer must be non-empty, "
                            "why_claims and uncertainty_claims are mandatory, and every claim quote must "
                            "appear exactly in answer so the UI can render it."
                        ),
                    },
                }
            except Exception as exc:
                payload = {
                    **payload,
                    "retry_feedback": {
                        "attempt": attempt,
                        "issues": [str(exc)],
                        "instruction": "Retry and return only strict JSON matching the required schema.",
                    },
                }
        if last_payload is not None:
            return _result_from_payload(last_payload, model_source="gemini", request=request)
        return _heuristic_phase2(request, model_source="heuristic_fallback")

    return _heuristic_phase2(request)


def build_phase2_model_payload(request: Phase2Request) -> dict[str, Any]:
    phase1_request = Phase1Request(
        prompt=request.prompt,
        project_id=request.project_id,
        session_id=request.session_id,
        attachments=request.attachments,
        mounted_paths=request.mounted_paths,
        clarification_answers=request.clarification_answers,
        previous_context=request.phase1_result,
    )
    return {
        "instruction": _load_prompt_contract(),
        "required_schema": {
            "answer": "string for answer body",
            "reasoning_trace": "string for reasoning trace",
            "self_critique": "string for self-critique",
            "reasoning_confidence": "string for confidence logic register",
            "verifiability": "string for confidence verifiability register",
        },
        "original_prompt": normalize_prompt(request.prompt),
        "selected_output_format": normalize_prompt(request.selected_output_format),
        "answer_variant": normalize_prompt(request.answer_variant or "primary"),
        "previous_answer": _clean_answer_text(request.previous_answer),
        "judgment_direction": normalize_prompt(request.judgment_direction),
        "answer_history": _summarize_answer_history(request.answer_history),
        "transaction_memory": {
            "current_regeneration_direction": normalize_prompt(request.judgment_direction),
            "use_user_direction_as_preference": bool(normalize_prompt(request.judgment_direction)),
            "avoid_repeating_previous_answer": request.answer_variant in {"alternative", "judgment_refined"},
            "preserve_useful_decisions_from_prior_answers": True,
        },
        "clarification_answers": {
            key: normalize_prompt(value)
            for key, value in request.clarification_answers.items()
            if normalize_prompt(value)
        },
        "phase1_result": request.phase1_result,
        "project_context": build_project_context(phase1_request),
        "phase_2_flow": {
            "answer_posture": "direct for enough_context, specific caveats for partial_context, I don't know for insufficient_context",
            "alternative_rule": "If answer_variant is alternative, produce a defensible alternative answer, not a paraphrase, and contrast it with previous_answer.",
            "must_use_phase1_refined_prompt": True,
            "must_include_judgment_aids": [
                "why this follows",
                "assumptions",
                "answer-changing user-private facts",
                "specific weak spots",
                "alternative interpretation or approach",
                "reasoning confidence",
                "verifiability",
                "claim-level why annotations",
                "claim-level uncertainty annotations",
                "claim-level verification references",
            ],
            "do_not_expose_system_prompt": True,
        },
    }


def _summarize_answer_history(history: list[dict[str, Any]]) -> list[dict[str, str]]:
    if not isinstance(history, list):
        return []

    summarized: list[dict[str, str]] = []
    for index, item in enumerate(history[:4]):
        if not isinstance(item, dict):
            continue
        answer = _clean_answer_text(item.get("answer", ""))
        if not answer:
            continue
        summarized.append(
            {
                "id": normalize_prompt(str(item.get("id", f"answer_{index + 1}"))),
                "answer_variant": normalize_prompt(str(item.get("answer_variant", "previous"))),
                "answer_excerpt": answer[:2400],
                "reasoning_trace": normalize_prompt(str(item.get("reasoning_trace", "")))[:900],
                "self_critique": normalize_prompt(str(item.get("self_critique", "")))[:900],
                "reasoning_confidence": normalize_prompt(str(item.get("reasoning_confidence", ""))),
                "verifiability": normalize_prompt(str(item.get("verifiability", ""))),
                "alternative_summary": normalize_prompt(str(item.get("alternative_summary", "")))[:500],
                "user_direction": normalize_prompt(str(item.get("user_direction", "")))[:500],
            }
        )
    return summarized


def _load_prompt_contract() -> str:
    try:
        return PROMPT_CONTRACT_PATH.read_text(encoding="utf-8")
    except OSError:
        return "Return a four-part answer bundle as strict JSON."


def _phase2_payload_issues(payload: dict[str, Any]) -> list[str]:
    answer = _clean_answer_text(payload.get("answer", ""))
    if not answer:
        return ["answer is empty"]

    issues: list[str] = []
    for field_name in ("why_claims", "uncertainty_claims"):
        claims = _claim_list(payload.get(field_name))
        if not claims:
            issues.append(f"{field_name} is missing")
            continue
        for claim in claims:
            quote = claim.get("quote", "")
            if quote and quote.lower() not in answer.lower():
                issues.append(f"{field_name} quote does not appear in answer: {quote[:80]}")

    for claim in _claim_list(payload.get("verifiable_claims"), reference_key="reference"):
        quote = claim.get("quote", "")
        if quote and quote.lower() not in answer.lower():
            issues.append(f"verifiable_claims quote does not appear in answer: {quote[:80]}")

    return issues


def _heuristic_phase2(
    request: Phase2Request,
    model_source: str = "heuristic",
) -> Phase2Result:
    phase1 = request.phase1_result or {}
    exit_state = phase1.get("exit_state", "partial_context")
    selected_format = request.selected_output_format or phase1.get("recommended_output_format") or "Brief answer"
    refined_prompt = phase1.get("refined_prompt") or request.prompt
    assumptions = _collect_assumptions(phase1, request.clarification_answers)
    direction = normalize_prompt(request.judgment_direction)

    if exit_state == "insufficient_context":
        answer = (
            "I don't know yet. I need the missing clarification requested in Phase 1 "
            "before I can produce a reliable answer."
        )
    elif not normalize_prompt(request.prompt):
        answer = "I don't know. I need the user prompt before I can answer."
    else:
        caveat = ""
        if exit_state == "partial_context":
            caveat = " Specific caveat: unresolved Phase 1 items may affect exact implementation details."
        prefix = "Alternative approach: " if request.answer_variant == "alternative" else ""
        answer = f"{prefix}{selected_format}: {refined_prompt}.{caveat}"
        if direction:
            answer += f" Regenerated direction applied: {direction}."

    assumption_list = _assumption_list(phase1, request.clarification_answers)
    change_factors = [
        "Target runtime, exact file contracts, preferred language/framework, or acceptance criteria would change the answer."
    ]
    if direction:
        change_factors.insert(0, f"The answer was regenerated toward this user direction: {direction}.")

    return Phase2Result(
        id=f"ans_{uuid4().hex[:12]}",
        phase="answer_evaluation",
        answer=answer,
        reasoning_trace=(
            "This follows from the original prompt, Phase 1 inferred intent, and the user's "
            f"clarifications. Assumptions: {assumptions or 'none recorded'}. "
            "User-private details that could change this: target runtime, exact file contracts, "
            "preferred language/framework, and acceptance criteria."
        ),
        self_critique=(
            "The answer is thinnest where Phase 1 still lacks concrete project-specific details. "
            "I left unresolved ambiguity in place instead of inventing facts. Alternative approach: "
            "ask for one more concrete example or target file before answering."
        ),
        reasoning_confidence=_confidence_for_exit_state(exit_state),
        verifiability="This is partly checkable against project files/tests and partly a judgment call about intent.",
        model_source=model_source,
        why_claims=[
            {
                "quote": _first_sentence(answer),
                "explanation": "This follows from the original prompt, refined context, and selected output format.",
            }
        ],
        uncertainty_claims=_heuristic_uncertainty_claims(answer, exit_state),
        assumptions=assumption_list or ([assumptions] if assumptions else []),
        change_factors=change_factors,
        verifiable_claims=[],
        alternative_summary="A more conservative alternative is to ask for one more concrete example before answering.",
    )


def _collect_assumptions(phase1: dict[str, Any], answers: dict[str, str]) -> str:
    return "; ".join(_assumption_list(phase1, answers))


def _assumption_list(phase1: dict[str, Any], answers: dict[str, str]) -> list[str]:
    raw_assumptions = phase1.get("assumptions") or []
    assumptions = []
    for item in raw_assumptions:
        if isinstance(item, dict):
            assumptions.append(str(item.get("text", "")))
        else:
            assumptions.append(str(item))
    assumptions.extend(str(value) for value in answers.values() if normalize_prompt(str(value)))
    cleaned = [normalize_prompt(item) for item in assumptions if normalize_prompt(item)]
    return cleaned


def _confidence_for_exit_state(exit_state: str) -> str:
    if exit_state == "enough_context":
        return "High: Phase 1 indicated enough context for the answer."
    if exit_state == "insufficient_context":
        return "Low: Phase 1 indicated insufficient context."
    return "Medium: the logic follows, but specific unresolved context may affect details."


def _heuristic_uncertainty_claims(answer: str, exit_state: str) -> list[dict[str, str]]:
    if exit_state == "partial_context" and "unresolved Phase 1 items may affect exact implementation details" in answer:
        return [
            {
                "quote": "unresolved Phase 1 items may affect exact implementation details",
                "explanation": "The context check did not fully resolve every project-specific detail.",
            }
        ]

    quote = _first_sentence(answer)
    if not quote:
        return []
    return [
        {
            "quote": quote,
            "explanation": "This is the answer's most assumption-dependent part under the available context.",
        }
    ]


def _result_from_payload(
    payload: dict[str, Any],
    model_source: str,
    request: Phase2Request | None = None,
) -> Phase2Result:
    request = request or Phase2Request(prompt="", phase1_result={})
    phase1 = request.phase1_result or {}
    exit_state = str(phase1.get("exit_state") or "partial_context")
    fallback = _heuristic_phase2(request, model_source=model_source)
    answer = _clean_answer_text(payload.get("answer", ""))
    if exit_state == "insufficient_context" and "i don't know" not in answer.lower():
        answer = fallback.answer

    return Phase2Result(
        id=f"ans_{uuid4().hex[:12]}",
        phase="answer_evaluation",
        answer=answer or fallback.answer,
        reasoning_trace=normalize_prompt(str(payload.get("reasoning_trace", ""))) or fallback.reasoning_trace,
        self_critique=normalize_prompt(str(payload.get("self_critique", ""))) or fallback.self_critique,
        reasoning_confidence=normalize_prompt(str(payload.get("reasoning_confidence", ""))) or fallback.reasoning_confidence,
        verifiability=normalize_prompt(str(payload.get("verifiability", ""))) or fallback.verifiability,
        model_source=model_source,
        why_claims=_claim_list(payload.get("why_claims")) or fallback.why_claims,
        uncertainty_claims=_claim_list(payload.get("uncertainty_claims")) or _mandatory_uncertainty(fallback),
        assumptions=_string_list(payload.get("assumptions")) or fallback.assumptions,
        change_factors=_string_list(payload.get("change_factors")) or fallback.change_factors,
        verifiable_claims=(
            _claim_list(payload.get("verifiable_claims"), reference_key="reference")
            or _inferred_verifiable_claims(answer or fallback.answer, payload)
            or fallback.verifiable_claims
        ),
        alternative_summary=normalize_prompt(str(payload.get("alternative_summary", ""))) or fallback.alternative_summary,
    )


def _clean_answer_text(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def _mandatory_uncertainty(fallback: Phase2Result) -> list[dict[str, str]]:
    if fallback.uncertainty_claims:
        return fallback.uncertainty_claims
    quote = _first_sentence(fallback.answer)
    if not quote:
        return []
    return [{"quote": quote, "explanation": fallback.self_critique}]


def _inferred_verifiable_claims(answer: str, payload: dict[str, Any]) -> list[dict[str, str]]:
    cleaned = _clean_answer_text(answer)
    if not cleaned:
        return []

    verifiability = normalize_prompt(str(payload.get("verifiability", ""))).lower()
    looks_checkable = (
        "```" in cleaned
        or "test" in verifiability
        or "run" in verifiability
        or "checkable" in verifiability
        or "verify" in verifiability
        or "documentation" in verifiability
    )
    if not looks_checkable:
        return []

    quote = _first_sentence(cleaned)
    if not quote:
        return []
    return [
        {
            "quote": quote,
            "reference": "Verify by running the generated code, tests, or command in the local project/runtime.",
        }
    ]


def _first_sentence(text: str) -> str:
    cleaned = _clean_answer_text(text)
    if not cleaned:
        return ""
    for delimiter in [". ", "? ", "! ", "\n"]:
        if delimiter in cleaned:
            return cleaned.split(delimiter, 1)[0].strip() + delimiter.strip()
    return cleaned[:160].strip()


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [normalize_prompt(str(item)) for item in value if normalize_prompt(str(item))]


def _claim_list(value: Any, reference_key: str = "explanation") -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []

    claims: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        quote = normalize_prompt(str(item.get("quote", "")))
        detail = normalize_prompt(str(item.get(reference_key, item.get("explanation", ""))))
        if quote and detail:
            claim = {"quote": quote}
            claim[reference_key] = detail
            if reference_key != "explanation" and item.get("explanation"):
                claim["explanation"] = normalize_prompt(str(item.get("explanation", "")))
            claims.append(claim)
    return claims[:5]


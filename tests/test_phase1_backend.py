from __future__ import annotations

from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib import error, request

from backend import db
from backend.gemini_client import _prepare_multimodal_payload
from backend.phase1 import Phase1Request, analyze_phase1, build_project_context, build_refined_prompt
from backend.phase2 import Phase2Request, generate_phase2, build_phase2_model_payload
from backend.server import Phase1Handler
from backend.streamlit_app import _attachment_from_upload


class FakeGeminiPhase1Client:
    def __init__(self) -> None:
        self.seen_project_context = None

    def generate_phase1(self, prompt, project_context):
        self.seen_project_context = project_context
        return {
            "exit_state": "partial_context",
            "goal": f"Gemini goal for {prompt}",
            "scenario": "Gemini dynamic scenario",
            "answer_form": "implementation",
            "ambiguity_score": 4,
            "reliability_nudge": "Gemini needs one project-specific detail.",
            "questions": [
                "Gemini-selected question about the attached file contract?"
            ],
            "assumptions": [
                "I'm assuming Gemini should use the attached file preview."
            ],
            "input_warnings": [],
            "impact_notes": [
                "Gemini sees this change may affect tests and imports."
            ],
            "output_format_options": ["Patch files", "Plan first"],
            "recommended_output_format": "Patch files",
            "refined_prompt": "Gemini refined prompt",
        }


class FailingGeminiPhase1Client:
    def generate_phase1(self, prompt, project_context):
        raise RuntimeError("provider unavailable")


class FakeGeminiPhase2Client:
    def __init__(self) -> None:
        self.seen_payload = None

    def generate_phase2(self, payload):
        self.seen_payload = payload
        return {
            "answer": "Use Python code for bucket sort.",
            "reasoning_trace": "This follows from the selected Python format and bucket sort goal.",
            "self_critique": "This may be thin if the input range differs.",
            "reasoning_confidence": "High given the clarified format.",
            "verifiability": "Checkable by running tests on sample lists.",
            "why_claims": [
                {
                    "quote": "Use Python code for bucket sort.",
                    "explanation": "The selected output format is Python code.",
                }
            ],
            "uncertainty_claims": [
                {
                    "quote": "bucket sort",
                    "explanation": "The useful implementation depends on the input range.",
                }
            ],
            "assumptions": ["Numeric inputs."],
            "change_factors": ["If the values are unbounded, bucket sort may not be appropriate."],
            "verifiable_claims": [
                {
                    "quote": "bucket sort",
                    "reference": "Verify against standard algorithm references.",
                }
            ],
            "alternative_summary": "Use comparison sort when the value range is unknown.",
        }


class BareAnswerGeminiPhase2Client:
    def generate_phase2(self, payload):
        return {
            "answer": "Here is the answer.",
        }


class RepairingGeminiPhase2Client:
    def __init__(self) -> None:
        self.calls = []

    def generate_phase2(self, payload):
        self.calls.append(payload)
        if len(self.calls) == 1:
            return {
                "answer": "Use a partial index.",
                "reasoning_trace": "It follows from the query.",
                "self_critique": "Write volume is unknown.",
                "reasoning_confidence": "High",
                "verifiability": "Judgment call",
                "why_claims": [{"quote": "Missing quote.", "explanation": "Bad quote."}],
                "uncertainty_claims": [{"quote": "Also missing.", "explanation": "Bad quote."}],
            }
        return {
            "answer": "Use a partial index. Write volume is unknown.",
            "reasoning_trace": "It follows from the user's preference and the prior attempt.",
            "self_critique": "Write volume is unknown.",
            "reasoning_confidence": "High",
            "verifiability": "Judgment call",
            "why_claims": [{"quote": "Use a partial index.", "explanation": "This respects lower write overhead."}],
            "uncertainty_claims": [{"quote": "Write volume is unknown.", "explanation": "The user has not provided write volume."}],
        }


class MultilineCodeGeminiPhase2Client:
    def generate_phase2(self, payload):
        return {
            "answer": "```python\nprint('hi')\n```",
            "reasoning_trace": "The user asked for Python code.",
            "self_critique": "Thin if runtime differs.",
            "reasoning_confidence": "High",
            "verifiability": "Checkable by running it.",
        }


class CheckableGeminiPhase2Client:
    def generate_phase2(self, payload):
        return {
            "answer": "Run pytest to verify the change.",
            "reasoning_trace": "The user asked for a checkable implementation step.",
            "self_critique": "The exact test suite may differ.",
            "reasoning_confidence": "High",
            "verifiability": "Checkable by running tests.",
            "why_claims": [
                {
                    "quote": "Run pytest to verify the change.",
                    "explanation": "The answer is a concrete local verification route.",
                }
            ],
            "uncertainty_claims": [
                {
                    "quote": "the change",
                    "explanation": "The exact changed files are not provided in this test.",
                }
            ],
        }


class FakeUploadedFile:
    def __init__(self, name, file_type, data):
        self.name = name
        self.type = file_type
        self._data = data

    def getvalue(self):
        return self._data


class ChattyGeminiPhase1Client:
    def generate_phase1(self, prompt, project_context):
        return {
            "exit_state": "partial_context",
            "goal": "Update a target function safely.",
            "scenario": "Code modification",
            "answer_form": "implementation",
            "ambiguity_score": 4,
            "reliability_nudge": "More context is useful.",
            "questions": [
                "Which file should be changed?",
                "Should tests be updated?",
                "What outcome proves this correct?",
            ],
            "assumptions": [
                "I'm assuming the target is src/auth.py.",
                "I'm assuming tests should be updated.",
                "I'm assuming docs may need updates.",
            ],
            "input_warnings": [
                "The request may be too broad.",
                "The new auth flow is not defined.",
            ],
            "impact_notes": [
                "This can affect callers.",
                "This can affect imports.",
            ],
            "output_format_options": ["Patch files", "Plan first"],
            "recommended_output_format": "Patch files",
            "refined_prompt": "Refined prompt",
        }


class OverAskingGeminiPhase1Client:
    def generate_phase1(self, prompt, project_context):
        return {
            "exit_state": "partial_context",
            "goal": "Clarify a task.",
            "scenario": "General assistance",
            "answer_form": "implementation",
            "ambiguity_score": 4,
            "reliability_nudge": "Need context.",
            "questions": [
                "Question one?",
                "Question two?",
                "Question three?",
                "Question four?",
            ],
            "assumptions": [
                "Assumption one.",
                "Assumption two.",
                "Assumption three.",
                "Assumption four.",
            ],
            "input_warnings": [
                "Warning one.",
                "Warning two.",
                "Warning three.",
            ],
            "impact_notes": [
                "Impact one.",
                "Impact two.",
                "Impact three.",
            ],
            "output_format_options": [
                "Patch files",
                "Plan first",
                "Code explanation",
                "Long report",
            ],
            "recommended_output_format": "Patch files",
            "refined_prompt": "Clarified prompt.",
        }


class StructuredGeminiPhase1Client:
    def generate_phase1(self, prompt, project_context):
        return {
            "exit_state": "partial_context",
            "goal": "Update a structured file safely.",
            "scenario": "Code modification",
            "answer_form": "implementation",
            "ambiguity_score": 4,
            "reliability_nudge": "Need one structured answer.",
            "questions": [
                {"id": "custom_q", "question": "Which function is the source of truth?"},
                {"body": "Which test proves the behavior?"},
            ],
            "assumptions": [
                {"id": "custom_a", "text": "I'm assuming the attached preview is authoritative."},
                {"body": "I'm assuming edits should be minimal."},
            ],
            "input_warnings": [],
            "impact_notes": ["This may affect callers."],
            "output_format_options": ["Patch files"],
            "recommended_output_format": "Patch files",
            "refined_prompt": "Update the structured file safely.",
        }


class Phase1BackendTests(unittest.TestCase):
    def test_vague_prompt_asks_decision_changing_questions(self) -> None:
        result = analyze_phase1(Phase1Request(prompt="Fix this"))

        self.assertEqual(result.phase, "context_acquisition")
        self.assertIn(result.exit_state, {"partial_context", "insufficient_context"})
        self.assertGreaterEqual(result.ambiguity_score, 4)
        self.assertGreaterEqual(len(result.questions), 1)
        self.assertLessEqual(len(result.questions), 3)
        self.assertTrue(all(question.is_decision_changing for question in result.questions))
        self.assertTrue(any("assuming" in item.text.lower() for item in result.assumptions))

    def test_gemini_client_controls_dynamic_questions_when_available(self) -> None:
        fake_client = FakeGeminiPhase1Client()
        result = analyze_phase1(
            Phase1Request(
                prompt="Update this parser.",
                attachments=[
                    {
                        "name": "parser.py",
                        "type": "text/plain",
                        "size": 120,
                        "content_preview": "def parse(value): return value",
                    }
                ],
            ),
            model_client=fake_client,
        )

        self.assertEqual(result.model_source, "gemini")
        self.assertEqual(result.questions[0].question, "Gemini-selected question about the attached file contract?")
        self.assertIn("Patch files", result.output_format_options)
        self.assertIsNotNone(fake_client.seen_project_context)
        self.assertEqual(fake_client.seen_project_context["attachments"][0]["name"], "parser.py")

    def test_configured_model_failure_is_marked_as_fallback(self) -> None:
        result = analyze_phase1(
            Phase1Request(prompt="Fix this"),
            model_client=FailingGeminiPhase1Client(),
        )

        self.assertEqual(result.model_source, "heuristic_fallback")
        self.assertGreaterEqual(len(result.questions), 1)

    def test_phase1_accepts_structured_model_questions_and_assumptions(self) -> None:
        result = analyze_phase1(
            Phase1Request(
                prompt="Update this file.",
                attachments=[
                    {
                        "name": "service.py",
                        "type": "text/plain",
                        "size": 30,
                        "content_preview": "def run(): pass",
                    }
                ],
            ),
            model_client=StructuredGeminiPhase1Client(),
        )

        self.assertEqual(result.model_source, "gemini")
        self.assertEqual(result.questions[0].question, "Which function is the source of truth?")
        self.assertNotIn("{", result.questions[0].question)
        self.assertEqual(result.assumptions[0].text, "I'm assuming the attached preview is authoritative.")
        self.assertNotIn("{", result.assumptions[0].text)

    def test_normal_query_is_budgeted_to_adequate_questions(self) -> None:
        result = analyze_phase1(
            Phase1Request(prompt="Help me improve this."),
            model_client=OverAskingGeminiPhase1Client(),
        )

        self.assertLessEqual(len(result.assumptions) + len(result.questions), 3)
        self.assertLessEqual(len(result.input_warnings), 2)
        self.assertEqual(result.impact_notes, [])
        self.assertLessEqual(len(result.output_format_options), 3)

    def test_attachment_query_allows_small_file_repercussion_budget(self) -> None:
        result = analyze_phase1(
            Phase1Request(
                prompt="Change this function.",
                attachments=[
                    {
                        "name": "auth.py",
                        "type": "text/plain",
                        "size": 50,
                        "content_preview": "def login(user): return legacy_auth(user)",
                    }
                ],
            ),
            model_client=OverAskingGeminiPhase1Client(),
        )

        self.assertLessEqual(len(result.assumptions) + len(result.questions), 4)
        self.assertLessEqual(len(result.impact_notes), 2)
        self.assertLessEqual(len(result.input_warnings), 2)

    def test_clarification_prunes_resolved_items_and_prevents_growth(self) -> None:
        previous_context = {
            "assumptions": [{"text": "I'm assuming the target is src/auth.py."}],
            "input_warnings": [{"text": "The request may be too broad."}],
            "impact_notes": [{"text": "This can affect callers."}],
            "questions": [{"question": "Which file should be changed?"}],
        }
        result = analyze_phase1(
            Phase1Request(
                prompt="Change this function.",
                clarification_answers={"a_1": "Change: Use src/auth.py and include tests."},
                latest_clarification={
                    "id": "a_1",
                    "type": "assumption",
                    "body": "I'm assuming the target is src/auth.py.",
                    "value": "Change: Use src/auth.py and include tests.",
                },
                previous_context=previous_context,
            ),
            model_client=ChattyGeminiPhase1Client(),
        )

        unresolved_count = (
            len(result.assumptions)
            + len(result.input_warnings)
            + len(result.impact_notes)
            + len(result.questions)
        )
        self.assertLessEqual(unresolved_count, 3)
        self.assertFalse(any("src/auth.py" in item.text for item in result.assumptions))
        self.assertFalse(any("Which file" in item.question for item in result.questions))

    def test_file_answer_does_not_prune_new_flow_function_question(self) -> None:
        result = analyze_phase1(
            Phase1Request(
                prompt="Change this function.",
                clarification_answers={"a_1": "Change: Use src/auth.py and include tests."},
                latest_clarification={
                    "id": "a_1",
                    "type": "assumption",
                    "body": "I'm assuming the target is src/auth.py.",
                    "value": "Change: Use src/auth.py and include tests.",
                },
                previous_context={
                    "assumptions": [{"text": "I'm assuming the target is src/auth.py."}],
                    "questions": [{"question": "Which file should be changed?"}],
                },
            ),
            model_client=type(
                "NewFlowQuestionClient",
                (),
                {
                    "generate_phase1": lambda self, prompt, project_context: {
                        "exit_state": "partial_context",
                        "goal": "Change auth flow.",
                        "scenario": "Code modification",
                        "answer_form": "implementation",
                        "ambiguity_score": 4,
                        "reliability_nudge": "Need new flow details.",
                        "questions": [
                            "Is the new auth flow a function, class method, or API call?"
                        ],
                        "assumptions": [],
                        "input_warnings": [],
                        "impact_notes": [],
                        "output_format_options": ["Patch files"],
                        "recommended_output_format": "Patch files",
                        "refined_prompt": "Change auth flow.",
                    }
                },
            )(),
        )

        self.assertEqual(len(result.questions), 1)
        self.assertIn("function, class method, or API call", result.questions[0].question)

    def test_file_path_answer_prunes_matching_assumption(self) -> None:
        result = analyze_phase1(
            Phase1Request(
                prompt="Change this function.",
                clarification_answers={"a_1": "Change: Use src/auth.py and include tests."},
                previous_context={
                    "assumptions": [{"text": "I'm assuming the target is src/auth.py."}],
                },
            ),
            model_client=type(
                "PathAssumptionClient",
                (),
                {
                    "generate_phase1": lambda self, prompt, project_context: {
                        "exit_state": "partial_context",
                        "goal": "Change auth.",
                        "scenario": "Code modification",
                        "answer_form": "implementation",
                        "ambiguity_score": 4,
                        "reliability_nudge": "Need details.",
                        "questions": [],
                        "assumptions": ["You want to modify src/auth.py."],
                        "input_warnings": [],
                        "impact_notes": [],
                        "output_format_options": ["Patch files"],
                        "recommended_output_format": "Patch files",
                        "refined_prompt": "Change auth.",
                    }
                },
            )(),
        )

        self.assertEqual(result.assumptions, [])

    def test_specific_prompt_can_exit_with_enough_context(self) -> None:
        result = analyze_phase1(
            Phase1Request(
                prompt=(
                    "Implement Phase 1 context acquisition in React and Python "
                    "with SQLite persistence and tests so that vague prompts are clarified."
                ),
                mounted_paths=["."]
            )
        )

        self.assertEqual(result.exit_state, "enough_context")
        self.assertLessEqual(result.ambiguity_score, 2)
        self.assertEqual(result.questions, [])
        self.assertEqual(result.answer_form, "implementation")

    def test_bucket_sort_gets_low_ambiguity_and_format_choices(self) -> None:
        result = analyze_phase1(Phase1Request(prompt="Give me the code of bucket sort."))

        self.assertEqual(result.scenario, "Algorithm and code generation")
        self.assertEqual(result.answer_form, "implementation")
        self.assertLessEqual(result.ambiguity_score, 2)
        self.assertEqual(result.questions, [])
        self.assertIn("Python code", result.output_format_options)
        self.assertIn("Java code", result.output_format_options)
        self.assertTrue(any("known value range" in item.text for item in result.assumptions))

    def test_wrong_or_overfit_bucket_sort_constraints_are_flagged(self) -> None:
        result = analyze_phase1(
            Phase1Request(prompt="Give me bucket sort in O(1) with no extra memory.")
        )

        self.assertEqual(result.exit_state, "partial_context")
        self.assertGreaterEqual(result.ambiguity_score, 3)
        self.assertGreaterEqual(len(result.input_warnings), 2)
        self.assertTrue(any("constant-time" in warning for warning in result.input_warnings))
        self.assertTrue(any("auxiliary buckets" in warning for warning in result.input_warnings))

    def test_file_modification_requests_surface_repercussions(self) -> None:
        result = analyze_phase1(
            Phase1Request(
                prompt="Change this function to use the new auth flow.",
                mounted_paths=["src/auth.py"],
            )
        )

        self.assertGreaterEqual(result.ambiguity_score, 3)
        self.assertGreaterEqual(len(result.questions), 2)
        self.assertTrue(any("callers" in note for note in result.impact_notes))
        self.assertTrue(any("tests" in note for note in result.impact_notes))
        self.assertIn("Patch files", result.output_format_options)

    def test_refined_prompt_includes_answers_and_assumptions(self) -> None:
        refined = build_refined_prompt(
            "Fix the auth bug",
            answers={"q_1": "The failing path is login callback handling."},
            assumptions=["I'm assuming existing tests define correct behavior."],
        )

        self.assertIn("Fix the auth bug", refined)
        self.assertIn("Clarifications:", refined)
        self.assertIn("login callback", refined)
        self.assertIn("Working assumptions:", refined)

    def test_project_context_summarizes_attached_files_for_model(self) -> None:
        context = build_project_context(
            Phase1Request(
                prompt="Review this",
                attachments=[
                    {
                        "name": "example.py",
                        "type": "text/plain",
                        "size": 42,
                        "content_preview": "x = 1\n" * 2000,
                    }
                ],
            )
        )

        self.assertEqual(context["attachments"][0]["name"], "example.py")
        self.assertLessEqual(len(context["attachments"][0]["content_preview"]), 4003)
        self.assertTrue(context["context_rules"]["ask_before_major_file_edits"])

    def test_project_context_preserves_inline_image_data_for_model_delivery(self) -> None:
        context = build_project_context(
            Phase1Request(
                prompt="Describe the image",
                attachments=[
                    {
                        "name": "diagram.png",
                        "type": "image/png",
                        "attachment_kind": "image",
                        "size": 128,
                        "content_preview": "Image file attached.",
                        "image_metadata": {"width": 640, "height": 480},
                        "inline_mime_type": "image/png",
                        "content_base64": "aW1hZ2UtYnl0ZXM=",
                    }
                ],
            )
        )

        attachment = context["attachments"][0]
        self.assertEqual(attachment["attachment_kind"], "image")
        self.assertEqual(attachment["image_metadata"]["width"], 640)
        self.assertEqual(attachment["inline_mime_type"], "image/png")
        self.assertEqual(attachment["content_base64"], "aW1hZ2UtYnl0ZXM=")
        self.assertEqual(attachment["inline_status"], "available_to_model")

    def test_gemini_payload_sends_inline_parts_without_dumping_base64_into_prompt_json(self) -> None:
        payload = build_phase2_model_payload(
            Phase2Request(
                prompt="Explain the image and code file",
                phase1_result={"id": "ctx_1", "exit_state": "enough_context"},
                attachments=[
                    {
                        "name": "screen.png",
                        "type": "image/png",
                        "attachment_kind": "image",
                        "size": 200,
                        "content_preview": "Image file attached.",
                        "inline_mime_type": "image/png",
                        "content_base64": "c2NyZWVu",
                    },
                    {
                        "name": "main.py",
                        "type": "text/plain",
                        "attachment_kind": "text",
                        "size": 20,
                        "content_preview": "print('ok')",
                    },
                ],
            )
        )

        clean_payload, inline_parts = _prepare_multimodal_payload(payload)

        self.assertEqual(len(inline_parts), 2)
        self.assertEqual(inline_parts[1]["inline_data"]["mime_type"], "image/png")
        self.assertEqual(inline_parts[1]["inline_data"]["data"], "c2NyZWVu")
        self.assertEqual(
            clean_payload["project_context"]["attachments"][0]["content_base64"],
            "[sent as inline Gemini part]",
        )
        self.assertIn("attachment_delivery", clean_payload)

    def test_streamlit_upload_adapter_keeps_text_preview_and_image_inline_data(self) -> None:
        text_attachment = _attachment_from_upload(
            FakeUploadedFile("notes.py", "text/plain", b"print('ok')\n")
        )
        image_attachment = _attachment_from_upload(
            FakeUploadedFile("screen.png", "image/png", b"fake-image-bytes")
        )

        self.assertEqual(text_attachment["attachment_kind"], "text")
        self.assertIn("print('ok')", text_attachment["content_preview"])
        self.assertEqual(text_attachment["content_base64"], "")
        self.assertEqual(image_attachment["attachment_kind"], "image")
        self.assertEqual(image_attachment["inline_mime_type"], "image/png")
        self.assertEqual(image_attachment["content_base64"], "ZmFrZS1pbWFnZS1ieXRlcw==")

    def test_project_context_carries_answered_clarifications(self) -> None:
        context = build_project_context(
            Phase1Request(
                prompt="Change this function",
                clarification_answers={"q_1": "Use src/auth.py and include tests."},
                previous_context={"ambiguity_score": 4},
            )
        )

        self.assertEqual(
            context["answered_clarifications"]["q_1"],
            "Use src/auth.py and include tests.",
        )
        self.assertEqual(context["previous_context"]["ambiguity_score"], 4)

    def test_phase1_result_is_persisted_to_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = str(Path(temp_dir) / "phase1.sqlite")
            connection = db.connect(db_path)
            try:
                db.initialize(connection)
                phase_request = Phase1Request(prompt="Improve this project")
                result = analyze_phase1(phase_request)
                db.persist_phase1(connection, phase_request, result)

                self.assertEqual(db.count_rows(connection, "context_acquisitions"), 1)
                self.assertGreaterEqual(db.count_rows(connection, "assumptions"), 1)
                self.assertIsNotNone(db.latest_context(connection))
                latest = db.latest_context(connection)
                self.assertIn("output_format_options", latest)
            finally:
                connection.close()

    def test_phase1_http_endpoint_returns_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = type(
                "TestPhase1Handler",
                (Phase1Handler,),
                {
                    "db_path": str(Path(temp_dir) / "api.sqlite"),
                    "model_client": None,
                },
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            try:
                port = server.server_address[1]
                payload = json.dumps(
                    {
                        "prompt": "Fix this",
                        "clarification_answers": {"q_1": "The target is src/auth.py."},
                        "previous_context": {"id": "ctx_previous"},
                    }
                ).encode("utf-8")
                http_request = request.Request(
                    f"http://127.0.0.1:{port}/phase1/clarify",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with request.urlopen(http_request, timeout=5) as response:
                    result = json.loads(response.read().decode("utf-8"))

                self.assertEqual(result["phase"], "context_acquisition")
                self.assertGreaterEqual(result["ambiguity_score"], 4)
                self.assertGreaterEqual(len(result["questions"]), 1)
            finally:
                server.shutdown()
                server.server_close()

    def test_http_endpoint_rejects_invalid_json_with_400(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = type(
                "InvalidJsonHandler",
                (Phase1Handler,),
                {
                    "db_path": str(Path(temp_dir) / "api.sqlite"),
                    "model_client": None,
                },
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            try:
                port = server.server_address[1]
                http_request = request.Request(
                    f"http://127.0.0.1:{port}/phase1",
                    data=b"{not-json",
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(error.HTTPError) as raised:
                    request.urlopen(http_request, timeout=5)
                self.assertEqual(raised.exception.code, 400)
                body = json.loads(raised.exception.read().decode("utf-8"))
                self.assertIn("valid JSON", body["error"])
            finally:
                server.shutdown()
                server.server_close()

    def test_http_endpoint_rejects_oversized_payload_with_413(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = type(
                "TooLargeHandler",
                (Phase1Handler,),
                {
                    "db_path": str(Path(temp_dir) / "api.sqlite"),
                    "model_client": None,
                    "max_request_bytes": 8,
                },
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            try:
                port = server.server_address[1]
                http_request = request.Request(
                    f"http://127.0.0.1:{port}/phase1",
                    data=json.dumps({"prompt": "This body is too large"}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(error.HTTPError) as raised:
                    request.urlopen(http_request, timeout=5)
                self.assertEqual(raised.exception.code, 413)
            finally:
                server.shutdown()
                server.server_close()

    def test_phase2_model_generates_four_part_bundle(self) -> None:
        phase1_result = {
            "id": "ctx_1",
            "exit_state": "enough_context",
            "goal": "Provide bucket sort code.",
            "recommended_output_format": "Python code",
            "assumptions": [{"text": "Use numeric inputs."}],
            "refined_prompt": "Provide Python bucket sort code.",
        }
        client = FakeGeminiPhase2Client()
        result = generate_phase2(
            Phase2Request(
                prompt="Give me bucket sort",
                phase1_result=phase1_result,
                selected_output_format="Python code",
            ),
            model_client=client,
        )

        self.assertEqual(result.phase, "answer_evaluation")
        self.assertEqual(result.model_source, "gemini")
        self.assertIn("bucket sort", result.answer)
        self.assertIn("selected Python format", result.reasoning_trace)
        self.assertIsNotNone(client.seen_payload)
        self.assertIn("Phase 2", client.seen_payload["instruction"])
        self.assertEqual(result.why_claims[0]["quote"], "Use Python code for bucket sort.")
        self.assertEqual(result.assumptions[0], "Numeric inputs.")
        self.assertIn("comparison sort", result.alternative_summary)

    def test_phase2_preserves_code_block_newlines(self) -> None:
        result = generate_phase2(
            Phase2Request(
                prompt="Give Python code",
                phase1_result={"exit_state": "enough_context"},
                selected_output_format="Python code",
            ),
            model_client=MultilineCodeGeminiPhase2Client(),
        )

        self.assertEqual(result.answer, "```python\nprint('hi')\n```")

    def test_phase2_infers_verifiable_claim_for_checkable_answers(self) -> None:
        result = generate_phase2(
            Phase2Request(
                prompt="How do I verify this?",
                phase1_result={"exit_state": "enough_context"},
            ),
            model_client=CheckableGeminiPhase2Client(),
        )

        self.assertGreaterEqual(len(result.verifiable_claims), 1)
        self.assertEqual(result.verifiable_claims[0]["quote"], "Run pytest to verify the change.")
        self.assertIn("Verify by running", result.verifiable_claims[0]["reference"])

    def test_phase2_insufficient_context_says_dont_know(self) -> None:
        result = generate_phase2(
            Phase2Request(
                prompt="Do it",
                phase1_result={"exit_state": "insufficient_context"},
            )
        )

        self.assertIn("I don't know", result.answer)
        self.assertIn("Low", result.reasoning_confidence)

    def test_phase2_model_cannot_skip_insufficient_context_posture(self) -> None:
        result = generate_phase2(
            Phase2Request(
                prompt="Do it",
                phase1_result={"exit_state": "insufficient_context"},
            ),
            model_client=BareAnswerGeminiPhase2Client(),
        )

        self.assertEqual(result.model_source, "gemini")
        self.assertIn("I don't know", result.answer)
        self.assertIn("Low", result.reasoning_confidence)
        self.assertIn("Alternative approach", result.self_critique)

    def test_phase2_retries_when_claim_quotes_cannot_render(self) -> None:
        client = RepairingGeminiPhase2Client()
        result = generate_phase2(
            Phase2Request(
                prompt="Should I add an index?",
                phase1_result={"id": "ctx_1", "exit_state": "enough_context"},
            ),
            model_client=client,
        )

        self.assertEqual(len(client.calls), 2)
        self.assertIn("retry_feedback", client.calls[1])
        self.assertEqual(result.answer, "Use a partial index. Write volume is unknown.")
        self.assertEqual(result.why_claims[0]["quote"], "Use a partial index.")

    def test_phase2_payload_includes_clarifications_and_context(self) -> None:
        payload = build_phase2_model_payload(
            Phase2Request(
                prompt="Change this",
                phase1_result={"id": "ctx_1", "exit_state": "partial_context"},
                clarification_answers={"q_1": "Use src/auth.py."},
                selected_output_format="Patch files",
                attachments=[{"name": "auth.py", "type": "text/plain", "size": 10, "content_preview": "def login(): pass"}],
            )
        )

        self.assertEqual(payload["selected_output_format"], "Patch files")
        self.assertEqual(payload["clarification_answers"]["q_1"], "Use src/auth.py.")
        self.assertEqual(payload["project_context"]["attachments"][0]["name"], "auth.py")
        self.assertTrue(payload["phase_2_flow"]["must_use_phase1_refined_prompt"])
        self.assertIn("reasoning confidence", payload["phase_2_flow"]["must_include_judgment_aids"])
        self.assertIn("claim-level why annotations", payload["phase_2_flow"]["must_include_judgment_aids"])

    def test_phase2_payload_carries_alternative_request(self) -> None:
        payload = build_phase2_model_payload(
            Phase2Request(
                prompt="Should I add an index?",
                phase1_result={"id": "ctx_1", "exit_state": "enough_context"},
                answer_variant="alternative",
                previous_answer="Add a B-tree index.",
                judgment_direction="Prefer lower write overhead.",
                answer_history=[
                    {
                        "id": "ans_1",
                        "answer": "Add a B-tree index.",
                        "reasoning_trace": "It followed from read-heavy traffic.",
                        "self_critique": "Write volume was unknown.",
                        "user_direction": "Prefer lower write overhead.",
                    }
                ],
            )
        )

        self.assertEqual(payload["answer_variant"], "alternative")
        self.assertEqual(payload["previous_answer"], "Add a B-tree index.")
        self.assertEqual(payload["judgment_direction"], "Prefer lower write overhead.")
        self.assertEqual(payload["answer_history"][0]["id"], "ans_1")
        self.assertEqual(payload["answer_history"][0]["user_direction"], "Prefer lower write overhead.")
        self.assertTrue(payload["transaction_memory"]["use_user_direction_as_preference"])

    def test_combined_phase1_phase2_pipeline_carries_context_and_history(self) -> None:
        phase1 = analyze_phase1(
            Phase1Request(prompt="Give me the code of bucket sort.")
        )
        phase2_request = Phase2Request(
            prompt="Give me the code of bucket sort.",
            phase1_result=phase1.to_dict(),
            clarification_answers={
                "output_format": "Python code",
                "chat_preference_context": "Preference signal: concise Python examples.",
            },
            selected_output_format="Python code",
            answer_history=[
                {
                    "id": "ans_old",
                    "answer": "Prefer concise Python examples.",
                    "reasoning_trace": "User previously chose concise code.",
                    "self_critique": "Range details were still thin.",
                    "user_direction": "Keep code concise.",
                }
            ],
        )
        payload = build_phase2_model_payload(phase2_request)
        result = generate_phase2(phase2_request)

        self.assertEqual(phase1.exit_state, "enough_context")
        self.assertIn("Python code", phase1.output_format_options)
        self.assertEqual(payload["clarification_answers"]["output_format"], "Python code")
        self.assertEqual(payload["answer_history"][0]["id"], "ans_old")
        self.assertGreaterEqual(len(result.why_claims), 1)
        self.assertGreaterEqual(len(result.uncertainty_claims), 1)
        self.assertIn("bucket sort", result.answer.lower())

    def test_phase2_heuristic_keeps_required_affordances_and_direction(self) -> None:
        result = generate_phase2(
            Phase2Request(
                prompt="Should I add an index?",
                phase1_result={"id": "ctx_1", "exit_state": "enough_context", "refined_prompt": "Assess the index."},
                selected_output_format="Recommendation",
                judgment_direction="Prefer lower write overhead.",
            )
        )

        self.assertGreaterEqual(len(result.why_claims), 1)
        self.assertGreaterEqual(len(result.uncertainty_claims), 1)
        self.assertIn("Prefer lower write overhead", result.answer)
        self.assertEqual(result.verifiable_claims, [])

    def test_phase2_result_is_persisted_to_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = str(Path(temp_dir) / "phase2.sqlite")
            connection = db.connect(db_path)
            try:
                db.initialize(connection)
                phase2_request = Phase2Request(
                    prompt="Give me bucket sort",
                    phase1_result={"id": "ctx_1", "exit_state": "enough_context"},
                    selected_output_format="Python code",
                )
                result = generate_phase2(phase2_request)
                db.persist_phase2(connection, phase2_request, result)

                self.assertEqual(db.count_rows(connection, "answer_bundles"), 1)
            finally:
                connection.close()

    def test_phase2_http_endpoint_returns_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            handler = type(
                "TestPhase2Handler",
                (Phase1Handler,),
                {
                    "db_path": str(Path(temp_dir) / "api.sqlite"),
                    "model_client": None,
                },
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            try:
                port = server.server_address[1]
                payload = json.dumps(
                    {
                        "prompt": "Give me bucket sort",
                        "phase1_result": {
                            "id": "ctx_1",
                            "exit_state": "enough_context",
                            "refined_prompt": "Give Python bucket sort code.",
                            "recommended_output_format": "Python code",
                        },
                        "selected_output_format": "Python code",
                    }
                ).encode("utf-8")
                http_request = request.Request(
                    f"http://127.0.0.1:{port}/phase2",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with request.urlopen(http_request, timeout=5) as response:
                    result = json.loads(response.read().decode("utf-8"))

                self.assertEqual(result["phase"], "answer_evaluation")
                self.assertIn("reasoning_confidence", result)
                self.assertIn("verifiability", result)
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()

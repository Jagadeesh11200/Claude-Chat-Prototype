import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPhase1Payload,
  inferFileType,
  normalizePhase1Response,
  requestPhase1Clarification
} from "../src/phase1Client.js";
import {
  buildPhase2Payload,
  normalizePhase2Response,
  requestPhase2
} from "../src/phase2Client.js";
import {
  annotationForText,
  buildAnswerAffordances,
  confidenceSummary,
  firstUrl,
  parseMarkdownTable,
  sanitizeAssistantText,
  splitAnswerBlocks,
  visibleAnnotationCounts,
  visibleAnnotationTypes
} from "../src/answerViewModel.js";
import {
  buildPhase1Steps,
  composeClarifiedPrompt,
  phase1AmbiguityLabel,
  phase1ExitLabel,
  phase1NeedsClarification,
  phase1StepResolution,
  summarizePhase1Selections
} from "../src/phase1ViewModel.js";
import {
  buildGroupedHandoffSummary,
  buildHandoffSummary,
  computeConversationHealth,
  topicDriftDetected,
  topicOverlap
} from "../src/healthMonitor.js";
import { groupSessionsForSidebar, removeSessionById } from "../src/sessionViewModel.js";
import {
  isValidEmail,
  normalizeEmail,
  userNameFromEmail,
  userSessionKey
} from "../src/userStorage.js";

test("buildPhase1Payload trims prompt and keeps local defaults", () => {
  const payload = buildPhase1Payload("  Fix this  ");

  assert.equal(payload.prompt, "Fix this");
  assert.equal(payload.project_id, "local-project");
  assert.equal(payload.session_id, "local-session");
  assert.deepEqual(payload.attachments, []);
});

test("user storage helpers normalize email-only sign in identities", () => {
  assert.equal(normalizeEmail("  ABC@Domain.COM "), "abc@domain.com");
  assert.equal(userNameFromEmail("ABC@domain.com"), "ABC");
  assert.equal(isValidEmail("abc@domain.com"), true);
  assert.equal(isValidEmail("abc"), false);
  assert.equal(userSessionKey("ABC@domain.com"), "guided-claude-chat-sessions:abc@domain.com");
});

test("buildPhase1Payload carries attached file context", () => {
  const payload = buildPhase1Payload("Review this", {
    attachments: [{ name: "app.py", size: 100, content_preview: "print('hi')" }]
  });

  assert.equal(payload.attachments[0].name, "app.py");
  assert.equal(payload.attachments[0].content_preview, "print('hi')");
});

test("buildPhase1Payload carries clarification loop state", () => {
  const payload = buildPhase1Payload("Change this", {
    clarification_answers: { q_1: "Use src/auth.py" },
    latest_clarification: { id: "q_1", value: "Use src/auth.py" },
    previous_context: { id: "ctx_1" }
  });

  assert.equal(payload.clarification_answers.q_1, "Use src/auth.py");
  assert.equal(payload.latest_clarification.id, "q_1");
  assert.equal(payload.previous_context.id, "ctx_1");
});

test("inferFileType marks common code files as text", () => {
  assert.equal(inferFileType("main.py"), "text/plain");
  assert.equal(inferFileType("diagram.png"), "image/png");
  assert.equal(inferFileType("photo.jpg"), "image/jpeg");
  assert.equal(inferFileType("brief.pdf"), "application/pdf");
  assert.equal(
    inferFileType("notes.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
});

test("requestPhase1Clarification calls the clarify endpoint", async () => {
  let requestedUrl = "";
  await requestPhase1Clarification(
    { prompt: "Fix this" },
    async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({ ambiguity_score: 3, questions: [] })
      };
    }
  );

  assert.match(requestedUrl, /\/phase1\/clarify$/);
});

test("buildPhase2Payload carries phase1 and selected format", () => {
  const payload = buildPhase2Payload("Give code", { id: "ctx_1" }, {
    selected_output_format: "Python code",
    clarification_answers: { q_1: "Use integers." },
    attachments: [{ name: "sort.py", size: 24 }],
    answer_variant: "alternative",
    previous_answer: "Old answer",
    judgment_direction: "Prefer lower write cost.",
    answer_history: [{ id: "ans_1", answer: "Old answer" }]
  });

  assert.equal(payload.phase1_result.id, "ctx_1");
  assert.equal(payload.selected_output_format, "Python code");
  assert.equal(payload.clarification_answers.q_1, "Use integers.");
  assert.equal(payload.attachments[0].name, "sort.py");
  assert.equal(payload.answer_variant, "alternative");
  assert.equal(payload.previous_answer, "Old answer");
  assert.equal(payload.judgment_direction, "Prefer lower write cost.");
  assert.equal(payload.answer_history[0].id, "ans_1");
});

test("requestPhase2 calls phase2 endpoint", async () => {
  let requestedUrl = "";
  await requestPhase2(
    { prompt: "Give code", phase1_result: {} },
    async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({ answer: "A", reasoning_trace: "R", self_critique: "S" })
      };
    }
  );

  assert.match(requestedUrl, /\/phase2$/);
});

test("normalizePhase2Response protects answer panel", () => {
  const result = normalizePhase2Response({
    answer: "Done",
    reasoning_confidence: "High",
    verifiability: "Checkable"
  });

  assert.equal(result.phase, "answer_evaluation");
  assert.equal(result.answer, "Done");
  assert.equal(result.reasoning_trace, "");
  assert.equal(result.reasoning_confidence, "High");
  assert.equal(result.verifiability, "Checkable");
  assert.equal(result.model_source, "unknown");
  assert.deepEqual(result.why_claims, []);
  assert.deepEqual(result.change_factors, []);
});

test("splitAnswerBlocks separates prose from fenced code", () => {
  const blocks = splitAnswerBlocks("Intro\n```python\nprint('hi')\n```\nDone");

  assert.deepEqual(blocks.map((block) => block.type), ["text", "code", "text"]);
  assert.equal(blocks[1].language, "python");
  assert.equal(blocks[1].content, "print('hi')");
});

test("splitAnswerBlocks handles one-line model code fences", () => {
  const blocks = splitAnswerBlocks("```python print('hi')```");

  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].language, "python");
  assert.equal(blocks[0].content, "print('hi')");
});

test("splitAnswerBlocks keeps markdown tables as renderable table blocks", () => {
  const blocks = splitAnswerBlocks("Intro\n| Name | Use |\n| --- | --- |\n| API | Verify facts |\nDone");
  const table = parseMarkdownTable(blocks.find((block) => block.type === "table")?.content || "");

  assert.deepEqual(blocks.map((block) => block.type), ["text", "table", "text"]);
  assert.deepEqual(table.headers, ["Name", "Use"]);
  assert.deepEqual(table.rows[0], ["API", "Verify facts"]);
});

test("firstUrl extracts citation links for verifiable claim hover", () => {
  assert.equal(
    firstUrl("Verify against https://example.com/docs before shipping."),
    "https://example.com/docs"
  );
});

test("confidenceSummary keeps reasoning and verifiability separate", () => {
  const summary = confidenceSummary({
    reasoning_confidence: "High given the inputs.",
    verifiability: "Judgment call, not fully checkable."
  });

  assert.equal(summary.reasoningTone, "solid");
  assert.equal(summary.verifiabilityTone, "judgment");
  assert.equal(summary.reasoningLabel, "Strong Reasoning");
  assert.equal(summary.verifiabilityLabel, "Judgment call");
});

test("compact verifiability label refuses reasoning-style confidence words", () => {
  const summary = confidenceSummary({
    reasoning_confidence: "High",
    verifiability: "High"
  });

  assert.equal(summary.reasoningLabel, "Strong Reasoning");
  assert.equal(summary.verifiabilityLabel, "Verifiability: unclear");
});

test("sanitizeAssistantText removes internal protocol labels", () => {
  const text = sanitizeAssistantText("\u30101. ANSWER\u3011 Phase 1 resolved context. Phase 2 answers.");

  assert.equal(text, "the context check resolved context. the answer pass answers.");
});

test("buildAnswerAffordances and annotationForText map exact answer clauses", () => {
  const result = {
    answer: "Add the index. Writes may slow down.",
    why_claims: [{ quote: "Add the index.", explanation: "The query filters on this column." }],
    uncertainty_claims: [{ quote: "Writes may slow down.", explanation: "Write volume is unknown." }],
    verifiable_claims: [{ quote: "Add the index.", reference: "Check the query plan." }],
    assumptions: ["Read-heavy workload"],
    change_factors: ["Write-heavy traffic"],
    alternative_summary: "Use a partial index."
  };
  const affordances = buildAnswerAffordances(result);
  const annotations = annotationForText(result.answer, affordances);

  assert.equal(affordances.assumptions[0], "Read-heavy workload");
  assert.equal(affordances.alternativeSummary, "Use a partial index.");
  assert.deepEqual(annotations.map((item) => item.type), ["why", "uncertainty"]);
});

test("visibleAnnotationTypes only reports renderable inline claims", () => {
  const result = {
    answer: "Run the tests. Then ship it.",
    why_claims: [{ quote: "Run the tests.", explanation: "The user asked for verification." }],
    verifiable_claims: [
      { quote: "Then ship it.", reference: "https://example.com/checklist" },
      { quote: "Missing sentence.", reference: "https://example.com/missing" }
    ],
    uncertainty_claims: [{ quote: "Run the tests.", explanation: "The exact test suite is unknown." }]
  };
  const affordances = buildAnswerAffordances(result);
  const types = visibleAnnotationTypes(result.answer, affordances);
  const counts = visibleAnnotationCounts(result.answer, affordances);

  assert.equal(types.has("verifiable"), true);
  assert.equal(counts.verifiable, 1);
  assert.equal(firstUrl(affordances.verifiable[0].detail), "https://example.com/checklist");
  assert.equal(firstUrl("Use local test output."), "");
});

test("buildAnswerAffordances does not invent verifiable claims", () => {
  const affordances = buildAnswerAffordances({
    answer: "This is probably a good idea.",
    reasoning_trace: "It follows from the given preference.",
    self_critique: "It is preference-sensitive.",
    verifiability: "Judgment call"
  });

  assert.equal(affordances.why.length, 1);
  assert.equal(affordances.uncertainty.length, 1);
  assert.deepEqual(affordances.verifiable, []);
});

test("buildAnswerAffordances moves overlapping uncertainty to a caveated clause", () => {
  const result = {
    answer: "Add the index. You will need to replace the table name.",
    why_claims: [{ quote: "Add the index.", explanation: "The query is selective." }],
    uncertainty_claims: [{ quote: "Add the index.", explanation: "The exact database is unknown." }],
    self_critique: "The exact database is unknown."
  };
  const affordances = buildAnswerAffordances(result);

  assert.equal(affordances.uncertainty[0].quote, "You will need to replace the table name.");
});

test("normalizePhase1Response protects the UI from partial backend JSON", () => {
  const result = normalizePhase1Response({ ambiguity_score: "4", questions: null });

  assert.equal(result.phase, "context_acquisition");
  assert.equal(result.ambiguity_score, 4);
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.assumptions, []);
  assert.deepEqual(result.input_warnings, []);
  assert.deepEqual(result.output_format_options, []);
});

test("phase1 view model exposes clarification state", () => {
  const result = {
    exit_state: "partial_context",
    ambiguity_score: 4,
    questions: [{ id: "q_1", question: "Which file?" }]
  };

  assert.equal(phase1NeedsClarification(result), true);
  assert.equal(phase1ExitLabel(result), "Clarify");
  assert.equal(phase1AmbiguityLabel(result.ambiguity_score), "Medium");
});

test("buildPhase1Steps orders assumptions, warnings, questions, then format", () => {
  const steps = buildPhase1Steps({
    input_warnings: ["O(1) bucket sort is suspicious."],
    impact_notes: ["Changing this function may affect callers."],
    assumptions: [{ id: "a_1", text: "I'm assuming numeric inputs." }],
    questions: [{ id: "q_1", question: "Which file?" }],
    output_format_options: ["Python code", "Java code"],
    recommended_output_format: "Python code"
  });

  assert.deepEqual(steps.map((step) => step.type), [
    "assumption",
    "warning",
    "impact",
    "question",
    "format"
  ]);
  assert.equal(steps.at(-1).recommended, "Python code");
});

test("summarizePhase1Selections reports selected output form", () => {
  const summary = summarizePhase1Selections(
    { recommended_output_format: "Python code" },
    { output_format: "Java code" }
  );

  assert.equal(summary.format, "Java code");
  assert.equal(summary.ready, true);
});

test("phase1StepResolution requires correction after changing assumption", () => {
  const step = {
    id: "a_1",
    type: "assumption",
    body: "I'm assuming values are 1-50."
  };

  assert.equal(phase1StepResolution(step, { a_1: "Change: " }).canContinue, false);
  assert.equal(
    phase1StepResolution(step, { a_1: "Change: Values are 1-100." }).canContinue,
    true
  );
  assert.match(phase1StepResolution(step, {}).value, /Confirmed:/);
});

test("phase1StepResolution supports per-context answer ids", () => {
  const step = {
    id: "a_1",
    answerId: "ctx_1:a_1",
    type: "assumption",
    body: "I'm assuming values are 1-50."
  };

  assert.equal(
    phase1StepResolution(step, { "ctx_1:a_1": "Change: Values are 1-100." }).value,
    "Change: Values are 1-100."
  );
});

test("composeClarifiedPrompt appends answers and assumptions", () => {
  const prompt = composeClarifiedPrompt(
    {
      refined_prompt: "Fix this",
      assumptions: [{ id: "a_1", text: "I'm assuming the current repo is the target." }]
    },
    { q_1: "The target is the backend folder." }
  );

  assert.match(prompt, /Fix this/);
  assert.match(prompt, /Clarifications:/);
  assert.match(prompt, /backend folder/);
  assert.match(prompt, /Confirmed working assumptions:/);
});

test("conversation health triggers after twenty exchanges", () => {
  const turns = Array.from({ length: 20 }, (_, index) => ({
    prompt: `Continue the architecture prototype ${index}`,
    phase1Result: { goal: "Build the prototype" },
    phase2Result: { answer: "Decision: keep the guided chat model." }
  }));
  const health = computeConversationHealth(turns);

  assert.equal(health.triggered, true);
  assert.match(health.reasons[0], /20\+ exchanges/);
  assert.match(health.summary, /Goal:/);
  assert.match(health.summary, /Decisions & constraints/);
});

test("conversation health triggers on clear topic drift", () => {
  const turns = [
    { prompt: "Design a Claude-style agentic coding prototype with React and Python" },
    { prompt: "Clarify the answer affordance UI" },
    { prompt: "Add health monitoring to the chat thread" },
    { prompt: "Build grouped branch chats for handoff summaries" },
    { prompt: "Plan a weekend cooking menu for pasta and dessert" }
  ];
  const health = computeConversationHealth(turns);

  assert.equal(health.triggered, true);
  assert.match(health.reasons.join(" "), /drifted/);
  assert.equal(topicDriftDetected(turns), true);
});

test("conversation health catches sharp topic drift before twenty exchanges", () => {
  const turns = [
    { prompt: "Explain Thor's powers and superhero abilities" },
    { prompt: "Compare Thor with Iron Man in Marvel stories" },
    { prompt: "Now write Python code for binary search" }
  ];
  const health = computeConversationHealth(turns);

  assert.equal(health.triggered, true);
  assert.equal(health.reasonCode, "topic_drift");
  assert.match(health.reason, /drifted/);
});

test("conversation health does not treat normal software subtopic changes as topic drift", () => {
  const turns = [
    { prompt: "Fix the React sidebar grouping UI" },
    { prompt: "Add Python backend tests for SQLite chat history" },
    { prompt: "Update Vercel frontend deployment settings" }
  ];
  const health = computeConversationHealth(turns);

  assert.equal(health.triggered, false);
  assert.equal(topicDriftDetected(turns), false);
});

test("conversation health checkpoint waits for a fresh drift or twenty more turns", () => {
  const turns = [
    { prompt: "Explain Thor's powers and superhero abilities" },
    { prompt: "Compare Thor with Iron Man in Marvel stories" },
    { prompt: "Now write Python code for binary search" }
  ];
  const continued = computeConversationHealth(turns, { checkpointIndex: turns.length });
  const sameTopicAfterContinue = computeConversationHealth([
    ...turns,
    { prompt: "Add tests for the binary search Python code" }
  ], { checkpointIndex: turns.length });
  const newDriftAfterContinue = computeConversationHealth([
    ...turns,
    { prompt: "Add tests for the binary search Python code" },
    { prompt: "Plan a dessert menu for this weekend" }
  ], { checkpointIndex: turns.length });

  assert.equal(continued.triggered, false);
  assert.equal(sameTopicAfterContinue.triggered, false);
  assert.equal(newDriftAfterContinue.triggered, true);
  assert.equal(newDriftAfterContinue.reasonCode, "topic_drift");
});

test("conversation health does not trigger for repeated prompts alone", () => {
  const turns = Array.from({ length: 4 }, () => ({
    prompt: "Please correct the phase two answer UI and make it more Claude-like"
  }));
  const health = computeConversationHealth(turns);

  assert.equal(health.triggered, false);
});

test("conversation health does not trigger for correction language alone", () => {
  const turns = [
    { prompt: "Build the guided context prototype UI" },
    { prompt: "This is wrong, please correct the guided context prototype UI" },
    { prompt: "Ignore previous wording and keep the guided context prototype UI simpler" },
    { prompt: "Instead use a compact guided context prototype UI" }
  ];
  const health = computeConversationHealth(turns);

  assert.equal(health.triggered, false);
});

test("handoff summary is editable-ready and includes key sections", () => {
  const summary = buildHandoffSummary([
    {
      prompt: "Build prototype",
      phase1Result: {
        goal: "Build a Claude-like prototype",
        assumptions: [{ text: "Use React locally." }],
        questions: ["Which deployment target?"]
      }
    },
    {
      prompt: "Add answer UI",
      phase2Result: {
        answer: "Decision: keep a single answer card with inline affordances."
      }
    }
  ]);

  assert.match(summary, /Goal: Build a Claude-like prototype/);
  assert.match(summary, /Decision: keep a single answer card/);
  assert.match(summary, /Questions still open: Which deployment target/);
  assert.match(summary, /Assumptions currently in play: Use React locally/);
});

test("grouped handoff summary carries essence from chained branch chats", () => {
  const sessions = [
    {
      id: "chat_1",
      groupId: "group_a",
      updatedAt: "2026-05-28T01:00:00.000Z",
      turns: [
        {
          id: "turn_1",
          prompt: "Build guided context",
          phase1Result: {
            goal: "Build guided context prototype",
            assumptions: ["Use Gemini as orchestrator."]
          },
          phase2Result: {
            answer: "Decision: Phase 1 asks only decision-changing questions."
          }
        }
      ]
    },
    {
      id: "chat_2",
      groupId: "group_a",
      updatedAt: "2026-05-28T02:00:00.000Z",
      turns: [
        {
          id: "turn_2",
          prompt: "Add phase two answer affordances",
          phase1Result: {
            questions: ["Should previous answers stay visible?"]
          },
          phase2Result: {
            answer: "Decision: Phase 2 uses inline why and shaky markers."
          }
        }
      ]
    }
  ];
  const summary = buildGroupedHandoffSummary({
    sessions,
    groupId: "group_a",
    currentTurns: [
      {
        id: "turn_3",
        prompt: "Add health notice branches",
        phase2Result: {
          answer: "Decision: Health notice creates an optional grouped branch."
        }
      }
    ]
  });

  assert.match(summary, /Build guided context prototype/);
  assert.match(summary, /context check asks only decision-changing questions/);
  assert.match(summary, /answer pass uses inline why and shaky markers/);
  assert.match(summary, /Health notice creates an optional grouped branch/);
  assert.match(summary, /Should previous answers stay visible/);
  assert.match(summary, /Use Gemini as orchestrator/);
});

test("sidebar grouping keeps branch chats together as one block", () => {
  const groups = groupSessionsForSidebar([
    { id: "root", groupId: "group_a", title: "Root", updatedAt: "2026-05-28T01:00:00.000Z" },
    { id: "other", groupId: "group_b", title: "Other", updatedAt: "2026-05-28T04:00:00.000Z" },
    { id: "branch_2", groupId: "group_a", parentId: "branch_1", title: "Branch 2", updatedAt: "2026-05-28T03:00:00.000Z" },
    { id: "branch_1", groupId: "group_a", parentId: "root", title: "Branch 1", updatedAt: "2026-05-28T02:00:00.000Z" }
  ]);
  const grouped = groups.find((group) => group.groupId === "group_a");

  assert.equal(groups[0].groupId, "group_b");
  assert.deepEqual(grouped.sessions.map((session) => session.id), ["root", "branch_1", "branch_2"]);
});

test("removeSessionById deletes only the selected chat from grouped history", () => {
  const sessions = [
    { id: "root", groupId: "group_a", title: "Root" },
    { id: "branch_1", groupId: "group_a", parentId: "root", title: "Branch 1" },
    { id: "other", groupId: "group_b", title: "Other" }
  ];
  const remaining = removeSessionById(sessions, "branch_1");

  assert.deepEqual(remaining.map((session) => session.id), ["root", "other"]);
  assert.deepEqual(removeSessionById(remaining, "missing"), remaining);
});

test("topicOverlap is high for related prompts and low for unrelated prompts", () => {
  assert.ok(topicOverlap("Claude code chat prototype", "Claude chat prototype UI") > 0.3);
  assert.ok(topicOverlap("Claude code chat prototype", "weekend pasta dessert menu") < 0.12);
});

test("combined phases carry clarification, answer affordances, and health state", () => {
  const phase1 = normalizePhase1Response({
    id: "ctx_combo",
    exit_state: "partial_context",
    ambiguity_score: 4,
    refined_prompt: "Implement bucket sort for integer inputs.",
    assumptions: [{ id: "a_1", text: "I'm assuming integer inputs in a bounded range." }],
    questions: [{ id: "q_1", question: "Which language should the code use?" }],
    output_format_options: ["Python code", "Pseudocode"],
    recommended_output_format: "Python code"
  });
  const steps = buildPhase1Steps(phase1);
  const answers = {
    "ctx_combo:a_1": "Confirmed: integer inputs in a bounded range.",
    "ctx_combo:q_1": "Use Python.",
    output_format: "Python code"
  };
  const selected = summarizePhase1Selections(phase1, answers);
  const phase2Payload = buildPhase2Payload("Give me bucket sort", phase1, {
    clarification_answers: answers,
    selected_output_format: selected.format,
    answer_history: [{ id: "ans_prev", answer: "Prefer concise Python examples." }]
  });
  const phase2 = normalizePhase2Response({
    answer: "Use Python bucket sort for bounded integers. Replace the range bounds if your data differs.",
    reasoning_trace: "The user selected Python and confirmed bounded integers.",
    self_critique: "The exact value range is not known.",
    reasoning_confidence: "High",
    verifiability: "Checkable by running tests.",
    why_claims: [
      {
        quote: "Use Python bucket sort for bounded integers.",
        explanation: "The language and bounded integer assumption were clarified."
      }
    ],
    uncertainty_claims: [
      {
        quote: "Replace the range bounds if your data differs.",
        explanation: "The exact min/max values are still user-private."
      }
    ],
    verifiable_claims: [
      {
        quote: "Use Python bucket sort for bounded integers.",
        reference: "Verify with unit tests over sorted/unsorted bounded integer arrays."
      }
    ]
  });
  const affordances = buildAnswerAffordances(phase2);
  const counts = visibleAnnotationCounts(phase2.answer, affordances);
  const health = computeConversationHealth([{ prompt: phase2Payload.prompt, phase1Result: phase1, phase2Result: phase2 }]);

  assert.deepEqual(steps.map((step) => step.type), ["assumption", "question", "format"]);
  assert.equal(phase2Payload.selected_output_format, "Python code");
  assert.equal(phase2Payload.answer_history[0].id, "ans_prev");
  assert.equal(counts.why, 1);
  assert.equal(counts.uncertainty, 1);
  assert.equal(counts.verifiable, 1);
  assert.equal(health.triggered, false);
});

test("extreme combined flow sanitizes protocol labels and remains health-safe before threshold", () => {
  const turns = Array.from({ length: 4 }, (_, index) => ({
    prompt: `Continue Claude code prototype implementation ${index}`,
    phase1Result: {
      goal: "Ship the Claude-like prototype",
      assumptions: [{ text: `Assumption ${index}` }],
      questions: [{ question: `Open question ${index}` }]
    },
    phase2Result: {
      answer: "\u30101. ANSWER\u3011 Keep the single answer card. Phase 1 and Phase 2 labels should not leak.",
      reasoning_trace: "It follows from UI constraints.",
      self_critique: "The exact layout may need review."
    }
  }));
  const health = computeConversationHealth(turns);
  const summary = buildHandoffSummary(turns);
  const cleaned = sanitizeAssistantText(turns.at(-1).phase2Result.answer);

  assert.equal(health.triggered, false);
  assert.doesNotMatch(cleaned, /\u30101\. ANSWER\u3011/);
  assert.doesNotMatch(cleaned, /\bPhase 1\b|\bPhase 2\b/);
  assert.ok(summary.length < 900);
  assert.match(summary, /Open question 3/);
});

test("extreme health threshold triggers at twenty without relying on repetition", () => {
  const turns = Array.from({ length: 20 }, (_, index) => ({
    prompt: `Claude prototype scoped implementation step ${index}`,
    phase2Result: { answer: `Decision ${index}: continue the same prototype objective.` }
  }));
  const health = computeConversationHealth(turns);

  assert.equal(health.triggered, true);
  assert.equal(health.reasons.length, 1);
  assert.match(health.reasons[0], /20\+ exchanges/);
});



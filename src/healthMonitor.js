import { sanitizeAssistantText } from "./answerViewModel.js";

export const HEALTH_EXCHANGE_THRESHOLD = 20;

export function computeConversationHealth(turns, options = {}) {
  const checkpointIndex = Math.max(0, Number(options.checkpointIndex || 0));
  const completedTurns = (turns || []).filter((turn) => turn?.prompt);
  const turnsSinceCheckpoint = Math.max(0, completedTurns.length - checkpointIndex);
  const drifted = topicDriftDetected(completedTurns, { checkpointIndex });
  const longChat = turnsSinceCheckpoint >= HEALTH_EXCHANGE_THRESHOLD;
  const reason = drifted
    ? "The topic appears to have drifted from the opening request."
    : longChat
      ? `This chat has crossed ${HEALTH_EXCHANGE_THRESHOLD}+ exchanges.`
      : "";

  return {
    triggered: Boolean(reason),
    reason,
    reasons: reason ? [reason] : [],
    reasonCode: drifted ? "topic_drift" : longChat ? "long_chat" : "",
    summary: buildHandoffSummary(completedTurns)
  };
}

export function buildGroupedHandoffSummary({ sessions = [], currentTurns = [], groupId = "" }) {
  const groupSessions = sessions
    .filter((session) => groupId && session.groupId === groupId)
    .sort((left, right) => new Date(left.updatedAt || 0) - new Date(right.updatedAt || 0));
  const seen = new Set();
  const groupedTurns = [];

  for (const turn of [
    ...groupSessions.flatMap((session) => session.turns || []),
    ...(currentTurns || [])
  ]) {
    const key = turn?.id || `${turn?.prompt || ""}:${groupedTurns.length}`;
    if (turn?.prompt && !seen.has(key)) {
      seen.add(key);
      groupedTurns.push(turn);
    }
  }

  return buildHandoffSummary(groupedTurns.length ? groupedTurns : currentTurns);
}

export function topicDriftDetected(turns, options = {}) {
  const checkpointIndex = Math.max(0, Number(options.checkpointIndex || 0));
  const completedTurns = (turns || []).filter((turn) => turn?.prompt);
  const segment = completedTurns.slice(checkpointIndex);
  if (segment.length < 2) {
    return false;
  }

  const latestText = topicText(segment[segment.length - 1]);
  const previousSegmentText = segment.slice(0, -1).map(topicText).join(" ");
  const openingText = segment.slice(0, Math.min(2, segment.length - 1)).map(topicText).join(" ");
  const previousOverlap = topicOverlap(previousSegmentText, latestText);
  const openingOverlap = topicOverlap(openingText, latestText);
  const previousDomains = domainSet(previousSegmentText);
  const latestDomains = domainSet(latestText);
  const hasKnownDomainShift =
    previousDomains.size > 0 &&
    latestDomains.size > 0 &&
    setOverlap(previousDomains, latestDomains) === 0;
  const sameKnownDomain =
    previousDomains.size > 0 &&
    latestDomains.size > 0 &&
    setOverlap(previousDomains, latestDomains) > 0;

  if (sameKnownDomain) {
    return false;
  }

  if (hasKnownDomainShift) {
    return previousOverlap < 0.18 && openingOverlap < 0.18;
  }

  return segment.length >= HEALTH_EXCHANGE_THRESHOLD && previousOverlap < 0.06 && openingOverlap < 0.06;
}

export function topicOverlap(leftText, rightText) {
  const left = keywordSet(leftText);
  const right = keywordSet(rightText);
  if (!left.size || !right.size) {
    return 1;
  }
  return setOverlap(left, right);
}

function topicText(turn) {
  return [
    turn?.prompt,
    turn?.phase1Result?.goal,
    turn?.phase1Result?.scenario,
    turn?.phase1Result?.refined_prompt
  ].filter(Boolean).join(" ");
}

function setOverlap(left, right) {
  const intersection = [...left].filter((item) => right.has(item)).length;
  return intersection / Math.max(left.size, right.size);
}

function keywordSet(text) {
  const stopWords = new Set([
    "the", "and", "for", "with", "this", "that", "from", "have", "what", "when", "where", "please",
    "should", "would", "could", "about", "into", "your", "you", "me", "my", "our", "are", "is", "to"
  ]);
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word))
      .slice(0, 24)
  );
}

function domainSet(text) {
  const source = ` ${String(text || "").toLowerCase()} `;
  const domains = {
    software: [
      "code", "python", "javascript", "react", "backend", "frontend", "api", "sqlite", "database",
      "function", "test", "deploy", "vercel", "streamlit", "gemini", "component", "ui", "bug"
    ],
    entertainment: [
      "thor", "iron man", "superhero", "marvel", "dc", "movie", "character", "powers", "abilities"
    ],
    sports: [
      "cricket", "ipl", "football", "soccer", "match", "score", "team", "player", "world cup"
    ],
    politics: [
      "pm", "prime minister", "president", "election", "parliament", "politics", "government", "minister"
    ],
    cooking: [
      "recipe", "cook", "cooking", "menu", "dessert", "pasta", "meal", "kitchen", "dinner"
    ],
    finance: [
      "stock", "market", "portfolio", "investment", "revenue", "profit", "budget", "tax"
    ],
    travel: [
      "travel", "flight", "hotel", "trip", "itinerary", "visa", "airport"
    ],
    health: [
      "doctor", "medical", "health", "symptom", "medicine", "diagnosis", "treatment"
    ],
    legal: [
      "law", "legal", "contract", "court", "lawsuit", "clause", "compliance"
    ]
  };

  return new Set(
    Object.entries(domains)
      .filter(([, terms]) => terms.some((term) => source.includes(` ${term} `)))
      .map(([domain]) => domain)
  );
}

export function buildHandoffSummary(turns) {
  const safeTurns = (turns || []).filter((turn) => turn?.prompt);
  if (!safeTurns.length) {
    return [
      "Goal: Continue the current work with cleaner context.",
      "Decisions & constraints already settled: No prior accepted answer is available yet.",
      "Questions still open: Confirm the next concrete task before acting.",
      "Assumptions currently in play: Carry forward only assumptions the user explicitly keeps."
    ].join("\n");
  }
  const first = safeTurns[0];
  const recentPrompts = safeTurns
    .map((turn) => sanitizeAssistantText(turn.prompt || ""))
    .filter(Boolean)
    .slice(-6);
  const decisions = safeTurns
    .map((turn) => turn?.phase2Result?.answer)
    .filter(Boolean)
    .slice(-6)
    .map((answer) => sanitizeAssistantText(answer).slice(0, 190));
  const assumptions = safeTurns
    .flatMap((turn) => turn?.phase1Result?.assumptions || [])
    .map((item) => typeof item === "string" ? item : item?.text)
    .filter(Boolean)
    .slice(-4);
  const openQuestions = safeTurns
    .flatMap((turn) => turn?.phase1Result?.questions || [])
    .map((item) => typeof item === "string" ? item : item?.question || item?.prompt || item?.body)
    .filter(Boolean)
    .slice(-3);

  return [
    `Goal: ${first?.phase1Result?.goal || first?.prompt || "Continue the current work with cleaner context."}`,
    `Recent chat path: ${recentPrompts.length ? recentPrompts.join(" -> ") : "No prior prompts captured."}`,
    `Decisions & constraints already settled: ${decisions.length ? decisions.join(" | ") : "Use the latest accepted answer as the current preference signal."}`,
    `Questions still open: ${openQuestions.length ? openQuestions.join("; ") : "None explicitly open; confirm any project-specific constraints before acting."}`,
    `Assumptions currently in play: ${assumptions.length ? assumptions.join("; ") : "Carry forward only assumptions the user has already accepted in this chat."}`
  ].join("\n");
}

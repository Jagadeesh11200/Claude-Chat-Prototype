import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Edit3,
  Folder,
  GitBranchPlus,
  KeyRound,
  LogOut,
  Menu,
  MessageSquare,
  Minus,
  PanelLeft,
  Plus,
  RefreshCcw,
  Scale,
  Search,
  Send,
  Shuffle,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import {
  buildPhase1Payload,
  filesToPhase1Attachments,
  requestPhase1,
  requestPhase1Clarification
} from "./phase1Client";
import {
  buildPhase1Steps,
  phase1ExitLabel,
  phase1NeedsClarification,
  phase1StepResolution,
  summarizePhase1Selections
} from "./phase1ViewModel";
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
} from "./answerViewModel";
import { buildGroupedHandoffSummary, computeConversationHealth } from "./healthMonitor";
import { buildPhase2Payload, requestPhase2 } from "./phase2Client";
import { groupSessionsForSidebar, removeSessionById } from "./sessionViewModel";
import {
  clearCurrentUser,
  clearLegacySharedHistory,
  isValidEmail,
  loadCurrentUser,
  loadSessionsForUser,
  normalizeEmail,
  saveCurrentUser,
  saveSessionsForUser,
  userNameFromEmail
} from "./userStorage";
import "./styles.css";

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function activeTurnSnapshot(state) {
  if (!state.id || !state.prompt) {
    return null;
  }
  return {
    id: state.id,
    createdAt: state.createdAt,
    prompt: state.prompt,
    attachments: state.attachments || [],
    phase1Status: state.phase1Status,
    phase1Result: state.phase1Result,
    phase1Error: state.phase1Error,
    clarificationAnswers: state.clarificationAnswers || {},
    phase2Status: state.phase2Status,
    phase2Result: state.phase2Result,
    phase2Error: state.phase2Error,
    previousAnswers: state.previousAnswers || [],
    judgmentComment: state.judgmentComment || ""
  };
}

function upsertSession(sessions, session) {
  return [
    session,
    ...sessions.filter((item) => item.id !== session.id)
  ].sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0));
}

function deriveChatTitle(prompt) {
  const clean = String(prompt || "New Chat").replace(/\s+/g, " ").trim();
  return clean.length > 34 ? `${clean.slice(0, 31)}...` : clean || "New Chat";
}

function buildChatMemory({ sessions, turns, activeTurn }) {
  const sessionTurns = [
    ...(turns || []),
    ...(activeTurn ? [activeTurn] : [])
  ];
  const savedTurns = (sessions || []).flatMap((session) => session.turns || []);
  const answeredTurns = [...sessionTurns, ...savedTurns]
    .filter((turn) => turn?.phase2Result?.answer)
    .slice(-8);

  const answerHistory = answeredTurns
    .map((turn, index) => ({
      id: turn.phase2Result.id || turn.id || `history_${index + 1}`,
      answer_variant: "chat_preference",
      answer: sanitizeAssistantText(turn.phase2Result.answer || "").slice(0, 1800),
      reasoning_trace: sanitizeAssistantText(turn.phase2Result.reasoning_trace || "").slice(0, 700),
      self_critique: sanitizeAssistantText(turn.phase2Result.self_critique || "").slice(0, 700),
      reasoning_confidence: sanitizeAssistantText(turn.phase2Result.reasoning_confidence || ""),
      verifiability: sanitizeAssistantText(turn.phase2Result.verifiability || ""),
      user_direction: latestUserDirection(turn)
    }))
    .filter((item) => item.answer);

  const preferenceText = answerHistory
    .slice(-5)
    .map((item, index) => `Preference signal ${index + 1}: ${item.user_direction || item.answer.slice(0, 260)}`)
    .join("\n");

  return { answerHistory, preferenceText };
}

function latestUserDirection(turn) {
  const answer = turn?.previousAnswers?.[0];
  if (turn?.judgmentComment) {
    return sanitizeAssistantText(turn.judgmentComment);
  }
  return sanitizeAssistantText(answer?.alternative_summary || "");
}

function App() {
  const phaseRunRef = useRef("");
  const [currentUserEmail, setCurrentUserEmail] = useState(loadCurrentUser);
  const currentUserName = userNameFromEmail(currentUserEmail);
  const [loginError, setLoginError] = useState("");
  const [sessions, setSessions] = useState(() => (
    currentUserEmail ? loadSessionsForUser(currentUserEmail) : []
  ));
  const initialChatIdRef = useRef(createId("chat"));
  const [chatId, setChatId] = useState(initialChatIdRef.current);
  const [chatGroupId, setChatGroupId] = useState(() => createId("group"));
  const [parentChatId, setParentChatId] = useState("");
  const [chatTitle, setChatTitle] = useState("New Chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [navigationIds, setNavigationIds] = useState([initialChatIdRef.current]);
  const [navigationIndex, setNavigationIndex] = useState(0);
  const [turns, setTurns] = useState([]);
  const [currentTurnId, setCurrentTurnId] = useState("");
  const [currentTurnCreatedAt, setCurrentTurnCreatedAt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [phase1Status, setPhase1Status] = useState("idle");
  const [phase1Result, setPhase1Result] = useState(null);
  const [phase1Error, setPhase1Error] = useState("");
  const [clarificationAnswers, setClarificationAnswers] = useState({});
  const [attachments, setAttachments] = useState([]);
  const [submittedAttachments, setSubmittedAttachments] = useState([]);
  const [isClarifying, setIsClarifying] = useState(false);
  const [phase2Status, setPhase2Status] = useState("idle");
  const [phase2Result, setPhase2Result] = useState(null);
  const [phase2Error, setPhase2Error] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [previousAnswers, setPreviousAnswers] = useState([]);
  const [judgmentComment, setJudgmentComment] = useState("");
  const [healthCheckpointTurnCount, setHealthCheckpointTurnCount] = useState(0);
  const [healthInterruption, setHealthInterruption] = useState(null);
  const [branchContextDraft, setBranchContextDraft] = useState("");
  const [branchContextMemory, setBranchContextMemory] = useState("");
  const [branchContextStatus, setBranchContextStatus] = useState("none");
  const [branchPendingPrompt, setBranchPendingPrompt] = useState("");
  const [branchPendingAttachments, setBranchPendingAttachments] = useState([]);
  const [branchAllowDiscard, setBranchAllowDiscard] = useState(false);
  const activeTurn = activeTurnSnapshot({
    id: currentTurnId,
    createdAt: currentTurnCreatedAt,
    prompt: submittedPrompt,
    attachments: submittedAttachments,
    phase1Status,
    phase1Result,
    phase1Error,
    clarificationAnswers,
    isClarifying,
    phase2Status,
    phase2Result,
    phase2Error,
    previousAnswers,
    judgmentComment
  });
  const visibleTurns = [...turns, activeTurn].filter(Boolean);
  const health = useMemo(
    () => computeConversationHealth(visibleTurns, { checkpointIndex: healthCheckpointTurnCount }),
    [visibleTurns, healthCheckpointTurnCount]
  );
  const groupedHandoffSummary = useMemo(() => buildGroupedHandoffSummary({
    sessions,
    currentTurns: visibleTurns,
    groupId: chatGroupId
  }), [sessions, visibleTurns, chatGroupId]);
  const [handoffDraft, setHandoffDraft] = useState("");
  const canGoBack = navigationIndex > 0;
  const canGoForward = navigationIndex < navigationIds.length - 1;
  const branchContextBlocking = branchContextStatus === "review" || branchContextStatus === "ingesting";
  const mascotThinking = (
    phase1Status === "loading"
    || phase1Status === "health_paused"
    || isClarifying
    || phase2Status === "loading"
    || branchContextStatus === "ingesting"
    || Boolean(healthInterruption)
  );

  useEffect(() => {
    clearLegacySharedHistory();
  }, []);

  useEffect(() => {
    if (
      health.triggered
      && !healthInterruption
      && phase1Status !== "loading"
      && phase1Status !== "health_paused"
      && phase2Status !== "loading"
      && !branchContextBlocking
    ) {
      setHandoffDraft(groupedHandoffSummary);
      setHealthInterruption({
        reason: health.reason,
        reasonCode: health.reasonCode,
        summary: groupedHandoffSummary,
        turnCount: visibleTurns.length
      });
    }
  }, [
    health.triggered,
    health.reason,
    healthInterruption,
    groupedHandoffSummary,
    visibleTurns.length,
    phase1Status,
    phase2Status,
    branchContextBlocking
  ]);

  useEffect(() => {
    if (currentUserEmail) {
      saveSessionsForUser(currentUserEmail, sessions);
    }
  }, [currentUserEmail, sessions]);

  async function runPhase1Request({ cleanPrompt, turnAttachments, nextTurns, runId }) {
    const memory = buildChatMemory({
      sessions,
      turns: nextTurns,
      activeTurn: null
    });
    const previousContext = {
      chat_preferences: memory.preferenceText,
      prior_answer_history: memory.answerHistory
    };
    if (branchContextMemory) {
      previousContext.grouped_handoff_summary = branchContextMemory;
    }

    setPhase1Status("loading");
    setPhase1Error("");

    try {
      const result = await requestPhase1(
        buildPhase1Payload(cleanPrompt, {
          attachments: turnAttachments,
          previous_context: previousContext
        })
      );
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase1Result(result);
      setPhase1Status("ready");
    } catch (error) {
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase1Error(error instanceof Error ? error.message : "Context request failed.");
      setPhase1Status("error");
    }
  }

  async function handlePhase1Submit() {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || phase1Status === "loading" || branchContextBlocking) {
      return;
    }

    const turnAttachments = attachments;
    const nextTurns = activeTurn ? [...turns, activeTurn] : turns;
    const nextTurnId = createId("turn");
    const nextCreatedAt = new Date().toISOString();
    const runId = nextTurnId;
    const candidateTurns = [
      ...nextTurns,
      {
        id: nextTurnId,
        createdAt: nextCreatedAt,
        prompt: cleanPrompt,
        attachments: turnAttachments
      }
    ];
    const projectedHealth = computeConversationHealth(candidateTurns, {
      checkpointIndex: healthCheckpointTurnCount
    });
    const projectedSummary = buildGroupedHandoffSummary({
      sessions,
      currentTurns: candidateTurns,
      groupId: chatGroupId
    });

    setTurns(nextTurns);
    phaseRunRef.current = runId;
    setChatTitle((current) => current === "New Chat" ? deriveChatTitle(cleanPrompt) : current);
    setCurrentTurnId(nextTurnId);
    setCurrentTurnCreatedAt(nextCreatedAt);
    setPhase1Status(projectedHealth.triggered ? "health_paused" : "loading");
    setPhase1Result(null);
    setPhase1Error("");
    setClarificationAnswers({});
    setPhase2Status("idle");
    setPhase2Result(null);
    setPhase2Error("");
    setPreviousAnswers([]);
    setJudgmentComment("");
    setSubmittedPrompt(cleanPrompt);
    setSubmittedAttachments(turnAttachments);
    setPrompt("");
    setAttachments([]);

    if (projectedHealth.triggered) {
      setHandoffDraft(projectedSummary);
      setHealthInterruption({
        reason: projectedHealth.reason,
        reasonCode: projectedHealth.reasonCode,
        summary: projectedSummary,
        turnCount: candidateTurns.length
      });
      return;
    }

    setHealthInterruption(null);
    setHandoffDraft("");
    await runPhase1Request({ cleanPrompt, turnAttachments, nextTurns, runId });
  }

  async function handleAddFiles(files) {
    const nextAttachments = await filesToPhase1Attachments(files);
    setAttachments((current) => {
      const existingKeys = new Set(current.map((item) => `${item.name}:${item.size}`));
      const merged = [...current];
      for (const attachment of nextAttachments) {
        const key = `${attachment.name}:${attachment.size}`;
        if (!existingKeys.has(key)) {
          merged.push(attachment);
        }
      }
      return merged;
    });
  }

  function handleRemoveAttachment(name, size) {
    setAttachments((current) => current.filter((item) => item.name !== name || item.size !== size));
  }

  function handleQuestionAnswer(questionId, value) {
    setClarificationAnswers((current) => ({
      ...current,
      [questionId]: value
    }));
  }

  async function handleResolveStep(step, value) {
    const answerValue = String(value || "").trim();
    if (!phase1Result || !answerValue || step.type === "format") {
      return;
    }

    const nextAnswers = {
      ...clarificationAnswers,
      [step.id]: answerValue
    };

    setClarificationAnswers(nextAnswers);
    setIsClarifying(true);
    setPhase1Error("");

    try {
      const result = await requestPhase1Clarification(
        buildPhase1Payload(submittedPrompt, {
          attachments: submittedAttachments,
          clarification_answers: nextAnswers,
          latest_clarification: {
            id: step.id,
            type: step.type,
            title: step.title,
            body: step.body,
            value: answerValue
          },
          previous_context: phase1Result
        })
      );
      setPhase1Result(result);
    } catch (error) {
      setPhase1Error(error instanceof Error ? error.message : "Clarification failed.");
      setPhase1Status("error");
    } finally {
      setIsClarifying(false);
    }
  }

  async function handlePhase2Submit(selectedOutputFormat) {
    if (!phase1Result || phase2Status === "loading") {
      return;
    }

    setPhase2Status("loading");
    setPhase2Error("");
    const runId = `${currentTurnId}:answer:${Date.now()}`;
    phaseRunRef.current = runId;
    const memory = buildChatMemory({
      sessions,
      turns,
      activeTurn
    });

    try {
      const result = await requestPhase2(
        buildPhase2Payload(submittedPrompt, phase1Result, {
          attachments: submittedAttachments,
          clarification_answers: {
            ...clarificationAnswers,
            chat_preference_context: memory.preferenceText,
            grouped_handoff_summary: branchContextMemory || undefined
          },
          selected_output_format: selectedOutputFormat,
          answer_history: memory.answerHistory
        })
      );
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase2Result(result);
      setPreviousAnswers([]);
      setJudgmentComment("");
      setPhase2Status("ready");
    } catch (error) {
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase2Error(error instanceof Error ? error.message : "Answer request failed.");
      setPhase2Status("error");
    }
  }

  async function handleAlternativeAnswer() {
    if (!phase1Result || !phase2Result || phase2Status === "loading") {
      return;
    }

    const currentResult = phase2Result;
    const memory = buildChatMemory({ sessions, turns, activeTurn });
    const runId = `${currentTurnId}:alternative:${Date.now()}`;
    phaseRunRef.current = runId;
    setPreviousAnswers((current) => [currentResult, ...current]);
    setPhase2Status("loading");
    setPhase2Error("");

    try {
      const result = await requestPhase2(
        buildPhase2Payload(submittedPrompt, phase1Result, {
          attachments: submittedAttachments,
          clarification_answers: {
            ...clarificationAnswers,
            chat_preference_context: memory.preferenceText,
            grouped_handoff_summary: branchContextMemory || undefined
          },
          selected_output_format: "Alternative answer",
          answer_variant: "alternative",
          previous_answer: currentResult.answer,
          answer_history: [
            ...buildAnswerHistory(currentResult, previousAnswers),
            ...memory.answerHistory
          ]
        })
      );
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase2Result(result);
      setPhase2Status("ready");
    } catch (error) {
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase2Result(currentResult);
      setPreviousAnswers((current) => current.slice(1));
      setPhase2Error(error instanceof Error ? error.message : "Alternative answer failed.");
      setPhase2Status("error");
    }
  }

  async function handleJudgmentRegenerate(comment) {
    if (!phase1Result || !phase2Result || phase2Status === "loading" || !comment.trim()) {
      return;
    }

    const currentResult = phase2Result;
    const memory = buildChatMemory({ sessions, turns, activeTurn });
    const runId = `${currentTurnId}:judgment:${Date.now()}`;
    phaseRunRef.current = runId;
    setPreviousAnswers((current) => [currentResult, ...current]);
    setPhase2Status("loading");
    setPhase2Error("");

    try {
      const result = await requestPhase2(
        buildPhase2Payload(submittedPrompt, phase1Result, {
          attachments: submittedAttachments,
          clarification_answers: {
            ...clarificationAnswers,
            chat_preference_context: memory.preferenceText,
            grouped_handoff_summary: branchContextMemory || undefined,
            judgment_direction: comment.trim()
          },
          selected_output_format: "Regenerate with user judgment direction",
          answer_variant: "judgment_refined",
          previous_answer: currentResult.answer,
          judgment_direction: comment.trim(),
          answer_history: [
            ...buildAnswerHistory(currentResult, previousAnswers, comment.trim()),
            ...memory.answerHistory
          ]
        })
      );
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase2Result(result);
      setJudgmentComment("");
      setPhase2Status("ready");
    } catch (error) {
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase2Result(currentResult);
      setPreviousAnswers((current) => current.slice(1));
      setPhase2Error(error instanceof Error ? error.message : "Regeneration failed.");
      setPhase2Status("error");
    }
  }

  function saveCurrentSession() {
    const sessionTurns = [...turns, activeTurn].filter(Boolean);
    if (!sessionTurns.length) {
      return;
    }
    const existingSession = sessions.find((item) => item.id === chatId);
    const session = {
      id: chatId,
      groupId: chatGroupId,
      parentId: parentChatId,
      title: chatTitle === "New Chat" ? deriveChatTitle(sessionTurns[0]?.prompt || "New Chat") : chatTitle,
      turns: sessionTurns,
      createdAt: existingSession?.createdAt || sessionTurns[0]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    setSessions((current) => {
      const nextSessions = upsertSession(current, session);
      if (currentUserEmail) {
        saveSessionsForUser(currentUserEmail, nextSessions);
      }
      return nextSessions;
    });
  }

  function clearActiveTransaction() {
    phaseRunRef.current = "";
    setPrompt("");
    setPhase1Status("idle");
    setPhase1Result(null);
    setPhase1Error("");
    setClarificationAnswers({});
    setAttachments([]);
    setSubmittedAttachments([]);
    setPhase2Status("idle");
    setPhase2Result(null);
    setPhase2Error("");
    setSubmittedPrompt("");
    setPreviousAnswers([]);
    setJudgmentComment("");
    setCurrentTurnId("");
    setCurrentTurnCreatedAt("");
    setHandoffDraft("");
    setHealthInterruption(null);
  }

  function clearBranchContext() {
    setBranchContextDraft("");
    setBranchContextMemory("");
    setBranchContextStatus("none");
    setBranchPendingPrompt("");
    setBranchPendingAttachments([]);
    setBranchAllowDiscard(false);
  }

  function resetWorkspaceState({ nextChatId = createId("chat"), nextGroupId = createId("group") } = {}) {
    phaseRunRef.current = "";
    setChatId(nextChatId);
    setChatGroupId(nextGroupId);
    setParentChatId("");
    setChatTitle("New Chat");
    setTurns([]);
    clearActiveTransaction();
    setHealthCheckpointTurnCount(0);
    clearBranchContext();
    setNavigationIds([nextChatId]);
    setNavigationIndex(0);
    setChatSearch("");
    setSearchOpen(false);
  }

  function handleSignIn(email) {
    const displayEmail = String(email || "").trim();
    const cleanEmail = normalizeEmail(displayEmail);
    if (!isValidEmail(displayEmail)) {
      setLoginError("Enter a valid email address.");
      return;
    }

    clearLegacySharedHistory();
    saveCurrentUser(displayEmail);
    setCurrentUserEmail(displayEmail);
    setLoginError("");
    setSessions(loadSessionsForUser(cleanEmail));
    resetWorkspaceState();
  }

  function handleLogout() {
    saveCurrentSession();
    clearCurrentUser();
    setCurrentUserEmail("");
    setLoginError("");
    setSessions([]);
    resetWorkspaceState();
  }

  function rememberNavigation(nextChatId) {
    setNavigationIds((current) => {
      const base = current.slice(0, navigationIndex + 1);
      if (base[base.length - 1] === nextChatId) {
        return base;
      }
      return [...base, nextChatId];
    });
    setNavigationIndex((current) => current + 1);
  }

  function resetChat() {
    saveCurrentSession();
    const nextChatId = createId("chat");
    setChatId(nextChatId);
    setChatGroupId(createId("group"));
    setParentChatId("");
    setChatTitle("New Chat");
    setTurns([]);
    clearActiveTransaction();
    setHealthCheckpointTurnCount(0);
    clearBranchContext();
    rememberNavigation(nextChatId);
  }

  function branchHealthChat() {
    const summary = healthInterruption?.summary || handoffDraft || groupedHandoffSummary || health.summary;
    const pendingPrompt = submittedPrompt;
    const pendingAttachments = submittedAttachments;
    const allowDiscard = healthInterruption?.reasonCode === "topic_drift";
    saveCurrentSession();
    const nextChatId = createId("chat");
    setChatId(nextChatId);
    setChatGroupId(chatGroupId);
    setParentChatId(chatId);
    setChatTitle(`Follow-up: ${chatTitle === "New Chat" ? "Current chat" : chatTitle}`);
    setTurns([]);
    clearActiveTransaction();
    setHealthCheckpointTurnCount(0);
    setBranchContextDraft(summary);
    setBranchContextMemory("");
    setBranchContextStatus("review");
    setBranchPendingPrompt(pendingPrompt);
    setBranchPendingAttachments(pendingAttachments);
    setBranchAllowDiscard(allowDiscard);
    rememberNavigation(nextChatId);
  }

  async function handleContinueAfterHealth() {
    const nextCheckpoint = visibleTurns.length;
    setHealthCheckpointTurnCount(nextCheckpoint);
    setHealthInterruption(null);
    setHandoffDraft("");

    if (phase1Status !== "health_paused" || !submittedPrompt) {
      return;
    }

    const runId = `${currentTurnId}:health-continue:${Date.now()}`;
    phaseRunRef.current = runId;
    await runPhase1Request({
      cleanPrompt: submittedPrompt,
      turnAttachments: submittedAttachments,
      nextTurns: turns,
      runId
    });
  }

  function handleIngestBranchContext() {
    const summary = branchContextDraft.trim();
    if (!summary || branchContextStatus === "ingesting") {
      return;
    }
    setBranchContextStatus("ingesting");
    window.setTimeout(() => {
      setBranchContextMemory(summary);
      setBranchContextStatus("ready");
      setPrompt(branchPendingPrompt);
      setAttachments(branchPendingAttachments);
    }, 850);
  }

  function handleDiscardBranchContext() {
    setBranchContextMemory("");
    setBranchContextStatus("ready");
    setPrompt(branchPendingPrompt);
    setAttachments(branchPendingAttachments);
  }

  function loadSession(sessionId) {
    if (sessionId === chatId) {
      return false;
    }
    saveCurrentSession();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      return false;
    }
    setChatId(session.id);
    setChatGroupId(session.groupId || session.id || createId("group"));
    setParentChatId(session.parentId || "");
    setChatTitle(session.title || "Chat");
    setTurns(Array.isArray(session.turns) ? session.turns : []);
    clearActiveTransaction();
    setHealthCheckpointTurnCount(Array.isArray(session.turns) ? session.turns.length : 0);
    clearBranchContext();
    return true;
  }

  function handleSelectSession(sessionId) {
    if (loadSession(sessionId)) {
      rememberNavigation(sessionId);
    }
  }

  function handleDeleteSession(sessionId) {
    const nextSessions = removeSessionById(sessions, sessionId);
    setSessions(nextSessions);
    if (currentUserEmail) {
      saveSessionsForUser(currentUserEmail, nextSessions);
    }
    const nextNavigationIds = navigationIds.filter((id) => id !== sessionId);
    setNavigationIds((current) => {
      const filtered = current.filter((id) => id !== sessionId);
      return filtered.length ? filtered : [chatId];
    });
    setNavigationIndex((current) => Math.max(0, Math.min(current, Math.max(0, nextNavigationIds.length - 1))));

    if (sessionId === chatId) {
      resetWorkspaceState();
    }
  }

  function handleNavigateHistory(direction) {
    const nextIndex = navigationIndex + direction;
    if (nextIndex < 0 || nextIndex >= navigationIds.length) {
      return;
    }
    const nextChatId = navigationIds[nextIndex];
    if (nextChatId === chatId) {
      setNavigationIndex(nextIndex);
      return;
    }
    if (loadSession(nextChatId)) {
      setNavigationIndex(nextIndex);
    }
  }

  async function handleEditCurrentPrompt(nextPrompt) {
    const cleanPrompt = String(nextPrompt || "").trim();
    if (!cleanPrompt || phase1Status === "loading") {
      return;
    }

    const turnAttachments = submittedAttachments;
    const runId = `${currentTurnId || createId("turn")}:edit:${Date.now()}`;
    phaseRunRef.current = runId;
    setSubmittedPrompt(cleanPrompt);
    setPhase1Status("loading");
    setPhase1Result(null);
    setPhase1Error("");
    setClarificationAnswers({});
    setPhase2Status("idle");
    setPhase2Result(null);
    setPhase2Error("");
    setPreviousAnswers([]);
    setJudgmentComment("");

    try {
      const memory = buildChatMemory({ sessions, turns, activeTurn: null });
      const previousContext = {
        chat_preferences: memory.preferenceText,
        prior_answer_history: memory.answerHistory
      };
      if (branchContextMemory) {
        previousContext.grouped_handoff_summary = branchContextMemory;
      }
      const result = await requestPhase1(
        buildPhase1Payload(cleanPrompt, {
          attachments: turnAttachments,
          previous_context: previousContext
        })
      );
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase1Result(result);
      setPhase1Status("ready");
    } catch (error) {
      if (phaseRunRef.current !== runId) {
        return;
      }
      setPhase1Error(error instanceof Error ? error.message : "Context request failed.");
      setPhase1Status("error");
    }
  }

  async function handleRetryCurrentPrompt() {
    await handleEditCurrentPrompt(submittedPrompt);
  }

  async function handleEditSavedTurn(turnId, nextPrompt) {
    const targetIndex = turns.findIndex((turn) => turn.id === turnId);
    if (targetIndex < 0) {
      return;
    }

    const targetTurn = turns[targetIndex];
    const cleanPrompt = String(nextPrompt || "").trim() || targetTurn.prompt;
    const priorTurns = turns.slice(0, targetIndex);
    const turnAttachments = targetTurn.attachments || [];
    const runId = `${turnId}:saved-edit:${Date.now()}`;

    phaseRunRef.current = runId;
    setTurns(priorTurns);
    setCurrentTurnId(targetTurn.id);
    setCurrentTurnCreatedAt(targetTurn.createdAt || new Date().toISOString());
    setSubmittedPrompt(cleanPrompt);
    setSubmittedAttachments(turnAttachments);
    setPhase1Status("loading");
    setPhase1Result(null);
    setPhase1Error("");
    setClarificationAnswers({});
    setPhase2Status("idle");
    setPhase2Result(null);
    setPhase2Error("");
    setPreviousAnswers([]);
    setJudgmentComment("");
    setHealthInterruption(null);
    setHandoffDraft("");

    await runPhase1Request({
      cleanPrompt,
      turnAttachments,
      nextTurns: priorTurns,
      runId
    });
  }

  if (!currentUserEmail) {
    return <LoginScreen onSignIn={handleSignIn} error={loginError} />;
  }

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <TopChrome
        sidebarOpen={sidebarOpen}
        searchOpen={searchOpen}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
        onToggleSearch={() => {
          setSearchOpen((value) => !value);
          setSidebarOpen(true);
        }}
        onBack={() => handleNavigateHistory(-1)}
        onForward={() => handleNavigateHistory(1)}
        onLogout={handleLogout}
      />
      <div className="workspace">
        {sidebarOpen && (
          <Sidebar
            sessions={sessions}
            activeSessionId={chatId}
            onNewSession={resetChat}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            searchOpen={searchOpen}
            searchValue={chatSearch}
            onSearch={setChatSearch}
            userName={currentUserName}
          />
        )}
        <section className="canvas">
          {healthInterruption && (
            <HealthNotice
              reason={healthInterruption.reason}
              onContinue={handleContinueAfterHealth}
              onBranch={branchHealthChat}
            />
          )}
          <div className="content-wrap">
            {visibleTurns.length === 0 ? (
              <>
                {branchContextStatus === "review" || branchContextStatus === "ingesting" ? (
                  <BranchContextPanel
                    value={branchContextDraft}
                    status={branchContextStatus}
                    allowDiscard={branchAllowDiscard}
                    onChange={setBranchContextDraft}
                    onIngest={handleIngestBranchContext}
                    onDiscard={handleDiscardBranchContext}
                  />
                ) : (
                  <>
                    <header className="welcome">
                      <ClaudeMark />
                      <h1>Hold onto your hats, {currentUserName}!</h1>
                    </header>
                    <UsagePanel />
                  </>
                )}
              </>
            ) : (
              <ChatThread
                turns={turns}
                activeTurn={activeTurn}
                onEditSavedTurn={handleEditSavedTurn}
                onEditCurrentPrompt={handleEditCurrentPrompt}
                onRetry={handleRetryCurrentPrompt}
                contextPanel={
                  phase2Status === "idle" && !healthInterruption && phase1Status !== "health_paused" ? (
                    <ContextPanel
                      key={phase1Result?.id || phase1Status}
                      status={phase1Status}
                      result={phase1Result}
                      error={phase1Error}
                      answers={clarificationAnswers}
                      onAnswer={handleQuestionAnswer}
                      isClarifying={isClarifying}
                      onResolveStep={handleResolveStep}
                      phase2Status={phase2Status}
                      onAnswerSubmit={handlePhase2Submit}
                    />
                  ) : null
                }
                answerPanel={
                  phase2Status !== "idle" ? (
                    <AnswerPanel
                      status={phase2Status}
                      result={phase2Result}
                      error={phase2Error}
                      prompt={submittedPrompt}
                      previousAnswers={previousAnswers}
                      onAlternativeAnswer={handleAlternativeAnswer}
                      judgmentComment={judgmentComment}
                      onJudgmentComment={setJudgmentComment}
                      onJudgmentRegenerate={handleJudgmentRegenerate}
                    />
                  ) : null
                }
              />
            )}
          </div>

          <Composer
            prompt={prompt}
            onPrompt={setPrompt}
            onSubmit={handlePhase1Submit}
            isLoading={phase1Status === "loading" || branchContextStatus === "ingesting"}
            disabled={branchContextBlocking}
            attachments={attachments}
            onAddFiles={handleAddFiles}
            onRemoveAttachment={handleRemoveAttachment}
            hasEditedAfterAnswer={false}
            mascotThinking={mascotThinking}
          />
        </section>
      </div>
    </main>
  );
}

function UsagePanel() {
  return (
    <section className="insight-panel starter-panel" aria-label="Guided context">
      <p className="phase-nudge">
        Send a prompt or add files. Gemini clarifies missing context, answers with inline reasoning and critique, then watches thread health so you can branch before drift creeps in.
      </p>
    </section>
  );
}

function LoginScreen({ onSignIn, error }) {
  const [email, setEmail] = useState("");

  function handleSubmit(event) {
    event.preventDefault();
    onSignIn(email);
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-label="Sign in">
        <div className="login-mark">
          <ClaudeMark />
          <strong>Guided Claude Prototype</strong>
        </div>
        <h1>Sign in to continue</h1>
        <p>Your chat history and preferences stay tied to this email. No password is required.</p>
        <form onSubmit={handleSubmit}>
          <label>
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@domain.com"
              autoFocus
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit">Continue</button>
        </form>
      </section>
    </main>
  );
}

function ChatThread({
  turns,
  activeTurn,
  onEditSavedTurn,
  onEditCurrentPrompt,
  onRetry,
  contextPanel,
  answerPanel
}) {
  return (
    <section className="chat-thread" aria-label="Chat conversation">
      {turns.map((turn) => (
        <TransactionTurn
          key={turn.id}
          turn={turn}
          onSavePrompt={(value) => onEditSavedTurn(turn.id, value)}
          readOnly
        />
      ))}
      {activeTurn && (
        <article className="transaction-turn active-transaction">
          <UserMessage
            prompt={activeTurn.prompt}
            attachments={activeTurn.attachments}
            onSavePrompt={onEditCurrentPrompt}
            onRetry={onRetry}
          />
          {contextPanel}
          {answerPanel}
        </article>
      )}
    </section>
  );
}

function HealthNotice({ reason, onContinue, onBranch }) {
  return (
    <section className="health-notice" aria-label="Conversation health notice">
      <div className="health-head">
        <Sparkles size={14} />
        <strong>Health Notice</strong>
      </div>
      <p>
        Long or drifting threads can accumulate stale assumptions. You can continue here, or start a
        grouped chat with a cleaner context handoff.
      </p>
      <div className="health-reasons"><span>{reason}</span></div>
      <div className="health-actions">
        <button type="button" onClick={onContinue}>Continue chat</button>
        <button type="button" onClick={onBranch}>
          <GitBranchPlus size={14} />
          Start grouped chat
        </button>
      </div>
    </section>
  );
}

function BranchContextPanel({ value, status, allowDiscard, onChange, onIngest, onDiscard }) {
  const isIngesting = status === "ingesting";
  return (
    <section className="branch-context" aria-label="Grouped chat handoff">
      <div className="health-head">
        <GitBranchPlus size={14} />
        <strong>Grouped Chat Context</strong>
      </div>
      {isIngesting ? (
        <>
          <p>Feeding the handoff summary into this grouped chat. The composer will unlock when the context is ready.</p>
          <div className="phase-skeleton" />
        </>
      ) : (
        <>
          <p>
            Review the handoff from the previous grouped chats. Edit it if needed, then use it as hidden
            context for this branch.
          </p>
          <label>
            <span>Editable handoff summary</span>
            <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={9} />
          </label>
          <div className="branch-context-actions">
            <button type="button" onClick={onIngest} disabled={!value.trim()}>
              Use as context
            </button>
            {allowDiscard && (
              <button className="quiet" type="button" onClick={onDiscard}>
                Discard summary
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function TransactionTurn({ turn, onSavePrompt, readOnly }) {
  return (
    <article className="transaction-turn">
      <UserMessage prompt={turn.prompt} attachments={turn.attachments || []} onSavePrompt={onSavePrompt} />
      {turn.phase2Result && (
        <AnswerPanel
          status={turn.phase2Status || "ready"}
          result={turn.phase2Result}
          error={turn.phase2Error}
          prompt={turn.prompt}
          previousAnswers={turn.previousAnswers || []}
          readOnly={readOnly}
        />
      )}
    </article>
  );
}

function UserMessage({ prompt, attachments = [], onSavePrompt, onRetry }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(prompt);

  useEffect(() => {
    setDraft(prompt);
  }, [prompt]);

  async function saveEdit() {
    const clean = draft.trim();
    if (!clean) {
      return;
    }
    setIsEditing(false);
    await onSavePrompt?.(clean);
  }

  return (
    <article className="user-turn">
      {isEditing ? (
        <div className="user-bubble editing">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveEdit();
              }
              if (event.key === "Escape") {
                setDraft(prompt);
                setIsEditing(false);
              }
            }}
            autoFocus
          />
          <div className="inline-edit-actions">
            <button type="button" onClick={saveEdit}>Save</button>
            <button
              type="button"
              onClick={() => {
                setDraft(prompt);
                setIsEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="user-message-stack">
          <button className="user-bubble as-button" type="button" onClick={() => setIsEditing(true)}>
            {prompt}
          </button>
          <MessageAttachments attachments={attachments} />
        </div>
      )}
      <div className="turn-actions" aria-label="Prompt actions">
        <span>{new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        {onRetry && (
          <IconButton label="Retry" onClick={onRetry}>
            <RefreshCcw size={14} />
          </IconButton>
        )}
        <IconButton label="Edit prompt" onClick={() => setIsEditing(true)}>
          <Edit3 size={14} />
        </IconButton>
        <IconButton label="Copy prompt" onClick={() => navigator.clipboard?.writeText(prompt)}>
          <Copy size={14} />
        </IconButton>
      </div>
    </article>
  );
}

function ContextPanel({
  status,
  result,
  error,
  answers,
  onAnswer,
  isClarifying,
  onResolveStep,
  phase2Status,
  onAnswerSubmit
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const steps = useMemo(() => buildPhase1Steps(result), [result]);
  const currentStep = steps[stepIndex];
  const currentAnswerId = currentStep ? answerIdForStep(result, currentStep) : "";
  const currentStepForView = currentStep
    ? { ...currentStep, answerId: currentAnswerId }
    : null;
  const summary = summarizePhase1Selections(result, answers);
  const resolution = phase1StepResolution(currentStepForView, answers);

  if (status === "loading") {
    return (
      <section className="context-card" aria-label="Checking context">
        <p className="phase-nudge">Reading the request and checking whether anything decision-changing is missing.</p>
        <div className="phase-skeleton" />
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="context-card" aria-label="Context error">
        <div className="phase-block-title">Connection</div>
        <strong>Backend unavailable</strong>
        <p className="phase-nudge">{error}</p>
        <p className="phase-small">Start the Python backend on port 8501, then send the prompt again.</p>
      </section>
    );
  }

  const needsClarification = phase1NeedsClarification(result);
  const contextLabel = needsClarification ? "Clarify" : phase1ExitLabel(result);

  return (
    <section className="context-card" aria-label="Context clarification">
      <div className="context-card-head">
        <ClaudeMark />
        <strong>{isClarifying ? "Updating the next question..." : contextLabel}</strong>
      </div>

      {result?.reliability_nudge && <p className="phase-nudge">{result.reliability_nudge}</p>}

      {currentStep ? (
        <PhaseStep
          step={currentStepForView}
          value={answers[currentAnswerId] || ""}
          selectedFormat={summary.format}
          onAnswer={onAnswer}
        />
      ) : (
        <div className="phase-step">
          <div className="phase-block-title">Ready to answer</div>
          <strong>Enough context to answer.</strong>
          <p>I can answer now without another clarification.</p>
        </div>
      )}

      <div className="phase-actions">
        <button
          type="button"
          disabled={stepIndex === 0}
          onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
        >
          Back
        </button>
        {stepIndex < steps.length - 1 ? (
          <button
            className="primary"
            type="button"
            onClick={() => {
              if (currentStep?.type === "format" && !answers.output_format) {
                onAnswer("output_format", currentStep.recommended);
              }
              if (currentStep?.type !== "format") {
                const value = resolution.value;
                if (value) {
                  onAnswer(currentAnswerId, value);
                }
                onResolveStep(currentStep, value);
              } else {
                setStepIndex((index) => Math.min(steps.length - 1, index + 1));
              }
            }}
            disabled={isClarifying || !resolution.canContinue}
          >
            {isClarifying ? "Updating" : "Next"}
          </button>
        ) : (
          <button
            className="primary"
            type="button"
            onClick={() => {
              if (currentStep?.type === "format" && !answers.output_format) {
                onAnswer("output_format", currentStep.recommended);
              }
              onAnswerSubmit(summary.format || currentStep?.recommended || result.recommended_output_format);
            }}
            disabled={isClarifying || phase2Status === "loading"}
          >
            {phase2Status === "loading" ? "Answering" : "Continue"}
          </button>
        )}
      </div>
      {currentStep && !resolution.canContinue && (
        <p className="phase-small">{resolution.reason}</p>
      )}
    </section>
  );
}

function answerIdForStep(result, step) {
  if (!step) {
    return "";
  }
  if (step.type === "format") {
    return "output_format";
  }
  return `${result?.id || "context"}:${step.id}`;
}

function buildAnswerHistory(currentResult, previousAnswers = [], currentDirection = "") {
  return [currentResult, ...(previousAnswers || [])]
    .filter(Boolean)
    .slice(0, 4)
    .map((item, index) => ({
      id: item.id || `answer_${index + 1}`,
      answer_variant: index === 0 ? "current" : "previous",
      answer: sanitizeAssistantText(item.answer || "").slice(0, 2400),
      reasoning_trace: sanitizeAssistantText(item.reasoning_trace || "").slice(0, 900),
      self_critique: sanitizeAssistantText(item.self_critique || "").slice(0, 900),
      reasoning_confidence: sanitizeAssistantText(item.reasoning_confidence || ""),
      verifiability: sanitizeAssistantText(item.verifiability || ""),
      alternative_summary: sanitizeAssistantText(item.alternative_summary || ""),
      user_direction: index === 0 ? currentDirection : ""
    }));
}

function AnswerPanel({
  status,
  result,
  error,
  prompt,
  previousAnswers,
  onAlternativeAnswer,
  judgmentComment,
  onJudgmentComment,
  onJudgmentRegenerate,
  readOnly = false
}) {
  if (status === "loading") {
    return (
      <section className="assistant-turn" aria-label="Assistant response">
        <p className="phase-nudge">Generating the answer and its confidence checks.</p>
        <div className="phase-skeleton" />
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="assistant-turn" aria-label="Assistant response error">
        <div className="phase-block-title">Connection</div>
        <strong>Unavailable</strong>
        <p className="phase-nudge">{error}</p>
      </section>
    );
  }

  const confidence = confidenceSummary(result);
  const affordances = buildAnswerAffordances(result);
  const visibleTypes = visibleAnnotationTypes(result?.answer || "", affordances);
  const visibleCounts = visibleAnnotationCounts(result?.answer || "", affordances);
  const hasJudgmentCall = confidence.verifiabilityTone === "judgment";
  const hasVerifiableClaims = visibleTypes.has("verifiable");
  const reasoningBadge = visibleCounts.why >= visibleCounts.uncertainty
    ? "Strong Reasoning"
    : "Not Sure";
  const reasoningTone = reasoningBadge === "Strong Reasoning" ? "solid" : "caution";

  return (
    <section className="answer-card" aria-label="Assistant response">
      <div className="answer-card-head">
        <div className="answer-question">"{prompt}"</div>
        <div className="answer-dials" aria-label="Answer confidence">
          <span className={`dial-pill ${reasoningTone}`}>
            <Sparkles size={13} />
            {reasoningBadge}
          </span>
          {hasVerifiableClaims && (
            <span className="dial-pill checkable">
              <Scale size={13} />
              Verifiable Claims
            </span>
          )}
          {hasJudgmentCall && (
            <span className="dial-pill judgment">
              <Scale size={13} />
              Judgment Call
            </span>
          )}
        </div>
      </div>
      <RichAnswer result={result} affordances={affordances} />
      <AnswerFooter affordances={affordances} />
      {hasJudgmentCall && !readOnly && (
        <JudgmentDirection
          value={judgmentComment}
          onChange={onJudgmentComment}
          onRegenerate={() => onJudgmentRegenerate(judgmentComment)}
        />
      )}
      {!readOnly && (
        <button className="alternative-button" type="button" onClick={onAlternativeAnswer}>
          <Shuffle size={14} />
          An alternative you might prefer
        </button>
      )}
      {affordances.alternativeSummary && (
        <div className="alternative-preview">
          <strong>Alternative approach</strong>
          <p>{affordances.alternativeSummary}</p>
        </div>
      )}
      <AnswerHistory answers={previousAnswers} />
      <div className="answer-legend" aria-label="Answer legend">
        <span><i className="legend-why" /> tap = why this follows</span>
        <span><i className="legend-risk" /> tap = where it's shaky</span>
        <span><i className="legend-check" /> verifiable fact</span>
        <span><i className="legend-judgment">-</i> judgment call</span>
      </div>
    </section>
  );
}

function RichAnswer({ result, affordances }) {
  const [openReveal, setOpenReveal] = useState(null);
  const blocks = splitAnswerBlocks(result.answer);

  return (
    <div className="answer-body">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <div className="code-card" key={`${block.type}-${index}`}>
              <div className="code-language">{block.language || "code"}</div>
              <pre><code>{block.content}</code></pre>
            </div>
          );
        }
        if (block.type === "table") {
          return <AnswerTable key={`${block.type}-${index}`} content={block.content} />;
        }
        return (
          <AnnotatedParagraph
            key={`${block.type}-${index}`}
            text={block.content}
            affordances={affordances}
            openReveal={openReveal}
            onReveal={setOpenReveal}
          />
        );
      })}
    </div>
  );
}

function AnswerHistory({ answers = [] }) {
  const [index, setIndex] = useState(0);
  const total = answers.length;
  const active = total ? answers[Math.min(index, total - 1)] : null;
  const activeAffordances = active ? buildAnswerAffordances(active) : null;

  if (!total || !active || !activeAffordances) {
    return null;
  }

  const safeIndex = Math.min(index, total - 1);
  const goPrevious = () => setIndex((value) => Math.max(0, value - 1));
  const goNext = () => setIndex((value) => Math.min(total - 1, value + 1));

  return (
    <section className="answer-history" aria-label="Previous answers">
      <div className="history-pager">
        <button type="button" onClick={goPrevious} disabled={safeIndex === 0} aria-label="Previous answer">
          <ArrowLeft size={15} />
        </button>
        <span>{safeIndex + 1}/{total}</span>
        <button type="button" onClick={goNext} disabled={safeIndex === total - 1} aria-label="Next answer">
          <ArrowRight size={15} />
        </button>
      </div>
      <div className="history-card">
        <RichAnswer result={active} affordances={activeAffordances} />
        <AnswerFooter affordances={activeAffordances} compact />
      </div>
    </section>
  );
}

function AnnotatedParagraph({ text, affordances, openReveal, onReveal }) {
  const annotations = annotationForText(text, affordances);
  const parts = [];
  let cursor = 0;

  annotations.forEach((annotation, index) => {
    if (annotation.start > cursor) {
      parts.push(text.slice(cursor, annotation.start));
    }

    const id = `${annotation.type}-${annotation.start}-${index}`;
    const segment = text.slice(annotation.start, annotation.end);
    const citationDetail = annotation.verifiableDetail || (annotation.type === "verifiable" ? annotation.detail : "");
    const url = citationDetail ? firstUrl(citationDetail) : "";
    parts.push(
      <span
        className={`inline-affordance ${annotation.type}`}
        key={id}
        role="button"
        tabIndex={0}
        title={citationDetail || "Tap to inspect"}
        onClick={() => onReveal(openReveal === id ? null : id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onReveal(openReveal === id ? null : id);
          }
        }}
      >
        {segment}
        {citationDetail && <span className="claim-dot check">{"\u2713"}</span>}
        {annotation.type === "uncertainty" && <span className="claim-dot judgment">-</span>}
        {citationDetail && (
          <span className="citation-pop" role="tooltip">
            <strong>Why this is verifiable</strong>
            <span>{citationDetail}</span>
            {url && <a href={url} target="_blank" rel="noreferrer">Open reference: {url}</a>}
          </span>
        )}
      </span>
    );

    if (openReveal === id && annotation.type !== "verifiable") {
      parts.push(
        <InlineReveal
          key={`${id}-reveal`}
          type={annotation.type}
          detail={annotation.detail}
        />
      );
    }
    cursor = annotation.end;
  });

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return <p>{parts.length ? parts : text}</p>;
}

function InlineReveal({ type, detail }) {
  return (
    <span className={`inline-reveal ${type}`}>
      <strong>{type === "why" ? "Why this follows" : "Where I'm least sure"}</strong>
      {detail}
    </span>
  );
}

function AnswerFooter({ affordances, compact = false }) {
  return (
    <div className={`answer-footer ${compact ? "compact" : ""}`}>
      {affordances.assumptions.length > 0 && (
        <div className="footer-row">
          <KeyRound size={14} />
          <span><strong>Resting on:</strong> {affordances.assumptions.join("; ")}</span>
        </div>
      )}
      {affordances.changeFactors.length > 0 && (
        <div className="footer-row">
          <Shuffle size={14} />
          <span><strong>Would change my answer:</strong> {affordances.changeFactors.join("; ")}</span>
        </div>
      )}
      {affordances.assumptions.length === 0 && affordances.changeFactors.length === 0 && (
        <div className="footer-row">
          <Minus size={14} />
          <span>No extra assumptions were surfaced for this answer.</span>
        </div>
      )}
    </div>
  );
}

function JudgmentDirection({ value, onChange, onRegenerate }) {
  return (
    <div className="judgment-direction">
      <label>
        <strong>Help steer this judgment call</strong>
        <span>
          This part depends on your private context, so tell Gemini what should matter most before
          regenerating. Useful guidance includes the outcome you want to optimize, constraints that
          cannot move, risk tolerance, scale, deadline, data shape, audience, and which tradeoff should
          win if two good options conflict.
        </span>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Example: optimize for write performance over read speed; this is a write-heavy table, storage is tight, and a slower dashboard is acceptable."
          rows={4}
        />
      </label>
      <button type="button" onClick={onRegenerate} disabled={!value.trim()}>
        Regenerate answer
      </button>
    </div>
  );
}

function MessageAttachments({ attachments = [] }) {
  if (!attachments.length) {
    return null;
  }

  return (
    <div className="user-attachments" aria-label="Attached files in this transaction">
      {attachments.map((attachment) => (
        <span className="user-attachment-chip" key={`${attachment.name}:${attachment.size}`}>
          <Folder size={12} />
          <span>{attachment.name}</span>
        </span>
      ))}
    </div>
  );
}

function AnswerTable({ content }) {
  const table = parseMarkdownTable(content);
  if (!table.headers.length) {
    return <AnnotatedParagraph text={content} affordances={{}} openReveal={null} onReveal={() => {}} />;
  }

  return (
    <div className="answer-table-wrap">
      <table className="answer-table">
        <thead>
          <tr>
            {table.headers.map((header) => <th key={header}>{header}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {table.headers.map((header, cellIndex) => (
                <td key={`${header}-${cellIndex}`}>{row[cellIndex] || ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhaseStep({ step, value, selectedFormat, onAnswer }) {
  const answerId = step.answerId || step.id;

  if (step.type === "format") {
    const activeFormat = selectedFormat || step.recommended;
    return (
      <div className="phase-step">
        <div className="phase-block-title">{step.title}</div>
        <strong>{step.body}</strong>
        <p>{step.prompt}</p>
        <div className="format-options">
          {step.options.map((option) => (
            <button
              className={activeFormat === option ? "active" : ""}
              key={option}
              type="button"
              onClick={() => onAnswer(answerId, option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (step.type === "assumption" || step.type === "impact") {
    return (
      <div className={`phase-step ${step.type}`}>
        <div className="phase-block-title">{step.title}</div>
        <strong>{step.body}</strong>
        <p>{step.prompt}</p>
        <div className="choice-row">
          <button
            className={value.startsWith("Confirmed") || value.startsWith("Include") ? "active" : ""}
            type="button"
            onClick={() => onAnswer(answerId, step.type === "impact" ? `Include: ${step.body}` : `Confirmed: ${step.body}`)}
          >
            Keep
          </button>
          <button
            className={value.startsWith("Change") || value.startsWith("Leave") ? "active" : ""}
            type="button"
            onClick={() => onAnswer(answerId, step.type === "impact" ? `Leave for later: ${step.body}` : "Change: ")}
          >
            Change
          </button>
        </div>
        <input
          value={value.startsWith("Change: ") ? value.replace("Change: ", "") : ""}
          onChange={(event) => onAnswer(answerId, `Change: ${event.target.value}`)}
          placeholder="Required when changing"
          aria-label="Required correction"
        />
      </div>
    );
  }

  return (
    <label className={`phase-step ${step.type}`}>
      <div className="phase-block-title">{step.title}</div>
      <strong>{step.body}</strong>
      <p>{step.prompt}</p>
      <input
        value={value}
        onChange={(event) => onAnswer(answerId, event.target.value)}
        placeholder={step.type === "warning" ? "Correction or constraint" : "Answer briefly"}
      />
    </label>
  );
}

function TopChrome({
  sidebarOpen,
  searchOpen,
  canGoBack,
  canGoForward,
  onToggleSidebar,
  onToggleSearch,
  onBack,
  onForward,
  onLogout
}) {
  return (
    <header className="top-chrome">
      <div className="chrome-left">
        <IconButton label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} onClick={onToggleSidebar}>
          <Menu size={16} />
        </IconButton>
        <IconButton label={sidebarOpen ? "Minimize sidebar" : "Maximize sidebar"} onClick={onToggleSidebar}>
          <PanelLeft size={15} />
        </IconButton>
        <IconButton label={searchOpen ? "Close chat search" : "Search chats"} onClick={onToggleSearch}>
          <Search size={15} />
        </IconButton>
        <IconButton label="Back to previous chat" onClick={onBack} disabled={!canGoBack}>
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton label="Forward to next chat" onClick={onForward} disabled={!canGoForward}>
          <ArrowRight size={15} />
        </IconButton>
      </div>
      <button className="logout-button" type="button" onClick={onLogout}>
        <LogOut size={14} />
        <span>Log out</span>
      </button>
    </header>
  );
}

function Sidebar({
  sessions,
  activeSessionId,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  searchOpen,
  searchValue,
  onSearch,
  userName
}) {
  const cleanSearch = searchValue.trim().toLowerCase();
  const filteredSessions = cleanSearch
    ? sessions.filter((session) => `${session.title || ""} ${(session.turns || []).map((turn) => turn.prompt).join(" ")}`.toLowerCase().includes(cleanSearch))
    : sessions;
  const sessionGroups = groupSessionsForSidebar(filteredSessions);

  return (
    <aside className="sidebar">
      <div className="mode-switch">
        <div className="active" aria-label="Chat mode">
          <MessageSquare size={14} />
          <span>Chat</span>
        </div>
      </div>

      <nav className="primary-nav" aria-label="Main">
        <button className="active" type="button" onClick={onNewSession}>
          <Plus size={14} />
          <span>New Chat</span>
        </button>
      </nav>

      {searchOpen && (
        <label className="chat-search">
          <Search size={13} />
          <input
            value={searchValue}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            autoFocus
          />
        </label>
      )}

      {sessions.length > 0 && (
        <section className="chat-history" aria-label="Chat history">
          <div className="sidebar-section-title">Chats</div>
          <div className="chat-history-list">
            {sessionGroups.map((group) => (
              <div
                className={`chat-group ${group.sessions.length > 1 ? "stacked" : ""} ${group.sessions.some((session) => session.id === activeSessionId) ? "active-group" : ""}`}
                key={group.groupId}
              >
                {group.sessions.map((session) => (
                  <div className={`${session.parentId ? "branch" : ""} session-row`} key={session.id}>
                    <button
                      className={session.id === activeSessionId ? "active session-select" : "session-select"}
                      type="button"
                      onClick={() => onSelectSession(session.id)}
                    >
                      {session.parentId ? <GitBranchPlus size={13} /> : <MessageSquare size={13} />}
                      <span>{session.title || "Chat"}</span>
                    </button>
                    <IconButton label={`Delete ${session.title || "chat"}`} onClick={() => onDeleteSession(session.id)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                ))}
              </div>
            ))}
            {filteredSessions.length === 0 && (
              <div className="empty-search">No matching chats</div>
            )}
          </div>
        </section>
      )}

      <div className="sidebar-bottom">
        <div className="profile">
          <span className="avatar">{userName.slice(0, 1).toUpperCase()}</span>
          <span>{userName}</span>
        </div>
      </div>
    </aside>
  );
}

function Composer({
  prompt,
  onPrompt,
  onSubmit,
  isLoading,
  disabled = false,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  hasEditedAfterAnswer,
  mascotThinking = false
}) {
  const fileInputRef = useRef(null);

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!disabled) {
        onSubmit();
      }
    }
  }

  return (
    <footer className="composer-zone">
      <div className="context-chips" aria-label="Context">
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          <Folder size={14} />
          <span>Add files</span>
        </button>
        <input
          ref={fileInputRef}
          className="file-input"
          type="file"
          multiple
          onChange={(event) => {
            onAddFiles(event.target.files);
            event.target.value = "";
          }}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
      {attachments.length > 0 && (
        <div className="attachment-strip" aria-label="Attached files">
          {attachments.map((attachment) => (
            <span className="attachment-chip" key={`${attachment.name}:${attachment.size}`}>
              <Folder size={12} />
              <span>{attachment.name}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemoveAttachment(attachment.name, attachment.size)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="prompt-row">
        <input
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? "Use the grouped-chat context first" : "Describe a task or ask a question"}
          aria-label="Describe a task or ask a question"
          disabled={disabled}
        />
        <IconButton label={prompt ? "Send" : "Submit"} onClick={onSubmit} disabled={isLoading || disabled}>
          <Send size={15} />
        </IconButton>
      </div>
      <div className="composer-meta">
        <div className="model-status">
          <span>{hasEditedAfterAnswer ? "Prompt edited - send to rerun" : "Gemini 2.5 Pro"}</span>
          <Sparkles size={12} />
        </div>
      </div>
      <PixelMascot thinking={mascotThinking} />
    </footer>
  );
}

function ClaudeMark() {
  return (
    <span className="claude-mark" aria-hidden="true">
      {Array.from({ length: 12 }).map((_, index) => (
        <i key={index} style={{ rotate: `${index * 30}deg` }} />
      ))}
    </span>
  );
}

function PixelMascot({ thinking = false }) {
  return (
    <div className={thinking ? "pixel-mascot thinking" : "pixel-mascot"} aria-hidden="true">
      {Array.from({ length: 25 }).map((_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

function IconButton({ children, label, muted = false, onClick, disabled = false }) {
  return (
    <button
      className={muted ? "icon-button muted" : "icon-button"}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

createRoot(document.getElementById("root")).render(<App />);

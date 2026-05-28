export function phase1NeedsClarification(result) {
  return Boolean(
    result &&
      (
        (result.questions && result.questions.length > 0) ||
        (result.input_warnings && result.input_warnings.length > 0) ||
        (result.impact_notes && result.impact_notes.length > 0) ||
        (result.assumptions && result.assumptions.length > 0) ||
        (result.output_format_options && result.output_format_options.length > 1)
      )
  );
}

export function phase1ExitLabel(result) {
  if (!result) {
    return "Idle";
  }
  if (result.exit_state === "enough_context") {
    return "Ready";
  }
  if (result.exit_state === "insufficient_context") {
    return "Needs input";
  }
  return "Clarify";
}

export function phase1AmbiguityLabel(score) {
  if (score <= 2) {
    return "Low";
  }
  if (score <= 4) {
    return "Medium";
  }
  return "High";
}

export function composeClarifiedPrompt(result, answers) {
  const answerLines = Object.values(answers || {})
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const assumptionLines = (result?.assumptions || [])
    .map((assumption) => assumption.text || assumption)
    .filter(Boolean);

  const parts = [result?.refined_prompt || ""];
  if (answerLines.length) {
    parts.push("Clarifications:");
    parts.push(...answerLines.map((line) => `- ${line}`));
  }
  if (assumptionLines.length) {
    parts.push("Confirmed working assumptions:");
    parts.push(...assumptionLines.map((line) => `- ${line}`));
  }

  return parts.filter(Boolean).join("\n");
}

export function buildPhase1Steps(result) {
  if (!result) {
    return [];
  }

  const steps = [];

  const shouldReviewAssumptions =
    result.exit_state !== "enough_context" ||
    (result.input_warnings || []).length > 0 ||
    (result.impact_notes || []).length > 0 ||
    (result.questions || []).length > 0;

  if (shouldReviewAssumptions) {
    for (const assumption of result.assumptions || []) {
      steps.push({
        id: assumption.id,
        type: "assumption",
        title: "Assumption",
        body: assumption.text || assumption,
        prompt: "Keep this assumption, or change it?"
      });
    }
  }

  for (const [index, warning] of (result.input_warnings || []).entries()) {
    steps.push({
      id: `warning_${index + 1}`,
      type: "warning",
      title: "Check input",
      body: warning,
      prompt: "This may be wrong or too broad. How should I correct it before continuing?"
    });
  }

  for (const [index, note] of (result.impact_notes || []).entries()) {
    steps.push({
      id: `impact_${index + 1}`,
      type: "impact",
      title: "Possible repercussions",
      body: note,
      prompt: "Should this be included in the action scope?"
    });
  }

  for (const question of result.questions || []) {
    steps.push({
      id: question.id,
      type: "question",
      title: "Clarify",
      body: question.question,
      prompt: "Answer briefly so the next prompt is specific."
    });
  }

  if ((result.output_format_options || []).length > 1) {
    steps.push({
      id: "output_format",
      type: "format",
      title: "Answer form",
      body: "Choose how you'd like the answer.",
      prompt: "Pick the shape that fits your next step.",
      options: result.output_format_options,
      recommended: result.recommended_output_format || result.output_format_options[0]
    });
  }

  return steps;
}

export function summarizePhase1Selections(result, selections) {
  const format = selections?.output_format || result?.recommended_output_format || "";
  const answered = Object.values(selections || {}).filter(Boolean).length;
  return {
    format,
    answered,
    ready: Boolean(result && format)
  };
}

export function phase1StepResolution(step, answers) {
  if (!step) {
    return { canContinue: false, value: "", reason: "" };
  }

  const answerId = step.answerId || step.id;
  const currentValue = String(answers?.[answerId] || "");

  if (step.type === "format") {
    return {
      canContinue: true,
      value: answers?.[answerId] || step.recommended || "",
      reason: ""
    };
  }

  if (step.type === "assumption") {
    if (currentValue.startsWith("Change: ")) {
      const correction = currentValue.replace("Change: ", "").trim();
      return {
        canContinue: correction.length > 0,
        value: currentValue,
        reason: correction ? "" : "Add a correction to change this assumption."
      };
    }

    return {
      canContinue: true,
      value: currentValue || `Confirmed: ${step.body}`,
      reason: ""
    };
  }

  if (step.type === "impact") {
    return {
      canContinue: true,
      value: currentValue || `Include: ${step.body}`,
      reason: ""
    };
  }

  const trimmedValue = currentValue.trim();
  return {
    canContinue: trimmedValue.length > 0,
    value: trimmedValue,
    reason: "Answer this before continuing."
  };
}

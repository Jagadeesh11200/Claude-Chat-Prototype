const viteEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};

export const API_BASE_URL = viteEnv.VITE_API_BASE_URL || "http://127.0.0.1:8501";

export function buildPhase2Payload(prompt, phase1Result, overrides = {}) {
  return {
    project_id: overrides.project_id || "local-project",
    session_id: overrides.session_id || "local-session",
    prompt: String(prompt || "").trim(),
    phase1_result: phase1Result || {},
    clarification_answers: overrides.clarification_answers || {},
    selected_output_format: overrides.selected_output_format || "",
    attachments: overrides.attachments || [],
    mounted_paths: overrides.mounted_paths || [],
    answer_variant: overrides.answer_variant || "primary",
    previous_answer: overrides.previous_answer || "",
    judgment_direction: overrides.judgment_direction || "",
    answer_history: Array.isArray(overrides.answer_history) ? overrides.answer_history : []
  };
}

export async function requestPhase2(payload, fetcher = fetch) {
  const response = await fetcher(`${API_BASE_URL}/phase2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Answer request failed with ${response.status}`);
  }

  return normalizePhase2Response(await response.json());
}

export function normalizePhase2Response(response) {
  return {
    id: response.id || "",
    phase: response.phase || "answer_evaluation",
    answer: response.answer || "",
    reasoning_trace: response.reasoning_trace || "",
    self_critique: response.self_critique || "",
    reasoning_confidence: response.reasoning_confidence || "",
    verifiability: response.verifiability || "",
    model_source: response.model_source || "unknown",
    why_claims: Array.isArray(response.why_claims) ? response.why_claims : [],
    uncertainty_claims: Array.isArray(response.uncertainty_claims) ? response.uncertainty_claims : [],
    assumptions: Array.isArray(response.assumptions) ? response.assumptions : [],
    change_factors: Array.isArray(response.change_factors) ? response.change_factors : [],
    verifiable_claims: Array.isArray(response.verifiable_claims) ? response.verifiable_claims : [],
    alternative_summary: response.alternative_summary || ""
  };
}

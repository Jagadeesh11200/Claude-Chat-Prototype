const viteEnv = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};

export const API_BASE_URL = viteEnv.VITE_API_BASE_URL || "http://127.0.0.1:8501";
const MAX_INLINE_ATTACHMENT_BYTES = 7 * 1024 * 1024;

export function buildPhase1Payload(prompt, overrides = {}) {
  return {
    project_id: overrides.project_id || "local-project",
    session_id: overrides.session_id || "local-session",
    prompt: String(prompt || "").trim(),
    attachments: overrides.attachments || [],
    mounted_paths: overrides.mounted_paths || [],
    current_transaction_id: overrides.current_transaction_id || null,
    clarification_answers: overrides.clarification_answers || {},
    latest_clarification: overrides.latest_clarification || null,
    previous_context: overrides.previous_context || null
  };
}

export async function filesToPhase1Attachments(files, maxPreviewChars = 12000) {
  const selectedFiles = Array.from(files || []);
  const attachments = [];

  for (const file of selectedFiles) {
    const type = file.type || inferFileType(file.name);
    const isImage = type.startsWith("image/");
    const imageMetadata = isImage ? await readImageMetadata(file) : null;
    const inlineData = await readInlineAttachment(file, type);
    attachments.push({
      name: file.name,
      type,
      attachment_kind: attachmentKind(file.name, type),
      size: file.size,
      last_modified: file.lastModified || null,
      content_preview: await readFilePreview(file, maxPreviewChars, type, Boolean(inlineData)),
      image_metadata: imageMetadata,
      content_base64: inlineData?.base64 || "",
      inline_mime_type: inlineData?.mimeType || ""
    });
  }

  return attachments;
}

export function inferFileType(fileName) {
  const extension = String(fileName || "").split(".").pop()?.toLowerCase();
  if (!extension || extension === fileName) {
    return "application/octet-stream";
  }
  const textExtensions = new Set([
    "js",
    "jsx",
    "ts",
    "tsx",
    "py",
    "md",
    "txt",
    "json",
    "css",
    "html",
    "yaml",
    "yml",
    "toml",
    "sql",
    "csv",
    "tsv",
    "xml",
    "svg",
    "log"
  ]);
  const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
  const mimeByExtension = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip"
  };
  if (imageExtensions.has(extension)) {
    return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  }
  if (mimeByExtension[extension]) {
    return mimeByExtension[extension];
  }
  return textExtensions.has(extension) ? "text/plain" : "application/octet-stream";
}

function readFilePreview(file, maxPreviewChars, knownType = "", canInline = false) {
  const type = knownType || file.type || inferFileType(file.name);
  if (type.startsWith("image/")) {
    const visualStatus = canInline
      ? "Visual content is sent to Gemini as image data."
      : "Visual content is not inlined because the file is too large for the prototype request budget.";
    return Promise.resolve(`Image file attached: ${file.name} (${type}, ${formatBytes(file.size)}). ${visualStatus}`);
  }
  if (type === "application/pdf") {
    const documentStatus = canInline
      ? "The PDF is sent to Gemini as document data."
      : "Only metadata is available because the PDF is too large for the prototype request budget.";
    return Promise.resolve(`PDF file attached: ${file.name} (${formatBytes(file.size)}). ${documentStatus}`);
  }
  if (!type.startsWith("text/") && !looksTextLike(file.name, type)) {
    return Promise.resolve(`File attached: ${file.name} (${type}, ${formatBytes(file.size)}). No text preview is available, so Gemini will use metadata unless this format is supported as inline data.`);
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    const slice = file.slice(0, maxPreviewChars);
    reader.onload = () => resolve(String(reader.result || "").slice(0, maxPreviewChars));
    reader.onerror = () => resolve("");
    reader.readAsText(slice);
  });
}

function looksTextLike(fileName, knownType = "") {
  return (knownType || inferFileType(fileName)).startsWith("text/");
}

function attachmentKind(fileName, type) {
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type === "application/pdf") {
    return "pdf";
  }
  if (looksTextLike(fileName, type)) {
    return "text";
  }
  if (type.includes("wordprocessingml") || type.includes("spreadsheetml") || type.includes("presentationml")) {
    return "document";
  }
  return "binary";
}

function readFileBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : "");
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function readInlineAttachment(file, type) {
  const size = Number(file.size || 0);
  if (supportsNativeInlineGeminiPart(type) && size <= MAX_INLINE_ATTACHMENT_BYTES) {
    return {
      base64: await readFileBase64(file),
      mimeType: type
    };
  }

  if (type.startsWith("image/")) {
    return normalizeImageForInline(file);
  }

  return null;
}

function supportsNativeInlineGeminiPart(type) {
  return [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/gif",
    "application/pdf"
  ].includes(type);
}

function normalizeImageForInline(file) {
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof document === "undefined") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const maxDimension = 1800;
        const width = image.naturalWidth || image.width || maxDimension;
        const height = image.naturalHeight || image.height || maxDimension;
        const scale = Math.min(1, maxDimension / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
        const base64 = dataUrl.includes(",") ? dataUrl.split(",").pop() : "";
        resolve(base64 ? { base64, mimeType: "image/jpeg" } : null);
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

function readImageMetadata(file) {
  if (typeof Image === "undefined" || typeof URL === "undefined") {
    return Promise.resolve({ width: null, height: null });
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth || null, height: image.naturalHeight || null });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      resolve({ width: null, height: null });
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

export async function requestPhase1(payload, fetcher = fetch) {
  return requestPhase1At("/phase1", payload, fetcher);
}

export async function requestPhase1Clarification(payload, fetcher = fetch) {
  return requestPhase1At("/phase1/clarify", payload, fetcher);
}

async function requestPhase1At(path, payload, fetcher = fetch) {
  const response = await fetcher(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Context request failed with ${response.status}`);
  }

  return normalizePhase1Response(await response.json());
}

export function normalizePhase1Response(response) {
  return {
    id: response.id || "",
    phase: response.phase || "context_acquisition",
    exit_state: response.exit_state || "partial_context",
    goal: response.goal || "",
    scenario: response.scenario || "",
    answer_form: response.answer_form || "",
    ambiguity_score: Number(response.ambiguity_score || 5),
    reliability_nudge: response.reliability_nudge || "",
    questions: Array.isArray(response.questions) ? response.questions : [],
    assumptions: Array.isArray(response.assumptions) ? response.assumptions : [],
    input_warnings: Array.isArray(response.input_warnings) ? response.input_warnings : [],
    impact_notes: Array.isArray(response.impact_notes) ? response.impact_notes : [],
    output_format_options: Array.isArray(response.output_format_options) ? response.output_format_options : [],
    recommended_output_format: response.recommended_output_format || "",
    refined_prompt: response.refined_prompt || "",
    model_source: response.model_source || "unknown"
  };
}

export function splitAnswerBlocks(text) {
  const source = sanitizeAssistantText(text);
  const blocks = [];
  const fencePattern = /```([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = fencePattern.exec(source)) !== null) {
    if (match.index > cursor) {
      blocks.push(...parseTextBlocks(source.slice(cursor, match.index)));
    }

    blocks.push(parseCodeFence(match[1]));
    cursor = match.index + match[0].length;
  }

  if (cursor < source.length) {
    blocks.push(...parseTextBlocks(source.slice(cursor)));
  }

  return blocks.filter((block) => block.content);
}

export function parseMarkdownTable(tableText) {
  const lines = String(tableText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !isTableSeparator(lines[1])) {
    return { headers: [], rows: [] };
  }
  return {
    headers: splitTableRow(lines[0]),
    rows: lines.slice(2).map(splitTableRow).filter((row) => row.length > 0)
  };
}

export function buildAnswerAffordances(result) {
  const answerText = sanitizeAssistantText(result?.answer || "");
  const why = renderableClaims(answerText, normalizeClaims(result?.why_claims, "explanation"));
  const rawUncertainty = renderableClaims(answerText, normalizeClaims(result?.uncertainty_claims, "explanation"));
  const uncertainty = uncertaintyOverlapsWhy(rawUncertainty, why)
    ? fallbackUncertainty(answerText, result)
    : rawUncertainty;
  const verifiable = renderableClaims(answerText, normalizeClaims(result?.verifiable_claims, "reference"));

  return {
    why: why.length ? why : fallbackWhy(answerText, result),
    uncertainty: uncertainty.length ? uncertainty : fallbackUncertainty(answerText, result),
    verifiable,
    assumptions: normalizeList(result?.assumptions).slice(0, 5),
    changeFactors: normalizeList(result?.change_factors).slice(0, 5),
    alternativeSummary: sanitizeAssistantText(result?.alternative_summary || "")
  };
}

export function annotationForText(text, affordances) {
  const source = String(text || "");
  const annotations = mergeExactRangeAnnotations([
    ...claimAnnotations(source, affordances?.why || [], "why"),
    ...claimAnnotations(source, affordances?.uncertainty || [], "uncertainty"),
    ...claimAnnotations(source, affordances?.verifiable || [], "verifiable")
  ]);

  return annotations
    .sort((left, right) => left.start - right.start || priority(left.type) - priority(right.type))
    .filter((item, index, all) => !all.some((other, otherIndex) => (
      otherIndex < index &&
      item.start < other.end &&
      item.end > other.start
    )));
}

export function visibleAnnotationTypes(answerText, affordances) {
  const blocks = splitAnswerBlocks(answerText);
  const types = new Set();

  blocks
    .filter((block) => block.type === "text")
    .forEach((block) => {
      annotationForText(block.content, affordances).forEach((annotation) => {
        types.add(annotation.type);
      });
    });

  return types;
}

export function visibleAnnotationCounts(answerText, affordances) {
  const counts = { why: 0, uncertainty: 0, verifiable: 0 };

  splitAnswerBlocks(answerText)
    .filter((block) => block.type === "text")
    .forEach((block) => {
      annotationForText(block.content, affordances).forEach((annotation) => {
        counts[annotation.type] = (counts[annotation.type] || 0) + 1;
        if (annotation.verifiableDetail) {
          counts.verifiable += 1;
        }
      });
    });

  return counts;
}

export function firstUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s)]+/);
  return match ? match[0] : "";
}

export function confidenceSummary(result) {
  const reasoning = sanitizeAssistantText(result?.reasoning_confidence || "Unspecified");
  const verifiability = sanitizeAssistantText(result?.verifiability || "Unspecified");

  return {
    reasoning,
    verifiability,
    reasoningLabel: compactConfidenceLabel(reasoning),
    verifiabilityLabel: compactVerifiabilityLabel(verifiability),
    reasoningTone: reasoning.toLowerCase().includes("low")
      ? "caution"
      : reasoning.toLowerCase().includes("high")
        ? "solid"
        : "balanced",
    verifiabilityTone: verifiability.toLowerCase().includes("judgment")
      ? "judgment"
      : verifiability.toLowerCase().includes("check") || verifiability.toLowerCase().includes("fact")
        ? "checkable"
        : "balanced"
  };
}

export function compactConfidenceLabel(value) {
  const lower = sanitizeAssistantText(value || "Unspecified").toLowerCase();
  if (lower.includes("high")) {
    return "Strong Reasoning";
  }
  return "Not Sure";
}

export function compactVerifiabilityLabel(value) {
  const text = sanitizeAssistantText(value || "Unspecified");
  const lower = text.toLowerCase();
  if (lower.includes("judgment")) {
    return "Judgment call";
  }
  if (lower.includes("check") || lower.includes("verifiable") || lower.includes("external fact")) {
    return "Verifiable";
  }
  if (["high", "medium", "low"].includes(lower.trim())) {
    return "Verifiability: unclear";
  }
  return text.split(/[.:;]/)[0] || "Unspecified";
}

export function sanitizeAssistantText(text) {
  return String(text || "")
    .replace(/[\u3010\u300a]\s*\d+\.\s*(ANSWER|REASONING TRACE|SELF-CRITIQUE|CONFIDENCE)\s*[\u3011\u300b]/gi, "")
    .replace(/\bPhase\s*1\b/gi, "the context check")
    .replace(/\bPhase\s*2\b/gi, "the answer pass")
    .trim();
}

function parseCodeFence(rawFence) {
  const inner = String(rawFence || "").trim();
  const lineBreak = inner.indexOf("\n");

  if (lineBreak >= 0) {
    return {
      type: "code",
      language: inner.slice(0, lineBreak).trim(),
      content: inner.slice(lineBreak + 1).trim()
    };
  }

  const singleLineMatch = inner.match(/^([a-zA-Z0-9_+-]+)\s+([\s\S]+)$/);
  if (singleLineMatch) {
    return {
      type: "code",
      language: singleLineMatch[1],
      content: singleLineMatch[2].trim()
    };
  }

  return {
    type: "code",
    language: "",
    content: inner
  };
}

function parseTextBlocks(rawText) {
  const lines = String(rawText || "").split("\n");
  const blocks = [];
  let textBuffer = [];
  let tableBuffer = [];

  function flushText() {
    const content = textBuffer.join("\n").trim();
    if (content) {
      blocks.push({ type: "text", content });
    }
    textBuffer = [];
  }

  function flushTable() {
    const content = tableBuffer.join("\n").trim();
    if (content) {
      blocks.push({ type: "table", content });
    }
    tableBuffer = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1] || "";
    const currentlyInTable = tableBuffer.length > 0;
    const startsTable = line.includes("|") && isTableSeparator(nextLine);
    const continuesTable = currentlyInTable && line.includes("|");

    if (startsTable || continuesTable) {
      flushText();
      tableBuffer.push(line);
      continue;
    }

    if (currentlyInTable) {
      flushTable();
    }
    textBuffer.push(line);
  }

  flushTable();
  flushText();
  return blocks;
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function normalizeClaims(items, detailKey) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      quote: sanitizeAssistantText(item?.quote || ""),
      detail: sanitizeAssistantText(item?.[detailKey] || item?.explanation || item?.reference || "")
    }))
    .filter((item) => item.quote && item.detail)
    .slice(0, 5);
}

function normalizeList(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => sanitizeAssistantText(item)).filter(Boolean);
}

function renderableClaims(answerText, claims) {
  const source = String(answerText || "").toLowerCase();
  return claims.filter((claim) => source.includes(claim.quote.toLowerCase()));
}

function fallbackWhy(answerText, result) {
  const quote = firstSentence(answerText);
  const detail = sanitizeAssistantText(result?.reasoning_trace || "");
  return quote && detail ? [{ quote, detail }] : [];
}

function fallbackUncertainty(answerText, result) {
  const detail = sanitizeAssistantText(result?.self_critique || "")
    || "This is the part most sensitive to missing context or a different interpretation.";
  const quote = sentenceContaining(answerText, [
    "assume",
    "may",
    "might",
    "could",
    "depends",
    "need to",
    "replace",
    "write-heavy",
    "permission",
    "if "
  ]) || firstSentence(answerText);
  return quote ? [{ quote, detail }] : [];
}

function firstSentence(text) {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }
  const match = source.match(/^(.+?[.!?])(\s|$)/);
  return match ? match[1] : source.split("\n")[0].slice(0, 160);
}

function sentenceContaining(text, tokens) {
  const sentences = String(text || "").match(/[^.!?\n]+[.!?]?/g) || [];
  return sentences.find((sentence) => tokens.some((token) => sentence.toLowerCase().includes(token)))?.trim() || "";
}

function claimAnnotations(source, claims, type) {
  return claims.flatMap((claim) => {
    const index = source.toLowerCase().indexOf(claim.quote.toLowerCase());
    if (index < 0) {
      return [];
    }
    return [{
      type,
      start: index,
      end: index + claim.quote.length,
      detail: claim.detail
    }];
  });
}

function mergeExactRangeAnnotations(annotations) {
  const byRange = new Map();
  for (const annotation of annotations) {
    const key = `${annotation.start}:${annotation.end}`;
    const existing = byRange.get(key);
    if (!existing) {
      byRange.set(key, { ...annotation });
      continue;
    }

    if (annotation.type === "verifiable") {
      existing.verifiableDetail = annotation.detail;
    } else if (existing.type === "verifiable") {
      byRange.set(key, {
        ...annotation,
        verifiableDetail: existing.detail
      });
    } else if (priority(annotation.type) < priority(existing.type)) {
      byRange.set(key, {
        ...annotation,
        verifiableDetail: existing.verifiableDetail
      });
    }
  }
  return [...byRange.values()];
}

function uncertaintyOverlapsWhy(uncertainty, why) {
  return uncertainty.some((risk) => why.some((reason) => {
    const riskQuote = risk.quote.toLowerCase();
    const reasonQuote = reason.quote.toLowerCase();
    return riskQuote.includes(reasonQuote) || reasonQuote.includes(riskQuote);
  }));
}

function priority(type) {
  if (type === "uncertainty") {
    return 0;
  }
  if (type === "why") {
    return 1;
  }
  return 2;
}

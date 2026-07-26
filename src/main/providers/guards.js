'use strict';

/**
 * An LLM asked to "clean up" text will occasionally answer it instead, wrap it
 * in commentary, or hallucinate an expansion. These deterministic gates decide
 * whether the polished output is trustworthy; if not, the raw transcript wins.
 */

const LEAK_PATTERNS = [
  /^\s*(here (is|are)|sure[,!]|certainly[,!]|of course[,!]|okay[,!]|i've |i have (cleaned|edited)|cleaned (up )?text\s*:)/i,
  /^\s*```/,
  /^\s*(output|result|response|cleaned)\s*:/i,
  /\bas an (ai|assistant)\b/i,
  /\bi (cannot|can't) (help|assist|process)\b/i
];

function words(s) {
  const m = String(s || '').trim().match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
}

function strip(text) {
  let out = String(text || '').trim();
  // Unwrap a fenced block if the model insisted on one.
  const fence = out.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) out = fence[1].trim();
  // Unwrap symmetric quotes around the whole output.
  if (
    (out.startsWith('"') && out.endsWith('"') && out.length > 2) ||
    (out.startsWith('“') && out.endsWith('”') && out.length > 2)
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * @returns {{ok:boolean, text:string, reason:string}}
 */
function evaluate(raw, polished) {
  const rawText = String(raw || '').trim();
  const rawWords = words(rawText);
  const cleaned = strip(polished);
  const cleanWords = words(cleaned);

  if (!rawText) return { ok: false, text: '', reason: 'empty transcript' };

  // Nothing meaningful to clean — a one or two word utterance is safest raw.
  if (rawWords <= 2) return { ok: false, text: rawText, reason: 'utterance too short to edit' };

  if (!cleaned) return { ok: false, text: rawText, reason: 'model returned nothing' };

  for (const re of LEAK_PATTERNS) {
    if (re.test(cleaned)) {
      return { ok: false, text: rawText, reason: 'model added commentary' };
    }
  }

  if (cleanWords > rawWords * 2.4 + 6) {
    return { ok: false, text: rawText, reason: 'output far longer than input' };
  }

  // Filler-heavy dictations legitimately shrink a lot once mic checks, false
  // starts and "um"s come out, so this floor is deliberately generous.
  if (rawWords >= 10 && cleanWords < rawWords * 0.3) {
    return { ok: false, text: rawText, reason: 'output dropped too much content' };
  }

  return { ok: true, text: cleaned, reason: '' };
}

// Cosmetic and structural tidying lives in ./format.js — these gates only
// decide *whether* the model's output is trustworthy, never how it looks.

module.exports = { evaluate, words, strip };

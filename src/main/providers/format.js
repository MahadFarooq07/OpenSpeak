'use strict';

/**
 * Deterministic structure pass, applied after the cleanup model.
 *
 * Language models are inconsistent about layout: dictate the same grocery list
 * four times and you get inline "1. bread 2. milk" once, a properly broken list
 * the next time, a lead-in glued to the first item after that, and a missing
 * full stop somewhere in between. Prompting narrows the spread but never closes
 * it, so everything mechanically decidable is decided here instead — where the
 * answer is the same every single time.
 *
 * This runs on whichever text won (model output, or the raw transcript after a
 * gate rejection), so layout is consistent even when cleanup was skipped.
 */

/** Lead-ins that should take a colon when they introduce a list. */
const COLON_LEAD = /\b(list|following|below|steps?|items?|these|order|agenda|todo|to-do|options?|reasons?)\s*$/i;

/** A line that is already a list item. */
const LIST_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;

const SENTENCE_END = /[.!?:;…"')\]]$/;

/** Spoken position markers: "one… two… three…", "first… second… third…". */
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10
};

const SPOKEN_MARKER =
  /(^|[\s(,;:—-])(number\s+|step\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b[,:]?\s+/gi;

/**
 * Words that mean the preceding number was a quantity or measure, not a list
 * position — "two hours", "three of them", "one thing".
 */
const MEASURE_WORD =
  /^(of|o'clock|hours?|minutes?|seconds?|days?|weeks?|months?|years?|times?|people|persons?|dollars?|pounds?|euros?|cents?|percent|degrees?|miles?|kilomet(?:re|er)s?|met(?:re|er)s?|feet|foot|inch(?:es)?|kilos?|kilograms?|grams?|lit(?:re|er)s?|thousand|hundred|million|billion|and|or|to|more|less|other|another|thing|things|way|ways)$/i;

/**
 * Words safe to collapse when repeated three or more times: mic checks and
 * stutters. Deliberately excludes ordinary words, because "no, no, no" and
 * "very very very" are emphasis, not noise.
 */
const REPEATABLE = new RegExp(
  `\\b(hello|hi|hey|testing|test|check|um|uh|er|so|okay|ok|well|like|the|a|i|it|is|that|to|of|and|but|my|we|you)\\b`,
  'i'
);

/* ------------------------------------------------------------- helpers */

function capitalizeFirst(text) {
  if (!text) return text;
  const first = text.charAt(0);
  if (!/[a-z]/.test(first)) return text; // symbol, digit, already capital
  if (/^[a-z]+[A-Z]/.test(text)) return text; // camelCase identifier
  return first.toUpperCase() + text.slice(1);
}

/** Gives a lead-in the right terminal mark before its list. */
function finishLead(lead) {
  const t = String(lead).trim();
  if (!t) return '';
  if (/[:.!?]$/.test(t)) return t;
  if (COLON_LEAD.test(t)) return `${t}:`;
  return `${t}.`;
}

/* ------------------------------------------------- spoken-marker lists */

/**
 * Turns a spoken enumeration into real list markers:
 *   "One bread, two milk, three bananas" -> "1. bread 2. milk 3. bananas"
 *
 * Doing this in code rather than leaving it to the model is the whole point —
 * the model treated the same sentence as a list one time and as prose the next.
 *
 * Guarded so ordinary sentences survive: it needs an ascending run starting at
 * one, at least three markers, short items after each, and no measure word
 * immediately following ("two hours", "three of them" stay as prose).
 */
function numeraliseSpokenList(text) {
  const src = String(text);
  if (/\d{1,2}[.)]\s/.test(src)) return src; // already has real markers

  const found = [];
  SPOKEN_MARKER.lastIndex = 0;
  let m;
  while ((m = SPOKEN_MARKER.exec(src)) !== null) {
    found.push({
      index: m.index + m[1].length,
      end: m.index + m[0].length,
      num: NUMBER_WORDS[m[3].toLowerCase()]
    });
  }

  const start = found.findIndex((f) => f.num === 1);
  if (start === -1) return src;

  const run = [found[start]];
  for (let i = start + 1; i < found.length; i += 1) {
    if (found[i].num === run[run.length - 1].num + 1) run.push(found[i]);
    else break;
  }
  // Three is the threshold: spoken number words are far more often prose than
  // list markers, and two of them in a row proves very little.
  if (run.length < 3) return src;

  const items = [];
  for (let i = 0; i < run.length; i += 1) {
    const stop = i + 1 < run.length ? run[i + 1].index : src.length;
    const item = src.slice(run[i].end, stop).replace(/[\s,;.]+$/, '').trim();
    if (!item) return src;
    const words = item.split(/\s+/);
    if (MEASURE_WORD.test(words[0])) return src; // a quantity, not a position
    if (words.length > 6) return src; // a clause, not a list item
    items.push(item);
  }

  const lead = src.slice(0, run[0].index).replace(/[\s,;:—-]+$/, '').trim();
  const out = [];
  if (lead) out.push(finishLead(lead));
  items.forEach((item, i) => out.push(`${i + 1}. ${capitalizeFirst(item)}`));
  return out.join('\n');
}

/* --------------------------------------------------------- list reflow */

/**
 * Every "1. " / "2) " style marker in the text, ignoring things that only look
 * like one — decimals, version numbers, prices.
 */
function collectMarkers(src) {
  const re = /(\d{1,2})[.)]([ \t]+)/g;
  const found = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const prevChar = m.index > 0 ? src.charAt(m.index - 1) : '';
    if (/[\d.,$£€]/.test(prevChar)) continue; // 3.50, v1. 2, $1. 20
    const atLineStart = m.index === 0 || /\n[ \t]*$/.test(src.slice(0, m.index));
    const afterSpace = /[ \t]$/.test(src.slice(0, m.index));
    if (!atLineStart && !afterSpace) continue;
    found.push({ index: m.index, end: m.index + m[0].length, num: Number(m[1]) });
  }
  return found;
}

/**
 * Puts every item of a numbered list on its own line, however the model chose
 * to lay it out, and splits a lead-in off the first item.
 *
 * Only an ascending run beginning at 1 counts, so "call me back on 3. no wait,
 * 5." is left alone.
 */
function reflowLists(text) {
  const src = String(text);
  const found = collectMarkers(src);
  const start = found.findIndex((f) => f.num === 1);
  if (start === -1) return src;

  const run = [found[start]];
  for (let i = start + 1; i < found.length; i += 1) {
    if (found[i].num === run[run.length - 1].num + 1) run.push(found[i]);
    else break;
  }
  if (run.length < 2) return src;

  // Reject when an "item" opens with a digit: that is a decimal or a measure
  // ("it costs 1. 50 and weighs 2. 5 kilos"), not a list. Leaving ambiguous
  // text alone is always safer than restructuring someone's numbers.
  for (let i = 0; i < run.length; i += 1) {
    const stop = i + 1 < run.length ? run[i + 1].index : src.length;
    const item = src.slice(run[i].end, stop).trim();
    if (!item || /^\d/.test(item)) return src;
  }

  let out = '';
  let cursor = 0;
  for (const mark of run) {
    out += src.slice(cursor, mark.index).replace(/[ \t]+$/, '');
    out = breakBeforeItem(out);
    out += `${mark.num}. `;
    cursor = mark.end;
  }
  out += src.slice(cursor);
  return out;
}

/** Ensures the next list item starts on a fresh line, punctuating any lead-in. */
function breakBeforeItem(out) {
  if (!out) return out; // the list opens the dictation
  const nl = out.lastIndexOf('\n');
  const lastLine = out.slice(nl + 1);
  if (!lastLine.trim()) return out; // already on a fresh line
  if (LIST_LINE.test(lastLine)) return `${out.replace(/[ \t]+$/, '')}\n`;
  return `${out.slice(0, nl + 1)}${finishLead(lastLine)}\n`;
}

/**
 * Renumbers contiguous runs and normalises bullet glyphs, so "1. / 1. / 1." or
 * "3) / 4) / 5)" come out as a clean 1..n with capitalised items.
 */
function renumber(text) {
  let counter = 0;
  return String(text)
    .split('\n')
    .map((line) => {
      const numbered = line.match(/^\s*(\d{1,2})[.)]\s+(.*)$/);
      if (numbered) {
        counter += 1;
        return `${counter}. ${capitalizeFirst(numbered[2].trim())}`;
      }
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      counter = 0;
      if (bullet) return `- ${capitalizeFirst(bullet[1].trim())}`;
      return line;
    })
    .join('\n');
}

/** A list must never begin on the same line as the prose introducing it. */
function separateLead(text) {
  const lines = String(text).split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const prev = out[out.length - 1];
    if (i > 0 && LIST_LINE.test(line) && prev && prev.trim() && !LIST_LINE.test(prev)) {
      out[out.length - 1] = finishLead(prev);
    }
    out.push(line);
  });
  return out.join('\n');
}

/** Adds a full stop to a trailing prose line that ended mid-air. */
function terminalPunctuation(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    if (LIST_LINE.test(lines[i])) break; // list items don't need one
    if (!SENTENCE_END.test(lines[i].trim())) lines[i] = `${lines[i].trimEnd()}.`;
    break;
  }
  return lines.join('\n');
}

/** Collapses the "testing, testing, testing" mic-check tic. */
function collapseRepeats(text) {
  return String(text).replace(/\b(\w+)((?:[,]?\s+\1\b){2,})/gi, (match, word) =>
    REPEATABLE.test(word) ? word : match
  );
}

function tidyWhitespace(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .trim();
}

/* ------------------------------------------------------------- entry */

/**
 * @param {string} text
 * @param {{mode?:string, autoPunctuate?:boolean, autoCapitalize?:boolean,
 *          trailingSpace?:boolean}} opts
 */
function normalize(text, opts = {}) {
  let out = String(text || '');
  if (!out.trim()) return '';

  // Raw mode is a promise not to touch anything structural.
  if (opts.mode === 'raw') return out.trim();

  out = tidyWhitespace(out);
  out = collapseRepeats(out);
  out = numeraliseSpokenList(out);
  out = reflowLists(out);
  out = separateLead(out);
  out = renumber(out);
  out = tidyWhitespace(out);

  if (opts.autoPunctuate !== false) out = terminalPunctuation(out);
  if (opts.autoCapitalize !== false) out = capitalizeFirst(out);

  if (opts.trailingSpace && out && !out.includes('\n') && !/\s$/.test(out)) {
    out += ' ';
  }
  return out;
}

module.exports = {
  normalize,
  numeraliseSpokenList,
  reflowLists,
  renumber,
  separateLead,
  terminalPunctuation,
  collapseRepeats,
  collectMarkers,
  finishLead
};

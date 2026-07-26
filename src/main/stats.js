'use strict';

const { JsonFile } = require('./store');

/** Assumed typing speed used to compute "time saved". */
const TYPING_WPM = 40;

const EMPTY = {
  totalWords: 0,
  totalSessions: 0,
  totalSpeakingMs: 0,
  bestWpm: 0,
  firstUseAt: 0,
  lastUseAt: 0,
  days: {} // 'YYYY-MM-DD' -> { words, sessions, ms }
};

let file = null;

function db() {
  if (!file) {
    file = new JsonFile('stats.json', EMPTY);
    if (!file.data.days || typeof file.data.days !== 'object') file.data.days = {};
  }
  return file;
}

function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function record(words, durationMs) {
  const store = db();
  const now = Date.now();
  const d = store.data;

  d.totalWords += words;
  d.totalSessions += 1;
  d.totalSpeakingMs += durationMs;
  if (!d.firstUseAt) d.firstUseAt = now;
  d.lastUseAt = now;

  if (durationMs > 1500) {
    const wpm = words / (durationMs / 60000);
    if (wpm > d.bestWpm && wpm < 400) d.bestWpm = Math.round(wpm);
  }

  const key = dayKey(now);
  const bucket = d.days[key] || { words: 0, sessions: 0, ms: 0 };
  bucket.words += words;
  bucket.sessions += 1;
  bucket.ms += durationMs;
  d.days[key] = bucket;

  // Keep at most ~1 year of daily buckets.
  const keys = Object.keys(d.days).sort();
  while (keys.length > 400) {
    delete d.days[keys.shift()];
  }

  store.save();
}

function streak() {
  const d = db().data.days;
  let n = 0;
  const cursor = new Date();
  // Today only counts if there was activity; otherwise start from yesterday.
  if (!d[dayKey(cursor.getTime())]) cursor.setDate(cursor.getDate() - 1);
  for (;;) {
    const k = dayKey(cursor.getTime());
    if (!d[k] || d[k].sessions === 0) break;
    n += 1;
    cursor.setDate(cursor.getDate() - 1);
    if (n > 3650) break;
  }
  return n;
}

function activity(days = 30) {
  const d = db().data.days;
  const out = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const k = dayKey(cursor.getTime());
    const b = d[k] || { words: 0, sessions: 0, ms: 0 };
    out.push({ date: k, words: b.words, sessions: b.sessions });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function summary() {
  const d = db().data;
  const speakingMinutes = d.totalSpeakingMs / 60000;
  const avgWpm = speakingMinutes > 0.05 ? Math.round(d.totalWords / speakingMinutes) : 0;
  // Time saved = time it would have taken to type this, minus time spent speaking.
  const typingMs = (d.totalWords / TYPING_WPM) * 60000;
  const savedMs = Math.max(0, typingMs - d.totalSpeakingMs);
  return {
    totalWords: d.totalWords,
    totalSessions: d.totalSessions,
    totalSpeakingMs: d.totalSpeakingMs,
    avgWpm,
    bestWpm: d.bestWpm,
    savedMs,
    streak: streak(),
    firstUseAt: d.firstUseAt,
    lastUseAt: d.lastUseAt,
    activity: activity(30)
  };
}

function reset() {
  const store = db();
  store.data = JSON.parse(JSON.stringify(EMPTY));
  store.save();
}

module.exports = { record, summary, reset, TYPING_WPM };

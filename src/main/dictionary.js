'use strict';

const crypto = require('crypto');
const { JsonFile } = require('./store');

let file = null;

function db() {
  if (!file) {
    file = new JsonFile('dictionary.json', { terms: [] });
    if (!Array.isArray(file.data.terms)) file.data.terms = [];
  }
  return file;
}

/**
 * A term is either a plain vocabulary hint ({ write: 'Mahad' }) or a
 * replacement rule ({ heard: 'mahad', write: 'Mahad' }).
 */
function add({ heard, write }) {
  const target = String(write || '').trim();
  if (!target) return { ok: false, error: 'Enter the text to write.' };
  const source = String(heard || '').trim();

  const store = db();
  const dupe = store.data.terms.find(
    (t) =>
      t.write.toLowerCase() === target.toLowerCase() &&
      (t.heard || '').toLowerCase() === source.toLowerCase()
  );
  if (dupe) return { ok: false, error: 'That entry already exists.' };

  store.data.terms.unshift({
    id: crypto.randomUUID(),
    heard: source,
    write: target,
    at: Date.now(),
    hits: 0
  });
  if (store.data.terms.length > 500) store.data.terms.length = 500;
  store.save();
  return { ok: true, terms: list() };
}

function remove(id) {
  const store = db();
  const before = store.data.terms.length;
  store.data.terms = store.data.terms.filter((t) => t.id !== id);
  if (store.data.terms.length !== before) store.save();
  return list();
}

function list() {
  return db().data.terms.slice();
}

/** Short comma list used to bias the speech-to-text model. */
function biasPrompt(limit = 60) {
  const words = list()
    .slice(0, limit)
    .map((t) => t.write)
    .filter(Boolean);
  if (!words.length) return '';
  return words.join(', ');
}

/** Instruction block appended to the cleanup system prompt. */
function promptFragment(limit = 80) {
  const terms = list().slice(0, limit);
  if (!terms.length) return '';
  const plain = [];
  const rules = [];
  for (const t of terms) {
    if (t.heard) rules.push(`"${t.heard}" -> "${t.write}"`);
    else plain.push(t.write);
  }
  const parts = [];
  if (plain.length) {
    parts.push(`Spell these exactly when they occur: ${plain.join(', ')}.`);
  }
  if (rules.length) {
    parts.push(
      `Apply these corrections when the transcript contains the left-hand form: ${rules.join('; ')}.`
    );
  }
  return parts.join(' ');
}

/** Post-cleanup deterministic pass so replacement rules always land. */
function applyReplacements(text) {
  let out = String(text || '');
  for (const t of list()) {
    if (!t.heard || !t.write) continue;
    const escaped = t.heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    out = out.replace(re, t.write);
  }
  return out;
}

module.exports = { add, remove, list, biasPrompt, promptFragment, applyReplacements };

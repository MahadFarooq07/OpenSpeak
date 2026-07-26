'use strict';

const crypto = require('crypto');
const { JsonFile } = require('./store');

let file = null;

function db() {
  if (!file) {
    file = new JsonFile('history.json', { entries: [] });
    if (!Array.isArray(file.data.entries)) file.data.entries = [];
  }
  return file;
}

/**
 * @param {{raw:string, text:string, mode:string, durationMs:number,
 *          words:number, provider:string, model:string, cleaned:boolean,
 *          fallbackReason?:string, error?:string}} entry
 */
function push(entry) {
  const store = db();
  const record = {
    id: crypto.randomUUID(),
    at: Date.now(),
    raw: entry.raw || '',
    text: entry.text || '',
    mode: entry.mode || 'auto',
    durationMs: Math.round(entry.durationMs || 0),
    words: entry.words || 0,
    provider: entry.provider || '',
    model: entry.model || '',
    cleaned: !!entry.cleaned,
    fallbackReason: entry.fallbackReason || '',
    error: entry.error || ''
  };
  store.data.entries.unshift(record);
  const limit = Math.max(20, Number(entry.limit) || 500);
  if (store.data.entries.length > limit) {
    store.data.entries.length = limit;
  }
  store.save();
  return record;
}

function list(query = '', limit = 200) {
  const store = db();
  const q = String(query || '').trim().toLowerCase();
  let rows = store.data.entries;
  if (q) {
    rows = rows.filter(
      (e) =>
        (e.text || '').toLowerCase().includes(q) ||
        (e.raw || '').toLowerCase().includes(q)
    );
  }
  return rows.slice(0, limit);
}

function get(id) {
  return db().data.entries.find((e) => e.id === id) || null;
}

function remove(id) {
  const store = db();
  const before = store.data.entries.length;
  store.data.entries = store.data.entries.filter((e) => e.id !== id);
  if (store.data.entries.length !== before) store.save();
  return store.data.entries.length !== before;
}

function clear() {
  const store = db();
  store.data.entries = [];
  store.save();
}

module.exports = { push, list, get, remove, clear };

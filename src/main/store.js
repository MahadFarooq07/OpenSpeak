'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { EventEmitter } = require('events');
const { DEFAULT_SETTINGS } = require('../shared/defaults');

/**
 * Tiny atomic JSON store. Writes to a temp file then renames, so a crash
 * mid-write can never leave a truncated settings file behind.
 */
class JsonFile {
  constructor(filename, fallback) {
    this.file = path.join(app.getPath('userData'), filename);
    this.fallback = fallback;
    this.data = this._read();
  }

  _read() {
    try {
      const txt = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {
      /* first run, or corrupt — fall through */
    }
    return JSON.parse(JSON.stringify(this.fallback));
  }

  save() {
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] failed to save', this.file, err);
    }
  }
}

class Settings extends EventEmitter {
  constructor() {
    super();
    this.store = new JsonFile('settings.json', DEFAULT_SETTINGS);
    // Backfill any key added by a newer version of the app.
    let dirty = false;
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(k in this.store.data)) {
        this.store.data[k] = v;
        dirty = true;
      }
    }
    if (dirty) this.store.save();
  }

  all() {
    return { ...this.store.data };
  }

  get(key) {
    return this.store.data[key];
  }

  set(patch) {
    const before = { ...this.store.data };
    let changed = false;
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULT_SETTINGS)) continue; // ignore unknown keys
      if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
      this.store.data[k] = v;
      changed = true;
    }
    if (changed) {
      this.store.save();
      this.emit('changed', this.all(), before);
    }
    return this.all();
  }
}

/**
 * Secret vault. API keys are encrypted with the OS keyring (DPAPI on Windows,
 * scoped to the logged-in user) before ever touching disk. If encryption is
 * unavailable we refuse to persist rather than silently writing plaintext.
 */
class Secrets {
  constructor() {
    this.store = new JsonFile('secrets.json', {});
  }

  available() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch (_) {
      return false;
    }
  }

  set(name, value) {
    if (!value) {
      this.clear(name);
      return { ok: true };
    }
    if (!this.available()) {
      return { ok: false, error: 'OS encryption is unavailable, so the key was not saved.' };
    }
    try {
      const buf = safeStorage.encryptString(String(value));
      this.store.data[name] = buf.toString('base64');
      this.store.save();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  get(name) {
    const raw = this.store.data[name];
    if (!raw) return '';
    try {
      return safeStorage.decryptString(Buffer.from(raw, 'base64'));
    } catch (_) {
      return '';
    }
  }

  clear(name) {
    delete this.store.data[name];
    this.store.save();
  }

  /** Never returns the key itself — only enough to recognise it. */
  hint(name) {
    const v = this.get(name);
    if (!v) return { present: false, hint: '' };
    const tail = v.slice(-4);
    const head = v.slice(0, Math.min(3, v.length));
    return { present: true, hint: `${head}…${tail}` };
  }
}

let settings = null;
let secrets = null;

function getSettings() {
  if (!settings) settings = new Settings();
  return settings;
}

function getSecrets() {
  if (!secrets) secrets = new Secrets();
  return secrets;
}

module.exports = { getSettings, getSecrets, JsonFile };

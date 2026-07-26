'use strict';

const { EventEmitter } = require('events');
const { ipcMain } = require('electron');
const { CH } = require('../shared/channels');
const windows = require('./windows');
const providers = require('./providers');
const guards = require('./providers/guards');
const format = require('./providers/format');
const dictionary = require('./dictionary');
const paste = require('./paste');
const history = require('./history');
const stats = require('./stats');
const { getSettings } = require('./store');

// The pill should be gone almost as soon as the text lands. Anything longer
// reads as clutter, since by then you are already looking at the result.
const DONE_LINGER_MS = 500;
const ERROR_LINGER_MS = 2600;
const CANCEL_LINGER_MS = 320;

/**
 * The dictation state machine.
 *   idle -> listening -> transcribing -> polishing -> inserting -> done|error -> idle
 */
class Session extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.startedAt = 0;
    this.token = 0;
    this.hideTimer = null;
    this.maxTimer = null;
    this.pendingResolve = null;
    this.lastError = '';
    this._bindRecorder();
  }

  settings() {
    return getSettings().all();
  }

  _bindRecorder() {
    ipcMain.on(CH.REC_LEVEL, (_e, level) => {
      if (this.state !== 'listening') return;
      const overlay = windows.getOverlay();
      windows.send(overlay, CH.OVL_LEVEL, level);
    });

    ipcMain.on(CH.REC_DATA, (_e, payload) => {
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        resolve(payload);
      }
    });

    ipcMain.on(CH.REC_ERROR, (_e, message) => {
      if (this.pendingResolve) {
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        resolve({ error: message });
      } else if (this.state === 'listening') {
        this._fail(message || 'Microphone error.');
      }
    });
  }

  _setState(state, extra = {}) {
    this.state = state;
    const s = this.settings();
    const payload = { state, sounds: s.soundsEnabled, ...extra };
    windows.send(windows.getOverlay(), CH.OVL_STATE, payload);
    windows.send(windows.getHub(), CH.HUB_SESSION_STATE, payload);
    this.emit('state', payload);
  }

  _clearTimers() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  _hideSoon(ms) {
    this._clearTimers();
    const token = this.token;
    this.hideTimer = setTimeout(() => {
      if (this.token !== token) return;
      const s = this.settings();
      if (s.overlayVisibleWhenIdle) {
        this._setState('idle');
      } else {
        windows.hideOverlay();
        this.state = 'idle';
        windows.send(windows.getHub(), CH.HUB_SESSION_STATE, { state: 'idle' });
      }
    }, ms);
  }

  /** Hotkey down. */
  begin() {
    // A finished, failed or cancelled pill may still be lingering on screen —
    // starting again should simply replace it.
    const inFlight = ['listening', 'transcribing', 'polishing', 'inserting'];
    if (inFlight.includes(this.state)) return;
    this._clearTimers();
    this.token += 1;
    const s = this.settings();

    const recorder = windows.getRecorder();
    if (!recorder) {
      this._fail('Audio capture is not ready yet. Give it a second and try again.');
      return;
    }

    this.startedAt = Date.now();
    windows.showOverlay(s.overlayPosition);
    this._setState('listening');
    windows.send(recorder, CH.REC_START, { deviceId: s.inputDeviceId });

    this.maxTimer = setTimeout(() => {
      if (this.state === 'listening') this.finish();
    }, Math.max(5000, s.maxDurationMs));
  }

  /** Hotkey up. */
  async finish() {
    if (this.state !== 'listening') return;
    const token = this.token;
    const s = this.settings();
    const durationMs = Date.now() - this.startedAt;
    this._clearTimers();

    const recorder = windows.getRecorder();
    if (!recorder) {
      this._fail('Audio capture went away mid-dictation.');
      return;
    }

    const payload = await new Promise((resolve) => {
      this.pendingResolve = resolve;
      windows.send(recorder, CH.REC_STOP, {});
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          resolve({ error: 'Timed out waiting for the audio buffer.' });
        }
      }, 8000);
    });

    if (this.token !== token) return; // cancelled while we waited

    if (!payload || payload.error) {
      this._fail(payload && payload.error ? payload.error : 'No audio was captured.');
      return;
    }

    const bytes = payload.buffer ? Buffer.from(payload.buffer) : Buffer.alloc(0);
    const recordedMs = payload.durationMs || durationMs;

    if (recordedMs < s.minDurationMs || bytes.length < 600) {
      // A stray tap, not a dictation. Disappear quietly.
      this._setState('idle');
      this._hideSoon(0);
      return;
    }

    await this._process(bytes, payload.mimeType || 'audio/wav', recordedMs, token);
  }

  async _process(bytes, mimeType, recordedMs, token) {
    const s = this.settings();
    let raw = '';
    let sttProvider = '';
    let sttModel = '';

    try {
      this._setState('transcribing');
      const result = await providers.transcribe(bytes, mimeType);
      raw = result.text;
      sttProvider = result.provider;
      sttModel = result.model;
    } catch (err) {
      if (this.token !== token) return;
      this._fail(err.message || 'Transcription failed.');
      history.push({
        raw: '',
        text: '',
        mode: s.mode,
        durationMs: recordedMs,
        words: 0,
        provider: s.transcriptionProvider,
        model: s.transcriptionModel,
        cleaned: false,
        error: err.message,
        limit: s.historyLimit
      });
      return;
    }

    if (this.token !== token) return;

    if (!raw || !raw.trim()) {
      this._fail("Didn't catch any speech in that.");
      return;
    }

    this._setState('polishing');
    const polished = await providers.polish(raw, s.mode);
    if (this.token !== token) return;

    // Layout is decided deterministically here rather than left to the model,
    // so the same words always come out laid out the same way.
    let text = dictionary.applyReplacements(polished.text);
    text = format.normalize(text, {
      mode: s.mode,
      autoPunctuate: s.autoPunctuate,
      autoCapitalize: s.autoCapitalize,
      trailingSpace: s.trailingSpace
    });

    if (!text) {
      this._fail('The cleanup step returned nothing usable.');
      return;
    }

    this._setState('inserting', { preview: text.slice(0, 120) });
    const injection = await paste.inject(text, {
      method: s.pasteMethod,
      restoreClipboard: s.restoreClipboard
    });

    const wordCount = guards.words(text);
    stats.record(wordCount, recordedMs);
    history.push({
      raw,
      text,
      mode: s.mode,
      durationMs: recordedMs,
      words: wordCount,
      provider: `${sttProvider}${polished.provider ? ` + ${polished.provider}` : ''}`,
      model: `${sttModel}${polished.model ? ` + ${polished.model}` : ''}`,
      cleaned: polished.cleaned,
      fallbackReason: polished.cleaned ? '' : polished.reason,
      limit: s.historyLimit
    });

    windows.send(windows.getHub(), CH.HUB_HISTORY_CHANGED, {});
    windows.send(windows.getHub(), CH.HUB_STATS_CHANGED, {});

    if (this.token !== token) return;

    if (!injection.ok) {
      this._setState('error', { message: injection.error, preview: text.slice(0, 120) });
      this.lastError = injection.error || '';
      windows.send(windows.getHub(), CH.HUB_TOAST, { level: 'warn', text: injection.error });
      this._hideSoon(ERROR_LINGER_MS);
      return;
    }

    this._setState('done', { words: wordCount, preview: text.slice(0, 120) });
    this._hideSoon(DONE_LINGER_MS);
  }

  cancel() {
    if (this.state === 'idle') return;
    this.token += 1;
    this._clearTimers();
    this.pendingResolve = null;
    const recorder = windows.getRecorder();
    if (recorder) windows.send(recorder, CH.REC_CANCEL, {});
    this._setState('cancelled');
    this._hideSoon(CANCEL_LINGER_MS);
  }

  _fail(message) {
    this.lastError = message;
    this.token += 1;
    this._clearTimers();
    this.pendingResolve = null;
    this._setState('error', { message });
    windows.send(windows.getHub(), CH.HUB_TOAST, { level: 'error', text: message });
    this._hideSoon(ERROR_LINGER_MS);
  }

  isBusy() {
    return this.state !== 'idle';
  }
}

let instance = null;
function getSession() {
  if (!instance) instance = new Session();
  return instance;
}

module.exports = { getSession };

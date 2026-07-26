'use strict';

const { EventEmitter } = require('events');
const { globalShortcut } = require('electron');

/**
 * Push-to-talk on Windows, in three tiers.
 *
 *  1. uiohook-napi present  -> real low-level keyboard hook. True keydown/keyup,
 *     supports bare keys like Right Ctrl. This is the good path.
 *  2. Absent, mode 'hold'   -> register an accelerator and exploit Windows key
 *     auto-repeat. A watchdog with no refire means the key was released.
 *     The threshold starts long (to clear the OS auto-repeat delay) then drops
 *     once repeats are observed, so long holds release quickly.
 *  3. Absent, mode 'toggle' -> press to start, press again to stop. Always works.
 *
 * Emits: 'down', 'up', 'cancel', 'toggle-start', 'toggle-stop'
 */

const REPEAT_WAIT_INITIAL = 700; // must exceed the OS auto-repeat delay
const REPEAT_WAIT_STREAM = 220; // once repeats are flowing, react fast

/** Bare keys we allow as a raw push-to-talk key (uiohook tier only). */
const RAW_KEYS = [
  { id: 'RightControl', label: 'Right Ctrl', uio: 'CtrlRight', fallback: 3613 },
  { id: 'RightAlt', label: 'Right Alt', uio: 'AltRight', fallback: 3640 },
  { id: 'RightShift', label: 'Right Shift', uio: 'ShiftRight', fallback: 54 },
  { id: 'CapsLock', label: 'Caps Lock', uio: 'CapsLock', fallback: 58 },
  { id: 'F13', label: 'F13', uio: 'F13', fallback: 91 },
  { id: 'F14', label: 'F14', uio: 'F14', fallback: 92 },
  { id: 'F15', label: 'F15', uio: 'F15', fallback: 93 }
];

const ESCAPE_KEYCODE = 1;

class HotkeyManager extends EventEmitter {
  constructor() {
    super();
    this.settings = null;
    this.tier = 'none';
    this.uio = null;
    this.uioKey = null;
    this.holding = false;
    this.toggleOn = false;
    this.watchdog = null;
    this.lastFire = 0;
    this.fireCount = 0;
    this.escapeRegistered = false;
    this.lastError = '';
    this._loadHook();
  }

  _loadHook() {
    try {
      // Optional dependency. Absent on machines where the native build failed.
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      const mod = require('uiohook-napi');
      if (mod && mod.uIOhook) {
        this.uio = mod.uIOhook;
        this.uioKey = mod.UiohookKey || {};
      }
    } catch (err) {
      this.uio = null;
      this.lastError = 'uiohook-napi not available';
    }
  }

  hookAvailable() {
    return !!this.uio;
  }

  rawHotkeyActive() {
    return this.tier === 'uiohook';
  }

  info() {
    return {
      tier: this.tier,
      hookAvailable: this.hookAvailable(),
      rawKeys: RAW_KEYS.map((k) => ({ id: k.id, label: k.label })),
      error: this.lastError
    };
  }

  _rawKeycode(id) {
    const entry = RAW_KEYS.find((k) => k.id === id) || RAW_KEYS[0];
    const fromLib = this.uioKey ? this.uioKey[entry.uio] : undefined;
    return typeof fromLib === 'number' ? fromLib : entry.fallback;
  }

  /** (Re)binds according to current settings. Safe to call repeatedly. */
  apply(settings) {
    this.settings = settings;
    this.teardown();
    this.lastError = '';

    const wantRaw = settings.useRawHotkey && this.hookAvailable();
    if (wantRaw) {
      this._startUiohook(settings);
      return this.info();
    }

    if (settings.hotkeyMode === 'toggle') this._startToggle(settings);
    else this._startHoldFallback(settings);
    return this.info();
  }

  /* ------------------------------------------------------- tier 1: uiohook */

  _startUiohook(settings) {
    const target = this._rawKeycode(settings.hotkeyRawKey);
    this._onDown = (e) => {
      if (e.keycode === ESCAPE_KEYCODE) {
        if (this.holding || this.toggleOn) this.emit('cancel');
        return;
      }
      if (e.keycode !== target) return;
      if (settings.hotkeyMode === 'toggle') {
        this.toggleOn = !this.toggleOn;
        this.emit(this.toggleOn ? 'down' : 'up');
        return;
      }
      if (this.holding) return; // ignore OS auto-repeat
      this.holding = true;
      this.emit('down');
    };
    this._onUp = (e) => {
      if (e.keycode !== target) return;
      if (settings.hotkeyMode === 'toggle') return;
      if (!this.holding) return;
      this.holding = false;
      this.emit('up');
    };

    try {
      this.uio.on('keydown', this._onDown);
      this.uio.on('keyup', this._onUp);
      this.uio.start();
      this.tier = 'uiohook';
    } catch (err) {
      this.lastError = `keyboard hook failed: ${err.message}`;
      this.uio = null;
      this.tier = 'none';
      // Fall back so the app is still usable.
      if (settings.hotkeyMode === 'toggle') this._startToggle(settings);
      else this._startHoldFallback(settings);
    }
  }

  /* ------------------------------------------ tier 2/3: globalShortcut */

  _register(accel, handler) {
    try {
      const ok = globalShortcut.register(accel, handler);
      if (!ok) {
        this.lastError = `Another app already owns ${accel}.`;
        return false;
      }
      return true;
    } catch (err) {
      this.lastError = `Could not register ${accel}: ${err.message}`;
      return false;
    }
  }

  _startToggle(settings) {
    const ok = this._register(settings.hotkeyAccelerator, () => {
      this.toggleOn = !this.toggleOn;
      if (this.toggleOn) {
        this._registerEscape();
        this.emit('down');
      } else {
        this._unregisterEscape();
        this.emit('up');
      }
    });
    this.tier = ok ? 'toggle' : 'none';
  }

  _startHoldFallback(settings) {
    const ok = this._register(settings.hotkeyAccelerator, () => {
      this.lastFire = Date.now();
      this.fireCount += 1;
      if (this.holding) return;
      this.holding = true;
      this.fireCount = 1;
      this._registerEscape();
      this.emit('down');
      this.watchdog = setInterval(() => {
        const wait = this.fireCount > 1 ? REPEAT_WAIT_STREAM : REPEAT_WAIT_INITIAL;
        if (Date.now() - this.lastFire < wait) return;
        this._stopWatchdog();
        this.holding = false;
        this._unregisterEscape();
        this.emit('up');
      }, 40);
    });
    this.tier = ok ? 'hold-fallback' : 'none';
  }

  _stopWatchdog() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  _registerEscape() {
    if (!this.settings || !this.settings.cancelKeyEnabled) return;
    if (this.escapeRegistered) return;
    try {
      this.escapeRegistered = globalShortcut.register('Escape', () => {
        this.emit('cancel');
      });
    } catch (_) {
      this.escapeRegistered = false;
    }
  }

  _unregisterEscape() {
    if (!this.escapeRegistered) return;
    try {
      globalShortcut.unregister('Escape');
    } catch (_) {
      /* ignore */
    }
    this.escapeRegistered = false;
  }

  /** Called by the session when it ends for any reason. */
  reset() {
    this._stopWatchdog();
    this.holding = false;
    this.toggleOn = false;
    this._unregisterEscape();
  }

  teardown() {
    this._stopWatchdog();
    this._unregisterEscape();
    this.holding = false;
    this.toggleOn = false;
    this.fireCount = 0;
    try {
      globalShortcut.unregisterAll();
    } catch (_) {
      /* ignore */
    }
    if (this.uio && this._onDown) {
      try {
        this.uio.off('keydown', this._onDown);
        this.uio.off('keyup', this._onUp);
      } catch (_) {
        /* ignore */
      }
      this._onDown = null;
      this._onUp = null;
    }
    this.tier = 'none';
  }

  destroy() {
    this.teardown();
    if (this.uio) {
      try {
        this.uio.stop();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

module.exports = { HotkeyManager, RAW_KEYS };

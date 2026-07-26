'use strict';

const { ipcMain, app, shell, clipboard } = require('electron');
const { CH } = require('../shared/channels');
const { MODES, MODELS, PROVIDER_LABELS } = require('../shared/defaults');
const { getSettings, getSecrets } = require('./store');
const providers = require('./providers');
const history = require('./history');
const stats = require('./stats');
const dictionary = require('./dictionary');
const paste = require('./paste');
const windows = require('./windows');
const { RAW_KEYS } = require('./hotkey');

/** Ask the hidden recorder window for the microphone list. */
function askDevices() {
  return new Promise((resolve) => {
    const rec = windows.getRecorder();
    if (!rec) {
      resolve([]);
      return;
    }
    const done = (_e, list) => {
      ipcMain.removeListener(CH.REC_DEVICES, done);
      resolve(Array.isArray(list) ? list : []);
    };
    ipcMain.on(CH.REC_DEVICES, done);
    windows.send(rec, CH.REC_LIST_DEVICES, {});
    setTimeout(() => {
      ipcMain.removeListener(CH.REC_DEVICES, done);
      resolve([]);
    }, 4000);
  });
}

/**
 * @param {{hotkeys:object, session:object, getActiveMic:Function,
 *          getDevices:Function, onSettingsChanged:Function}} deps
 */
function registerIpc(deps) {
  const settings = getSettings();

  // While the Settings panel is open the recorder streams input levels so the
  // user can speak and watch the meter to confirm they picked the right mic.
  let monitoring = false;

  const snapshot = () => ({
    settings: settings.all(),
    modes: MODES,
    models: MODELS,
    providerLabels: PROVIDER_LABELS,
    keys: providers.keyStatus(),
    hotkey: deps.hotkeys.info(),
    rawKeys: RAW_KEYS.map((k) => ({ id: k.id, label: k.label })),
    problems: providers.validate(),
    devices: deps.getDevices ? deps.getDevices() : [],
    activeMic: deps.getActiveMic ? deps.getActiveMic() : null,
    version: app.getVersion(),
    platform: process.platform,
    dataDir: app.getPath('userData')
  });

  ipcMain.handle(CH.HUB_BOOTSTRAP, () => snapshot());
  ipcMain.handle(CH.HUB_SETTINGS_GET, () => settings.all());

  ipcMain.handle(CH.HUB_SETTINGS_SET, (_e, patch) => {
    const next = settings.set(patch || {});
    deps.onSettingsChanged(next, patch || {});
    return snapshot();
  });

  ipcMain.handle(CH.HUB_KEY_SET, (_e, { provider, value }) => {
    if (!providers.REGISTRY[provider]) return { ok: false, error: 'Unknown provider.' };
    const out = getSecrets().set(providers.keyName(provider), String(value || '').trim());
    return { ...out, keys: providers.keyStatus(), problems: providers.validate() };
  });

  ipcMain.handle(CH.HUB_KEY_CLEAR, (_e, { provider }) => {
    getSecrets().clear(providers.keyName(provider));
    return { ok: true, keys: providers.keyStatus(), problems: providers.validate() };
  });

  ipcMain.handle(CH.HUB_KEY_STATUS, () => ({
    keys: providers.keyStatus(),
    problems: providers.validate()
  }));

  ipcMain.handle(CH.HUB_TEST_PROVIDER, async (_e, { provider, key }) => {
    try {
      return await providers.test(provider, key);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ------------------------------------------------------------ history */

  ipcMain.handle(CH.HUB_HISTORY_LIST, (_e, { query, limit } = {}) =>
    history.list(query, limit || 200)
  );
  ipcMain.handle(CH.HUB_HISTORY_CLEAR, () => {
    history.clear();
    return [];
  });
  ipcMain.handle(CH.HUB_HISTORY_DELETE, (_e, { id }) => {
    history.remove(id);
    return history.list('', 200);
  });
  ipcMain.handle(CH.HUB_HISTORY_COPY, (_e, { id, raw }) => {
    const entry = history.get(id);
    if (!entry) return { ok: false, error: 'Entry not found.' };
    clipboard.writeText(raw ? entry.raw : entry.text);
    return { ok: true };
  });
  ipcMain.handle(CH.HUB_HISTORY_PASTE, async (_e, { id, raw }) => {
    const entry = history.get(id);
    if (!entry) return { ok: false, error: 'Entry not found.' };
    const hub = windows.getHub();
    if (hub) hub.minimize();
    await new Promise((r) => setTimeout(r, 320));
    const s = settings.all();
    return paste.inject(raw ? entry.raw : entry.text, {
      method: s.pasteMethod,
      restoreClipboard: s.restoreClipboard
    });
  });

  /* --------------------------------------------------------- dictionary */

  ipcMain.handle(CH.HUB_DICT_LIST, () => dictionary.list());
  ipcMain.handle(CH.HUB_DICT_ADD, (_e, entry) => dictionary.add(entry || {}));
  ipcMain.handle(CH.HUB_DICT_REMOVE, (_e, { id }) => dictionary.remove(id));

  /* -------------------------------------------------------------- stats */

  ipcMain.handle(CH.HUB_STATS_GET, () => stats.summary());
  ipcMain.handle(CH.HUB_STATS_RESET, () => {
    stats.reset();
    return stats.summary();
  });

  /* ---------------------------------------------------------- app misc */

  ipcMain.handle(CH.HUB_MIC_DEVICES, () => askDevices());

  ipcMain.handle(CH.HUB_MIC_MONITOR, (_e, { on } = {}) => {
    monitoring = !!on;
    const s = settings.all();
    windows.send(windows.getRecorder(), CH.REC_MONITOR, {
      on: monitoring,
      deviceId: s.inputDeviceId,
      label: s.inputDeviceLabel
    });
    return { ok: true, monitoring };
  });

  // The session forwards levels to the pill during a dictation; this forwards
  // the same stream to the hub while the meter is on screen.
  ipcMain.on(CH.REC_LEVEL, (_e, level) => {
    if (!monitoring) return;
    windows.send(windows.getHub(), CH.HUB_MIC_LEVEL, level);
  });

  ipcMain.handle(CH.HUB_MIC_CHECK, async () => {
    const devices = await askDevices();
    const labelled = devices.filter((d) => d.label);
    return {
      ok: devices.length > 0 && labelled.length > 0,
      count: devices.length,
      devices,
      hint:
        devices.length === 0
          ? 'No microphone was found. Plug one in, then reopen this window.'
          : labelled.length === 0
            ? 'Microphone access has not been granted yet. Check Windows Settings → Privacy → Microphone.'
            : ''
    };
  });

  ipcMain.handle(CH.HUB_HOTKEY_INFO, () => deps.hotkeys.info());

  ipcMain.handle(CH.HUB_ONBOARDING_DONE, () => {
    const next = settings.set({ onboarded: true });
    deps.onSettingsChanged(next, { onboarded: true });
    return next;
  });

  ipcMain.handle(CH.HUB_OPEN_EXTERNAL, (_e, { url }) => {
    if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle(CH.HUB_OPEN_DATA_DIR, () => {
    shell.openPath(app.getPath('userData'));
    return { ok: true };
  });

  ipcMain.handle(CH.HUB_TRIGGER_DICTATION, () => {
    const hub = windows.getHub();
    if (hub) hub.minimize();
    setTimeout(() => deps.session.begin(), 350);
    return { ok: true };
  });

  ipcMain.handle(CH.HUB_WINDOW, (_e, { action }) => {
    const hub = windows.getHub();
    if (!hub) return { ok: false };
    if (action === 'minimize') hub.minimize();
    if (action === 'close') hub.hide();
    return { ok: true };
  });

  /* ------------------------------------------------------ overlay input */

  ipcMain.on(CH.OVL_CANCEL, () => deps.session.cancel());
  ipcMain.on(CH.OVL_OPEN_HUB, () => windows.createHub({ show: true }));
}

module.exports = { registerIpc, askDevices };

'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { CH } = require('../shared/channels');

const invoke = (ch, payload) => ipcRenderer.invoke(ch, payload);
const on = (ch, fn) => {
  const wrapped = (_e, p) => fn(p);
  ipcRenderer.on(ch, wrapped);
  return () => ipcRenderer.removeListener(ch, wrapped);
};

contextBridge.exposeInMainWorld('cadence', {
  bootstrap: () => invoke(CH.HUB_BOOTSTRAP),

  settings: {
    get: () => invoke(CH.HUB_SETTINGS_GET),
    set: (patch) => invoke(CH.HUB_SETTINGS_SET, patch),
    onChanged: (fn) => on(CH.HUB_SETTINGS_CHANGED, fn)
  },

  keys: {
    status: () => invoke(CH.HUB_KEY_STATUS),
    set: (provider, value) => invoke(CH.HUB_KEY_SET, { provider, value }),
    clear: (provider) => invoke(CH.HUB_KEY_CLEAR, { provider }),
    test: (provider, key) => invoke(CH.HUB_TEST_PROVIDER, { provider, key })
  },

  history: {
    list: (query, limit) => invoke(CH.HUB_HISTORY_LIST, { query, limit }),
    clear: () => invoke(CH.HUB_HISTORY_CLEAR),
    remove: (id) => invoke(CH.HUB_HISTORY_DELETE, { id }),
    copy: (id, raw) => invoke(CH.HUB_HISTORY_COPY, { id, raw }),
    paste: (id, raw) => invoke(CH.HUB_HISTORY_PASTE, { id, raw }),
    onChanged: (fn) => on(CH.HUB_HISTORY_CHANGED, fn)
  },

  dictionary: {
    list: () => invoke(CH.HUB_DICT_LIST),
    add: (entry) => invoke(CH.HUB_DICT_ADD, entry),
    remove: (id) => invoke(CH.HUB_DICT_REMOVE, { id })
  },

  stats: {
    get: () => invoke(CH.HUB_STATS_GET),
    reset: () => invoke(CH.HUB_STATS_RESET),
    onChanged: (fn) => on(CH.HUB_STATS_CHANGED, fn)
  },

  mic: {
    check: () => invoke(CH.HUB_MIC_CHECK),
    devices: () => invoke(CH.HUB_MIC_DEVICES),
    monitor: (on) => invoke(CH.HUB_MIC_MONITOR, { on }),
    onLevel: (fn) => on(CH.HUB_MIC_LEVEL, fn),
    onChanged: (fn) => on(CH.HUB_MIC_CHANGED, fn),
    onActive: (fn) => on(CH.HUB_MIC_ACTIVE, fn)
  },

  hotkey: {
    info: () => invoke(CH.HUB_HOTKEY_INFO)
  },

  app: {
    finishOnboarding: () => invoke(CH.HUB_ONBOARDING_DONE),
    openExternal: (url) => invoke(CH.HUB_OPEN_EXTERNAL, { url }),
    openDataDir: () => invoke(CH.HUB_OPEN_DATA_DIR),
    dictate: () => invoke(CH.HUB_TRIGGER_DICTATION),
    window: (action) => invoke(CH.HUB_WINDOW, { action })
  },

  onSessionState: (fn) => on(CH.HUB_SESSION_STATE, fn),
  onToast: (fn) => on(CH.HUB_TOAST, fn),
  onGoto: (fn) => on(CH.HUB_GOTO, fn)
});

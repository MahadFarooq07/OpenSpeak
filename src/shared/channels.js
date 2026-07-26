'use strict';

/**
 * Single source of truth for every IPC channel name in the app.
 * Main, preload and (indirectly) renderer all read from here.
 */
const CH = {
  // --- recorder window (main <-> hidden capture window) ---
  REC_WARM: 'recorder:warm',
  REC_START: 'recorder:start',
  REC_STOP: 'recorder:stop',
  REC_CANCEL: 'recorder:cancel',
  REC_READY: 'recorder:ready',
  REC_LEVEL: 'recorder:level',
  REC_DATA: 'recorder:data',
  REC_ERROR: 'recorder:error',
  REC_DEVICES: 'recorder:devices',
  REC_LIST_DEVICES: 'recorder:list-devices',
  REC_MONITOR: 'recorder:monitor',

  // --- overlay pill ---
  OVL_STATE: 'overlay:state',
  OVL_LEVEL: 'overlay:level',
  OVL_CANCEL: 'overlay:cancel',
  OVL_OPEN_HUB: 'overlay:open-hub',

  // --- hub <-> main ---
  HUB_BOOTSTRAP: 'hub:bootstrap',
  HUB_SETTINGS_GET: 'hub:settings:get',
  HUB_SETTINGS_SET: 'hub:settings:set',
  HUB_SETTINGS_CHANGED: 'hub:settings:changed',

  HUB_KEY_SET: 'hub:key:set',
  HUB_KEY_CLEAR: 'hub:key:clear',
  HUB_KEY_STATUS: 'hub:key:status',
  HUB_TEST_PROVIDER: 'hub:provider:test',

  HUB_HISTORY_LIST: 'hub:history:list',
  HUB_HISTORY_CLEAR: 'hub:history:clear',
  HUB_HISTORY_DELETE: 'hub:history:delete',
  HUB_HISTORY_COPY: 'hub:history:copy',
  HUB_HISTORY_PASTE: 'hub:history:paste',
  HUB_HISTORY_CHANGED: 'hub:history:changed',

  HUB_DICT_LIST: 'hub:dictionary:list',
  HUB_DICT_ADD: 'hub:dictionary:add',
  HUB_DICT_REMOVE: 'hub:dictionary:remove',
  HUB_DICT_CHANGED: 'hub:dictionary:changed',

  HUB_STATS_GET: 'hub:stats:get',
  HUB_STATS_RESET: 'hub:stats:reset',
  HUB_STATS_CHANGED: 'hub:stats:changed',

  HUB_SESSION_STATE: 'hub:session:state',
  HUB_TOAST: 'hub:toast',

  HUB_MIC_CHECK: 'hub:mic:check',
  HUB_MIC_DEVICES: 'hub:mic:devices',
  HUB_MIC_MONITOR: 'hub:mic:monitor',
  HUB_MIC_LEVEL: 'hub:mic:level',
  HUB_MIC_CHANGED: 'hub:mic:changed',
  HUB_MIC_ACTIVE: 'hub:mic:active',
  HUB_HOTKEY_INFO: 'hub:hotkey:info',
  HUB_HOTKEY_CAPTURE: 'hub:hotkey:capture',
  HUB_ONBOARDING_DONE: 'hub:onboarding:done',
  HUB_OPEN_EXTERNAL: 'hub:open-external',
  HUB_OPEN_DATA_DIR: 'hub:open-data-dir',
  HUB_WINDOW: 'hub:window',
  HUB_TRIGGER_DICTATION: 'hub:trigger-dictation',
  HUB_GOTO: 'hub:goto'
};

module.exports = { CH };

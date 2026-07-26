'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { CH } = require('../shared/channels');
const windows = require('./windows');
const { getSettings } = require('./store');
const { HotkeyManager } = require('./hotkey');
const { getSession } = require('./session');
const { registerIpc } = require('./ipc');
const { createTray, refreshTray, destroyTray } = require('./tray');
const autostart = require('./autostart');
const paste = require('./paste');

let hotkeys = null;
let session = null;
let quitting = false;
let deviceCache = [];
let activeMic = null;

/** One definition of the tray's behaviour, reused on every refresh. */
function trayHandlers() {
  return {
    getSettings: () => getSettings().all(),
    getDevices: () => deviceCache,
    rawHotkeyActive: () => (hotkeys ? hotkeys.rawHotkeyActive() : false),
    onOpen: () => windows.createHub({ show: true }),
    onSettings: () => windows.createHub({ show: true, view: 'settings' }),
    onKeys: () => windows.createHub({ show: true, view: 'settings', anchor: 'keys' }),
    onDictate: () => session && session.begin(),
    onModeChange: (mode) => {
      const next = getSettings().set({ mode });
      applySettings(next, { mode });
    },
    onMicChange: (deviceId, label) => {
      const next = getSettings().set({ inputDeviceId: deviceId, inputDeviceLabel: label });
      applySettings(next, { inputDeviceId: deviceId });
    },
    onQuit: () => {
      quitting = true;
      windows.setQuitting(true);
      app.quit();
    }
  };
}

function boot() {
  app.on('second-instance', () => {
    windows.createHub({ show: true });
  });

  app.on('window-all-closed', () => {
    // Cadence lives in the tray; closing the hub does not quit.
  });

  app.on('before-quit', () => {
    quitting = true;
    windows.setQuitting(true);
    if (hotkeys) hotkeys.destroy();
    destroyTray();
    paste.shutdown();
  });

  app.whenReady().then(onReady).catch((err) => {
    dialog.showErrorBox('Cadence failed to start', String(err && err.stack ? err.stack : err));
    app.quit();
  });
}

function onReady() {
  const settings = getSettings();

  // Microphone permission prompts are handled by the OS; auto-approve the
  // in-app request so the hidden recorder can hold a warm stream.
  const ses = require('electron').session.defaultSession;
  const allowed = new Set(['media', 'audioCapture']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  // Without this, enumerateDevices() returns unlabelled entries.
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  const recorder = windows.createRecorder();
  recorder.webContents.once('did-finish-load', () => {
    const s0 = settings.all();
    // The recorder warms the default mic on boot; hand it the saved choice.
    if (s0.inputDeviceId && s0.inputDeviceId !== 'default') {
      windows.send(recorder, CH.REC_WARM, {
        deviceId: s0.inputDeviceId,
        label: s0.inputDeviceLabel
      });
    }
    windows.send(recorder, CH.REC_LIST_DEVICES, {});
  });
  paste.warm();

  session = getSession();
  hotkeys = new HotkeyManager();
  hotkeys.on('down', () => session.begin());
  hotkeys.on('up', () => session.finish());
  hotkeys.on('cancel', () => session.cancel());
  hotkeys.apply(settings.all());

  registerIpc({
    hotkeys,
    session,
    getActiveMic: () => activeMic,
    getDevices: () => deviceCache,
    onSettingsChanged: applySettings
  });

  createTray(trayHandlers());

  // Show the hub on first run (or when not started via autostart --hidden).
  const s = settings.all();
  const hidden = autostart.launchedHidden() || (s.startMinimized && s.onboarded);
  windows.createHub({ show: !hidden });

  if (s.overlayVisibleWhenIdle) {
    windows.showOverlay(s.overlayPosition);
    windows.send(windows.getOverlay(), CH.OVL_STATE, { state: 'idle' });
  } else {
    windows.createOverlay(s.overlayPosition);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length === 0) {
      windows.createHub({ show: true });
    }
  });
}

/** Side effects for anything the user changed in Settings. */
function applySettings(next, patch) {
  const touchedHotkey =
    'hotkeyMode' in patch ||
    'hotkeyAccelerator' in patch ||
    'hotkeyRawKey' in patch ||
    'useRawHotkey' in patch ||
    'cancelKeyEnabled' in patch;

  if (touchedHotkey && hotkeys) hotkeys.apply(next);

  if ('launchAtLogin' in patch || 'startMinimized' in patch) {
    autostart.apply(next.launchAtLogin, { startMinimized: next.startMinimized });
  }

  if ('overlayPosition' in patch) {
    windows.positionOverlay(next.overlayPosition);
  }

  if ('overlayVisibleWhenIdle' in patch) {
    if (next.overlayVisibleWhenIdle) {
      windows.showOverlay(next.overlayPosition);
      windows.send(windows.getOverlay(), CH.OVL_STATE, { state: 'idle' });
    } else if (!session || !session.isBusy()) {
      windows.hideOverlay();
    }
  }

  if ('inputDeviceId' in patch || 'inputDeviceLabel' in patch) {
    windows.send(windows.getRecorder(), CH.REC_WARM, {
      deviceId: next.inputDeviceId,
      label: next.inputDeviceLabel
    });
  }

  refreshTray(trayHandlers());

  windows.send(windows.getHub(), CH.HUB_SETTINGS_CHANGED, next);
}

// The recorder tells us when its warm stream is live (or failed to start).
ipcMain.on(CH.REC_READY, (_e, info) => {
  if (!info) return;
  if (info.error) {
    activeMic = { error: info.error };
    windows.send(windows.getHub(), CH.HUB_TOAST, { level: 'error', text: info.error });
    windows.send(windows.getHub(), CH.HUB_MIC_ACTIVE, activeMic);
    return;
  }
  activeMic = { deviceId: info.deviceId, label: info.label, fellBack: !!info.fellBack };
  windows.send(windows.getHub(), CH.HUB_MIC_ACTIVE, activeMic);
  if (info.fellBack) {
    windows.send(windows.getHub(), CH.HUB_TOAST, {
      level: 'warn',
      text: 'The microphone you chose is unavailable — using the system default for now.'
    });
  }
});

// Cache the device list so the tray can offer a Microphone submenu without
// having to round-trip to the hidden recorder every time the menu opens.
ipcMain.on(CH.REC_DEVICES, (_e, list) => {
  deviceCache = Array.isArray(list) ? list : [];
  windows.send(windows.getHub(), CH.HUB_MIC_CHANGED, deviceCache);
  refreshTray(trayHandlers());
});

// A second launch should surface the existing window, not start a rival app
// that fights for the same global hotkey.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

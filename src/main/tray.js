'use strict';

const { Tray, Menu, app } = require('electron');
const { appIcon } = require('./windows');
const { MODES } = require('../shared/defaults');

let tray = null;
let lastHandlers = null;

/**
 * @param {{onOpen:Function, onSettings:Function, onKeys:Function, onDictate:Function,
 *          onModeChange:Function, onMicChange:Function, onQuit:Function,
 *          getSettings:Function, getDevices:Function, rawHotkeyActive:Function}} handlers
 */
function createTray(handlers) {
  if (tray) return tray;
  // Rendered large and downsampled: nativeImage's filtering beats trying to
  // draw sub-pixel bars directly at 16px.
  tray = new Tray(appIcon(64, { plate: false, simple: true }).resize({ width: 16, height: 16 }));
  tray.setToolTip('OpenSpeak');
  tray.on('click', () => handlers.onOpen());
  tray.on('double-click', () => handlers.onOpen());
  refreshTray(handlers);
  return tray;
}

function micSubmenu(handlers, s) {
  const devices = (handlers.getDevices ? handlers.getDevices() : []) || [];
  const items = [
    {
      label: 'System default',
      type: 'radio',
      checked: !s.inputDeviceId || s.inputDeviceId === 'default',
      click: () => handlers.onMicChange('default', '')
    }
  ];

  const real = devices.filter((d) => d.deviceId && d.deviceId !== 'default');
  if (!real.length) {
    items.push({ label: 'No other inputs detected', enabled: false });
    return items;
  }

  real.forEach((d, i) => {
    items.push({
      label: d.label || `Microphone ${i + 1}`,
      type: 'radio',
      checked: s.inputDeviceId === d.deviceId,
      click: () => handlers.onMicChange(d.deviceId, d.label || '')
    });
  });
  return items;
}

function refreshTray(handlers) {
  if (!tray) return;
  lastHandlers = handlers || lastHandlers;
  const h = lastHandlers;
  if (!h) return;
  const s = h.getSettings();

  const menu = Menu.buildFromTemplate([
    { label: 'Open OpenSpeak', click: () => h.onOpen() },
    { label: 'Start dictation', click: () => h.onDictate() },
    { type: 'separator' },
    {
      label: `Hotkey: ${s.useRawHotkey && h.rawHotkeyActive && h.rawHotkeyActive() ? s.hotkeyRawKey : s.hotkeyAccelerator}`,
      enabled: false
    },
    {
      label: 'Formatting mode',
      submenu: MODES.map((m) => ({
        label: m.label,
        type: 'radio',
        checked: s.mode === m.id,
        click: () => h.onModeChange(m.id)
      }))
    },
    {
      label: 'Microphone',
      submenu: micSubmenu(h, s)
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => h.onSettings() },
    { label: 'API keys…', click: () => h.onKeys() },
    { type: 'separator' },
    { label: `OpenSpeak ${app.getVersion()}`, enabled: false },
    { label: 'Quit', click: () => h.onQuit() }
  ]);
  tray.setContextMenu(menu);
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  lastHandlers = null;
}

module.exports = { createTray, refreshTray, destroyTray };

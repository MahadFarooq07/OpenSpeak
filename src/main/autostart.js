'use strict';

const { app } = require('electron');

/**
 * Windows login item. In development `process.execPath` is electron.exe, so we
 * point the login item at electron with the project path as an argument —
 * otherwise enabling autostart in dev would launch a bare Electron shell.
 */
function apply(enabled, { startMinimized = false } = {}) {
  const isPackaged = app.isPackaged;
  const args = [];
  if (!isPackaged) args.push(app.getAppPath());
  if (startMinimized) args.push('--hidden');

  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function status() {
  try {
    return app.getLoginItemSettings();
  } catch (_) {
    return { openAtLogin: false };
  }
}

function launchedHidden() {
  return process.argv.includes('--hidden');
}

module.exports = { apply, status, launchedHidden };

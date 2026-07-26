'use strict';

const path = require('path');
const { BrowserWindow, screen, nativeImage } = require('electron');
const { CH } = require('../shared/channels');

const ROOT = path.join(__dirname, '..', '..');
const R = (...p) => path.join(ROOT, 'src', ...p);

// Deliberately small: the pill is a peripheral status cue, not a panel.
const OVERLAY_W = 230;
const OVERLAY_H = 52;
const OVERLAY_MARGIN = 46;

let hub = null;
let overlay = null;
let recorder = null;

/* ------------------------------------------------------------------ icon */

/* --------------------------------------------------------------- brand */

const BRAND = {
  plate: [19, 24, 33], // slate tile behind the mark
  markTop: [79, 158, 241], // sky blue, lit from above
  markBottom: [33, 116, 219]
};

/**
 * The mark: a letter C traced by level-meter bars — a monogram and a waveform
 * at once. Drawn procedurally into a raw BGRA buffer so the app needs no
 * bitmap icon asset and every size is rendered rather than scaled.
 *
 * @param {number} size
 * @param {{plate?:boolean, simple?:boolean}} opts
 *   `plate` draws the rounded tile (window and installer icon).
 *   `simple` uses five heavier bars instead of seven, which survives being
 *   squeezed into a 16px tray slot.
 */
function appIcon(size = 256, { plate = true, simple = false } = {}) {
  const buf = Buffer.alloc(size * size * 4, 0);

  // Source-over compositing so the mark anti-aliases against the plate.
  const blend = (x, y, r, g, b, a) => {
    if (a <= 0 || x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = Math.min(1, a);
    const da = buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    buf[i] = Math.round((b * sa + buf[i] * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((r * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };

  if (plate) {
    const c = size / 2;
    const half = size / 2;
    const corner = size * 0.22;
    const inner = half - corner;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        // Signed distance to a rounded square.
        const qx = Math.abs(x + 0.5 - c) - inner;
        const qy = Math.abs(y + 0.5 - c) - inner;
        const d =
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
          Math.min(Math.max(qx, qy), 0) -
          corner;
        const cov = Math.max(0, Math.min(1, 0.5 - d));
        if (cov > 0) blend(x, y, BRAND.plate[0], BRAND.plate[1], BRAND.plate[2], cov);
      }
    }
  }

  // Bar centres sit on an arc that opens to the right, forming the C. Heights
  // swell toward the belly so it also reads as a level meter.
  const angles = simple
    ? [-60, -120, -180, -240, -300]
    : [-60, -100, -140, -180, -220, -260, -300];
  const heights = simple
    ? [0.052, 0.098, 0.118, 0.098, 0.052]
    : [0.048, 0.072, 0.096, 0.108, 0.096, 0.072, 0.048];

  const cx = size * 0.52;
  const cy = size * 0.5;
  const radius = size * (simple ? 0.25 : 0.265);
  const halfW = size * (simple ? 0.05 : 0.037);

  angles.forEach((deg, i) => {
    const t = (deg * Math.PI) / 180;
    const bx = cx + radius * Math.cos(t);
    const by = cy + radius * Math.sin(t);
    const top = by - heights[i] * size;
    const bottom = by + heights[i] * size;

    const x0 = Math.floor(bx - halfW - 1);
    const x1 = Math.ceil(bx + halfW + 1);
    const y0 = Math.floor(top - halfW - 1);
    const y1 = Math.ceil(bottom + halfW + 1);

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        // Distance to the vertical segment gives a capsule with round caps.
        const clamped = Math.min(Math.max(py, top), bottom);
        const d = Math.hypot(px - bx, py - clamped);
        const cov = Math.max(0, Math.min(1, halfW + 0.5 - d));
        if (cov <= 0) continue;
        const g = Math.max(0, Math.min(1, (y / size - 0.2) / 0.6));
        blend(
          x,
          y,
          Math.round(BRAND.markTop[0] + (BRAND.markBottom[0] - BRAND.markTop[0]) * g),
          Math.round(BRAND.markTop[1] + (BRAND.markBottom[1] - BRAND.markTop[1]) * g),
          Math.round(BRAND.markTop[2] + (BRAND.markBottom[2] - BRAND.markTop[2]) * g),
          cov
        );
      }
    }
  });

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/* --------------------------------------------------------------- overlay */

function overlayBounds(position) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  let x;
  let y;
  switch (position) {
    case 'bottom-right':
      x = wa.x + wa.width - OVERLAY_W - 24;
      y = wa.y + wa.height - OVERLAY_H - 24;
      break;
    case 'top-center':
      x = wa.x + Math.round((wa.width - OVERLAY_W) / 2);
      y = wa.y + 28;
      break;
    case 'top-right':
      x = wa.x + wa.width - OVERLAY_W - 24;
      y = wa.y + 28;
      break;
    case 'bottom-center':
    default:
      x = wa.x + Math.round((wa.width - OVERLAY_W) / 2);
      y = wa.y + wa.height - OVERLAY_H - OVERLAY_MARGIN;
      break;
  }
  return { x: Math.round(x), y: Math.round(y), width: OVERLAY_W, height: OVERLAY_H };
}

function positionOverlay(position) {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setBounds(overlayBounds(position));
}

function createOverlay(position) {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    ...overlayBounds(position),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // critical: focus must never leave the user's app
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: R('preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(false);
  overlay.loadFile(R('renderer', 'overlay', 'index.html'));
  overlay.on('closed', () => {
    overlay = null;
  });
  return overlay;
}

function showOverlay(position) {
  const win = createOverlay(position);
  positionOverlay(position);
  if (!win.isVisible()) win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  return win;
}

function hideOverlay() {
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide();
}

function getOverlay() {
  return overlay && !overlay.isDestroyed() ? overlay : null;
}

/* -------------------------------------------------------------- recorder */

function createRecorder() {
  if (recorder && !recorder.isDestroyed()) return recorder;
  recorder = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: R('preload', 'recorder.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  recorder.loadFile(R('renderer', 'recorder', 'index.html'));
  recorder.on('closed', () => {
    recorder = null;
  });
  return recorder;
}

function getRecorder() {
  return recorder && !recorder.isDestroyed() ? recorder : null;
}

/* ------------------------------------------------------------------- hub */

/**
 * @param {{show?:boolean, view?:string, anchor?:string}} opts
 *   `view` deep-links to a section (e.g. 'settings'); `anchor` scrolls to a
 *   panel within it (e.g. 'keys'), so the tray can drop you straight on the
 *   API key fields.
 */
function createHub({ show = true, view = '', anchor = '' } = {}) {
  if (hub && !hub.isDestroyed()) {
    if (show) {
      if (hub.isMinimized()) hub.restore();
      hub.show();
      hub.focus();
    }
    if (view) send(hub, CH.HUB_GOTO, { view, anchor });
    return hub;
  }
  hub = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'Cadence',
    backgroundColor: '#0d0f14',
    icon: appIcon(256),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d0f14',
      symbolColor: '#9aa4b2',
      height: 40
    },
    webPreferences: {
      preload: R('preload', 'hub.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  hub.loadFile(R('renderer', 'hub', 'index.html'));
  hub.once('ready-to-show', () => {
    if (show) hub.show();
  });
  // The renderer boots asynchronously, so deep links wait for its first paint.
  hub.webContents.once('did-finish-load', () => {
    if (view) send(hub, CH.HUB_GOTO, { view, anchor });
  });
  // Cadence lives in the tray: closing the hub hides it instead of quitting.
  hub.on('close', (e) => {
    if (quittingForReal) return;
    e.preventDefault();
    hub.hide();
  });
  hub.on('closed', () => {
    hub = null;
  });
  return hub;
}

let quittingForReal = false;
function setQuitting(v) {
  quittingForReal = !!v;
}

function getHub() {
  return hub && !hub.isDestroyed() ? hub : null;
}

/** Send to a window only if it exists and is alive. */
function send(win, channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

module.exports = {
  appIcon,
  createOverlay,
  showOverlay,
  hideOverlay,
  positionOverlay,
  getOverlay,
  createRecorder,
  getRecorder,
  createHub,
  getHub,
  setQuitting,
  send,
  OVERLAY_W,
  OVERLAY_H
};

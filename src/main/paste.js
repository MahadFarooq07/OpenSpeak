'use strict';

const { spawn } = require('child_process');
const { clipboard } = require('electron');

/**
 * Text injection without native modules.
 *
 * A single PowerShell process is kept alive for the app's lifetime with
 * System.Windows.Forms already loaded. Injecting is then one line written to
 * its stdin (~5ms) instead of a ~300ms cold `powershell.exe` spawn per paste.
 */

const IS_WIN = process.platform === 'win32';
const READY_TOKEN = 'CADENCE_READY';
const INIT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Add-Type -AssemblyName System.Windows.Forms',
  `Write-Output "${READY_TOKEN}"`,
  ''
].join('\r\n');

let ps = null;
let psReady = false;
let psFailed = false;

/**
 * Starts (or restarts) the persistent shell. `psReady` only flips once the
 * shell has echoed a token back, so we never assume a session that PowerShell
 * is actually buffering — until then every injection uses a one-shot spawn.
 */
function startShell() {
  if (!IS_WIN || ps || psFailed) return;
  try {
    ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    ps.on('error', (err) => {
      console.error('[paste] powershell failed to start:', err.message);
      psFailed = true;
      ps = null;
      psReady = false;
    });
    ps.on('exit', () => {
      ps = null;
      psReady = false;
    });
    if (ps.stderr) ps.stderr.on('data', () => {});
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (chunk) => {
      if (String(chunk).includes(READY_TOKEN)) psReady = true;
    });
    ps.stdin.on('error', () => {});
    ps.stdin.write(INIT);
    // If PowerShell never answers, stop trusting the persistent path.
    setTimeout(() => {
      if (!psReady && ps) {
        try {
          ps.kill();
        } catch (_) {
          /* ignore */
        }
        ps = null;
      }
    }, 6000);
  } catch (err) {
    console.error('[paste] powershell spawn threw:', err.message);
    psFailed = true;
    ps = null;
  }
}

function run(line) {
  if (!IS_WIN) return false;
  if (!ps) startShell();
  if (ps && psReady) {
    try {
      ps.stdin.write(`${line}\r\n`);
      return true;
    } catch (_) {
      ps = null;
      psReady = false;
    }
  }
  // One-shot fallback if the persistent shell died.
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; ${line}`
      ],
      { windowsHide: true, stdio: 'ignore' }
    );
    child.on('error', () => {});
    return true;
  } catch (_) {
    return false;
  }
}

/** Escape a string for SendKeys' little markup language. */
function escapeSendKeys(text) {
  return String(text)
    .replace(/[+^%~(){}[\]]/g, (m) => `{${m}}`)
    .replace(/\r\n/g, '{ENTER}')
    .replace(/\n/g, '{ENTER}')
    .replace(/\r/g, '{ENTER}')
    .replace(/\t/g, '{TAB}');
}

/** Escape for a PowerShell single-quoted string literal. */
function escapePsString(text) {
  return String(text).replace(/'/g, "''");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} text
 * @param {{method?:'paste'|'type'|'clipboard', restoreClipboard?:boolean}} opts
 * @returns {Promise<{ok:boolean, method:string, error?:string}>}
 */
async function inject(text, opts = {}) {
  const method = opts.method || 'paste';
  const payload = String(text || '');
  if (!payload) return { ok: false, method, error: 'Nothing to inject.' };

  if (!IS_WIN) {
    clipboard.writeText(payload);
    return {
      ok: false,
      method: 'clipboard',
      error: 'Automatic insertion is Windows-only right now — the text is on your clipboard.'
    };
  }

  if (method === 'clipboard') {
    clipboard.writeText(payload);
    return { ok: true, method: 'clipboard' };
  }

  if (method === 'type') {
    // SendKeys in chunks; very long strings can otherwise drop characters.
    const chunks = payload.match(/[\s\S]{1,180}/g) || [];
    for (const chunk of chunks) {
      const ok = run(
        `[System.Windows.Forms.SendKeys]::SendWait('${escapePsString(escapeSendKeys(chunk))}')`
      );
      if (!ok) {
        clipboard.writeText(payload);
        return { ok: false, method, error: 'Could not simulate typing; text copied instead.' };
      }
      await sleep(12);
    }
    return { ok: true, method };
  }

  // Default: clipboard + Ctrl+V into whatever window has focus.
  const previous = opts.restoreClipboard ? clipboard.readText() : null;
  clipboard.writeText(payload);
  await sleep(35); // let the clipboard settle before the keystroke

  const ok = run("[System.Windows.Forms.SendKeys]::SendWait('^v')");
  if (!ok) {
    return {
      ok: false,
      method,
      error: 'Could not send Ctrl+V — the text is on your clipboard, press it yourself.'
    };
  }

  if (opts.restoreClipboard && previous !== null) {
    setTimeout(() => {
      // Only restore if nothing else claimed the clipboard in the meantime.
      if (clipboard.readText() === payload) clipboard.writeText(previous);
    }, 700);
  }

  return { ok: true, method };
}

function copy(text) {
  clipboard.writeText(String(text || ''));
}

function warm() {
  startShell();
}

function shutdown() {
  if (ps) {
    try {
      ps.stdin.end();
      ps.kill();
    } catch (_) {
      /* ignore */
    }
    ps = null;
    psReady = false;
  }
}

module.exports = { inject, copy, warm, shutdown, escapeSendKeys };

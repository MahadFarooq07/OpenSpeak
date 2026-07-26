'use strict';

const api = window.cadence;

const state = {
  settings: {},
  modes: [],
  models: {},
  providerLabels: {},
  keys: {},
  hotkey: {},
  rawKeys: [],
  problems: [],
  devices: [],
  activeMic: null,
  history: [],
  dictionary: [],
  stats: null,
  view: 'home'
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------------------------------------- helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(text, level = 'ok', ms = 3600) {
  if (!text) return;
  const node = el('div', `toast ${level}`, text);
  $('#toasts').appendChild(node);
  setTimeout(() => node.remove(), ms);
}

function prettyAccelerator(accel) {
  return String(accel || '')
    .split('+')
    .map((p) => (p === 'Control' ? 'Ctrl' : p === 'Space' ? 'Space' : p))
    .join(' + ');
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function humanDuration(ms) {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

/* ------------------------------------------------------------ settings */

async function saveSettings(patch) {
  const snap = await api.settings.set(patch);
  applySnapshot(snap);
}

function bindSettingInputs() {
  $$('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    const isCheckbox = input.type === 'checkbox';
    const isNumber = input.dataset.number === '1';
    const event = isCheckbox || input.tagName === 'SELECT' ? 'change' : 'change';
    input.addEventListener(event, () => {
      let value;
      if (isCheckbox) value = input.checked;
      else if (isNumber) value = Number(input.value) || 0;
      else value = input.value;
      saveSettings({ [key]: value });
    });
  });
}

function paintSettingInputs() {
  $$('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    if (!(key in state.settings)) return;
    const value = state.settings[key];
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value;
  });
}

/* ------------------------------------------------------------ snapshot */

function applySnapshot(snap) {
  if (!snap) return;
  Object.assign(state, {
    settings: snap.settings || state.settings,
    modes: snap.modes || state.modes,
    models: snap.models || state.models,
    providerLabels: snap.providerLabels || state.providerLabels,
    keys: snap.keys || state.keys,
    hotkey: snap.hotkey || state.hotkey,
    rawKeys: snap.rawKeys || state.rawKeys,
    problems: snap.problems || [],
    devices: snap.devices && snap.devices.length ? snap.devices : state.devices,
    activeMic: snap.activeMic || state.activeMic
  });
  if (snap.version) $('#version').textContent = `v${snap.version}`;
  render();
}

/* --------------------------------------------------------------- views */

function switchView(view, anchor) {
  state.view = view;
  $$('.nav').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === view)));
  $$('.view').forEach((s) => {
    s.hidden = s.dataset.view !== view;
  });
  if (view === 'history') loadHistory();
  if (view === 'dictionary') loadDictionary();
  if (view === 'stats') loadStats();

  // The input meter only runs while its panel is actually on screen.
  if (view === 'settings') {
    refreshDevices();
    setMonitoring(true);
  } else {
    setMonitoring(false);
  }

  if (anchor) {
    const target = $(`#panel-${anchor}`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.remove('flash');
      // Reflow so the animation re-runs if the same anchor is hit twice.
      void target.offsetWidth;
      target.classList.add('flash');
      const first = target.querySelector('input');
      if (first) setTimeout(() => first.focus(), 320);
    }
  } else {
    $('.content').scrollTop = 0;
  }
}

/* ---------------------------------------------------------------- home */

function hotkeyDisplay() {
  const s = state.settings;
  const usingRaw = s.useRawHotkey && state.hotkey.tier === 'uiohook';
  if (usingRaw) {
    const entry = state.rawKeys.find((k) => k.id === s.hotkeyRawKey);
    return entry ? entry.label : s.hotkeyRawKey;
  }
  return prettyAccelerator(s.hotkeyAccelerator);
}

function renderHome() {
  $('#heroHotkey').textContent = hotkeyDisplay();
  const s = state.settings;
  $('#heroSub').textContent =
    s.hotkeyMode === 'toggle'
      ? 'Press to start, press again to stop.'
      : 'Hold it, speak, let go.';

  const box = $('#problems');
  box.textContent = '';
  for (const p of state.problems) {
    const row = el('div', `problem ${p.level}`);
    row.appendChild(el('span', '', p.text));
    const wantsKey = /api key/i.test(p.text);
    const go = el('button', 'btn small ghost', wantsKey ? 'Add a key' : 'Fix');
    go.addEventListener('click', () => switchView('settings', wantsKey ? 'keys' : ''));
    row.appendChild(go);
    box.appendChild(row);
  }

  const grid = $('#modeGrid');
  grid.textContent = '';
  for (const m of state.modes) {
    const b = el('button', 'mode');
    b.setAttribute('aria-pressed', String(state.settings.mode === m.id));
    b.appendChild(el('strong', '', m.label));
    b.appendChild(el('small', '', m.blurb));
    b.addEventListener('click', () => saveSettings({ mode: m.id }));
    grid.appendChild(b);
  }
}

async function renderRecent() {
  const rows = await api.history.list('', 3);
  const box = $('#recent');
  box.textContent = '';
  if (!rows.length) {
    box.appendChild(
      el('div', 'empty', 'Nothing yet. Hold your hotkey anywhere in Windows and say something.')
    );
    return;
  }
  rows.forEach((r) => box.appendChild(entryNode(r, true)));
}

/* ------------------------------------------------------------- history */

function entryNode(entry, compact) {
  const node = el('div', 'entry');

  const top = el('div', 'entry-top');
  top.appendChild(el('span', '', relTime(entry.at)));
  top.appendChild(el('span', 'tag', entry.mode));
  if (entry.words) top.appendChild(el('span', 'tag', `${entry.words}w`));
  if (entry.error) top.appendChild(el('span', 'tag bad', 'failed'));
  else if (!entry.cleaned && entry.fallbackReason) {
    const t = el('span', 'tag warn', 'raw');
    t.title = `Cleanup skipped: ${entry.fallbackReason}`;
    top.appendChild(t);
  }
  node.appendChild(top);

  node.appendChild(el('div', 'entry-text', entry.error ? entry.error : entry.text));

  if (!compact && state.settings.showRawInHistory && entry.raw && entry.raw !== entry.text) {
    node.appendChild(el('div', 'entry-raw', `raw: ${entry.raw}`));
  }

  if (!compact && !entry.error) {
    const actions = el('div', 'entry-actions');

    const copy = el('button', 'btn small ghost', 'Copy');
    copy.addEventListener('click', async () => {
      await api.history.copy(entry.id, false);
      toast('Copied to clipboard.');
    });
    actions.appendChild(copy);

    const insert = el('button', 'btn small ghost', 'Insert again');
    insert.addEventListener('click', async () => {
      const res = await api.history.paste(entry.id, false);
      if (!res.ok) toast(res.error || 'Could not insert.', 'warn');
    });
    actions.appendChild(insert);

    if (entry.raw && entry.raw !== entry.text) {
      const copyRaw = el('button', 'btn small ghost', 'Copy raw');
      copyRaw.addEventListener('click', async () => {
        await api.history.copy(entry.id, true);
        toast('Raw transcript copied.');
      });
      actions.appendChild(copyRaw);
    }

    const del = el('button', 'btn small ghost danger', 'Delete');
    del.addEventListener('click', async () => {
      state.history = await api.history.remove(entry.id);
      paintHistory();
    });
    actions.appendChild(del);

    node.appendChild(actions);
  }

  return node;
}

async function loadHistory() {
  state.history = await api.history.list($('#historySearch').value, 200);
  paintHistory();
}

function paintHistory() {
  const box = $('#historyList');
  box.textContent = '';
  if (!state.history.length) {
    box.appendChild(el('div', 'empty', 'No dictations match.'));
    return;
  }
  state.history.forEach((r) => box.appendChild(entryNode(r, false)));
}

/* ---------------------------------------------------------- dictionary */

async function loadDictionary() {
  state.dictionary = await api.dictionary.list();
  paintDictionary();
}

function paintDictionary() {
  const box = $('#dictList');
  box.textContent = '';
  if (!state.dictionary.length) {
    box.appendChild(el('div', 'empty', 'No terms yet. Add the names Cadence keeps getting wrong.'));
    return;
  }
  for (const t of state.dictionary) {
    const chip = el('div', 'chip');
    if (t.heard) {
      chip.appendChild(el('span', 'from', t.heard));
      chip.appendChild(el('span', 'from', '→'));
    }
    chip.appendChild(el('span', '', t.write));
    const x = el('button', '', '×');
    x.title = 'Remove';
    x.addEventListener('click', async () => {
      state.dictionary = await api.dictionary.remove(t.id);
      paintDictionary();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

/* --------------------------------------------------------------- stats */

async function loadStats() {
  state.stats = await api.stats.get();
  paintStats();
}

function paintStats() {
  const s = state.stats;
  if (!s) return;
  const grid = $('#statGrid');
  grid.textContent = '';

  const cards = [
    { value: s.totalWords.toLocaleString(), key: 'words dictated' },
    { value: s.totalSessions.toLocaleString(), key: 'dictations' },
    { value: s.avgWpm ? `${s.avgWpm}` : '—', key: 'average words / minute' },
    { value: s.bestWpm ? `${s.bestWpm}` : '—', key: 'best words / minute' },
    { value: `${s.streak}`, key: s.streak === 1 ? 'day streak' : 'day streak' },
    { value: humanDuration(s.savedMs), key: 'saved vs typing at 40wpm' }
  ];
  for (const c of cards) {
    const card = el('div', 'stat');
    card.appendChild(el('div', 'value', c.value));
    card.appendChild(el('div', 'key', c.key));
    grid.appendChild(card);
  }

  const act = $('#activity');
  act.textContent = '';
  const max = Math.max(1, ...s.activity.map((d) => d.words));
  for (const day of s.activity) {
    const col = el('div', `act-col${day.words ? ' on' : ''}`);
    col.style.height = `${Math.max(3, Math.round((day.words / max) * 96))}px`;
    col.title = `${day.date}: ${day.words} words in ${day.sessions} dictation${day.sessions === 1 ? '' : 's'}`;
    act.appendChild(col);
  }
  const active = s.activity.filter((d) => d.sessions > 0).length;
  $('#activityCaption').textContent = `Active on ${active} of the last 30 days`;
}

/* ------------------------------------------------------------ settings */

function paintModelLists() {
  const t = (state.models.transcription || {})[state.settings.transcriptionProvider] || [];
  const c = (state.models.cleanup || {})[state.settings.cleanupProvider] || [];
  const fill = (id, items) => {
    const list = $(id);
    list.textContent = '';
    items.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.label = m.label;
      list.appendChild(o);
    });
  };
  fill('#transModels', t);
  fill('#cleanModels', c);
}

function paintKeyRows() {
  const box = $('#keyRows');
  box.textContent = '';
  const order = ['openai', 'anthropic', 'gemini'];
  const links = {
    openai: 'https://platform.openai.com/api-keys',
    anthropic: 'https://console.anthropic.com/settings/keys',
    gemini: 'https://aistudio.google.com/app/apikey'
  };

  for (const id of order) {
    const info = state.keys[id] || { present: false, hint: '' };
    const row = el('div', 'key-row');

    const head = el('div', 'head');
    head.appendChild(el('span', `pip${info.present ? ' on' : ''}`));
    head.appendChild(el('span', '', state.providerLabels[id] || id));
    if (info.present) head.appendChild(el('span', 'tag', info.hint));
    const getKey = el('button', 'link', 'Get a key');
    getKey.addEventListener('click', () => api.app.openExternal(links[id]));
    head.appendChild(getKey);
    row.appendChild(head);

    const controls = el('div', 'row');
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'input mono';
    input.placeholder = info.present ? 'Saved — paste a new key to replace' : 'Paste your API key';
    controls.appendChild(input);

    const result = el('div', 'key-result');

    const save = el('button', 'btn', 'Save');
    save.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) {
        result.className = 'key-result bad';
        result.textContent = 'Paste a key first.';
        return;
      }
      result.className = 'key-result';
      result.textContent = 'Saving…';
      const res = await api.keys.set(id, value);
      if (!res.ok) {
        result.className = 'key-result bad';
        result.textContent = res.error || 'Could not save the key.';
        return;
      }
      input.value = '';
      result.className = 'key-result';
      result.textContent = 'Saved. Testing…';
      const t = await api.keys.test(id);
      result.className = `key-result ${t.ok ? 'ok' : 'bad'}`;
      result.textContent = t.ok ? t.detail || 'Key works.' : t.error;
      await refreshKeys();
    });
    controls.appendChild(save);

    const test = el('button', 'btn ghost', 'Test');
    test.title = 'Tests the key in the box, or the saved one if the box is empty.';
    test.addEventListener('click', async () => {
      result.className = 'key-result';
      result.textContent = 'Testing…';
      const t = await api.keys.test(id, input.value.trim() || undefined);
      result.className = `key-result ${t.ok ? 'ok' : 'bad'}`;
      result.textContent = t.ok ? t.detail || 'Key works.' : t.error;
    });
    controls.appendChild(test);

    if (info.present) {
      const clear = el('button', 'btn ghost danger', 'Remove');
      clear.addEventListener('click', async () => {
        await api.keys.clear(id);
        await refreshKeys();
      });
      controls.appendChild(clear);
    }

    row.appendChild(controls);
    row.appendChild(result);
    box.appendChild(row);
  }

  $('#encryptionNote').textContent = state.keys.encryptionAvailable
    ? 'Keys are encrypted with the Windows credential store before being written to disk.'
    : 'Warning: OS encryption is unavailable on this machine, so keys cannot be saved securely.';
}

function paintHotkeyPanel() {
  const tierText = {
    uiohook: 'Low-level keyboard hook active — true hold-to-talk with any single key.',
    'hold-fallback':
      'Running without the native keyboard hook. Hold-to-talk works via key auto-repeat, so release is detected up to ~0.7s late. Toggle mode is exact.',
    toggle: 'Toggle mode: press the shortcut to start, press it again to stop.',
    none: 'No hotkey is registered. Another app may already own this shortcut.'
  };
  $('#hotkeyTier').textContent = tierText[state.hotkey.tier] || '';

  const sel = $('#setRawKey');
  if (sel.options.length !== state.rawKeys.length) {
    sel.textContent = '';
    state.rawKeys.forEach((k) => {
      const o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.label;
      sel.appendChild(o);
    });
    sel.value = state.settings.hotkeyRawKey;
  }

  const hookable = !!state.hotkey.hookAvailable;
  $('#setUseRawHotkey').disabled = !hookable;
  $('#rawToggleRow').title = hookable
    ? ''
    : 'Install the optional uiohook-napi dependency to use a single bare key.';
  const usingRaw = hookable && state.settings.useRawHotkey;
  $('#rawKeyField').style.display = usingRaw ? '' : 'none';
}

async function refreshKeys() {
  const res = await api.keys.status();
  state.keys = res.keys;
  state.problems = res.problems;
  paintKeyRows();
  renderHome();
}

/** Fills a <select> with the current inputs; returns true if the saved one survived. */
function fillDeviceSelect(sel, devices, selectedId, selectedLabel) {
  sel.textContent = '';
  const def = document.createElement('option');
  def.value = 'default';
  def.textContent = 'System default';
  sel.appendChild(def);

  let matched = !selectedId || selectedId === 'default';
  devices.forEach((d, i) => {
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') return;
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone ${i + 1}`;
    o.dataset.label = d.label || '';
    sel.appendChild(o);
    if (d.deviceId === selectedId) matched = true;
  });

  if (matched) {
    sel.value = selectedId || 'default';
    return true;
  }

  // The saved id is stale (a replugged USB mic gets a new one). Try the label
  // before silently dropping the user back to the system default.
  if (selectedLabel) {
    const byLabel = Array.from(sel.options).find((o) => o.dataset.label === selectedLabel);
    if (byLabel) {
      sel.value = byLabel.value;
      return true;
    }
  }
  sel.value = 'default';
  return false;
}

async function refreshDevices(known) {
  const devices = known || (await api.mic.devices());
  state.devices = devices;

  const sel = $('#setDevice');
  const survived = fillDeviceSelect(
    sel,
    devices,
    state.settings.inputDeviceId,
    state.settings.inputDeviceLabel
  );

  // Re-point the saved setting at whatever we actually resolved to.
  if (sel.value !== state.settings.inputDeviceId) {
    const opt = sel.selectedOptions[0];
    saveSettings({
      inputDeviceId: sel.value,
      inputDeviceLabel: (opt && opt.dataset.label) || ''
    });
  }

  const real = devices.filter((d) => d.deviceId && d.deviceId !== 'default').length;
  const unlabelled = devices.length > 0 && devices.every((d) => !d.label);
  $('#micStatus').textContent = !devices.length
    ? 'No microphone detected. Plug one in, then hit Refresh.'
    : unlabelled
      ? 'Microphone access has not been granted yet — device names are hidden until it is.'
      : `${real} input${real === 1 ? '' : 's'} available.`;

  if (!survived && state.settings.inputDeviceLabel) {
    toast(`“${state.settings.inputDeviceLabel}” is not connected — using the system default.`, 'warn');
  }
  paintActiveMic();
}

function paintActiveMic() {
  const box = $('#activeMic');
  const m = state.activeMic;
  if (!m) {
    box.className = 'active-mic';
    box.textContent = '';
    return;
  }
  if (m.error) {
    box.className = 'active-mic bad';
    box.textContent = m.error;
    return;
  }
  box.className = 'active-mic';
  box.textContent = m.label ? `Currently listening through: ${m.label}` : '';
}

/* ---------------------------------------------------------- mic meter */

let monitorOn = false;
let peak = 0;
let peakTimer = null;
let silenceTimer = null;

async function setMonitoring(on) {
  if (on === monitorOn) return;
  monitorOn = on;
  await api.mic.monitor(on);
  if (!on) {
    $('#meterFill').style.width = '0%';
    $('#obMeterFill').style.width = '0%';
    $('#meterFloor').classList.remove('on');
    clearTimeout(silenceTimer);
    if (peakTimer) {
      clearInterval(peakTimer);
      peakTimer = null;
    }
    return;
  }
  const caption = $('#meterCaption');
  caption.className = 'meter-caption';
  caption.textContent = 'Say something — the bar should move.';
  peak = 0;
  peakTimer = setInterval(() => {
    peak = Math.max(0, peak - 0.04); // slow peak-hold decay
    const floor = $('#meterFloor');
    floor.style.left = `${(peak * 100).toFixed(1)}%`;
    floor.classList.toggle('on', peak > 0.02);
  }, 90);
}

function onMicLevel(level) {
  if (!monitorOn) return;
  const v = Math.max(0, Math.min(1, Number(level) || 0));
  const width = `${(v * 100).toFixed(1)}%`;

  // Settings meter and the onboarding meter share one level stream.
  $('#meterFill').style.width = width;
  $('#obMeterFill').style.width = width;
  if (v > peak) peak = v;

  if (v <= 0.06) return;
  const captions = [$('#meterCaption'), $('#obMeterCaption')];
  captions.forEach((c) => {
    c.className = 'meter-caption live';
    c.textContent = 'Hearing you — this is the mic Cadence will use.';
  });
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    captions.forEach((c) => {
      c.className = 'meter-caption';
      c.textContent = 'Say something — the bar should move.';
    });
  }, 2500);
}

/* ------------------------------------------------------ hotkey capture */

let capturing = false;
function captureHotkey() {
  const btn = $('#btnCapture');
  const input = $('#setAccelerator');
  if (capturing) return;
  capturing = true;
  btn.textContent = 'Press keys…';
  input.value = '';

  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');

    const raw = e.key;
    const isModifier = ['Control', 'Alt', 'Shift', 'Meta'].includes(raw);
    if (isModifier) return; // wait for a real key

    let key = raw;
    if (raw === ' ') key = 'Space';
    else if (raw === 'Escape') {
      finish(null);
      return;
    } else if (/^[a-z]$/.test(raw)) key = raw.toUpperCase();
    else if (/^F\d{1,2}$/.test(raw)) key = raw;
    else if (raw.length > 1) key = raw;

    if (!mods.length) {
      // A bare key would swallow it globally; require at least one modifier.
      return;
    }
    finish([...mods, key].join('+'));
  };

  const finish = (accel) => {
    capturing = false;
    window.removeEventListener('keydown', onKey, true);
    btn.textContent = 'Record keys';
    if (accel) {
      input.value = accel;
      saveSettings({ hotkeyAccelerator: accel });
    } else {
      input.value = state.settings.hotkeyAccelerator;
    }
  };

  window.addEventListener('keydown', onKey, true);
}

/* ---------------------------------------------------------- onboarding */

const ob = { step: 0, max: 3 };

function paintOnboarding() {
  $('#obSteps').textContent = '';
  for (let i = 0; i <= ob.max; i += 1) {
    const bar = document.createElement('i');
    if (i <= ob.step) bar.className = 'on';
    $('#obSteps').appendChild(bar);
  }
  $$('.ob-body').forEach((b) => {
    b.hidden = Number(b.dataset.step) !== ob.step;
  });
  $('#obBack').style.visibility = ob.step === 0 ? 'hidden' : 'visible';
  $('#obNext').textContent = ob.step === ob.max ? 'Start dictating' : 'Continue';
  $('#obHotkey').textContent = hotkeyDisplay();
  $('#obHotkeyNote').textContent =
    state.hotkey.tier === 'hold-fallback'
      ? 'Tip: the native keyboard hook is not installed, so release is detected a moment late. Switching to toggle mode in Settings makes it exact.'
      : '';
  // The meter only runs on the microphone step.
  setMonitoring(ob.step === 2);
}

async function onboardingNext() {
  if (ob.step === 2) {
    const sel = $('#obDevice');
    const opt = sel.selectedOptions[0];
    if (sel.value) {
      await saveSettings({
        inputDeviceId: sel.value,
        inputDeviceLabel: (opt && opt.dataset.label) || ''
      });
    }
  }
  if (ob.step >= ob.max) {
    await api.app.finishOnboarding();
    $('#onboarding').hidden = true;
    toast('You are set up. Hold your hotkey and say something.', 'ok', 5000);
    return;
  }
  ob.step += 1;
  if (ob.step === 2) await fillOnboardingDevices();
  paintOnboarding();
}

async function fillOnboardingDevices() {
  const res = await api.mic.check();
  state.devices = res.devices || [];
  fillDeviceSelect(
    $('#obDevice'),
    state.devices,
    state.settings.inputDeviceId,
    state.settings.inputDeviceLabel
  );
  const box = $('#obMicResult');
  box.className = res.ok ? 'field-error ok' : 'field-error';
  box.textContent = res.ok ? 'Microphone ready.' : res.hint || 'Microphone not available.';
}

function wireOnboarding() {
  $('#obNext').addEventListener('click', onboardingNext);
  $('#obBack').addEventListener('click', () => {
    ob.step = Math.max(0, ob.step - 1);
    paintOnboarding();
  });
  $('#obSkip').addEventListener('click', async () => {
    setMonitoring(false);
    await api.app.finishOnboarding();
    $('#onboarding').hidden = true;
  });

  // Switching mic mid-setup should move the meter immediately.
  $('#obDevice').addEventListener('change', async () => {
    const sel = $('#obDevice');
    const opt = sel.selectedOptions[0];
    await saveSettings({
      inputDeviceId: sel.value,
      inputDeviceLabel: (opt && opt.dataset.label) || ''
    });
    await api.mic.monitor(true); // re-point the monitor at the new device
  });

  $('#obProvider').addEventListener('change', () => {
    const p = $('#obProvider').value;
    $('#obKeyNote').textContent =
      p === 'anthropic'
        ? 'Claude cannot transcribe audio, so you will also need an OpenAI or Gemini key for the speech step. Add it later in Settings.'
        : '';
  });

  $('#obTest').addEventListener('click', async () => {
    const provider = $('#obProvider').value;
    const key = $('#obKey').value.trim();
    const out = $('#obKeyResult');
    if (!key) {
      out.className = 'field-error';
      out.textContent = 'Paste a key first.';
      return;
    }
    out.className = 'field-error';
    out.textContent = 'Saving and testing…';
    const saved = await api.keys.set(provider, key);
    if (!saved.ok) {
      out.textContent = saved.error || 'Could not save the key.';
      return;
    }
    const test = await api.keys.test(provider);
    out.className = `field-error${test.ok ? ' ok' : ''}`;
    out.textContent = test.ok ? test.detail || 'Key works.' : test.error;
    if (test.ok) {
      $('#obKey').value = '';
      const patch = {};
      if (provider !== 'anthropic') {
        patch.transcriptionProvider = provider;
        patch.transcriptionModel =
          provider === 'openai' ? 'gpt-4o-transcribe' : 'gemini-2.0-flash';
      }
      patch.cleanupProvider = provider;
      patch.cleanupModel =
        provider === 'openai'
          ? 'gpt-4o-mini'
          : provider === 'anthropic'
            ? 'claude-haiku-4-5-20251001'
            : 'gemini-2.0-flash';
      await saveSettings(patch);
      await refreshKeys();
    }
  });
}

/* -------------------------------------------------------------- render */

function render() {
  paintSettingInputs();
  paintModelLists();
  paintKeyRows();
  paintHotkeyPanel();
  paintActiveMic();
  renderHome();
  renderRecent();
}

/* ---------------------------------------------------------------- boot */

function wire() {
  $$('.nav').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $$('[data-goto]').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.goto))
  );

  $('#btnDictate').addEventListener('click', () => api.app.dictate());
  $('#btnCapture').addEventListener('click', captureHotkey);
  $('#btnRefreshMics').addEventListener('click', () => refreshDevices());
  $('#btnDataDir').addEventListener('click', () => api.app.openDataDir());

  // The mic select carries both id and label, so it is bound by hand rather
  // than through the generic data-setting path.
  $('#setDevice').addEventListener('change', async () => {
    const sel = $('#setDevice');
    const opt = sel.selectedOptions[0];
    await saveSettings({
      inputDeviceId: sel.value,
      inputDeviceLabel: (opt && opt.dataset.label) || ''
    });
    if (monitorOn) await api.mic.monitor(true); // re-point the meter
  });

  let searchTimer = null;
  $('#historySearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadHistory, 160);
  });

  $('#btnClearHistory').addEventListener('click', async () => {
    state.history = await api.history.clear();
    paintHistory();
    renderRecent();
    toast('History cleared.');
  });

  $('#btnResetStats').addEventListener('click', async () => {
    state.stats = await api.stats.reset();
    paintStats();
    toast('Stats reset.');
  });

  $('#dictForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const heard = $('#dictHeard').value;
    const write = $('#dictWrite').value;
    const res = await api.dictionary.add({ heard, write });
    const err = $('#dictError');
    if (!res.ok) {
      err.textContent = res.error;
      return;
    }
    err.textContent = '';
    $('#dictHeard').value = '';
    $('#dictWrite').value = '';
    state.dictionary = res.terms;
    paintDictionary();
  });

  bindSettingInputs();
  wireOnboarding();

  api.settings.onChanged((next) => {
    state.settings = next;
    paintSettingInputs();
    paintHotkeyPanel();
    renderHome();
  });

  api.history.onChanged(() => {
    renderRecent();
    if (state.view === 'history') loadHistory();
  });

  api.stats.onChanged(() => {
    if (state.view === 'stats') loadStats();
  });

  api.mic.onLevel(onMicLevel);

  api.mic.onChanged((devices) => {
    state.devices = devices || [];
    if (state.view === 'settings') refreshDevices(state.devices);
  });

  api.mic.onActive((m) => {
    state.activeMic = m;
    paintActiveMic();
  });

  api.onGoto((p) => {
    const target = { view: (p && p.view) || 'settings', anchor: p && p.anchor };
    // A deep link can arrive before bootstrap resolves; hold it so boot()
    // doesn't stomp it with the default view.
    if (!booted) {
      pendingGoto = target;
      return;
    }
    switchView(target.view, target.anchor);
  });

  // Don't hold a live meter open behind another window.
  window.addEventListener('blur', () => setMonitoring(false));
  window.addEventListener('focus', () => {
    if (state.view === 'settings') setMonitoring(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setMonitoring(false);
    else if (state.view === 'settings' && document.hasFocus()) setMonitoring(true);
  });

  api.onToast((t) => {
    if (t && t.text) toast(t.text, t.level === 'error' ? 'error' : t.level === 'warn' ? 'warn' : 'ok');
  });

  api.onSessionState((s) => {
    const labels = {
      listening: 'Listening…',
      transcribing: 'Transcribing…',
      polishing: 'Polishing…',
      inserting: 'Inserting…',
      done: 'Inserted',
      error: 'Error',
      cancelled: 'Cancelled',
      idle: ''
    };
    $('#titleStatus').textContent = labels[s.state] || '';
  });
}

let booted = false;
let pendingGoto = null;

async function boot() {
  wire();
  const snap = await api.bootstrap();
  applySnapshot(snap);
  booted = true;

  if (pendingGoto) {
    switchView(pendingGoto.view, pendingGoto.anchor);
    pendingGoto = null;
  } else {
    switchView('home');
  }

  if (!state.settings.onboarded) {
    $('#onboarding').hidden = false;
    paintOnboarding();
    // Onboarding covers the screen; no point metering behind it.
    setMonitoring(false);
  }
}

boot();

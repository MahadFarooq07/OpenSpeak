'use strict';

const pill = document.getElementById('pill');
const canvas = document.getElementById('wave');
const label = document.getElementById('label');
const time = document.getElementById('time');

const ctx = canvas.getContext('2d');

/* ------------------------------------------------------------- waveform */

/**
 * Three stacked sine waves at different frequencies, drifting against each
 * other. Amplitude follows the real microphone level, but never drops to zero
 * while listening — a dead flat line reads as "broken", and the whole point of
 * this thing is to reassure you that your voice is being picked up.
 */
const WAVES = [
  { freq: 1.7, drift: 1.0, scale: 1.0, alpha: 1.0, width: 1.7 },
  { freq: 2.9, drift: -0.68, scale: 0.6, alpha: 0.5, width: 1.4 },
  { freq: 4.3, drift: 1.45, scale: 0.34, alpha: 0.28, width: 1.2 }
];

const IDLE_FLOOR = 0.07; // gentle breathing when the room is silent
const THINKING_AMP = 0.22; // low travelling wave while the API is working

let cssW = 108;
let cssH = 20;
let phase = 0;
let amp = 0;
let target = 0;
let raf = null;
let running = false;
let colour = '#4f9ef1';

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  cssW = rect.width || 108;
  cssH = rect.height || 20;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw() {
  const mid = cssH / 2;
  const max = mid - 1.5;
  ctx.clearRect(0, 0, cssW, cssH);

  for (const wave of WAVES) {
    ctx.beginPath();
    for (let x = 0; x <= cssW; x += 1) {
      const t = x / cssW;
      // Taper toward both ends so the wave sits inside the capsule rather
      // than being clipped by it.
      const envelope = Math.pow(Math.sin(Math.PI * t), 1.3);
      const y =
        mid +
        Math.sin(t * Math.PI * 2 * wave.freq + phase * wave.drift) *
          max *
          amp *
          wave.scale *
          envelope;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = wave.alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = wave.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function frame() {
  // Rise fast so a syllable registers immediately, fall slowly so the wave
  // doesn't strobe between words.
  const k = target > amp ? 0.35 : 0.12;
  amp += (target - amp) * k;
  phase += 0.085;
  draw();
  raf = requestAnimationFrame(frame);
}

function startWave() {
  if (running) return;
  running = true;
  sizeCanvas();
  raf = requestAnimationFrame(frame);
}

function stopWave() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  amp = 0;
  target = 0;
  ctx.clearRect(0, 0, cssW, cssH);
}

/* --------------------------------------------------------------- sound */

let audio = null;
let soundsEnabled = true;

function beep(freq, ms, gain = 0.04) {
  if (!soundsEnabled) return;
  try {
    audio = audio || new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const amplifier = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    amplifier.gain.setValueAtTime(0, audio.currentTime);
    amplifier.gain.linearRampToValueAtTime(gain, audio.currentTime + 0.012);
    amplifier.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
    osc.connect(amplifier).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + ms / 1000 + 0.02);
  } catch (_) {
    /* audio is a nicety, never a failure */
  }
}

/* --------------------------------------------------------------- timer */

let timerHandle = null;
let startedAt = 0;

function startTimer() {
  stopTimer();
  startedAt = Date.now();
  time.textContent = '0:00';
  timerHandle = setInterval(() => {
    const total = Math.floor((Date.now() - startedAt) / 1000);
    time.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }, 500);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

/* --------------------------------------------------------------- state */

let current = 'idle';

function apply(payload) {
  const state = (payload && payload.state) || 'idle';
  if (payload && typeof payload.sounds === 'boolean') soundsEnabled = payload.sounds;

  current = state;
  pill.className = `pill state-${state}`;

  if (state === 'listening') {
    label.textContent = '';
    colour = '#4f9ef1';
    target = IDLE_FLOOR;
    startWave();
    startTimer();
    beep(660, 80, 0.035);
    return;
  }

  stopTimer();
  time.textContent = '';

  if (state === 'transcribing' || state === 'polishing' || state === 'inserting') {
    label.textContent = '';
    colour = '#3d7fc4';
    target = THINKING_AMP;
    startWave();
    return;
  }

  stopWave();

  if (state === 'done') {
    label.textContent = payload && payload.words ? `${payload.words} words` : 'Done';
    beep(880, 95, 0.04);
    return;
  }

  if (state === 'error') {
    label.textContent = (payload && payload.message) || 'Something went wrong';
    beep(220, 160, 0.045);
    return;
  }

  if (state === 'cancelled') {
    label.textContent = 'Cancelled';
    beep(320, 80, 0.03);
    return;
  }

  // Idle: a dim dot and nothing else. Only ever visible if the user asked for
  // a permanent pill; otherwise the window is hidden outright.
  label.textContent = '';
}

function onLevel(value) {
  if (current !== 'listening') return;
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  // Bias the curve upward: normal speech should fill most of the capsule,
  // not creep along the bottom.
  target = Math.max(IDLE_FLOOR, Math.pow(v, 0.72));
}

window.pill.onState(apply);
window.pill.onLevel(onLevel);
window.addEventListener('resize', () => {
  if (running) sizeCanvas();
});

pill.addEventListener('click', () => {
  if (current === 'listening') window.pill.cancel();
  else if (current === 'idle') window.pill.openHub();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pill.cancel();
});

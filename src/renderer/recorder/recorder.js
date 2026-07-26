'use strict';

/**
 * Hidden window that owns the microphone.
 *
 * The stream is acquired once at startup and kept warm for the app's lifetime —
 * getUserMedia costs 200-400ms, and paying that on every keypress would be felt.
 *
 * Capture is raw PCM encoded to 16 kHz mono WAV rather than MediaRecorder's
 * WebM/Opus. WebM is the only container Chromium's MediaRecorder reliably
 * produces, and Gemini's audio input does not accept it — WAV is understood by
 * every provider, needs no dependency to write, and at 32 kB/s is a non-issue
 * for utterances measured in seconds.
 */

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 4096;
const MAX_SECONDS = 600; // hard memory ceiling regardless of settings

let stream = null;
let audioCtx = null;
let sourceNode = null;
let processor = null;
let sink = null;
let warming = null;

let capturing = false;
let monitoring = false;
let chunks = [];
let sampleCount = 0;
let startedAt = 0;
let activeDeviceId = 'default';
let activeDeviceLabel = '';
let wantedDeviceLabel = '';
let lastMicError = '';
let levelAccum = 0;
let levelFrames = 0;

/* ------------------------------------------------------------- capture */

function constraintsFor(deviceId) {
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1
  };
  if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

function micError(err) {
  const name = err && err.name ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow it in Windows Settings → Privacy & security → Microphone.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Plug one in, then pick it in Settings.';
  }
  if (name === 'NotReadableError') {
    return 'The microphone is in use by another app and could not be opened.';
  }
  return `Microphone error: ${err && err.message ? err.message : name || 'unknown'}`;
}

/**
 * Windows issues a brand new deviceId every time a USB mic is re-plugged, so a
 * saved id goes stale constantly. If the id is gone but a device with the same
 * label is present, use that — otherwise the user's choice silently reverts to
 * the default mic every time they unplug their headset.
 */
async function resolveDevice(deviceId, label) {
  if (!deviceId || deviceId === 'default') return 'default';
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter((d) => d.kind === 'audioinput');
    if (mics.some((d) => d.deviceId === deviceId)) return deviceId;
    if (label) {
      const byLabel = mics.find((d) => d.label && d.label === label);
      if (byLabel) return byLabel.deviceId;
    }
  } catch (_) {
    /* fall through and let getUserMedia decide */
  }
  return deviceId;
}

/** Serialised so a start() racing the boot-time warm cannot double-acquire. */
function warm(deviceId, label) {
  if (typeof label === 'string') wantedDeviceLabel = label;
  const wanted = deviceId || activeDeviceId || 'default';
  if (warming) return warming; // an acquisition is already in flight
  if (stream && wanted === activeDeviceId) return Promise.resolve(true);
  warming = doWarm(wanted).finally(() => {
    warming = null;
  });
  return warming;
}

async function doWarm(requested) {
  teardown();
  const wanted = await resolveDevice(requested, wantedDeviceLabel);
  activeDeviceId = wanted;

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraintsFor(wanted));
  } catch (err) {
    // A specific device may have vanished; fall back to the default mic once.
    if (wanted !== 'default') {
      activeDeviceId = 'default';
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraintsFor('default'));
      } catch (err2) {
        lastMicError = micError(err2);
        window.rec.ready({ error: lastMicError });
        return false;
      }
    } else {
      lastMicError = micError(err);
      window.rec.ready({ error: lastMicError });
      return false;
    }
  }

  // Whatever we ended up with, report its real name back to the UI.
  const track = stream.getAudioTracks()[0];
  activeDeviceLabel = (track && track.label) || '';
  const settings = track && track.getSettings ? track.getSettings() : null;
  if (settings && settings.deviceId) activeDeviceId = settings.deviceId;

  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    sourceNode = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(FRAME_SIZE, 1, 1);
    processor.onaudioprocess = onFrame;

    // A ScriptProcessor only runs while connected to the graph's destination,
    // so route it through a muted gain node rather than the speakers.
    sink = audioCtx.createGain();
    sink.gain.value = 0;
    sourceNode.connect(processor);
    processor.connect(sink);
    sink.connect(audioCtx.destination);
  } catch (err) {
    lastMicError = `Audio pipeline failed: ${err.message}`;
    window.rec.ready({ error: lastMicError });
    return false;
  }

  lastMicError = '';
  window.rec.ready({
    ok: true,
    sampleRate: audioCtx.sampleRate,
    deviceId: activeDeviceId,
    label: activeDeviceLabel,
    fellBack: requested !== 'default' && activeDeviceId === 'default'
  });
  return true;
}

function onFrame(e) {
  const input = e.inputBuffer.getChannelData(0);

  // Level metering runs whether or not we're recording, so the pill can show
  // movement the instant a dictation starts.
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
  const rms = Math.sqrt(sum / input.length);
  levelAccum = Math.max(levelAccum, rms);
  levelFrames += 1;
  if (levelFrames >= 2) {
    // Perceptual-ish curve: quiet speech still moves the bars, loud doesn't peg them.
    const level = Math.max(0, Math.min(1, Math.log10(1 + levelAccum * 22) / 1.15));
    if (capturing || monitoring) window.rec.level(level);
    levelAccum = 0;
    levelFrames = 0;
  }

  if (!capturing) return;
  if (sampleCount >= SAMPLE_RATE * MAX_SECONDS) return;
  chunks.push(new Float32Array(input)); // must copy: the buffer is recycled
  sampleCount += input.length;
}

function teardown() {
  capturing = false;
  chunks = [];
  sampleCount = 0;
  try {
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    if (sourceNode) sourceNode.disconnect();
    if (sink) sink.disconnect();
  } catch (_) {
    /* ignore */
  }
  processor = null;
  sourceNode = null;
  sink = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

/* -------------------------------------------------------- wav encoding */

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function encodeWav(frames, total, sampleRate) {
  const bytes = total * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, bytes, true);

  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1) {
      const s = Math.max(-1, Math.min(1, frame[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/* ------------------------------------------------------------ commands */

async function start(payload) {
  const ok = await warm(payload && payload.deviceId);
  if (!ok || !stream) {
    window.rec.error(lastMicError || 'The microphone could not be opened.');
    return;
  }
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch (_) {
      /* ignore */
    }
  }
  chunks = [];
  sampleCount = 0;
  startedAt = Date.now();
  capturing = true;
}

function stop() {
  if (!capturing) {
    window.rec.error('There was no active recording to stop.');
    return;
  }
  capturing = false;
  const rate = audioCtx ? audioCtx.sampleRate : SAMPLE_RATE;
  const durationMs = Math.max(Date.now() - startedAt, Math.round((sampleCount / rate) * 1000));

  if (!sampleCount) {
    window.rec.error('No audio was captured — check that the right microphone is selected.');
    chunks = [];
    return;
  }

  try {
    const wav = encodeWav(chunks, sampleCount, rate);
    window.rec.data({ buffer: wav, mimeType: 'audio/wav', durationMs });
  } catch (err) {
    window.rec.error(`Could not encode the recording: ${err.message}`);
  }
  chunks = [];
  sampleCount = 0;
}

function cancel() {
  capturing = false;
  chunks = [];
  sampleCount = 0;
}

/**
 * Level metering outside a dictation, so the Settings panel can show a live
 * meter and you can confirm the selected mic is the one actually hearing you.
 */
async function monitor(payload) {
  const on = !!(payload && payload.on);
  if (on) {
    const ok = await warm(payload.deviceId, payload.label);
    if (!ok) {
      window.rec.error(lastMicError || 'The microphone could not be opened.');
      return;
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch (_) {
        /* ignore */
      }
    }
  }
  monitoring = on;
}

async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || '' }));
    window.rec.devices(mics);
  } catch (_) {
    window.rec.devices([]);
  }
}

window.rec.onWarm((p) => warm(p && p.deviceId, p && p.label));
window.rec.onStart((p) => start(p));
window.rec.onStop(() => stop());
window.rec.onCancel(() => cancel());
window.rec.onListDevices(() => listDevices());
window.rec.onMonitor((p) => monitor(p));

warm('default');

// Hot-plugging a headset changes the device list and can invalidate the one we
// hold, so re-publish the list and re-resolve the user's choice.
navigator.mediaDevices.addEventListener('devicechange', async () => {
  await listDevices();
  if (activeDeviceId !== 'default' || wantedDeviceLabel) {
    const resolved = await resolveDevice(activeDeviceId, wantedDeviceLabel);
    if (resolved !== activeDeviceId) await warm(resolved, wantedDeviceLabel);
  }
});

'use strict';

const { request, ProviderError, trimBase } = require('./http');
const { systemPrompt, userPrompt } = require('./prompt');

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const NAME = 'Gemini';

function base(settings) {
  return trimBase(settings.geminiBaseUrl, DEFAULT_BASE);
}

function textOf(body) {
  const cand = body && Array.isArray(body.candidates) ? body.candidates[0] : null;
  const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

async function generate({ settings, apiKey, model, system, parts, timeoutMs }) {
  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };

  const body = await request(
    `${base(settings)}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload)
    },
    { provider: NAME, timeoutMs: timeoutMs || 45000 }
  );
  return textOf(body);
}

async function transcribe(audio, ctx) {
  const { settings, apiKey, bias, mimeType } = ctx;
  if (!apiKey) throw new ProviderError('No Gemini API key set. Add one in Settings.', { provider: NAME });

  const instruction = [
    'Transcribe the speech in this audio verbatim.',
    'Return only the transcript text — no labels, timestamps, speaker tags or commentary.',
    'If there is no intelligible speech, return an empty response.'
  ];
  if (bias) instruction.push(`These proper nouns or terms may appear, spell them this way: ${bias}.`);
  if (settings.language && settings.language !== 'auto') {
    instruction.push(`The speaker is using ${settings.language}.`);
  }

  return generate({
    settings,
    apiKey,
    model: settings.transcriptionModel || 'gemini-2.0-flash',
    system: null,
    parts: [
      { text: instruction.join(' ') },
      { inlineData: { mimeType: mimeType || 'audio/wav', data: audio.toString('base64') } }
    ],
    timeoutMs: 90000
  });
}

async function clean(raw, ctx) {
  const { settings, apiKey, dictionary, mode } = ctx;
  if (!apiKey) throw new ProviderError('No Gemini API key set. Add one in Settings.', { provider: NAME });

  return generate({
    settings,
    apiKey,
    model: settings.cleanupModel || 'gemini-2.0-flash',
    system: systemPrompt({ mode, dictionary, language: settings.language }),
    parts: [{ text: userPrompt(raw) }]
  });
}

async function test({ settings, apiKey }) {
  if (!apiKey) return { ok: false, error: 'No API key entered.' };
  try {
    const body = await request(
      `${base(settings)}/models`,
      { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
      { provider: NAME, timeoutMs: 15000 }
    );
    const n = Array.isArray(body.models) ? body.models.length : 0;
    return { ok: true, detail: n ? `Key works. ${n} models available.` : 'Key works.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { transcribe, clean, test, NAME, DEFAULT_BASE };

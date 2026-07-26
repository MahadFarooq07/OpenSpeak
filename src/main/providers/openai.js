'use strict';

const { request, ProviderError, trimBase } = require('./http');
const { systemPrompt, userPrompt } = require('./prompt');

const DEFAULT_BASE = 'https://api.openai.com/v1';
const NAME = 'OpenAI';

function base(settings) {
  return trimBase(settings.openaiBaseUrl, DEFAULT_BASE);
}

function headers(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * @param {Buffer} audio
 * @param {{mimeType:string, settings:object, apiKey:string, bias:string}} ctx
 * @returns {Promise<string>}
 */
async function transcribe(audio, ctx) {
  const { settings, apiKey, bias, mimeType } = ctx;
  if (!apiKey) throw new ProviderError('No OpenAI API key set. Add one in Settings.', { provider: NAME });

  const type = mimeType || 'audio/wav';
  const ext = type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : 'wav';
  const form = new FormData();
  form.append('file', new Blob([audio], { type }), `speech.${ext}`);
  form.append('model', settings.transcriptionModel || 'gpt-4o-transcribe');
  form.append('response_format', 'json');
  if (settings.language && settings.language !== 'auto') {
    form.append('language', settings.language);
  }
  if (bias) {
    form.append('prompt', `Proper nouns and terms that may appear: ${bias}.`);
  }

  const body = await request(
    `${base(settings)}/audio/transcriptions`,
    { method: 'POST', headers: headers(apiKey), body: form },
    { provider: NAME, timeoutMs: 90000 }
  );

  return String(body.text || '').trim();
}

/**
 * @param {string} raw
 * @param {{settings:object, apiKey:string, dictionary:string, mode:string}} ctx
 */
async function clean(raw, ctx) {
  const { settings, apiKey, dictionary, mode } = ctx;
  if (!apiKey) throw new ProviderError('No OpenAI API key set. Add one in Settings.', { provider: NAME });

  const body = await request(
    `${base(settings)}/chat/completions`,
    {
      method: 'POST',
      headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.cleanupModel || 'gpt-4o-mini',
        temperature: 0.1,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemPrompt({ mode, dictionary, language: settings.language }) },
          { role: 'user', content: userPrompt(raw) }
        ]
      })
    },
    { provider: NAME, timeoutMs: 45000 }
  );

  const choice = body.choices && body.choices[0];
  return String((choice && choice.message && choice.message.content) || '').trim();
}

/** Cheap round-trip used by the "Test" button in Settings. */
async function test({ settings, apiKey }) {
  if (!apiKey) return { ok: false, error: 'No API key entered.' };
  try {
    const body = await request(
      `${base(settings)}/models`,
      { method: 'GET', headers: headers(apiKey) },
      { provider: NAME, timeoutMs: 15000 }
    );
    const n = Array.isArray(body.data) ? body.data.length : 0;
    return { ok: true, detail: n ? `Key works. ${n} models available.` : 'Key works.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { transcribe, clean, test, NAME, DEFAULT_BASE };

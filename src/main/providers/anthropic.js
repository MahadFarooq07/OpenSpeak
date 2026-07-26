'use strict';

const { request, ProviderError, trimBase } = require('./http');
const { systemPrompt, userPrompt } = require('./prompt');

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const NAME = 'Anthropic';

function base(settings) {
  return trimBase(settings.anthropicBaseUrl, DEFAULT_BASE);
}

function headers(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json'
  };
}

/** Anthropic ships no speech-to-text endpoint. */
async function transcribe() {
  throw new ProviderError(
    'Claude cannot transcribe audio. Pick OpenAI or Gemini as the transcription provider — Claude can still do the cleanup.',
    { provider: NAME }
  );
}

async function clean(raw, ctx) {
  const { settings, apiKey, dictionary, mode } = ctx;
  if (!apiKey) {
    throw new ProviderError('No Anthropic API key set. Add one in Settings.', { provider: NAME });
  }

  const body = await request(
    `${base(settings)}/messages`,
    {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model: settings.cleanupModel || 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        temperature: 0.1,
        system: systemPrompt({ mode, dictionary, language: settings.language }),
        messages: [{ role: 'user', content: userPrompt(raw) }]
      })
    },
    { provider: NAME, timeoutMs: 45000 }
  );

  const parts = Array.isArray(body.content) ? body.content : [];
  return parts
    .filter((p) => p && p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
}

async function test({ settings, apiKey }) {
  if (!apiKey) return { ok: false, error: 'No API key entered.' };
  try {
    await request(
      `${base(settings)}/messages`,
      {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({
          model: settings.cleanupModel || 'claude-haiku-4-5-20251001',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
        })
      },
      { provider: NAME, timeoutMs: 20000 }
    );
    return { ok: true, detail: 'Key works.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { transcribe, clean, test, NAME, DEFAULT_BASE };

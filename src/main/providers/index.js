'use strict';

const openai = require('./openai');
const anthropic = require('./anthropic');
const gemini = require('./gemini');
const guards = require('./guards');
const { ProviderError } = require('./http');
const { getSettings, getSecrets } = require('../store');
const dictionary = require('../dictionary');

const REGISTRY = { openai, anthropic, gemini };

function keyName(provider) {
  return `${provider}ApiKey`;
}

function providerFor(id) {
  const p = REGISTRY[id];
  if (!p) throw new ProviderError(`Unknown provider "${id}".`);
  return p;
}

function keyFor(id) {
  return getSecrets().get(keyName(id));
}

/** Which providers currently have a usable key. */
function keyStatus() {
  const secrets = getSecrets();
  const out = {};
  for (const id of Object.keys(REGISTRY)) {
    out[id] = secrets.hint(keyName(id));
  }
  out.encryptionAvailable = secrets.available();
  return out;
}

/**
 * @param {Buffer} audio
 * @param {string} mimeType
 * @returns {Promise<{text:string, provider:string, model:string}>}
 */
async function transcribe(audio, mimeType) {
  const settings = getSettings().all();
  const id = settings.transcriptionProvider;
  const provider = providerFor(id);
  const text = await provider.transcribe(audio, {
    settings,
    apiKey: keyFor(id),
    bias: dictionary.biasPrompt(),
    mimeType
  });
  return { text: String(text || '').trim(), provider: id, model: settings.transcriptionModel };
}

/**
 * Runs the cleanup stage and the sanity gates.
 * @returns {Promise<{text:string, cleaned:boolean, reason:string, provider:string, model:string}>}
 */
async function polish(raw, modeOverride) {
  const settings = getSettings().all();
  const mode = modeOverride || settings.mode || 'auto';

  if (!settings.cleanupEnabled || mode === 'raw') {
    return { text: raw, cleaned: false, reason: 'cleanup disabled', provider: '', model: '' };
  }

  const id = settings.cleanupProvider;
  const provider = providerFor(id);

  let polished = '';
  try {
    polished = await provider.clean(raw, {
      settings,
      apiKey: keyFor(id),
      dictionary: dictionary.promptFragment(),
      mode
    });
  } catch (err) {
    // Cleanup is a nicety; never lose the user's words over it.
    return {
      text: raw,
      cleaned: false,
      reason: err.message || 'cleanup failed',
      provider: id,
      model: settings.cleanupModel
    };
  }

  const verdict = guards.evaluate(raw, polished);
  return {
    text: verdict.text,
    cleaned: verdict.ok,
    reason: verdict.reason,
    provider: id,
    model: settings.cleanupModel
  };
}

async function test(id, apiKeyOverride) {
  const settings = getSettings().all();
  const provider = providerFor(id);
  const apiKey = apiKeyOverride || keyFor(id);
  return provider.test({ settings, apiKey });
}

/** Warns about combinations that cannot work, for the Settings UI. */
function validate(settings) {
  const problems = [];
  const s = settings || getSettings().all();
  const secrets = getSecrets();

  if (s.transcriptionProvider === 'anthropic') {
    problems.push({
      level: 'error',
      text: 'Claude has no speech-to-text API. Choose OpenAI or Gemini for transcription.'
    });
  }
  if (!secrets.get(keyName(s.transcriptionProvider))) {
    problems.push({
      level: 'error',
      text: `Add an API key for ${s.transcriptionProvider} — transcription cannot run without it.`
    });
  }
  if (s.cleanupEnabled && s.mode !== 'raw' && !secrets.get(keyName(s.cleanupProvider))) {
    problems.push({
      level: 'warn',
      text: `No key for ${s.cleanupProvider}; dictations will be inserted as raw transcripts.`
    });
  }
  if (!secrets.available()) {
    problems.push({
      level: 'error',
      text: 'Windows encryption is unavailable, so API keys cannot be stored securely.'
    });
  }
  return problems;
}

module.exports = { transcribe, polish, test, keyStatus, keyName, validate, REGISTRY, ProviderError };

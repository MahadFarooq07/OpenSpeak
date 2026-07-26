'use strict';

/** Formatting modes drive the cleanup system prompt. */
const MODES = [
  {
    id: 'auto',
    label: 'Auto',
    blurb: 'Reads the tone of what you said and matches it.'
  },
  {
    id: 'email',
    label: 'Email',
    blurb: 'Complete sentences, paragraph breaks, professional register.'
  },
  {
    id: 'message',
    label: 'Message',
    blurb: 'Short and casual. Chat, Slack, DMs. No sign-offs.'
  },
  {
    id: 'notes',
    label: 'Notes',
    blurb: 'Terse bullet points. Strips connective filler aggressively.'
  },
  {
    id: 'prompt',
    label: 'Prompt',
    blurb: 'Structured instructions for an AI assistant. Keeps every constraint.'
  },
  {
    id: 'code',
    label: 'Code comment',
    blurb: 'Technical phrasing, identifiers kept verbatim, no prose padding.'
  },
  {
    id: 'raw',
    label: 'Raw',
    blurb: 'No cleanup at all. Straight transcript, punctuation as heard.'
  }
];

/** Model catalogue shown in Settings. Users may type any other model id. */
const MODELS = {
  transcription: {
    openai: [
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe — best accuracy' },
      { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe — faster, cheaper' },
      { id: 'whisper-1', label: 'whisper-1 — classic Whisper' }
    ],
    gemini: [
      { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash — fast' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' }
    ]
  },
  cleanup: {
    openai: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini — fast, cheap, plenty good' },
      { id: 'gpt-4o', label: 'gpt-4o' },
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' }
    ],
    anthropic: [
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fast' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 — sharpest' }
    ],
    gemini: [
      { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash — fast' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' }
    ]
  }
};

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini'
};

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  onboarded: false,

  // providers
  transcriptionProvider: 'openai', // openai | gemini
  transcriptionModel: 'gpt-4o-transcribe',
  cleanupEnabled: true,
  cleanupProvider: 'openai', // openai | anthropic | gemini
  cleanupModel: 'gpt-4o-mini',
  openaiBaseUrl: 'https://api.openai.com/v1',
  anthropicBaseUrl: 'https://api.anthropic.com/v1',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  language: 'auto',

  // behaviour
  mode: 'auto',
  hotkeyMode: 'hold', // hold | toggle
  hotkeyAccelerator: 'Control+Shift+Space',
  hotkeyRawKey: 'RightControl', // used only when uiohook is available
  useRawHotkey: true,
  cancelKeyEnabled: true,
  pasteMethod: 'paste', // paste | type | clipboard
  restoreClipboard: true,
  trailingSpace: true,
  autoCapitalize: true,
  autoPunctuate: true,
  minDurationMs: 350,
  maxDurationMs: 300000,

  // audio
  inputDeviceId: 'default',
  // Kept alongside the id because Windows hands out a fresh deviceId every
  // time a USB mic is re-plugged; the label is what survives.
  inputDeviceLabel: '',

  // app
  launchAtLogin: false,
  startMinimized: false,
  soundsEnabled: true,
  overlayPosition: 'bottom-center', // bottom-center | bottom-right | top-center | top-right
  overlayVisibleWhenIdle: false,
  showRawInHistory: true,
  historyLimit: 500
};

const STAGE_KEYS = ['openai', 'anthropic', 'gemini'];

module.exports = { MODES, MODELS, PROVIDER_LABELS, DEFAULT_SETTINGS, STAGE_KEYS };

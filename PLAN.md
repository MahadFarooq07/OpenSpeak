# Cadence — Build Plan

A Windows-first Electron dictation app. Hold a key, speak, release — polished text lands at
your cursor in whatever app you're in. Independent, from-scratch implementation of the
push-to-talk dictation workflow. Not affiliated with any existing product.

---

## 1. Product definition

**Core loop (must be < ~2s end to end for a short utterance):**

```
hotkey down → mic capture starts → live waveform on pill
hotkey up   → audio → STT → LLM cleanup → clipboard → Ctrl+V into focused app
```

**Feature set**

| Area | What ships |
|---|---|
| Push-to-talk | Hold-to-record (true key-up detection when `uiohook-napi` is present, auto-repeat heuristic otherwise) + toggle mode |
| Transcription | Cloud STT — OpenAI (`gpt-4o-transcribe` / `whisper-1`) or Gemini (`gemini-2.0-flash`) |
| Cleanup | OpenAI / Anthropic (Claude) / Gemini — filler removal, self-correction resolution, spoken punctuation, list & paragraph formatting |
| Formatting modes | Auto, Email, Message, Notes, Prompt, Code comment, Raw |
| AI commands | Inline spoken instructions ("make that a bullet list", "shorter") are executed by the cleanup pass, not transcribed literally |
| Dictionary | Custom vocabulary + "sounds like → write as" replacements, injected into both STT bias prompt and cleanup prompt |
| History | Last 500 dictations, searchable, one-click re-copy, raw vs polished diff |
| Stats | Words dictated, avg WPM, sessions, day streak, time saved, 30-day activity heat strip |
| Microphone | Device picker in Settings and in the tray, live input meter, label-based re-resolution across replugs, hot-plug refresh |
| Overlay | Frameless, non-focusable, always-on-top pill with idle / listening / transcribing / polishing / done / error states |
| System | Tray menu, launch at Windows login, start minimized, first-run onboarding, mic permission check |
| Settings | Provider + model per stage, API keys for all three vendors, custom base URL (OpenRouter etc.), hotkey, paste method, overlay position, sounds |

---

## 2. Architectural decisions (and why)

### 2.1 Zero runtime dependencies

The only `dependencies` entry is `uiohook-napi`, and it is **optional** — the app detects its
absence and degrades gracefully. Everything else uses Node/Electron built-ins:

- HTTP → global `fetch` (Node 20 in Electron 32)
- Multipart upload → global `FormData` + `Blob`
- Secret storage → `safeStorage` (Windows DPAPI, user-scoped)
- Settings/history/stats → hand-rolled atomic JSON store in `app.getPath('userData')`
- Tray icon → generated at runtime as a raw BGRA bitmap via `nativeImage.createFromBuffer`

**Why:** every native module is a `node-gyp` roll of the dice on a stranger's Windows box.
A dictation app that fails at `npm install` is worth nothing. This installs clean.

### 2.2 No bundler, no framework

Renderers are plain HTML/CSS/ES modules loaded straight off disk. No Vite, no React, no
build step — `npm install && npm start` runs the real app.

**Why:** a build step is another failure surface, and the UI here is a pill and a five-tab
settings window. Hand-written CSS gets it looking sharp without 300MB of `node_modules`.

### 2.3 Three windows, each with one job

| Window | Visible | Purpose |
|---|---|---|
| `hub` | on demand | Settings, history, dictionary, stats, onboarding |
| `overlay` | during dictation | The pill. `focusable: false` so focus never leaves the user's app |
| `recorder` | never | Owns the `getUserMedia` stream and the PCM→WAV capture graph. `backgroundThrottling: false` |

The recorder is separate from the overlay because a hidden window can hold a warm mic stream
indefinitely, while the overlay gets shown/hidden/moved constantly. Warming the stream at
startup removes ~300ms of `getUserMedia` latency from the first keypress.

**Device selection:** the chosen mic is persisted as `{ inputDeviceId, inputDeviceLabel }`. Windows
mints a new `deviceId` every time a USB mic is re-plugged, so an id-only setting silently reverts
to the default mic constantly; the label is the stable half. On warm-up the recorder checks
whether the saved id is still enumerated and falls back to a label match before giving up. The
`devicechange` event re-publishes the list and re-resolves the selection. The recorder reports the
label of the track it actually opened, so the UI can show what is really being listened to rather
than what was requested — and warns when those differ.

**Audio format:** raw PCM captured through a `ScriptProcessorNode` at 16 kHz mono and encoded to
WAV in ~30 lines, rather than `MediaRecorder`. Chromium's MediaRecorder reliably produces only
WebM/Opus, which **Gemini's audio input does not accept** — so a MediaRecorder-based pipeline
silently locks you into OpenAI. WAV is understood by every provider, costs no dependency to
write, and at 32 kB/s is irrelevant for utterances measured in seconds.

### 2.4 Push-to-talk on Windows

Electron's `globalShortcut` fires on press only — no key-up event, and bare modifiers
(`Right Ctrl` alone) can't be registered. Three-tier strategy:

1. **`uiohook-napi` present** → real low-level keyboard hook. True keydown/keyup, supports
   bare keys like Right Ctrl / Right Alt / F13. This is the good path.
2. **Not present, mode = hold** → register the accelerator and exploit Windows key auto-repeat:
   the shortcut refires every ~33ms while held; a 250ms watchdog with no refire means released.
3. **Not present, mode = toggle** → press to start, press to stop. Always reliable.

The app reports which tier is active in Settings so the behaviour is never mysterious.

### 2.5 Text injection

No `robotjs`, no `nut-js`. Instead: write to clipboard, then send `Ctrl+V` to the foreground
window through a **persistent PowerShell process** kept alive for the app's lifetime with
`System.Windows.Forms` preloaded. Per-paste cost is a single line written to stdin (~5ms),
versus ~300ms for a cold `powershell.exe` spawn each time.

The user's prior clipboard contents are captured before the paste and restored 600ms after.
A `type` method (SendKeys character stream) is offered for apps that reject synthetic paste,
and a `clipboard-only` method as the always-works escape hatch.

### 2.6 Provider abstraction

```
providers/index.js   → routes to the right vendor per stage
providers/openai.js  → transcribe() + clean()   (also serves any OpenAI-compatible base URL)
providers/gemini.js  → transcribe() + clean()
providers/anthropic.js →              clean()   (Anthropic ships no STT)
```

Transcription provider and cleanup provider are configured **independently**, because
Claude is excellent at cleanup and cannot do STT. Choosing Anthropic for cleanup while
transcription stays on OpenAI is a first-class, validated configuration.

### 2.7 Deterministic layout, not prompted layout

`providers/format.js` runs after the model and decides structure in code. The motivating evidence:
the same grocery list dictated four times produced inline `1. bread 2. milk 3. bananas`, a properly
broken list, a lead-in glued to the first item (`Hello, hello, hello 1. Bread`), and a missing full
stop — from one prompt, one model, one setting.

Prompting narrows that spread; it does not close it. So the formatter owns everything mechanically
decidable: breaking inline numbered runs onto lines, splitting the lead-in and giving it a colon,
renumbering, capitalising items, normalising bullet glyphs, collapsing mic-check repetitions, and
adding terminal punctuation. It runs on the winning text whether that came from the model or from
the raw transcript after a gate rejection, so layout stays consistent even when cleanup was skipped.

It is deliberately conservative about what counts as a list: only an ascending run starting at 1,
and never when an item opens with a digit — so `it costs 1. 50 and weighs 2. 5 kilos` is left
alone rather than restructured into nonsense. `npm run test:format` exercises these cases in plain
Node.

Counting off out loud is handled in code too. "One bread, two milk, three bananas" becomes a
three-item list, because that is what someone dictating a list actually says. The guard rails are
mechanical: an ascending run starting at one, three or more markers, short items after each, and
no measure word following — so "it took two hours" and "three of them helped" stay as prose. The
model is given matching rules and worked examples so it does not fight the formatter.

### 2.8 Cleanup safety gates

An LLM asked to "clean up" text will occasionally answer the text instead of cleaning it, or
hallucinate an expansion. `providers/guards.js` rejects the polished output and falls back to
the raw transcript when:

- output is empty, or > 2.4× the raw word count, or < 35% of it
- output contains prompt-leak markers (`Here is the`, `Sure,`, backtick fences)
- raw was ≤ 2 words (nothing to clean — pass through)

Every rejection is recorded in history so the failure mode is visible rather than silent.

### 2.9 Security

- API keys → `safeStorage.encryptString` → base64 in `secrets.json`. Never plaintext on disk,
  never in the settings file, never logged. Renderer only ever receives a masked hint
  (`sk-…4f2a`) and a boolean.
- `contextIsolation: true`, `nodeIntegration: false` on every window; renderers touch nothing
  but a narrow, explicitly-enumerated preload bridge.
- Audio never leaves the machine except to the STT vendor the user chose. Nothing else phones home.

---

## 3. Module map

```
cadence/
├─ package.json
├─ README.md · PLAN.md · .gitignore
├─ src/
│  ├─ shared/
│  │   ├─ channels.js        IPC channel name constants (single source of truth)
│  │   └─ defaults.js        default settings, model catalogue, formatting modes
│  ├─ main/
│  │   ├─ main.js            app lifecycle, single-instance lock, boot order
│  │   ├─ store.js           atomic JSON store + safeStorage secret vault
│  │   ├─ windows.js         hub / overlay / recorder creation, overlay placement
│  │   ├─ tray.js            tray icon (generated bitmap) + context menu
│  │   ├─ hotkey.js          three-tier push-to-talk manager
│  │   ├─ paste.js           clipboard + persistent-PowerShell injector
│  │   ├─ session.js         the dictation state machine
│  │   ├─ history.js         capped ring log of dictations
│  │   ├─ stats.js           counters, streak, 30-day activity
│  │   ├─ dictionary.js      custom vocab CRUD + prompt fragments
│  │   ├─ autostart.js       Windows login item
│  │   ├─ ipc.js             all ipcMain handlers
│  │   └─ providers/
│  │        ├─ index.js  openai.js  anthropic.js  gemini.js
│  │        ├─ prompt.js      cleanup system prompt per formatting mode
│  │        └─ guards.js      output sanity gates
│  ├─ preload/
│  │   ├─ hub.js  overlay.js  recorder.js
│  └─ renderer/
│      ├─ hub/       index.html  hub.css  hub.js
│      ├─ overlay/   index.html  overlay.css  overlay.js
│      └─ recorder/  index.html  recorder.js
```

## 4. Data flow — one dictation

```
hotkey.js  ──ptt:down──►  session.begin()
                            ├─ overlay.show({state:'listening'})
                            └─ recorder ◄──REC_START──
recorder   ──REC_LEVEL──►  session ──►  overlay (waveform, 20fps)
hotkey.js  ──ptt:up────►  session.finish()
                            └─ recorder ◄──REC_STOP──
recorder   ──REC_DATA(16kHz mono wav, ms)──►  session
                            ├─ guard: < 350ms → abort quietly
                            ├─ overlay {state:'transcribing'}
                            ├─ providers.transcribe(buf, dictionary bias)
                            ├─ overlay {state:'polishing'}
                            ├─ providers.clean(raw, mode, dictionary)
                            ├─ guards.accept(raw, polished) ? polished : raw
                            ├─ paste.inject(text)
                            ├─ stats.record(words, ms) · history.push(...)
                            └─ overlay {state:'done'} → hide after 900ms
```

Escape at any point cancels. Errors surface on the pill in red plus a hub toast, and the raw
transcript is still placed on the clipboard so nothing spoken is ever lost.

## 5. Build order

1. Scaffold + shared constants
2. Store / secrets / windows / tray / autostart
3. Hotkey + paste (the two Windows-specific hard parts)
4. Providers + prompt + guards
5. Session state machine + IPC surface
6. Overlay pill, then hub (Home / History / Dictionary / Stats / Settings / Onboarding)
7. Static verification pass + README

## 6. Known limits of v1

- Windows only in practice — the injector is PowerShell/SendKeys. macOS/Linux paths are stubbed
  with clear errors rather than half-working code.
- Cloud STT only. The provider interface is shaped so a local whisper.cpp backend can be added
  as a fourth provider without touching the session machine.
- No installer signing pipeline; `electron-builder` config is present but unsigned.
- Streaming partial transcripts are not implemented (single-shot upload after release).

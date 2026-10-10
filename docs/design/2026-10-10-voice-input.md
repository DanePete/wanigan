# Voice input

Dane, 9 October: "add voice input thats fun". Then, rejecting a macOS-only design: "it needs to be anyone can use it
remember this app will eventually be on windows too stop short cutting stuff".

So: the owner speaks, and the words appear live in the box they are writing in (a note about a part of their site,
a message to an agent session, Talk to Wanigan, the explanation sent with a snap or a recording), and narration
fills a recording's step log. It works the same on macOS (arm64 and x64), Windows (x64 and arm64) and Linux x64.

## The rules that shaped it

- **One engine on every OS.** No macOS Speech framework, no Windows.Media speech, no Chromium Web Speech (it does not
  work in Electron and is a network service anyway). A platform's own recogniser could only ever be an optional
  extra behind the same interface; there is none today.
- **On the computer, private, free.** Speech becomes text on this computer. Audio never leaves it, no model call
  spends tokens, and nothing goes to an agent until the owner clicks Send, as before.
- **The model is downloaded once, only when the owner asks**, after being shown its size and source; it lives in
  Wanigan's own data and can be removed. After that, voice works offline.

## Phase 1: measured, not assumed

Measured on 9–10 October on an Apple M2 Pro (12 cores, 32 GB, macOS 26.5) with Electron 44.3.0 (Node 24.20,
Chromium 152). Test audio came from the OS's own text-to-speech (`say`, eight voices), converted to 16 kHz mono with
ffmpeg: 29 English sentences of the kind an owner says about a site ("Move the northwind banner below the search
box."), the same 29 over loud pink noise, 36 sentences in 18 other languages (two each), three seconds of digital
silence and three of room noise. WER is word error rate; CER is character error rate (spaces removed, so "north wind"
and "northwind" score alike). Rows marked † ran on the quick set (33 clips) rather than all 94.

### On the CPU, four threads

| Engine and model | EN clean WER | EN noisy WER | 18 languages CER | Language found | Median per utterance | CPU per utterance | Peak memory | Silence / noise gave |
|---|---|---|---|---|---|---|---|---|
| onnxruntime-web WASM · tiny q8 (43.6 MB) | 15.3% | 25.7% | 33.4% | 90/94 | 529 ms | 1.9 s | 327 MB | "yw'n gwneud yn…" / "happy" |
| **onnxruntime-web WASM · base q8 (79.7 MB)** | **5.9%** | **8.8%** | **18.6%** | 92/94 | **1003 ms** | 3.7 s | **403 MB** | "you" / "1 5kg" |
| **onnxruntime-web WASM · small q8 (251.8 MB)** | **4.7%** | **5.6%** | **6.3%** | 93/94 | **3669 ms** | 11.2 s | **914 MB** | "you" / "ლლლლ…" |
| onnxruntime-node · tiny q8 (43.6 MB) | 15.9% | 26.5% | 37.9% | 88/94 | 272 ms | 0.9 s | 1152 MB | "yw'n gwneud yn…" / "n o t a" |
| onnxruntime-node · base q8 (79.7 MB) | 7.7% | 8.8% | 18.5% | 92/94 | 458 ms | 1.6 s | 825 MB | "you" / "1 5kg" |
| onnxruntime-node · small q8 (251.8 MB) | 4.7% | 6.2% | 6.3% | 92/94 | 1045 ms | 3.8 s | 2477 MB | "you" / "ლლლლ…" |
| whisper.cpp · tiny q5_1 (32.2 MB) | 8.3% | 16.2% | 20.3% | 92/94 | 296 ms | 1.0 s | 344 MB | nothing / "see you next t…" |
| whisper.cpp · base q5_1 (59.7 MB) | 5.6% | 7.7% | 14.1% | 93/94 | 631 ms | 1.6 s | 361 MB | nothing / nothing |
| whisper.cpp · small q5_1 (190.1 MB) | 5.0% | 5.9% | 5.9% | 93/94 | 4265 ms | 9.5 s | 630 MB | nothing / "ʌ ʌ ʌ ʌ ʌ" |
| whisper.cpp · large-v3-turbo q5_0 (574.0 MB) † | 1.8% | 0% | 2.4% | 33/33 | 8431 ms | 23.4 s | 1040 MB | "thank you" / nothing |

Speed measured again in one pass, with the load average steady (CPU time is the fairer number on a busy machine):
WASM base q8 0.96 s wall, 3.59 s CPU; WASM small q8 3.22 s, 12.48 s; onnxruntime-node base q8 0.41 s, 1.45 s;
onnxruntime-node small q8 0.99 s, 3.73 s; whisper.cpp base 0.54 s, 1.82 s; whisper.cpp small 1.63 s, 5.47 s.

### On the GPU

| Engine and model | EN clean WER | EN noisy WER | 18 languages CER | Median per utterance | Peak memory |
|---|---|---|---|---|---|
| WebGPU, hidden window · base fp32 (293.8 MB) | 5.3% | 8.6% | 16.6% | 511 ms | 1723 MB |
| WebGPU, hidden window · base q4 (145.1 MB) | 6.2% | 11.2% | 17.6% | 361 ms | 1738 MB |
| WebGPU, hidden window · small q4 (302.1 MB) | 3.5% | 6.5% | 5.8% | 715 ms | 2366 MB |
| WebGPU, hidden window · large-v3-turbo q4 (761.9 MB) † | 1.8% | 0% | 3.6% | 1887 ms | 3551 MB |
| whisper.cpp on Metal (macOS only) · small q5_1 (190.1 MB) | 5.0% | 5.9% | 5.9% | 378 ms | 502 MB |
| whisper.cpp on Metal (macOS only) · large-v3-turbo q5_0 (574.0 MB) | 2.1% | 5.0% | 3.6% | 1393 ms | 787 MB |

### Other precisions and settings, WASM

| Model | EN clean WER | EN noisy WER | 18 languages CER | Median per utterance | Peak memory |
|---|---|---|---|---|---|
| base q4 (145.1 MB) | 6.2% | 11.2% | 17.6% | 1191 ms | 480 MB |
| base, encoder fp32, decoder q8 (138.9 MB) | 7.4% | 8.6% | 16.6% | 1185 ms | 666 MB |
| small q4 (302.1 MB) | 3.5% | 6.5% | 5.8% | 4536 ms | 982 MB |
| base q8, language given | 5.9% | 8.8% | 15.2% | 900 ms | 411 MB |
| base q8, two threads † | 1.8% | 6.8% | 16.8% | 1642 ms | 411 MB |
| small q8, two threads † | 3.6% | 3.4% | 7.4% | 6078 ms | 893 MB |

Per language (CER, language detected), base q8 against small q8: French 4.4% / 7.7%, German 3.0% / 5.0%, Spanish
6.9% / 2.9%, Italian 4.9% / 1.0%, Portuguese 67.4% (two clips detected as another language; 18.9% with the language
given) / 7.4%, Dutch 7.3% / 9.4%, Polish 5.1% / 3.8%, Swedish 17.1% / 2.6%, Turkish 18.3% / 11.3%, Russian 10.1% /
6.3%, Ukrainian 10.0% / 0%, Arabic 24.6% / 20.0%, Hindi 100% / 17.5%, Vietnamese 37.5% / 4.2%, Indonesian 2.5% /
4.9%, Japanese 8.5% / 0%, Chinese 7.4% / 7.4%, Korean 7.5% / 5.0%.

### What each candidate would ship

| | transformers.js on onnxruntime-web (WASM) | transformers.js on onnxruntime-node | whisper.cpp binding (`@fugood/whisper.node` 1.1.3) | WebGPU in a hidden window |
|---|---|---|---|---|
| Licence | Apache-2.0 (transformers.js), MIT (onnxruntime-web) | Apache-2.0, MIT | MIT (whisper.cpp MIT) | as WASM |
| Native code | none | a binary per OS and arch | a binary per OS and arch | none, but needs a GPU adapter |
| What ships | one 14.2 MB `.wasm`, its 24 KB loader and the bundled worker: the same files on every OS | `onnxruntime-node` 1.30.0: 85 MB (macOS arm64), 64 MB (Windows x64), 69 MB (Windows arm64), 44 MB (Linux x64); **no macOS x64 binary at all** in 1.30.0 | 2.4–4.6 MB per target, from optional packages per OS/arch (and CUDA and Vulkan variants) | as WASM |
| Leaving other platforms out | nothing to leave out | electron-builder file filters per target, by hand | install only the target's optional package, per build machine | — |
| Electron ABI | none (WASM) | N-API 6: no rebuild | N-API: no rebuild | — |
| Peak memory, base | 403 MB | 825 MB | 361 MB | 1.7 GB |

### The decision

**transformers.js 4.3.1 on onnxruntime-web 1.30.0, WASM (`ort-wasm-simd-threaded`), in an Electron utilityProcess.**

- It is the one engine that is identical everywhere: the same `.wasm` file runs on macOS arm64 and x64, Windows x64
  and arm64 and Linux x64, with no native binary to build, sign, notarise, filter per target or break on an Electron
  upgrade.
- onnxruntime-node is about twice as fast (base q8 0.41 s against 0.96 s per utterance) but ships a native binary per
  OS and arch (44–85 MB each), has none for Intel Macs in 1.30.0, and doubles peak memory (825 MB against 403 MB for
  base; 2.5 GB against 0.9 GB for small).
- whisper.cpp bindings are accurate and lean, but need a prebuilt native binary per target, and their best speed
  (Metal) is macOS-only: on Windows and Linux they are CPU builds like everything else.
- WebGPU in a hidden window is fast, but peaks at 1.7–3.5 GB and is not on every machine (no adapter, a blocklisted
  driver, a remote desktop).
- One second for a sentence on the default model is fast enough for dictation: the words appear as each pause ends,
  and volatile words show while the owner is still speaking.

Proven before it was chosen: the bundling recipe below transcribed "Move the northwind banner below the search box."
exactly, inside an Electron utilityProcess, both from a plain folder and from inside an `app.asar`, with peak memory
358–372 MB on four threads.

### Packages

| Package | Version | Licence | Role |
|---|---|---|---|
| `@huggingface/transformers` | 4.3.1 | Apache-2.0 | Whisper: features, the encoder–decoder loop, the tokenizer |
| `onnxruntime-web` | 1.30.0 | MIT | Runs the ONNX models as WebAssembly |

Both are **devDependencies**: the build bundles them into the voice worker, so nothing of theirs is installed into
the packaged app's `node_modules`. transformers.js lists `onnxruntime-node` and `sharp` (both native) as its own
dependencies; neither is ever bundled or shipped. The build replaces its one runtime `require("onnxruntime-node")`
with an empty object and aliases `sharp` to a stub that refuses (audio never needs images), and the worker hands
transformers.js onnxruntime-web through `globalThis[Symbol.for('onnxruntime')]`. `package.json` overrides
transformers.js's own pin of an onnxruntime-web nightly with the stable 1.30.0.

### Models

From Hugging Face, quantized to 8 bits (q8), each file pinned to a repository commit with its size and SHA-256 (the
LFS hash for the weights, computed for the small files) in `src/shared/voice.ts`, and downloaded from
`https://huggingface.co/<repo>/resolve/<commit>/<file>`:

| | Fast (the default) | Accurate |
|---|---|---|
| Repository | `onnx-community/whisper-base` | `onnx-community/whisper-small` |
| Commit | `1846881b6b3a3024392c1eea3ad983695bc23925` | `36050c46d777d46dc4b5f43f6d90574fc38f8732` |
| Download | 79.7 MB (seven files) | 251.8 MB (seven files) |
| English clean / noisy WER | 5.9% / 8.8% | 4.7% / 5.6% |
| 18 languages CER | 18.6% (weak on Hindi, Vietnamese, Arabic, and Portuguese when detected) | 6.3% |
| Per sentence, four threads | about 1 s | about 3.5 s |
| Peak memory | about 400 MB | about 900 MB |
| Licence | Apache-2.0: the onnx-community card states none of its own and names `openai/whisper-base` as its base model, whose card says Apache-2.0 | Apache-2.0, likewise from `openai/whisper-small` |

Files, for each: `onnx/encoder_model_quantized.onnx`, `onnx/decoder_model_merged_quantized.onnx`, `config.json`,
`generation_config.json`, `preprocessor_config.json`, `tokenizer.json`, `tokenizer_config.json`.

Settings › Voice offers both with their size and source, and a language: Detect (the default), or a named one.
Naming the language fixed Portuguese from 67% to 19% CER on the fast model.

## How it works

```
window (renderer)                         main process                       voice worker (utilityProcess)
getUserMedia → AudioContext at 16 kHz     permission: media, audio only,      transformers.js + onnxruntime-web WASM
→ AudioWorklet (100 ms chunks)            our own window only                 VAD → segments → Whisper
        │                                 forks the worker on first use,              ▲   │
        │  MessagePort (audio in, text out) ──────────────────────────────────────────┘   │
        └───────────────────────────────── volatile and final words, with times ◄─────────┘
```

- **The microphone** is captured in the window with `getUserMedia({ audio })`, which Chromium supports on every OS.
  An AudioContext at 16 kHz resamples it; an AudioWorklet hands over 100 ms chunks. Audio goes to the worker over a
  MessagePort that the main process creates and hands to both ends; the main process never sees the audio.
- **The engine** runs out of the window's thread, in a utilityProcess forked on the first use, and is stopped after a
  minute and a half unused or when the window closes. It finds pauses with a voice-activity detector
  (`src/shared/voice-vad.ts`), transcribes each spoken stretch as it ends (a final, with its start and end in
  milliseconds from the first sample), and while one is still going, transcribes what it has so far whenever the
  engine is free (volatile words).
- **Silence and noise never reach the model.** Every Whisper model invents words for silence ("you", "thank you") and
  noise (see the tables). The detector is energy-based with a floor that follows the quietest frame around each one
  (a second and a half before it, a third of a second after: each frame is decided that much late): speech is
  modulated (syllables, gaps between words) and rises well above that floor; steady noise does not, and digital
  silence is under an absolute floor (-62 dBFS). A stretch must hold at least 0.2 s of voiced frames, and its voiced
  core must hold 8 dB between its loud and quiet frames (90th and 10th percentiles): Phase 1's speech held 12–27 dB,
  clean, noisy or in 18 languages, and room noise under 4. That second rule catches noise that starts after silence
  (it rises over the old floor) and the tail of noise before silence (the floor looks ahead into the quiet), which
  the engine's tests caught. Volatile words are asked of the model only for a stretch that passes both so far. On
  Phase 1's 108 clips it finds every sentence from its start and gives nothing for silence or loud room noise, where
  the prototype's slowly rising floor called the room noise speech. Tests prove silence, steady noise and noise
  beside silence give no text and no model call. (Silero VAD agreed with it on every clean and noisy clip; it would
  add a second model to download for no measured gain.)
- **Bounded.** One model loaded, one transcription at a time, at most four threads (one fewer than the cores). A
  spoken stretch is cut at 25 s (Whisper's window is 30 s); audio waiting in a stream is capped at two minutes; an
  audio message over one second is refused. The main process watches the worker's memory and stops it above 1.5 GB
  (fast) or 2.5 GB (accurate), saying so.
- **Language.** transformers.js 4.3.1 transcribes as English when no language is given, so with Detect the worker
  runs the encoder once, reads the language token Whisper chooses in one decoder step, and transcribes in that
  language: the method behind the per-language numbers above.
- **The control.** One reusable `VoiceInput` (`components/VoiceInput.tsx`): a mic `IconButton` beside the box it
  belongs to. Pressed, it listens (water fill, a ring that follows the voice); volatile words show above it while the
  owner speaks; each final goes in at the caret of its box as ordinary, editable, undoable text. ⌘⇧M (Ctrl+Shift+M on
  Windows and Linux) starts or stops it; holding ⌘⇧H (Ctrl+Shift+H) talks until the keys are let go. The chords
  reach the control of the box being typed in, or the one used last; both are on the shortcut sheet and free on every
  platform. What the owner can act on is said in place: no model yet (Download, with size and source), the
  microphone refused (how to allow it on this OS, with a button to that OS setting where there is one), no
  microphone, the engine failed (Try again).
- **The model download** is resumable (an HTTP range request from what is already on disk) and checksum-verified
  (SHA-256 of each file against the pinned value; a file that does not match is deleted, never used), with progress,
  Stop and Remove, into `<Wanigan's data>/voice/models/`. Free disk space is checked first. No download ever happens
  without the owner's click.

### Where it is

| Place | File | What it writes into |
|---|---|---|
| The live view's note composer, its voice slot (a chosen part's note, a snap's and a recording's explanation) | `components/live/Notes.tsx` | the explanation box |
| The live editor's toolbar, its voice slot after Snap and Record | `components/Live.tsx`, `components/live/Voice.tsx` | narration into a recording; else the note box |
| The Request tab's hook search | `components/live/Request.tsx` | the search box (one line, no full stop) |
| Talk to Wanigan | `components/Chat.tsx` | the question |
| A session's message to its agent | `views/SessionView.tsx` | the message |
| Settings › Voice | `components/VoiceSettings.tsx`, one line in `views/SettingsView.tsx` | — |

## Permissions, per OS

- **Electron.** The window's session allows `media` only for Wanigan's own page in its own window, and only audio;
  every other request for the microphone or camera is refused. The live view's sites are in sessions of their own that
  refuse every permission (unchanged).
- **macOS.** `NSMicrophoneUsageDescription` in the app's Info.plist and the `com.apple.security.device.audio-input`
  entitlement (the hardened runtime refuses the microphone without it). macOS asks once, on the first use; refused, it
  is turned back on in System Settings › Privacy & Security › Microphone, and the control's button opens that pane.
- **Windows.** Desktop apps are not asked one by one: Settings › Privacy & security › Microphone has "Microphone
  access" and "Let desktop apps access your microphone", and with either off, Chromium cannot open the device. The
  control says so and its button opens `ms-settings:privacy-microphone`.
- **Linux.** No prompt for a native app: the device is PulseAudio's or PipeWire's. In a Flatpak the app needs the
  PulseAudio socket (or the portal's microphone permission); in a Snap, the `audio-record` interface connected
  (`snap connect wanigan:audio-record`). There is no OS pane to open, so the control says what to check.

## Narration for recordings

While a recording runs, voice input can fill its step log with what the owner says, each line a `said` step at the
moment the words began:

- **Main** (`src/main/live-record.ts`): `live:recordSay(text, at?)`. `at` is when the words began, in milliseconds
  since the epoch; it is clamped into the recording (no earlier than its start, no later than now) and stored as
  milliseconds from the start. Without `at`, the step is stamped as it arrives. The answer is false when nothing is
  recording. Through `cleanStep`, as every step is: text trimmed, control characters removed, at most 2,000
  characters.
- **Window**: `window.wanigan.live.recordSay(text, at?)`.
- **Voice**: the engine gives each final its start in milliseconds from the stream's first sample; the window stamps
  the wall-clock time of that first sample, so `at = streamStart + final.start`.
- **When**: Settings › Voice › "Narrate recordings" listens from a recording's start to its stop; without it, the mic
  beside the recording's Stop narrates this recording only. The chords start and stop narration while a recording
  runs and no box is being typed into.

## What was proven, and what was not

- The built worker in an Electron utilityProcess, driven as the app drives it (`scripts/voice-harness.mjs`), wrote
  "Move the Northwind banner below the search box." from macOS `say` with the fast model, and "Move the North Wind
  Banner below the search box." with the accurate one; three seconds of silence and of steady noise made no model
  call (`main/voice-real.test.ts`, with `WANIGAN_VOICE_MODELS`). French and Japanese came back in their own scripts.
- The same worker ran from inside an `app.asar` packed from exactly what electron-builder ships (`out/**` and the
  production dependencies better-sqlite3, node-addon-api, node-pty and qrcode-generator), and transcribed the same.
  The lockfile marks transformers.js, onnxruntime-web, onnxruntime-node, sharp and `@img/*` as dev-only, and that
  asar holds no onnxruntime-node, sharp or `@img` file: its only native files are node-pty's and better-sqlite3's.
- In the real app (Electron 44, the demo), `window.wanigan.voice.start()` handed a port through the main process
  and the preload to the page, audio sent over it reached the worker, the final came back, and an unknown and an
  oversized message were refused by name.
- The window's capture (getUserMedia, the AudioContext at 16 kHz, the AudioWorklet's 100 ms chunks, the port) runs
  in the voice sweep against a stream an AudioContext makes; the microphone is never opened in a test.
- Not seen: a real microphone. On the test machine, the agent-launched Electron could not open even Chromium's
  fake audio device (getUserMedia never settled, with no permission request logged) and its audio graph rendered
  silence; the sweep's headless Chromium did not have that problem. Not yet run on Windows, Linux or an Intel Mac.

## What it is not

- It does not run while nothing asks it to: the microphone is open only while a control is listening (the OS shows
  its indicator), and the worker exits when unused.
- It is not a cloud service and makes no request except the model download the owner asks for.
- It does not reach the site's page in the live view: the chords work while the keyboard is in Wanigan's window.
- The tests never open a microphone: the sweep stubs `getUserMedia`, and the real transcription test feeds OS
  text-to-speech to the built worker directly.

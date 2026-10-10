// Voice input played in the browser harness: added as an init script after
// scripts/ui-harness.mjs's BRIDGE. `window.wanigan.voice` answers as the main
// process would (settings, models, downloads, starting a stream), a stream's
// port is handed to the page as the preload hands it, and the other end of
// the port is a stand-in engine the sweep makes speak (__wgVoice.say). The
// microphone is never opened: getUserMedia is replaced by a stream an
// AudioContext makes (a voice-like tone, or a refusal the sweep chooses), so
// the window's real capture (the AudioWorklet at 16 kHz) still runs. Test-only;
// never shipped.

export function voiceStub(options = {}) {
  const v = {
    calls: [],
    /** What the stand-in engine was sent: audio chunks (count, samples, peak), and every other message. */
    audio: { chunks: 0, samples: 0, peak: 0, sizes: new Set() },
    sent: [],
    /** How getUserMedia answers: 'ok', or the name of the DOMException it throws. */
    mic: options.mic ?? 'ok',
    gum: [],
    tracks: [],
    engine: null,
    state: {
      settings: { model: 'fast', language: 'auto', narrate: false, ...(options.settings ?? {}) },
      models: [
        { id: 'fast', ready: options.ready ?? true, download: { state: 'idle' } },
        { id: 'accurate', ready: false, download: { state: 'idle' } },
      ],
      engine: 'off', engineError: null, mic: 'granted', micSettings: (options.platform ?? 'darwin') !== 'linux', platform: options.platform ?? 'darwin',
    },
  };
  window.__wgVoice = v;
  const listeners = new Set();
  const copy = () => JSON.parse(JSON.stringify(v.state));
  v.push = (patch) => { v.state = { ...v.state, ...patch }; for (const l of listeners) l(copy()); };
  v.model = (id, patch) => { v.push({ models: v.state.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }); };
  /** The stand-in engine says something on the open stream. */
  v.say = (msg) => { v.engine?.postMessage(msg); };
  window.wanigan.platform = options.platform ?? 'darwin';

  window.wanigan.voice = {
    state: async () => copy(),
    onState: (l) => { listeners.add(l); return () => listeners.delete(l); },
    setSettings: async (patch) => { v.calls.push(`setSettings ${JSON.stringify(patch)}`); v.push({ settings: { ...v.state.settings, ...patch } }); return copy(); },
    download: async (id) => {
      v.calls.push(`download ${id}`);
      v.model(id, { download: { state: 'downloading', done: 0, total: 79_664_191 } });
      return copy();
    },
    cancel: async (id) => { v.calls.push(`cancel ${id}`); v.model(id, { download: { state: 'failed', done: 1, total: 79_664_191, error: 'Stopped. Download carries on from where it stopped.' } }); return copy(); },
    remove: async (id) => { v.calls.push(`remove ${id}`); v.model(id, { ready: false }); return copy(); },
    openMicSettings: async () => { v.calls.push('openMicSettings'); return v.state.platform !== 'linux'; },
    start: async () => {
      v.calls.push('start');
      const ready = v.state.models.find((m) => m.id === v.state.settings.model)?.ready;
      if (!ready) return { ok: false, code: 'no-model', message: 'Voice input needs its speech model first.' };
      const id = `stream-${v.calls.length}`;
      const channel = new MessageChannel();
      const engine = channel.port2;
      v.engine = engine;
      engine.onmessage = (e) => {
        const m = e.data;
        if (m?.type === 'audio') {
          v.audio.chunks++;
          v.audio.samples += m.samples.length;
          v.audio.sizes.add(m.samples.length);
          for (const s of m.samples) v.audio.peak = Math.max(v.audio.peak, Math.abs(s));
          return;
        }
        v.sent.push(m);
        if (m?.type === 'end') setTimeout(() => { for (const f of v.pendingFinals ?? []) engine.postMessage(f); v.pendingFinals = []; engine.postMessage({ type: 'done', finals: 0, transcribed: 0 }); }, 60);
        if (m?.type === 'cancel') engine.postMessage({ type: 'done', finals: 0, transcribed: 0 });
      };
      v.push({ engine: 'ready' });
      // As the preload hands a port to the page.
      setTimeout(() => window.postMessage({ wanigan: 'voice-port', id }, '*', [channel.port1]), 10);
      return { ok: true, id };
    },
  };

  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      v.gum.push(JSON.parse(JSON.stringify(constraints ?? null)));
      if (v.mic !== 'ok') {
        const message = v.mic === 'NotAllowedError' ? 'Permission denied by system' : v.mic === 'NotFoundError' ? 'Requested device not found' : 'Could not start audio source';
        throw new DOMException(message, v.mic);
      }
      // A voice-like tone: 180 Hz, its loudness rising and falling four times a second.
      const ctx = new AudioContext();
      const tone = ctx.createOscillator();
      tone.frequency.value = 180;
      const level = ctx.createGain();
      level.gain.value = 0.2;
      const syllables = ctx.createOscillator();
      syllables.frequency.value = 4;
      const depth = ctx.createGain();
      depth.gain.value = 0.18;
      syllables.connect(depth).connect(level.gain);
      const out = ctx.createMediaStreamDestination();
      tone.connect(level).connect(out);
      tone.start();
      syllables.start();
      v.tracks.push(...out.stream.getTracks());
      return out.stream;
    };
  }
}

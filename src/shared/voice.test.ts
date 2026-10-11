// Voice input's data: the stream's messages are checked before use, words join
// a box as typing would, the chords are free on every platform, the settings
// keep only what they may, and every model file is pinned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHORTCUTS, VOICE_HOLD, VOICE_TOGGLE, keySets, matchKey, menuAccelerator, type CommandId } from './shortcuts.ts';
import {
  VOICE_CHUNK_MAX, VOICE_MODELS, cleanHeard, cleanVoiceSettings, endsVoiceHold, fileUrl, hasWords, isVoiceHoldKey, isVoiceToggleKey,
  joinSpoken, modelBytes, readVoiceIn,
} from './voice.ts';

const key = (k: string, over: Partial<{ code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

test('a stream message is read only when it is one the worker knows, and audio only as float samples of a second at most', () => {
  assert.deepEqual(readVoiceIn({ type: 'end' }), { ok: true, msg: { type: 'end' } });
  assert.deepEqual(readVoiceIn({ type: 'cancel', extra: 'ignored' }), { ok: true, msg: { type: 'cancel' } });
  const samples = new Float32Array(1600);
  const audio = readVoiceIn({ type: 'audio', samples, path: '/etc/passwd' });
  assert.ok(audio.ok && audio.msg.type === 'audio' && audio.msg.samples === samples && !('path' in audio.msg));
  for (const raw of [null, 'end', 42, { type: 'shout' }, { type: 'load', root: '/' }, {}]) {
    const r = readVoiceIn(raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.equal(!r.ok && r.code, 'unknown-message');
  }
  const big = readVoiceIn({ type: 'audio', samples: new Float32Array(VOICE_CHUNK_MAX + 1) });
  assert.equal(!big.ok && big.code, 'oversized');
  for (const bad of [[0.1, 0.2], new Float64Array(10), new Int16Array(10), 'samples']) {
    const r = readVoiceIn({ type: 'audio', samples: bad });
    assert.equal(!r.ok && r.code, 'bad-audio', String(bad));
  }
});

test('what Whisper says for what was not speech is taken out; punctuation alone is not words', () => {
  assert.equal(cleanHeard(' [BLANK_AUDIO] '), '');
  assert.equal(cleanHeard('(music) Move the banner. ♪♪'), 'Move the banner.');
  assert.equal(cleanHeard('Move   the\nbanner'), 'Move the banner');
  assert.equal(hasWords('...'), false);
  assert.equal(hasWords('バナー'), true);
  assert.equal(hasWords('42'), true);
});

test('spoken words join a box as typing would: a space after a word, none at the start, one line in an input', () => {
  assert.equal(joinSpoken('', ' Move the banner. ', false), 'Move the banner.');
  assert.equal(joinSpoken('Make it blue.', 'And bigger.', false), ' And bigger.');
  assert.equal(joinSpoken('Make it blue. ', 'And bigger.', false), 'And bigger.');
  assert.equal(joinSpoken('Line one\n', 'Two.', false), 'Two.');
  assert.equal(joinSpoken('Make it blue', ', please.', false), ', please.');
  // An input is one line: no breaks and no closing full stop (a search box).
  assert.equal(joinSpoken('', 'Form alter.', true), 'Form alter');
  assert.equal(joinSpoken('hook', 'form\nalter.', true), ' form alter');
  assert.equal(joinSpoken('x', '   ', false), '');
});

test('⌘⇧M starts or stops listening and ⌘⇧H is held to talk, Ctrl+Shift on Windows and Linux, whatever the layout', () => {
  assert.ok(isVoiceToggleKey(key('M', { metaKey: true, shiftKey: true }), true));
  assert.ok(isVoiceToggleKey(key('m', { ctrlKey: true, shiftKey: true }), false));
  assert.ok(isVoiceHoldKey(key('H', { metaKey: true, shiftKey: true }), true));
  assert.ok(isVoiceHoldKey(key('H', { ctrlKey: true, shiftKey: true }), false));
  // A Cyrillic layout types ь on the M key: the key's code still names it.
  assert.ok(isVoiceToggleKey(key('Ь', { metaKey: true, shiftKey: true, code: 'KeyM' }), true));
  // Each platform's modifier only, and never with ⌥ (AltGr on many keyboards) or without ⇧.
  assert.ok(!isVoiceToggleKey(key('M', { ctrlKey: true, shiftKey: true }), true), 'Control stays with the terminal on a Mac');
  assert.ok(!isVoiceToggleKey(key('M', { metaKey: true, shiftKey: true }), false));
  assert.ok(!isVoiceToggleKey(key('m', { metaKey: true }), true), '⌘M minimises the window');
  assert.ok(!isVoiceToggleKey(key('M', { metaKey: true, shiftKey: true, altKey: true }), true));
  assert.ok(!isVoiceHoldKey(key('h', { metaKey: true }), true), '⌘H hides the app');
  // A hold ends when the letter or a modifier of the chord is let go (a Mac sends no key-up for the letter under ⌘).
  assert.ok(endsVoiceHold({ key: 'Meta' }, true));
  assert.ok(endsVoiceHold({ key: 'Control' }, false));
  assert.ok(endsVoiceHold({ key: 'Shift' }, true));
  assert.ok(endsVoiceHold({ key: 'H', code: 'KeyH' }, true));
  assert.ok(!endsVoiceHold({ key: 'Control' }, true));
  assert.ok(!endsVoiceHold({ key: 'a' }, true));
  // A real key-up keeps key and code on its prototype, as KeyboardEvent does: letting go of H first (Windows and
  // Linux send its key-up while Ctrl is still down) ends the hold, and never throws.
  const KeyUp = class { readonly #k: string; readonly #c: string; constructor(k: string, c: string) { this.#k = k; this.#c = c; } get key(): string { return this.#k; } get code(): string { return this.#c; } };
  assert.ok(endsVoiceHold(new KeyUp('H', 'KeyH'), false));
  assert.ok(endsVoiceHold(new KeyUp('h', 'KeyH'), true));
  assert.ok(!endsVoiceHold(new KeyUp('a', 'KeyA'), false));
});

test('the voice chords are on the sheet, and no other shortcut, app command or menu item is either chord on any platform', () => {
  assert.ok(SHORTCUTS.includes(VOICE_TOGGLE) && SHORTCUTS.includes(VOICE_HOLD));
  for (const mac of [true, false]) {
    for (const s of [VOICE_TOGGLE, VOICE_HOLD]) {
      const chord = s.keys.join('+');
      const owners = SHORTCUTS.filter((x) => keySets(x, mac).some((k) => k.join('+') === chord));
      assert.deepEqual(owners, [s], `${chord} on ${mac ? 'macOS' : 'Windows and Linux'}`);
    }
    // The window's own keys leave both alone, typing or not, so they reach voice input.
    for (const typing of [false, true]) {
      for (const k of ['m', 'M', 'h', 'H']) {
        const e = key(k, { shiftKey: true, ...(mac ? { metaKey: true } : { ctrlKey: true }) });
        assert.equal(matchKey(e, { mac, typing, dialog: false, afterG: false }), null, `${k} on ${mac ? 'mac' : 'pc'}`);
      }
    }
    const accelerators = SHORTCUTS.flatMap((s) => (s.id ? [menuAccelerator(s.id as CommandId, mac)] : []));
    assert.ok(!accelerators.includes('CmdOrCtrl+Shift+M') && !accelerators.includes('CmdOrCtrl+Shift+H'));
  }
});

test('settings keep a known model, a known language and a switch; anything else is dropped', () => {
  assert.deepEqual(cleanVoiceSettings(null), { model: 'fast', language: 'auto', narrate: false });
  assert.deepEqual(cleanVoiceSettings({ model: 'accurate', language: 'pt', narrate: true, root: '/' }), { model: 'accurate', language: 'pt', narrate: true });
  assert.deepEqual(cleanVoiceSettings({ model: '../../etc', language: 'klingon', narrate: 'yes' }, { model: 'accurate', language: 'en', narrate: true }),
    { model: 'accurate', language: 'en', narrate: true });
});

test('every model file is pinned to a commit, with its size and SHA-256, and comes from Hugging Face', () => {
  assert.deepEqual(VOICE_MODELS.map((m) => m.id), ['fast', 'accurate']);
  for (const m of VOICE_MODELS) {
    assert.match(m.revision, /^[0-9a-f]{40}$/);
    assert.match(m.repo, /^onnx-community\/whisper-(base|small)$/);
    assert.match(m.licence, /Apache-2\.0/);
    assert.deepEqual(m.files.map((f) => f.path).sort(), ['config.json', 'generation_config.json', 'onnx/decoder_model_merged_quantized.onnx',
      'onnx/encoder_model_quantized.onnx', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']);
    for (const f of m.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isInteger(f.bytes) && f.bytes > 0);
      assert.equal(fileUrl(m, f), `https://huggingface.co/${m.repo}/resolve/${m.revision}/${f.path}`);
    }
  }
  // The sizes the owner is shown: about 80 MB and 252 MB.
  assert.equal(Math.round(modelBytes(VOICE_MODELS[0]!) / 1e6), 80);
  assert.equal(Math.round(modelBytes(VOICE_MODELS[1]!) / 1e6), 252);
});

#!/usr/bin/env node
// Voice input, in both themes, against the harness's real core (the demo) and
// a stand-in for the main process and the speech engine
// (scripts/ui-voice-stub.mjs). The microphone is never opened: getUserMedia is
// a stream an AudioContext makes, so the window's real capture runs (the
// AudioWorklet at 16 kHz, 100 ms chunks, over the port), and the stand-in
// engine says what the sweep tells it to. Screenshots go to
// .artifacts/voice/<theme>-<name>.png.
//
// The control (Talk to Wanigan's box, a session's box): idle, with its name
// and keys; pressed, it listens (audio reaches the engine, at 16 kHz, with a
// voice in it), shows the words heard so far, and puts the final sentence in
// at the caret; stopped, the microphone is let go. ⌘⇧M from the box, and ⌘Z
// takes the words back out; ⌘⇧H held talks until let go. No model: the
// prompt with the size and source, and Download with its progress. The
// microphone refused (with the OS's words and its settings button), no
// microphone, the engine failing. Settings › Voice. The sheet's Voice input
// keys. The live editor: the Voice tool in the toolbar, the note composer's
// mic, and narration filling a recording's log with the time each sentence
// began. And the build: the worker bundles nothing native.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BRIDGE, root, startGateway } from './ui-harness.mjs';
import { liveFixture, liveStub } from './ui-live-stub.mjs';
import { LIVE_DEFAULTS } from './ui-live-defaults.mjs';
import { snapStub } from './ui-snap-stub.mjs';
import { voiceStub } from './ui-voice-stub.mjs';

const out = join(root, '.artifacts', 'voice');
mkdirSync(out, { recursive: true });
const failures = [];
const fail = (what) => { failures.push(what); console.error(`✗ ${what}`); };
const SENTENCE = 'Move the northwind banner below the search box.';

// ── The build: the worker and its WebAssembly, and nothing native in it.
{
  const main = join(root, 'out', 'main');
  const files = existsSync(main) ? readdirSync(main, { recursive: true }).map(String) : [];
  if (!files.includes('voice-worker.js')) fail('build: out/main/voice-worker.js is missing');
  if (!files.some((f) => f.endsWith('voice/ort-wasm-simd-threaded.wasm')) || !files.some((f) => f.endsWith('voice/ort-wasm-simd-threaded.mjs'))) fail('build: onnxruntime’s WebAssembly is not beside the worker');
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const code = readFileSync(join(main, f), 'utf8');
    if (/require\(["']onnxruntime-node["']\)|from ["']onnxruntime-node["']|requireFromHere\(["']onnxruntime-node["']\)/.test(code)) fail(`build: ${f} loads onnxruntime-node`);
    if (/require\(["']sharp["']\)|from ["']sharp["']/.test(code)) fail(`build: ${f} loads sharp`);
    if (/\.node["']\)/.test(code) && /voice|transformers/.test(f)) fail(`build: ${f} loads a native addon`);
  }
}

const { base, gateway } = await startGateway({ demo: true, quiet: true });
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(theme, stub, route = '#/needs', { live = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 });
  await context.addInitScript(BRIDGE);
  await context.addInitScript(`try { localStorage.setItem('wanigan.theme', '${theme}'); } catch {}`);
  if (live) {
    await context.addInitScript(liveStub, liveFixture);
    await context.addInitScript(LIVE_DEFAULTS);
    await context.addInitScript(snapStub);
  }
  await context.addInitScript(voiceStub, stub);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(`${base}${route}`);
  return { page, context, errors };
}

const voice = (page) => page.evaluate(() => {
  const v = window.__wgVoice;
  return { calls: v.calls, sent: v.sent, gum: v.gum, chunks: v.audio.chunks, samples: v.audio.samples, peak: v.audio.peak, sizes: [...v.audio.sizes], tracks: v.tracks.map((t) => t.readyState) };
});

/** Talk to Wanigan, open, with its box holding `text`. */
async function chat(page, text = '') {
  await page.getByRole('button', { name: /^Talk to Wanigan/ }).first().click();
  const box = page.locator('.chat-compose textarea');
  await box.waitFor({ timeout: 10_000 });
  await box.fill(text);
  return box;
}

try {
  for (const theme of ['dark', 'light']) {
    const t = (what) => `${theme}/${what}`;
    const shot = (page, name) => page.screenshot({ path: join(out, `${theme}-${name}.png`), animations: 'disabled', style: '.toasts { visibility: hidden !important; }' });

    // ── Idle, listening with volatile words, a final at the caret, stopping.
    {
      const { page, context, errors } = await open(theme, {});
      const box = await chat(page, 'Please');
      const mic = page.locator('.chat-compose .voice button');
      if ((await mic.getAttribute('aria-label')) !== 'Speak your question') fail(t(`idle: the mic is named ${await mic.getAttribute('aria-label')}`));
      if ((await mic.getAttribute('aria-keyshortcuts')) !== 'Meta+Shift+M') fail(t(`idle: the mic's keys are ${await mic.getAttribute('aria-keyshortcuts')}`));
      if ((await page.locator('.chat-compose .voice').getAttribute('data-voice')) !== 'idle') fail(t('idle: the control is not idle'));
      await mic.focus();
      await page.waitForTimeout(400);
      await shot(page, 'idle');
      await mic.click();
      await page.waitForSelector('.chat-compose .voice[data-voice="listening"]', { timeout: 5000 }).catch(() => fail(t('listening: pressing the mic did not listen')));
      await page.waitForFunction(() => window.__wgVoice.audio.chunks >= 6, null, { timeout: 8000 }).catch(() => {});
      const heard = await voice(page);
      if (JSON.stringify(heard.gum[0]?.audio) === undefined || heard.gum[0]?.video) fail(t(`capture: getUserMedia was asked for ${JSON.stringify(heard.gum[0])}`));
      if (heard.chunks < 6) fail(t(`capture: ${heard.chunks} audio chunks reached the engine`));
      if (heard.sizes.some((n) => n !== 1600)) fail(t(`capture: chunks were ${heard.sizes.join(', ')} samples, not 100 ms at 16 kHz`));
      if (heard.peak < 0.02) fail(t(`capture: the audio that reached the engine was silent (peak ${heard.peak})`));
      if ((await mic.getAttribute('aria-pressed')) !== 'true') fail(t('listening: the mic is not pressed'));
      await page.evaluate(() => { window.__wgVoice.say({ type: 'speech', speaking: true, at: 300 }); window.__wgVoice.say({ type: 'partial', text: 'Move the northwind banner', start: 300, end: 1800 }); });
      await page.waitForFunction(() => document.querySelector('.chat-compose .voice-volatile')?.textContent?.includes('northwind'), null, { timeout: 3000 })
        .catch(() => fail(t('volatile: the words heard so far did not show')));
      if ((await box.inputValue()) !== 'Please') fail(t('volatile: volatile words went into the box'));
      await shot(page, 'listening');
      await page.evaluate((s) => window.__wgVoice.say({ type: 'final', text: s, start: 300, end: 3100 }), SENTENCE);
      await page.waitForFunction((s) => document.querySelector('.chat-compose textarea')?.value === `Please ${s}`, SENTENCE, { timeout: 3000 })
        .catch(async () => fail(t(`final: the box holds ${JSON.stringify(await box.inputValue())}`)));
      if (await page.locator('.chat-compose .voice-words').count()) {
        const left = await page.locator('.chat-compose .voice-volatile').innerText();
        if (left.includes('northwind')) fail(t('final: the volatile words stayed after the final'));
      }
      if (!(await page.locator('.chat-compose [role="status"]').innerText()).includes('Added: Move the northwind')) fail(t('final: the screen reader was not told what was added'));
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await page.waitForSelector('.chat-compose .voice[data-voice="idle"]', { timeout: 5000 }).catch(() => fail(t('stop: the control did not go back to idle')));
      const after = await voice(page);
      if (!after.sent.some((m) => m.type === 'end')) fail(t('stop: the engine was not told the stream ended'));
      if (after.tracks.some((s) => s !== 'ended')) fail(t('stop: the microphone was not let go'));
      if (errors.length) fail(t(`errors: ${errors.join(' | ')}`));
      await context.close();
    }

    // ── The chord from the box, ⌘Z, and holding ⌘⇧H.
    {
      const { page, context } = await open(theme, {});
      const box = await chat(page, 'Make it blue.');
      await box.focus();
      await page.keyboard.press('Meta+Shift+M');
      await page.waitForSelector('.chat-compose .voice[data-voice="listening"]', { timeout: 5000 }).catch(() => fail(t('chord: ⌘⇧M in the box did not listen')));
      await page.evaluate(() => window.__wgVoice.say({ type: 'final', text: 'And twice as large.', start: 200, end: 1500 }));
      await page.waitForFunction(() => document.querySelector('.chat-compose textarea')?.value === 'Make it blue. And twice as large.', null, { timeout: 3000 })
        .catch(async () => fail(t(`chord: the box holds ${JSON.stringify(await box.inputValue())}`)));
      await page.keyboard.press('Meta+Shift+M');
      await page.waitForSelector('.chat-compose .voice[data-voice="idle"]', { timeout: 5000 }).catch(() => fail(t('chord: ⌘⇧M again did not stop')));
      await box.focus();
      await page.keyboard.press('Meta+Z');
      if ((await box.inputValue()) !== 'Make it blue.') fail(t(`undo: ⌘Z left ${JSON.stringify(await box.inputValue())}`));
      // Held: listening while the keys are down, finishing once ⌘ is let go.
      await box.focus();
      await page.keyboard.down('Meta');
      await page.keyboard.down('Shift');
      await page.keyboard.down('KeyH');
      await page.waitForSelector('.chat-compose .voice[data-voice="listening"]', { timeout: 5000 }).catch(() => fail(t('hold: ⌘⇧H held did not listen')));
      await page.keyboard.up('KeyH');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Meta');
      await page.waitForSelector('.chat-compose .voice[data-voice="idle"]', { timeout: 5000 }).catch(() => fail(t('hold: letting go did not stop')));
      await context.close();
    }

    // ── No model: the prompt with its size and source; Download and its progress.
    {
      const { page, context } = await open(theme, { ready: false });
      await chat(page);
      await page.locator('.chat-compose .voice button').click();
      const pop = page.locator('.voice-pop');
      await pop.waitFor({ timeout: 5000 }).catch(() => fail(t('no model: pressing the mic showed no prompt')));
      const words = await pop.innerText().catch(() => '');
      for (const want of ['Speak instead of typing', '80 MB', 'Hugging Face, onnx-community/whisper-base', 'Apache-2.0', 'never leaves', 'Download (80 MB)']) {
        if (!words.includes(want)) fail(t(`no model: the prompt does not say "${want}"`));
      }
      if ((await voice(page)).gum.length) fail(t('no model: the microphone was asked for before there was a model'));
      await shot(page, 'no-model');
      await pop.getByRole('button', { name: 'Download (80 MB)' }).click();
      if (!(await voice(page)).calls.includes('download fast')) fail(t('no model: Download did not ask for the fast model'));
      await page.evaluate(() => window.__wgVoice.model('fast', { download: { state: 'downloading', done: 40_000_000, total: 79_664_191 } }));
      await page.waitForFunction(() => document.querySelector('.voice-pop')?.textContent?.includes('40 MB of 80 MB'), null, { timeout: 3000 })
        .catch(() => fail(t('download: the progress did not show')));
      await shot(page, 'downloading');
      await page.evaluate(() => window.__wgVoice.model('fast', { ready: true, download: { state: 'idle' } }));
      await page.waitForFunction(() => document.querySelector('.voice-pop')?.textContent?.includes('is ready'), null, { timeout: 3000 })
        .catch(() => fail(t('download: done, the prompt did not say it was ready')));
      await context.close();
    }

    // ── The microphone refused: the OS's words and its settings; no microphone; the engine failing.
    {
      const { page, context } = await open(theme, { mic: 'NotAllowedError' });
      await chat(page);
      await page.locator('.chat-compose .voice button').click();
      const pop = page.locator('.voice-pop');
      await pop.waitFor({ timeout: 5000 }).catch(() => fail(t('denied: no popover')));
      const words = await pop.innerText().catch(() => '');
      if (!words.includes('Wanigan can’t use the microphone') || !words.includes('System Settings › Privacy & Security › Microphone')) fail(t(`denied: the popover says ${JSON.stringify(words)}`));
      await shot(page, 'denied');
      await pop.getByRole('button', { name: 'Open Microphone settings' }).click();
      if (!(await voice(page)).calls.includes('openMicSettings')) fail(t('denied: the settings button did not open the OS’s page'));
      // No microphone at all.
      await page.keyboard.press('Escape');
      await page.evaluate(() => { window.__wgVoice.mic = 'NotFoundError'; });
      await page.locator('.chat-compose .voice button').click();
      await page.waitForFunction(() => document.querySelector('.voice-pop')?.textContent?.includes('No microphone was found'), null, { timeout: 3000 })
        .catch(() => fail(t('no mic: not said')));
      // The engine failing while it listens.
      await page.keyboard.press('Escape');
      await page.evaluate(() => { window.__wgVoice.mic = 'ok'; });
      await page.locator('.chat-compose .voice button').click();
      await page.waitForSelector('.chat-compose .voice[data-voice="listening"]', { timeout: 5000 }).catch(() => fail(t('engine: did not listen')));
      await page.waitForFunction(() => window.__wgVoice.engine !== null, null, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__wgVoice.push({ engine: 'failed', engineError: 'The speech engine stopped unexpectedly (exit code 133).' }));
      await page.waitForFunction(() => document.querySelector('.voice-pop')?.textContent?.includes('exit code 133'), null, { timeout: 3000 })
        .catch(() => fail(t('engine: its failure was not said')));
      if (!(await page.locator('.voice-pop').innerText().catch(() => '')).includes('Try again')) fail(t('engine: no Try again'));
      await shot(page, 'engine-failed');
      await context.close();
    }

    // ── Windows words.
    if (theme === 'light') {
      const { page, context } = await open(theme, { mic: 'NotReadableError', platform: 'win32' });
      await chat(page);
      await page.locator('.chat-compose .voice button').click();
      await page.waitForFunction(() => document.querySelector('.voice-pop')?.textContent?.includes('Let desktop apps access your microphone'), null, { timeout: 3000 })
        .catch(() => fail('windows: the refusal does not say how Windows allows it'));
      const mic = await page.locator('.chat-compose .voice button').getAttribute('aria-keyshortcuts');
      if (mic !== 'Control+Shift+M') fail(`windows: the mic's keys are ${mic}`);
      await context.close();
    }

    // ── Settings › Voice, and the sheet's keys.
    {
      const { page, context } = await open(theme, {}, '#/settings');
      const section = page.locator('section[aria-labelledby="set-voice"]');
      await section.waitFor({ timeout: 10_000 }).catch(() => fail(t('settings: no Voice section')));
      await section.scrollIntoViewIfNeeded().catch(() => {});
      const words = await section.innerText().catch(() => '');
      for (const want of ['Fast: Whisper base', 'Accurate: Whisper small', 'On this computer, 80 MB', 'Download (252 MB)', 'onnx-community/whisper-small', '1846881b6b', 'Apache-2.0', 'Narrate recordings', 'Detect it']) {
        if (!words.includes(want)) fail(t(`settings: the Voice section does not say "${want}"`));
      }
      await page.waitForTimeout(300);
      await section.screenshot({ path: join(out, `${theme}-settings.png`), animations: 'disabled' });
      await page.getByRole('switch', { name: /Narrate recordings/ }).click();
      if (!(await voice(page)).calls.some((c) => c === 'setSettings {"narrate":true}')) fail(t('settings: the narrate switch did not save'));
      await page.keyboard.press('Meta+/');
      const sheet = await page.locator('[aria-modal="true"]').innerText().catch(() => '');
      if (!sheet.includes('Voice input') || !sheet.includes('Hold to speak')) fail(t('sheet: the Voice input keys are not on it'));
      await context.close();
    }

    // ── The live editor: the toolbar's Voice tool, the note composer's mic, and narration into a recording's log.
    {
      const { page, context, errors } = await open(theme, { settings: { narrate: true } }, '#/p/NS/live', { live: true });
      await page.addInitScript(() => {});
      await page.waitForSelector('.live-tree', { timeout: 15_000 }).catch(() => fail(t('live: the Live tab never showed the parts')));
      const tool = page.locator('.tool-slot[data-slot="voice"] button');
      if ((await tool.getAttribute('aria-label').catch(() => null)) !== 'Speak a note') fail(t('live: no Voice tool in the toolbar’s voice slot'));
      await page.evaluate(() => {
        window.__said = [];
        const say = window.wanigan.live.recordSay;
        window.wanigan.live.recordSay = (text, at) => { window.__said.push({ text, at, now: Date.now() }); return say(text, at); };
      });
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Shift+R');
      await page.waitForSelector('.tool-slot[data-slot="voice"] .voice[data-voice^="narrating"]', { timeout: 6000 }).catch(() => fail(t('narrate: a recording did not start narration')));
      await page.waitForFunction(() => window.__wgVoice.engine !== null && window.__wgVoice.audio.chunks > 2, null, { timeout: 6000 }).catch(() => fail(t('narrate: no audio reached the engine')));
      await page.evaluate(() => { window.__wgVoice.say({ type: 'partial', text: 'It hangs', start: 500, end: 1200 }); });
      await page.waitForFunction(() => document.querySelector('.voice-narrating')?.textContent?.includes('It hangs'), null, { timeout: 3000 })
        .catch(() => fail(t('narrate: the words heard so far are not in the status line')));
      await shot(page, 'live-narrating');
      // The final comes once the engine has heard past the sentence's start (as a real one would, after the pause).
      await page.waitForFunction(() => window.__wgVoice.audio.chunks >= 12, null, { timeout: 6000 }).catch(() => {});
      await page.evaluate(() => window.__wgVoice.say({ type: 'final', text: 'It hangs after this.', start: 500, end: 1100 }));
      await page.waitForFunction(() => window.__said.length > 0, null, { timeout: 3000 }).catch(() => fail(t('narrate: the final did not reach the recording')));
      const said = await page.evaluate(() => window.__said);
      if (said[0]?.text !== 'It hangs after this.') fail(t(`narrate: the log was given ${JSON.stringify(said)}`));
      // At the moment the words began: half a second after the first sample, so at least that long before it arrived.
      else if (!(said[0].now - said[0].at >= 300 && said[0].now - said[0].at < 10_000)) fail(t(`narrate: the step's time is ${said[0].now - said[0].at} ms before it arrived, not when the words began`));
      await page.keyboard.press('Shift+R');
      await page.waitForFunction(() => window.__wgVoice.sent.some((m) => m.type === 'end'), null, { timeout: 5000 }).catch(() => fail(t('narrate: stopping the recording did not end narration')));
      if (errors.length) fail(t(`live errors: ${errors.join(' | ')}`));
      await context.close();
    }
  }
} finally {
  await browser.close();
  gateway.kill('SIGTERM');
}

if (failures.length) {
  console.error(`Voice sweep failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`Voice sweep passed. Screenshots in ${out}`);

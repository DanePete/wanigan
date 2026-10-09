// The hidden window every comparable render uses (live-capture.ts). Windows cannot be opened under this test
// runner; what is checked here are the rules a change could quietly undo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { folderOf, inHiddenWindow } from './live-capture.ts';
import { captureInWindow } from './live-library.ts';

test('a hidden window is given a page before the debugger acts on it: the first Emulation command on an empty one crashes Electron', () => {
  // Reproduced end to end on a demo site on 9 October 2026; this keeps the line that stops it above the attach.
  const src = inHiddenWindow.toString();
  const blank = src.indexOf("loadURL('about:blank')"), attach = src.indexOf("attach('1.3')"), emulate = src.indexOf('await metrics(screen)');
  assert.ok(blank > 0 && attach > blank && emulate > attach, 'about:blank is loaded before the debugger attaches and emulates');
  assert.match(captureInWindow.toString(), /inHiddenWindow/, 'the library’s pictures render through it');
});

test('pictures are taken through the protocol at one device pixel per CSS pixel, never capturePage', () => {
  const src = inHiddenWindow.toString();
  assert.match(src, /deviceScaleFactor: 1/);
  assert.match(src, /Page\.captureScreenshot/);
  assert.doesNotMatch(src, /capturePage\(/);
});

test('a project’s folder name keeps only safe characters, and a hash keeps two projects apart', () => {
  assert.match(folderOf('p1'), /^p1-[0-9a-f]{8}$/);
  assert.notEqual(folderOf('a/b'), folderOf('ab'));
  assert.doesNotMatch(folderOf('../../etc'), /[./]/);
});

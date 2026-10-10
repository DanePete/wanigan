import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainSaid } from './ipc-error.ts';

test('what main threw reaches the window as main said it, without Electron’s words in front', () => {
  assert.equal(mainSaid("Error invoking remote method 'live:layerVerify': Error: Not in the site yet: the site does not render it as designed yet."),
    'Not in the site yet: the site does not render it as designed yet.');
  assert.equal(mainSaid("Error invoking remote method 'live:go': TypeError: That is not an address."), 'That is not an address.');
  assert.equal(mainSaid("Error invoking remote method 'live:hide': no error name"), 'no error name');
  assert.equal(mainSaid('The live view is off.'), 'The live view is off.', 'a message without them is left alone');
  assert.equal(mainSaid("Said: Error invoking remote method 'x': Error: y"), "Said: Error invoking remote method 'x': Error: y", 'only at the start');
});

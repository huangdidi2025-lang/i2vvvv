import { test } from 'node:test';
import assert from 'node:assert';
import { isFlowTab } from '../lib/cdp.js';

test('isFlowTab: matches Flow project URL', () => {
  assert.strictEqual(isFlowTab({ url: 'https://labs.google/fx/tools/flow/project/abc123' }), true);
});

test('isFlowTab: matches Flow tools path', () => {
  assert.strictEqual(isFlowTab({ url: 'https://labs.google/fx/tools/flow' }), true);
});

test('isFlowTab: rejects non-Flow tabs', () => {
  assert.strictEqual(isFlowTab({ url: 'https://google.com' }), false);
  assert.strictEqual(isFlowTab({ url: 'https://labs.google/other' }), false);
});

test('isFlowTab: rejects tabs without url', () => {
  assert.strictEqual(isFlowTab({}), false);
  assert.strictEqual(isFlowTab(null), false);
});

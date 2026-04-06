import { test } from 'node:test';
import assert from 'node:assert';
import { serializeCheckpoint, deserializeCheckpoint, isExpired } from '../../i2v_extension/lib/checkpoint.js';

test('serializeCheckpoint: 剥离 rows 中的 image_base64', () => {
  const state = {
    phase: 'phase1',
    rows: [
      { row_n: 1, prompt: 'p1', image_base64: 'AAAAAA' },
      { row_n: 2, prompt: 'p2', image_data_url: 'data:image/png;base64,xxx' },
    ],
  };
  const c = serializeCheckpoint(state);
  assert.strictEqual(c.rows[0].image_base64, undefined);
  assert.strictEqual(c.rows[0].prompt, 'p1');
  assert.strictEqual(c.rows[1].image_data_url, undefined);
  assert.strictEqual(c.rows[1].prompt, 'p2');
  assert.ok(c.savedAt);
});

test('serializeCheckpoint: 非对象输入抛错', () => {
  assert.throws(() => serializeCheckpoint(null), /must be an object/);
});

test('deserializeCheckpoint: 处理字符串和对象', () => {
  assert.deepStrictEqual(deserializeCheckpoint('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(deserializeCheckpoint({ a: 1 }), { a: 1 });
  assert.strictEqual(deserializeCheckpoint(null), null);
  assert.strictEqual(deserializeCheckpoint('not json'), null);
});

test('isExpired: 缺 savedAt 返回 true', () => {
  assert.strictEqual(isExpired(null), true);
  assert.strictEqual(isExpired({}), true);
});

test('isExpired: 新 checkpoint 返回 false', () => {
  assert.strictEqual(isExpired({ savedAt: new Date().toISOString() }), false);
});

test('isExpired: 旧 checkpoint 返回 true', () => {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isExpired({ savedAt: old }), true);
});

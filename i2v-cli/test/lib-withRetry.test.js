import { test } from 'node:test';
import assert from 'node:assert';
import { withRetry } from '../../i2v_extension/lib/withRetry.js';

test('withRetry: 函数成功时立即返回', async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return 'ok'; });
  assert.strictEqual(r, 'ok');
  assert.strictEqual(calls, 1);
});

test('withRetry: 暂态错误重试后成功', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('timeout reached');
    return 'finally';
  }, { delays: [1, 1, 1], sleepImpl: () => Promise.resolve() });
  assert.strictEqual(r, 'finally');
  assert.strictEqual(calls, 3);
});

test('withRetry: 非暂态错误立即抛出', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('permission denied'); },
              { sleepImpl: () => Promise.resolve() }),
    /permission denied/
  );
  assert.strictEqual(calls, 1);
});

test('withRetry: 重试用完后放弃', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('timeout'); },
              { retries: 2, delays: [1,1,1], sleepImpl: () => Promise.resolve() }),
    /timeout/
  );
  assert.strictEqual(calls, 3);
});

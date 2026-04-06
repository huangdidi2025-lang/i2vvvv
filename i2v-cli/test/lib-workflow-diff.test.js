import { test } from 'node:test';
import assert from 'node:assert';
import { diffWorkflowIds, pickFirstNewWorkflow } from '../../i2v_extension/lib/workflow-diff.js';

test('diffWorkflowIds: before 空，after 有数据', () => {
  assert.deepStrictEqual(diffWorkflowIds({}, { a: [], b: [] }).sort(), ['a', 'b']);
});

test('diffWorkflowIds: 相同 map 返回空', () => {
  assert.deepStrictEqual(diffWorkflowIds({ a: [] }, { a: [] }), []);
});

test('diffWorkflowIds: 只返回新 key', () => {
  assert.deepStrictEqual(diffWorkflowIds({ a: [] }, { a: [], b: [] }), ['b']);
});

test('diffWorkflowIds: 处理 null 输入', () => {
  assert.deepStrictEqual(diffWorkflowIds(null, { a: [] }), ['a']);
  assert.deepStrictEqual(diffWorkflowIds({ a: [] }, null), []);
});

test('pickFirstNewWorkflow: 返回第一个新增或 null', () => {
  assert.strictEqual(pickFirstNewWorkflow({}, { x: [] }), 'x');
  assert.strictEqual(pickFirstNewWorkflow({ x: [] }, { x: [] }), null);
});

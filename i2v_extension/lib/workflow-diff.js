// 对比两份 project-cache 快照，返回 `after` 里有但 `before` 里没有的
// workflowId。Phase 1 用这个来检测一行刚提交后被分配了哪个 workflowId
// （生产版本内联在 content.js processRow 里；这里是纯版本用于测试）。

export function diffWorkflowIds(beforeMap, afterMap) {
  if (!afterMap || typeof afterMap !== 'object') return [];
  if (!beforeMap || typeof beforeMap !== 'object') beforeMap = {};
  const added = [];
  for (const wfId of Object.keys(afterMap)) {
    if (!beforeMap[wfId]) added.push(wfId);
  }
  return added;
}

export function pickFirstNewWorkflow(beforeMap, afterMap) {
  const added = diffWorkflowIds(beforeMap, afterMap);
  return added[0] || null;
}

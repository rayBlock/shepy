import {projectPiContextHealth, projectClaudeContextHealth} from '/Users/ray/dev/shepy/dist/src/agent-history/context-health.js';

// Synthetic metadata only; no real transcript content or live harness mutation.
const timestamp = '2026-09-13T14:20:00.000Z';
const entries = (values: Record<string, unknown>[]) => values.map((value, i) => ({value: {timestamp, ...value}, line: i + 1}));
const pi = entries([
 {type: 'session', id: 'manager-pi', version: 3},
 {type: 'model_change', id: 'm', parentId: null, modelId: 'A', provider: 'test'},
 {type: 'message', id: 'a', parentId: 'm', message: {role: 'assistant', model: 'A', provider: 'test', usage: {input: 100, cacheRead: 0, cacheWrite: 0}}},
 {type: 'message', id: 'b', parentId: 'a', message: {role: 'assistant', model: 'A', provider: 'test', usage: {input: 200, cacheRead: 0, cacheWrite: 0}}},
 {type: 'branch_summary', id: 'r', parentId: 'a', fromId: 'b'},
 {type: 'message', id: 'u', parentId: 'r', message: {role: 'user', content: [{type: 'text', text: 'synthetic continuation'}]}},
]);
const claude = entries([
 {type: 'assistant', uuid: 'a', sessionId: 'manager-claude', gitBranch: 'main', message: {role: 'assistant', model: 'A', usage: {input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}}},
 {type: 'assistant', uuid: 'c', sessionId: 'child-claude', gitBranch: 'child-branch', isSidechain: true, message: {role: 'assistant', model: 'B', usage: {input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}}},
]);
const beforeUser = projectPiContextHealth('synthetic-pi.jsonl', pi.slice(0, -1));
const afterUser = projectPiContextHealth('synthetic-pi.jsonl', pi);
const managerOnly = projectClaudeContextHealth('synthetic-claude.jsonl', claude.slice(0, -1));
const withSidechain = projectClaudeContextHealth('synthetic-claude.jsonl', claude);
console.log(JSON.stringify({
 candidate: '36fe131',
 piBranchBoundaryPersistence: {
   expected: 'Appending a user entry without fresh usage must not make the pre-branch reading current again.',
   beforeUser: beforeUser.usage,
   afterUser: afterUser.usage,
   pass: !beforeUser.usage.current && !afterUser.usage.current,
 },
 claudeSidechainIdentityIsolation: {
   expected: 'A child sidechain must not replace manager session identity/branch or alter the manager reading.',
   managerOnly: {sessionId: managerOnly.sessionId, branch: managerOnly.branch, usage: managerOnly.usage},
   withSidechain: {sessionId: withSidechain.sessionId, branch: withSidechain.branch, usage: withSidechain.usage},
   pass: withSidechain.sessionId === managerOnly.sessionId && withSidechain.branch === managerOnly.branch && withSidechain.usage.current === managerOnly.usage.current,
 },
}, null, 2));

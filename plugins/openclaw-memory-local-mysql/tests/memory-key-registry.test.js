const test = require('node:test');
const assert = require('node:assert/strict');

const { MEMORY_KEY_RULES, isSingleActiveKey, getMemoryKeyRule } = require('../dist/key-registry.js');

test('key registry covers phase spec core keys', () => {
  const required = [
    'user.output.style',
    'user.output.length',
    'user.output.format',
    'plugin.path.knowledgebase',
    'plugin.path.memory',
    'project.path.root',
    'deployment.no_direct_ports',
    'workflow.dispatch.architect_first',
    'workflow.reply.include_verification_steps',
    'project.openclaw_memory.official_path',
    'session.task.current_goal'
  ];

  const keySet = new Set(MEMORY_KEY_RULES.map((x) => x.key));
  for (const k of required) {
    assert.ok(keySet.has(k), `missing required key: ${k}`);
  }
});

test('single active key rules are correct for core keys', () => {
  assert.equal(isSingleActiveKey('user.output.style'), true);
  assert.equal(isSingleActiveKey('plugin.path.knowledgebase'), true);
  assert.equal(isSingleActiveKey('workflow.reply.include_verification_steps'), true);
  assert.equal(isSingleActiveKey('user.output.examples'), false);
  assert.equal(isSingleActiveKey('session.task.current_step'), false);
  assert.equal(isSingleActiveKey('not.exists.key'), false);
});

test('getMemoryKeyRule returns stable defaults', () => {
  const r1 = getMemoryKeyRule('project.openclaw_memory.official_path');
  assert.equal(r1.scopeDefault, 'project');
  assert.equal(r1.uniqueness, 'single_active');

  const r2 = getMemoryKeyRule('session.task.current_step');
  assert.equal(r2.scopeDefault, 'session');
  assert.equal(r2.uniqueness, 'multi_active');
});

export type MemoryScope = 'global' | 'project' | 'session';

export type KeyUniqueness = 'single_active' | 'multi_active';

export interface MemoryKeyRule {
  key: string;
  domain: 'user' | 'plugin' | 'project' | 'environment' | 'deployment' | 'workflow' | 'session';
  scopeDefault: MemoryScope;
  uniqueness: KeyUniqueness;
}

export const MEMORY_KEY_RULES: MemoryKeyRule[] = [
  // A. 用户偏好
  { key: 'user.output.style', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.output.length', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.output.format', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.output.language', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.output.structure', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.output.greeting', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.output.examples', domain: 'user', scopeDefault: 'global', uniqueness: 'multi_active' },
  { key: 'user.tone.preference', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.feedback.preference', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.decision.preference', domain: 'user', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'user.tool.preference.deploy', domain: 'user', scopeDefault: 'global', uniqueness: 'multi_active' },
  { key: 'user.tool.preference.messaging', domain: 'user', scopeDefault: 'global', uniqueness: 'multi_active' },
  { key: 'user.tool.preference.browser', domain: 'user', scopeDefault: 'global', uniqueness: 'multi_active' },
  { key: 'user.tool.preference.code_execution', domain: 'user', scopeDefault: 'global', uniqueness: 'multi_active' },

  // B. 环境路径
  { key: 'plugin.path.knowledgebase', domain: 'plugin', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'plugin.path.memory', domain: 'plugin', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.path.root', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.path.workspace', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.path.frontend', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.path.backend', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'environment.runtime.gateway_restart_interrupts_session', domain: 'environment', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'environment.runtime.workspace_root', domain: 'environment', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'environment.runtime.os', domain: 'environment', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'environment.runtime.channel', domain: 'environment', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'deployment.compose.required', domain: 'deployment', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'deployment.no_direct_ports', domain: 'deployment', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'deployment.nginx.web_root', domain: 'deployment', scopeDefault: 'global', uniqueness: 'single_active' },

  // C. 工作流
  { key: 'workflow.dispatch.code_modification_required', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'workflow.dispatch.architect_first', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'workflow.dispatch.audit_required', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'workflow.operation.gateway_restart_by_user', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'workflow.operation.sensitive_actions_notify', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'workflow.operation.use_srv_as_official_source', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'workflow.reply.keep_concise', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'workflow.reply.include_verification_steps', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },
  { key: 'workflow.reply.avoid_unnecessary_smalltalk', domain: 'workflow', scopeDefault: 'global', uniqueness: 'single_active' },

  // D. 项目事实
  { key: 'project.openclaw_memory.official_path', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.openclaw_kb.official_path', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.openclaw_memory.plugin_status', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.openclaw_kb.plugin_status', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.known_issue.gateway_restart_interrupts_session', domain: 'project', scopeDefault: 'project', uniqueness: 'multi_active' },
  { key: 'project.known_issue.plugin_load_path_mismatch', domain: 'project', scopeDefault: 'project', uniqueness: 'multi_active' },
  { key: 'project.known_issue.memory_recall_logic', domain: 'project', scopeDefault: 'project', uniqueness: 'multi_active' },
  { key: 'project.architecture.memory_scope_strategy', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },
  { key: 'project.architecture.plugin_source_of_truth', domain: 'project', scopeDefault: 'project', uniqueness: 'single_active' },

  // E. 会话记忆
  { key: 'session.task.current_goal', domain: 'session', scopeDefault: 'session', uniqueness: 'single_active' },
  { key: 'session.task.current_step', domain: 'session', scopeDefault: 'session', uniqueness: 'multi_active' },
  { key: 'session.task.blocker', domain: 'session', scopeDefault: 'session', uniqueness: 'multi_active' },
  { key: 'session.validation.kb_plugin_status', domain: 'session', scopeDefault: 'session', uniqueness: 'multi_active' },
  { key: 'session.validation.memory_plugin_status', domain: 'session', scopeDefault: 'session', uniqueness: 'multi_active' },
  { key: 'session.decision.pending_plan', domain: 'session', scopeDefault: 'session', uniqueness: 'multi_active' },
  { key: 'session.decision.approved_direction', domain: 'session', scopeDefault: 'session', uniqueness: 'multi_active' }
];

const KEY_MAP = new Map(MEMORY_KEY_RULES.map((x) => [x.key, x]));

export function getMemoryKeyRule(key?: string | null): MemoryKeyRule | null {
  if (!key) return null;
  return KEY_MAP.get(key) || null;
}

export function isSingleActiveKey(key?: string | null): boolean {
  const rule = getMemoryKeyRule(key);
  return !!rule && rule.uniqueness === 'single_active';
}

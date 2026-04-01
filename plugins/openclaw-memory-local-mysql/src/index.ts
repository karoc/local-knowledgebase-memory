/**
 * OpenClaw 记忆插件 - 自建 MySQL + Ollama
 * 增强版 v1：支持 scope / memory_key / status / TTL / duplicate-refine-conflict 治理
 */
import type { OpenClawPluginApi, HookEvent, HookContext } from 'openclaw/plugin-sdk';
import { isSingleActiveKey } from './key-registry';

type MemoryScope = 'global' | 'project' | 'session';
type MemoryStatus = 'active' | 'superseded' | 'deleted' | 'conflicted' | 'expired';
type MemorySource = 'manual' | 'auto' | 'inferred' | 'migrated';
type TTLType = 'permanent' | 'temporary' | 'expiring';
type MemoryCategory = 'general' | 'preference' | 'environment' | 'workflow' | 'decision' | 'fact' | 'project_fact' | 'temporary' | 'healthcheck';

type MemoryHealthStatus = 'available' | 'degraded' | 'unavailable';

interface MemoryHealthDetail {
    ok: boolean;
    lastError?: string;
    lastCheckedAt?: number;
    lastSuccessAt?: number;
}

interface MemoryHealth {
    status: MemoryHealthStatus;
    lastError?: string;
    lastCheckedAt?: number;
    lastSuccessAt?: number;
    mysql: MemoryHealthDetail;
    ollama: MemoryHealthDetail;
}


interface PluginConfig {
    mysql: { host: string; port: number; user: string; password: string; database: string };
    ollama: { baseUrl: string; model: string; dimensions: number };
    autoRecall?: boolean;
    autoCapture?: boolean;
    minRecallScore?: number;
    sessionTtlDays?: number;
    rankingMode?: 'legacy' | 'hybrid';
    rankingDebug?: boolean;
}

interface MemoryRecord {
    id: number;
    agent_id: string;
    project_id?: string | null;
    session_key?: string | null;
    content: string;
    vector: string | number[];
    category: string;
    importance: number;
    valid: number;
    scope?: string | null;
    subject?: string | null;
    memory_key?: string | null;
    status?: string | null;
    source?: string | null;
    confidence?: number | string | null;
    supersedes_id?: number | null;
    replaced_by_id?: number | null;
    ttl_type?: string | null;
    expires_at?: string | null;
    tags_json?: string | null;
    use_count?: number | null;
    last_used_at?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
}

interface StoreParams {
    content: string;
    category?: MemoryCategory;
    importance?: number;
    scope?: MemoryScope;
    projectId?: string;
    sessionKey?: string;
    memoryKey?: string;
    source?: MemorySource;
    confidence?: number;
    ttlType?: TTLType;
    expiresAt?: string;
    tags?: string[];
}

interface RecallParams {
    query: string;
    agentId?: string;
    projectId?: string;
    sessionKey?: string;
    scope?: MemoryScope;
    limit?: number;
    minScore?: number;
}

interface ListParams {
    agentId?: string;
    scope?: MemoryScope;
    status?: MemoryStatus;
    projectId?: string;
    sessionKey?: string;
    memoryKey?: string;
    source?: MemorySource;
    limit?: number;
    offset?: number;
}

interface UpdateParams {
    memoryId: number;
    agentId?: string;
    content?: string;
    status?: MemoryStatus;
    confidence?: number;
    tags?: string[];
    importance?: number;
    expiresAt?: string | null;
}

interface ExplainParams {
    memoryId?: number;
    query?: string;
    agentId?: string;
    scope?: MemoryScope;
    projectId?: string;
    sessionKey?: string;
    minScore?: number;
}

interface ForgetParams {
    memoryId: number;
    agentId?: string;
}

class MemoryPlugin {
    private api: OpenClawPluginApi;
    private config: PluginConfig;
    private pool: any = null;
    private health: MemoryHealth = {
        status: 'unavailable',
        lastError: 'not checked yet',
        mysql: { ok: false },
        ollama: { ok: false }
    };
    private healthTimer: any = null;
    private statusManager: any = null;

    constructor(api: OpenClawPluginApi) {
        this.api = api;
        this.config = api.pluginConfig as PluginConfig;
    }

    register() {
        this.initDB();
        this.ensureStatusStorePath();
        this.registerMemoryRuntime();
        this.registerTools();
        if (this.config.autoRecall !== false) this.api.on('before_agent_start', this.onBeforeStart.bind(this));
        if (this.config.autoCapture !== false) this.api.on('agent_end', this.onAgentEnd.bind(this));
        this.startHealthLoop();
        void this.expireSessionMemories().catch((err) => this.api.logger.error('[memory-local] 过期清理失败:', err));
        this.api.logger.info('[memory-local] 记忆插件注册完成');
    }

    private initDB() {
        const mysql = require('mysql2/promise');
        this.pool = mysql.createPool({
            host: this.config.mysql.host,
            port: this.config.mysql.port,
            user: this.config.mysql.user,
            password: this.config.mysql.password,
            database: this.config.mysql.database,
            waitForConnections: true,
            connectionLimit: 10
        });
    }

    private ensureStatusStorePath(agentId = 'main') {
        try {
            const os = require('os');
            const path = require('path');
            const fs = require('fs');
            const stateDir = (this.api as any)?.runtime?.state?.resolveStateDir?.(process.env, os.homedir()) || '';
            if (!stateDir) return;
            const memoryDir = path.join(stateDir, 'memory');
            fs.mkdirSync(memoryDir, { recursive: true });
            const storePath = path.join(memoryDir, `${agentId}.sqlite`);
            if (!fs.existsSync(storePath)) {
                fs.writeFileSync(storePath, '');
            }
            this.api.logger.info('[memory-local] ensured status store path', { storePath });
        } catch (err) {
            this.api.logger.warn('[memory-local] ensure status store path failed', err);
        }
    }

    private registerMemoryRuntime() {
        if (!this.statusManager) this.statusManager = this.buildStatusManager();

        this.api.logger.info('[memory-local] registerMemoryRuntime invoked');

        (this.api as any).registerMemoryRuntime({
            getMemorySearchManager: async () => {
                this.api.logger.info('[memory-local] getMemorySearchManager called', {
                    status: this.health.status,
                    lastError: this.health.lastError
                });
                if (this.health.status === 'unavailable') {
                    return { manager: null, error: this.health.lastError || 'memory plugin unavailable' };
                }
                return { manager: this.statusManager };
            },
            resolveMemoryBackendConfig: () => ({
                backend: 'qmd',
                qmd: {
                    provider: 'mysql',
                    database: this.config.mysql.database
                }
            }),
            closeAllMemorySearchManagers: async () => {
                return;
            }
        });
    }

    private buildStatusManager() {
        return {
            status: () => {
                this.api.logger.info('[memory-local] status() called', {
                    status: this.health.status,
                    lastError: this.health.lastError,
                    mysql: this.health.mysql,
                    ollama: this.health.ollama
                });
                return {
                    backend: 'qmd',
                    provider: 'openclaw-memory-local-mysql',
                    model: this.config.ollama.model,
                    files: 0,
                    chunks: 0,
                    sources: ['memory'],
                    custom: {
                        health: {
                            status: this.health.status,
                            lastError: this.health.lastError,
                            lastCheckedAt: this.health.lastCheckedAt,
                            lastSuccessAt: this.health.lastSuccessAt,
                            mysql: this.health.mysql,
                            ollama: this.health.ollama
                        },
                        mysql: {
                            host: this.config.mysql.host,
                            port: this.config.mysql.port,
                            database: this.config.mysql.database
                        },
                        ollama: {
                            baseUrl: this.config.ollama.baseUrl,
                            model: this.config.ollama.model
                        }
                    }
                };
            },
            probeEmbeddingAvailability: async () => ({
                ok: this.health.ollama.ok,
                error: this.health.ollama.ok ? undefined : (this.health.ollama.lastError || this.health.lastError)
            }),
            probeVectorAvailability: async () => this.health.mysql.ok,
            search: async () => [],
            readFile: async (params: { relPath: string; from?: number; lines?: number }) => ({
                path: params.relPath,
                text: ''
            }),
            close: async () => {
                return;
            }
        };
    }

    private startHealthLoop() {
        const run = () => void this.runHealthCheck().catch((err) => {
            this.health.status = 'unavailable';
            this.health.lastError = String(err);
            this.api.logger.error('[memory-local] health check failed', err);
        });
        run();
        if (this.healthTimer) clearInterval(this.healthTimer);
        this.healthTimer = setInterval(run, 10_000);
    }

    private async runHealthCheck() {
        const now = Date.now();
        const mysql = await this.probeMysql();
        const ollama = await this.probeOllama();

        this.health.mysql = {
            ok: mysql.ok,
            lastError: mysql.error,
            lastCheckedAt: now,
            lastSuccessAt: mysql.ok ? now : this.health.mysql.lastSuccessAt
        };
        this.health.ollama = {
            ok: ollama.ok,
            lastError: ollama.error,
            lastCheckedAt: now,
            lastSuccessAt: ollama.ok ? now : this.health.ollama.lastSuccessAt
        };

        if (mysql.ok && ollama.ok) {
            this.health.status = 'available';
            this.health.lastError = undefined;
            this.health.lastSuccessAt = now;
        } else if (mysql.ok) {
            this.health.status = 'degraded';
            this.health.lastError = ollama.error || 'ollama unavailable';
            this.health.lastSuccessAt = now;
        } else {
            this.health.status = 'unavailable';
            this.health.lastError = mysql.error || 'mysql unavailable';
        }
        this.health.lastCheckedAt = now;
        this.api.logger.info('[memory-local] health updated', {
            status: this.health.status,
            lastError: this.health.lastError,
            mysql: this.health.mysql,
            ollama: this.health.ollama
        });
    }

    private async probeMysql(): Promise<{ ok: boolean; error?: string }> {
        try {
            await this.pool.query('SELECT 1');
            return { ok: true };
        } catch (err) {
            return { ok: false, error: String(err) };
        }
    }

    private async probeOllama(): Promise<{ ok: boolean; error?: string }> {
        try {
            const res = await fetch(`${this.config.ollama.baseUrl}/api/tags`);
            if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: String(err) };
        }
    }

    private registerTools() {
        this.api.registerTool((ctx: HookContext) => ({
            name: 'memory_recall',
            label: '回忆记忆',
            description: '通过向量相似度检索相关记忆',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '检索查询' },
                    agentId: { type: 'string', description: 'Agent ID' },
                    projectId: { type: 'string', description: '项目 ID' },
                    sessionKey: { type: 'string', description: '会话 Key' },
                    scope: { type: 'string', description: '作用域 global/project/session' },
                    limit: { type: 'number', description: '返回数量' },
                    minScore: { type: 'number', description: '最低相似度阈值，可选，默认使用配置或 0.3' }
                },
                required: ['query']
            },
            execute: async (_toolCallId: string, params: RecallParams) =>
                this.handleRecall({ ...params, agentId: params.agentId || ctx?.agentId })
        }));

        this.api.registerTool((ctx: HookContext) => ({
            name: 'memory_store',
            label: '存储记忆',
            description: '存储新的记忆',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: '记忆内容' },
                    category: { type: 'string', description: '分类' },
                    importance: { type: 'number', description: '重要性 1-5' },
                    scope: { type: 'string', description: '作用域 global/project/session' },
                    projectId: { type: 'string', description: '项目 ID' },
                    sessionKey: { type: 'string', description: '会话 Key' },
                    memoryKey: { type: 'string', description: '结构化主题键' },
                    source: { type: 'string', description: '来源 manual/auto/inferred/migrated' },
                    confidence: { type: 'number', description: '置信度 0-1' },
                    ttlType: { type: 'string', description: 'TTL 类型 permanent/temporary/expiring' },
                    expiresAt: { type: 'string', description: '过期时间 ISO 字符串' },
                    tags: { type: 'array', items: { type: 'string' }, description: '标签列表' }
                },
                required: ['content']
            },
            execute: async (_toolCallId: string, params: StoreParams) => this.handleStore(params, ctx?.agentId)
        }));

        this.api.registerTool((ctx: HookContext) => ({
            name: 'memory_forget',
            label: '忘记记忆',
            description: '删除指定记忆',
            parameters: {
                type: 'object',
                properties: {
                    memoryId: { type: 'number', description: '记忆 ID' },
                    agentId: { type: 'string', description: 'Agent ID（可选）' }
                },
                required: ['memoryId']
            },
            execute: async (_toolCallId: string, params: ForgetParams, ctx: any) =>
                this.handleForget({ ...params, agentId: params.agentId || ctx?.agentId })
        }));

        this.api.registerTool((ctx: HookContext) => ({
            name: 'memory_list',
            label: '查询记忆',
            description: '按条件查询记忆列表',
            parameters: {
                type: 'object',
                properties: {
                    agentId: { type: 'string', description: 'Agent ID' },
                    scope: { type: 'string', description: '作用域 global/project/session' },
                    status: { type: 'string', description: '状态 active/superseded/deleted/expired' },
                    projectId: { type: 'string', description: '项目 ID' },
                    sessionKey: { type: 'string', description: '会话 Key' },
                    memoryKey: { type: 'string', description: '结构化键' },
                    source: { type: 'string', description: '来源 manual/auto/inferred/migrated' },
                    limit: { type: 'number', description: '返回数量（默认 20）' },
                    offset: { type: 'number', description: '偏移（默认 0）' }
                }
            },
            execute: async (_toolCallId: string, params: ListParams) =>
                this.handleList({ ...params, agentId: params.agentId || ctx?.agentId })
        }));

        this.api.registerTool((ctx: HookContext) => ({
            name: 'memory_update',
            label: '更新记忆',
            description: '更新记忆内容、状态或元数据',
            parameters: {
                type: 'object',
                properties: {
                    memoryId: { type: 'number', description: '记忆 ID' },
                    agentId: { type: 'string', description: 'Agent ID（可选）' },
                    content: { type: 'string', description: '新内容（可选）' },
                    status: { type: 'string', description: '新状态（可选）' },
                    confidence: { type: 'number', description: '新置信度 0-1（可选）' },
                    tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
                    importance: { type: 'number', description: '重要性 1-5（可选）' },
                    expiresAt: { type: 'string', description: '过期时间 ISO 字符串，null 清空（可选）' }
                },
                required: ['memoryId']
            },
            execute: async (_toolCallId: string, params: UpdateParams, ctx: any) =>
                this.handleUpdate({ ...params, agentId: params.agentId || ctx?.agentId })
        }));

        this.api.registerTool((ctx: HookContext) => ({
            name: 'memory_explain',
            label: '解释记忆',
            description: '解释某条记忆为何被召回或被替代',
            parameters: {
                type: 'object',
                properties: {
                    memoryId: { type: 'number', description: '记忆 ID（优先）' },
                    query: { type: 'string', description: '检索查询（可选）' },
                    agentId: { type: 'string', description: 'Agent ID（可选）' },
                    scope: { type: 'string', description: '作用域过滤（可选）' },
                    projectId: { type: 'string', description: '项目过滤（可选）' },
                    sessionKey: { type: 'string', description: '会话过滤（可选）' },
                    minScore: { type: 'number', description: '最低相似度阈值（可选）' }
                }
            },
            execute: async (_toolCallId: string, params: ExplainParams) =>
                this.handleExplain({ ...params, agentId: params.agentId || ctx?.agentId })
        }));
    }

    private sessionTtlDays(): number {
        return this.config.sessionTtlDays && this.config.sessionTtlDays > 0 ? this.config.sessionTtlDays : 7;
    }

    private async getEmbedding(text: string): Promise<number[]> {
        const res = await fetch(`${this.config.ollama.baseUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.config.ollama.model, prompt: text })
        });
        if (!res.ok) throw new Error(`Ollama error: ${res.statusText}`);
        const data = await res.json() as { embedding: number[] };
        return data.embedding;
    }

    private cosineSim(a: number[], b: number[]): number {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    private rankingMode(): 'legacy' | 'hybrid' {
        return this.config.rankingMode === 'legacy' ? 'legacy' : 'hybrid';
    }

    private toDateMs(value?: string | null): number {
        if (!value) return 0;
        const t = Date.parse(value);
        return Number.isFinite(t) ? t : 0;
    }

    private rankRows(rows: any[], queryEmbedding: number[], minScore: number, limit: number, includeDebug = false) {
        const now = Date.now();
        const mode = this.rankingMode();

        const scored = rows.map((row: any) => {
            const rawVector = row.vector;
            const vec = typeof rawVector === 'string' ? JSON.parse(rawVector) : rawVector;
            const similarity = Array.isArray(vec) ? this.cosineSim(queryEmbedding, vec) : 0;
            const importanceNorm = Math.max(0, Math.min(1, Number(row.importance || 0) / 5));
            const confidence = Math.max(0, Math.min(1, Number(row.confidence || 0)));

            const updatedAtMs = this.toDateMs(row.updated_at || row.last_used_at || row.created_at);
            const ageDays = updatedAtMs > 0 ? Math.max(0, (now - updatedAtMs) / 86400000) : 365;
            const recency = Math.max(0, Math.min(1, 1 / (1 + ageDays / 7)));

            const usageRaw = Number(row.use_count || 0);
            const usage = Math.max(0, Math.min(1, Math.log10(usageRaw + 1) / 2));

            const finalScore = mode === 'legacy'
                ? similarity
                : (0.55 * similarity + 0.15 * importanceNorm + 0.15 * confidence + 0.10 * recency + 0.05 * usage);

            return {
                ...row,
                similarity,
                finalScore,
                breakdown: {
                    similarity,
                    importanceNorm,
                    confidence,
                    recency,
                    usage
                }
            };
        });

        const filtered = scored
            .filter((row: any) => Number.isFinite(row.similarity) && row.similarity >= minScore)
            .sort((a: any, b: any) => {
                if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
                const scopeRank = (s: string) => s === 'project' ? 3 : s === 'global' ? 2 : 1;
                if (scopeRank(b.scope || '') !== scopeRank(a.scope || '')) return scopeRank(b.scope || '') - scopeRank(a.scope || '');
                if ((b.importance || 0) !== (a.importance || 0)) return (b.importance || 0) - (a.importance || 0);
                return (b.id || 0) - (a.id || 0);
            })
            .slice(0, limit)
            .map((row: any) => includeDebug ? row : ({ ...row, breakdown: undefined }));

        return { scored, filtered };
    }

    private normalizeText(text: string): string {
        return text.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    private inferMemoryKey(content: string, category: string, scope: MemoryScope): { memoryKey: string | null; subject: string | null } {
        const text = content.toLowerCase();

        if (/知识库插件.*(路径|目录)|plugin.*knowledgebase|openclaw-knowledgebase-local-mysql/.test(text)) {
            return { memoryKey: 'plugin.path.knowledgebase', subject: 'plugin' };
        }
        if (/记忆插件.*(路径|目录)|plugin.*memory|openclaw-memory-local-mysql/.test(text)) {
            return { memoryKey: 'plugin.path.memory', subject: 'plugin' };
        }
        if (/正式插件路径|插件正式路径|正式目录.*插件/.test(text)) {
            return { memoryKey: 'env.path.primary_plugin', subject: 'environment' };
        }
        if (/正式项目路径|项目正式路径|正式目录.*项目/.test(text)) {
            return { memoryKey: 'env.path.primary_project', subject: 'environment' };
        }
        if (/极简输出|简洁输出|精简输出/.test(text)) {
            return { memoryKey: 'user.output.style', subject: 'user' };
        }
        if (/详细输出|详细一点|展开说明/.test(text)) {
            return { memoryKey: 'user.output.style', subject: 'user' };
        }
        if (/markdown/.test(text)) {
            return { memoryKey: 'user.output.format', subject: 'user' };
        }
        if (/不要寒暄|不需要寒暄|别寒暄/.test(text)) {
            return { memoryKey: 'user.output.greeting', subject: 'user' };
        }
        if (/验证步骤|验证命令/.test(text)) {
            return { memoryKey: 'workflow.reply.include_verification_steps', subject: 'workflow' };
        }
        if (/重启网关.*断开|gateway restart.*disconnect|重启.*会话.*断开/.test(text)) {
            return { memoryKey: 'workflow.gateway.restart_interrupts_session', subject: 'workflow' };
        }
        if (/网关重启由用户执行|网关必须由用户执行|用户执行网关重启/.test(text)) {
            return { memoryKey: 'workflow.gateway.restart.by_user', subject: 'workflow' };
        }
        if (/正式目录优先\s*\/srv|优先\s*\/srv|\/srv优先/.test(text)) {
            return { memoryKey: 'workflow.path.prefer_srv', subject: 'workflow' };
        }
        if (/docker-compose|compose 编排/.test(text)) {
            return { memoryKey: 'deployment.compose.required', subject: 'environment' };
        }
        if (/端口.*不允许暴露|不允许暴露端口/.test(text)) {
            return { memoryKey: 'deployment.no_direct_ports', subject: 'environment' };
        }

        if (scope === 'session') {
            return { memoryKey: null, subject: 'session' };
        }

        if (category === 'preference') return { memoryKey: null, subject: 'user' };
        if (category === 'environment') return { memoryKey: null, subject: 'environment' };
        if (category === 'workflow') return { memoryKey: null, subject: 'workflow' };
        return { memoryKey: null, subject: null };
    }

    private needsUniqueActive(key: string | null): boolean {
        return isSingleActiveKey(key);
    }

    private isConflict(oldContent: string, newContent: string, memoryKey: string | null): boolean {
        if (!memoryKey) return false;
        const oldText = this.normalizeText(oldContent);
        const newText = this.normalizeText(newContent);
        if (oldText === newText) return false;

        if (memoryKey === 'user.output.style') {
            const conciseWords = /(极简|简洁|精简)/;
            const detailedWords = /(详细|展开|详尽)/;
            if ((conciseWords.test(oldText) && detailedWords.test(newText)) || (detailedWords.test(oldText) && conciseWords.test(newText))) {
                return true;
            }
        }

        if (memoryKey.startsWith('plugin.path.') || memoryKey.startsWith('deployment.') || memoryKey.startsWith('workflow.')) {
            return oldText !== newText;
        }

        return false;
    }

    private async expireSessionMemories() {
        await this.pool.execute(
            `UPDATE memories
             SET status = 'expired', valid = 0
             WHERE status = 'active'
               AND expires_at IS NOT NULL
               AND expires_at <= NOW()`
        );
    }

    private async fetchActiveByKey(agentId: string, scope: MemoryScope, memoryKey: string, projectId?: string, sessionKey?: string): Promise<MemoryRecord[]> {
        let sql = `SELECT * FROM memories WHERE agent_id = ? AND scope = ? AND memory_key = ? AND valid = 1 AND status = 'active'`;
        const params: any[] = [agentId, scope, memoryKey];
        if (scope === 'project') {
            sql += ' AND project_id <=> ?';
            params.push(projectId || null);
        }
        if (scope === 'session') {
            sql += ' AND session_key <=> ?';
            params.push(sessionKey || null);
        }
        sql += ` AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id DESC`;
        const [rows] = await this.pool.query(sql, params);
        return Array.isArray(rows) ? rows as MemoryRecord[] : [];
    }

    private async supersedeRecords(oldIds: number[], newId: number, executor?: any) {
        if (!oldIds.length) return;
        const conn = executor || this.pool;
        await conn.query(
            `UPDATE memories SET status = 'superseded', valid = 0, replaced_by_id = ?, updated_at = NOW() WHERE id IN (${oldIds.map(() => '?').join(',')})`,
            [newId, ...oldIds]
        );
        await conn.execute(
            `UPDATE memories SET supersedes_id = ?, updated_at = NOW() WHERE id = ?`,
            [oldIds[0], newId]
        );
    }

    private extractStructuredValues(content: string, memoryKey: string | null): Record<string, any> {
        const text = content || '';
        const lower = text.toLowerCase();
        const out: Record<string, any> = {};

        if (!memoryKey) return out;

        if (memoryKey.startsWith('plugin.path.') || memoryKey.startsWith('project.path.') || memoryKey.includes('.official_path') || memoryKey === 'deployment.nginx.web_root') {
            const pathMatch = text.match(/(\/[A-Za-z0-9._\-/]+)/);
            if (pathMatch) out.path = pathMatch[1];
            if (/(^|\W)\/srv(\W|$)/.test(text)) out.locationHint = 'srv';
            if (/workspace/.test(lower)) out.locationHint = 'workspace';
            const pluginMatch = text.match(/openclaw-[a-z0-9-]+/i);
            if (pluginMatch) out.pluginName = pluginMatch[0].toLowerCase();
        }

        if (memoryKey.startsWith('user.output.') || memoryKey === 'user.tone.preference') {
            if (/(极简|简洁|精简)/.test(text)) out.style = 'concise';
            if (/(详细|展开|详尽)/.test(text)) out.style = 'detailed';
            if (/markdown/i.test(text)) out.format = 'markdown';
            if (/(中文|chinese)/i.test(text)) out.language = 'chinese';
            if (/(不要寒暄|不需要寒暄|别寒暄)/.test(text)) out.greeting = 'no_greeting';
        }

        if (memoryKey.startsWith('workflow.') || memoryKey.startsWith('deployment.') || memoryKey.startsWith('environment.runtime.')) {
            if (/网关重启由用户执行|必须由用户执行|用户执行网关重启/.test(text)) out.gateway_restart_by_user = true;
            if (/不允许暴露端口/.test(text)) out.no_direct_ports = true;
            if (/docker-compose|compose 编排/i.test(text)) out.compose_required = true;
            if (/优先\s*\/srv|\/srv优先/.test(text)) out.prefer_srv = true;
        }

        return out;
    }

    private detectConflictByStructuredValues(oldValues: Record<string, any>, newValues: Record<string, any>): boolean {
        if (!oldValues || !newValues) return false;

        if (oldValues.path && newValues.path && oldValues.path !== newValues.path) return true;
        if (oldValues.style && newValues.style && oldValues.style !== newValues.style) return true;
        if (typeof oldValues.gateway_restart_by_user === 'boolean' && typeof newValues.gateway_restart_by_user === 'boolean' && oldValues.gateway_restart_by_user !== newValues.gateway_restart_by_user) return true;
        if (typeof oldValues.no_direct_ports === 'boolean' && typeof newValues.no_direct_ports === 'boolean' && oldValues.no_direct_ports !== newValues.no_direct_ports) return true;

        return false;
    }

    private decideRelation(oldContent: string, newContent: string, memoryKey: string | null, similarity: number) {
        const oldValues = this.extractStructuredValues(oldContent, memoryKey);
        const newValues = this.extractStructuredValues(newContent, memoryKey);

        if (similarity >= 0.95 && !this.detectConflictByStructuredValues(oldValues, newValues)) {
            return 'duplicate' as const;
        }

        if (this.detectConflictByStructuredValues(oldValues, newValues) || this.isConflict(oldContent, newContent, memoryKey)) {
            return 'conflict' as const;
        }

        const oldLen = oldContent.trim().length;
        const newLen = newContent.trim().length;
        if (similarity >= 0.6 && newLen > oldLen) {
            return 'refine' as const;
        }

        return 'unrelated' as const;
    }

    private async insertMemory(agentId: string, params: Required<Pick<StoreParams, 'content'>> & {
        category: string;
        importance: number;
        scope: MemoryScope;
        projectId?: string;
        sessionKey?: string;
        memoryKey?: string | null;
        source: MemorySource;
        confidence: number;
        ttlType: TTLType;
        expiresAt?: string | null;
        tagsJson?: string | null;
        status: MemoryStatus;
        subject?: string | null;
    }, executor?: any, embedding?: number[]): Promise<number> {
        const emb = embedding || await this.getEmbedding(params.content);
        const conn = executor || this.pool;
        const [result]: any = await conn.execute(
            `INSERT INTO memories
            (agent_id, project_id, session_key, content, vector, category, importance, valid, scope, subject, memory_key, status, source, confidence, ttl_type, expires_at, tags_json, use_count, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
            [
                agentId,
                params.projectId || null,
                params.sessionKey || null,
                params.content,
                JSON.stringify(emb),
                params.category,
                params.importance,
                params.scope,
                params.subject || null,
                params.memoryKey || null,
                params.status,
                params.source,
                params.confidence,
                params.ttlType,
                params.expiresAt || null,
                params.tagsJson || null
            ]
        );
        return result.insertId;
    }

    private resolveSessionExpiry(scope: MemoryScope, ttlType?: TTLType, expiresAt?: string): { ttlType: TTLType; expiresAt: string | null } {
        if (expiresAt) return { ttlType: ttlType || 'expiring', expiresAt };
        if (scope === 'session') {
            const d = new Date();
            d.setDate(d.getDate() + this.sessionTtlDays());
            return { ttlType: ttlType || 'expiring', expiresAt: d.toISOString().slice(0, 19).replace('T', ' ') };
        }
        return { ttlType: ttlType || 'permanent', expiresAt: null };
    }

    private buildMemoryLockName(agentId: string, scope: MemoryScope, memoryKey: string, projectId?: string, sessionKey?: string): string {
        const base = `${agentId}|${scope}|${memoryKey}|${projectId || ''}|${sessionKey || ''}`;
        const safe = base.replace(/[^a-zA-Z0-9|:_-]/g, '_');
        return `mem_lock:${safe}`.slice(0, 63);
    }

    private detectAutoCategory(msg: string): MemoryCategory {
        if (/喜欢|爱好|偏好/.test(msg)) return 'preference';
        if (/记住|别忘|以后都|默认/.test(msg)) return 'decision';
        if (/路径|目录|插件|\/srv|workspace|docker-compose|端口/.test(msg)) return 'environment';
        if (/流程|必须|重启网关|验证步骤/.test(msg)) return 'workflow';
        return 'general';
    }

    private detectAutoScope(msg: string): MemoryScope {
        // 临时上下文默认进入 session scope（7 天 TTL）
        if (/当前会话|本次会话|这次会话|临时|仅本次|先记一下|只在这次/.test(msg)) {
            return 'session';
        }
        return 'global';
    }

    private shouldAutoCapture(msg: string): boolean {
        const patterns = [
            /我喜欢|我的爱好|我偏好/,
            /我是|我的工作是|我从事/,
            /记住|别忘了|以后都|默认/,
            /路径|目录|插件正式|走\s*\/srv|走\s*workspace/,
            /重启网关.*断开|验证步骤|docker-compose|不允许暴露端口/
        ];
        return patterns.some(p => p.test(msg));
    }

    private async onBeforeStart(event: HookEvent, ctx: HookContext) {
        try {
            const msg = event.messages?.[0]?.content || '';
            if (!msg || msg.length < 5) return {};
            const agentId = ctx.agentId || 'default';
            const qEmb = await this.getEmbedding(msg);
            let sql = `SELECT id, content, vector, category, scope, subject, memory_key, importance, confidence, project_id, session_key
                       FROM memories
                       WHERE agent_id = ?
                         AND valid = 1
                         AND status = 'active'
                         AND (expires_at IS NULL OR expires_at > NOW())`;
            const params: any[] = [agentId];
            if (ctx.projectId) {
                sql += ' AND (project_id = ? OR project_id IS NULL)';
                params.push(ctx.projectId);
            }
            if (ctx.sessionKey) {
                sql += ' AND (session_key = ? OR session_key IS NULL)';
                params.push(ctx.sessionKey);
            }
            const [rows]: any = await this.pool.query(sql, params);
            const minScore = this.config.minRecallScore || 0.3;
            const scored = (rows as MemoryRecord[]).map((r: any) => {
                const vec = typeof r.vector === 'string' ? JSON.parse(r.vector) : r.vector;
                return { ...r, vec, score: Array.isArray(vec) ? this.cosineSim(qEmb, vec) : 0 };
            }).filter((r: any) => r.score >= minScore)
              .sort((a: any, b: any) => {
                  const scopeRank = (s: string) => s === 'project' ? 3 : s === 'global' ? 2 : 1;
                  if (scopeRank(b.scope || '') !== scopeRank(a.scope || '')) return scopeRank(b.scope || '') - scopeRank(a.scope || '');
                  if ((b.importance || 0) !== (a.importance || 0)) return (b.importance || 0) - (a.importance || 0);
                  return b.score - a.score;
              })
              .slice(0, 8);
            if (scored.length) {
                const ctxText = scored.map((m: any) => `[记忆-${m.category}${m.memory_key ? `:${m.memory_key}` : ''}] ${m.content}`).join('\n');
                return { prependContext: `以下是你之前记住的相关信息:\n${ctxText}\n` };
            }
        } catch (e) { this.api.logger.error('[memory-local] 召回失败:', e); }
        return {};
    }

    private async onAgentEnd(event: HookEvent, ctx: HookContext) {
        try {
            const msg = event.messages?.[0]?.content || '';
            if (!msg || msg.length < 10) return;
            if (!this.shouldAutoCapture(msg)) return;
            const scope: MemoryScope = this.detectAutoScope(msg);
            const category = this.detectAutoCategory(msg);
            const { memoryKey, subject } = this.inferMemoryKey(msg, category, scope);
            await this.handleStore({
                content: msg,
                category,
                importance: 3,
                scope,
                projectId: ctx.projectId,
                sessionKey: ctx.sessionKey,
                memoryKey: memoryKey || undefined,
                source: 'auto',
                confidence: 0.85
            }, ctx.agentId || 'default');
            this.api.logger.info(`[memory-local] 自动捕获新记忆 scope=${scope}${memoryKey ? ` key=${memoryKey}` : ''}${subject ? ` subject=${subject}` : ''}`);
        } catch (e) { this.api.logger.error('[memory-local] 捕获失败:', e); }
    }

    async handleRecall(params: RecallParams) {
        const { query, agentId = 'default', projectId, sessionKey, scope, limit = 5, minScore } = params;
        const qEmb = await this.getEmbedding(query);
        let sql = `SELECT id, content, vector, category, agent_id, valid, scope, subject, memory_key, importance, confidence, project_id, session_key, use_count, last_used_at, created_at, updated_at
                   FROM memories
                   WHERE agent_id = ?
                     AND valid = 1
                     AND status = 'active'
                     AND (expires_at IS NULL OR expires_at > NOW())`;
        const queryParams: any[] = [agentId];
        if (scope) {
            sql += ' AND scope = ?';
            queryParams.push(scope);
        }
        if (projectId) {
            sql += ' AND (project_id = ? OR project_id IS NULL)';
            queryParams.push(projectId);
        }
        if (sessionKey) {
            sql += ' AND (session_key = ? OR session_key IS NULL)';
            queryParams.push(sessionKey);
        }
        sql += ' ORDER BY id DESC';
        const [rows]: any = await this.pool.query(sql, queryParams);
        const scoreThreshold = typeof minScore === 'number'
            ? minScore
            : (typeof this.config.minRecallScore === 'number' ? this.config.minRecallScore : 0.3);

        const includeDebug = this.config.rankingDebug === true;
        const { scored, filtered } = this.rankRows(Array.isArray(rows) ? rows : [], qEmb, scoreThreshold, Math.max(limit, 12), includeDebug);

        if (!filtered.length) {
            const best = scored.sort((a: any, b: any) => b.similarity - a.similarity)[0] as any;
            if (best) {
                this.api.logger.info(`[memory-local] recall miss: agentId=${agentId}, threshold=${scoreThreshold}, bestSimilarity=${best.similarity.toFixed(4)}, bestId=${best.id}`);
            }
            return { content: [{ type: 'text', text: '未找到相关记忆' }] };
        }

        const isRuleRow = (row: any) => {
            const key = String(row.memory_key || '');
            const cat = String(row.category || '');
            if (['preference', 'environment', 'workflow', 'decision'].includes(cat)) return true;
            return key.startsWith('user.') || key.startsWith('workflow.') || key.startsWith('environment.') || key.startsWith('deployment.');
        };
        const isProjectFactRow = (row: any) => {
            const key = String(row.memory_key || '');
            const cat = String(row.category || '');
            return cat === 'project_fact' || key.startsWith('project.');
        };

        const ruleRows = filtered.filter(isRuleRow).slice(0, 5);
        const projectFactRows = filtered.filter((row: any) => !ruleRows.some((x: any) => x.id === row.id) && isProjectFactRow(row)).slice(0, 5);
        const vectorRows = filtered.filter((row: any) => !ruleRows.some((x: any) => x.id === row.id) && !projectFactRows.some((x: any) => x.id === row.id)).slice(0, 5);

        const finalRows = [...ruleRows, ...projectFactRows, ...vectorRows].slice(0, limit);

        const ids = finalRows.map((row: any) => row.id);
        if (ids.length) {
            await this.pool.query(
                `UPDATE memories SET use_count = COALESCE(use_count, 0) + 1, last_used_at = NOW(), updated_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
        }

        const lines = finalRows.map((row: any) => {
            const score = this.rankingMode() === 'legacy' ? row.similarity : row.finalScore;
            const layer = isRuleRow(row) ? 'rule' : (isProjectFactRow(row) ? 'project_fact' : 'vector');
            const keyPart = row.memory_key ? ` key=${row.memory_key}` : '';
            const base = `[${score.toFixed(2)}][${layer}]${keyPart} ${row.content} (${row.category})`;
            if (!includeDebug) return base;
            return `${base}\n  debug=${JSON.stringify(row.breakdown)}`;
        });

        return {
            content: [{
                type: 'text',
                text: lines.join('\n\n')
            }]
        };
    }

    async handleStore(params: StoreParams, forcedAgentId?: string) {
        const agentId = forcedAgentId || 'default';
        const content = params.content;
        const category = params.category || 'general';
        const importance = params.importance || 3;
        const scope: MemoryScope = params.scope || 'global';
        const source: MemorySource = params.source || 'manual';
        const confidenceRaw = typeof params.confidence === 'number' ? params.confidence : 0.9;
        const confidence = Math.max(0, Math.min(1, confidenceRaw));
        const inferred = this.inferMemoryKey(content, category, scope);
        const memoryKey = params.memoryKey || inferred.memoryKey || null;
        const subject = inferred.subject;
        const ttl = this.resolveSessionExpiry(scope, params.ttlType, params.expiresAt);
        const tagsJson = params.tags ? JSON.stringify(params.tags) : null;

        if (memoryKey && this.needsUniqueActive(memoryKey)) {
            const conn = await this.pool.getConnection();
            const lockName = this.buildMemoryLockName(agentId, scope, memoryKey, params.projectId, params.sessionKey);
            try {
                const [lockRows]: any = await conn.query('SELECT GET_LOCK(?, 5) AS got_lock', [lockName]);
                const gotLock = Array.isArray(lockRows) && lockRows[0] && Number(lockRows[0].got_lock) === 1;
                if (!gotLock) {
                    throw new Error(`failed to acquire memory lock: ${lockName}`);
                }

                await conn.beginTransaction();
                const emb = await this.getEmbedding(content);

                let lockSql = `SELECT * FROM memories WHERE agent_id = ? AND scope = ? AND memory_key = ? AND valid = 1 AND status = 'active'`;
                const lockParams: any[] = [agentId, scope, memoryKey];
                if (scope === 'project') {
                    lockSql += ' AND project_id <=> ?';
                    lockParams.push(params.projectId || null);
                }
                if (scope === 'session') {
                    lockSql += ' AND session_key <=> ?';
                    lockParams.push(params.sessionKey || null);
                }
                lockSql += ` AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id DESC`;

                const [lockedRows] = await conn.query(lockSql, lockParams);
                const existing = Array.isArray(lockedRows) ? lockedRows as MemoryRecord[] : [];

                let relation: 'duplicate' | 'refine' | 'conflict' | 'unrelated' = 'unrelated';
                if (existing.length) {
                    const latest = existing[0];
                    const oldEmb = typeof latest.vector === 'string' ? JSON.parse(latest.vector) : latest.vector;
                    const similarity = Array.isArray(oldEmb) ? this.cosineSim(emb, oldEmb) : 0;
                    relation = this.decideRelation(latest.content, content, memoryKey, similarity);

                    if (relation === 'duplicate') {
                        await conn.execute(
                            `UPDATE memories SET use_count = COALESCE(use_count, 0) + 1, last_used_at = NOW(), updated_at = NOW(), confidence = GREATEST(confidence, ?) WHERE id = ?`,
                            [confidence, latest.id]
                        );
                        await conn.commit();
                        await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
                        conn.release();
                        return { content: [{ type: 'text', text: `重复记忆已跳过，已更新已有记忆 ${latest.id}` }] };
                    }
                }

                const newId = await this.insertMemory(agentId, {
                    content,
                    category,
                    importance,
                    scope,
                    projectId: params.projectId,
                    sessionKey: params.sessionKey,
                    memoryKey,
                    source,
                    confidence,
                    ttlType: ttl.ttlType,
                    expiresAt: ttl.expiresAt,
                    tagsJson,
                    status: 'active',
                    subject
                }, conn, emb);

                if (existing.length && relation !== 'unrelated') {
                    const latest = existing[0];
                    await this.supersedeRecords(existing.map((row) => row.id), newId, conn);
                    await conn.commit();
                    await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
                    conn.release();
                    if (relation === 'conflict') {
                        return { content: [{ type: 'text', text: `冲突记忆已替换，旧记忆 ${latest.id} 已失效，新记忆 ${newId} 已生效` }] };
                    }
                    return { content: [{ type: 'text', text: `记忆已精炼更新，旧记忆 ${latest.id} 已被 ${newId} 替代` }] };
                }

                await conn.commit();
                await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
                conn.release();
                return { content: [{ type: 'text', text: `记忆已存储: "${content.slice(0, 30)}..." (id=${newId})` }] };
            } catch (e) {
                try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch (_) {}
                try { await conn.rollback(); } catch (_) {}
                conn.release();
                throw e;
            }
        }

        const newId = await this.insertMemory(agentId, {
            content,
            category,
            importance,
            scope,
            projectId: params.projectId,
            sessionKey: params.sessionKey,
            memoryKey,
            source,
            confidence,
            ttlType: ttl.ttlType,
            expiresAt: ttl.expiresAt,
            tagsJson,
            status: 'active',
            subject
        });

        return { content: [{ type: 'text', text: `记忆已存储: "${content.slice(0, 30)}..." (id=${newId})` }] };
    }

    async handleList(params: ListParams) {
        const agentId = params.agentId || 'default';
        const limit = Math.min(Math.max(Number(params.limit || 20), 1), 100);
        const offset = Math.max(Number(params.offset || 0), 0);

        let sql = `SELECT id, agent_id, scope, project_id, session_key, memory_key, status, source, category, importance, confidence, ttl_type, expires_at, use_count, last_used_at, created_at, updated_at, content
                   FROM memories
                   WHERE agent_id = ?`;
        const queryParams: any[] = [agentId];

        if (params.scope) {
            sql += ' AND scope = ?';
            queryParams.push(params.scope);
        }
        if (params.status) {
            sql += ' AND status = ?';
            queryParams.push(params.status);
        }
        if (params.projectId) {
            sql += ' AND project_id = ?';
            queryParams.push(params.projectId);
        }
        if (params.sessionKey) {
            sql += ' AND session_key = ?';
            queryParams.push(params.sessionKey);
        }
        if (params.memoryKey) {
            sql += ' AND memory_key = ?';
            queryParams.push(params.memoryKey);
        }
        if (params.source) {
            sql += ' AND source = ?';
            queryParams.push(params.source);
        }

        sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        queryParams.push(limit, offset);

        const [rows]: any = await this.pool.query(sql, queryParams);
        const result = Array.isArray(rows) ? rows : [];

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    total: result.length,
                    limit,
                    offset,
                    items: result
                }, null, 2)
            }]
        };
    }

    async handleUpdate(params: UpdateParams) {
        const agentId = params.agentId || 'default';
        const updates: string[] = [];
        const values: any[] = [];

        if (typeof params.status === 'string') {
            updates.push('status = ?');
            values.push(params.status);
            if (params.status === 'deleted' || params.status === 'expired' || params.status === 'superseded') {
                updates.push('valid = 0');
            }
            if (params.status === 'active') {
                updates.push('valid = 1');
            }
        }

        if (typeof params.confidence === 'number') {
            const confidence = Math.max(0, Math.min(1, params.confidence));
            updates.push('confidence = ?');
            values.push(confidence);
        }

        if (typeof params.importance === 'number') {
            const importance = Math.max(1, Math.min(5, Math.floor(params.importance)));
            updates.push('importance = ?');
            values.push(importance);
        }

        if (Array.isArray(params.tags)) {
            updates.push('tags_json = ?');
            values.push(JSON.stringify(params.tags));
        }

        if (Object.prototype.hasOwnProperty.call(params, 'expiresAt')) {
            updates.push('expires_at = ?');
            values.push(params.expiresAt || null);
        }

        if (typeof params.content === 'string' && params.content.trim()) {
            const emb = await this.getEmbedding(params.content);
            updates.push('content = ?');
            values.push(params.content);
            updates.push('vector = ?');
            values.push(JSON.stringify(emb));
        }

        if (!updates.length) {
            return { content: [{ type: 'text', text: '没有可更新字段，已跳过' }] };
        }

        updates.push('updated_at = NOW()');
        values.push(params.memoryId);
        values.push(agentId);

        const [result]: any = await this.pool.execute(
            `UPDATE memories SET ${updates.join(', ')} WHERE id = ? AND agent_id = ?`,
            values
        );

        if (!result || result.affectedRows === 0) {
            return { content: [{ type: 'text', text: `记忆 ${params.memoryId} 不存在或未更新` }] };
        }

        return { content: [{ type: 'text', text: `记忆 ${params.memoryId} 更新成功` }] };
    }

    async handleExplain(params: ExplainParams) {
        if (params.memoryId) {
            const [rows]: any = await this.pool.query('SELECT * FROM memories WHERE id = ? LIMIT 1', [params.memoryId]);
            if (!Array.isArray(rows) || !rows.length) {
                return { content: [{ type: 'text', text: `记忆 ${params.memoryId} 不存在` }] };
            }

            const current = rows[0] as MemoryRecord;
            const chain: any[] = [];
            const visited = new Set<number>();

            let cursor: any = current;
            let hop = 0;
            while (cursor && cursor.id && !visited.has(cursor.id) && hop < 20) {
                visited.add(cursor.id);
                chain.push({
                    id: cursor.id,
                    status: cursor.status,
                    supersedes_id: cursor.supersedes_id || null,
                    replaced_by_id: cursor.replaced_by_id || null,
                    updated_at: cursor.updated_at || null,
                    content: String(cursor.content || '').slice(0, 120)
                });
                if (!cursor.replaced_by_id) break;
                const [nextRows]: any = await this.pool.query('SELECT * FROM memories WHERE id = ? LIMIT 1', [cursor.replaced_by_id]);
                cursor = Array.isArray(nextRows) && nextRows.length ? nextRows[0] : null;
                hop += 1;
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        mode: 'memoryId',
                        memoryId: params.memoryId,
                        current: {
                            id: current.id,
                            status: current.status,
                            valid: current.valid,
                            scope: current.scope,
                            memory_key: current.memory_key,
                            use_count: current.use_count,
                            last_used_at: current.last_used_at,
                            expires_at: current.expires_at
                        },
                        explain: {
                            recalled_if: "valid=1 AND status='active' AND (expires_at IS NULL OR expires_at > NOW())",
                            not_recalled_if: 'status!=active or expired or valid=0'
                        },
                        chain
                    }, null, 2)
                }]
            };
        }

        if (params.query) {
            const recall = await this.handleRecall({
                query: params.query,
                agentId: params.agentId,
                scope: params.scope,
                projectId: params.projectId,
                sessionKey: params.sessionKey,
                minScore: params.minScore,
                limit: 5
            });
            const text = recall?.content?.[0]?.text || '';
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        mode: 'query',
                        query: params.query,
                        filters: {
                            agentId: params.agentId || 'default',
                            scope: params.scope || null,
                            projectId: params.projectId || null,
                            sessionKey: params.sessionKey || null,
                            minScore: typeof params.minScore === 'number' ? params.minScore : (this.config.minRecallScore || 0.3)
                        },
                        recall_preview: text
                    }, null, 2)
                }]
            };
        }

        return { content: [{ type: 'text', text: '请提供 memoryId 或 query' }] };
    }

    async handleForget(params: ForgetParams) {
        const agentId = params.agentId || 'default';
        const [result]: any = await this.pool.execute(
            `UPDATE memories SET valid = 0, status = 'deleted', updated_at = NOW() WHERE id = ? AND agent_id = ?`,
            [params.memoryId, agentId]
        );
        if (!result || result.affectedRows === 0) {
            return { content: [{ type: 'text', text: `记忆 ${params.memoryId} 不存在或无权限` }] };
        }
        return { content: [{ type: 'text', text: `记忆 ${params.memoryId} 已删除` }] };
    }
}

const plugin = {
    id: 'openclaw-memory-local-mysql',
    register: (api: OpenClawPluginApi) => {
        const inst = new MemoryPlugin(api);
        inst.register();
    }
};

export default plugin;

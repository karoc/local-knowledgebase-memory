"use strict";
/**
 * OpenClaw 知识库插件 - 自建 MySQL + Ollama
 *
 * 提供工具:
 * - kb_store: 存储文本到知识库
 * - kb_store_batch: 批量存储
 * - kb_search: 向量搜索知识库
 * - kb_scan: 查看知识库统计
 * - kb_dedupe: 语义去重
 */
Object.defineProperty(exports, "__esModule", { value: true });
class KnowledgeBasePlugin {
    constructor(api) {
        this.mysqlPool = null;
        this.api = api;
        this.config = api.pluginConfig;
        this.ollamaBaseUrl = this.config.ollama.baseUrl;
    }
    /**
     * 插件注册入口
     */
    async register() {
        this.api.logger.info('[kb-local] 注册知识库插件...');
        // 初始化 MySQL 连接池
        await this.initMySQL();
        // 注册工具
        this.registerTools();
        this.api.logger.info('[kb-local] 知识库插件注册完成');
    }
    /**
     * 初始化 MySQL 连接池
     */
    async initMySQL() {
        const mysql = require('mysql2/promise');
        this.mysqlPool = mysql.createPool({
            host: this.config.mysql.host,
            port: this.config.mysql.port,
            user: this.config.mysql.user,
            password: this.config.mysql.password,
            database: this.config.mysql.database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        this.api.logger.info('[kb-local] MySQL 连接池已创建');
    }
    /**
     * 注册工具
     */
    registerTools() {
        // kb_store: 存储单条文本
        this.api.registerTool({
            name: 'kb_store',
            label: '存储到知识库',
            description: '将文本存储到知识库，自动进行分块和向量化',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: '要存储的文本内容' },
                    table: { type: 'string', description: '目标表名（可选，默认使用配置中的 defaultTable）' },
                    source: { type: 'string', description: '来源标识（可选）' }
                },
                required: ['text']
            },
            execute: async (_toolCallId, params) => {
                return this.handleKBStore(params);
            }
        });
        // kb_store_batch: 批量存储
        this.api.registerTool({
            name: 'kb_store_batch',
            label: '批量存储到知识库',
            description: '批量存储多条文本到知识库',
            parameters: {
                type: 'object',
                properties: {
                    texts: { type: 'array', items: { type: 'string' }, description: '文本数组' },
                    table: { type: 'string', description: '目标表名' },
                    source: { type: 'string', description: '来源标识' }
                },
                required: ['texts']
            },
            execute: async (_toolCallId, params) => {
                return this.handleKBStoreBatch(params);
            }
        });
        // kb_search: 向量搜索
        this.api.registerTool({
            name: 'kb_search',
            label: '搜索知识库',
            description: '使用向量相似度搜索知识库',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '搜索查询' },
                    table: { type: 'string', description: '搜索的表名' },
                    topK: { type: 'number', description: '返回结果数量，默认 5' },
                    minScore: { type: 'number', description: '最低相似度阈值 0-1' }
                },
                required: ['query']
            },
            execute: async (_toolCallId, params) => {
                return this.handleKBSearch(params);
            }
        });
        // kb_scan: 查看统计
        this.api.registerTool({
            name: 'kb_scan',
            label: '查看知识库统计',
            description: '查看知识库的文档和分块统计信息',
            parameters: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: '表名（可选）' }
                }
            },
            execute: async (_toolCallId, params) => {
                return this.handleKBScan(params);
            }
        });
    }
    /**
     * 获取 Ollama Embedding
     */
    async getEmbedding(text) {
        const response = await fetch(`${this.ollamaBaseUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.config.ollama.model,
                prompt: text
            })
        });
        if (!response.ok) {
            throw new Error(`Ollama embedding 失败: ${response.statusText}`);
        }
        const data = await response.json();
        return data.embedding;
    }
    /**
     * 文本分块
     */
    chunkText(text) {
        const { strategy = 'paragraph', maxChunkSize = 500, overlap = 100 } = this.config.chunking || {};
        if (strategy === 'none') {
            return [text];
        }
        if (strategy === 'paragraph') {
            // 按段落分割
            const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
            const chunks = [];
            let currentChunk = '';
            for (const para of paragraphs) {
                if ((currentChunk + para).length > maxChunkSize && currentChunk) {
                    chunks.push(currentChunk.trim());
                    // 保留 overlap 部分
                    const overlapText = currentChunk.slice(-overlap);
                    currentChunk = overlapText + '\n\n' + para;
                }
                else {
                    currentChunk += (currentChunk ? '\n\n' : '') + para;
                }
            }
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
            }
            return chunks;
        }
        // fixed 策略：固定长度分块
        const chunks = [];
        for (let i = 0; i < text.length; i += maxChunkSize - overlap) {
            chunks.push(text.slice(i, i + maxChunkSize));
        }
        return chunks;
    }
    /**
     * 计算余弦相似度
     */
    cosineSimilarity(a, b) {
        if (a.length !== b.length)
            return 0;
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    /**
     * 工具执行: kb_store
     */
    async handleKBStore(params) {
        const { text, table: paramTable, source } = params;
        const table = paramTable || this.config.defaultTable;
        // 分块
        const chunks = this.chunkText(text);
        this.api.logger.info(`[kb-store] 分块为 ${chunks.length} 个片段`);
        // 批量处理
        for (const chunk of chunks) {
            const embedding = await this.getEmbedding(chunk);
            await this.mysqlPool.execute(`INSERT INTO kb_documents (table_name, chunk_text, vector, source) VALUES (?, ?, ?, ?)`, [table, chunk, JSON.stringify(embedding), source || 'unknown']);
        }
        return {
            content: [{
                    type: 'text',
                    text: `成功存储 "${text.slice(0, 50)}..." 到知识库，分块数: ${chunks.length}`
                }]
        };
    }
    /**
     * 工具执行: kb_store_batch
     */
    async handleKBStoreBatch(params) {
        const { texts, table = this.config.defaultTable, source } = params;
        let stored = 0;
        for (const text of texts) {
            const chunks = this.chunkText(text);
            for (const chunk of chunks) {
                const embedding = await this.getEmbedding(chunk);
                await this.mysqlPool.execute(`INSERT INTO kb_documents (table_name, chunk_text, vector, source) VALUES (?, ?, ?, ?)`, [table, chunk, JSON.stringify(embedding), source || 'batch']);
                stored++;
            }
        }
        return {
            content: [{
                    type: 'text',
                    text: `批量存储完成，共存储 ${stored} 个分块`
                }]
        };
    }
    /**
     * 工具执行: kb_search
     */
    async handleKBSearch(params) {
        const { query, table = this.config.defaultTable, topK = 5, minScore = 0.3 } = params;
        // 获取查询向量
        const queryEmbedding = await this.getEmbedding(query);
        // 从数据库获取所有向量（生产环境应使用 HNSW 索引优化）
        const [rows] = await this.mysqlPool.execute(`SELECT id, chunk_text, vector, source, created_at FROM kb_documents WHERE table_name = ?`, [table]);
        // 计算相似度并排序
        const results = rows
            .map(row => ({
            ...row,
            vector: typeof row.vector === 'string' ? JSON.parse(row.vector) : row.vector,
            score: this.cosineSimilarity(queryEmbedding, row.vector)
        }))
            .filter(item => item.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
        if (results.length === 0) {
            return {
                content: [{
                        type: 'text',
                        text: '未找到相关知识'
                    }]
            };
        }
        const resultText = results.map(r => `[${r.score.toFixed(3)}] ${r.chunk_text}${r.source ? ` (来源: ${r.source})` : ''}`).join('\n\n');
        return {
            content: [{
                    type: 'text',
                    text: resultText
                }]
        };
    }
    /**
     * 工具执行: kb_scan
     */
    async handleKBScan(params) {
        const { table } = params;
        let query = 'SELECT table_name, COUNT(*) AS count, COALESCE(SUM(CHAR_LENGTH(chunk_text)), 0) AS total_chars FROM kb_documents';
        const queryParams = [];
        if (table) {
            query += ' WHERE table_name = ?';
            queryParams.push(table);
        }
        query += ' GROUP BY table_name ORDER BY table_name';
        const result = await this.mysqlPool.query(query, queryParams);
        const rows = Array.isArray(result) ? result[0] : [];
        const normalizedRows = Array.isArray(rows) ? rows : [];
        if (normalizedRows.length === 0) {
            return {
                content: [{
                        type: 'text',
                        text: '知识库为空'
                    }]
            };
        }
        const stats = normalizedRows.map((row) => {
            const tableName = row.table_name ?? row.TABLE_NAME ?? 'unknown';
            const count = Number(row.count ?? row.COUNT ?? 0);
            const totalChars = Number(row.total_chars ?? row.TOTAL_CHARS ?? 0);
            return `${tableName}: ${count} 条记录, ${totalChars} 字符`;
        }).join('\n');
        return {
            content: [{
                    type: 'text',
                    text: stats
                }]
        };
    }
}
// 插件导出
const plugin = {
    id: 'openclaw-knowledgebase-local-mysql',
    register: async (api) => {
        const instance = new KnowledgeBasePlugin(api);
        await instance.register();
    }
};
exports.default = plugin;

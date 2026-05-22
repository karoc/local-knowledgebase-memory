/**
 * OpenClaw 知识库插件 - 自建 MySQL + Ollama
 *
 * 提供工具:
 * - kb_store: 存储文本到知识库
 * - kb_store_batch: 批量存储
 * - kb_search: 向量搜索知识库
 * - kb_scan: 查看知识库统计
 */
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

interface PluginConfig {
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  ollama: {
    baseUrl: string;
    model: string;
    dimensions: number;
  };
  chunking?: {
    strategy: "paragraph" | "fixed" | "none";
    maxChunkSize: number;
    overlap: number;
  };
  defaultTable: string;
}

interface KBDocument {
  id: number;
  table_name: string;
  chunk_text: string;
  vector: string | number[];
  source: string;
  created_at: Date;
}

/**
 * 懒加载的单例管理器，负责 MySQL 连接池和 Ollama 调用
 */
class KBBackend {
  private config: PluginConfig;
  private pool: any = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const mysql = require("mysql2/promise");
      this.pool = mysql.createPool({
        host: this.config.mysql.host,
        port: this.config.mysql.port,
        user: this.config.mysql.user,
        password: this.config.mysql.password,
        database: this.config.mysql.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });
      this.initialized = true;
    })();
    return this.initPromise;
  }

  async getEmbedding(text: string): Promise<number[]> {
    const response = await fetch(
      `${this.config.ollama.baseUrl}/api/embeddings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.ollama.model,
          prompt: text,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Ollama embedding 失败: ${response.statusText}`);
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  chunkText(text: string): string[] {
    const {
      strategy = "paragraph",
      maxChunkSize = 500,
      overlap = 100,
    } = this.config.chunking || {};

    if (strategy === "none") {
      return [text];
    }

    if (strategy === "paragraph") {
      const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
      const chunks: string[] = [];
      let currentChunk = "";

      for (const para of paragraphs) {
        if ((currentChunk + para).length > maxChunkSize && currentChunk) {
          chunks.push(currentChunk.trim());
          const overlapText = currentChunk.slice(-overlap);
          currentChunk = overlapText + "\n\n" + para;
        } else {
          currentChunk += (currentChunk ? "\n\n" : "") + para;
        }
      }
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      return chunks;
    }

    // fixed 策略
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxChunkSize - overlap) {
      chunks.push(text.slice(i, i + maxChunkSize));
    }
    return chunks;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

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

  async store(params: {
    text: string;
    table?: string;
    source?: string;
    agentId?: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const { text, source, agentId } = params;
    const table = params.table || this.config.defaultTable;
    const finalAgentId = agentId || "default";

    const chunks = this.chunkText(text);

    for (const chunk of chunks) {
      const embedding = await this.getEmbedding(chunk);
      await this.pool.execute(
        `INSERT INTO kb_documents (agent_id, table_name, chunk_text, vector, source) VALUES (?, ?, ?, ?, ?)`,
        [
          finalAgentId,
          table,
          chunk,
          JSON.stringify(embedding),
          source || "unknown",
        ]
      );
    }

    return `成功存储 "${text.slice(0, 50)}..." 到知识库，分块数: ${chunks.length}`;
  }

  async storeBatch(params: {
    texts: string[];
    table?: string;
    source?: string;
    agentId?: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const { texts, source, agentId } = params;
    const table = params.table || this.config.defaultTable;
    const finalAgentId = agentId || "default";
    let stored = 0;

    for (const text of texts) {
      const chunks = this.chunkText(text);
      for (const chunk of chunks) {
        const embedding = await this.getEmbedding(chunk);
        await this.pool.execute(
          `INSERT INTO kb_documents (agent_id, table_name, chunk_text, vector, source) VALUES (?, ?, ?, ?, ?)`,
          [
            finalAgentId,
            table,
            chunk,
            JSON.stringify(embedding),
            source || "batch",
          ]
        );
        stored++;
      }
    }

    return `批量存储完成，共存储 ${stored} 个分块`;
  }

  async search(params: {
    query: string;
    table?: string;
    topK?: number;
    minScore?: number;
    agentId?: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const { query, topK = 5, minScore = 0.3, agentId } = params;
    const table = params.table || this.config.defaultTable;
    const finalAgentId = agentId || "default";

    const queryEmbedding = await this.getEmbedding(query);

    const [rows] = await this.pool.execute(
      `SELECT id, chunk_text, vector, source, created_at FROM kb_documents WHERE agent_id = ? AND table_name = ?`,
      [finalAgentId, table]
    );

    const results = (rows as KBDocument[])
      .map((row) => ({
        ...row,
        vector:
          typeof row.vector === "string"
            ? JSON.parse(row.vector)
            : row.vector,
        score: this.cosineSimilarity(
          queryEmbedding,
          typeof row.vector === "string"
            ? JSON.parse(row.vector)
            : row.vector
        ),
      }))
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (results.length === 0) {
      return "未找到相关知识";
    }

    return results
      .map(
        (r) =>
          `[${r.score.toFixed(3)}] ${r.chunk_text}${r.source ? ` (来源: ${r.source})` : ""}`
      )
      .join("\n\n");
  }

  async scan(params: {
    table?: string;
    agentId?: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const { agentId } = params;
    const finalAgentId = agentId || "default";

    let query =
      "SELECT table_name, COUNT(*) AS count, COALESCE(SUM(CHAR_LENGTH(chunk_text)), 0) AS total_chars FROM kb_documents WHERE agent_id = ?";
    const queryParams: any[] = [finalAgentId];

    if (params.table) {
      query += " AND table_name = ?";
      queryParams.push(params.table);
    }

    query += " GROUP BY table_name ORDER BY table_name";

    const result = await this.pool.query(query, queryParams);
    const rows = Array.isArray(result) ? result[0] : [];
    const normalizedRows = Array.isArray(rows)
      ? (rows as Array<Record<string, any>>)
      : [];

    if (normalizedRows.length === 0) {
      return "知识库为空";
    }

    return normalizedRows
      .map((row) => {
        const tableName = row.table_name ?? row.TABLE_NAME ?? "unknown";
        const count = Number(row.count ?? row.COUNT ?? 0);
        const totalChars = Number(row.total_chars ?? row.TOTAL_CHARS ?? 0);
        return `${tableName}: ${count} 条记录, ${totalChars} 字符`;
      })
      .join("\n");
  }
}

export default defineToolPlugin({
  id: "openclaw-knowledgebase-local-mysql",
  name: "知识库插件 (本地 MySQL)",
  description: "基于自建 MySQL + Ollama 的知识库 RAG 插件",
  configSchema: Type.Object({
    mysql: Type.Object({
      host: Type.String(),
      port: Type.Number({ default: 3306 }),
      user: Type.String(),
      password: Type.String(),
      database: Type.String(),
    }),
    ollama: Type.Object({
      baseUrl: Type.String({ default: "http://localhost:11434" }),
      model: Type.String({ default: "nomic-embed-text" }),
      dimensions: Type.Number({ default: 768 }),
    }),
    chunking: Type.Optional(
      Type.Object({
        strategy: Type.Union([
          Type.Literal("paragraph"),
          Type.Literal("fixed"),
          Type.Literal("none"),
        ]),
        maxChunkSize: Type.Number({ default: 500 }),
        overlap: Type.Number({ default: 100 }),
      })
    ),
    defaultTable: Type.String({ default: "default" }),
  }),
  tools: (tool) => {
    let backend: KBBackend | null = null;

    function getBackend(config: PluginConfig): KBBackend {
      if (!backend) {
        backend = new KBBackend(config);
      }
      return backend;
    }

    return [
      tool({
        name: "kb_store",
        label: "存储到知识库",
        description: "将文本存储到知识库，自动进行分块和向量化",
        parameters: Type.Object({
          text: Type.String({ description: "要存储的文本内容" }),
          table: Type.Optional(
            Type.String({
              description: "目标表名（可选，默认使用配置中的 defaultTable）",
            })
          ),
          source: Type.Optional(
            Type.String({ description: "来源标识（可选）" })
          ),
          agentId: Type.Optional(
            Type.String({ description: "Agent ID（可选）" })
          ),
        }),
        async execute(params, config) {
          return getBackend(config).store(params);
        },
      }),
      tool({
        name: "kb_store_batch",
        label: "批量存储到知识库",
        description: "批量存储多条文本到知识库",
        parameters: Type.Object({
          texts: Type.Array(Type.String(), {
            description: "文本数组",
          }),
          table: Type.Optional(Type.String({ description: "目标表名" })),
          source: Type.Optional(
            Type.String({ description: "来源标识" })
          ),
          agentId: Type.Optional(
            Type.String({ description: "Agent ID（可选）" })
          ),
        }),
        async execute(params, config) {
          return getBackend(config).storeBatch(params);
        },
      }),
      tool({
        name: "kb_search",
        label: "搜索知识库",
        description: "使用向量相似度搜索知识库",
        parameters: Type.Object({
          query: Type.String({ description: "搜索查询" }),
          table: Type.Optional(
            Type.String({ description: "搜索的表名" })
          ),
          topK: Type.Optional(
            Type.Number({ description: "返回结果数量，默认 5" })
          ),
          minScore: Type.Optional(
            Type.Number({ description: "最低相似度阈值 0-1" })
          ),
          agentId: Type.Optional(
            Type.String({ description: "Agent ID（可选）" })
          ),
        }),
        async execute(params, config) {
          return getBackend(config).search(params);
        },
      }),
      tool({
        name: "kb_scan",
        label: "查看知识库统计",
        description: "查看知识库的文档和分块统计信息",
        parameters: Type.Object({
          table: Type.Optional(Type.String({ description: "表名（可选）" })),
          agentId: Type.Optional(
            Type.String({ description: "Agent ID（可选）" })
          ),
        }),
        async execute(params, config) {
          return getBackend(config).scan(params);
        },
      }),
    ];
  },
});

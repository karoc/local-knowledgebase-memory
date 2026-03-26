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
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
declare const plugin: {
    id: string;
    register: (api: OpenClawPluginApi) => Promise<void>;
};
export default plugin;

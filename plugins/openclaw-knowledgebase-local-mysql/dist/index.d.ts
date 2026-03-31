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
interface OpenClawPluginApi {
    pluginConfig: any;
    logger: {
        info: (msg: string, ...args: any[]) => void;
        error: (msg: string, ...args: any[]) => void;
        warn: (msg: string, ...args: any[]) => void;
    };
    registerTool: (tool: any, binding?: any) => void;
    on: (event: string, handler: Function) => void;
}
declare const plugin: {
    id: string;
    register: (api: OpenClawPluginApi) => Promise<void>;
};
export default plugin;

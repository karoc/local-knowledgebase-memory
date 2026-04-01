/**
 * OpenClaw 记忆插件 - 自建 MySQL + Ollama
 * 增强版 v1：支持 scope / memory_key / status / TTL / duplicate-refine-conflict 治理
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
declare const plugin: {
    id: string;
    register: (api: OpenClawPluginApi) => void;
};
export default plugin;

# OpenClaw 本地化插件集 (MySQL + Ollama)

> **中文 | [English](./README.en.md)**

面向 OpenClaw 的生产级本地化插件：

- **知识库插件**（`openclaw-knowledgebase-local-mysql`）
- **记忆插件**（`openclaw-memory-local-mysql`）

特性：

- **MySQL** 持久化存储
- **Ollama** 向量嵌入
- **零外部云服务依赖**

---

## 功能概览

### 知识库插件

- `kb_store` / `kb_store_batch`
- `kb_search`
- `kb_scan`
- 可配置分块策略

### 记忆插件

- `memory_store` / `memory_recall` / `memory_forget`
- `memory_list` / `memory_update` / `memory_explain`
- Scope 记忆（`global` / `project` / `session`）
- Session 默认 TTL（7 天）
- 治理管道：duplicate / refine / conflict / unrelated
- 唯一 active key 规则（registry 驱动）
- Recall 分层：rule / project_fact / vector
- 维护脚本（过期 + 软清理）

---

## 目录结构

```text
.
├── infrastructure/
│   ├── docker-compose.yml
│   ├── .env.example
│   └── mysql/
│       └── migrations/
│           ├── openclaw_memory/
│           └── openclaw_knowledge_base/
├── plugins/
│   ├── openclaw-knowledgebase-local-mysql/
│   │   ├── src/
│   │   ├── dist/
│   │   └── openclaw.plugin.json
│   └── openclaw-memory-local-mysql/
│       ├── src/
│       ├── tests/
│       ├── dist/
│       └── openclaw.plugin.json
├── scripts/
│   ├── start.sh
│   ├── run-migrations.js
│   ├── migrate.sh
│   └── memory-maintenance.js
└── plugins-config-example.json
```

---

## 快速开始

### 1) 准备环境

```bash
git clone git@github.com:karoc/local-knowledgebase-memory.git openclaw-local-plugins
cd openclaw-local-plugins
cp infrastructure/.env.example infrastructure/.env
```

### 2) 启动基础设施并迁移

```bash
./scripts/start.sh
```

### 3) 构建插件

```bash
cd plugins/openclaw-knowledgebase-local-mysql
npm install
npm run build

cd ../openclaw-memory-local-mysql
npm install
npm run build
```

### 4) 配置 OpenClaw

使用 `plugins-config-example.json` 作为配置模板。

---

## 运维命令

### 迁移

```bash
node scripts/run-migrations.js
```

### 备份 / 恢复

```bash
./scripts/migrate.sh export
./scripts/migrate.sh import
```

### 记忆维护

```bash
# dry-run
node scripts/memory-maintenance.js --dry-run --expire-now --soft-prune

# apply
node scripts/memory-maintenance.js --expire-now --soft-prune
```

---

## 测试

```bash
cd plugins/openclaw-memory-local-mysql
npx tsc -p tsconfig.json
node --test --test-force-exit --test-concurrency=1 tests/*.test.js
```

---

## 安全提示

- 请勿提交真实凭据。
- `infrastructure/.env` 仅本地保留。
- 发布或部署前请轮换数据库密码。

---

## 许可证

MIT License. See [LICENSE](./LICENSE).

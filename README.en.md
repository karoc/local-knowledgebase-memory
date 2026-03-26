# OpenClaw Local Plugins (MySQL + Ollama)

Production-ready local plugins for OpenClaw:

- **Knowledge Base Plugin** (`openclaw-knowledgebase-local-mysql`)
- **Memory Plugin** (`openclaw-memory-local-mysql`)

Built for self-hosted deployments with:

- **MySQL** as durable storage
- **Ollama** for embeddings
- **Zero external cloud dependencies**

---

## Features

### Knowledge Base Plugin

- `kb_store` / `kb_store_batch`
- `kb_search`
- `kb_scan`
- Configurable chunking strategy

### Memory Plugin

- `memory_store` / `memory_recall` / `memory_forget`
- `memory_list` / `memory_update` / `memory_explain`
- Scope-aware memory (`global` / `project` / `session`)
- Session default TTL (7 days)
- Governance pipeline: duplicate / refine / conflict / unrelated
- Single-active key policy (registry-driven)
- Recall layering: rule / project_fact / vector
- Maintenance script for expiration and soft pruning

---

## Repository Layout

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

## Quick Start

### 1) Prepare env

```bash
git clone git@github.com:karoc/local-knowledgebase-memory.git openclaw-local-plugins
cd openclaw-local-plugins
cp infrastructure/.env.example infrastructure/.env
```

### 2) Start infra and run migrations

```bash
./scripts/start.sh
```

### 3) Build plugins

```bash
cd plugins/openclaw-knowledgebase-local-mysql
npm install
npm run build

cd ../openclaw-memory-local-mysql
npm install
npm run build
```

### 4) Configure OpenClaw

Use `plugins-config-example.json` as a template for your OpenClaw config file.

---

## Operations

### Migrations

```bash
node scripts/run-migrations.js
```

### Backup / Restore

```bash
./scripts/migrate.sh export
./scripts/migrate.sh import
```

### Memory maintenance

```bash
# dry-run
node scripts/memory-maintenance.js --dry-run --expire-now --soft-prune

# apply
node scripts/memory-maintenance.js --expire-now --soft-prune
```

---

## Testing

```bash
cd plugins/openclaw-memory-local-mysql
npx tsc -p tsconfig.json
node --test --test-force-exit --test-concurrency=1 tests/*.test.js
```

---

## Security Notes

- Never commit real credentials.
- Keep `infrastructure/.env` local only.
- Rotate DB credentials before publishing or deploying.

---

## License

MIT License. See [LICENSE](./LICENSE).

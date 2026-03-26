# Contributing

Thanks for your interest in contributing.

## Development setup

```bash
git clone git@github.com:karoc/local-knowledgebase-memory.git openclaw-local-plugins
cd openclaw-local-plugins
cp infrastructure/.env.example infrastructure/.env
./scripts/start.sh
```

Build plugins:

```bash
cd plugins/openclaw-knowledgebase-local-mysql && npm install && npm run build
cd ../openclaw-memory-local-mysql && npm install && npm run build
```

## Tests

```bash
cd plugins/openclaw-memory-local-mysql
npx tsc -p tsconfig.json
node --test --test-force-exit --test-concurrency=1 tests/*.test.js
```

## Pull request checklist

- [ ] No secrets committed (`.env`, tokens, passwords)
- [ ] TypeScript build passes
- [ ] Tests pass
- [ ] README updated when behavior/config changes
- [ ] Migrations are additive and idempotent

## Commit style

Recommended conventional format:

- `feat: ...`
- `fix: ...`
- `refactor: ...`
- `test: ...`
- `docs: ...`

# OpenClaw MySQL migrations

This directory contains ordered SQL migrations applied by `scripts/run-migrations.js`.

Rules:
- Use subfolders for each database (e.g. `openclaw_memory`, `openclaw_knowledge_base`).
- File names must start with a numeric prefix to enforce order, e.g. `001_*.sql`.
- Do not edit already-applied migrations; create a new migration instead.

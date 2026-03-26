-- Memory enhancement v1 migration
-- Adds governance fields for active/superseded/expired lifecycle, scope, keys, and TTL.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS scope VARCHAR(32) NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS subject VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS memory_key VARCHAR(191) NULL,
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS confidence DECIMAL(4,3) NOT NULL DEFAULT 0.800,
  ADD COLUMN IF NOT EXISTS supersedes_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS replaced_by_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS ttl_type VARCHAR(32) NOT NULL DEFAULT 'permanent',
  ADD COLUMN IF NOT EXISTS expires_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS project_id VARCHAR(191) NULL,
  ADD COLUMN IF NOT EXISTS session_key VARCHAR(191) NULL,
  ADD COLUMN IF NOT EXISTS tags_json JSON NULL,
  ADD COLUMN IF NOT EXISTS use_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_memories_agent_valid ON memories(agent_id, valid);
CREATE INDEX IF NOT EXISTS idx_memories_scope_status ON memories(scope, status);
CREATE INDEX IF NOT EXISTS idx_memories_key_status ON memories(memory_key, status);
CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_session_status ON memories(session_key, status);
CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);

UPDATE memories
SET scope = COALESCE(NULLIF(scope, ''), 'global'),
    status = COALESCE(NULLIF(status, ''), 'active'),
    source = COALESCE(NULLIF(source, ''), 'migrated'),
    ttl_type = COALESCE(NULLIF(ttl_type, ''), 'permanent'),
    confidence = COALESCE(confidence, 0.800)
WHERE 1=1;

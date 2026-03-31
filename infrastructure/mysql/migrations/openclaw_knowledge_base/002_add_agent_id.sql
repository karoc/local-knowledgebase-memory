-- Add agent_id to knowledge base documents for agent isolation

ALTER TABLE kb_documents
  ADD COLUMN agent_id VARCHAR(64) NOT NULL DEFAULT 'default' AFTER id;

CREATE INDEX idx_kb_documents_agent_table
  ON kb_documents (agent_id, table_name);

-- OpenClaw 数据库初始化脚本

-- 知识库数据库
CREATE DATABASE IF NOT EXISTS openclaw_knowledge_base CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE openclaw_knowledge_base;

CREATE TABLE IF NOT EXISTS kb_documents (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(255) NOT NULL DEFAULT 'default',
    chunk_text TEXT NOT NULL,
    vector JSON NOT NULL,
    source VARCHAR(512),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_table_name (table_name),
    INDEX idx_created_at (created_at),
    FULLTEXT INDEX ft_text (chunk_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_stats (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(255) NOT NULL UNIQUE,
    doc_count BIGINT DEFAULT 0,
    chunk_count BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 记忆数据库
CREATE DATABASE IF NOT EXISTS openclaw_memory CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE openclaw_memory;

CREATE TABLE IF NOT EXISTS memories (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    vector JSON NOT NULL,
    category VARCHAR(50) DEFAULT 'general',
    importance INT DEFAULT 3,
    valid TINYINT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_agent_id (agent_id),
    INDEX idx_category (category),
    INDEX idx_importance (importance),
    INDEX idx_created_at (created_at),
    FULLTEXT INDEX ft_content (content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET GLOBAL log_bin_trust_function_creators = 1;
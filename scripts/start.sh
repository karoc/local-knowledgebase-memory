#!/bin/bash
# ============================================================
# OpenClaw 本地化基础设施 - 一键启动脚本
# ============================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MODE="full"
STARTED_COMPOSE=0

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --check)
            MODE="check"
            ;;
        --migrate-only)
            MODE="migrate"
            ;;
        --help|-h)
            echo "用法: $0 [--migrate-only|--check]"
            echo "  --migrate-only  仅执行迁移与校验 (不启动容器、不拉模型)"
            echo "  --check         仅执行 MySQL 就绪检查与表结构校验"
            exit 0
            ;;
        *)
            log_error "未知参数: $1"
            exit 1
            ;;
    esac
    shift
done

cd "$PROJECT_ROOT/infrastructure"

COMPOSE_CMD=""
if [ "$MODE" = "full" ]; then
    if command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
    elif docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
    else
        log_error "Docker Compose 未安装"
        exit 1
    fi
fi

cleanup() {
    local exit_code=$?
    if [ "${KEEP_ON_FAIL:-}" = "1" ]; then
        log_warn "启动失败，保持容器运行以便排查 (KEEP_ON_FAIL=1)"
        exit $exit_code
    fi
    if [ "$STARTED_COMPOSE" = "1" ]; then
        log_warn "启动失败，正在关闭容器..."
        $COMPOSE_CMD down || true
    fi
    exit $exit_code
}

trap cleanup ERR

# 检查 docker
if ! command -v docker &> /dev/null; then
    log_error "Docker 未安装"
    exit 1
fi

if ! command -v node &> /dev/null; then
    log_error "Node.js 未安装，无法执行迁移"
    exit 1
fi

# 启动服务
if [ "$MODE" = "full" ]; then
    log_info "启动 MySQL + Ollama..."
    $COMPOSE_CMD up -d
    STARTED_COMPOSE=1
fi

# 等待 MySQL 就绪
log_info "等待 MySQL 就绪..."
MYSQL_READY=0
for i in {1..60}; do
    if docker exec openclaw-mysql mysqladmin ping -h localhost &>/dev/null; then
        MYSQL_READY=1
        log_info "MySQL 已就绪"
        break
    fi
    sleep 2
done

if [ "$MYSQL_READY" != "1" ]; then
    log_error "MySQL 启动超时"
    exit 1
fi

if [ "$MODE" = "migrate" ] || [ "$MODE" = "full" ]; then
    log_info "执行数据库迁移..."
    node "$PROJECT_ROOT/scripts/run-migrations.js"
fi

log_info "校验关键表结构..."
MYSQL_ROOT_PASSWORD=$(grep -E '^MYSQL_ROOT_PASSWORD=' "$PROJECT_ROOT/infrastructure/.env" | tail -1 | cut -d= -f2-)
if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    log_error "未找到 MYSQL_ROOT_PASSWORD，无法校验表结构"
    exit 1
fi
for col in status expires_at scope memory_key project_id session_key; do
    COL_EXISTS=$(docker exec openclaw-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='openclaw_memory' AND TABLE_NAME='memories' AND COLUMN_NAME='${col}'")
    if [ "${COL_EXISTS}" != "1" ]; then
        log_error "缺少字段: openclaw_memory.memories.${col}"
        exit 1
    fi
done

if docker exec openclaw-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SELECT COUNT(*) FROM openclaw_memory.schema_migrations" &>/dev/null; then
    log_info "迁移表已就绪"
fi

if [ "$MODE" = "check" ]; then
    log_info "检查完成"
    exit 0
fi

# 拉取模型
if [ "$MODE" = "full" ]; then
    if ! docker exec openclaw-ollama ollama list 2>/dev/null | grep -q nomic-embed-text; then
        log_info "拉取 Embedding 模型 (nomic-embed-text)..."
        docker exec openclaw-ollama ollama pull nomic-embed-text
    fi
fi

log_info "启动完成!"
echo ""
echo "服务状态:"
$COMPOSE_CMD ps
echo ""
echo "下一步: 构建插件"
echo "  cd $PROJECT_ROOT/plugins/openclaw-knowledgebase-local-mysql"
echo "  npm install && npm run build"
echo ""
echo "  cd $PROJECT_ROOT/plugins/openclaw-memory-local-mysql"
echo "  npm install && npm run build"

#!/bin/bash
# ============================================================
# OpenClaw 本地化基础设施 - 一键迁移脚本
# 用法: 
#   导出: ./scripts/migrate.sh export
#   导入: ./scripts/migrate.sh import
# ============================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_ROOT/backup"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查 docker 和 docker-compose
check_requirements() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker 未安装"
        exit 1
    fi
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_error "Docker Compose 未安装"
        exit 1
    fi
    log_info "环境检查通过"
}

# 导出数据
do_export() {
    log_info "开始导出数据..."
    mkdir -p "$BACKUP_DIR"
    
    local backup_file="openclaw_backup_${TIMESTAMP}.tar.gz"
    
    # 停止服务
    log_info "停止服务..."
    cd "$PROJECT_ROOT/infrastructure"
    docker-compose down
    
    # 导出数据卷
    log_info "导出 MySQL 数据卷..."
    docker run --rm \
        -v openclaw-mysql-data:/data \
        -v "$BACKUP_DIR:/backup" \
        alpine tar czf "/backup/mysql_${TIMESTAMP}.tar" -C /data .
    
    log_info "导出 Ollama 模型卷..."
    docker run --rm \
        -v openclaw-ollama-models:/data \
        -v "$BACKUP_DIR:/backup" \
        alpine tar czf "/backup/ollama_${TIMESTAMP}.tar" -C /data .
    
    # 复制配置文件
    log_info "复制配置..."
    cp "$PROJECT_ROOT/infrastructure/.env" "$BACKUP_DIR/.env" 2>/dev/null || true
    
    # 打包
    log_info "打包备份文件..."
    cd "$BACKUP_DIR"
    tar czf "$backup_file" mysql_${TIMESTAMP}.tar ollama_${TIMESTAMP}.tar .env 2>/dev/null || true
    rm -f mysql_${TIMESTAMP}.tar ollama_${TIMESTAMP}.tar .env 2>/dev/null || true
    
    log_info "导出完成: $BACKUP_DIR/$backup_file"
    log_info "文件大小: $(du -h "$backup_file" | cut -f1)"
}

# 导入数据
do_import() {
    log_info "开始导入数据..."
    
    # 查找最新的备份文件
    local backup_file=$(ls -t "$BACKUP_DIR"/openclaw_backup_*.tar.gz 2>/dev/null | head -1)
    
    if [ -z "$backup_file" ]; then
        log_error "未找到备份文件"
        exit 1
    fi
    
    log_info "使用备份: $backup_file"
    
    # 解压
    log_info "解压备份..."
    cd "$BACKUP_DIR"
    tar -xzf "$backup_file"
    
    # 创建数据卷
    log_info "创建数据卷..."
    docker volume create openclaw-mysql-data 2>/dev/null || true
    docker volume create openclaw-ollama-models 2>/dev/null || true
    
    # 恢复数据
    if [ -f "mysql_${TIMESTAMP}.tar" ] || ls mysql_*.tar &>/dev/null; then
        local mysql_tar=$(ls mysql_*.tar 2>/dev/null | head -1)
        log_info "恢复 MySQL 数据..."
        docker run --rm -v openclaw-mysql-data:/data -v "$BACKUP_DIR:/backup" alpine tar xzf "/backup/$mysql_tar" -C /
    fi
    
    if [ -f "ollama_${TIMESTAMP}.tar" ] || ls ollama_*.tar &>/dev/null; then
        local ollama_tar=$(ls ollama_*.tar 2>/dev/null | head -1)
        log_info "恢复 Ollama 模型..."
        docker run --rm -v openclaw-ollama-models:/data -v "$BACKUP_DIR:/backup" alpine tar xzf "/backup/$ollama_tar" -C /
    fi
    
    # 恢复配置
    if [ -f ".env" ]; then
        log_info "恢复配置..."
        cp "$BACKUP_DIR/.env" "$PROJECT_ROOT/infrastructure/.env"
    fi
    
    # 重启服务
    log_info "启动服务..."
    cd "$PROJECT_ROOT/infrastructure"
    docker-compose up -d
    
    # 清理临时文件
    rm -f mysql_*.tar ollama_*.tar .env 2>/dev/null || true
    
    log_info "导入完成!"
    log_info "验证服务: cd $PROJECT_ROOT/infrastructure && docker-compose ps"
}

# 主入口
case "${1:-}" in
    export)
        check_requirements
        do_export
        ;;
    import)
        check_requirements
        do_import
        ;;
    *)
        echo "用法: $0 {export|import}"
        echo "  export - 导出当前数据到备份"
        echo "  import - 从备份恢复数据"
        exit 1
        ;;
esac
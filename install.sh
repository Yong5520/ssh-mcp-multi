#!/bin/bash
# ssh-mcp-multi 一键安装脚本
# 用法: bash install.sh [/path/to/hosts.yaml]
#
# 如果不传参数，会基于模板创建一个 hosts.yaml 供你填写

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== ssh-mcp-multi 安装 ==="
echo ""

# 1. 检查 Node.js
if ! command -v node &>/dev/null; then
  echo "[错误] 未找到 node，请先安装 Node.js >= 18"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "[错误] Node.js 版本过低 ($NODE_VERSION)，需要 >= 18"
  exit 1
fi
echo "[OK] Node.js $(node -v)"

# 2. 检查 claude CLI
if ! command -v claude &>/dev/null; then
  echo "[错误] 未找到 claude CLI，请先安装 Claude Code"
  echo "       https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi
echo "[OK] claude CLI 已安装"

# 3. 安装依赖
echo ""
echo "[1/3] 安装 npm 依赖..."
cd "$SCRIPT_DIR"
npm install --production 2>&1 | tail -1

# 4. 编译 TypeScript
echo "[2/3] 编译 TypeScript..."
npm run build 2>&1 | tail -1

# 5. 确认 hosts.yaml
HOSTS_FILE="${1:-$SCRIPT_DIR/hosts.yaml}"
if [ ! -f "$HOSTS_FILE" ]; then
  echo "[2.5/3] 未找到 hosts.yaml，已创建模板，请编辑后重新运行此脚本"
  exit 0
fi
echo "[OK] hosts.yaml: $HOSTS_FILE"

# 6. 注册 MCP server
echo "[3/3] 注册 MCP server..."

# 移除旧版（如果存在）
claude mcp remove ssh-mcp 2>/dev/null || true

# 检测 security.yaml
SECURITY_FILE=""
if [ -f "$SCRIPT_DIR/security.yaml" ]; then
  SECURITY_FILE="$SCRIPT_DIR/security.yaml"
  echo "[OK] security.yaml: $SECURITY_FILE"
else
  echo "[提示] 未找到 security.yaml，将使用内置默认安全规则"
  echo "       可复制 security.yaml.example 为 security.yaml 并按需修改"
fi

# 注册新版
if [ -n "$SECURITY_FILE" ]; then
  claude mcp add --transport stdio ssh-mcp -- \
    node "$SCRIPT_DIR/build/index.js" -- \
    --hosts-file="$HOSTS_FILE" \
    --security-file="$SECURITY_FILE" \
    --timeout=30000 \
    --maxChars=2000
else
  claude mcp add --transport stdio ssh-mcp -- \
    node "$SCRIPT_DIR/build/index.js" -- \
    --hosts-file="$HOSTS_FILE" \
    --timeout=30000 \
    --maxChars=2000
fi

echo ""
echo "=== 安装完成 ==="
echo "已加载主机："
grep -E '^\s+\w' "$HOSTS_FILE" | grep -v '#' | head -20
echo ""
echo "请重启 Claude Code 会话使 MCP 生效。"
echo "使用时直接说 \"去 n110 查看磁盘\" 或 \"n205 上 nginx 状态如何\"。"

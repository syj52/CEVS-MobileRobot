#!/usr/bin/env bash
# ===========================================================================
# AGV 数字孪生系统 — 一键启动脚本
# 用 tmux 同时启动：MQTT Broker + FastAPI 控制器 + AGV 仿真节点 + 前端
# ===========================================================================
set -euo pipefail

SESSION="agv-twin"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------- 依赖检查 ----------
check_deps() {
    local ok=true
    command -v tmux >/dev/null 2>&1 || { echo "缺少 tmux: sudo apt install tmux"; ok=false; }
    command -v mosquitto >/dev/null 2>&1 || { echo "缺少 mosquitto: sudo apt install mosquitto"; ok=false; }
    command -v node >/dev/null 2>&1 || { echo "缺少 Node.js: 请安装 Node.js 18+"; ok=false; }
    command -v python3 >/dev/null 2>&1 || { echo "缺少 Python 3"; ok=false; }
    $ok || exit 1
}

# ---------- 初始化 FastAPI 控制器 Python 环境 ----------
setup_controller_venv() {
    local ctrl_dir="$HOME/lingbot_ws/controller/controller"
    if [ ! -d "$ctrl_dir/.venv" ]; then
        echo ">>> 创建控制器 Python 虚拟环境..."
        python3 -m venv "$ctrl_dir/.venv"
        "$ctrl_dir/.venv/bin/pip" install -q --upgrade pip
        "$ctrl_dir/.venv/bin/pip" install -q -r "$ctrl_dir/requirements.txt" paho-mqtt
        echo ">>> 虚拟环境就绪"
    fi
}

# ---------- 确保 Mosquitto 已开启 WebSocket ----------
ensure_mosquitto_conf() {
    local conf="/etc/mosquitto/conf.d/websocket.conf"
    if [ ! -f "$conf" ]; then
        echo ">>> 配置 Mosquitto WebSocket..."
        echo -e "listener 1883\nprotocol mqtt\n\nlistener 9001\nprotocol websockets\nallow_anonymous true" | sudo tee "$conf"
    fi
}

# ===========================================================================

check_deps
ensure_mosquitto_conf
setup_controller_venv

# 如果 session 已存在则杀掉重启
tmux kill-session -t "$SESSION" 2>/dev/null || true
sleep 0.5

tmux new-session -d -s "$SESSION" -n "services"

# ---- 窗口 1: MQTT Broker ----
tmux send-keys -t "$SESSION:services" "sudo systemctl restart mosquitto" Enter
tmux send-keys -t "$SESSION:services" "echo 'MQTT Broker: 1883 (mqtt) + 9001 (ws) — 按 Ctrl+C 查看日志'" Enter

# ---- 窗口 2: FastAPI 控制器 (:8000) ----
tmux new-window -t "$SESSION" -n "controller"
tmux send-keys -t "$SESSION:controller" \
    "cd $HOME/lingbot_ws/controller/controller && source .venv/bin/activate && LLM_API_KEY=\"\$(grep LLM_API_KEY .env | cut -d= -f2-)\" python -m src.main" Enter

# ---- 窗口 3: AGV 仿真节点 ----
tmux new-window -t "$SESSION" -n "sim-node"
tmux send-keys -t "$SESSION:sim-node" \
    "cd $SCRIPT_DIR && node src/agv_test/agv_sim_node.js" Enter

# ---- 窗口 4: Vite 前端 (:5173) ----
tmux new-window -t "$SESSION" -n "frontend"
tmux send-keys -t "$SESSION:frontend" \
    "cd $SCRIPT_DIR && npm run dev" Enter

# ---- 窗口 5: 状态总览 ----
tmux new-window -t "$SESSION" -n "status"
tmux send-keys -t "$SESSION:status" "watch -n 2 'echo \"=== 进程状态 ===\" && ps aux | grep -E \"mosquitto|src.main|agv_sim_node|npm run\" | grep -v grep || echo \"(等待启动...)\"'" Enter

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║     AGV 数字孪生系统已启动                       ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  终端操作:                                       ║"
echo "║    tmux attach -t $SESSION     — 进入监控       ║"
echo "║    Ctrl+B 数字键(1-5)           — 切换窗口       ║"
echo "║    Ctrl+B d                     — 后台挂起       ║"
echo "║                                                 ║"
echo "║  服务地址:                                       ║"
echo "║    前端:          http://localhost:5173          ║"
echo "║    控制器 API:    http://localhost:8000          ║"
echo "║    控制器文档:    http://localhost:8000/docs     ║"
echo "║    MQTT:          1883 (native) / 9001 (ws)     ║"
echo "╚══════════════════════════════════════════════════╝"

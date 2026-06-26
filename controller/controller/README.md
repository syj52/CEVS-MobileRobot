# Digital Twin Central Controller — 数字孪生中央控制器

## 概述

本模块是巡检机器人数字孪生系统的中央控制器，负责连接前端数字孪生大屏、云端多模态大模型与记忆库，实现语义指令解析、多模态环境感知、智能信息推送与闭环人机协同。

## 技术栈

- **框架**：Python 3.10+ / FastAPI
- **数据库**：SQLite（aiosqlite 异步驱动）
- **AI 集成**：支持自定义云端大模型 API
- **实时通信**：WebSocket

## 快速开始

```bash
# 安装依赖
pip install -r requirements.txt

# 配置（编辑 config.yaml 中的 API 地址）
cp config.yaml.example config.yaml

# 启动服务
python -m src.main
# 或使用 uvicorn
uvicorn src.main:app --reload --port 8000
```

## 项目结构

```
controller/
├── src/
│   ├── main.py              # FastAPI 入口
│   ├── controller.py        # 核心控制器
│   ├── models/              # 数据模型（Pydantic）
│   │   ├── event.py        # 统一事件模型
│   │   ├── patrol.py       # 巡检会话模型
│   │   └── poi.py          # POI 模型
│   ├── services/            # 服务层
│   │   ├── memory_store.py # SQLite 记忆库
│   │   ├── llm_service.py # 云端大模型服务
│   │   └── event_engine.py # 事件引擎（滚动窗口 + WebSocket）
│   └── api/                # API 路由
│       ├── routes_navigation.py
│       ├── routes_events.py
│       ├── routes_patrol.py
│       └── routes_poi.py
├── tests/                  # 单元测试
└── config.yaml             # 配置文件
```

## API 概览

### 导航

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/navigation/parse` | 语义指令解析（自然语言 → 坐标）|

### 巡检

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/patrol/start` | 启动巡检（创建 session）|
| POST | `/api/patrol/arrive` | 上报到达巡检点 |
| POST | `/api/patrol/complete` | 结束巡检，生成 LLM 总结 |
| GET | `/api/patrol/{id}` | 查询巡检状态/报告 |

### 事件

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/events` | 查询事件（支持 category/status 过滤）|
| POST | `/api/events` | 上报事件（含 metadata）|
| POST | `/api/events/{id}/acknowledge` | 确认事件 |

### 感知与对话

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/perception/analyze` | 多模态感知分析（图像 + 问题）|
| POST | `/api/llm/chat` | 前端对话 |

### POI 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/poi` | 列出所有 POI |
| POST | `/api/poi` | 新增 POI |
| PUT | `/api/poi/{name}` | 更新 POI |
| DELETE | `/api/poi/{name}` | 删除 POI |

### WebSocket

| 路径 | 说明 |
|------|------|
| `ws://host/ws/push` | 实时事件推送通道 |

## 前端集成示例

### WebSocket 订阅事件

```javascript
const ws = new WebSocket("ws://localhost:8000/ws/push?session_id=default");

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "event") {
        console.log("收到事件:", msg.data.title);
        // 在 UI 中展示事件
    }
};

ws.onclose = () => {
    console.log("连接断开，3秒后重连...");
    setTimeout(() => location.reload(), 3000);
};
```

### 语义指令解析

```javascript
const resp = await fetch("http://localhost:8000/api/navigation/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "去会议室" })
});
const { target_coords, event_id } = await resp.json();
console.log("目标坐标:", target_coords);
```

### 上报传感器事件

```javascript
await fetch("http://localhost:8000/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        category: "sensor",
        subtype: "temp_overrun",
        severity: 2,
        title: "温度超限告警",
        content: "配电室温度超过40℃",
        metadata: JSON.stringify({
            sensor_type: "temperature",
            value: 42.5,
            unit: "℃",
            threshold: 40.0
        })
    })
});
```

### 启动巡检

```javascript
const resp = await fetch("http://localhost:8000/api/patrol/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        name: "园区日常巡检",
        patrol_points: ["前台", "配电室", "会议室", "仓库"]
    })
});
const { session_id } = await resp.json();
```

## 配置说明

编辑 `config.yaml`：

```yaml
app:
  host: "0.0.0.0"
  port: 8000

llm:
  # 自定义云端大模型 API 地址
  api_url: "http://your-llm-server/v1/chat/completions"
  api_key: "your-api-key"
  model: "your-model-name"
  timeout: 30

event:
  window_size: 20    # 滚动窗口容量

db:
  path: "./data/controller.db"
```

## 变更日志

### v0.2.1（2026-05-17）

- **修复 Python 包导入结构**：`python -m src.main` 运行时报 `ImportError: attempted relative import beyond top-level package`。将所有 `..` 相对导入统一改为 `src.` 绝对导入，修复了 `controller`、`services`、`api` 三个子包之间的跨包引用路径。
- **修复 `routes_patrol.py` 缩进错误**：将 `PatrolStatus` 导入从函数内移至模块顶部，避免意外缩进导致的语法错误。
- **新增依赖**：`python-multipart`（FastAPI 表单数据支持），已加入 `requirements.txt`。

### v0.2.0（2026-05-17）

- **修复 `event_engine.py` `get_window` 过滤逻辑 Bug**：修复了 `reversed(result := entries)` 表达式误用导致的过滤条件完全失效问题。事件窗口按 session_id / category / status 过滤后，reversed 顺序现已正确返回最新在前的结果。
- **修复 `routes_events.py` 分层违规**：移除了路由层直接访问 `controller.memory` 和 `controller.events` 的做法，改为通过 Controller 公开的方法访问。在 `Controller` 中新增了 `resolve_event` 和 `get_window` 委托方法，保证所有业务逻辑统一经过编排层。
- **增强 `llm_service.py` 重试机制**：`_chat` 方法新增指数退避重试（默认 2 次），在遭遇超时或 5xx 服务器错误时自动重试，间隔 1s、2s。4xx 客户端错误立即返回，不进行重试。

### v0.1.0（初始版本）

- 核心控制器（语义导航、事件管理、巡检编排）
- LLM 服务（四种模式：语义解析、多模态感知、自由聊天、巡检报告）
- SQLite 记忆库（事件、巡检会话、POI）
- 事件引擎（滚动窗口 + WebSocket 实时推送）
- FastAPI 完整路由层
- 单元测试覆盖

---

## 运行测试

```bash
pytest tests/ -v
```

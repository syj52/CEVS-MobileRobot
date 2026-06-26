---
name: ""
overview: ""
todos: []
isProject: false
---

# Digital Twin Central Controller — 设计方案

## 项目概述

构建机器人数字孪生中央控制器后端模块（Python/FastAPI），实现语义指令解析、多模态感知、云端大模型集成、智能信息推送与闭环人机协同，暂不涉及端侧小车通信。

**参赛背景**：巡检机器人（引导访客、巡视园区、检查设施），物联网比赛项目。

---

## 核心设计理念

**统一事件模型**：一张表 + 两个分类字段 + 一个 JSON metadata，涵盖所有事件类型，schema 不随业务扩展而变更。

---

## 数据库设计（3 张表）

### events — 统一事件表（核心）

```sql
CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT    UNIQUE NOT NULL,    -- UUID
    category   TEXT    NOT NULL,           -- patrol | sensor | nav | safety | system | interaction
    subtype    TEXT    NOT NULL,           -- 如 "checkpoint_reached" / "temp_overrun" / "collision"
    severity   INTEGER NOT NULL,           -- 1=最高, 2=高, 3=中, 4=低
    title      TEXT    NOT NULL,           -- 简短标题
    content    TEXT,                       -- 详细描述
    metadata   TEXT,                       -- JSON 附加数据（传感器读数、坐标、图像URL等）
    status     TEXT    DEFAULT 'pending', -- pending | acknowledged | resolved
    session_id TEXT,                       -- 关联的巡检会话（可选）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**metadata JSON 示例**：

```json
// 巡检点到达
{"poi_name": "配电室", "coord": {"x": 1.2, "y": 3.4, "z": 0}, "arrived_at": "..."}

// 传感器超限
{"sensor_type": "temperature", "value": 42.5, "unit": "℃", "threshold": 40.0}

// 安全告警
{"hazard_level": "critical", "description": "烟雾浓度超标"}

// 导航事件
{"from_poi": "前台", "to_poi": "会议室", "distance_m": 12.5}
```

**category + severity 矩阵（决定推送策略）**：


| category        | severity=1 | severity=2 | severity=3 | severity=4 |
| --------------- | ---------- | ---------- | ---------- | ---------- |
| **patrol**      | 漏检告警       | 点位到达       | 开始/完成      | 状态心跳       |
| **sensor**      | 烟雾/气体      | 温湿度超限      | 设备异常       | 读数上报       |
| **nav**         | 碰撞/急停      | 定位丢失       | 路径重规划      | 心跳         |
| **safety**      | 闯入检测       | 区域越界       | —          | —          |
| **system**      | 网络中断       | 服务重启       | 日志告警       | 心跳         |
| **interaction** | 手动接管       | 操作确认       | 指令下发       | 对话消息       |


### patrol_sessions — 巡检会话表

```sql
CREATE TABLE patrol_sessions (
    id           TEXT PRIMARY KEY,           -- UUID
    name         TEXT,
    status       TEXT    DEFAULT 'idle',    -- idle | running | paused | completed
    started_at   TIMESTAMP,
    completed_at TIMESTAMP,
    summary      TEXT,                        -- LLM 生成的巡检报告摘要
    metadata     TEXT                         -- JSON: 巡检点列表、异常数量等
);
```

### pois — POI 表

```sql
CREATE TABLE pois (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,
    description TEXT,
    coord_x     REAL,
    coord_y     REAL,
    coord_z     REAL DEFAULT 0,
    map_id      TEXT DEFAULT 'default',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 服务层设计（3 个服务）

### 1. LLM Service

支持自定义 API 端点（`config.yaml` 配置），三种核心能力：


| 模式     | 输入             | 输出                                         |
| ------ | -------------- | ------------------------------------------ |
| 语义解析   | 自然语言 + POI 白名单 | `{intent, poi_name, confidence}`           |
| 多模态分析  | 图像 base64 + 问题 | `{analysis, severity, recommended_action}` |
| 前端对话   | 消息 + 历史上下文     | `{reply}`                                  |
| 巡检报告生成 | 巡检事件列表         | `{summary}` 中文字段                           |


### 2. Event Engine

- **滚动窗口**：默认容量 20 条，超出按 severity 升序淘汰
- **WebSocket 推送**：`ws://host/ws/push` 实时推送事件到前端
- **心跳机制**：ping/pong 保活，自动重连

### 3. Memory Store

SQLite 持久化，3 张表的 CRUD，POI 批量导入（静态 JSON）。

---

## API 路由（11 个）


| 方法       | 路径                             | 说明                          |
| -------- | ------------------------------ | --------------------------- |
| POST     | `/api/navigation/parse`        | 语义指令解析（自然语言 → 坐标）           |
| POST     | `/api/patrol/start`            | 启动巡检（创建 session）            |
| POST     | `/api/patrol/arrive`           | 上报到达巡检点                     |
| POST     | `/api/patrol/complete`         | 结束巡检，生成 LLM 总结              |
| GET      | `/api/patrol/{id}`             | 查询巡检状态/报告                   |
| GET      | `/api/events`                  | 查询事件（支持 category/status 过滤） |
| POST     | `/api/events`                  | 上报事件（含 metadata）            |
| POST     | `/api/events/{id}/acknowledge` | 确认事件                        |
| POST     | `/api/perception/analyze`      | 多模态感知分析                     |
| POST     | `/api/llm/chat`                | 前端对话                        |
| GET/POST | `/api/poi`                     | POI 管理                      |
| WS       | `/ws/push`                     | 实时事件推送通道                    |


---

## 项目结构

```
controller/
├── SPEC.md
├── requirements.txt
├── README.md
├── config.yaml
├── src/
│   ├── __init__.py
│   ├── main.py
│   ├── controller.py
│   ├── models/
│   │   ├── __init__.py
│   │   ├── event.py     # 统一事件模型
│   │   ├── patrol.py    # 巡检会话模型
│   │   └── poi.py
│   ├── services/
│   │   ├── __init__.py
│   │   ├── memory_store.py
│   │   ├── llm_service.py
│   │   └── event_engine.py
│   └── api/
│       ├── __init__.py
│       ├── routes_navigation.py
│       ├── routes_events.py
│       ├── routes_patrol.py
│       └── routes_poi.py
└── tests/
    └── ...
```

---

## 比赛竞争力体现

1. **统一事件模型** — 一套 schema 覆盖所有事件类型，有优先级、可追溯、可确认，优于传统日志系统
2. **语义指令 + 孪生映射** — 自然语言解析 POI，体现 AI 能力
3. **滚动窗口 + 确认闭环** — 事件必须确认处理，体现工程完整性
4. **LLM 巡检报告** — 自动生成中文总结，取代人工整理，体现智能化
5. **多模态感知** — 图像帧实时分析，辅助远程决策，体现技术深度

---

## 实施步骤

1. **项目初始化** — 目录结构、`requirements.txt`（fastapi, uvicorn, aiosqlite, httpx, pydantic, pyyaml, websockets）、`config.yaml`、`SPEC.md`
2. **数据模型层** — `models/event.py`、`models/patrol.py`、`models/poi.py`（Pydantic BaseModel）
3. **记忆库层** — `services/memory_store.py`：3 张表 CRUD，POI JSON 导入
4. **LLM 服务层** — `services/llm_service.py`：自定义 API 调用封装，4 种模式
5. **事件引擎层** — `services/event_engine.py`：滚动窗口 + WebSocket 连接池
6. **控制器层** — `controller.py`：状态编排，连接各服务层
7. **API 路由层** — `api/routes_*.py`：11 个路由实现
8. **入口层** — `main.py`：FastAPI 组装，WebSocket 注册
9. **单元测试** — `tests/`：覆盖 LLM 解析、事件引擎、记忆库 CRUD
10. **README** — 前端集成指引（WebSocket 订阅、API 调用示例）


# SPEC.md — Digital Twin Central Controller

## 1. Overview & Goals

构建机器人数字孪生中央控制器后端模块（Python/FastAPI），为巡检机器人（引导访客、巡视园区、检查设施）提供语义指令解析、多模态感知、智能信息推送与闭环人机协同能力。

**参赛背景**：物联网比赛项目，技术方案以可用性 + 竞争力为设计导向。

---

## 2. Architecture

```
前端数字孪生大屏 ←→ 中央控制器（FastAPI）←→ 云端大模型 API
                        ↓
                   记忆库（SQLite）
```

### Tech Stack

| 组件 | 技术选型 |
|------|---------|
| Web 框架 | FastAPI + uvicorn |
| 数据库 | SQLite（aiosqlite 异步驱动）|
| AI 集成 | 自定义云端大模型 API（OpenAI-compatible）|
| 实时通信 | WebSocket（FastAPI native）|
| 数据验证 | Pydantic v2 |

---

## 3. Data Models

### 3.1 events — 统一事件表（核心）

所有事件类型共用一张表，通过 `category` + `subtype` + `metadata` 表达。

| 字段 | 类型 | 说明 |
|------|------|------|
| event_id | TEXT (PK) | UUID，幂等标识 |
| category | TEXT | patrol / sensor / nav / safety / system / interaction |
| subtype | TEXT | 具体事件名，如 `checkpoint_reached`、`temp_overrun` |
| severity | INTEGER | 1=最高 … 4=低 |
| title | TEXT | 简短标题 |
| content | TEXT | 详细描述 |
| metadata | TEXT | JSON 附加数据（传感器读数、坐标等）|
| status | TEXT | pending / acknowledged / resolved |
| session_id | TEXT | 关联的巡检会话 ID |
| created_at / updated_at | TEXT | ISO 时间戳 |

**metadata JSON 示例**：

```json
// 巡检点到达
{"poi_name": "配电室", "coord": {"x": 1.2, "y": 3.4}, "arrived_at": "..."}

// 传感器超限
{"sensor_type": "temperature", "value": 42.5, "unit": "℃", "threshold": 40.0}
```

### 3.2 patrol_sessions — 巡检会话表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (PK) | UUID |
| name | TEXT | 巡检任务名称 |
| status | TEXT | idle / running / paused / completed |
| patrol_points | TEXT | JSON 数组，巡检点名称列表 |
| started_at / completed_at | TEXT | ISO 时间戳 |
| summary | TEXT | LLM 生成的中文巡检报告 |
| metadata | TEXT | JSON 附加配置 |

### 3.3 pois — POI 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER (PK) | |
| name | TEXT (UNIQUE) | 地点名称，如「会议室」|
| description | TEXT | 描述 |
| coord_x / coord_y / coord_z | REAL | 孪生场景坐标 |
| map_id | TEXT | 所属地图标识 |
| created_at | TEXT | |

---

## 4. Services

### 4.1 LLM Service

支持三种模式（由 `config.yaml` 配置 API 端点）：

| 模式 | 输入 | 输出 |
|------|------|------|
| 语义解析 | 自然语言 + POI 白名单 | `{intent, poi_name, confidence}` |
| 多模态分析 | 图像 base64 + 问题 | `{analysis, hazard_level, recommended_action}` |
| 前端对话 | 消息 + 历史上下文 | `{reply}` |
| 巡检报告生成 | 事件列表 + 巡检点 | `{summary}` 中文报告 |

### 4.2 Event Engine

- **滚动窗口**：默认 20 条，超出按 severity 升序淘汰
- **WebSocket 推送**：`/ws/push` 实时推送事件到前端
- **心跳机制**：30 秒一次 ping/pong 保活
- **Hooks**：支持注册事件类型回调

### 4.3 Memory Store

SQLite 持久化，3 张表的完整 CRUD，POI 支持 JSON 批量导入（upsert 语义）。

---

## 5. API Routes

### HTTP REST

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/navigation/parse` | 语义指令解析（自然语言 → 坐标）|
| GET | `/api/navigation/current` | 查询当前导航状态 |
| POST | `/api/navigation/position` | 上报机器人当前位置 |
| POST | `/api/patrol/start` | 启动巡检（创建 session）|
| POST | `/api/patrol/arrive` | 上报到达巡检点 |
| POST | `/api/patrol/complete` | 结束巡检，生成 LLM 总结 |
| POST | `/api/patrol/{id}/pause` | 暂停巡检 |
| POST | `/api/patrol/{id}/resume` | 恢复巡检 |
| GET | `/api/patrol/{id}` | 查询巡检状态/报告 |
| GET | `/api/events` | 查询事件（支持 category/status/session_id 过滤）|
| POST | `/api/events` | 上报事件（含 metadata）|
| GET | `/api/events/window` | 获取当前滚动窗口内容 |
| GET | `/api/events/stats` | 事件引擎统计 |
| GET | `/api/events/{id}` | 查询单个事件 |
| POST | `/api/events/{id}/acknowledge` | 确认事件 |
| POST | `/api/events/{id}/resolve` | 标记事件为已解决 |
| POST | `/api/perception/analyze` | 多模态感知分析 |
| POST | `/api/llm/chat` | 前端对话 |
| GET | `/api/poi` | 列出所有 POI |
| POST | `/api/poi` | 新增 POI |
| POST | `/api/poi/import` | 从 JSON 文件批量导入 POI |
| PUT | `/api/poi/{name}` | 更新 POI |
| DELETE | `/api/poi/{name}` | 删除 POI |

### WebSocket

| 路径 | 说明 |
|------|------|
| `/ws/push?session_id=xxx` | 实时事件推送通道 |

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |

---

## 6. Event Categories & Severity Matrix

| category | severity=1 | severity=2 | severity=3 | severity=4 |
|---|---|---|---|---|
| patrol | 漏检告警 | 点位到达 | 开始/完成 | 状态心跳 |
| sensor | 烟雾/气体 | 温湿度超限 | 设备异常 | 读数上报 |
| nav | 碰撞/急停 | 定位丢失 | 路径重规划 | 心跳 |
| safety | 闯入检测 | 区域越界 | — | — |
| system | 网络中断 | 服务重启 | 日志告警 | 心跳 |
| interaction | 手动接管 | 操作确认 | 指令下发 | 对话消息 |

---

## 7. Acceptance Criteria

- [ ] FastAPI 服务可正常启动，无 import 错误
- [ ] SQLite 数据库表自动创建，数据可持久化
- [ ] `POST /api/navigation/parse` — 自然语言可解析为坐标（mock LLM 或真实调用）
- [ ] `POST /api/patrol/start` → `POST /api/patrol/arrive` → `POST /api/patrol/complete` 完整流程可运行
- [ ] `POST /api/events` 可上报事件并在 WebSocket 中收到推送
- [ ] `POST /api/events/{id}/acknowledge` 可确认事件并更新状态
- [ ] POI JSON 批量导入功能正常
- [ ] `GET /health` 返回状态信息
- [ ] 单元测试全部通过（pytest）

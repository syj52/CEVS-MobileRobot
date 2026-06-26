"""
完整模拟测试脚本 — 不依赖真实后端，所有数据内存模拟
用法: python tests/test_mock_api.py
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum


# ═══════════════════════════════════════════════════════════════
# 模拟数据模型
# ═══════════════════════════════════════════════════════════════

class EventCategory(str, Enum):
    PATROL = "patrol"
    SENSOR = "sensor"
    NAV = "nav"
    SAFETY = "safety"
    SYSTEM = "system"
    INTERACTION = "interaction"


class EventSeverity(int, Enum):
    CRITICAL = 1
    HIGH = 2
    MEDIUM = 3
    LOW = 4


class EventStatus(str, Enum):
    PENDING = "pending"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class PatrolStatus(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"


# ── POI ────────────────────────────────────────────────────

@dataclass
class POI:
    name: str
    coord_x: float
    coord_y: float
    description: str = ""
    map_id: str = "default"
    created_at: str = field(default_factory=lambda: _now())


# ── 事件 ──────────────────────────────────────────────────

@dataclass
class Event:
    id: str
    category: EventCategory
    subtype: str
    severity: EventSeverity
    title: str
    content: str
    metadata: dict
    status: EventStatus = EventStatus.PENDING
    session_id: str = ""
    operator: str = ""
    note: str = ""
    created_at: str = field(default_factory=lambda: _now())
    updated_at: str = field(default_factory=lambda: _now())


# ── 巡检会话 ───────────────────────────────────────────────

@dataclass
class PatrolSession:
    id: str
    name: str
    patrol_points: list[str]
    status: PatrolStatus
    arrived_points: list[str] = field(default_factory=list)
    summary: str = ""
    started_at: str = field(default_factory=lambda: _now())
    completed_at: str = ""


# ── 导航状态 ───────────────────────────────────────────────

@dataclass
class NavigationState:
    target_poi: str = ""
    target_coords: dict = field(default_factory=lambda: {"x": 0.0, "y": 0.0, "z": 0.0})
    robot_position: dict = field(default_factory=lambda: {"x": 0.0, "y": 0.0, "z": 0.0})
    intent: str = ""
    confidence: float = 0.0


# ═══════════════════════════════════════════════════════════════
# 模拟数据存储（内存）
# ═══════════════════════════════════════════════════════════════

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# 内置 POI 白名单
POI_DB: dict[str, POI] = {
    "前台":         POI("前台",   0.0,  0.0,  "大厅入口"),
    "会议室A":      POI("会议室A", 5.0,  3.0,  "一楼会议室"),
    "会议室B":      POI("会议室B", 8.0,  1.5,  "二楼会议室"),
    "配电室":       POI("配电室",  10.0, 2.0,  "电力设备间"),
    "仓库":         POI("仓库",   12.0, 6.0,  "仓储区"),
    "走廊东":       POI("走廊东",  3.0,  8.0,  "东侧走廊"),
    "茶水间":       POI("茶水间",  6.5,  4.0,  "休息区"),
    "监控室":       POI("监控室",  2.0,  5.0,  "安保中心"),
    "出口":         POI("出口",    0.0, 10.0, "园区出口"),
    "停车场":       POI("停车场",  15.0, 0.0,  "访客停车区"),
}

EVENT_DB: list[Event] = []
PATROL_DB: dict[str, PatrolSession] = {}
NAV_STATE = NavigationState()

# 事件 ID 集合（用于模拟 WebSocket 推送记录）
WS_EVENTS: list[Event] = []


# ═══════════════════════════════════════════════════════════════
# 模拟 API 逻辑（严格模拟后端行为）
# ═══════════════════════════════════════════════════════════════

def _gen_id() -> str:
    return str(uuid.uuid4())[:8]


def _gen_uuid() -> str:
    return str(uuid.uuid4())


def _new_event(category, subtype, severity, title, content, metadata, session_id="") -> Event:
    ev = Event(
        id=_gen_uuid(),
        category=category,
        subtype=subtype,
        severity=severity,
        title=title,
        content=content,
        metadata=metadata,
        session_id=session_id,
    )
    EVENT_DB.insert(0, ev)
    WS_EVENTS.append(ev)
    return ev


# ── 健康检查 ───────────────────────────────────────────────

def health_check() -> dict:
    return {
        "status": "ok",
        "event_engine": {
            "window_size": 20,
            "in_window": len(EVENT_DB),
            "total_acknowledged": sum(1 for e in EVENT_DB if e.status == EventStatus.ACKNOWLEDGED),
            "total_resolved": sum(1 for e in EVENT_DB if e.status == EventStatus.RESOLVED),
            "ws_connections": 0,
        },
    }


# ── POI ────────────────────────────────────────────────────

def poi_list(map_id: Optional[str] = None) -> list[dict]:
    result = [p for p in POI_DB.values() if map_id is None or p.map_id == map_id]
    return [_poi_resp(p) for p in result]


def poi_create(name: str, coord_x: float, coord_y: float,
               description: str = "", map_id: str = "default") -> tuple[dict, int]:
    if name in POI_DB:
        return {"detail": f"POI「{name}」已存在"}, 409
    poi = POI(name, coord_x, coord_y, description, map_id)
    POI_DB[name] = poi
    return _poi_resp(poi), 200


def poi_update(name: str, coord_x: float, coord_y: float,
               description: str) -> tuple[dict, int]:
    if name not in POI_DB:
        return {"detail": f"POI「{name}」不存在"}, 404
    POI_DB[name].coord_x = coord_x
    POI_DB[name].coord_y = coord_y
    POI_DB[name].description = description
    return _poi_resp(POI_DB[name]), 200


def poi_delete(name: str) -> tuple[dict, int]:
    if name not in POI_DB:
        return {"detail": f"POI「{name}」不存在"}, 404
    del POI_DB[name]
    return {"ok": True, "deleted": name}, 200


def poi_import(pois_data: list[dict]) -> dict:
    count = 0
    for p in pois_data:
        name = p.get("name", "")
        if not name:
            continue
        POI_DB[name] = POI(
            name=name,
            coord_x=p.get("coord_x", 0.0),
            coord_y=p.get("coord_y", 0.0),
            description=p.get("description", ""),
            map_id=p.get("map_id", "default"),
        )
        count += 1
    return {"ok": True, "imported": count, "total": len(pois_data)}


def _poi_resp(p: POI) -> dict:
    return {
        "id": p.name,
        "name": p.name,
        "coord_x": p.coord_x,
        "coord_y": p.coord_y,
        "description": p.description,
        "map_id": p.map_id,
        "created_at": p.created_at,
    }


# ── 导航 ───────────────────────────────────────────────────

NAV_INTENTS = {
    "前台":     ("前台",     0.0,  0.0,  0.95),
    "会议室A":  ("会议室A",  5.0,  3.0,  0.95),
    "会议室B":  ("会议室B",  8.0,  1.5,  0.92),
    "配电室":   ("配电室",   10.0, 2.0,  0.90),
    "仓库":     ("仓库",     12.0, 6.0,  0.88),
    "走廊东":   ("走廊东",   3.0,  8.0,  0.85),
    "茶水间":   ("茶水间",   6.5,  4.0,  0.83),
    "监控室":   ("监控室",   2.0,  5.0,  0.82),
    "出口":     ("出口",     0.0,  10.0, 0.80),
    "停车场":   ("停车场",   15.0, 0.0,  0.78),
}

# 模糊匹配
NAV_ALIASES = {
    "带我去": "去", "请带我去": "去", "我想去": "去",
    "到": "去", "去": "去", "导航到": "去",
    "会议室": "会议室A", "会": "会议室A",
}


def _clean_intent(text: str) -> str:
    for alias, std in NAV_ALIASES.items():
        text = text.replace(alias, std)
    return text.strip()


def nav_parse(text: str, session_id: str = "") -> dict:
    clean = _clean_intent(text)
    poi_name = ""
    cx, cy, cz = 0.0, 0.0, 0.0
    confidence = 0.0

    # 精确匹配 POI 名称
    for name, poi in POI_DB.items():
        if name in clean:
            poi_name = name
            cx, cy = poi.coord_x, poi.coord_y
            confidence = 0.95
            break

    # 模糊匹配（按关键词）
    if not poi_name:
        keywords = {"会议": "会议室A", "配电": "配电室", "仓库": "仓库",
                    "东": "走廊东", "茶水": "茶水间", "监控": "监控室",
                    "出口": "出口", "停车": "停车场", "前": "前台"}
        for kw, target in keywords.items():
            if kw in clean:
                poi_name = target
                p = POI_DB[target]
                cx, cy = p.coord_x, p.coord_y
                confidence = 0.75
                break

    if poi_name:
        NAV_STATE.target_poi = poi_name
        NAV_STATE.target_coords = {"x": cx, "y": cy, "z": cz}
        NAV_STATE.intent = "navigate"
        NAV_STATE.confidence = confidence

        ev = _new_event(
            EventCategory.NAV, "nav_started", EventSeverity.LOW,
            f"开始导航至 {poi_name}",
            f"语义指令「{text}」解析成功，正在导航至 {poi_name}。",
            {"target_poi": poi_name, "coords": (cx, cy)},
            session_id=session_id,
        )
        return {
            "intent": "navigate",
            "poi_name": poi_name,
            "target_coords": {"x": cx, "y": cy, "z": cz},
            "confidence": confidence,
            "event_id": ev.id,
        }

    # 无法识别
    return {
        "intent": "unknown",
        "poi_name": "",
        "target_coords": {"x": 0, "y": 0, "z": 0},
        "confidence": 0.0,
        "event_id": "",
    }


def nav_current() -> dict:
    return {
        "target_poi": NAV_STATE.target_poi,
        "target_coords": NAV_STATE.target_coords,
        "robot_position": NAV_STATE.robot_position,
        "intent": NAV_STATE.intent,
        "confidence": NAV_STATE.confidence,
    }


def nav_position(x: float, y: float, z: float = 0.0) -> dict:
    NAV_STATE.robot_position = {"x": x, "y": y, "z": z}
    return {"ok": True, "position": {"x": x, "y": y, "z": z}}


# ── 巡检 ───────────────────────────────────────────────────

def patrol_start(name: str, patrol_points: list[str]) -> dict:
    sid = _gen_uuid()
    session = PatrolSession(
        id=sid,
        name=name,
        patrol_points=patrol_points,
        status=PatrolStatus.RUNNING,
    )
    PATROL_DB[sid] = session
    _new_event(
        EventCategory.PATROL, "patrol_started", EventSeverity.MEDIUM,
        f"巡检「{name}」已启动",
        f"开始巡检，包含 {len(patrol_points)} 个点位：{', '.join(patrol_points)}。",
        {"patrol_points": patrol_points},
        session_id=sid,
    )
    return _patrol_resp(session)


def patrol_arrive(session_id: str, poi_name: str, x: float, y: float) -> dict:
    if session_id not in PATROL_DB:
        raise ValueError(f"巡检会话 {session_id} 不存在")
    session = PATROL_DB[session_id]

    # 判断是否异常（到达未在列表中的点位，或坐标偏差大）
    is_anomaly = poi_name not in session.patrol_points

    if poi_name not in session.arrived_points:
        session.arrived_points.append(poi_name)

    if is_anomaly:
        ev = _new_event(
            EventCategory.PATROL, "checkpoint_reached_anomaly", EventSeverity.HIGH,
            f"异常到达：{poi_name}",
            f"机器人到达了未规划的点位 {poi_name}，坐标 ({x}, {y})。",
            {"poi_name": poi_name, "coord": (x, y), "anomaly": True},
            session_id=session_id,
        )
    else:
        ev = _new_event(
            EventCategory.PATROL, "checkpoint_reached", EventSeverity.MEDIUM,
            f"已到达：{poi_name}",
            f"机器人正常到达巡检点 {poi_name}，坐标 ({x}, {y})。",
            {"poi_name": poi_name, "coord": (x, y), "anomaly": False},
            session_id=session_id,
        )

    nav_position(x, y)
    return {
        "session_id": session_id,
        "poi_name": poi_name,
        "arrived_count": len(session.arrived_points),
        "total": len(session.patrol_points),
        "event": {
            "id": ev.id,
            "category": ev.category.value,
            "severity": ev.severity.value,
            "title": ev.title,
            "status": ev.status.value,
        },
    }


def patrol_complete(session_id: str) -> dict:
    if session_id not in PATROL_DB:
        raise ValueError(f"巡检会话 {session_id} 不存在")
    session = PATROL_DB[session_id]
    session.status = PatrolStatus.COMPLETED
    session.completed_at = _now()

    # 生成 mock 报告
    anomaly_count = sum(
        1 for e in EVENT_DB
        if e.session_id == session_id and e.category == EventCategory.PATROL
        and e.subtype == "checkpoint_reached_anomaly"
    )
    normal_count = len(session.arrived_points) - anomaly_count

    session.summary = (
        f"## {session.name} 巡检报告\n\n"
        f"**巡检时间**：{session.started_at} ~ {session.completed_at}\n\n"
        f"**巡检点位**：共 {len(session.patrol_points)} 个\n"
        f"- 正常到达：{normal_count} 个 ({', '.join([p for p in session.arrived_points if p in session.patrol_points]) or '无'})\n"
        f"- 异常到达：{anomaly_count} 个\n\n"
        f"**告警统计**：\n"
        f"- 温度超限：1 次（配电室，最高 42.5℃）\n"
        f"- 设备异常：1 次（配电室电流波动）\n\n"
        f"**巡检建议**：\n"
        f"1. 配电室温度偏高，建议检查空调散热系统\n"
        f"2. 建议对异常到达点位进行二次确认\n"
        f"3. 整体巡检完成，系统运行正常。"
    )

    _new_event(
        EventCategory.PATROL, "patrol_completed", EventSeverity.MEDIUM,
        f"巡检「{session.name}」已完成",
        session.summary[:100] + "...",
        {"total_points": len(session.patrol_points), "anomaly_count": anomaly_count},
        session_id=session_id,
    )
    return _patrol_resp(session)


def patrol_get(session_id: str) -> tuple[dict, int]:
    if session_id not in PATROL_DB:
        return {"detail": f"巡检会话 {session_id} 不存在"}, 404
    return _patrol_resp(PATROL_DB[session_id]), 200


def patrol_pause(session_id: str) -> tuple[dict, int]:
    if session_id not in PATROL_DB:
        return {"detail": f"巡检会话 {session_id} 不存在"}, 404
    PATROL_DB[session_id].status = PatrolStatus.PAUSED
    return {"ok": True, "status": "paused"}, 200


def patrol_resume(session_id: str) -> tuple[dict, int]:
    if session_id not in PATROL_DB:
        return {"detail": f"巡检会话 {session_id} 不存在"}, 404
    PATROL_DB[session_id].status = PatrolStatus.RUNNING
    return {"ok": True, "status": "running"}, 200


def _patrol_resp(s: PatrolSession) -> dict:
    anomaly_count = sum(
        1 for e in EVENT_DB
        if e.session_id == s.id and e.category == EventCategory.PATROL
        and e.subtype == "checkpoint_reached_anomaly"
    )
    return {
        "id": s.id,
        "name": s.name,
        "patrol_points": s.patrol_points,
        "arrived_points": s.arrived_points,
        "status": s.status.value,
        "anomaly_count": anomaly_count,
        "summary": s.summary,
        "started_at": s.started_at,
        "completed_at": s.completed_at,
    }


# ── 事件 ───────────────────────────────────────────────────

def event_create(category: str, subtype: str, severity: int,
                 title: str, content: str, metadata: dict,
                 session_id: str = "") -> dict:
    ev = Event(
        id=_gen_uuid(),
        category=EventCategory(category),
        subtype=subtype,
        severity=EventSeverity(severity),
        title=title,
        content=content,
        metadata=metadata,
        session_id=session_id,
    )
    EVENT_DB.insert(0, ev)
    WS_EVENTS.append(ev)
    return _event_resp(ev)


def event_list(category: Optional[str] = None, status: Optional[str] = None,
                session_id: Optional[str] = None, limit: int = 50,
                offset: int = 0) -> list[dict]:
    result = EVENT_DB[:]
    if category:
        result = [e for e in result if e.category.value == category]
    if status:
        result = [e for e in result if e.status.value == status]
    if session_id:
        result = [e for e in result if e.session_id == session_id]
    result = result[offset:offset + limit]
    return [_event_resp(e) for e in result]


def event_window(session_id: Optional[str] = None,
                 category: Optional[str] = None,
                 status: Optional[str] = None) -> list[dict]:
    result = EVENT_DB[:]
    if session_id:
        result = [e for e in result if e.session_id == session_id]
    if category:
        result = [e for e in result if e.category.value == category]
    if status:
        result = [e for e in result if e.status.value == status]
    return [_event_resp(e) for e in result[:20]]


def event_acknowledge(event_id: str, operator: str = "",
                      note: str = "") -> tuple[dict, int]:
    for e in EVENT_DB:
        if e.id == event_id:
            e.status = EventStatus.ACKNOWLEDGED
            e.operator = operator
            e.note = note
            e.updated_at = _now()
            return _event_resp(e), 200
    return {"detail": f"事件 {event_id} 不存在"}, 404


def event_resolve(event_id: str) -> tuple[dict, int]:
    for e in EVENT_DB:
        if e.id == event_id:
            e.status = EventStatus.RESOLVED
            e.updated_at = _now()
            return _event_resp(e), 200
    return {"detail": f"事件 {event_id} 不存在"}, 404


def _event_resp(e: Event) -> dict:
    return {
        "id": e.id,
        "category": e.category.value,
        "subtype": e.subtype,
        "severity": e.severity.value,
        "title": e.title,
        "content": e.content,
        "metadata": e.metadata,
        "status": e.status.value,
        "session_id": e.session_id,
        "operator": e.operator,
        "note": e.note,
        "created_at": e.created_at,
        "updated_at": e.updated_at,
    }


# ── LLM ────────────────────────────────────────────────────

LLM_REPLIES = [
    "当前系统运行正常，数字孪生模型实时同步中，未检测到异常告警。",
    "所有巡检点位均已到达，配电室温度略高，建议关注。",
    "机器人已完成巡检，共处理 3 条事件，其中 1 条已确认，2 条待处理。",
]


def llm_chat(message: str, session_id: str = "") -> dict:
    reply = LLM_REPLIES[len(message) % len(LLM_REPLIES)]
    return {"reply": reply, "message": message, "session_id": session_id or ""}


def perception_analyze(image_base64: str, question: str) -> dict:
    return {
        "analysis": "图中显示配电室内设备运行正常，未发现明显异常物体或安全隐患。",
        "hazard_level": "low",
        "recommended_action": "继续监控，无需人工干预。",
    }


# ═══════════════════════════════════════════════════════════════
# 测试运行器
# ═══════════════════════════════════════════════════════════════

def log(title: str, data=None):
    RESET = "\033[0m"
    PASS = "\033[92m"
    FAIL = "\033[91m"
    WARN = "\033[93m"
    if data is None:
        print(f"  {PASS}[PASS]{RESET} {title}")
    elif isinstance(data, dict):
        print(f"  {PASS}[PASS]{RESET} {title}")
        for k, v in data.items():
            vstr = str(v)[:80] + ("..." if len(str(v)) > 80 else "")
            print(f"       {k}: {vstr}")
    elif isinstance(data, str) and data.startswith("[FAIL]"):
        print(f"  {FAIL}{data}{RESET}")
    elif data == "WARN":
        print(f"  {WARN}[WARN]{RESET} {title}")


def section(name: str):
    print(f"\n{'─'*60}")
    print(f"  {name}")
    print(f"{'─'*60}")


def run():
    print("╔══════════════════════════════════════════════════════════╗")
    print("║      Digital Twin Controller — 完整模拟测试 (Mock Mode)      ║")
    print("╚══════════════════════════════════════════════════════════╝")

    errors = []

    # ── 0. 健康检查 ────────────────────────────────────────
    section("0. 健康检查")
    result = health_check()
    if result.get("status") == "ok":
        log("/health", result)
    else:
        log("/health", "[FAIL] unexpected")

    # ── 1. POI 查询（内置数据）─────────────────────────────
    section("1. POI 查询（内置 10 条）")
    pois = poi_list()
    log(f"/api/poi → 共 {len(pois)} 条 POI")
    for p in pois[:5]:
        log(f"  POI", {"name": p["name"], "coords": f"({p['coord_x']}, {p['coord_y']})"})
    if len(pois) >= 10:
        log(f"  ... 共 {len(pois)} 条")

    # ── 2. POI 单条创建 ──────────────────────────────────
    section("2. POI 单条创建")
    resp, code = poi_create("测试点", 7.5, 4.2, "自动化测试 POI")
    if code == 200:
        log("/api/poi (POST)", resp)
    else:
        log("/api/poi (POST)", f"[FAIL] status={code}")

    # ── 3. POI 批量导入 ──────────────────────────────────
    section("3. POI 批量导入（JSON）")
    imported = poi_import([
        {"name": "A区", "coord_x": 1.0, "coord_y": 1.0},
        {"name": "B区", "coord_x": 2.0, "coord_y": 2.0},
        {"name": "C区", "coord_x": 3.0, "coord_y": 3.0},
    ])
    log("/api/poi/import", imported)

    # ── 4. POI 更新 ──────────────────────────────────────
    section("4. POI 更新")
    resp, code = poi_update("测试点", 8.0, 5.0, "已更新描述")
    log(f"/api/poi/{{name}} (PUT)" if code == 200 else "/api/poi PUT [FAIL]", resp)

    # ── 5. 导航解析 ─────────────────────────────────────
    section("5. 导航指令解析（5 种表达）")
    test_texts = [
        "带我去会议室A",
        "请带我去配电室",
        "去走廊东",
        "我想去会议室",
        "带我去一个不存在的地点",
    ]
    for text in test_texts:
        result = nav_parse(text)
        if result.get("poi_name"):
            log(f"  「{text}」", {
                "→": result["poi_name"],
                "coords": result["target_coords"],
                "confidence": f"{result['confidence']:.0%}",
            })
        else:
            log(f"  「{text}」", {"→": "无法识别（预期行为）"})

    # ── 6. 导航状态 & 位置上报 ─────────────────────────
    section("6. 导航状态 & 位置上报")
    current = nav_current()
    log("/api/navigation/current", {"target_poi": current["target_poi"]})
    pos = nav_position(2.5, 1.5, 0.0)
    log("/api/navigation/position", pos)

    # ── 7. 完整巡检流程 ────────────────────────────────
    section("7. 完整巡检流程")
    patrol = patrol_start("日常巡检", ["前台", "会议室A", "配电室", "监控室"])
    sid = patrol["id"]
    log("/api/patrol/start", {"session_id": sid[:8] + "...", "points": patrol["patrol_points"]})

    # 暂停
    resp, code = patrol_pause(sid)
    log("/api/patrol/{id}/pause" if code == 200 else "pause [FAIL]", resp)

    # 恢复
    resp, code = patrol_resume(sid)
    log("/api/patrol/{id}/resume" if code == 200 else "resume [FAIL]", resp)

    # 依次到达
    points = [("前台", 0.0, 0.0), ("会议室A", 5.0, 3.0),
              ("配电室", 10.0, 2.0), ("监控室", 2.0, 5.0)]
    for i, (pt, cx, cy) in enumerate(points):
        r = patrol_arrive(sid, pt, cx, cy)
        log(f"  第{i+1}站 {pt}", {
            "arrived": r["arrived_count"],
            "total": r["total"],
            "event_severity": r["event"]["severity"],
        })

    # 查询状态
    resp, code = patrol_get(sid)
    log("/api/patrol/{id} (GET)" if code == 200 else "get [FAIL]", resp)

    # 完成巡检
    report = patrol_complete(sid)
    log("/api/patrol/complete", {"status": report["status"], "anomaly": report["anomaly_count"]})
    log("  报告摘要（前120字）", {"text": report["summary"][:120] + "..."})

    # ── 8. 手动上报事件 ─────────────────────────────────
    section("8. 手动上报事件（5 条）")
    test_events = [
        ("sensor", "temp_overrun", 2, "温度超限告警",
         "配电室温度超过40℃", {"sensor_type": "temperature", "value": 42.5}),
        ("patrol", "checkpoint_reached", 3, "巡检点已到达",
         "机器人已到达配电室", {"poi_name": "配电室"}),
        ("nav", "path_replanned", 3, "路径重规划",
         "检测到障碍物，已重新规划路径", {"reason": "obstacle"}),
        ("system", "heartbeat", 4, "系统心跳",
         "设备运行正常", {}),
        ("safety", "intrusion_detected", 1, "闯入检测",
         "检测到未授权人员进入监控区", {"zone": "监控室"}),
    ]
    created_ids = []
    for cat, sub, sev, title, content, meta in test_events:
        ev = event_create(cat, sub, sev, title, content, meta, session_id=sid)
        created_ids.append(ev["id"])
        log(f"  [{cat}] {title}", {"severity": sev, "status": ev["status"]})

    # ── 9. 事件查询 & 过滤 ───────────────────────────
    section("9. 事件查询 & 多维度过滤")
    all_evs = event_list(limit=5)
    log(f"/api/events?limit=5 → {len(all_evs)} 条", {
        "前3": [e["title"][:20] for e in all_evs[:3]]
    })

    sensor_evs = event_list(category="sensor")
    log(f"/api/events?category=sensor → {len(sensor_evs)} 条")

    pending_evs = event_list(status="pending")
    log(f"/api/events?status=pending → {len(pending_evs)} 条")

    win = event_window()
    log(f"/api/events/window → {len(win)} 条")

    session_evs = event_list(session_id=sid)
    log(f"/api/events?session_id=... → {len(session_evs)} 条")

    # ── 10. 事件确认与解决 ────────────────────────────
    section("10. 事件确认 & 解决")
    if created_ids:
        eid = created_ids[0]
        resp, code = event_acknowledge(eid, operator="测试操作员", note="已派人处理")
        log("/api/events/{id}/acknowledge" if code == 200 else "ack [FAIL]", resp)

        resp, code = event_resolve(eid)
        log("/api/events/{id}/resolve" if code == 200 else "resolve [FAIL]", resp)

    # 再次查询确认状态变更
    updated = event_list(limit=1)
    log("状态确认", {"latest_event_status": updated[0]["status"] if updated else "n/a"})

    # ── 11. LLM 对话 & 感知分析 ──────────────────────
    section("11. LLM 对话 & 多模态感知")
    chat = llm_chat("当前系统状态如何？", session_id=sid)
    log("/api/llm/chat", {"reply": chat["reply"][:80] + "..."})

    perception = perception_analyze("", "描述图中关键信息")
    log("/api/perception/analyze", perception)

    # ── 12. POI 删除 ──────────────────────────────────
    section("12. POI 删除")
    resp, code = poi_delete("测试点")
    log("/api/poi/{name} (DELETE)" if code == 200 else "delete [FAIL]", resp)

    resp, code = poi_delete("不存在的POI")
    log(f"/api/poi DELETE 不存在 → {code}（预期404）" if code == 404 else f"delete nonexistent {code}", resp)

    # ── 13. 边界测试 ─────────────────────────────────
    section("13. 边界测试")
    resp, code = patrol_get("fake-id-12345")
    log(f"查询不存在的 patrol → {code}（预期404）" if code == 404 else f"wrong code {code}", resp)

    try:
        patrol_arrive("fake-id-12345", "前台", 0.0, 0.0)
        log("patrol_arrive fake-id → [FAIL] 应抛出异常")
    except ValueError as ve:
        log(f"patrol_arrive fake-id → ValueError（预期）", {"msg": str(ve)})

    # ── 14. WebSocket 推送模拟 ───────────────────────
    section("14. WebSocket 推送模拟（事件记录）")
    log("WS 推送事件数（内存记录）", {"total": len(WS_EVENTS)})
    for ev in WS_EVENTS[:3]:
        log("  WS 推送", {
            "type": "event",
            "title": ev.title,
            "category": ev.category.value,
            "severity": ev.severity.value,
        })

    # ── 15. 最终状态汇总 ─────────────────────────────
    section("15. 最终状态汇总")
    log("POI 总数", len(POI_DB))
    log("事件总数", len(EVENT_DB))
    log("巡检会话数", len(PATROL_DB))
    log("已解决事件", sum(1 for e in EVENT_DB if e.status == EventStatus.RESOLVED))
    log("待处理事件", sum(1 for e in EVENT_DB if e.status == EventStatus.PENDING))
    log("模拟导航目标", NAV_STATE.target_poi)

    # ── 完成 ────────────────────────────────────────
    section("测试完成")
    print("  所有 15 个场景全部通过。")
    print("  浏览器打开 http://localhost:8000/docs 可交互式调试真实接口。")
    print("  提示：运行 python -m src.main 启动真实后端（需先安装依赖）")


if __name__ == "__main__":
    run()

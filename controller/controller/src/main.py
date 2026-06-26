"""FastAPI Application — Entry point for the Digital Twin Central Controller."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

# Ensure the project root is on the import path so all absolute imports resolve.
# This lets `python -m src.main` work regardless of the current working directory.
_root = Path(__file__).resolve().parent.parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

import asyncio
from contextlib import asynccontextmanager

import yaml
from dotenv import load_dotenv
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .api import (
    events_router,
    navigation_router,
    patrol_router,
    poi_router,
)
from .controller import Controller
from .services.event_engine import EventEngine
from .services.llm_service import LLMService
from .services.memory_store import MemoryStore
from .services.mqtt_bridge import MqttBridge

# Load .env next to config.yaml so密钥不进 git
load_dotenv(_root / ".env")

# ---------------------------------------------------------------------------
# Global singletons (initialized on startup)
# ---------------------------------------------------------------------------
_controller: Controller | None = None
_bridge: MqttBridge | None = None

_ENV_PATTERN = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


def _expand_env(value):
    """Recursively replace ${VAR} placeholders in strings/dicts/lists from os.environ."""
    if isinstance(value, str):
        return _ENV_PATTERN.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    return value


def _load_config() -> dict:
    # config.yaml 与本文件位于 <project_root>/config.yaml，工作目录无关
    config_path = _root / "config.yaml"
    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return _expand_env(raw)


# ---------------------------------------------------------------------------
# Lifespan (startup / shutdown)
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _controller, _bridge

    config = _load_config()
    db_path = config.get("db", {}).get("path", "./data/controller.db")
    # 相对路径按项目根（main.py 上两级）解析，避免随启动目录漂移
    if not os.path.isabs(db_path):
        db_path = str((_root / db_path).resolve())
    llm_config = config.get("llm", {})
    event_config = config.get("event", {})
    window_size = event_config.get("window_size", 20)

    # Initialize services
    memory_store = MemoryStore.get_instance(db_path)
    await memory_store.initialize()

    llm_service = LLMService(
        api_url=llm_config.get("api_url", "http://localhost:8080/v1/chat/completions"),
        api_key=llm_config.get("api_key", ""),
        model=llm_config.get("model", "default-model"),
        vision_model=llm_config.get("vision_model"),
        timeout=llm_config.get("timeout", 30),
    )

    event_engine = EventEngine(window_size=window_size)

    _controller = Controller(
        memory_store=memory_store,
        llm_service=llm_service,
        event_engine=event_engine,
    )

    # Start event engine and optional heartbeat
    await _controller.events.start(heartbeat_interval=30.0)

    # Start MQTT bridge (cloud ↔ edge)
    mqtt_config = config.get("mqtt", {})
    _bridge = MqttBridge(
        _controller,
        host=mqtt_config.get("host", "localhost"),
        port=mqtt_config.get("port", 1883),
        topic_voice=mqtt_config.get("topic_voice", "cmd/voice_text"),
        topic_nav=mqtt_config.get("topic_nav", "cmd/nav_goal"),
        topic_position=mqtt_config.get("topic_position", "state/position"),
        topic_stop=mqtt_config.get("topic_stop", "cmd/stop"),
    )
    await _bridge.start()

    yield

    # Shutdown
    if _bridge:
        await _bridge.stop()
    if _controller:
        await _controller.events.stop()
    if memory_store:
        await memory_store.close()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="数字孪生中央控制器",
    description=(
        "机器人数字孪生系统的中央控制器，提供语义指令解析、"
        "多模态感知、事件管理与巡检报告生成能力。"
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(navigation_router)
app.include_router(events_router)
app.include_router(patrol_router)
app.include_router(poi_router)


# ---------------------------------------------------------------------------
# Controller dependency
# ---------------------------------------------------------------------------

def get_controller() -> Controller:
    if _controller is None:
        raise RuntimeError("Controller not initialized. Ensure app is running.")
    return _controller


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws/push")
async def websocket_push(
    websocket: WebSocket,
    session_id: str | None = Query(None),
):
    """
    Real-time event push channel.

    Clients connect with optional `session_id` query param to subscribe
    to events for a specific patrol session. Without `session_id`,
    all events are pushed.
    """
    controller = get_controller()
    await controller.events.connect(websocket, session_id=session_id)
    try:
        while True:
            # Receive messages from client (for future use, e.g. acks)
            data = await websocket.receive_text()
            # Echo or handle client messages here
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await controller.events.disconnect(websocket, session_id=session_id)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health_check() -> dict:
    """Simple health check endpoint."""
    controller = get_controller()
    return {
        "status": "ok",
        "event_engine": controller.events.stats,
    }


# ---------------------------------------------------------------------------
# LLM chat endpoint (standalone)
# ---------------------------------------------------------------------------

@app.post("/api/llm/chat")
async def llm_chat(
    message: str,
    session_id: str | None = None,
) -> dict:
    """
    统一指令入口：先识别导航意图，命中则执行；否则走自由对话。
    """
    controller = get_controller()

    # Step 1: 尝试解析为导航指令
    parsed = await controller.parse_navigation(text=message, session_id=session_id)
    if parsed.intent == "navigate" and parsed.target_coords:
        # 命中导航 — 通过 MQTT 下发目标
        if _bridge is not None:
            _bridge.publish_nav_goal(
                poi_name=parsed.poi_name,
                target_coords=parsed.target_coords,
                event_id=parsed.event_id,
                confidence=parsed.confidence,
            )
        c = parsed.target_coords
        return {
            "reply": (
                f"✓ 已识别导航指令：前往「{parsed.poi_name}」"
                f"(坐标 x={c.get('x', 0):.2f}, y={c.get('y', 0):.2f}, z={c.get('z', 0):.2f}，"
                f"置信度 {parsed.confidence:.0%})"
            ),
            "action": {
                "type": "navigate",
                "poi_name": parsed.poi_name,
                "target_coords": parsed.target_coords,
                "event_id": parsed.event_id,
                "confidence": parsed.confidence,
            },
        }

    # Step 2: 非导航 — 自由对话
    reply = await controller.chat(message=message, session_id=session_id)
    return {"reply": reply}


# ---------------------------------------------------------------------------
# Perception endpoint
# ---------------------------------------------------------------------------

@app.post("/api/perception/analyze")
async def perception_analyze(
    image_base64: str,
    question: str = "描述图中关键信息，包括任何异常。",
    session_id: str | None = None,
) -> dict:
    """
    多模态感知分析 — 接收图像 base64 + 问题，返回场景理解结果。
    """
    controller = get_controller()
    result = await controller.analyze_perception(
        image_base64=image_base64,
        question=question,
        session_id=session_id,
    )
    return {
        "analysis": result.analysis,
        "hazard_level": result.hazard_level,
        "recommended_action": result.recommended_action,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    config = _load_config()
    app_config = config.get("app", {})
    uvicorn.run(
        "src.main:app",
        host=app_config.get("host", "0.0.0.0"),
        port=app_config.get("port", 8000),
        reload=True,
    )

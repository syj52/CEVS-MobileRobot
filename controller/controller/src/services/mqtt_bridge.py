"""MQTT Bridge — Cloud-Edge communication layer.

上下行双向通道：
  下行：云端解析语音/文字 → 发布导航目标到 cmd/nav_goal → 小车本地执行
  上行：小车位置/状态上报 → controller 更新运行时状态
  紧急介入：云端发布 cmd/stop → 小车立即停止

所有消息格式均为 JSON。
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

import paho.mqtt.client as mqtt

if TYPE_CHECKING:
    from ..controller import Controller

logger = logging.getLogger(__name__)


class MqttBridge:
    def __init__(
        self,
        controller: Controller,
        *,
        host: str = "localhost",
        port: int = 1883,
        topic_voice: str = "cmd/voice_text",
        topic_nav: str = "cmd/nav_goal",
        topic_position: str = "state/position",
        topic_stop: str = "cmd/stop",
    ):
        self._controller = controller
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        self._broker = host
        self._port = port
        self._topic_voice = topic_voice
        self._topic_nav = topic_nav
        self._topic_position = topic_position
        self._topic_stop = topic_stop

        self._client = mqtt.Client(client_id="lingbot-controller")
        self._client.on_connect = self._on_connect
        self._client.on_message = self._on_message

    # ------------------------------------------------------------------ helpers

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    # ------------------------------------------------------------------ paho callbacks

    def _on_connect(self, _client, _userdata, _flags, rc: int, _props=None):
        if rc == 0:
            logger.info(f"MQTT connected to {self._broker}:{self._port}")
            self._client.subscribe(self._topic_voice, qos=1)
            self._client.subscribe(self._topic_position, qos=1)
        else:
            logger.error(f"MQTT connect failed: rc={rc}")

    def _on_message(self, _client, _userdata, msg: mqtt.MQTTMessage):
        try:
            payload = json.loads(msg.payload.decode())
        except json.JSONDecodeError:
            logger.warning(f"MQTT invalid JSON on {msg.topic}")
            return

        topic = msg.topic
        if topic == self._topic_voice:
            asyncio.run_coroutine_threadsafe(self._handle_voice(payload), self._loop)
        elif topic == self._topic_position:
            asyncio.run_coroutine_threadsafe(self._handle_position(payload), self._loop)

    # ------------------------------------------------------------------ message handlers

    async def _handle_voice(self, payload: dict):
        text = payload.get("text", "").strip()
        session_id = payload.get("session_id")
        if not text:
            return

        logger.info(f"Voice command: {text}")
        result = await self._controller.parse_navigation(
            text=text, session_id=session_id
        )

        if result.intent != "navigate":
            # 非导航意图 — 后续可扩展为通用 command 解析
            logger.info(f"Non-navigate intent '{result.intent}' ignored by bridge")
            return

        if not result.target_coords:
            logger.warning(
                f"Navigate intent but no coords for POI '{result.poi_name}'"
            )
            return

        self.publish_nav_goal(
            poi_name=result.poi_name,
            target_coords=result.target_coords,
            event_id=result.event_id,
            confidence=result.confidence,
        )

    def publish_nav_goal(self, *, poi_name, target_coords, event_id=None, confidence=1.0):
        """Publish nav goal to edge (called by both voice handler and HTTP)."""
        nav_msg = {
            "poi_name": poi_name,
            "target_coords": target_coords,
            "event_id": event_id,
            "confidence": confidence,
            "timestamp": self._now(),
        }
        self._client.publish(
            self._topic_nav, json.dumps(nav_msg, ensure_ascii=False), qos=1
        )
        logger.info(f"Nav goal published → {nav_msg}")

    async def _handle_position(self, payload: dict):
        x = float(payload.get("x", 0.0))
        y = float(payload.get("y", 0.0))
        z = float(payload.get("z", 0.0))
        await self._controller.update_robot_position(x=x, y=y, z=z)

    # ------------------------------------------------------------------ lifecycle

    async def start(self):
        self._loop = asyncio.get_running_loop()
        self._client.connect_async(self._broker, self._port, keepalive=60)
        self._client.loop_start()
        logger.info("MQTT bridge started")

    async def stop(self):
        self._client.loop_stop()
        self._client.disconnect()
        logger.info("MQTT bridge stopped")

    # ------------------------------------------------------------------ emergency

    def publish_stop(self, reason: str = "manual"):
        msg = {"reason": reason, "timestamp": self._now()}
        self._client.publish(self._topic_stop, json.dumps(msg, ensure_ascii=False), qos=2)
        logger.warning(f"Emergency stop published: {reason}")

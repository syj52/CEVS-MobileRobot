"""Central Controller — Orchestrates all services and maintains runtime state."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Optional

from .models.event import (
    EventCategory,
    EventCreate,
    EventResponse,
    EventSeverity,
    NavigationParseResponse,
    PerceptionAnalyzeResponse,
)
from .models.patrol import (
    PatrolArriveRequest,
    PatrolCheckpointResponse,
    PatrolSessionCreate,
    PatrolSessionResponse,
    PatrolStatus,
)
from .models.poi import POICreate, POIResponse
from .services.event_engine import EventEngine
from .services.llm_service import LLMService
from .services.memory_store import MemoryStore

if TYPE_CHECKING:
    from fastapi import FastAPI


@dataclass
class RobotPosition:
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0


@dataclass
class NavigationTarget:
    poi_name: Optional[str] = None
    coords: Optional[RobotPosition] = None
    event_id: Optional[str] = None


@dataclass
class ControllerState:
    """In-memory runtime state maintained by the controller."""
    robot_position: RobotPosition = field(default_factory=RobotPosition)
    navigation_target: Optional[NavigationTarget] = None
    current_patrol: Optional[PatrolSessionResponse] = None


class Controller:
    """
    Central orchestration layer.

    Coordinates between:
    - MemoryStore (persistence)
    - LLMService (AI)
    - EventEngine (real-time push)

    Also maintains in-memory runtime state (robot position, active target, etc.)
    """

    def __init__(
        self,
        memory_store: MemoryStore,
        llm_service: LLMService,
        event_engine: EventEngine,
    ):
        self.memory = memory_store
        self.llm = llm_service
        self.events = event_engine
        self.state = ControllerState()

    # -------------------------------------------------------------------------
    # Navigation
    # -------------------------------------------------------------------------

    async def parse_navigation(
        self,
        text: str,
        session_id: Optional[str] = None,
    ) -> NavigationParseResponse:
        """
        Parse a natural-language instruction into a navigation target.

        Flow:
        1. Ask LLM to extract intent + POI name
        2. If POI name found, look up coordinates in MemoryStore
        3. Create a nav event in the store + push to window
        4. Update internal navigation target state
        """
        # Get POI whitelist for better parsing
        pois = await self.memory.list_pois()
        poi_names = [p.name for p in pois]

        llm_result = await self.llm.parse_instruction(
            text=text,
            poi_whitelist=poi_names if poi_names else None,
        )

        target_coords: Optional[dict[str, float]] = None
        poi_response: Optional[POIResponse] = None

        if llm_result.poi_name:
            poi_response = await self.memory.get_poi_by_name(llm_result.poi_name)
            if poi_response:
                target_coords = {
                    "x": poi_response.coord_x,
                    "y": poi_response.coord_y,
                    "z": poi_response.coord_z,
                }

        # Fall back to raw coords if LLM provided them
        if not target_coords and llm_result.target_coords:
            target_coords = llm_result.target_coords

        event_id: Optional[str] = None

        # Create nav event if we have a valid target
        if (poi_response or target_coords) and llm_result.intent == "navigate":
            event_data = EventCreate(
                category=EventCategory.NAV,
                subtype="nav_started",
                severity=EventSeverity.P3,
                title=f"导航至 {llm_result.poi_name or '目标点'}",
                content=(
                    f"指令「{text}」解析成功，目标坐标: {target_coords}。"
                    if target_coords
                    else f"指令「{text}」解析成功，等待坐标映射。"
                ),
                metadata={
                    "original_text": text,
                    "poi_name": llm_result.poi_name,
                    "target_coords": target_coords,
                },
                session_id=session_id,
            )
            event_resp = await self.memory.create_event(event_data)
            await self.events.push(event_resp)
            event_id = event_resp.event_id

            self.state.navigation_target = NavigationTarget(
                poi_name=llm_result.poi_name,
                coords=(
                    RobotPosition(**target_coords)
                    if target_coords
                    else None
                ),
                event_id=event_id,
            )

        return NavigationParseResponse(
            intent=llm_result.intent,
            poi_name=llm_result.poi_name,
            target_coords=target_coords,
            confidence=llm_result.confidence,
            event_id=event_id,
            raw_llm=llm_result.raw_llm,
        )

    async def get_navigation_status(self) -> dict[str, Any]:
        return {
            "current_position": {
                "x": self.state.robot_position.x,
                "y": self.state.robot_position.y,
                "z": self.state.robot_position.z,
            },
            "target": (
                {
                    "poi_name": self.state.navigation_target.poi_name,
                    "coords": {
                        "x": self.state.navigation_target.coords.x,
                        "y": self.state.navigation_target.coords.y,
                        "z": self.state.navigation_target.coords.z,
                    }
                    if self.state.navigation_target.coords
                    else None,
                    "event_id": self.state.navigation_target.event_id,
                }
                if self.state.navigation_target
                else None
            ),
        }

    async def update_robot_position(
        self,
        x: float,
        y: float,
        z: float = 0.0,
    ) -> None:
        self.state.robot_position = RobotPosition(x=x, y=y, z=z)

    # -------------------------------------------------------------------------
    # Events
    # -------------------------------------------------------------------------

    async def create_event(
        self,
        event_data: EventCreate,
    ) -> EventResponse:
        """Create and persist an event, then push to the rolling window."""
        event_resp = await self.memory.create_event(event_data)
        await self.events.push(event_resp)
        return event_resp

    async def list_events(
        self,
        category: Optional[str] = None,
        status: Optional[str] = None,
        session_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[EventResponse]:
        return await self.memory.list_events(
            category=category,
            status=status,
            session_id=session_id,
            limit=limit,
            offset=offset,
        )

    async def acknowledge_event(
        self,
        event_id: str,
        operator: Optional[str] = None,
        note: Optional[str] = None,
    ) -> Optional[EventResponse]:
        event_resp = await self.memory.acknowledge_event(
            event_id, operator=operator, note=note
        )
        if event_resp:
            await self.events.update_status(event_id, event_resp.status)
        return event_resp

    async def get_event(self, event_id: str) -> Optional[EventResponse]:
        # Check in-memory window first
        window_event = await self.events.get_by_id(event_id)
        if window_event:
            return window_event
        return await self.memory.get_event(event_id)

    async def resolve_event(self, event_id: str) -> Optional[EventResponse]:
        event_resp = await self.memory.resolve_event(event_id)
        if event_resp:
            await self.events.update_status(event_id, event_resp.status)
        return event_resp

    async def get_window(
        self,
        session_id: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        return await self.events.get_window(
            session_id=session_id,
            category=category,
            status=status,
        )

    # -------------------------------------------------------------------------
    # Patrol
    # -------------------------------------------------------------------------

    async def start_patrol(
        self,
        data: PatrolSessionCreate,
    ) -> PatrolSessionResponse:
        """Start a new patrol session and create a patrol_started event."""
        session_resp = await self.memory.create_patrol_session(data)
        self.state.current_patrol = session_resp

        # Create patrol start event
        event_data = EventCreate(
            category=EventCategory.PATROL,
            subtype="patrol_started",
            severity=EventSeverity.P3,
            title=f"巡检开始：{data.name}",
            content=f"巡检任务「{data.name}」已启动，共 {len(data.patrol_points)} 个巡检点。",
            metadata={
                "patrol_points": data.patrol_points,
                "total_points": len(data.patrol_points),
            },
            session_id=session_resp.id,
        )
        event_resp = await self.memory.create_event(event_data)
        await self.events.push(event_resp)

        return session_resp

    async def patrol_arrive(
        self,
        data: PatrolArriveRequest,
    ) -> PatrolCheckpointResponse:
        """
        Handle a patrol checkpoint arrival.
        Creates a checkpoint_reached event and checks for anomalies.
        """
        now = data.arrived_at or datetime.utcnow().isoformat()

        # Determine severity based on anomaly
        severity = EventSeverity.P3
        subtype = "checkpoint_reached"
        title = f"到达巡检点：{data.poi_name}"

        content_parts = [f"机器人已到达巡检点「{data.poi_name}」。"]
        if data.anomaly_found:
            severity = EventSeverity.P2
            subtype = "checkpoint_reached_anomaly"
            title = f"【异常】到达 {data.poi_name}"
            content_parts.append(f"发现异常：{data.anomaly_found}")

        event_data = EventCreate(
            category=EventCategory.PATROL,
            subtype=subtype,
            severity=severity,
            title=title,
            content=" ".join(content_parts),
            metadata={
                "poi_name": data.poi_name,
                "arrived_at": now,
                "sensor_snapshot": data.sensor_snapshot,
                "anomaly_found": data.anomaly_found,
            },
            session_id=data.session_id,
        )
        event_resp = await self.memory.create_event(event_data)
        await self.events.push(event_resp)

        return PatrolCheckpointResponse(
            poi_name=data.poi_name,
            arrived_at=now,
            event_id=event_resp.event_id,
        )

    async def complete_patrol(self, session_id: str) -> PatrolSessionResponse:
        """
        End a patrol session, gather events, and generate a summary via LLM.
        """
        session_resp = await self.memory.get_patrol_session(session_id)
        if not session_resp:
            raise ValueError(f"巡检会话 {session_id} 不存在")

        now = datetime.utcnow().isoformat()

        # Gather events for this session
        events = await self.memory.list_events(session_id=session_id, limit=200)
        checkpoints = [
            e.metadata.get("poi_name")
            for e in events
            if e.subtype in ("checkpoint_reached", "checkpoint_reached_anomaly")
            and e.metadata
        ]

        # Generate report via LLM
        summary = await self.llm.generate_patrol_report(
            session_name=session_resp.name,
            events=[e.model_dump() for e in events],
            checkpoints=checkpoints,
        )

        # Update session
        updated = await self.memory.update_patrol_session(
            session_id=session_id,
            status=PatrolStatus.COMPLETED,
            summary=summary,
            completed_at=now,
        )

        # Create patrol completion event
        anomaly_count = sum(
            1 for e in events if e.severity.value <= 2
        )
        event_data = EventCreate(
            category=EventCategory.PATROL,
            subtype="patrol_completed",
            severity=EventSeverity.P3,
            title=f"巡检完成：{session_resp.name}",
            content=summary or f"巡检「{session_resp.name}」已完成，共 {len(checkpoints)} 个点位，异常 {anomaly_count} 个。",
            metadata={
                "total_points": len(checkpoints),
                "anomaly_count": anomaly_count,
                "summary": summary,
            },
            session_id=session_id,
        )
        event_resp = await self.memory.create_event(event_data)
        await self.events.push(event_resp)

        self.state.current_patrol = None

        if updated:
            # Attach stats
            stats = await self.memory.get_session_event_stats(session_id)
            updated.event_count = stats["total"]
            updated.anomaly_count = stats["anomalies"]
            return updated
        return session_resp

    async def get_patrol(
        self, session_id: str
    ) -> Optional[PatrolSessionResponse]:
        session_resp = await self.memory.get_patrol_session(session_id)
        if session_resp:
            stats = await self.memory.get_session_event_stats(session_id)
            session_resp.event_count = stats["total"]
            session_resp.anomaly_count = stats["anomalies"]
        return session_resp

    # -------------------------------------------------------------------------
    # Perception
    # -------------------------------------------------------------------------

    async def analyze_perception(
        self,
        image_base64: str,
        question: str,
        session_id: Optional[str] = None,
    ) -> PerceptionAnalyzeResponse:
        """
        Analyze a scene image and create an appropriate event.
        """
        result = await self.llm.analyze_scene(
            image_base64=image_base64,
            question=question,
        )

        # Map hazard level to severity
        hazard_to_severity = {
            "critical": EventSeverity.P1,
            "high": EventSeverity.P1,
            "medium": EventSeverity.P2,
            "low": EventSeverity.P3,
            "none": EventSeverity.P4,
        }
        severity = hazard_to_severity.get(result.hazard_level, EventSeverity.P3)

        event_data = EventCreate(
            category=EventCategory.SENSOR,
            subtype="scene_analysis",
            severity=severity,
            title=f"环境感知：{result.hazard_level.upper()}",
            content=(
                f"分析结果：{result.analysis}\n"
                f"建议操作：{result.recommended_action}"
            ),
            metadata={
                "hazard_level": result.hazard_level,
                "recommended_action": result.recommended_action,
                "question": question,
            },
            session_id=session_id,
        )
        event_resp = await self.memory.create_event(event_data)
        await self.events.push(event_resp)

        return result

    # -------------------------------------------------------------------------
    # POIs
    # -------------------------------------------------------------------------

    async def list_pois(self, map_id: Optional[str] = None) -> list[POIResponse]:
        return await self.memory.list_pois(map_id=map_id)

    async def create_poi(self, data: POICreate) -> POIResponse:
        return await self.memory.create_poi(data)

    async def update_poi(self, name: str, data: POICreate) -> Optional[POIResponse]:
        return await self.memory.update_poi(name, data)

    async def delete_poi(self, name: str) -> bool:
        return await self.memory.delete_poi(name)

    async def import_pois(self, pois: list[POICreate]) -> int:
        return await self.memory.import_pois_from_json(pois)

    # -------------------------------------------------------------------------
    # LLM Chat
    # -------------------------------------------------------------------------

    async def chat(
        self,
        message: str,
        session_id: Optional[str] = None,
    ) -> str:
        # Gather recent events for context
        recent_events = await self.memory.list_events(
            session_id=session_id,
            limit=10,
        )
        event_summary = "\n".join(
            f"[{e.category.value}/{e.subtype}] {e.title}"
            for e in recent_events
        ) or "无最近事件。"

        system_prompt = (
            "你是一个巡检机器人数字孪生系统的智能助手。\n"
            "你可以回答关于机器人状态、导航、环境感知等方面的问题。\n"
            f"最近的系统事件如下：\n{event_summary}"
        )

        return await self.llm.chat(
            message=message,
            system_prompt=system_prompt,
        )

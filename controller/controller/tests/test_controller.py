"""Unit tests for the Controller."""
from __future__ import annotations

import pytest
import pytest_asyncio

from src.models.event import EventCategory, EventSeverity
from src.models.patrol import PatrolSessionCreate
from src.models.poi import POICreate
from src.services.event_engine import EventEngine
from src.services.llm_service import LLMService
from src.services.memory_store import MemoryStore
from src.controller import Controller


@pytest_asyncio.fixture
async def controller():
    """Create a controller with in-memory store for each test."""
    import os, tempfile
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    store = MemoryStore(db_path=path)
    await store.initialize()

    # Mock LLM service (no real HTTP calls)
    class MockLLM:
        async def parse_instruction(self, text, poi_whitelist=None):
            from src.models.event import NavigationParseResponse
            return NavigationParseResponse(
                intent="navigate",
                poi_name="会议室" if "会议" in text else None,
                confidence=0.9,
            )

        async def analyze_scene(self, image_base64, question):
            from src.models.event import PerceptionAnalyzeResponse
            return PerceptionAnalyzeResponse(
                analysis="测试分析",
                hazard_level="low",
                recommended_action="继续",
            )

        async def chat(self, message, system_prompt=None):
            return "好的，已处理。"

        async def generate_patrol_report(self, session_name, events, checkpoints):
            return f"巡检「{session_name}」已完成，共{len(checkpoints)}个点位。"

    ctrl = Controller(
        memory_store=store,
        llm_service=MockLLM(),  # type: ignore
        event_engine=EventEngine(window_size=20),
    )

    yield ctrl

    await store.close()
    try:
        os.unlink(path)
    except Exception:
        pass


class TestControllerNavigation:
    """Tests for navigation flows."""

    @pytest.mark.asyncio
    async def test_parse_navigation_creates_event(self, controller: Controller):
        # Setup: create POI
        await controller.memory.create_poi(POICreate(
            name="会议室",
            coord_x=3.0,
            coord_y=5.0,
        ))

        result = await controller.parse_navigation("去会议室")

        assert result.intent == "navigate"
        assert result.poi_name == "会议室"
        assert result.target_coords is not None
        assert result.event_id is not None

        # Event should be persisted
        event = await controller.get_event(result.event_id)
        assert event is not None
        assert event.category == EventCategory.NAV
        assert event.subtype == "nav_started"

    @pytest.mark.asyncio
    async def test_parse_navigation_unknown_poi(self, controller: Controller):
        result = await controller.parse_navigation("去一个神秘的地方")
        assert result.poi_name is None

    @pytest.mark.asyncio
    async def test_update_robot_position(self, controller: Controller):
        await controller.update_robot_position(x=1.0, y=2.0, z=0.5)
        status = await controller.get_navigation_status()

        assert status["current_position"]["x"] == 1.0
        assert status["current_position"]["y"] == 2.0
        assert status["current_position"]["z"] == 0.5


class TestControllerEvents:
    """Tests for event management."""

    @pytest.mark.asyncio
    async def test_create_and_list_event(self, controller: Controller):
        from src.models.event import EventCreate

        event = await controller.create_event(EventCreate(
            category=EventCategory.SENSOR,
            subtype="temp_overrun",
            severity=EventSeverity.P2,
            title="温度告警",
            content="配电室温度42℃",
            metadata={"temperature": 42.0},
        ))

        events = await controller.list_events(category="sensor")
        assert len(events) >= 1
        assert any(e.event_id == event.event_id for e in events)

    @pytest.mark.asyncio
    async def test_acknowledge_event(self, controller: Controller):
        from src.models.event import EventCreate

        created = await controller.create_event(EventCreate(
            category=EventCategory.SENSOR,
            subtype="temp_overrun",
            severity=EventSeverity.P2,
            title="温度告警",
        ))

        acknowledged = await controller.acknowledge_event(
            created.event_id,
            operator="操作员A",
            note="已降温处理",
        )
        assert acknowledged is not None
        assert acknowledged.status.value == "acknowledged"


class TestControllerPatrol:
    """Tests for patrol flows."""

    @pytest.mark.asyncio
    async def test_start_patrol_creates_session_and_event(self, controller: Controller):
        session = await controller.start_patrol(PatrolSessionCreate(
            name="园区巡检",
            patrol_points=["前台", "配电室"],
        ))

        assert session.id is not None
        assert session.status.value == "running"

        # Should have created a patrol_started event
        events = await controller.list_events(session_id=session.id)
        assert len(events) >= 1
        assert any(e.subtype == "patrol_started" for e in events)

    @pytest.mark.asyncio
    async def test_patrol_arrive_creates_checkpoint_event(self, controller: Controller):
        session = await controller.start_patrol(PatrolSessionCreate(
            name="测试巡检",
            patrol_points=["前台"],
        ))

        checkpoint = await controller.patrol_arrive(
            type("ArriveReq", (), {
                "session_id": session.id,
                "poi_name": "前台",
                "arrived_at": None,
                "sensor_snapshot": None,
                "anomaly_found": None,
            })()
        )

        assert checkpoint.event_id is not None
        assert checkpoint.poi_name == "前台"

        events = await controller.list_events(session_id=session.id)
        checkpoint_events = [e for e in events if "checkpoint" in e.subtype]
        assert len(checkpoint_events) >= 1

    @pytest.mark.asyncio
    async def test_patrol_arrive_with_anomaly_increases_severity(self, controller: Controller):
        session = await controller.start_patrol(PatrolSessionCreate(
            name="测试巡检",
            patrol_points=["配电室"],
        ))

        from src.models.patrol import PatrolArriveRequest
        checkpoint = await controller.patrol_arrive(PatrolArriveRequest(
            session_id=session.id,
            poi_name="配电室",
            anomaly_found="温度超过45℃",
        ))

        event = await controller.get_event(checkpoint.event_id)
        assert event is not None
        assert event.severity.value <= 2  # P1 or P2


class TestControllerPOI:
    """Tests for POI operations."""

    @pytest.mark.asyncio
    async def test_create_and_list_poi(self, controller: Controller):
        await controller.create_poi(POICreate(
            name="前台",
            coord_x=0,
            coord_y=0,
        ))

        pois = await controller.list_pois()
        assert any(p.name == "前台" for p in pois)

    @pytest.mark.asyncio
    async def test_import_pois(self, controller: Controller):
        count = await controller.import_pois([
            POICreate(name="A", coord_x=1, coord_y=1),
            POICreate(name="B", coord_x=2, coord_y=2),
        ])
        assert count == 2


class TestControllerPerception:
    """Tests for perception flows."""

    @pytest.mark.asyncio
    async def test_analyze_perception_creates_event(self, controller: Controller):
        result = await controller.analyze_perception(
            image_base64="dGVzdA==",
            question="前方有什么？",
        )

        assert result.analysis == "测试分析"
        assert result.hazard_level == "low"

        events = await controller.list_events(category="sensor")
        scene_events = [e for e in events if e.subtype == "scene_analysis"]
        assert len(scene_events) >= 1

"""Unit tests for the Memory Store."""
from __future__ import annotations

import os
import tempfile

import pytest
import pytest_asyncio

from src.models.event import (
    EventCategory,
    EventCreate,
    EventResponse,
    EventSeverity,
    EventStatus,
)
from src.models.patrol import PatrolSessionCreate, PatrolStatus
from src.models.poi import POICreate
from src.services.memory_store import MemoryStore


@pytest_asyncio.fixture
async def store():
    """Create an in-memory store for each test."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    store = MemoryStore(db_path=path)
    await store.initialize()
    yield store
    await store.close()
    try:
        os.unlink(path)
    except Exception:
        pass


class TestMemoryStoreEvents:
    """Tests for event CRUD."""

    @pytest.mark.asyncio
    async def test_create_event(self, store: MemoryStore):
        event_data = EventCreate(
            category=EventCategory.PATROL,
            subtype="checkpoint_reached",
            severity=EventSeverity.P3,
            title="到达配电室",
            content="机器人已到达巡检点",
            metadata={"poi_name": "配电室"},
            session_id="sess-1",
        )
        event = await store.create_event(event_data)

        assert event.event_id is not None
        assert event.category == EventCategory.PATROL
        assert event.severity == EventSeverity.P3
        assert event.metadata == {"poi_name": "配电室"}
        assert event.status == EventStatus.PENDING

    @pytest.mark.asyncio
    async def test_get_event(self, store: MemoryStore):
        created = await store.create_event(EventCreate(
            category=EventCategory.NAV,
            subtype="nav_started",
            severity=EventSeverity.P3,
            title="开始导航",
        ))
        found = await store.get_event(created.event_id)
        assert found is not None
        assert found.event_id == created.event_id

    @pytest.mark.asyncio
    async def test_list_events_filter(self, store: MemoryStore):
        await store.create_event(EventCreate(
            category=EventCategory.PATROL,
            subtype="cp1",
            severity=EventSeverity.P3,
            title="A",
        ))
        await store.create_event(EventCreate(
            category=EventCategory.NAV,
            subtype="nav1",
            severity=EventSeverity.P3,
            title="B",
        ))
        await store.create_event(EventCreate(
            category=EventCategory.PATROL,
            subtype="cp2",
            severity=EventSeverity.P2,
            title="C",
        ))

        all_events = await store.list_events()
        assert len(all_events) == 3

        patrol_events = await store.list_events(category="patrol")
        assert len(patrol_events) == 2

    @pytest.mark.asyncio
    async def test_acknowledge_event(self, store: MemoryStore):
        created = await store.create_event(EventCreate(
            category=EventCategory.SENSOR,
            subtype="temp_overrun",
            severity=EventSeverity.P2,
            title="温度告警",
        ))
        acknowledged = await store.acknowledge_event(
            created.event_id,
            operator="操作员A",
            note="已处理",
        )
        assert acknowledged is not None
        assert acknowledged.status == EventStatus.ACKNOWLEDGED

    @pytest.mark.asyncio
    async def test_resolve_event(self, store: MemoryStore):
        created = await store.create_event(EventCreate(
            category=EventCategory.SENSOR,
            subtype="temp_overrun",
            severity=EventSeverity.P2,
            title="温度告警",
        ))
        resolved = await store.resolve_event(created.event_id)
        assert resolved is not None
        assert resolved.status == EventStatus.RESOLVED


class TestMemoryStorePatrol:
    """Tests for patrol session CRUD."""

    @pytest.mark.asyncio
    async def test_create_patrol_session(self, store: MemoryStore):
        data = PatrolSessionCreate(
            name="园区日常巡检",
            patrol_points=["前台", "配电室", "会议室"],
        )
        session = await store.create_patrol_session(data)

        assert session.id is not None
        assert session.name == "园区日常巡检"
        assert session.patrol_points == ["前台", "配电室", "会议室"]
        assert session.status == PatrolStatus.RUNNING

    @pytest.mark.asyncio
    async def test_get_patrol_session(self, store: MemoryStore):
        created = await store.create_patrol_session(PatrolSessionCreate(
            name="测试巡检",
            patrol_points=["点A"],
        ))
        found = await store.get_patrol_session(created.id)
        assert found is not None
        assert found.id == created.id

    @pytest.mark.asyncio
    async def test_update_patrol_session_summary(self, store: MemoryStore):
        created = await store.create_patrol_session(PatrolSessionCreate(
            name="测试巡检",
            patrol_points=["点A"],
        ))
        from datetime import datetime
        now = datetime.utcnow().isoformat()

        updated = await store.update_patrol_session(
            session_id=created.id,
            status=PatrolStatus.COMPLETED,
            summary="本次巡检共发现1处异常。",
            completed_at=now,
        )
        assert updated is not None
        assert updated.status == PatrolStatus.COMPLETED
        assert updated.summary is not None


class TestMemoryStorePOI:
    """Tests for POI CRUD."""

    @pytest.mark.asyncio
    async def test_create_and_get_poi(self, store: MemoryStore):
        poi_data = POICreate(
            name="会议室A",
            description="二楼会议室",
            coord_x=3.5,
            coord_y=2.1,
            coord_z=0.0,
        )
        created = await store.create_poi(poi_data)
        assert created.id is not None
        assert created.name == "会议室A"
        assert created.coord_x == 3.5

    @pytest.mark.asyncio
    async def test_get_poi_by_name(self, store: MemoryStore):
        await store.create_poi(POICreate(name="前台", coord_x=0, coord_y=0))
        found = await store.get_poi_by_name("前台")
        assert found is not None
        assert found.name == "前台"

    @pytest.mark.asyncio
    async def test_list_pois(self, store: MemoryStore):
        await store.create_poi(POICreate(name="配电室", coord_x=1, coord_y=1))
        await store.create_poi(POICreate(name="前台", coord_x=0, coord_y=0))
        await store.create_poi(POICreate(name="会议室", coord_x=5, coord_y=3))

        all_pois = await store.list_pois()
        assert len(all_pois) == 3
        # Ordered by name ASC: 会议室 < 前台 < 配电室
        assert all_pois[0].name == "会议室"

    @pytest.mark.asyncio
    async def test_update_poi(self, store: MemoryStore):
        await store.create_poi(POICreate(name="配电室", coord_x=1, coord_y=1))
        updated = await store.update_poi("配电室", POICreate(
            name="配电室",
            description="已更新",
            coord_x=2.0,
            coord_y=2.0,
        ))
        assert updated is not None
        assert updated.description == "已更新"
        assert updated.coord_x == 2.0

    @pytest.mark.asyncio
    async def test_delete_poi(self, store: MemoryStore):
        await store.create_poi(POICreate(name="临时点", coord_x=0, coord_y=0))
        deleted = await store.delete_poi("临时点")
        assert deleted is True

        found = await store.get_poi_by_name("临时点")
        assert found is None

    @pytest.mark.asyncio
    async def test_import_pois_from_json(self, store: MemoryStore):
        pois = [
            POICreate(name="前台", coord_x=0, coord_y=0),
            POICreate(name="会议室", coord_x=5, coord_y=3),
            POICreate(name="配电室", coord_x=2, coord_y=7),
        ]
        count = await store.import_pois_from_json(pois)
        assert count == 3

        all_pois = await store.list_pois()
        assert len(all_pois) == 3

    @pytest.mark.asyncio
    async def test_import_pois_upsert(self, store: MemoryStore):
        """Importing an existing POI should update it, not fail."""
        await store.create_poi(POICreate(name="前台", coord_x=0, coord_y=0))
        count = await store.import_pois_from_json([
            POICreate(name="前台", coord_x=99, coord_y=99),
        ])
        assert count == 1
        updated = await store.get_poi_by_name("前台")
        assert updated.coord_x == 99


class TestMemoryStoreStats:
    """Tests for session statistics."""

    @pytest.mark.asyncio
    async def test_session_event_stats(self, store: MemoryStore):
        session = await store.create_patrol_session(PatrolSessionCreate(
            name="测试巡检",
            patrol_points=["A"],
        ))
        # Create events with different severities
        await store.create_event(EventCreate(
            category=EventCategory.PATROL,
            subtype="cp1",
            severity=EventSeverity.P4,
            title="低优先级",
            session_id=session.id,
        ))
        await store.create_event(EventCreate(
            category=EventCategory.SENSOR,
            subtype="temp_overrun",
            severity=EventSeverity.P1,
            title="高优先级",
            session_id=session.id,
        ))

        stats = await store.get_session_event_stats(session.id)
        assert stats["total"] == 2
        assert stats["anomalies"] == 1  # severity <= 2

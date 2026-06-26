"""Unit tests for the Event Engine."""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from src.models.event import (
    EventCategory,
    EventCreate,
    EventResponse,
    EventSeverity,
    EventStatus,
)
from src.services.event_engine import EventEngine


def make_event(
    event_id: str = "test-ev-1",
    category: EventCategory = EventCategory.PATROL,
    subtype: str = "checkpoint_reached",
    severity: EventSeverity = EventSeverity.P3,
    title: str = "Test Event",
    status: EventStatus = EventStatus.PENDING,
    session_id: str | None = "sess-1",
) -> EventResponse:
    return EventResponse(
        event_id=event_id,
        category=category,
        subtype=subtype,
        severity=severity,
        title=title,
        content=None,
        metadata=None,
        status=status,
        session_id=session_id,
        created_at="2026-05-17T10:00:00",
        updated_at=None,
    )


@pytest_asyncio.fixture
async def engine():
    eng = EventEngine(window_size=5)
    yield eng
    await eng.stop()


class TestEventEngineWindow:
    """Tests for rolling window management."""

    @pytest.mark.asyncio
    async def test_push_adds_event_to_window(self, engine: EventEngine):
        event = make_event()
        await engine.push(event)

        window = await engine.get_window()
        assert len(window) == 1
        assert window[0]["event_id"] == event.event_id

    @pytest.mark.asyncio
    async def test_eviction_when_over_capacity(self, engine: EventEngine):
        # Window capacity = 5
        for i in range(8):
            await engine.push(make_event(event_id=f"ev-{i}"))

        window = await engine.get_window()
        # Should contain last 5 events (ev-3 through ev-7)
        assert len(window) == 5
        ids = [e["event_id"] for e in window]
        assert "ev-0" not in ids
        assert "ev-7" in ids

    @pytest.mark.asyncio
    async def test_get_window_filter_by_session(self, engine: EventEngine):
        await engine.push(make_event(event_id="ev-a", session_id="sess-A"))
        await engine.push(make_event(event_id="ev-b", session_id="sess-B"))
        await engine.push(make_event(event_id="ev-c", session_id="sess-A"))

        window_a = await engine.get_window(session_id="sess-A")
        window_b = await engine.get_window(session_id="sess-B")

        assert len(window_a) == 2
        assert len(window_b) == 1

    @pytest.mark.asyncio
    async def test_get_window_filter_by_category(self, engine: EventEngine):
        await engine.push(make_event(category=EventCategory.PATROL, event_id="ev-p"))
        await engine.push(make_event(category=EventCategory.NAV, event_id="ev-n"))
        await engine.push(make_event(category=EventCategory.SENSOR, event_id="ev-s"))

        window_patrol = await engine.get_window(category="patrol")
        assert len(window_patrol) == 1

        window_nav = await engine.get_window(category="nav")
        assert len(window_nav) == 1

    @pytest.mark.asyncio
    async def test_get_by_id(self, engine: EventEngine):
        await engine.push(make_event(event_id="target-ev"))
        found = await engine.get_by_id("target-ev")
        assert found is not None
        assert found.event_id == "target-ev"

        not_found = await engine.get_by_id("nonexistent")
        assert not_found is None

    @pytest.mark.asyncio
    async def test_update_status(self, engine: EventEngine):
        await engine.push(make_event(event_id="ev-update"))

        updated = await engine.update_status("ev-update", EventStatus.ACKNOWLEDGED)
        assert updated is not None
        assert updated.status == EventStatus.ACKNOWLEDGED

        in_window = await engine.get_by_id("ev-update")
        assert in_window is not None
        assert in_window.status == EventStatus.ACKNOWLEDGED

    @pytest.mark.asyncio
    async def test_stats(self, engine: EventEngine):
        assert engine.stats["window_capacity"] == 5
        assert engine.stats["window_size"] == 0
        assert engine.stats["total_connections"] == 0

        await engine.push(make_event())
        assert engine.stats["window_size"] == 1


class TestEventEngineHooks:
    """Tests for event hooks."""

    @pytest.mark.asyncio
    async def test_register_and_trigger_hook(self, engine: EventEngine):
        triggered = []

        async def hook(e: EventResponse):
            triggered.append(e.event_id)

        engine.register_hook("checkpoint_reached", hook)
        await engine.push(make_event(subtype="checkpoint_reached", event_id="hooked"))

        assert len(triggered) == 1
        assert triggered[0] == "hooked"

    @pytest.mark.asyncio
    async def test_hook_by_category(self, engine: EventEngine):
        triggered = []

        async def hook(e: EventResponse):
            triggered.append(e.category.value)

        engine.register_hook("patrol", hook)
        await engine.push(make_event(category=EventCategory.PATROL))

        assert "patrol" in triggered


class TestEventEngineOrder:
    """Tests for event ordering (newest first in get_window)."""

    @pytest.mark.asyncio
    async def test_newest_first(self, engine: EventEngine):
        for i in range(3):
            await engine.push(make_event(event_id=f"ev-{i}"))

        window = await engine.get_window()
        # Newest should be first
        assert window[0]["event_id"] == "ev-2"
        assert window[2]["event_id"] == "ev-0"

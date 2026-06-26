"""Event Engine — Priority queue, rolling window, and WebSocket push."""
from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Optional

from fastapi import WebSocket, WebSocketDisconnect

from src.models.event import EventResponse, EventStatus


@dataclass
class WindowEntry:
    """A single event entry inside the rolling window."""
    event: EventResponse
    arrived_at: float  # monotonic timestamp


class EventEngine:
    """
    Manages the rolling event window and WebSocket push pipeline.

    Responsibilities:
    1. Maintain an in-memory rolling window (size configurable)
    2. Track WebSocket connections per session
    3. Broadcast events to subscribed sessions in real-time
    """

    def __init__(self, window_size: int = 20):
        self.window_size = window_size
        # Rolling window: ordered by arrival (oldest first), max `window_size` entries
        self._window: list[WindowEntry] = []
        # WebSocket connections keyed by session_id
        self._connections: dict[str, list[WebSocket]] = defaultdict(list)
        # Lock for thread-safe access
        self._lock = asyncio.Lock()
        # Subscribers who want ALL events (no session filter)
        self._global_connections: list[WebSocket] = []
        # Optional callbacks for specific event types
        self._hooks: dict[str, list[Callable[[EventResponse], Any]]] = defaultdict(list)
        # Connected clients info
        self._client_count = 0
        # Background heartbeat task
        self._heartbeat_task: asyncio.Task | None = None

    # -------------------------------------------------------------------------
    # Lifecycle (start / stop)
    # -------------------------------------------------------------------------

    async def start(self, heartbeat_interval: float = 0.0) -> None:
        """
        Start the event engine. Optionally launch a background heartbeat.

        Args:
            heartbeat_interval: Seconds between heartbeats. 0 or None disables it.
        """
        self._heartbeat_task = asyncio.create_task(
            self._run_heartbeat(heartbeat_interval)
        )

    async def stop(self) -> None:
        """Gracefully stop the event engine, cancelling the heartbeat task."""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

    # -------------------------------------------------------------------------
    # Window management
    # -------------------------------------------------------------------------

    async def push(self, event: EventResponse) -> None:
        """
        Add an event to the rolling window, evicting the oldest if full.
        Then broadcast to all connected WebSocket clients.
        """
        now = asyncio.get_event_loop().time()
        entry = WindowEntry(event=event, arrived_at=now)

        # Collect evicted entries inside the lock, then broadcast outside
        evicted_entries: list[WindowEntry] = []
        async with self._lock:
            self._window.append(entry)
            while len(self._window) > self.window_size:
                evicted_entries.append(self._window.pop(0))
            await self._trigger_hooks(event)

        # Broadcast evictions (no lock held)
        for evicted in evicted_entries:
            await self._broadcast_to_all({
                "type": "window_evict",
                "data": self._event_to_dict(evicted.event),
            })

        # Broadcast the new event
        await self._broadcast_to_all({
            "type": "event",
            "data": self._event_to_dict(event),
        })

    async def get_window(
        self,
        session_id: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """
        Return the current window contents, optionally filtered.
        """
        async with self._lock:
            entries = list(self._window)

        result = []
        for entry in reversed(entries):  # newest first
            ev = entry.event
            if session_id and ev.session_id != session_id:
                continue
            if category and ev.category.value != category:
                continue
            if status and ev.status.value != status:
                continue
            result.append(self._event_to_dict(ev))

        return result

    async def get_by_id(self, event_id: str) -> Optional[EventResponse]:
        async with self._lock:
            for entry in self._window:
                if entry.event.event_id == event_id:
                    return entry.event
        return None

    async def update_status(
        self, event_id: str, status: EventStatus
    ) -> Optional[EventResponse]:
        async with self._lock:
            for entry in self._window:
                if entry.event.event_id == event_id:
                    entry.event.status = status
                    updated = entry.event
                    break
            else:
                return None

        await self._broadcast_to_all({
            "type": "event_update",
            "data": self._event_to_dict(updated),
        })
        return updated

    # -------------------------------------------------------------------------
    # WebSocket connection management
    # -------------------------------------------------------------------------

    async def connect(
        self,
        websocket: WebSocket,
        session_id: Optional[str] = None,
    ) -> None:
        """Register a new WebSocket client."""
        await websocket.accept()
        async with self._lock:
            self._client_count += 1
            if session_id:
                self._connections[session_id].append(websocket)
            else:
                self._global_connections.append(websocket)

        await self._send_initial_state(websocket, session_id)

    async def disconnect(
        self,
        websocket: WebSocket,
        session_id: Optional[str] = None,
    ) -> None:
        """Remove a WebSocket client."""
        async with self._lock:
            self._client_count = max(0, self._client_count - 1)
            if session_id:
                try:
                    self._connections[session_id].remove(websocket)
                except ValueError:
                    pass
            else:
                try:
                    self._global_connections.remove(websocket)
                except ValueError:
                    pass

    async def _send_initial_state(
        self,
        websocket: WebSocket,
        session_id: Optional[str] = None,
    ) -> None:
        """Send the current window contents to a newly connected client."""
        try:
            # Send current window
            window_data = await self.get_window(session_id=session_id)
            await websocket.send_json({
                "type": "window_snapshot",
                "data": window_data,
                "window_size": len(window_data),
            })
        except Exception:
            pass

    async def _broadcast_to_all(self, message: dict[str, Any]) -> None:
        """Send a message to all connected clients."""
        dead: list[tuple[Optional[str], WebSocket]] = []

        async with self._lock:
            all_connections: list[tuple[Optional[str], WebSocket]] = []
            for sid, conns in self._connections.items():
                for ws in conns:
                    all_connections.append((sid, ws))
            all_connections.extend((None, ws) for ws in self._global_connections)

        for sid, ws in all_connections:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append((sid, ws))

        # Clean up dead connections
        for sid, ws in dead:
            await self.disconnect(ws, sid)

    # -------------------------------------------------------------------------
    # Hooks (for future extensibility, e.g. alerting)
    # -------------------------------------------------------------------------

    def register_hook(
        self,
        event_type: str,
        callback: Callable[[EventResponse], Any],
    ) -> None:
        """
        Register a callback for a specific event subtype or category.

        Example:
            engine.register_hook("temp_overrun", my_alert_handler)
        """
        self._hooks[event_type].append(callback)

    async def _trigger_hooks(self, event: EventResponse) -> None:
        for callback in self._hooks.get(event.subtype, []):
            try:
                result = callback(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass
        for callback in self._hooks.get(event.category.value, []):
            try:
                result = callback(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass

    # -------------------------------------------------------------------------
    # Heartbeat
    # -------------------------------------------------------------------------

    async def _run_heartbeat(self, interval: float = 30.0) -> None:
        """
        Internal heartbeat loop. Runs until stop() is called.
        """
        if interval <= 0:
            return
        while True:
            await asyncio.sleep(interval)
            await self._broadcast_to_all({
                "type": "heartbeat",
                "data": {
                    "server_time": datetime.utcnow().isoformat(),
                    "window_size": len(self._window),
                    "client_count": self._client_count,
                },
            })

    # -------------------------------------------------------------------------
    # Utilities
    # -------------------------------------------------------------------------

    @staticmethod
    def _event_to_dict(event: EventResponse) -> dict[str, Any]:
        return {
            "event_id": event.event_id,
            "category": event.category.value,
            "subtype": event.subtype,
            "severity": event.severity.value,
            "title": event.title,
            "content": event.content,
            "metadata": event.metadata,
            "status": event.status.value,
            "session_id": event.session_id,
            "created_at": event.created_at,
            "updated_at": event.updated_at,
        }

    @property
    def stats(self) -> dict[str, Any]:
        return {
            "window_size": len(self._window),
            "window_capacity": self.window_size,
            "total_connections": self._client_count,
            "sessions": len(self._connections),
        }

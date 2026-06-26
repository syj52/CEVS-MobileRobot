"""SQLite Memory Store — Persistent storage for events, patrols, and POIs."""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import aiosqlite

from src.models.event import EventCreate, EventResponse, EventStatus
from src.models.patrol import PatrolSessionCreate, PatrolSessionResponse, PatrolStatus
from src.models.poi import POICreate, POIResponse


class MemoryStore:
    """Async SQLite-backed memory store for all persistent data."""

    _instances: dict[str, "MemoryStore"] = {}

    def __init__(self, db_path: str = "./data/controller.db"):
        self.db_path = db_path
        self._conn: Optional[aiosqlite.Connection] = None
        self._lock = asyncio.Lock()

    @classmethod
    def get_instance(cls, db_path: str = "./data/controller.db") -> "MemoryStore":
        if db_path not in cls._instances:
            cls._instances[db_path] = cls(db_path)
        return cls._instances[db_path]

    # -------------------------------------------------------------------------
    # Lifecycle
    # -------------------------------------------------------------------------

    async def initialize(self) -> None:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.db_path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._create_tables()
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    async def _create_tables(self) -> None:
        await self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id     TEXT    UNIQUE NOT NULL,
                category     TEXT    NOT NULL,
                subtype      TEXT    NOT NULL,
                severity     INTEGER NOT NULL,
                title        TEXT    NOT NULL,
                content      TEXT,
                metadata     TEXT,
                status       TEXT    DEFAULT 'pending',
                session_id   TEXT,
                created_at   TEXT    DEFAULT (datetime('now')),
                updated_at   TEXT    DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS patrol_sessions (
                id           TEXT    PRIMARY KEY,
                name         TEXT    NOT NULL,
                status       TEXT    DEFAULT 'idle',
                patrol_points TEXT   NOT NULL,
                started_at   TEXT,
                completed_at TEXT,
                summary      TEXT,
                metadata     TEXT
            );

            CREATE TABLE IF NOT EXISTS pois (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    UNIQUE NOT NULL,
                description TEXT,
                coord_x     REAL    DEFAULT 0,
                coord_y     REAL    DEFAULT 0,
                coord_z     REAL    DEFAULT 0,
                map_id      TEXT    DEFAULT 'default',
                created_at  TEXT    DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
            CREATE INDEX IF NOT EXISTS idx_events_status   ON events(status);
            CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
            CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
        """)

    # -------------------------------------------------------------------------
    # Events
    # -------------------------------------------------------------------------

    async def create_event(self, event_data: EventCreate) -> EventResponse:
        event_id = str(uuid4())
        now = datetime.utcnow().isoformat()
        metadata_json = (
            json.dumps(event_data.metadata, ensure_ascii=False)
            if event_data.metadata
            else None
        )
        async with self._lock:
            await self._conn.execute(
                """INSERT INTO events
                   (event_id, category, subtype, severity, title, content,
                    metadata, status, session_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    event_id,
                    event_data.category.value,
                    event_data.subtype,
                    event_data.severity.value,
                    event_data.title,
                    event_data.content,
                    metadata_json,
                    EventStatus.PENDING.value,
                    event_data.session_id,
                    now,
                    now,
                ),
            )
            await self._conn.commit()

        return EventResponse(
            event_id=event_id,
            category=event_data.category,
            subtype=event_data.subtype,
            severity=event_data.severity,
            title=event_data.title,
            content=event_data.content,
            metadata=event_data.metadata,
            status=EventStatus.PENDING,
            session_id=event_data.session_id,
            created_at=now,
            updated_at=now,
        )

    async def get_event(self, event_id: str) -> Optional[EventResponse]:
        async with self._lock:
            cursor = await self._conn.execute(
                "SELECT * FROM events WHERE event_id = ?", (event_id,)
            )
            row = await cursor.fetchone()
        if not row:
            return None
        return self._row_to_event_response(row)

    async def list_events(
        self,
        category: Optional[str] = None,
        subtype: Optional[str] = None,
        status: Optional[str] = None,
        session_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[EventResponse]:
        sql = ["SELECT * FROM events WHERE 1=1"]
        params: list[Any] = []
        if category:
            sql.append("AND category = ?")
            params.append(category)
        if subtype:
            sql.append("AND subtype = ?")
            params.append(subtype)
        if status:
            sql.append("AND status = ?")
            params.append(status)
        if session_id:
            sql.append("AND session_id = ?")
            params.append(session_id)
        sql.append("ORDER BY severity ASC, created_at DESC")
        sql.append("LIMIT ? OFFSET ?")
        params.extend([limit, offset])

        async with self._lock:
            cursor = await self._conn.execute(" ".join(sql), tuple(params))
            rows = await cursor.fetchall()
        return [self._row_to_event_response(r) for r in rows]

    async def acknowledge_event(
        self, event_id: str, operator: Optional[str] = None, note: Optional[str] = None
    ) -> Optional[EventResponse]:
        now = datetime.utcnow().isoformat()
        note_str = f"[{operator or 'operator'}] {note}" if note else None
        async with self._lock:
            await self._conn.execute(
                """UPDATE events
                   SET status = ?, updated_at = ?,
                       content = IFNULL(content, '') || ? || ?
                   WHERE event_id = ?""",
                (EventStatus.ACKNOWLEDGED.value, now, "\n", note_str, event_id),
            )
            await self._conn.commit()
            cursor = await self._conn.execute(
                "SELECT * FROM events WHERE event_id = ?", (event_id,)
            )
            row = await cursor.fetchone()
        if not row:
            return None
        return self._row_to_event_response(row)

    async def resolve_event(self, event_id: str) -> Optional[EventResponse]:
        now = datetime.utcnow().isoformat()
        async with self._lock:
            await self._conn.execute(
                "UPDATE events SET status = ?, updated_at = ? WHERE event_id = ?",
                (EventStatus.RESOLVED.value, now, event_id),
            )
            await self._conn.commit()
            cursor = await self._conn.execute(
                "SELECT * FROM events WHERE event_id = ?", (event_id,)
            )
            row = await cursor.fetchone()
        if not row:
            return None
        return self._row_to_event_response(row)

    def _row_to_event_response(self, row: aiosqlite.Row) -> EventResponse:
        from src.models.event import EventCategory, EventSeverity, EventStatus

        metadata = None
        if row["metadata"]:
            try:
                metadata = json.loads(row["metadata"])
            except Exception:
                metadata = {"raw": row["metadata"]}

        return EventResponse(
            event_id=row["event_id"],
            category=EventCategory(row["category"]),
            subtype=row["subtype"],
            severity=EventSeverity(row["severity"]),
            title=row["title"],
            content=row["content"],
            metadata=metadata,
            status=EventStatus(row["status"]),
            session_id=row["session_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    # -------------------------------------------------------------------------
    # Patrol Sessions
    # -------------------------------------------------------------------------

    async def create_patrol_session(
        self, data: PatrolSessionCreate
    ) -> PatrolSessionResponse:
        session_id = str(uuid4())
        now = datetime.utcnow().isoformat()
        points_json = json.dumps(data.patrol_points, ensure_ascii=False)
        metadata_json = (
            json.dumps(data.metadata, ensure_ascii=False)
            if data.metadata
            else None
        )
        async with self._lock:
            await self._conn.execute(
                """INSERT INTO patrol_sessions
                   (id, name, status, patrol_points, started_at, metadata)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    data.name,
                    PatrolStatus.RUNNING.value,
                    points_json,
                    now,
                    metadata_json,
                ),
            )
            await self._conn.commit()

        return PatrolSessionResponse(
            id=session_id,
            name=data.name,
            status=PatrolStatus.RUNNING,
            patrol_points=data.patrol_points,
            started_at=now,
            metadata=data.metadata,
            event_count=0,
            anomaly_count=0,
        )

    async def get_patrol_session(self, session_id: str) -> Optional[PatrolSessionResponse]:
        async with self._lock:
            cursor = await self._conn.execute(
                "SELECT * FROM patrol_sessions WHERE id = ?", (session_id,)
            )
            row = await cursor.fetchone()
        if not row:
            return None
        return self._row_to_patrol_response(row)

    async def update_patrol_session(
        self,
        session_id: str,
        status: Optional[PatrolStatus] = None,
        summary: Optional[str] = None,
        completed_at: Optional[str] = None,
        metadata_update: Optional[dict[str, Any]] = None,
    ) -> Optional[PatrolSessionResponse]:
        async with self._lock:
            cursor = await self._conn.execute(
                "SELECT * FROM patrol_sessions WHERE id = ?", (session_id,)
            )
            row = await cursor.fetchone()
            if not row:
                return None

            updates: list[str] = []
            params: list[Any] = []

            if status:
                updates.append("status = ?")
                params.append(status.value)
            if summary is not None:
                updates.append("summary = ?")
                params.append(summary)
            if completed_at:
                updates.append("completed_at = ?")
                params.append(completed_at)
            if metadata_update is not None:
                existing = json.loads(row["metadata"] or "{}")
                existing.update(metadata_update)
                updates.append("metadata = ?")
                params.append(json.dumps(existing, ensure_ascii=False))

            if not updates:
                return self._row_to_patrol_response(row)

            params.append(session_id)
            await self._conn.execute(
                f"UPDATE patrol_sessions SET {', '.join(updates)} WHERE id = ?",
                tuple(params),
            )
            await self._conn.commit()

            cursor = await self._conn.execute(
                "SELECT * FROM patrol_sessions WHERE id = ?", (session_id,)
            )
            row = await cursor.fetchone()
        return self._row_to_patrol_response(row) if row else None

    def _row_to_patrol_response(self, row: aiosqlite.Row) -> PatrolSessionResponse:
        patrol_points = []
        metadata: dict[str, Any] = {}
        if row["patrol_points"]:
            try:
                patrol_points = json.loads(row["patrol_points"])
            except Exception:
                pass
        if row["metadata"]:
            try:
                metadata = json.loads(row["metadata"])
            except Exception:
                pass

        return PatrolSessionResponse(
            id=row["id"],
            name=row["name"],
            status=PatrolStatus(row["status"]),
            patrol_points=patrol_points,
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            summary=row["summary"],
            metadata=metadata,
            event_count=0,
            anomaly_count=0,
        )

    # -------------------------------------------------------------------------
    # POIs
    # -------------------------------------------------------------------------

    async def create_poi(self, data: POICreate) -> POIResponse:
        async with self._lock:
            await self._conn.execute(
                """INSERT INTO pois (name, description, coord_x, coord_y, coord_z, map_id)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    data.name,
                    data.description,
                    data.coord_x,
                    data.coord_y,
                    data.coord_z,
                    data.map_id,
                ),
            )
            await self._conn.commit()
            cursor = await self._conn.execute(
                "SELECT * FROM pois WHERE name = ?", (data.name,)
            )
            row = await cursor.fetchone()
        return self._row_to_poi_response(row) if row else None

    async def get_poi_by_name(self, name: str) -> Optional[POIResponse]:
        async with self._lock:
            cursor = await self._conn.execute(
                "SELECT * FROM pois WHERE name = ?", (name,)
            )
            row = await cursor.fetchone()
        if not row:
            return None
        return self._row_to_poi_response(row)

    async def list_pois(self, map_id: Optional[str] = None) -> list[POIResponse]:
        if map_id:
            cursor = await self._conn.execute(
                "SELECT * FROM pois WHERE map_id = ? ORDER BY name",
                (map_id,),
            )
        else:
            cursor = await self._conn.execute("SELECT * FROM pois ORDER BY name")
        rows = await cursor.fetchall()
        return [self._row_to_poi_response(r) for r in rows]

    async def update_poi(self, name: str, data: POICreate) -> Optional[POIResponse]:
        async with self._lock:
            await self._conn.execute(
                """UPDATE pois
                   SET name = ?, description = ?, coord_x = ?,
                       coord_y = ?, coord_z = ?, map_id = ?
                   WHERE name = ?""",
                (
                    data.name,
                    data.description,
                    data.coord_x,
                    data.coord_y,
                    data.coord_z,
                    data.map_id,
                    name,
                ),
            )
            await self._conn.commit()
            cursor = await self._conn.execute(
                "SELECT * FROM pois WHERE name = ?", (data.name,)
            )
            row = await cursor.fetchone()
        return self._row_to_poi_response(row) if row else None

    async def delete_poi(self, name: str) -> bool:
        async with self._lock:
            cursor = await self._conn.execute(
                "DELETE FROM pois WHERE name = ?", (name,)
            )
            await self._conn.commit()
            return cursor.rowcount > 0

    async def import_pois_from_json(self, pois: list[POICreate]) -> int:
        imported = 0
        for poi in pois:
            try:
                await self.create_poi(poi)
                imported += 1
            except Exception:
                await self.update_poi(poi.name, poi)
                imported += 1
        return imported

    def _row_to_poi_response(self, row: aiosqlite.Row) -> POIResponse:
        return POIResponse(
            id=row["id"],
            name=row["name"],
            description=row["description"],
            coord_x=row["coord_x"],
            coord_y=row["coord_y"],
            coord_z=row["coord_z"],
            map_id=row["map_id"],
            created_at=row["created_at"],
        )

    # -------------------------------------------------------------------------
    # Statistics
    # -------------------------------------------------------------------------

    async def get_session_event_stats(
        self, session_id: str
    ) -> dict[str, int]:
        async with self._lock:
            cursor = await self._conn.execute(
                "SELECT COUNT(*) as c FROM events WHERE session_id = ?",
                (session_id,),
            )
            total = await cursor.fetchone()
            cursor = await self._conn.execute(
                """SELECT COUNT(*) as c FROM events
                   WHERE session_id = ? AND severity <= 2""",
                (session_id,),
            )
            anomalies = await cursor.fetchone()
        return {
            "total": total["c"] if total else 0,
            "anomalies": anomalies["c"] if anomalies else 0,
        }

"""Patrol session data model."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class PatrolStatus(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"


class PatrolSessionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256, description="巡检任务名称")
    patrol_points: list[str] = Field(
        default_factory=list,
        description="巡检点名称列表，按顺序巡检"
    )
    metadata: Optional[dict[str, Any]] = Field(
        default_factory=dict,
        description="附加配置，如巡检间隔、速度等"
    )


class PatrolArriveRequest(BaseModel):
    session_id: str = Field(..., description="巡检会话 ID")
    poi_name: str = Field(..., description="到达的 POI 名称")
    arrived_at: Optional[str] = Field(
        None,
        description="到达时间 ISO 字符串，默认当前时间"
    )
    sensor_snapshot: Optional[dict[str, Any]] = Field(
        None,
        description="到达时的传感器读数快照"
    )
    anomaly_found: Optional[str] = Field(
        None,
        description="发现的异常简要描述"
    )


class PatrolCheckpointResponse(BaseModel):
    poi_name: str
    arrived_at: str
    event_id: str


class PatrolSessionResponse(BaseModel):
    id: str
    name: str
    status: PatrolStatus
    patrol_points: list[str]
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    summary: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    event_count: int = 0
    anomaly_count: int = 0

    model_config = {"from_attributes": True}

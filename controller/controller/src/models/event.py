"""Unified event data model.

All event types share this model. The `category` + `subtype` fields
determine the event kind; `metadata` carries arbitrary JSON payload.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class EventCategory(str, Enum):
    PATROL = "patrol"          # 巡检相关事件
    SENSOR = "sensor"          # 传感器告警事件
    NAV = "nav"               # 导航状态事件
    SAFETY = "safety"          # 安全相关事件
    SYSTEM = "system"          # 系统状态事件
    INTERACTION = "interaction" # 人机交互事件


class EventSeverity(int, Enum):
    P1 = 1   # 最高：必须立即处理
    P2 = 2   # 高
    P3 = 3   # 中
    P4 = 4   # 低


class EventStatus(str, Enum):
    PENDING = "pending"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


# ---------------------------------------------------------------------------
# Common subtype constants
# ---------------------------------------------------------------------------

PATROL_SUBTYPES = (
    "patrol_started",
    "patrol_completed",
    "patrol_paused",
    "patrol_resumed",
    "checkpoint_reached",
    "patrol_missed",       # 漏检
)

SENSOR_SUBTYPES = (
    "temp_overrun",
    "humidity_overrun",
    "smoke_detected",
    "gas_leak",
    "sensor_offline",
    "sensor_anomaly",
)

NAV_SUBTYPES = (
    "nav_started",
    "nav_arrived",
    "nav_replanned",
    "collision",
    "emergency_stop",
    "localization_lost",
    "heartbeat",
)

SAFETY_SUBTYPES = (
    "intrusion_detected",
    "zone_violation",
)

SYSTEM_SUBTYPES = (
    "network_offline",
    "network_recovered",
    "service_restart",
    "log_warning",
)

INTERACTION_SUBTYPES = (
    "manual_takeover",
    "operation_confirm",
    "command_issued",
    "chat_message",
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class EventCreate(BaseModel):
    category: EventCategory
    subtype: str = Field(..., min_length=1, max_length=64)
    severity: EventSeverity
    title: str = Field(..., min_length=1, max_length=256)
    content: Optional[str] = Field(None, description="详细描述")
    metadata: Optional[dict[str, Any]] = Field(
        default_factory=dict,
        description="JSON 附加数据"
    )
    session_id: Optional[str] = Field(None, description="关联的巡检会话 ID")


class EventResponse(BaseModel):
    event_id: str
    category: EventCategory
    subtype: str
    severity: EventSeverity
    title: str
    content: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    status: EventStatus
    session_id: Optional[str] = None
    created_at: str
    updated_at: Optional[str] = None

    model_config = {"from_attributes": True}


class EventFilter(BaseModel):
    category: Optional[EventCategory] = None
    subtype: Optional[str] = None
    severity: Optional[EventSeverity] = None
    status: Optional[EventStatus] = None
    session_id: Optional[str] = None
    limit: int = Field(50, ge=1, le=500)
    offset: int = Field(0, ge=0)


class AcknowledgeRequest(BaseModel):
    operator: Optional[str] = Field(None, description="操作员名称")
    note: Optional[str] = Field(None, description="处理备注")


# ---------------------------------------------------------------------------
# LLM parse result
# ---------------------------------------------------------------------------

class NavigationParseRequest(BaseModel):
    text: str = Field(..., description="自然语言指令，如「去会议室」")
    session_id: Optional[str] = Field(None, description="会话 ID")


class NavigationParseResponse(BaseModel):
    intent: str
    poi_name: Optional[str] = None
    target_coords: Optional[dict[str, float]] = None
    confidence: float
    event_id: Optional[str] = None
    raw_llm: Optional[dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Perception
# ---------------------------------------------------------------------------

class PerceptionAnalyzeRequest(BaseModel):
    image_base64: str = Field(..., description="图片 Base64 编码")
    question: str = Field(..., description="关于图片的问题")
    session_id: Optional[str] = None


class PerceptionAnalyzeResponse(BaseModel):
    analysis: str
    hazard_level: str = Field(description="none / low / medium / high / critical")
    recommended_action: str
    raw_llm: Optional[dict[str, Any]] = None

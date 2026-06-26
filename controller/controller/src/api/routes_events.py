"""Event routes — Query, create, and acknowledge events."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query

from src.controller import Controller
from src.models.event import (
    AcknowledgeRequest,
    EventCategory,
    EventCreate,
    EventFilter,
    EventResponse,
    EventSeverity,
    EventStatus,
)

router = APIRouter(prefix="/api/events", tags=["事件"])


def get_controller() -> Controller:
    from src.main import get_controller
    return get_controller()


@router.get("", response_model=list[EventResponse])
async def list_events(
    category: Optional[EventCategory] = Query(None, description="按类别过滤"),
    subtype: Optional[str] = Query(None, description="按子类型过滤"),
    status: Optional[EventStatus] = Query(None, description="按状态过滤"),
    session_id: Optional[str] = Query(None, description="按巡检会话过滤"),
    limit: int = Query(50, ge=1, le=500, description="返回条数"),
    offset: int = Query(0, ge=0, description="分页偏移"),
    controller: Controller = Depends(get_controller),
) -> list[EventResponse]:
    """
    查询事件列表，支持多维度过滤。
    默认按 severity 升序（严重事件优先）、时间倒序排列。
    """
    return await controller.list_events(
        category=category.value if category else None,
        status=status.value if status else None,
        session_id=session_id,
        limit=limit,
        offset=offset,
    )


@router.post("", response_model=EventResponse)
async def create_event(
    body: EventCreate,
    controller: Controller = Depends(get_controller),
) -> EventResponse:
    """
    上报一个事件（由前端或小车侧调用）。

    支持任何 category + subtype 组合，metadata 中可携带传感器读数、
    坐标、图像 URL 等附加信息。
    """
    return await controller.create_event(body)


@router.get("/window", response_model=list[dict])
async def get_window(
    session_id: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    controller: Controller = Depends(get_controller),
) -> list[dict]:
    """
    获取当前滚动窗口内容（实时内存状态）。
    """
    return await controller.get_window(
        session_id=session_id,
        category=category,
        status=status,
    )


@router.get("/stats")
async def get_event_stats(
    controller: Controller = Depends(get_controller),
) -> dict:
    """
    获取事件引擎统计信息（窗口容量、连接数等）。
    """
    return controller.events.stats


@router.get("/{event_id}", response_model=EventResponse)
async def get_event(
    event_id: str,
    controller: Controller = Depends(get_controller),
) -> EventResponse:
    """
    根据 event_id 查询单个事件。
    """
    event = await controller.get_event(event_id)
    if not event:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"事件 {event_id} 不存在")
    return event


@router.post("/{event_id}/acknowledge", response_model=EventResponse)
async def acknowledge_event(
    event_id: str,
    body: Optional[AcknowledgeRequest] = None,
    controller: Controller = Depends(get_controller),
) -> EventResponse:
    """
    确认（acknowledge）一个事件。

    操作员处理完事件后调用此接口，事件状态从 pending → acknowledged。
    可选传入操作员名称和处理备注。
    """
    event = await controller.acknowledge_event(
        event_id=event_id,
        operator=body.operator if body else None,
        note=body.note if body else None,
    )
    if not event:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"事件 {event_id} 不存在")
    return event


@router.post("/{event_id}/resolve", response_model=EventResponse)
async def resolve_event(
    event_id: str,
    controller: Controller = Depends(get_controller),
) -> EventResponse:
    """
    将事件标记为已解决（resolved）。
    """
    event = await controller.resolve_event(event_id)
    if not event:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail=f"事件 {event_id} 不存在")
    return event

"""Patrol routes — Start, manage, and complete patrol sessions."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from src.controller import Controller
from src.models.patrol import (
    PatrolArriveRequest,
    PatrolCheckpointResponse,
    PatrolSessionCreate,
    PatrolSessionResponse,
    PatrolStatus,
)

router = APIRouter(prefix="/api/patrol", tags=["巡检"])


def get_controller() -> Controller:
    from src.main import get_controller
    return get_controller()


@router.post("/start", response_model=PatrolSessionResponse)
async def start_patrol(
    body: PatrolSessionCreate,
    controller: Controller = Depends(get_controller),
) -> PatrolSessionResponse:
    """
    启动一个新的巡检会话。

    创建 session，生成 patrol_started 事件并推送，
    返回 session_id 供后续操作使用。
    """
    return await controller.start_patrol(body)


@router.post("/arrive", response_model=PatrolCheckpointResponse)
async def patrol_arrive(
    body: PatrolArriveRequest,
    controller: Controller = Depends(get_controller),
) -> PatrolCheckpointResponse:
    """
    上报机器人到达某个巡检点。

    自动判断是否有异常，生成对应优先级的事件。
    如传入 sensor_snapshot（传感器读数快照），会一并记录到事件 metadata 中。
    """
    return await controller.patrol_arrive(body)


@router.post("/complete", response_model=PatrolSessionResponse)
async def complete_patrol(
    session_id: str,
    controller: Controller = Depends(get_controller),
) -> PatrolSessionResponse:
    """
    结束巡检会话，触发 LLM 生成巡检报告摘要。

    流程：
      1. 收集该 session 所有事件
      2. 调用 LLM 生成中文总结
      3. 更新 session 状态为 completed
      4. 生成 patrol_completed 事件
    """
    try:
        return await controller.complete_patrol(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{session_id}", response_model=PatrolSessionResponse)
async def get_patrol(
    session_id: str,
    controller: Controller = Depends(get_controller),
) -> PatrolSessionResponse:
    """
    查询巡检会话详情，包括已完成点位、异常数量和报告摘要。
    """
    session = await controller.get_patrol(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"巡检会话 {session_id} 不存在")
    return session


@router.post("/{session_id}/pause")
async def pause_patrol(
    session_id: str,
    controller: Controller = Depends(get_controller),
) -> dict:
    """
    暂停巡检会话。
    """
    session = await controller.get_patrol(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"巡检会话 {session_id} 不存在")
    await controller.memory.update_patrol_session(
        session_id,
        status=PatrolStatus.PAUSED,
    )
    return {"ok": True, "status": "paused"}


@router.post("/{session_id}/resume")
async def resume_patrol(
    session_id: str,
    controller: Controller = Depends(get_controller),
) -> dict:
    """
    恢复已暂停的巡检会话。
    """
    await controller.memory.update_patrol_session(
        session_id,
        status=PatrolStatus.RUNNING,
    )
    return {"ok": True, "status": "running"}

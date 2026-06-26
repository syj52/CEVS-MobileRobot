"""Navigation routes — Semantic instruction parsing."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query

from src.controller import Controller
from src.models.event import NavigationParseRequest, NavigationParseResponse

router = APIRouter(prefix="/api/navigation", tags=["导航"])


def get_controller() -> Controller:
    from src.main import get_controller
    return get_controller()


@router.post("/parse", response_model=NavigationParseResponse)
async def parse_navigation(
    body: NavigationParseRequest,
    controller: Controller = Depends(get_controller),
) -> NavigationParseResponse:
    """
    将自然语言指令解析为孪生场景坐标。

    示例：
      POST /api/navigation/parse
      Body: {"text": "去会议室"}

    流程：
      1. LLM 语义解析 → intent + poi_name
      2. MemoryStore 查询 POI 坐标
      3. 生成 nav_started 事件并推送
      4. 返回 {target_coords, event_id}
    """
    return await controller.parse_navigation(
        text=body.text,
        session_id=body.session_id,
    )


@router.get("/current")
async def get_navigation_status(
    controller: Controller = Depends(get_controller),
) -> dict:
    """
    查询当前导航状态，包括机器人位置和目标点。
    """
    return await controller.get_navigation_status()


@router.post("/position")
async def update_robot_position(
    x: float,
    y: float,
    z: float = 0.0,
    controller: Controller = Depends(get_controller),
) -> dict:
    """
    上报机器人当前位置（由前端或小车侧调用）。
    """
    await controller.update_robot_position(x=x, y=y, z=z)
    return {"ok": True, "position": {"x": x, "y": y, "z": z}}

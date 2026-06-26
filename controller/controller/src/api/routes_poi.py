"""POI routes — Manage Points of Interest."""
from __future__ import annotations

import json
from io import StringIO
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile

from src.controller import Controller
from src.models.poi import POICreate, POIResponse

router = APIRouter(prefix="/api/poi", tags=["POI"])


def get_controller() -> Controller:
    from src.main import get_controller
    return get_controller()


@router.get("", response_model=list[POIResponse])
async def list_pois(
    map_id: Optional[str] = None,
    controller: Controller = Depends(get_controller),
) -> list[POIResponse]:
    """
    列出所有 POI，支持按 map_id 过滤。
    """
    return await controller.list_pois(map_id=map_id)


@router.post("", response_model=POIResponse)
async def create_poi(
    body: POICreate,
    controller: Controller = Depends(get_controller),
) -> POIResponse:
    """
    新增一个 POI。
    """
    poi = await controller.create_poi(body)
    if not poi:
        raise HTTPException(status_code=409, detail=f"POI「{body.name}」已存在")
    return poi


@router.post("/import")
async def import_pois_json(
    file: UploadFile,
    controller: Controller = Depends(get_controller),
) -> dict:
    """
    从 JSON 文件批量导入 POI。

    文件格式示例 (pois.json):
    ```json
    [
      {"name": "前台", "coord_x": 1.0, "coord_y": 2.0, "description": "大厅入口"},
      {"name": "会议室", "coord_x": 5.0, "coord_y": 3.0}
    ]
    ```
    """
    try:
        contents = await file.read()
        pois_data = json.loads(contents)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"JSON 解析失败: {e}")

    if not isinstance(pois_data, list):
        raise HTTPException(status_code=400, detail="文件根元素必须是 POI 列表")

    pois = [POICreate(**p) for p in pois_data]
    count = await controller.import_pois(pois)
    return {"ok": True, "imported": count, "total": len(pois)}


@router.put("/{name}", response_model=POIResponse)
async def update_poi(
    name: str,
    body: POICreate,
    controller: Controller = Depends(get_controller),
) -> POIResponse:
    """
    更新 POI 信息。
    如果 name 发生变化，需要先删除旧 POI 再创建新 POI。
    这里采用 upsert 语义：新 name 覆盖旧 name。
    """
    poi = await controller.update_poi(name, body)
    if not poi:
        raise HTTPException(status_code=404, detail=f"POI「{name}」不存在")
    return poi


@router.delete("/{name}")
async def delete_poi(
    name: str,
    controller: Controller = Depends(get_controller),
) -> dict:
    """
    删除指定 POI。
    """
    deleted = await controller.delete_poi(name)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"POI「{name}」不存在")
    return {"ok": True, "deleted": name}

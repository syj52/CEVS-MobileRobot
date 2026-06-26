"""POI (Point of Interest) data model."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class POICoord(BaseModel):
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0


class POICreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128, description="POI 名称，如「会议室」「前台」")
    description: Optional[str] = Field(None, description="POI 描述")
    coord_x: float = Field(0.0, description="孪生场景 X 坐标")
    coord_y: float = Field(0.0, description="孪生场景 Y 坐标")
    coord_z: float = Field(0.0, description="孪生场景 Z 坐标（高度）")
    map_id: str = Field("default", description="所属地图标识")


class POIResponse(POICreate):
    id: int
    created_at: Optional[str] = None

    model_config = {"from_attributes": True}

    @property
    def coord(self) -> POICoord:
        return POICoord(x=self.coord_x, y=self.coord_y, z=self.coord_z)

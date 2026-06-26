"""LingBot 小车端 <-> 边缘端 MQTT 协议常量与编解码。

所有上行/下行消息统一从这里取 topic 和 schema，避免 publisher/subscriber
两侧手写字符串导致漂移。

消息体一律 JSON（UTF-8），二进制大数据（图像/点云）走 WebSocket，不在此协议内。
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any


# ---------- Topics ----------
# 上行：小车 -> 边缘
TOPIC_ODOM = "lingbot/car/odometry"   # 里程计 + IMU 融合姿态
TOPIC_STATUS = "lingbot/car/status"   # 电量、温度、运行模式等

# 下行：边缘 -> 小车
TOPIC_CMD_VEL = "lingbot/car/cmd_vel"  # 速度指令
TOPIC_PATH = "lingbot/car/path"        # 路径点序列


@dataclass
class OdometryMsg:
    """里程计 + IMU 的一帧融合姿态。

    坐标系: 小车自身的 odom 坐标系，右手系，theta 为绕 Z 轴航向角（弧度）。
    """

    ts: float                 # 发布时间 (epoch seconds, 双精度浮点)
    seq: int                  # 单调递增序号，便于丢包检测
    # 2D 平面姿态
    x: float
    y: float
    theta: float
    # 速度
    vx: float = 0.0           # 前向线速度 m/s
    vth: float = 0.0          # 角速度 rad/s
    # IMU 2D 平面相关分量（可选，缺省 0）
    ax: float = 0.0           # 平面前向加速度 m/s^2
    ay: float = 0.0           # 平面侧向加速度 m/s^2
    gz: float = 0.0           # 偏航角速度 rad/s（IMU 原始，与 vth 可能不同源，留作 EKF 融合用）
    frame_id: str = "odom"

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def from_json(cls, payload: bytes | str) -> "OdometryMsg":
        d = json.loads(payload)
        return cls(**d)


@dataclass
class StatusMsg:
    ts: float
    battery_v: float = 0.0
    battery_pct: float = 0.0
    mode: str = "idle"        # idle / manual / auto / estop
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def from_json(cls, payload: bytes | str) -> "StatusMsg":
        return cls(**json.loads(payload))


@dataclass
class CmdVelMsg:
    """边缘端下发的速度指令。小车若 200ms 内未收到下一帧，应自动停车。"""

    ts: float
    vx: float                 # m/s, 正为前进
    vth: float                # rad/s, 正为逆时针
    ttl_ms: int = 200         # 指令有效期，超时即视为掉线

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def from_json(cls, payload: bytes | str) -> "CmdVelMsg":
        return cls(**json.loads(payload))


def now_ts() -> float:
    return time.time()

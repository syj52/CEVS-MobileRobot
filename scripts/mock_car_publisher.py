"""模拟 ESP32-P4 小车端，按设定频率向 MQTT broker 发布 IMU/里程计数据。

用途：在真车到位前，先把 LingBot-MAP 推理端、Three.js 前端的数据通路调通。

用法：
    # 启动本地 broker（先装 mosquitto: sudo apt install mosquitto mosquitto-clients）
    mosquitto -v

    # 跑假车（默认走半径 1m 的圆，10Hz）
    python mock_car_publisher.py
    python mock_car_publisher.py --host 192.168.1.5 --rate 20 --shape figure8
"""

from __future__ import annotations

import argparse
import math
import signal
import sys
import time

import paho.mqtt.client as mqtt

from mqtt_protocol import TOPIC_ODOM, TOPIC_STATUS, OdometryMsg, StatusMsg, now_ts


def make_client(host: str, port: int, client_id: str) -> mqtt.Client:
    # paho-mqtt 2.x 引入了 CallbackAPIVersion，1.x 没有这个枚举，兼容两版本。
    try:
        from paho.mqtt.client import CallbackAPIVersion
        client = mqtt.Client(CallbackAPIVersion.VERSION2, client_id=client_id)
    except ImportError:
        client = mqtt.Client(client_id=client_id)

    def on_connect(c, userdata, flags, reason_code, properties=None):
        print(f"[mock_car] connected to {host}:{port}, rc={reason_code}")

    def on_disconnect(c, userdata, *args):
        print("[mock_car] disconnected")

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.connect(host, port, keepalive=30)
    client.loop_start()
    return client


def trajectory(shape: str, t: float, radius: float, speed: float) -> tuple[float, float, float, float, float]:
    """根据时间 t 生成 (x, y, theta, vx, vth)。"""
    w = speed / radius  # 角速度
    if shape == "circle":
        x = radius * math.cos(w * t)
        y = radius * math.sin(w * t)
        theta = (w * t + math.pi / 2) % (2 * math.pi)
        return x, y, theta, speed, w
    if shape == "figure8":
        x = radius * math.sin(w * t)
        y = radius * math.sin(w * t) * math.cos(w * t)
        theta = math.atan2(math.cos(2 * w * t), math.cos(w * t))
        return x, y, theta, speed, w
    if shape == "line":
        x = speed * t
        return x, 0.0, 0.0, speed, 0.0
    raise ValueError(f"unknown shape: {shape}")


def main() -> int:
    ap = argparse.ArgumentParser(description="模拟小车 MQTT 发布")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--rate", type=float, default=10.0, help="里程计发布频率 Hz")
    ap.add_argument("--status-rate", type=float, default=1.0, help="状态上报频率 Hz")
    ap.add_argument("--shape", choices=["circle", "figure8", "line"], default="circle")
    ap.add_argument("--radius", type=float, default=1.0)
    ap.add_argument("--speed", type=float, default=0.3, help="线速度 m/s")
    ap.add_argument("--client-id", default="lingbot-mock-car")
    args = ap.parse_args()

    client = make_client(args.host, args.port, args.client_id)

    stop = False

    def handle_sigint(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, handle_sigint)
    signal.signal(signal.SIGTERM, handle_sigint)

    odom_period = 1.0 / args.rate
    status_period = 1.0 / args.status_rate
    t0 = time.monotonic()
    seq = 0
    next_status = t0

    print(
        f"[mock_car] publishing {args.shape} r={args.radius} v={args.speed} "
        f"odom@{args.rate}Hz status@{args.status_rate}Hz -> {args.host}:{args.port}"
    )

    while not stop:
        loop_start = time.monotonic()
        t = loop_start - t0

        x, y, theta, vx, vth = trajectory(args.shape, t, args.radius, args.speed)
        # IMU 近似：平面向心加速度 + 偏航角速度（gz 与 vth 同源，真车上来自不同传感器）
        ay = vx * vth
        msg = OdometryMsg(
            ts=now_ts(), seq=seq, x=x, y=y, theta=theta, vx=vx, vth=vth,
            ax=0.0, ay=ay, gz=vth,
        )
        client.publish(TOPIC_ODOM, msg.to_json(), qos=0)
        seq += 1

        if loop_start >= next_status:
            status = StatusMsg(
                ts=now_ts(),
                battery_v=12.4 - 0.001 * t,
                battery_pct=max(0.0, 100.0 - 0.05 * t),
                mode="auto",
            )
            client.publish(TOPIC_STATUS, status.to_json(), qos=0, retain=True)
            next_status = loop_start + status_period

        # 稳定节拍
        sleep_for = odom_period - (time.monotonic() - loop_start)
        if sleep_for > 0:
            time.sleep(sleep_for)

    print(f"[mock_car] stopping, sent {seq} odom messages")
    client.loop_stop()
    client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())

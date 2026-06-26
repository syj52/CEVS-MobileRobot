"""边缘端 MQTT 订阅器：接收小车上报的里程计/IMU/状态，缓存最新值并打印统计。

两种用法：

1. 命令行直接跑，做协议联调验证：
       python odometry_bridge.py --host localhost --stats
   会持续打印接收速率、最近一帧位姿、丢包数。

2. 作为库导入到 demo_live_ws.py，给 LingBot-MAP 提供位姿先验：
       from odometry_bridge import OdometryBridge
       bridge = OdometryBridge(host="localhost")
       bridge.start()
       pose = bridge.get_latest()       # OdometryMsg | None
"""

from __future__ import annotations

import argparse
import csv
import signal
import sys
import threading
import time
from collections import deque
from typing import Callable

import paho.mqtt.client as mqtt

from mqtt_protocol import (
    TOPIC_CMD_VEL,
    TOPIC_ODOM,
    TOPIC_STATUS,
    CmdVelMsg,
    OdometryMsg,
    StatusMsg,
    now_ts,
)


class OdometryBridge:
    """线程安全的 MQTT 订阅器。get_latest / get_status 可在任意线程调用。"""

    def __init__(self, host: str = "localhost", port: int = 1883,
                 client_id: str = "lingbot-edge-bridge"):
        self.host = host
        self.port = port
        self.client_id = client_id

        self._lock = threading.Lock()
        self._latest_odom: OdometryMsg | None = None
        self._latest_status: StatusMsg | None = None

        # 用于统计 (recv_ts, seq)
        self._recv_log: deque[tuple[float, int]] = deque(maxlen=200)
        self._dropped = 0
        self._last_seq: int | None = None

        self._on_odom_cbs: list[Callable[[OdometryMsg], None]] = []

        self._client = self._make_client()

    def _make_client(self) -> mqtt.Client:
        try:
            from paho.mqtt.client import CallbackAPIVersion
            c = mqtt.Client(CallbackAPIVersion.VERSION2, client_id=self.client_id)
        except ImportError:
            c = mqtt.Client(client_id=self.client_id)
        c.on_connect = self._on_connect
        c.on_message = self._on_message
        c.on_disconnect = lambda *a: print("[bridge] disconnected")
        return c

    # ---------- public API ----------
    def start(self) -> None:
        self._client.connect(self.host, self.port, keepalive=30)
        self._client.loop_start()

    def stop(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()

    def get_latest(self) -> OdometryMsg | None:
        with self._lock:
            return self._latest_odom

    def get_status(self) -> StatusMsg | None:
        with self._lock:
            return self._latest_status

    def add_odom_callback(self, cb: Callable[[OdometryMsg], None]) -> None:
        self._on_odom_cbs.append(cb)

    def publish_cmd_vel(self, vx: float, vth: float, ttl_ms: int = 200) -> None:
        msg = CmdVelMsg(ts=now_ts(), vx=vx, vth=vth, ttl_ms=ttl_ms)
        self._client.publish(TOPIC_CMD_VEL, msg.to_json(), qos=0)

    def stats(self) -> dict:
        with self._lock:
            log = list(self._recv_log)
            dropped = self._dropped
            last = self._latest_odom
        if len(log) < 2:
            return {"rate_hz": 0.0, "dropped": dropped, "count": len(log), "last": last}
        dt = log[-1][0] - log[0][0]
        rate = (len(log) - 1) / dt if dt > 0 else 0.0
        return {"rate_hz": rate, "dropped": dropped, "count": len(log), "last": last}

    # ---------- MQTT callbacks ----------
    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        print(f"[bridge] connected to {self.host}:{self.port}, rc={reason_code}")
        client.subscribe([(TOPIC_ODOM, 0), (TOPIC_STATUS, 0), (TOPIC_CMD_VEL, 0)])

    def _on_message(self, client, userdata, msg):
        try:
            if msg.topic == TOPIC_ODOM:
                self._handle_odom(msg.payload)
            elif msg.topic == TOPIC_STATUS:
                self._handle_status(msg.payload)
            # TOPIC_CMD_VEL 订阅仅用于自测回环，正常不处理
        except Exception as e:
            print(f"[bridge] bad message on {msg.topic}: {e}")

    def _handle_odom(self, payload: bytes) -> None:
        m = OdometryMsg.from_json(payload)
        recv_ts = time.monotonic()
        with self._lock:
            if self._last_seq is not None:
                expected = self._last_seq + 1
                if m.seq > expected:
                    self._dropped += m.seq - expected
            self._last_seq = m.seq
            self._latest_odom = m
            self._recv_log.append((recv_ts, m.seq))
        for cb in self._on_odom_cbs:
            try:
                cb(m)
            except Exception as e:
                print(f"[bridge] odom callback error: {e}")

    def _handle_status(self, payload: bytes) -> None:
        s = StatusMsg.from_json(payload)
        with self._lock:
            self._latest_status = s


def _run_cli() -> int:
    ap = argparse.ArgumentParser(description="LingBot 边缘端 MQTT 订阅验证")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--stats", action="store_true", help="每秒打印一次接收统计")
    ap.add_argument("--log-csv", help="把每帧里程计落 CSV，方便离线对齐")
    args = ap.parse_args()

    bridge = OdometryBridge(host=args.host, port=args.port)

    csv_writer = None
    csv_file = None
    if args.log_csv:
        csv_file = open(args.log_csv, "w", newline="")
        csv_writer = csv.writer(csv_file)
        csv_writer.writerow(["ts", "seq", "x", "y", "theta", "vx", "vth"])

        def log_row(m: OdometryMsg) -> None:
            csv_writer.writerow([m.ts, m.seq, m.x, m.y, m.theta, m.vx, m.vth])
            csv_file.flush()

        bridge.add_odom_callback(log_row)

    bridge.start()

    stop = False

    def handle_sigint(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, handle_sigint)
    signal.signal(signal.SIGTERM, handle_sigint)

    try:
        while not stop:
            time.sleep(1.0)
            if args.stats:
                s = bridge.stats()
                last = s["last"]
                if last is None:
                    print(f"[stats] waiting...  dropped={s['dropped']}")
                else:
                    print(
                        f"[stats] rate={s['rate_hz']:5.2f}Hz  dropped={s['dropped']:3d}  "
                        f"x={last.x:+.2f} y={last.y:+.2f} theta={last.theta:+.2f} "
                        f"vx={last.vx:+.2f} vth={last.vth:+.2f}"
                    )
    finally:
        bridge.stop()
        if csv_file is not None:
            csv_file.close()
    return 0


if __name__ == "__main__":
    sys.exit(_run_cli())

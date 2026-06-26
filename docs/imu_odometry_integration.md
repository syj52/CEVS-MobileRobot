# IMU / 里程计数据接入指南

## 数据流架构

方案设计中 IMU/里程计的完整链路：

```
┌──────────┐   UART/WiFi    ┌──────────────┐   rosbridge WebSocket   ┌─────────┐
│ ESP32-P4 │ ──────────────►│  边缘计算机   │ ──────────────────────► │ 前端    │
│ (IMU+odo)│                │ (ROS 2)       │   ws://localhost:9090   │ (Three.js)
└──────────┘                │              │◄──────────────────────┘ │
        │                   │  rosbridge   │                         └─────────┘
        │ MQTT               │  server      │
        └──────────────────►│              │
          (状态上报)         │              │
                             │              │   rosbridge client       ┌─────────┐
                             │              │ ──────────────────────► │ Python  │
                             │              │   (同一 ws://:9090)     │ (demo)  │
                             └──────────────┘                         └─────────┘
```

## 前提条件

小车端的 ROS 2 环境已打通，能看到 `/odom` 和 `/imu/data` 话题。rosbridge 已启动：

```bash
ros2 run rosbridge_server rosbridge_websocket
```

如果还没有 ROS 2 环境，另外两个方案见末尾。

## Python 端接收 IMU/里程计

在 `demo_live.py` 或 `demo_live_ws.py` 中增加一个 WebSocket 客户端，连到同一个 rosbridge 服务器。

### 安装依赖

```bash
pip install roslibpy
```

### 代码示例

```python
import roslibpy

class OdometrySubscriber:
    """订阅 ROS 2 /odom 和 /imu 数据，供 LingBot-MAP 用作位姿先验。"""

    def __init__(self, host="localhost", port=9090):
        self.client = roslibpy.Ros(host=host, port=port)
        self.latest_pose = None  # (x, y, z, qx, qy, qz, qw)
        self.client.run()

        # 订阅里程计
        odom_topic = roslibpy.Topic(self.client, "/odom", "nav_msgs/Odometry")
        odom_topic.subscribe(self._on_odom)

        # 订阅 IMU
        imu_topic = roslibpy.Topic(self.client, "/imu/data", "sensor_msgs/Imu")
        imu_topic.subscribe(self._on_imu)

        print(f"[Odometry] 已连接 ws://{host}:{port}")

    def _on_odom(self, msg):
        p = msg["pose"]["pose"]["position"]
        o = msg["pose"]["pose"]["orientation"]
        self.latest_pose = (p["x"], p["y"], p["z"],
                            o["x"], o["y"], o["z"], o["w"])

    def _on_imu(self, msg):
        # IMU 数据可用于航向校正、加速度辅助等
        self.latest_imu = msg

    def get_pose(self):
        """获取最新位姿，用于推理时传入相机位姿先验。"""
        return self.latest_pose

    def stop(self):
        self.client.terminate()
```

### 集成到 demo_live.py

```python
def main():
    # ... 原有参数解析、模型加载 ...

    # 启动里程计订阅
    odom = OdometrySubscriber()

    # 在每帧推理前，将里程计位姿传递给模型
    # 注意: GCTStream 目前不直接接受外部位姿输入，
    # 但可以作为 camera head 的 warm-start 或与 pose_enc 做融合
    for i in pbar:
        pose = odom.get_pose()
        if pose is not None:
            # 将里程计位姿转换为 pose_encoding 格式
            # 与模型的 camera_head 输出做加权平均或 Kalman 融合
            pass

        frame_img = images[i:i+1].to(_model_device, non_blocking=True)
        frame_out = model.forward(frame_img, ...)

    odom.stop()
```

## 模型内的融合方式

目前 GCTStream 的 camera head 自己从图像估计位姿（不经外部输入）。如果要融入 IMU/里程计，有两条路：

### 方式 A：后处理加权融合（最简单）

推理保持原样，用模型自己的 pose_enc。之后将模型输出的位姿与里程计做 EKF/smoothing：

```python
# 推理完成后，将模型位姿与里程计融合
model_poses = predictions["pose_enc"]   # [S, 9]
odom_poses = load_odom_data()           # 对齐时间戳

# 用简单的互补滤波或 Kalman 融合
fused_poses = complementary_filter(model_poses, odom_poses)
```

在 demo.py 的 `postprocess` 之后，把融合后的位姿替换进去即可。

### 方式 B：修改 camera head 输入（进阶）

修改 `gct_base.py` 的 `_build_camera_head`，使其接受外部位姿作为 cross-attention 的 query 初始值。这样模型在估计每帧位姿时就有里程计先验可用。

## 不依赖 ROS 2 的替代方案

如果边缘计算机没装 ROS 2，可以直接从 ESP32 通过以下方式接收：

### 方案 1：MQTT (推荐)

ESP32 通过 MQTT 发布 IMU/里程计数据，Python 端直接订阅：

```python
import paho.mqtt.client as mqtt

def on_message(client, userdata, msg):
    data = json.loads(msg.payload)
    # data = {"x":..., "y":..., "theta":..., "imu_accel":..., "imu_gyro":...}
    print(f"收到里程计: x={data['x']:.2f}, y={data['y']:.2f}")

client = mqtt.Client()
client.connect("localhost", 1883)  # MQTT Broker 地址
client.subscribe("car/odometry")
client.on_message = on_message
client.loop_start()
```

### 方案 2：UDP 直连

ESP32 直接通过 UDP 广播 IMU/里程计数据包到计算机 IP：

```python
import socket
import struct

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", 12345))

while True:
    data, addr = sock.recvfrom(1024)
    # 按你定义的二进制协议解析
    x, y, theta = struct.unpack("<fff", data[:12])
    print(f"UDP odom: x={x:.2f}, y={y:.2f}, theta={theta:.2f}")
```

## 建议

1. **如果 ROS 2 已就绪** → 用 `roslibpy` 方案，与前端共享同一路数据，一致性最好
2. **如果只想验证** → 先用 UDP 直连快速验证数据通路
3. **IMU 用于位姿先验 → 对 LingBot-MAP 的改进**：当 VIO 初始位姿足够准，`--num_scale_frames` 可以不需要（camera head 有好的起始值），甚至 `--camera_num_iterations` 可以降为 0

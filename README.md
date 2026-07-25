# CEVS-MobileRobot — Edge ESP Server

> Cloud-Edge Vision System (CEVS) for mobile robots: real-time visual perception, ESP32-P4 edge control, and web-based digital twin visualization.

---

## 项目概述

本模块是 CEVS 系统的 **边缘端 (Edge)**，基于 ESP32-P4 芯片实现实时视觉感知与车端控制。

- **摄像头采集** — SC2336 (2MP, MIPI CSI-2, RAW10) 图像捕获
- **ISP 管线** — RAW10 → YUV420 → JPEG 硬件编码
- **WiFi 图传** — HTTP MJPEG 实时视频流 + TCP 客户端上报
- **车端控制** — 通过 UART 与 STM32 底盘通信
- **PC 中控服务** — TypeScript 中控服务器 (TCP 接收 + HTTP 前端)

---

## 硬件信息

| 组件 | 型号 |
|------|------|
| 主控 | ESP32-P4-Function-EV-Board v1.5.2 |
| 图像传感器 | SC2336 (2 MP, MIPI CSI-2, 2-lane) |
| 底盘控制器 | STM32F103 (UART 115200) |
| WiFi | ESP32-P4 内置 |

## 系统架构

```
SC2336 (MIPI CSI-2)
    │
    ▼
MIPI CSI Host → ISP (RAW10→YUV420) → JPEG Encoder
                                           │
                    ┌──────────────────────┤
                    │                      │
                    ▼                      ▼
            HTTP MJPEG Stream          UART → STM32
            (PC browser)               (car control)
                    │
                    ▼
            TCP Client → PC Center Server
                          (TypeScript)
```

---

## 快速开始

### 1. 固件编译与烧录

```bash
# 设置 ESP-IDF 环境 (v5.4+)
. $HOME/esp/esp-idf/export.sh

cd /c/ESP/esp32_cam

# 配置 WiFi
idf.py menuconfig
# → ESP32-P4 Camera Streaming → SSID & Password

# 编译 & 烧录
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

### 2. 启动中控服务

```bash
cd center
npm install
npm run dev
```

### 3. 查看视频流

| 模式 | 操作 |
|------|------|
| **Soft-AP** | 连接 WiFi `ESP32-P4-Camera` (密码 `12345678`)，访问 `http://192.168.4.1/` |
| **STA** | 设置 `CONFIG_ESP_WIFI_SSID` 连接路由器，查看串口输出的 IP 地址 |

中控服务: `http://localhost:8000`

---

## 目录结构

```
esp32_cam/
├── CMakeLists.txt           # ESP-IDF 项目文件
├── partitions.csv           # 分区表
├── sdkconfig                # 构建配置
├── main/
│   ├── main.c               # 入口：WiFi → Camera → Streamer → UART
│   ├── camera_driver.c/h    # MIPI CSI + ISP + SC2336 驱动
│   ├── streamer.c/h         # HTTP MJPEG 流媒体服务器
│   ├── uart_stm32.c/h       # UART 与 STM32 通信
│   └── Kconfig.projbuild    # 项目配置项
├── components/
│   └── sensor_init/         # 传感器初始化
├── center/                  # PC 中控服务 (TypeScript)
│   ├── src/
│   │   ├── main.ts          # 入口：TCP + HTTP 服务器
│   │   ├── tcp_server.ts    # 接收 ESP32 TCP 数据
│   │   ├── http_server.ts   # HTTP API + 前端页面
│   │   ├── dispatcher.ts    # 指令分发
│   │   ├── astar.ts         # A* 路径规划
│   │   ├── state.ts         # 机器人状态管理
│   │   └── types.ts         # 类型定义
│   ├── test.html            # 前端测试页
│   └── package.json
└── docs/                    # 文档
```

## 关键技术说明

| 模块 | 说明 |
|------|------|
| **SC2336 初始化** | Espressif `esp-video-components` 官方寄存器配置 |
| **ISP 管线** | RAW10 → RGB565 → JPEG (硬件编码) |
| **JPEG 编码** | ESP32-P4 硬件 JPEG 编码器 (`esp_driver_jpeg`) |
| **WiFi 图传** | STA 模式连接路由器，HTTP MJPEG 流 + TCP 客户端 |
| **UART 协议** | 115200 baud, GPIO5 TX / GPIO6 RX |
| **路径规划** | 中控内置 A* 算法，支持航点下发 |

## 配置项 (`idf.py menuconfig`)

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `CONFIG_ESP_WIFI_SSID` | — | WiFi SSID |
| `CONFIG_ESP_WIFI_PASSWORD` | — | WiFi 密码 |
| `CONFIG_PC_SERVER_IP` | — | PC 中控服务器 IP |
| `CONFIG_PC_SERVER_PORT` | 5000 | TCP 端口 |

---

## 测试验证

- [x] ESP32-P4 固件编译通过
- [x] 摄像头 MIPI CSI 驱动正常
- [x] HTTP MJPEG 视频流可访问
- [ ] UART 与 STM32 联调通过
- [ ] 中控服务端到端验证

## 关联分支

| 分支 | 说明 |
|------|------|
| `feature/edge-esp-server` | 本分支 — ESP32-P4 边缘视觉处理 |
| `feature/cloud-front` | 云端前端 + 控制器 |
| `feature/device-stm32` | STM32 底盘控制 |
| `main` | 主分支 |

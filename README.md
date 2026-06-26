# CEVS-MobileRobot

Cloud-Edge Vision System (CEVS) for mobile robots: real-time visual perception, ESP32-P4 edge control, and web-based digital twin visualization.

---

## 项目概述

CEVS-MobileRobot 是一套面向移动机器人的云边端协同系统架构：

- **云端 (Cloud)** — 数字孪生可视化前端、中央控制器
- **边缘端 (Edge)** — ESP32-P4 实时视觉感知处理
- **设备端 (Device)** — STM32 底盘运动控制

本仓库为 **cloud-front** 分支，承载云端核心模块。

---

## 模块说明

### 前端 — AGV 数字孪生
- Three.js + Vite 构建的 3D 可视化界面
- 实时点云渲染、导航地图叠加、AGV 状态监控
- 基于 MQTT / WebSocket 与边缘端实时数据同步

### 控制器 — FastAPI 后端
- RESTful API（导航、巡检、POI 管理、事件推送）
- MQTT 双向通信桥接
- LLM 服务集成、事件引擎

### SLAM 重建管线
- 视频输入抽帧 → SuperPoint 特征提取
- HLoc / NetVLAD 全局检索 + 3D 重建
- WebSocket 实时推送到前端可视化

---

## 快速开始

```bash
# 启动前端
cd web/agv-digital-twin
npm install
npm run dev

# 启动控制器 (新终端)
cd controller/controller
pip install -r requirements.txt
python -m src.main

# 一键启动所有服务
bash web/agv-digital-twin/startup.sh
```

| 服务 | 地址 |
|------|------|
| 前端 | http://localhost:5173 |
| 控制器 API | http://localhost:8000/docs |
| MQTT Broker | 1883 (native) / 9001 (ws) |

---

## 目录结构

```
lingbot_ws/
├── web/agv-digital-twin/     # 数字孪生前端 (Vite + Three.js)
├── controller/controller/    # 中央控制器 (FastAPI)
├── input/                    # 输入视频 / 图片
├── output/                   # 重建输出
├── scripts/                  # 辅助脚本
├── docs/                     # 部署与集成文档
├── config/                   # 配置文件
├── main.js                   # 入口
└── run.sh                    # SLAM 启动脚本
```

## 文档索引

| 文档 | 说明 |
|------|------|
| [部署指南](docs/deploy_guide.md) | 环境配置与排坑 |
| [Web 集成](docs/web_integration.md) | 前端与 SLAM 管线对接 |
| [数字孪生集成说明](docs/agv-digital-twin-integration.md) | 实时建图与前端架构 |
| [IMU 里程计集成](docs/imu_odometry_integration.md) | 传感器融合方案 |
| [CUDA 环境](docs/cuda_environment.md) | GPU 加速配置 |

---

## 关联分支

| 分支 | 说明 |
|------|------|
| `feature/cloud-front` | 本分支 — 云端前端 + 控制器 |
| `feature/edge-esp-server` | ESP32-P4 边缘视觉处理 |
| `feature/device-stm32` | STM32 底盘控制 |
| `main` | 主分支 |

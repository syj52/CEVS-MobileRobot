# LingBot-MAP 工作空间

统一管理实时 3D 重建的推理、可视化和前端集成。

## 目录结构

```
lingbot_ws/
├── run.sh              # 统一启动脚本 [入口]
├── config/
│   └── profiles.yaml   # 参数配置文件
├── input/              # 放入你的视频或图片文件夹
├── output/             # 推理结果输出
├── scripts/            # 辅助脚本
├── web/                # 前端项目 (指向 agv-digital-twin)
└── docs/               # 文档
```

## 快速开始

### 1. 放数据

把视频放到 `input/` 目录下：
```bash
cp /path/to/your/video.mp4 ~/lingbot_ws/input/
```

### 2. 运行

```bash
cd ~/lingbot_ws
./run.sh --mode live --video input/CA.mp4          # 实时可视化 (viser)
./run.sh --mode ws --video input/CA.mp4             # WebSocket 流 (给前端)
./run.sh --mode batch --image input/courthouse/     # 一次性推理 + 查看
```

### 3. 查看结果

- **live 模式**：浏览器打开 `http://localhost:8080`
- **ws 模式**：配合前端项目 `web/agv-digital-twin` 使用
- **batch 模式**：浏览器打开 `http://localhost:8080`

## 完整参数

```bash
./run.sh --mode live --video input/CA.mp4 --fps 5 --quality balanced
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--mode` | `live` | `live` / `ws` / `batch` |
| `--video` | — | 输入视频路径 |
| `--image` | — | 输入图片文件夹 |
| `--fps` | `5` | 视频抽帧率 |
| `--quality` | `balanced` | `performance` / `balanced` / `quality` |
| `--port` | `8080` | Viser Web 端口 |
| `--ws_port` | `9091` | WebSocket 端口 |

## 环境要求

```bash
conda activate lingbot-map
```

见 [排坑文档](docs/deploy_guide.md) 或原项目 `README_deploy.md`。

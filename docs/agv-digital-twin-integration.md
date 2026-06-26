# 集成 LingBot-Map 实时建图到 AGV 数字孪生系统

## 架构

```
┌─────────────────────┐         WebSocket          ┌──────────────────────┐
│  WSL2 (Python)      │   ws://localhost:9091       │  Windows 浏览器      │
│                     │ ──────────────────────────► │                      │
│  demo_live_ws.py    │   每帧推一次:               │  Three.js + live_map │
│  ┌─────────────┐    │   - 点云 (binary)           │  ┌──────────────┐   │
│  │ LingBot-Map │    │   - 相机位姿 (binary)       │  │ LiveMapClient│   │
│  │ inference   │───►│   - 完成信号                │  │ → 自动渲染帧 │   │
│  └─────────────┘    │                             │  └──────────────┘   │
└─────────────────────┘                             └──────────────────────┘
```

## 使用方法

### 1. 启动 Python 端

在 WSL2 中，进入 LingBot-Map 目录：

```bash
cd ~/lingbot_map/LingBot-Map

python demo_live_ws.py \
    --model_path weights/lingbot-map-long.pt \
    --image_folder /path/to/your/images \
    --fps 5 \
    --use_sdpa --offload_to_cpu \
    --num_scale_frames 2 \
    --kv_cache_sliding_window 20 \
    --keyframe_interval 2 \
    --camera_num_iterations 1 \
    --downsample_factor 20 \
    --ws_port 9091
```

- `--downsample_factor 20`：网络传输用更高的下采样（20倍），减少带宽
- `--ws_port 9091`：WebSocket 端口（避免跟 rosbridge 的 9090 冲突）
- 看到 `WebSocket server at ws://0.0.0.0:9091` 即启动成功

> ⚠️ **从图片文件夹还是视频输入？** 这个脚本支持跟 demo.py 一样的输入方式，`--image_folder` 或 `--video_path` 都可以。

### 2. 修改前端 main.js

在 AGVDigitalTwin 类中增加 LiveMapClient：

```javascript
// 文件顶部加 import
import { LiveMapClient } from './live_map.js';

// 在 AGVDigitalTwin 的 constructor 中增加属性
class AGVDigitalTwin {
    constructor() {
        // ... 已有属性 ...
        this.liveMap = null;    // ← 新增
        // ...
    }
}

// 在 async startSceneMode() 中，scene 初始化完成后创建 LiveMapClient
// 建议在 scene 创建之后（约第120行，this.controls = controls 之后）添加：
this.liveMap = new LiveMapClient(this.scene, 'ws://localhost:9091');

// 再在界面上加一个启动按钮（放在 createModeSelector 里，约第70行附近）：
modeSelector.innerHTML += `
    <hr style="border-color:#444;margin:8px 0;">
    <button onclick="agvTwin.toggleLiveMap()" id="btn-live-map" style="background:#0a0;color:#fff;">
        ▶ 启动实时建图
    </button>
`;

// 在类中新增 toggleLiveMap 方法：
toggleLiveMap() {
    if (this.liveMap) {
        if (this.liveMap.ws && this.liveMap.ws.readyState === WebSocket.OPEN) {
            this.liveMap.stop();
            document.getElementById('btn-live-map').textContent = '▶ 启动实时建图';
            document.getElementById('btn-live-map').style.background = '#0a0';
        } else {
            this.liveMap.start();
            document.getElementById('btn-live-map').textContent = '■ 停止实时建图';
            document.getElementById('btn-live-map').style.background = '#a00';
        }
    }
}
```

### 3. 运行

```bash
# 终端1 (WSL2) — 运行推理 + WebSocket
conda activate lingbot-map
cd ~/lingbot_map/LingBot-Map
python demo_live_ws.py ...

# 终端2 (Windows) — 运行前端
cd /path/to/agv-digital-twin
npm run dev
```

浏览器打开 Vite 给出的地址（通常 `http://localhost:5173`），点击 **"启动实时建图"** 按钮，就能看着场景一帧帧建出来了。

## 数据格式（供二次开发参考）

WebSocket 使用二进制协议，每种消息由首字节 type 区分：

| type | 含义 | 数据内容 |
|------|------|----------|
| `0x01` | 点云帧 | frame_idx(4B) + num_points(4B) + xyz(float32×3) × N + rgb(uint8×3) × N |
| `0x02` | 相机位姿 | frame_idx(4B) + t.xyz(float32×3) + q.xyzw(float32×4) + fov(float32) + aspect(float32) |
| `0xFF` | 推理完成 | num_frames(4B) |

## 注意事项

1. **先启动 Python 端，再打开网页**：LiveMapClient 有自动重连机制（断开后 2 秒重试），所以顺序无所谓，但要确保推理运行时端口可用
2. **带宽**：~20000 点/帧 × 15 字节/点 = ~300 KB/帧，加上 2.5 FPS ≈ 750 KB/s，局域网无压力
3. **显存**：推理端的参数跟之前一样，如果跑长视频还是用 windowed 模式
4. **清除建图结果**：调用 `agvTwin.liveMap.clear()` 可清除所有已加载的点云

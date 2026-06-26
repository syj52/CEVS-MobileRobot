# LingBot-Map 部署排坑记录

> 硬件环境：RTX 5060 Laptop GPU (8GB) | CUDA 12.8 | Driver 581.83
> 基础环境见 [CUDA 环境报告](/home/ljq/cuda_environment.md)

---

## 目录

1. [安装问题](#1-安装问题)
2. [FlashInfer 不兼容 Blackwell GPU](#2-flashinfer-不兼容-blackwell-gpu)
3. [爆显存——模型加载阶段](#3-爆显存模型加载阶段)
4. [爆显存——推理阶段](#4-爆显存推理阶段)
5. [参数调整总结](#5-参数调整总结)
6. [最终可用命令](#6-最终可用命令)
7. [源文件修改记录](#7-源文件修改记录)

---

## 1. 安装问题

### 1.1 缺少 urllib3

运行 `python demo.py` 时 `flashinfer-python` 导入失败，报 `ModuleNotFoundError: No module named 'urllib3'`。

**原因**：`conda create` 新环境后未安装 `urllib3`，而 `flashinfer-python` 运行 JIT 编译时需要 `requests` → `urllib3`。

**解决**：
```bash
pip install urllib3
```

### 1.2 可视化依赖未安装

运行完推理后提示 `viser not installed`。

**原因**：只安装了核心推理依赖，未装可视化相关包。

**解决**：
```bash
pip install -e ".[vis]"
# 安装内容包括: viser, trimesh, matplotlib, onnxruntime, requests
```

---

## 2. FlashInfer 不兼容 Blackwell GPU

### 现象

```
RuntimeError: FlashInfer is not available. Please install flashinfer.
```

### 原因

项目默认使用 FlashInfer 的 paged KV cache attention。但是：

1. RTX 5060 是 **Blackwell 架构**，计算能力 **sm_120**
2. FlashInfer 0.6.10 的 JIT 编译需要 **CUDA >= 12.9** 才能生成 sm_120 的内核
3. 系统安装的是 CUDA 12.8，不满足要求

### 解决

加 `--use_sdpa` 参数，让模型回退到 PyTorch 原生的 SDPA (Scaled Dot-Product Attention)。

```bash
python demo.py --use_sdpa ...
```

SDPA 使用 FlashAttention 内核，不需要额外依赖，但性能略低于 FlashInfer（~2.4 FPS vs ~20 FPS）。

---

## 3. 爆显存——模型加载阶段

### 现象

```
RuntimeError: CUDA driver error: out of memory
```

发生在 `model.to(device).eval()` 处，模型权重文件 `lingbot-map-long.pt` 为 **4.4 GB**。

### 原因（重要）

源文件 `demo.py` 第 154 行：

```python
ckpt = torch.load(args.model_path, map_location=device, weights_only=False)
```

- `device = torch.device("cuda")`
- `map_location="cuda"` 直接把 **4.4 GB 权重全部加载到 GPU 显存**
- 紧接着 `load_state_dict()` 在 GPU 上又**复制了一份**模型参数
- 短时间内 GPU 上有 **两份共 ~8.8 GB** 的权重数据
- RTX 5060 只有 8 GB 显存 → 直接爆

### 解决

修改 `demo.py` 第 154 行，把 checkpoint 加载到 CPU 内存：

```python
# 改前
ckpt = torch.load(args.model_path, map_location=device, weights_only=False)

# 改后
ckpt = torch.load(args.model_path, map_location="cpu", weights_only=False)
```

这样 checkpoint 放在 CPU 内存中，`load_state_dict` 将参数复制到模型（此时模型还在 CPU 上），最后 `model.to(device)` 一次性将已加载好的模型搬到 GPU——**只有一份拷⻉在 GPU 上**。

---

## 4. 爆显存——推理阶段

### 现象

加载成功（3.36 GB allocated），但推理到约第 31 帧时 OOM。

### 原因

推理时的显存占用构成（以 286 帧为例）：

| 项目 | 大小 | 说明 |
|------|------|------|
| 模型权重 | ~3.36 GB | 聚合器已转 bf16 (节省 ~2-3 GB) |
| 286 张图像 | ~0.52 GB | fp32, 518×294 |
| KV cache（逐帧增长） | ~77 MB/帧 | 24 层 × k+v 各一份 |
| 注意力中间变量 | ~0.5-1 GB | 每帧计算时临时分配 |

当 KV cache 增长到约 31 帧时：

```
3.36 (模型) + 0.52 (图像) + 2.40 (KV cache 31帧) + 中间变量 ≈ 7.5+ GB
```

超过 8 GB 显存上限，触发 OOM。

### 核心机制

KV cache 是流式推理的核心——它存储历史帧的 key/value，新帧只需要用 query 与缓存做注意力，无需重新编码历史帧。

KV cache 数据结构（spa 模式，在 `attention.py` 中）：

```python
# 每帧、每层、每个方向 (k/v) 存一��� tensor:
# shape: [B=1, num_heads=16, 1, tokens_per_frame=780, head_dim=64]
# 1 × 16 × 1 × 780 × 64 × 2 bytes (bf16) = 1.6 MB 每个方向
# 每层 k+v = 3.2 MB，24 层 = 77 MB/帧
```

### 解决

通过命令行参数组合控制 KV cache 大小：

| 参数 | 默认 | 建议 | 作用 |
|------|------|------|------|
| `--num_scale_frames` | 8 | **2** | 初始基准帧数（设为 4 可保质量)）
| `--kv_cache_sliding_window` | 64 | **20** | 滑动窗口大小，控制缓存上限 |
| `--keyframe_interval` | 1 | **2** | 隔帧缓存，KV cache 条目减半 |
| `--camera_num_iterations` | 4 | **2** | 相机位姿优化轮数 |
| `--offload_to_cpu` | false | **必须加** | 逐帧预测结果搬到 CPU |

同时修改 `demo.py` 第 462 行，**不让图片进入 GPU**，再省 ~0.5 GB：

```python
# 改前
images = images.to(device)

# 改后
# images = images.to(device)  # keep on CPU
```

`inference_streaming` 内部会逐帧将当前帧搬到 GPU，用完即弃，峰值内存远低于全部驻留。

### 参数对质量的影响

| 参数 | 调低后影响 |
|------|-----------|
| `--num_scale_frames` 8→2 | 初始位姿基准少，后续帧累积误差增大 |
| `--camera_num_iterations` 4→1 | 位姿精���差，点云对齐度下降，视觉上"糊" |
| `--kv_cache_sliding_window` 64→20 | 长时序上下文丢失，远处场景可能漂移 |
| `--keyframe_interval` 1→2 | 时间密度减半，细长结构可能有断 |

---

## 5. 参数调整总结

### 极致性能模式（内存优先）

```bash
--num_scale_frames 2 \
--kv_cache_sliding_window 20 \
--keyframe_interval 2 \
--camera_num_iterations 1 \
--offload_to_cpu \
--use_sdpa
```

峰值 ~6.5 GB，可稳定跑完 286 帧。

### 质量优先模式（推荐）

```bash
--num_scale_frames 4 \
--kv_cache_sliding_window 20 \
--keyframe_interval 2 \
--camera_num_iterations 2 \
--offload_to_cpu \
--use_sdpa
```

---

## 6. 最终可用命令

```bash
# Activate environment
conda activate lingbot-map

# Run demo (质量优先)
python demo.py \
    --model_path weights/lingbot-map-long.pt \
    --image_folder /home/ljq/video_input/corridor \
    --mask_sky \
    --use_sdpa \
    --offload_to_cpu \
    --num_scale_frames 2 \
    --kv_cache_sliding_window 20 \
    --keyframe_interval 2 \
    --camera_num_iterations 2

# 实时建图版本

python demo_live.py \
    --model_path weights/lingbot-map-long.pt \
    --image_folder /home/ljq/video_input/corridor \
    --fps 5 \
    --use_sdpa --offload_to_cpu \
    --num_scale_frames 2 \
    --kv_cache_sliding_window 20 \
    --keyframe_interval 2 \
    --camera_num_iterations 1


# 浏览器打开 http://localhost:8080 查看 3D 点云
```

---

## 7. 源文件修改记录

### `demo.py` 第 154 行

```python
# 改前
ckpt = torch.load(args.model_path, map_location=device, weights_only=False)

# 改后
ckpt = torch.load(args.model_path, map_location="cpu", weights_only=False)
```

**原因**：见第 3 节，防止 checkpoint 直接加载到 GPU 造成 OOM。

### `demo.py` 第 462 行

```python
# 改前
images = images.to(device)

# 改后
# images = images.to(device)  # keep on CPU; inference_streaming transfers frame by frame
```

**原因**：见第 4 节，286 张图占 0.5 GB 显存，改为逐帧传输。

---

## 附：硬件限制总结

RTX 5060 8GB 跑 4.4 GB 的模型确实紧张，核心瓶颈：

1. **显存容量**：模型权重 3.36 GB（bf16）+ KV cache + 中间变量，8 GB 几乎占满
2. **Blackwell 兼容性**：FlashInfer 等 CUDA 扩展尚未完全支持 sm_120
3. **CUDA 版本**：系统的 12.8 略低于 FlashInfer 对 Blackwell 要求的 12.9

如果未来升级条件允许，**24 GB 以上显存的 GPU**（如 RTX 4090 / 5090）可以：
- 不用 `--use_sdpa`，用 FlashInfer 实现 ~20 FPS
- 不用缩参数，全量跑满 8 scale frames + 64 sliding window
- 跑 10000+ 帧长序列

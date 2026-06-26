# CUDA 环境检测报告

**检测时间**: 2026-05-05 15:32

---

## 1. GPU 硬件

| 项目 | 详情 |
|------|------|
| GPU 型号 | NVIDIA GeForce RTX 5060 Laptop GPU |
| 架构 | Blackwell |
| 计算能力 (Compute Capability) | **12.0** (sm_120) |
| 显存 | 8151 MiB (~8 GB) |
| 驱动版本 | 581.83 |
| 驱动支持的最高 CUDA 版本 | 13.0 |

---

## 2. 已安装的 CUDA Toolkit

系统中通过 dpkg 安装了 **3 个版本** 的 CUDA Toolkit：

| 版本 | 路径 | 优先级 | 状态 |
|------|------|--------|------|
| CUDA 13.2 | `/usr/local/cuda-13.2` | 132 | 当前 alternatives 默认 |
| CUDA 12.8 | `/usr/local/cuda-12.8` | 128 | cuda-12 的默认，**PyTorch 推荐使用此版本** |
| CUDA 12.6 | `/usr/local/cuda-12.6` | 126 | 已安装 |

符号链接：
```
/usr/local/cuda     → /usr/local/cuda-13.2
/usr/local/cuda-12  → /usr/local/cuda-12.8
/usr/local/cuda-13  → /usr/local/cuda-13.2
```

---

## 3. Conda 环境中的 CUDA

Miniconda3 (base 环境) 中安装了 **CUDA 12.1** 完整工具包。

当前终端中 `nvcc` 命令指向 conda 的 12.1：
```
/home/ljq/miniconda3/bin/nvcc  →  V12.1.66
```

各路径 nvcc 版本：

| 来源 | nvcc 版本 |
|------|------------|
| conda (PATH 最前) | 12.1.66 |
| /usr/local/cuda-13.2/bin/nvcc | 13.2.78 |
| /usr/local/cuda-12.8/bin/nvcc | 12.8.93 |
| /usr/local/cuda-12.6/bin/nvcc | 12.6.85 |

---

## 4. 环境变量

| 变量 | 值 |
|------|-----|
| `CUDA_HOME` | (未设置) |
| `CUDA_PATH` | (未设置) |
| `PATH` | `/usr/local/cuda-12.8/bin` 在其中，但 conda 路径在前 |
| `LD_LIBRARY_PATH` | 包含 `/usr/local/cuda-12.8/lib64` |

---

## 5. 现有 Conda 虚拟环境 PyTorch 版本检测

| 环境名 | Python | PyTorch | CUDA 支持 | torchvision | 是否 CUDA 12.8 |
|--------|--------|---------|-----------|-------------|----------------|
| **splatam** | 3.10.20 | 2.11.0+cu128 | True, sm_120 | 0.26.0+cu128 | ✅ 是 |
| **surfel_splatting** | 3.10.14 | 2.11.0+cu128 | True, sm_120 | 0.26.0+cu128 | ✅ 是 |
| base | — | 未安装 | — | — | ❌ |

两个虚拟环境都已经使用 **PyTorch 2.11.0 + CUDA 12.8**，并且正确识别 RTX 5060 (sm_120)。

各环境关键包详情：
```
# splatam (Python 3.10.20)
torch                                2.11.0+cu128
torchvision                          0.26.0+cu128
triton                               3.6.0
nvidia-cuda-cupti-cu12               12.8.90
nvidia-cuda-nvrtc-cu12               12.8.93
nvidia-cuda-runtime-cu12             12.8.90
```

```
# surfel_splatting (Python 3.10.14)
torch                                2.11.0+cu128
torchvision                          0.26.0+cu128
triton                               3.6.0
nvidia-cuda-cupti-cu12               12.8.90
nvidia-cuda-nvrtc-cu12               12.8.93
nvidia-cuda-runtime-cu12             12.8.90
```

---

## 6. PyTorch CUDA 12.8 安装指南（给其他 AI 用的参考）

### 为何必须用 CUDA 12.8？

RTX 5060 是 Blackwell 架构 (sm_120)，需要较新的 CUDA 版本才能支持。CUDA 12.8 是 **首个完整支持 Blackwell 消费级显卡的长期稳定版本**，PyTorch 官方也为其提供预编译 wheel。CUDA 12.6 及更早版本不支持 sm_120。

### Python 版本要求

| 要求 | 说明 |
|------|------|
| 最低版本 | Python 3.10 |
| 推荐版本 | **Python 3.10.x** (兼容性最广泛) |
| 支持的最高版本 | Python 3.14 |
| 不支持 | Python 3.9 及更早版本 |

推荐使用 Python 3.10，因为：
- 绝大多数 3DGS/Gaussian Splatting 相关项目依赖此版本
- 与 `gsplat`、`diff-gaussian-rasterization` 等子模块兼容性最好
- 这台机器上现有的两个环境也都是 3.10

### pip 安装命令

```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
```

如果只需要 torch 核心包（很多 3DGS 项目不需要 torchaudio）：

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
```

安装后验证：

```python
import torch
print(torch.__version__)           # 应显示 2.x.0+cu128
print(torch.cuda.is_available())   # 必须为 True
print(torch.cuda.get_device_name(0))  # 应显示 RTX 5060
```

### 注意事项

1. **不要混用 conda 和 pip 的 CUDA 包**：如果 conda 环境里已经安装了 `cudatoolkit` 或 `cuda-toolkit`，pip 安装 PyTorch 时可能产生冲突。建议在新环境中只通过 pip 安装 PyTorch，它自带了 `nvidia-cuda-runtime-cu12` 等依赖，不需要单独安装 CUDA toolkit。

2. **不要用 conda install pytorch**：conda 的 PyTorch 通常落后于 pip 版本，且 CUDA 12.8 版本可能不可用。统一用 pip + `--index-url` 方式安装。

3. **nvcc 编译器跟 PyTorch 运行时是可以分离的**：PyTorch 通过自带的 `nvidia-cuda-runtime-cu12` 在运行时调用 GPU，不需要系统 nvcc。但如果你在项目中需要编译 CUDA 扩展（如 `gsplat`、`diff-gaussian-rasterization`），则需要 `CUDA_HOME` 指向 `/usr/local/cuda-12.8`。

4. **Triton 兼容性**：PyTorch 2.11 配合 CUDA 12.8 时 Triton 3.6.0 工作正常，但某些旧版 Triton 在 Blackwell GPU 上可能有 bug。

5. **cuDNN**：PyTorch 预编译 wheel 已自带 cuDNN 9.19，无需额外安装。

---

## 7. 新项目环境配置建议（汇总）

```bash
# 创建新环境
conda create -n <your_project> python=3.10 -y
conda activate <your_project>

# 安装 PyTorch (CUDA 12.8)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128

# 如果项目需要编译 CUDA 扩展，设置环境变量
export CUDA_HOME=/usr/local/cuda-12.8
export PATH=$CUDA_HOME/bin:$PATH
export LD_LIBRARY_PATH=$CUDA_HOME/lib64:$LD_LIBRARY_PATH
```

---

## 8. 已知问题

1. `CUDA_HOME` 未设置，编译 CUDA 扩展时会找不到 CUDA 头文件
2. 系统 alternatives 默认指向 CUDA 13.2，但实际开发和 PyTorch 生态都建议基于 CUDA 12.8
3. conda 的 CUDA 12.1 在 PATH 最前，`nvcc` 被拦截为旧版本

# gen_nav2_map.py使用指令
## 在home/ljq目录下执行
```bash
python3 nsjs/agv-digital-twin/public/models/gen_nav2_map.py \
  --pcd nsjs/agv-digital-twin/public/models/scene.ply \
  --out-dir nsjs/agv-digital-twin/public/models \
  --resolution 0.05 --zmin 0.05 --zmax 0.5 --margin 10 --robot-radius 0
```
- **--pcd**: 指定输入的源文件路径。在这里是 `scene.ply`，它是通过 3DGS 扫描或三维重建生成的点云数据。

- **--out-dir**: 指定生成的地图文件（`.pgm` 图片和 `.yaml` 配置文件）存放的目标目录。

- **--resolution 0.05**: 地图分辨率（单位：米/像素）。数值为 0.05 表示地图上的一个像素代表现实世界中的 5×5 厘米。分辨率越小，地图越精细，但计算开销也越大。

- **--zmin 0.05 和 --zmax 0.5**: 垂直切片范围。脚本只会提取高度（Z 轴）在这个区间内的点云数据。
  - `zmin 0.05`: 过滤掉地面干扰（如地毯、微小起伏）。
  - `zmax 0.5`: 只保留机器人底盘高度范围内的障碍物，过滤掉天花板、吊灯或高于机器人的物体。

- **--margin 10**: 边缘留白（单位：像素）。在生成的 PGM 图像四周额外增加 10 个像素的空白区域，防止点云边界紧贴图像边缘，给导航留出缓冲空间。

- **--robot-radius 0**: 机器人半径。用于在生成地图时对障碍物进行"膨胀"处理。如果设为 0，则生成的地图只反映真实的物理边界；如果设置为正值，障碍物会向外扩大该半径，从而在地图层面直接防止路径规划过于贴近墙壁。

# three.js启动命令

```bash
npm run dev
# 在nsjs/agv-digital-twin目录下执行
```

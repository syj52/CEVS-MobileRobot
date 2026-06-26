// navigation_display.js
// PGM/YAML 地图解析、A*寻路、Three.js 动画（修正版：处理 negate、阈值；增加调试、半透明地图与键盘控制）
import * as THREE from 'three';

export class NavigationDisplay {
    constructor({ scene, camera, renderer, mapPgmUrl, mapYamlUrl, logger }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.log = logger || null;
        this.originalCursor = this.renderer.domElement.style.cursor || '';
        this.renderer.domElement.style.cursor = 'crosshair';
        this.mapPgmUrl = mapPgmUrl;
        this.mapYamlUrl = mapYamlUrl;

        this.robotMesh = null;
        this.mapData = null;
        this.gridMesh = null;
        this._pathLine = null;
        this._pathGroup = null;

        this._onClick = null;
        this._animating = false;
        this._teleportMode = false;

        // 键盘控制状态
        this._keyboardState = { forward: false, back: false, left: false, right: false };
        this._keyboardLoopActive = false;
        this._keyboardLast = null;
        this._kbDown = null;
        this._kbUp = null;

        // 小地图相关
        this.miniMapCanvas = document.getElementById('mini-map-canvas');
        this.miniMapCtx = this.miniMapCanvas ? this.miniMapCanvas.getContext('2d') : null;
        this.monitorContainer = document.getElementById('map-monitor');
        this._bgCanvas = null; // 离屏 canvas 缓存地图背景，配合 drawImage 使用 canvas transform
        this._miniMapGoal = null;
        this._miniMapPath = null;
        this._onMiniMapClick = null;
        this._init();
    }

    async _init() {
        try {
            await this._loadMap();
            this._addRobot();
            // 添加可视化路径组
            if (this.scene) {
                this._pathGroup = new THREE.Group();
                this._pathGroup.name = 'nav_pathGroup';
                this.scene.add(this._pathGroup);
            }
            this._addClickListener();
            // 小地图点击导航
            this._addMiniMapClickListener();
            // 添加键盘控制
            this._addKeyboardControls();
            // 初始化完成后立即显示小地图
            this._updateMiniMap();
            this.log?.status('导航模块就绪 — 可点击地图寻路或使用 WASD 键盘操控');
        } catch (e) {
            this.log?.error(`导航模块初始化失败: ${e.message}`);
            console.error('NavigationDisplay init 失败:', e);
        }
    }

    async _loadMap() {
        const yamlText = await fetch(this.mapYamlUrl + "?v=1777604930").then(r => r.text());
        const yaml = this._parseYAML(yamlText);
        const pgmData = await fetch(this.mapPgmUrl + "?v=1777604930").then(r => r.arrayBuffer());
        const pgm = this._parsePGM(pgmData);

        // 合并并标准化字段
        this.mapData = Object.assign({}, yaml, pgm);
        this.mapData.resolution = Number(this.mapData.resolution || 1);
        this.mapData.maxval = Number(this.mapData.maxval || this.mapData.maxval || 255);
        this.mapData.negate = Number(this.mapData.negate || 0);
        this.mapData.occupied_thresh = Number(this.mapData.occupied_thresh || 0.95);
        this.mapData.free_thresh = Number(this.mapData.free_thresh || 0.196);
        if (!this.mapData.origin) this.mapData.origin = [-(this.mapData.width * this.mapData.resolution) / 2, -(this.mapData.height * this.mapData.resolution) / 2, 0];

        // 计算占用掩码并创建贴图（考虑 negate 与阈值）
        const { width, height, grid, maxval, negate, occupied_thresh, free_thresh } = this.mapData;
        const occupied = new Uint8Array(width * height);
        // const rgba = new Uint8Array(width * height * 3);

        // for (let y = 0; y < height; y++) {
        //     for (let x = 0; x < width; x++) {
        //         const idx = y * width + x;
        //         let v = grid[idx];
        //         if (negate) v = maxval - v;
        //         const occ = v / maxval;
        //         let color = 127;
        //         if (occ >= occupied_thresh) { occupied[idx] = 1; color = 0; } // occupied -> black
        //         else if (occ <= free_thresh) { occupied[idx] = 0; color = 255; } // free -> white
        //         else { occupied[idx] = 0; color = 127; } // unknown -> gray
        //         const dst = ((height - 1 - y) * width + x) * 3;
        //         rgba[dst] = color; rgba[dst+1] = color; rgba[dst+2] = color;
        //     }
        // }

        // this.mapData.occupied = occupied; // 1 = occupied

        // // 贴图（半透明，禁写深度以避免遮挡点云）
        // const tex = new THREE.DataTexture(rgba, width, height, THREE.RGBFormat);
        // tex.needsUpdate = true;
        // if (this.gridMesh) {
        //     this.scene.remove(this.gridMesh);
        // }
        const geom = new THREE.PlaneGeometry(width * this.mapData.resolution, height * this.mapData.resolution);
        // const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: 1.0, depthWrite: false, depthTest: false });
        const rgba = new Uint8Array(width * height * 4); // 改为 RGBA 4通道

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                let v = grid[idx];
                if (negate) v = maxval - v;
                const occ = v / maxval;
                
                const dst = (y * width + x) * 4;
                if (occ >= occupied_thresh) {
                    // 障碍物：暗红色，近不透明
                    rgba[dst]=180; rgba[dst+1]=20; rgba[dst+2]=20; rgba[dst+3]=230;
                } else if (occ <= free_thresh) {
                    // 空闲区：淡绿色，半透明（可清晰看到可通过区域）
                    rgba[dst]=0; rgba[dst+1]=180; rgba[dst+2]=50; rgba[dst+3]=90;
                } else {
                    // 未知区：灰色，低透明
                    rgba[dst]=100; rgba[dst+1]=100; rgba[dst+2]=100; rgba[dst+3]=60;
                }
            }
        }

        // 材质创建时使用 RGBAFormat
        const tex = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
        const mat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        this.gridMesh = new THREE.Mesh(geom, mat); this.gridMesh.renderOrder = 1;
        const org = this.mapData.origin;
        const centerX = org[0] + (width * this.mapData.resolution) / 2;
        const centerY = org[1] + (height * this.mapData.resolution) / 2;
        // 抬高一点避免 z-fighting，与点云交互更友好
        this.gridMesh.position.set(centerX, 0.05, centerY);
        this.gridMesh.rotation.x = -Math.PI / 2;
        this.gridMesh.name = 'nav_gridMesh';
        this.scene.add(this.gridMesh);
    }

    _parseYAML(text) {
        const lines = text.split(/\r?\n/);
        const data = {};
        for (const line of lines) {
            const m = line.match(/^\s*([a-zA-Z0-9_]+):\s*(.+)$/);
            if (!m) continue;
            const key = m[1];
            let val = m[2].trim();
            if (!isNaN(Number(val))) val = Number(val);
            else if (val.startsWith('[')) {
                try { val = JSON.parse(val.replace(/'/g, '"')); } catch (e) {}
            }
            data[key] = val;
        }
        return data;
    }

    _parsePGM(buffer) {
        const bytes = new Uint8Array(buffer);
        let i = 0;
        function skipWhitespaceAndComments() {
            while (i < bytes.length) {
                if (bytes[i] === 0x23) { // '#'
                    while (i < bytes.length && bytes[i] !== 0x0A) i++;
                    continue;
                }
                if (bytes[i] <= 32) { i++; continue; }
                break;
            }
        }
        function readToken() {
            skipWhitespaceAndComments();
            let s = '';
            while (i < bytes.length && bytes[i] > 32) s += String.fromCharCode(bytes[i++]);
            return s;
        }
        const magic = readToken();
        const width = parseInt(readToken(), 10);
        const height = parseInt(readToken(), 10);
        const maxval = parseInt(readToken(), 10);
        if (bytes[i] === 0x0A) i++;
        const expected = width * height;
        const data = bytes.slice(i, i + expected);
        return { width, height, maxval, grid: data };
    }

    _addRobot() {
        if (!this.scene) return;
        const res = this.mapData.resolution || 1;
        const r = Math.max(0.2, res * 0.4);
        const geom = new THREE.BoxGeometry(r*2.5, r*1.2, r*2.5);
        const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff, side: THREE.DoubleSide, depthTest: false });
        this.robotMesh = new THREE.Mesh(geom, mat);
        this.robotMesh.name = 'nav_robotMesh';
        // 初始放在地图中心
        const init = { x: Math.floor(this.mapData.width / 2), y: Math.floor(this.mapData.height / 2) };
        const p = this._gridToWorld(init);
        this.robotMesh.position.copy(p);
        this.scene.add(this.robotMesh);
    }

    _addClickListener() {
        if (!this.renderer || !this.renderer.domElement) return;

        this._onClick = (event) => {
            if (!this.gridMesh) return;
            this.renderer.domElement.style.cursor = 'wait';
            setTimeout(() => {
                if (this.gridMesh) this.renderer.domElement.style.cursor = 'crosshair';
            }, 100);
            const rect = this.renderer.domElement.getBoundingClientRect();
            const mouse = new THREE.Vector2();
            mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            const ray = new THREE.Raycaster();
            ray.setFromCamera(mouse, this.camera);
            const intersects = ray.intersectObject(this.gridMesh);
            if (!intersects || intersects.length === 0) return;
            const pt = intersects[0].point;
            const start = this._worldToGrid(this.robotMesh.position);
            const goal = this._worldToGrid(pt);

            const { width, height, occupied, maxval, negate, occupied_thresh } = this.mapData;
            const idx = (p) => p.y * width + p.x;
            const startIdx = idx(start);
            const goalIdx = idx(goal);
            const startVal = this.mapData.grid[startIdx];
            const goalVal = this.mapData.grid[goalIdx];
            console.log('Map Stats:', width, height, 'Origin:', this.mapData.origin); console.log('click point', pt, 'start', start, 'goal', goal, 'startRaw', startVal, 'goalRaw', goalVal, 'negate', negate, 'occupied_thresh', occupied_thresh);

            if (goal.x < 0 || goal.x >= width || goal.y < 0 || goal.y >= height) {
                this.log?.warn('点击超出地图范围');
                return;
            }

            // 瞬移模式：跳过 A*，直接移动
            if (this._teleportMode) {
                const worldPos = this._gridToWorld(goal);
                this.robotMesh.position.copy(worldPos);
                this._miniMapGoal = goal;
                this._miniMapPath = null;
                this._updateMiniMap();
                console.log('瞬移至:', goal.x, goal.y);
                return;
            }

            const path = this._astar(start, goal);
            if (path && path.length) {
                const dist = (path.length * (this.mapData?.resolution || 0.05)).toFixed(2);
                this.log?.info(`路径规划: 起点 (${start.x},${start.y}) → 目标 (${goal.x},${goal.y})，${path.length} 步 ≈ ${dist}m`);
                this._showPath(path);
                this._animateRobot(path);
            } else {
                this.log?.warn(`无路可走: 起点 (${start.x},${start.y}) → 目标 (${goal.x},${goal.y})`);
            }
        };

        this.renderer.domElement.addEventListener('click', this._onClick);
    }

    _showPath(path) {
        if (!this.scene) return;
        if (!this._pathGroup) {
            this._pathGroup = new THREE.Group();
            this._pathGroup.name = 'nav_pathGroup';
            this.scene.add(this._pathGroup);
        }
        // 清空
        while (this._pathGroup.children.length) {
            const c = this._pathGroup.children[0];
            this._pathGroup.remove(c);
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        }
        if (!path || !path.length) return;
        const points = path.map(g => this._gridToWorld(g));
        const pts = new Float32Array(points.length * 3);
        for (let i = 0; i < points.length; i++) {
            pts[i*3] = points[i].x;
            pts[i*3+1] = points[i].y + 0.15; // lift a bit
            pts[i*3+2] = points[i].z;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
        const mat = new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false });
        const line = new THREE.Line(geom, mat);
        this._pathGroup.add(line);
        // also add small markers at path nodes
        const markerMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
        const msize = Math.max(0.05, (this.mapData.resolution || 1) * 0.2);
        for (let p of points) {
            const m = new THREE.Mesh(new THREE.SphereGeometry(msize,8,8), markerMat);
            m.position.copy(p).add(new THREE.Vector3(0,0.1,0));
            this._pathGroup.add(m);
        }
    }

    _worldToGrid(pos) {
        const { width, height, resolution, origin } = this.mapData;
        const res = resolution || 1;
        const org = origin || [-(width * res) / 2, -(height * res) / 2, 0];
        const gx = Math.floor((pos.x - org[0]) / res);
        // gen_nav2_map.py 用 --up-axis y：原始 Z 映射为地图 Y，原始 Y 为高度
        // Three.js Y-up 场景等价：地图 Y = Three.js Z
        const gy = Math.floor((pos.z - org[1]) / res);
        return { x: gx, y: gy };
    }

    _gridToWorld(g) {
        const { resolution, origin, width, height } = this.mapData;
        const res = resolution || 1;
        const org = origin || [-(width * res) / 2, -(height * res) / 2, 0];
        const x = org[0] + (g.x + 0.5) * res;
        const z = org[1] + (g.y + 0.5) * res;
        return new THREE.Vector3(x, 0.2, z);
    }

    _astar(start, goal) {
        const { width, height, grid, maxval, negate, occupied_thresh } = this.mapData;
        const idx = (p) => p.y * width + p.x;
        const inBounds = (p) => p.x >= 0 && p.x < width && p.y >= 0 && p.y < height;

        const gScore = new Array(width * height).fill(Infinity);
        const fScore = new Array(width * height).fill(Infinity);
        const cameFrom = {};

        const open = [];
        gScore[idx(start)] = 0;
        fScore[idx(start)] = this._heuristic(start, goal);
        open.push(start);

        while (open.length) {
            open.sort((a, b) => fScore[idx(a)] - fScore[idx(b)]);
            const current = open.shift();
            if (current.x === goal.x && current.y === goal.y) {
                const path = [current];
                let key = `${current.x},${current.y}`;
                while (cameFrom[key]) {
                    path.unshift(cameFrom[key]);
                    key = `${cameFrom[key].x},${cameFrom[key].y}`;
                }
                return path;
            }
            for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                const neighbor = { x: current.x + dx, y: current.y + dy };
                if (!inBounds(neighbor)) continue;
                const nidx = idx(neighbor);
                let v = grid[nidx];
                if (negate) v = maxval - v;
                const occ = v / maxval;
                if (occ >= occupied_thresh) continue; // 障碍
                const tent = gScore[idx(current)] + 1;
                if (tent < gScore[nidx]) {
                    cameFrom[`${neighbor.x},${neighbor.y}`] = current;
                    gScore[nidx] = tent;
                    fScore[nidx] = tent + this._heuristic(neighbor, goal);
                    if (!open.some(p => p.x === neighbor.x && p.y === neighbor.y)) open.push(neighbor);
                }
            }
        }
        return [];
    }

    _heuristic(a, b) {
        return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    }

    _animateRobot(path) {
        if (!path || !path.length) return;
        // 取消已有动画
        this._animating = false;
        let i = 0;
        const stepTo = (from, to, duration = 60) => {
            const start = performance.now();
            const sPos = from.clone();
            const animate = () => {
                const t = Math.min(1, (performance.now() - start) / duration);
                this.robotMesh.position.lerpVectors(sPos, to, t);
                this._updateMiniMap(); // 实时刷新监控面板
                if (t < 1 && this._animating) requestAnimationFrame(animate);
                else if (t >= 1 && this._animating) {
                    i++;
                    moveNext();
                }
            };
            requestAnimationFrame(animate);
        };
        const moveNext = () => {
            if (!this._animating) return;
            if (i >= path.length) { this._animating = false; return; }
            const tgt = this._gridToWorld(path[i]);
            stepTo(this.robotMesh.position, tgt);
        };
        this._animating = true;
        moveNext();
    }

    // --- 键盘控制相关 ---
    _addKeyboardControls() {
        if (typeof window === 'undefined') return;
        // 已有监听则跳过
        if (this._kbDown) return;
        this._kbDown = (e) => {
            const k = (e.key || '').toLowerCase();
            // 瞬移模式切换
            if (k === 't' && !e.repeat) {
                this._teleportMode = !this._teleportMode;
                this.log?.info(this._teleportMode ? '🔵 瞬移模式 ON — 点击直接跳转' : '🔴 瞬移模式 OFF');
                return;
            }
            let started = false;
            if (k === 'w' || k === 'arrowup') { this._keyboardState.forward = true; started = true; }
            if (k === 's' || k === 'arrowdown') { this._keyboardState.back = true; started = true; }
            if (k === 'a' || k === 'arrowleft') { this._keyboardState.left = true; started = true; }
            if (k === 'd' || k === 'arrowright') { this._keyboardState.right = true; started = true; }
            if (started && !this._keyboardLoopActive) {
                this._keyboardLoopActive = true;
                this._keyboardLast = performance.now();
                this._keyboardLoopBound = this._keyboardLoopBound || this._keyboardLoop.bind(this);
                requestAnimationFrame(this._keyboardLoopBound);
            }
        };
        this._kbUp = (e) => {
            const k = (e.key || '').toLowerCase();
            if (k === 'w' || k === 'arrowup') this._keyboardState.forward = false;
            if (k === 's' || k === 'arrowdown') this._keyboardState.back = false;
            if (k === 'a' || k === 'arrowleft') this._keyboardState.left = false;
            if (k === 'd' || k === 'arrowright') this._keyboardState.right = false;
        };
        window.addEventListener('keydown', this._kbDown);
        window.addEventListener('keyup', this._kbUp);
    }

    _removeKeyboardControls() {
        try {
            if (this._kbDown) window.removeEventListener('keydown', this._kbDown);
            if (this._kbUp) window.removeEventListener('keyup', this._kbUp);
        } catch (e) {}
        this._keyboardLoopActive = false;
    }
    // --- 小地图点击导航 ---
    _addMiniMapClickListener() {
        if (!this.miniMapCanvas) return;
        this._onMiniMapClick = (event) => {
            if (!this.mapData || !this.robotMesh) return;
            const rect = this.miniMapCanvas.getBoundingClientRect();
            const ox = (event.clientX - rect.left) * (this.miniMapCanvas.width / rect.width);
            const oy = (event.clientY - rect.top) * (this.miniMapCanvas.height / rect.height);

            const gx = Math.floor(ox);
            // Canvas 经过 scale(1,-1)+translate(0,height) 翻转，顶部点击对应高 gy
            const gy = this.mapData.height - 1 - Math.floor(oy);
            if (gx < 0 || gx >= this.mapData.width || gy < 0 || gy >= this.mapData.height) return;

            const { grid, maxval, negate, occupied_thresh } = this.mapData;
            const nidx = gy * this.mapData.width + gx;
            let v = grid[nidx];
            if (negate) v = maxval - v;
            if (v / maxval >= occupied_thresh) {
                this.log?.warn(`小地图目标点 (${gx},${gy}) 是障碍物`);
                return;
            }

            const start = this._worldToGrid(this.robotMesh.position);
            const goal = { x: gx, y: gy };

            // 瞬移模式：跳过 A*，直接移动
            if (this._teleportMode) {
                const worldPos = this._gridToWorld(goal);
                this.robotMesh.position.copy(worldPos);
                this._miniMapGoal = goal;
                this._miniMapPath = null;
                this._updateMiniMap();
                this.log?.info(`瞬移至 (${goal.x}, ${goal.y})`);
                return;
            }

            this.log?.info(`小地图导航: (${start.x},${start.y}) → (${goal.x},${goal.y})`);
            this._miniMapGoal = goal;
            const path = this._astar(start, goal);
            this._miniMapPath = path;
            if (path && path.length) {
                this._showPath(path);
                this._animateRobot(path);
            }
            this._updateMiniMap();
        };
        this.miniMapCanvas.addEventListener('click', this._onMiniMapClick);
        this.miniMapCanvas.style.cursor = 'crosshair';
    }

    // --- 小地图更新（可在动画或位置更新时调用） ---
    _updateMiniMap() {
        if (!this.miniMapCtx || !this.mapData || !this.robotMesh) return;

        const { width, height, grid, maxval, negate, occupied_thresh, free_thresh } = this.mapData;

        // 1. 如果 Canvas 尺寸没对齐，初始化尺寸
        if (this.miniMapCanvas.width !== width) {
            this.miniMapCanvas.width = width;
            this.miniMapCanvas.height = height;
            this.monitorContainer.style.display = 'flex';
        }

        const ctx = this.miniMapCtx;
        ctx.clearRect(0, 0, width, height);

        // 2. 生成背景二值图到离屏 canvas（putImageData 不受 transform 影响，改用 drawImage）
        if (!this._bgCanvas || this._bgCanvas.width !== width) {
            this._bgCanvas = document.createElement('canvas');
            this._bgCanvas.width = width;
            this._bgCanvas.height = height;
            const bgCtx = this._bgCanvas.getContext('2d');
            const imgData = bgCtx.createImageData(width, height);
            for (let i = 0; i < grid.length; i++) {
                let v = grid[i];
                if (negate) v = maxval - v;
                const occ = v / maxval;
                let r, g, b;
                if (occ >= occupied_thresh) { r = g = b = 0; }
                else if (occ <= free_thresh) { r = g = b = 255; }
                else { r = g = b = 127; }
                const p = i * 4;
                imgData.data[p] = r;
                imgData.data[p+1] = g;
                imgData.data[p+2] = b;
                imgData.data[p+3] = 255;
            }
            bgCtx.putImageData(imgData, 0, 0);
        }

        // 3. 整体垂直翻转 Canvas，让 gy=0 在视觉上方，gy=height-1 在下方
        ctx.save();
        ctx.translate(0, height);
        ctx.scale(1, -1);

        // 4. 绘制背景（drawImage 受 transform 影响，随画布一起翻转）
        ctx.drawImage(this._bgCanvas, 0, 0);

        // 5. 绘制路径（直接使用逻辑坐标 gy，transform 已处理翻转）
        if (this._miniMapPath && this._miniMapPath.length > 1) {
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(this._miniMapPath[0].x, this._miniMapPath[0].y);
            for (let i = 1; i < this._miniMapPath.length; i++) {
                ctx.lineTo(this._miniMapPath[i].x, this._miniMapPath[i].y);
            }
            ctx.stroke();
        }

        // 6. 绘制目标点
        if (this._miniMapGoal) {
            ctx.fillStyle = '#00ff00';
            ctx.beginPath();
            ctx.arc(this._miniMapGoal.x, this._miniMapGoal.y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // 7. 绘制小车当前位置
        const gridPos = this._worldToGrid(this.robotMesh.position);
        ctx.fillStyle = '#ff0000';
        ctx.beginPath();
        ctx.arc(gridPos.x, gridPos.y, 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }
    _keyboardLoop() {
        if (!this._keyboardLoopActive) return;
        const now = performance.now();
        const dt = Math.min(0.05, (now - (this._keyboardLast || now)) / 1000);
        this._keyboardLast = now;
        this._updateMiniMap(); // 实时刷新监控面板    
        requestAnimationFrame(this._keyboardLoopBound);
        // 如果正在执行自动路径动画，则暂停键盘控制
        if (this._animating) { this._keyboardLoopActive = false; return; }
        if (!this.robotMesh) { requestAnimationFrame(this._keyboardLoopBound); return; }
        const speed = (this.mapData?.resolution || 0.05) * 8; // 基于地图分辨率的速度标度
        const rotSpeed = Math.PI * 0.9; // rad/s
        if (this._keyboardState.left) this.robotMesh.rotation.y += rotSpeed * dt;
        if (this._keyboardState.right) this.robotMesh.rotation.y -= rotSpeed * dt;
        let forward = 0;
        if (this._keyboardState.forward) forward += 1;
        if (this._keyboardState.back) forward -= 1;
        if (forward !== 0) {
            const dir = new THREE.Vector3(0,0,-1).applyQuaternion(this.robotMesh.quaternion);
            dir.y = 0; dir.normalize();
            this.robotMesh.position.addScaledVector(dir, forward * speed * dt);
        }
        requestAnimationFrame(this._keyboardLoopBound);
    }

    dispose() {
        // 停止动画
        this._animating = false;
        // 移除事件
        try {
            if (this._onClick && this.renderer && this.renderer.domElement) {
                this.renderer.domElement.removeEventListener('click', this._onClick);
                this.renderer.domElement.style.cursor = this.originalCursor || 'default';
            }
        } catch (e) {}
        // 移除小地图点击
        try {
            if (this._onMiniMapClick && this.miniMapCanvas) {
                this.miniMapCanvas.removeEventListener('click', this._onMiniMapClick);
                this.miniMapCanvas.style.cursor = '';
            }
        } catch (e) {}
        // 移除网格
        try {
            if (this.gridMesh && this.scene) {
                this.scene.remove(this.gridMesh);
                if (this.gridMesh.geometry) this.gridMesh.geometry.dispose();
                if (this.gridMesh.material) { if (this.gridMesh.material.map) this.gridMesh.material.map.dispose(); this.gridMesh.material.dispose(); }
                this.gridMesh = null;
            }
        } catch (e) { console.warn(e); }
        // 移除路径
        try {
            if (this._pathGroup && this.scene) {
                while (this._pathGroup.children.length) {
                    const c = this._pathGroup.children[0];
                    this._pathGroup.remove(c);
                    if (c.geometry) c.geometry.dispose();
                    if (c.material) c.material.dispose();
                }
                this.scene.remove(this._pathGroup);
                this._pathGroup = null;
            }
        } catch (e) { console.warn(e); }
        // 移除机器人
        try {
            if (this.robotMesh && this.scene) {
                this.scene.remove(this.robotMesh);
                if (this.robotMesh.geometry) this.robotMesh.geometry.dispose();
                if (this.robotMesh.material) this.robotMesh.material.dispose();
                this.robotMesh = null;
            }
        } catch (e) { console.warn(e); }
        // 移除键盘监听
        try { this._removeKeyboardControls(); } catch (e) {}
    }
}

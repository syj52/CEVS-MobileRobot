import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
window.THREE = THREE;

import { logger } from './logger.js';
import { PoiManager } from './poi_manager.js';

function makeDraggable(element) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    element.style.cursor = 'move';
    element.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        // 忽略按钮、输入框等元素的拖拽
        if (['INPUT', 'BUTTON', 'LABEL', 'SELECT', 'SPAN'].includes(e.target.tagName)) return;
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        // 如果原本是 right 定位，则转换为 left
        if (element.style.right) {
            element.style.left = element.offsetLeft + "px";
            element.style.right = '';
        }
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }
}

class AGVDigitalTwin {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.navigationDisplay = null;
        this._animationRunning = false;
        this.currentMode = '3dgs';

        this.init();
    }

    async init() {
        // 初始化日志面板
        const logContainer = document.getElementById('log-panel');
        const logList = document.getElementById('log-list');
        if (logContainer && logList) {
            logger.bind(logContainer, logList);
            logger.info('系统启动');
            document.getElementById('log-clear-btn')?.addEventListener('click', () => {
                logList.innerHTML = '';
                logger.info('日志已清空');
            });
            const input = document.getElementById('log-llm-input');
            const sendBtn = document.getElementById('log-llm-send');
            const doLLM = async () => {
                const text = input?.value?.trim();
                if (!text) return;
                logger.llm(text);
                try {
                    const resp = await fetch(
                        `http://localhost:8000/api/llm/chat?message=${encodeURIComponent(text)}&session_id=default`,
                        { method: 'POST' },
                    );
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = await resp.json();

                    // 检测到导航动作时给出醒目反馈
                    if (data.action?.type === 'navigate') {
                        const c = data.action.target_coords || {};
                        logger.status(`🎯 NAV → ${data.action.poi_name} @ (${(c.x || 0).toFixed(2)}, ${(c.y || 0).toFixed(2)}, ${(c.z || 0).toFixed(2)})`);
                        logger.info(`置信度: ${(data.action.confidence * 100).toFixed(0)}%，事件 ID: ${data.action.event_id || '无'}`);

                        // 确保导航模式已就绪
                        const doNav = async () => {
                            if (this.currentMode !== 'navigation') {
                                logger.info('正在自动切换至导航监控模式...');
                                await this.switchMode('navigation');
                            }
                            // 给 NavigationDisplay 一点初始化时间
                            setTimeout(() => {
                                if (this.navigationDisplay && this.navigationDisplay.navigateTo) {
                                    this.navigationDisplay.navigateTo(c.x, c.z, data.action.poi_name);
                                } else {
                                    logger.warn('导航模块未就绪');
                                }
                            }, 500);
                        };
                        doNav();
                    }

                    logger.llmReply(data.reply || '(空回复)');
                } catch (e) {
                    logger.llmReply(`请求失败: ${e.message}`);
                }
                if (input) input.value = '';
            };
            sendBtn?.addEventListener('click', doLLM);
            input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLLM(); });
        }

        // 创建模式切换界面
        this.createModeSelector();

        // 默认启动 3D 场景模式
        await this.startSceneMode();
    }

    createModeSelector() {
        const modeSelector = document.createElement('div');
        modeSelector.style.position = 'absolute';
        modeSelector.style.top = '10px';
        modeSelector.style.right = '10px';
        modeSelector.style.zIndex = '1000';
        modeSelector.style.backgroundColor = 'rgba(0,0,0,0.7)';
        modeSelector.style.padding = '10px';
        modeSelector.style.borderRadius = '5px';
        modeSelector.style.color = 'white';

        modeSelector.innerHTML = `
            <h3>AGV数字孪生系统</h3>
            <p>当前模式: <span id="currentMode">3D场景</span></p>
            <button onclick="agvTwin.switchMode('3dgs')">3D场景模式</button>
            <button onclick="agvTwin.switchMode('navigation')">导航监控模式</button>
        `;

        document.body.appendChild(modeSelector);
        makeDraggable(modeSelector); // 让导航面板可拖拽
    }

    async switchMode(mode) {
        if (this.currentMode === mode) return;

        logger.info(`切换至 ${mode === '3dgs' ? '3D场景' : '导航监控'} 模式`);

        await this.cleanupCurrentMode();

        if (mode === '3dgs') {
            // 已有 scene，只是显示/隐藏控制
        } else if (mode === 'navigation') {
            await this.startNavigationMode();
        }

        this.currentMode = mode;
        document.getElementById('currentMode').textContent =
            mode === '3dgs' ? '3D场景' : '导航监控';
    }

    async startSceneMode() {
        if (this.scene) {
            logger.info('场景已存在，复用');
            return;
        }

        // 创建 Three.js 渲染器
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
        renderer.setClearColor(0x222222, 1);
        renderer.autoClear = true;
        document.body.insertBefore(renderer.domElement, document.body.firstChild);

        // 场景
        const scene = new THREE.Scene();

        // 相机
        const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
        camera.position.set(3, 3, 5);

        // 轨道控制
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.update();

        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.controls = controls;

        // 窗口 resize — 防抖避免拖窗口时狂触发
        let _resizeTimer = null;
        window.addEventListener('resize', () => {
            if (_resizeTimer) cancelAnimationFrame(_resizeTimer);
            _resizeTimer = requestAnimationFrame(() => {
                camera.aspect = window.innerWidth / window.innerHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(window.innerWidth, window.innerHeight);
                _resizeTimer = null;
            });
        });

        // 加载 GLB
        const loader = new GLTFLoader();
        try {
            const gltf = await loader.loadAsync('/models/corridor_point_test.glb');
            logger.status('GLB 加载完成');

            // 放弃之前强行把模型拆成点云的做法，恢复 GLB 原生高质量网格
            const renderModel = gltf.scene;

            let vertexCount = 0;
            // 恢复直接原生渲染，放弃复杂的材质覆盖，防止性能卡顿
            renderModel.traverse((child) => {
                if (child.isMesh) {
                    if (child.geometry && child.geometry.attributes.position) {
                        vertexCount += child.geometry.attributes.position.count;
                    }
                    if (child.material) {
                        child.material.side = THREE.DoubleSide;
                    }
                } else if (child.isPoints) {
                    if (child.geometry && child.geometry.attributes.position) {
                        vertexCount += child.geometry.attributes.position.count;
                    }
                    // 仅采用系统原生点云材质设置基础显示大小，移除所有导致局部卡顿的透明度和发光纹理
                    if (child.material) {
                        child.material.size = 0.1;
                        // 确保系统默认使用顶点颜色，并且取消透明度混合
                        child.material.transparent = false;
                        child.material.depthWrite = true;
                    }
                }
            });

            if (renderModel) {
                // ==============================================
                // 【调整场景整体大小与位姿】
                // 必须保持 1.0 的缩放，否则物理导航坐标系会因为缩放被破坏
                const SCENE_SCALE = 1.0; 
                renderModel.scale.set(SCENE_SCALE, SCENE_SCALE, SCENE_SCALE);

                // 如果模型是斜的，可以在这里修改旋转角度（弧度制）来摆正
                // Math.PI 代表 180 度。你可以修改这里的数值慢慢微调，例如：
                // renderModel.rotation.x = -Math.PI / 2; // 绕X轴转-90度
                // renderModel.rotation.y = 0.15;         // 绕Y轴转一点点
                // renderModel.rotation.z = -0.1;         // 绕Z轴转一点点
                renderModel.rotation.set(0, 0, 0); // 默认无旋转：(x, y, z)
                
                // 需要平移的话也可以设置 position
                // renderModel.position.set(0, 0, 0);

                renderModel.updateMatrixWorld(true);
                // ==============================================

                scene.add(renderModel);

                const box = new THREE.Box3().setFromObject(renderModel);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);

                controls.target.copy(center);
                camera.position.set(center.x, center.y + maxDim * 0.8, center.z + maxDim * 1.5);
                controls.update();

                logger.info(`场景范围: ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}m，网格顶点约 ${(vertexCount / 1e4).toFixed(0)}万`);
                
                // === 新增：位姿调整（TransformControls）与保存界面 ===
                const transformControl = new TransformControls(camera, renderer.domElement);
                transformControl.addEventListener('dragging-changed', (event) => {
                    controls.enabled = !event.value; // 拖拽模型时禁用相机轨道
                });
                transformControl.attach(renderModel);
                // 修复：Three.js 新版本中需要通过 getHelper() 将辅助网格体加入场景
                scene.add(transformControl.getHelper());

                // 创建小控制面板
                const tPanel = document.createElement('div');
                tPanel.style.position = 'absolute';
                tPanel.style.left = '10px';
                tPanel.style.top = '60px';
                tPanel.style.background = 'rgba(0,0,0,0.8)';
                tPanel.style.padding = '10px';
                tPanel.style.color = '#fff';
                tPanel.style.zIndex = '1000';
                tPanel.style.borderRadius = '5px';
                
                tPanel.innerHTML = `
                    <div style="margin-bottom:8px;">模型姿态调整</div>
                    <button id="t-move" style="margin-right:5px;">移动 (W)</button>
                    <button id="t-rotate" style="margin-right:5px;">旋转 (E)</button>
                    <button id="t-hide">隐藏控制杠 (Q)</button>
                    <hr style="border-color:#555; margin: 10px 0;">
                    <div style="margin-bottom:8px; font-weight:bold; color:#0f0;">截面地图参数预演</div>
                    <label><input type="checkbox" id="t-slice-toggle"> 显示高度截平面</label><br>
                    <div id="t-slice-controls" style="display:none; margin-top:8px;">
                        高度 (Y): <input type="range" id="t-slice-y" min="-5" max="5" step="0.05" value="0.0" style="width:100px;"> <span id="val-slice-y">0.00</span>m<br>
                        厚度 (H): <input type="range" id="t-slice-t" min="0.05" max="2.0" step="0.05" value="0.5" style="width:100px;"> <span id="val-slice-t">0.50</span>m<br>
                        <div style="margin-top:5px; font-size:12px; color:#aaa;">(请将下命令复制到树莓派或本机终端执行)</div>
                        <input type="text" id="t-slice-cmd" readonly style="width:240px; margin-top:2px; background:#222; color:#0f0; border:1px solid #444;" value="">
                    </div>
                    <hr style="border-color:#555; margin: 10px 0;">
                    <button id="t-save" style="background:#0f0; color:#000; font-weight:bold; width:100%;">⏬ 1. 导出摆正后的GLB</button>
                    <div style="font-size:12px; margin-top:5px; color:#aaa;">(导出后覆盖原 corridor_point.glb)</div>
                `;
                document.body.appendChild(tPanel);
                makeDraggable(tPanel); // 让姿态调整面板可拖拽

                // --- 截平面逻辑 ---
                const sliceGroup = new THREE.Group();
                const slicePlane = new THREE.Mesh(
                    new THREE.PlaneGeometry(100, 100),
                    new THREE.MeshBasicMaterial({
                        color: 0x00ff00, 
                        transparent: true, 
                        opacity: 0.25, 
                        side: THREE.DoubleSide, 
                        depthWrite: false
                    })
                );
                slicePlane.rotation.x = -Math.PI / 2; // 水平放置
                sliceGroup.add(slicePlane);
                
                // 上下包围盒边界线 (表示厚度)
                const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 });
                const topEdge = new THREE.LineLoop(new THREE.EdgesGeometry(new THREE.PlaneGeometry(100, 100)), edgeMaterial);
                topEdge.rotation.x = -Math.PI / 2;
                const bottomEdge = new THREE.LineLoop(new THREE.EdgesGeometry(new THREE.PlaneGeometry(100, 100)), edgeMaterial);
                bottomEdge.rotation.x = -Math.PI / 2;
                sliceGroup.add(topEdge);
                sliceGroup.add(bottomEdge);
                
                sliceGroup.visible = false;
                scene.add(sliceGroup);

                // 更新命令和界面
                const updateSliceUI = () => {
                    const y = parseFloat(document.getElementById('t-slice-y').value);
                    const t = parseFloat(document.getElementById('t-slice-t').value);
                    document.getElementById('val-slice-y').innerText = y.toFixed(2);
                    document.getElementById('val-slice-t').innerText = t.toFixed(2);
                    
                    slicePlane.position.y = y;
                    topEdge.position.y = y + t / 2;
                    bottomEdge.position.y = y - t / 2;
                    
                    const zmin = (y - t / 2).toFixed(2);
                    const zmax = (y + t / 2).toFixed(2);
                    document.getElementById('t-slice-cmd').value = `python3 generate_map.py --glb corridor_point.glb --zmin ${zmin} --zmax ${zmax}`;
                };

                document.getElementById('t-slice-toggle').addEventListener('change', (e) => {
                    const show = e.target.checked;
                    document.getElementById('t-slice-controls').style.display = show ? 'block' : 'none';
                    sliceGroup.visible = show;
                    
                    if (show) {
                        // 动态挂载Slider边界
                        document.getElementById('t-slice-y').min = box.min.y.toFixed(2);
                        document.getElementById('t-slice-y').max = box.max.y.toFixed(2);
                        document.getElementById('t-slice-y').value = center.y.toFixed(2);
                        updateSliceUI();
                    }
                });
                document.getElementById('t-slice-y').addEventListener('input', updateSliceUI);
                document.getElementById('t-slice-t').addEventListener('input', updateSliceUI);
                // ------------------

                // 快捷键支持
                window.addEventListener('keydown', (event) => {
                    switch (event.key.toLowerCase()) {
                        case 'w': transformControl.setMode('translate'); break;
                        case 'e': transformControl.setMode('rotate'); break;
                        case 'q': transformControl.showX = !transformControl.showX; transformControl.showY = !transformControl.showY; transformControl.showZ = !transformControl.showZ; break;
                    }
                });

                document.getElementById('t-move').onclick = () => transformControl.setMode('translate');
                document.getElementById('t-rotate').onclick = () => transformControl.setMode('rotate');
                document.getElementById('t-hide').onclick = () => {
                    const isVisible = transformControl.showX;
                    transformControl.showX = !isVisible;
                    transformControl.showY = !isVisible;
                    transformControl.showZ = !isVisible;
                };
                
                document.getElementById('t-save').onclick = async () => {
                    logger.info("准备导出模型...");
                    // 暂时解除控制器关联或隐藏，避免被一起导出（其实Exporter默认是只导出传入对象）
                    const exporter = new GLTFExporter();
                    exporter.parse(
                        renderModel,
                        (gltfPluginData) => {
                            const blob = new Blob([gltfPluginData], { type: 'application/octet-stream' });
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement('a');
                            link.style.display = 'none';
                            link.href = url;
                            link.download = 'corridor_point_adjusted.glb';
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            URL.revokeObjectURL(url);
                            logger.status("导出成功，请覆盖原文件并重新生成地图");
                        },
                        (error) => {
                            logger.error("导出失败: " + error.message);
                        },
                        { binary: true }
                    );
                };
                // ==============================================
            } else {
                logger.warn('GLB 中未找到场景数据');
            }

            // 加载 POI 标记
            this.poiManager = new PoiManager({
                scene, camera, renderer,
                mapId: 'default',
                logger,
            });
            await this.poiManager.load();

        } catch (err) {
            logger.error(`GLB 加载失败: ${err.message}`);
            console.error('GLB 加载失败:', err);
        }

        // 辅助
        scene.add(new THREE.AxesHelper(2));
        scene.add(new THREE.GridHelper(10, 10));

        // 环境光
        scene.add(new THREE.AmbientLight(0x404040));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(5, 10, 7);
        scene.add(dirLight);

        // 启动渲染循环
        if (!this._animationRunning) {
            this._animationRunning = true;
            const animate = () => {
                if (!this._animationRunning) return;
                requestAnimationFrame(animate);
                if (this.controls) this.controls.update();
                if (this.poiManager) this.poiManager.update();
                renderer.render(scene, camera);
            };
            animate();
        }
    }

    /** 禁用/启用 OrbitControls 键盘快捷键 */
    _toggleControlsKeys(disable) {
        if (!this.controls) return;
        if (disable) {
            this.controls.stopListenToKeyEvents?.();
        } else {
            // 重新监听（需要 domElement，这里用 renderer 的）
            this.controls.listenToKeyEvents?.(this.renderer?.domElement);
        }
    }

    async startNavigationMode() {
        this._toggleControlsKeys(true);
        logger.info('已禁用 OrbitControls 键盘快捷键（WASD/方向键用于小车操控）');

        try {
            const { NavigationDisplay } = await import('./navigation_display.js');
            this.navigationDisplay = new NavigationDisplay({
                scene: this.scene,
                camera: this.camera,
                renderer: this.renderer,
                mapPgmUrl: '/models/nav2_map.pgm',
                mapYamlUrl: '/models/nav2_map.yaml',
                logger
            });
            logger.info('导航监控模式已就绪');
        } catch (error) {
            logger.error(`导航显示模块加载失败: ${error.message}`);
            console.error('导航显示模块加载失败:', error);
        }
    }

    async cleanupCurrentMode() {
        if (this.currentMode === 'navigation' && this.navigationDisplay) {
            try { this.navigationDisplay.dispose && this.navigationDisplay.dispose(); } catch (e) { console.warn(e); }
            this.navigationDisplay = null;
        }
        this._toggleControlsKeys(false);
    }
}

// 启动数字孪生系统
const agvTwin = new AGVDigitalTwin();
window.agvTwin = agvTwin;

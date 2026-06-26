import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
window.THREE = THREE;

import { logger } from './logger.js';

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
            const doLLM = () => {
                const text = input?.value?.trim();
                if (!text) return;
                logger.llm(text);
                setTimeout(() => {
                    logger.llmReply(`收到场景请求「${text}」，当前前方路况正常，无障碍物。`);
                }, 800);
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
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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

        // 窗口 resize
        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });

        // 加载 GLB
        const loader = new GLTFLoader();
        try {
            const gltf = await loader.loadAsync('/export.glb');
            logger.status('GLB 场景加载完成');

            const model = gltf.scene;
            scene.add(model);

            // 计算包围盒调整相机
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);

            controls.target.copy(center);
            camera.position.set(center.x, center.y + maxDim * 0.8, center.z + maxDim * 1.5);
            controls.update();

            logger.info(`场景范围: ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}m`);

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

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { logger } from './logger.js';
import './style.css';

// ─── State ──────────────────────────────────────────────────
interface RobotState { position: { x: number; y: number; angle: number }; status: string; battery: number; tcpConnected: boolean; }
let robot: RobotState = { position: { x: 0, y: 0, angle: 0 }, status: 'idle', battery: 100, tcpConnected: false };
let navPath: [number, number][] = [];
let drawObstacleMode = false;  /* toggle for obstacle painting */
let goalMarker: { x: number; y: number } | null = null;
const API = '/api';
let ws: WebSocket | null = null;

// ─── Calib state ─────────────────────────────────────────────
interface CalibResult {
  turnMsPerDeg: number;
  driveMsPerMm: number;
  turnDegPerSec: number;
  driveMmPerSec: number;
  turnCount: number;
  driveCount: number;
}
let calibResult: CalibResult = { turnMsPerDeg: 0, driveMsPerMm: 0, turnDegPerSec: 0, driveMmPerSec: 0, turnCount: 0, driveCount: 0 };

// ─── Debug state ─────────────────────────────────────────────
let debugData: any = { odom: { delta: [0,0,0,0], leftDist: 0, rightDist: 0, dHeading: 0, angleDeg: 0 }, tagFusion: {} };
let motionTrace: { t: number; e: number; y: number }[] = [];

// ─── Logger ─────────────────────────────────────────────────
const logList = document.getElementById('log-list')!;
const logContainer = document.getElementById('panel-logs')!;
logger.bind(logContainer, logList);

// ─── Tab switching ──────────────────────────────────────────
let currentTab = 'map';
document.querySelectorAll('.tab').forEach(el => {
  el.addEventListener('click', () => {
    currentTab = (el as HTMLElement).dataset.tab!;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    const panel = document.getElementById(`panel-${currentTab}`);
    if (panel) panel.classList.add('active');
    if (currentTab === '3d') {
      const w = container.clientWidth, h = container.clientHeight;
      if (w > 0 && h > 0) { camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); }
    }
    if (currentTab === 'map') {
      setTimeout(() => drawMap(), 200);
      loadCameraConfig();
      loadTags();
      loadDebugData();
      startDebugPolling();
    } else {
      stopDebugPolling();
    }
    if (currentTab === 'goods') loadGoods();
    if (currentTab === 'calib') loadCalibStatus();
    if (currentTab === 'logs') loadEvents();
    if (currentTab === 'chat') setTimeout(() => (document.getElementById('chat-input') as HTMLInputElement)?.focus(), 100);
  });
});

// ─── 3D Scene — GLB model + slice generation ───────────────
const container = document.getElementById('three-container')!;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1419);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
camera.position.set(8, 6, 8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0x404060));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// 12m×12m grid floor (每格 0.5m)
const gridHelper = new THREE.GridHelper(12, 24, 0x2a3a50, 0x1a2332);
scene.add(gridHelper);

// Robot marker
let sceneModel: THREE.Group | null = null;
const MODEL_PATH = '/models/export.glb';
new GLTFLoader().load(MODEL_PATH,
  (gltf) => {
    sceneModel = gltf.scene; scene.add(gltf.scene);
    logger.info('3D 场景加载完成');
    setTimeout(() => {
      restoreModelTransform();
      initTransformControls();
      updateModelUI();
    }, 100);
  },
  undefined,
  () => logger.warn('3D 模型未找到，显示简易场景')
);

const robotGroup = new THREE.Group();
const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.15, 0.3), new THREE.MeshStandardMaterial({ color: 0x3b82f6 }));
body.position.y = 0.075;
robotGroup.add(body);
const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.15, 8), new THREE.MeshStandardMaterial({ color: 0xef4444 }));
arrow.position.set(0, 0.15, 0.18);
robotGroup.add(arrow);
robotGroup.position.set(0, 0, 0);
scene.add(robotGroup);

// ─── Ceiling AprilTag markers in 3D scene ─────────────────────
const tagCeilingGroup = new THREE.Group();
scene.add(tagCeilingGroup);

function refreshCeilingTags() {
  while (tagCeilingGroup.children.length) {
    const c = tagCeilingGroup.children[0];
    if ((c as any).geometry) (c as any).geometry.dispose();
    if ((c as any).material) {
      if ((c as any).material.map) (c as any).material.map?.dispose();
      (c as any).material.dispose();
    }
    tagCeilingGroup.remove(c);
  }
  if (!tagMap) return;
  for (const [idStr, entry] of Object.entries(tagMap)) {
    const tag = entry as any;
    const tx = tag.x ?? 0, tz = tag.y ?? 0;
    const ty = tag.z ?? 2.8;
    const s = 0.168; // tag physical size (m)
    // Canvas texture: tag ID with border
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const cx = cv.getContext('2d')!;
    cx.fillStyle = '#1a2332'; cx.fillRect(0, 0, 64, 64);
    cx.strokeStyle = '#22c55e'; cx.lineWidth = 3; cx.strokeRect(4, 4, 56, 56);
    cx.fillStyle = '#22c55e';
    cx.font = 'bold 22px monospace'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(`#${idStr}`, 32, 32);
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, depthWrite: false });
    const geo = new THREE.PlaneGeometry(s, s);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(tx, ty, tz);
    mesh.rotation.x = -Math.PI / 2;
    tagCeilingGroup.add(mesh);
    // Vertical guide line to floor
    const lg = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(tx, ty, tz), new THREE.Vector3(tx, 0, tz)
    ]);
    const lm = new THREE.LineBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.2 });
    tagCeilingGroup.add(new THREE.Line(lg, lm));
    // Floor projection dot
    const dg = new THREE.CircleGeometry(0.04, 8);
    const dm = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
    const dot = new THREE.Mesh(dg, dm);
    dot.position.set(tx, 0.01, tz); dot.rotation.x = -Math.PI / 2;
    tagCeilingGroup.add(dot);
  }
}

// ─── Slice plane visualization ──────────────────────────────
const sliceGroup = new THREE.Group();
sliceGroup.visible = false; scene.add(sliceGroup);
const slabMat = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
const edgeMat = new THREE.MeshBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.3, wireframe: true });
const SW = 20;
const centerSlab = new THREE.Mesh(new THREE.PlaneGeometry(SW, SW), slabMat);
centerSlab.rotation.x = -Math.PI / 2; sliceGroup.add(centerSlab);
const topEdge = new THREE.Mesh(new THREE.PlaneGeometry(SW, SW), edgeMat);
topEdge.rotation.x = -Math.PI / 2; sliceGroup.add(topEdge);
const botEdge = new THREE.Mesh(new THREE.PlaneGeometry(SW, SW), edgeMat);
botEdge.rotation.x = -Math.PI / 2; sliceGroup.add(botEdge);
function updateSlicePlanes() {
  const y = parseFloat((document.getElementById('slice-y') as HTMLInputElement).value) || 0.15;
  const t = parseFloat((document.getElementById('slice-t') as HTMLInputElement).value) || 0.20;
  document.getElementById('slice-y-val')!.textContent = y.toFixed(2);
  document.getElementById('slice-t-val')!.textContent = t.toFixed(2);
  centerSlab.position.y = y; topEdge.position.y = y + t / 2; botEdge.position.y = y - t / 2;
}
(document.getElementById('slice-y') as HTMLInputElement).addEventListener('input', updateSlicePlanes);
(document.getElementById('slice-t') as HTMLInputElement).addEventListener('input', updateSlicePlanes);
(document.getElementById('t-slice-toggle') as HTMLInputElement).addEventListener('change', (e: any) => {
  const v = e.target.checked;
  document.getElementById('slice-panel')!.style.display = v ? 'block' : 'none';
  sliceGroup.visible = v;
  updateTransformControlsVisibility();
});

// ─── TransformControls (translate/rotate/scale gizmo) ────────
let transformControls: TransformControls | null = null;

function initTransformControls() {
  if (!sceneModel) return;
  if (transformControls) {
    transformControls.dispose();
    scene.remove(transformControls.getHelper());
  }
  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.attach(sceneModel);
  transformControls.setSize(0.8);
  transformControls.setMode('translate');
  transformControls.enabled = false; // hidden until slice toggle
  scene.add(transformControls.getHelper());

  // Disable OrbitControls while dragging the gizmo
  transformControls.addEventListener('mouseDown', () => { controls.enabled = false; });
  transformControls.addEventListener('mouseUp', () => { controls.enabled = true; });

  // Save transform on every change
  transformControls.addEventListener('objectChange', () => {
    updateModelUI();
    saveModelTransform();
  });

  updateTransformControlsVisibility();
  updateModelUI();
}

function updateTransformControlsVisibility() {
  if (!transformControls) return;
  const on = (document.getElementById('t-slice-toggle') as HTMLInputElement).checked;
  transformControls.enabled = on;
  transformControls.getHelper().visible = on;
}
function saveModelTransform() {
  if (!sceneModel) return;
  try {
    localStorage.setItem('modelTransform', JSON.stringify({
      px: sceneModel.position.x, py: sceneModel.position.y, pz: sceneModel.position.z,
      rx: sceneModel.rotation.x, ry: sceneModel.rotation.y, rz: sceneModel.rotation.z,
      s: sceneModel.scale.x,
    }));
  } catch {}
}
function restoreModelTransform() {
  if (!sceneModel) return;
  try {
    const raw = localStorage.getItem('modelTransform');
    if (!raw) return;
    const t = JSON.parse(raw);
    sceneModel.position.set(t.px || 0, t.py || 0, t.pz || 0);
    sceneModel.rotation.set(t.rx || 0, t.ry || 0, t.rz || 0);
    const s = t.s || 1; sceneModel.scale.set(s, s, s);
  } catch {}
}
function updateModelUI() {
  if (!sceneModel) return;
  const p = sceneModel.position, s = sceneModel.scale.x;
  (document.getElementById('model-px') as HTMLInputElement).value = p.x.toFixed(2);
  (document.getElementById('model-pz') as HTMLInputElement).value = p.z.toFixed(2);
  (document.getElementById('model-scale') as HTMLInputElement).value = s.toFixed(2);
  const box = new THREE.Box3().setFromObject(sceneModel);
  document.getElementById('model-bounds-info')!.textContent =
    `${(box.max.x - box.min.x).toFixed(1)}×${(box.max.z - box.min.z).toFixed(1)}m`;
  saveModelTransform();
}
function setTcMode(mode: 'translate' | 'rotate' | 'scale') {
  if (transformControls) transformControls.setMode(mode);
  document.querySelectorAll('#tc-translate,#tc-rotate,#tc-scale').forEach(b => (b as HTMLElement).style.background = '');
  const btn = document.getElementById(`tc-${mode}`); if (btn) btn.style.background = '#2563eb';
}
document.getElementById('tc-translate')!.addEventListener('click', () => setTcMode('translate'));
document.getElementById('tc-rotate')!.addEventListener('click', () => setTcMode('rotate'));
document.getElementById('tc-scale')!.addEventListener('click', () => setTcMode('scale'));
document.getElementById('tc-reset')!.addEventListener('click', () => {
  if (!sceneModel) return;
  sceneModel.position.set(0, 0, 0); sceneModel.rotation.set(0, 0, 0); sceneModel.scale.set(1, 1, 1);
  localStorage.removeItem('modelTransform');
  if (transformControls) {
    transformControls.detach();
    transformControls.attach(sceneModel);
  }
  updateModelUI();
});
// Precision inputs update the model on Enter/blur
['model-px','model-pz'].forEach(id => {
  document.getElementById(id)!.addEventListener('change', () => {
    if (!sceneModel) return;
    sceneModel.position.x = parseFloat((document.getElementById('model-px') as HTMLInputElement).value) || 0;
    sceneModel.position.z = parseFloat((document.getElementById('model-pz') as HTMLInputElement).value) || 0;
    updateModelUI();
  });
});
document.getElementById('model-scale')!.addEventListener('change', () => {
  if (!sceneModel) return;
  const s = parseFloat((document.getElementById('model-scale') as HTMLInputElement).value) || 1;
  sceneModel.scale.set(s, s, s);
  updateModelUI();
});
// ─── Slice → grid map generation ────────────────────────────
(document.getElementById('slice-gen') as HTMLElement).addEventListener('click', async () => {
  if (!sceneModel) { document.getElementById('slice-status')!.textContent = '❌ 模型未加载'; return; }
  const sliceY = parseFloat((document.getElementById('slice-y') as HTMLInputElement).value) || 0.15;
  const sliceT = parseFloat((document.getElementById('slice-t') as HTMLInputElement).value) || 0.20;
  const res   = parseFloat((document.getElementById('slice-res') as HTMLInputElement).value) || 0.01;
  const st = document.getElementById('slice-status')!;
  st.textContent = '扫描中...';
  await new Promise(r => setTimeout(r, 50));
  try {
    const meshes: THREE.Mesh[] = []; const ptsObj: THREE.Points[] = [];
    sceneModel.traverse((obj: any) => { if (obj.isMesh) meshes.push(obj); if (obj.isPoints) ptsObj.push(obj); });
    if (meshes.length === 0 && ptsObj.length === 0) { st.textContent = '❌ 模型无网格/点云'; return; }
    const box = new THREE.Box3().setFromObject(sceneModel);
    const oX = box.min.x, oZ = box.min.z;
    let gW = Math.ceil((box.max.x - box.min.x) / res) + 1, gH = Math.ceil((box.max.z - box.min.z) / res) + 1;
    let fRes = res;
    if (gW * gH > 512 * 512) {
      fRes = res * Math.ceil(Math.sqrt(gW * gH / 262144));
      gW = Math.ceil((box.max.x - box.min.x) / fRes) + 1; gH = Math.ceil((box.max.z - box.min.z) / fRes) + 1;
    }
    const grid = new Uint8Array(gW * gH).fill(254);
    const yMin = sliceY - sliceT / 2, yMax = sliceY + sliceT / 2;
    if (meshes.length > 0) {
      const rc = new THREE.Raycaster();
      for (let r = 0; r < gH; r++) {
        for (let c = 0; c < gW; c++) {
          rc.set(new THREE.Vector3(oX + c * fRes, 10, oZ + r * fRes), new THREE.Vector3(0, -1, 0));
          for (const hit of rc.intersectObjects(meshes)) {
            if (hit.point.y >= yMin && hit.point.y <= yMax) {
              grid[r * gW + c] = 0;
              if (c > 0) grid[r * gW + c - 1] = 0;
              if (r > 0) grid[(r-1) * gW + c] = 0;
              break;
            }
          }
        }
        if (r % 20 === 0) await new Promise(r2 => setTimeout(r2, 0));
      }
    }
    if (ptsObj.length > 0) {
      const vec = new THREE.Vector3();
      for (const pc of ptsObj) {
        pc.updateWorldMatrix(true, false);
        const pos = (pc.geometry as THREE.BufferGeometry).getAttribute('position');
        if (!pos) continue;
        for (let i = 0; i < pos.count; i++) {
          vec.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(pc.matrixWorld);
          if (vec.y < yMin || vec.y > yMax) continue;
          const c = Math.floor((vec.x - oX) / fRes), r = Math.floor((vec.z - oZ) / fRes);
          if (c >= 0 && c < gW && r >= 0 && r < gH) grid[r * gW + c] = 0;
        }
      }
      // 1px dilation
      const d = new Uint8Array(gW * gH).fill(254);
      for (let r = 0; r < gH; r++) for (let c = 0; c < gW; c++) {
        if (grid[r * gW + c] === 0) { d[r * gW + c] = 0; if (c > 0) d[r * gW + c - 1] = 0; if (r > 0) d[(r-1) * gW + c] = 0; }
      }
      grid.set(d);
    }
    st.textContent = `上传中 (${gW}×${gH})...`;
    const blob = new Blob([grid.buffer], { type: 'application/octet-stream' });
    const resp = await fetch(`${API}/map/upload`, {
      method: 'POST',
      headers: { 'X-Map-Width': String(gW), 'X-Map-Height': String(gH), 'X-Map-Res': String(fRes), 'X-Map-Ox': String(oX), 'X-Map-Oy': String(oZ) },
      body: blob,
    });
    const d = await resp.json();
    if (d.ok) {
      st.textContent = `✅ ${gW}×${gH} @ ${fRes.toFixed(3)}m`;
      LOCAL_MAP_W = gW; LOCAL_MAP_H = gH;
      LOCAL_MAP_RES = fRes; LOCAL_MAP_OX = oX; LOCAL_MAP_OY = oZ;
      localGrid = new Uint8Array(grid);
      dilatedGrid = new Uint8Array(gW * gH).fill(255);
      dilateObstacles(); drawMap();
    } else { st.textContent = `❌ ${d.error}`; }
  } catch (e: any) { st.textContent = `❌ ${e.message}`; console.warn('[slice]', e); }
});

window.addEventListener('resize', () => {
  const w = container.clientWidth, h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

function animate() {
  requestAnimationFrame(animate);
  if (currentTab !== '3d') return;
  if (renderer.domElement.width === 0 || renderer.domElement.height === 0) {
    const w = container.clientWidth, h = container.clientHeight;
    if (w > 0 && h > 0) { camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); }
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ─── WebSocket ──────────────────────────────────────────────
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = location.port === '5173' ? ':8000' : '';
  ws = new WebSocket(`${proto}//${location.hostname}${port}/ws`);
  ws.onopen = () => { sendWs({ type: 'subscribe_video' }); };
  ws.onmessage = (e) => {
    if (e.data instanceof Blob || e.data instanceof ArrayBuffer) {
      videoActive = true;
      videoFrameCount++;
      videoBytes += e.data.size || e.data.byteLength;
      lastFrameTime = performance.now();
      latestJpegBlob = e.data instanceof Blob ? e.data : new Blob([e.data]);
      document.getElementById('video-status')!.textContent =
        `📡 接收中 (${videoBytes > 1024 ? (videoBytes/1024).toFixed(0)+'KB' : videoBytes+'B'})`;
      return;
    }
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state' && msg.robot) {
        robot = msg.robot;
        updateUI();
      }
      if (msg.type === 'stm32' && msg.raw) {
        if (msg.raw.startsWith('$SNSR')) logger.info(`STM32: ${msg.raw}`);
        parseStm32Frame(msg.raw);
      }
      if (msg.type === 'voice_status' && msg.text) {
        const status = msg.status;
        const cmd = msg.cmd || {};
        if (status === 'recognized') {
          logger.llm(`🎤 ${msg.text}`);
          addChatMessage('system', `🎤 识别到: "${msg.text}"`);
          if (cmd.reply) {
            addChatMessage('ai', cmd.reply);
          }
          if (cmd.cmd && cmd.cmd !== 'unknown' && cmd.cmd !== 'none') {
            const actionMap: Record<string, string> = {
              pick: `📦 取货: ${cmd.goods || ''}`,
              goto: `📍 导航到: ${cmd.target || ''}`,
              nav: '🧭 导航',
              stop: '🛑 停止',
              return: '🏠 返回原点',
            };
            addChatMessage('system', `✅ ${actionMap[cmd.cmd] || cmd.cmd}`);
            logger.llmReply(`${actionMap[cmd.cmd] || cmd.cmd}: ${cmd.reply || ''}`);
          } else if (cmd.reply) {
            logger.llmReply(`💬 ${cmd.reply}`);
          }
        } else if (status === 'executed') {
          if (cmd.cmd && cmd.cmd !== 'unknown' && cmd.cmd !== 'none') {
            const actionMap: Record<string, string> = {
              pick: `📦 取货: ${cmd.goods || ''}`,
              goto: `📍 导航到: ${cmd.target || ''}`,
              nav: `🧭 导航: (${cmd.x?.toFixed(1) ?? '?'}, ${cmd.y?.toFixed(1) ?? '?'})`,
              stop: '🛑 停止',
              return: '🏠 返回原点',
            };
            logger.llmReply(`${actionMap[cmd.cmd] || cmd.cmd}`);
          }
          // 语音触发的 goto/nav 也在地图画线
          if ((cmd.cmd === 'goto' || cmd.cmd === 'nav') && cmd.x != null) {
            goalMarker = { x: cmd.x, y: cmd.y };
            const robotPos = robot.position;
            navPath = generatePath(robotPos.x, robotPos.y, cmd.x, cmd.y);
            navPath = [[robotPos.x, robotPos.y], ...navPath];
            drawMap();
          }
        }
      }
      if (msg.type === 'apriltag_status' && msg.status) {
        document.getElementById('video-status')!.textContent = `🏷️ ${msg.status}`;
        document.getElementById('video-status')!.style.color = msg.status.includes('✅') ? '#22c55e' : '#f59e0b';
      }
      if (msg.type === 'apriltag' && msg.tags) {
        currentTags = msg.tags;
        const valid = currentTags.filter((t: any) => !t.error);
        document.getElementById('v-tags')!.textContent =
          valid.length > 0
            ? `发现 ${valid.length} 个标签: ` + valid.map((t: any) => `#${t.id}`).join(', ')
            : '未检测到';
        if (valid.length > 0) {
          logger.info(`🏷️ AprilTag 检测: ${valid.map((t: any) => `#${t.id} @(${t.center?.[0]?.toFixed(0) ?? '?'},${t.center?.[1]?.toFixed(0) ?? '?'})`).join(', ')}`);
        }
      }
      // Calibration messages
      if (msg.type === 'calib_status') {
        const phase = msg.state || 'idle';
        document.getElementById('calib-phase')!.textContent = phase;
        document.getElementById('calib-message')!.textContent = msg.message || '';
        const badge = document.getElementById('status-calib')!;
        if (phase !== 'idle') {
          badge.style.display = 'inline';
          badge.textContent = '校准中';
          badge.className = 'badge on';
        } else {
          badge.style.display = 'none';
        }
      }
      if (msg.type === 'calib_result' && msg.result) {
        calibResult = msg.result;
        updateCalibDisplay();
      }
      // Motion trace
      if (msg.type === 'motion_trace' && msg.points) {
        motionTrace = msg.points;
        document.getElementById('dbg-trace-count')!.textContent = msg.n || msg.points.length;
      }
      // Manual move report
      if (msg.type === 'manual_move') {
        const d = msg.dist_mm || 0;
        const a = msg.yaw_delta || 0;
        document.getElementById('dbg-last-move')!.textContent = `${d.toFixed(0)}mm, Δ${a.toFixed(1)}°`;
      }
    } catch { /* ignore */ }
  };
  ws.onclose = () => setTimeout(connectWs, 3000);
  ws.onerror = () => ws?.close();
}
connectWs();

function updateUI() {
  const espEl = document.getElementById('status-esp')!;
  espEl.textContent = robot.tcpConnected ? 'ESP 已连接' : 'ESP 未连接';
  espEl.className = `badge ${robot.tcpConnected ? 'on' : 'off'}`;
  document.getElementById('status-robot')!.textContent = `位置: (${robot.position.x.toFixed(2)}, ${robot.position.y.toFixed(2)})`;
  document.getElementById('status-mode')!.textContent = `状态: ${robot.status}`;

  // 3D robot
  robotGroup.position.set(robot.position.x, 0, robot.position.y);
  robotGroup.rotation.y = Math.PI / 2 - robot.position.angle;

  if (currentTab === 'map') drawMap();
}

// ─── Parse STM32 frames ────────────────────────────────────
function parseStm32Frame(raw: string) {
  if (raw.startsWith('$SNSR')) {
    const bat = raw.match(/BAT=([\d.]+)/);
    if (bat) {
      const v = parseFloat(bat[1]);
      const pct = Math.min(100, Math.max(0, ((v - 6.0) / (8.4 - 6.0)) * 100));
      setDash('d-bat', v.toFixed(2) + 'V');
      setDash('d-bat-pct', pct.toFixed(0) + '%');
      document.getElementById('status-battery')!.textContent = `🔋 ${pct.toFixed(0)}% (${v.toFixed(2)}V)`;
    }
    const us = raw.match(/US=([\d.]+)/); if (us) setDash('d-us', us[1] + ' cm');
    const irL = raw.match(/IRL=(\d+)/); if (irL) setDash('d-irl', irL[1]);
    const irR = raw.match(/IRR=(\d+)/); if (irR) setDash('d-irr', irR[1]);
  }
  if (raw.startsWith('$ODOM')) {
    const vx = raw.match(/Vx=(-?\d+)/); if (vx) setDash('d-vx', vx[1] + ' mm/s');
    const vz = raw.match(/Vz=(-?\d+)/); if (vz) setDash('d-vz', vz[1]);
    const enc = raw.match(/ENC=([\d,]+)/); if (enc) setDash('d-enc', enc[1]);
  }
  if (raw.startsWith('$IMU')) {
    const euler = raw.match(/EULER,(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/);
    if (euler) {
      setDash('d-roll', euler[1] + '°');
      setDash('d-pitch', euler[2] + '°');
      setDash('d-yaw', euler[3] + '°');
    }
  }
}

function setDash(id: string, val: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ─── 2D Map — Local 8m×8m empty grid ──────────────────────
let LOCAL_MAP_W = 200, LOCAL_MAP_H = 200;
let LOCAL_MAP_RES = 0.02;
let LOCAL_MAP_OX = -2.0, LOCAL_MAP_OY = -2.0;
let localGrid = new Uint8Array(LOCAL_MAP_W * LOCAL_MAP_H).fill(255);
/* Dilated grid: obstacles expanded by robot radius (7.5cm ≈ 4 cells) for A* path planning */
const ROBOT_RADIUS_CELLS = 4;
let dilatedGrid = new Uint8Array(LOCAL_MAP_W * LOCAL_MAP_H).fill(255);

// dilate once at startup (grid is empty, so this is a no-op initially)
dilateObstacles();

function dilateObstacles() {
  dilatedGrid.fill(255);
  const R = ROBOT_RADIUS_CELLS;
  for (let r = 0; r < LOCAL_MAP_H; r++) {
    for (let c = 0; c < LOCAL_MAP_W; c++) {
      if (localGrid[r * LOCAL_MAP_W + c] >= 200) continue;
      for (let dr = -R; dr <= R; dr++) {
        for (let dc = -R; dc <= R; dc++) {
          if (dr * dr + dc * dc > R * R) continue;  /* circular kernel */
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= LOCAL_MAP_H || nc < 0 || nc >= LOCAL_MAP_W) continue;
          dilatedGrid[nr * LOCAL_MAP_W + nc] = 0;
        }
      }
    }
  }
}
let tagMap: any = null;

const mapCanvas = document.getElementById('map-canvas') as HTMLCanvasElement;
const mapCtx = mapCanvas.getContext('2d')!;

/* ── World → Canvas helpers (Y-flipped: world-North = screen-up) ── */
function worldToCanvasX(wx: number, cellSize: number, offsetX: number): number {
  return offsetX + (wx - LOCAL_MAP_OX) / LOCAL_MAP_RES * cellSize;
}
function worldToCanvasY(wy: number, cellSize: number, offsetY: number): number {
  /* 翻转 Y: 世界坐标 Y 越大 → 画布上越靠上（row 越小） */
  const row = (LOCAL_MAP_OY + LOCAL_MAP_H * LOCAL_MAP_RES - wy) / LOCAL_MAP_RES;
  return offsetY + row * cellSize;
}

/* ─── Grid helpers ─────────────────────────────────────────── */
function worldToGrid(wx: number, wy: number): [number, number] {
  const c = Math.floor((wx - LOCAL_MAP_OX) / LOCAL_MAP_RES);
  const r = Math.floor((wy - LOCAL_MAP_OY) / LOCAL_MAP_RES);
  return [c, r];
}
function gridToWorld(c: number, r: number): [number, number] {
  return [c * LOCAL_MAP_RES + LOCAL_MAP_OX, LOCAL_MAP_OY + r * LOCAL_MAP_RES];
}
function isBlocked(c: number, r: number): boolean {
  if (c < 0 || c >= LOCAL_MAP_W || r < 0 || r >= LOCAL_MAP_H) return true;
  return dilatedGrid[r * LOCAL_MAP_W + c] < 200;
}

/* ─── A* pathfinding on localGrid ──────────────────────────── */

function aStarSearch(sx: number, sy: number, tx: number, ty: number): [number, number][] {
  const [sc, sr] = worldToGrid(sx, sy);
  const [tc, tr] = worldToGrid(tx, ty);
  if (sc === tc && sr === tr) return [[tx, ty]];
  if (isBlocked(tc, tr)) return [[tx, ty]];  // target blocked — direct fallback

  const W = LOCAL_MAP_W;
  const open: number[] = [];
  const closed = new Uint8Array(W * LOCAL_MAP_H);
  const parent = new Int32Array(W * LOCAL_MAP_H * 2).fill(-1);
  const gCost = new Float32Array(W * LOCAL_MAP_H).fill(Infinity);

  const key = (c: number, r: number) => r * W + c;
  const push = (c: number, r: number, g: number) => {
    const k = key(c, r);
    if (closed[k]) return;
    const h = Math.abs(c - tc) + Math.abs(r - tr);  // Manhattan
    gCost[k] = g;
    open.push(k);
  };
  const pop = () => {
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      const k = open[i], r = Math.floor(k / W), c = k % W;
      const bk = open[best], br = Math.floor(bk / W), bc = bk % W;
      if (gCost[k] + Math.abs(c - tc) + Math.abs(r - tr) < gCost[bk] + Math.abs(bc - tc) + Math.abs(br - tr)) best = i;
    }
    return open.splice(best, 1)[0];
  };

  push(sc, sr, 0);
  parent[key(sc, sr) * 2] = sc;
  parent[key(sc, sr) * 2 + 1] = sr;
  const DIRS = [[0,1],[1,0],[0,-1],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
  const DIR_COST = [1,1,1,1,1.414,1.414,1.414,1.414];

  while (open.length > 0) {
    const cur = pop();
    const cr = Math.floor(cur / W), cc = cur % W;
    if (cc === tc && cr === tr) break;
    if (closed[cur]) continue;
    closed[cur] = 1;

    for (let d = 0; d < 8; d++) {
      const nc = cc + DIRS[d][0], nr = cr + DIRS[d][1];
      if (nc < 0 || nc >= W || nr < 0 || nr >= LOCAL_MAP_H) continue;
      if (isBlocked(nc, nr)) continue;
      const nk = key(nc, nr);
      const ng = gCost[cur] + DIR_COST[d];
      if (ng < gCost[nk]) {
        gCost[nk] = ng;
        parent[nk * 2] = cc;
        parent[nk * 2 + 1] = cr;
        push(nc, nr, ng);
      }
    }
  }

  // Reconstruct path
  if (parent[key(tc, tr) * 2] < 0) return [[tx, ty]];  // no path
  const path: [number, number][] = [];
  let cc = tc, cr = tr;
  while (true) {
    const [bx, by] = gridToWorld(cc, cr);
    path.push([bx, by]);
    const pk = key(cc, cr);
    const pc = parent[pk * 2], pr = parent[pk * 2 + 1];
    if (pc === cc && pr === cr) break;
    cc = pc; cr = pr;
  }
  return path.reverse();
}

/* Remove redundant waypoints: skip points where line-of-sight to the next-next point is clear */
function simplifyPath(path: [number, number][]): [number, number][] {
  if (path.length <= 2) return path;
  const result: [number, number][] = [path[0]];
  for (let i = 0; i < path.length - 1; ) {
    let farthest = i + 1;
    for (let j = i + 2; j < path.length; j++) {
      const [c1, r1] = worldToGrid(path[i][0], path[i][1]);
      const [c2, r2] = worldToGrid(path[j][0], path[j][1]);
      let clear = true;
      // Check all cells on line i→j
      let dc = Math.abs(c2 - c1), dr = -Math.abs(r2 - r1);
      let sc = c1 < c2 ? 1 : -1, sr = r1 < r2 ? 1 : -1;
      let err = dc + dr;
      for (let c = c1, r = r1; ; ) {
        if (isBlocked(c, r)) { clear = false; break; }
        if (c === c2 && r === r2) break;
        const e2 = 2 * err;
        if (e2 >= dr) { err += dr; c += sc; }
        if (e2 <= dc) { err += dc; r += sr; }
      }
      if (clear) farthest = j; else break;
    }
    result.push(path[farthest]);
    i = farthest;
  }
  return result;
}

function generatePath(fx: number, fy: number, tx: number, ty: number): [number, number][] {
  const raw = aStarSearch(fx, fy, tx, ty);
  return simplifyPath(raw);
}

async function drawMap() {
  await new Promise(r => setTimeout(r, 50));
  const parent = mapCanvas.parentElement!;
  if (parent.clientWidth === 0 || parent.clientHeight === 0) { setTimeout(() => drawMap(), 200); return; }
  mapCanvas.width = parent.clientWidth;
  mapCanvas.height = parent.clientHeight;

  const w = LOCAL_MAP_W, h = LOCAL_MAP_H;
  const cellSize = Math.min(mapCanvas.width / w, mapCanvas.height / h);
  const mapPixelW = Math.ceil(cellSize * w);
  const mapPixelH = Math.ceil(cellSize * h);
  const offsetX = Math.floor((mapCanvas.width - mapPixelW) / 2);
  const offY = Math.floor((mapCanvas.height - mapPixelH) / 2);

  mapCtx.fillStyle = '#0f1419';
  mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

  // Grid lines
  mapCtx.strokeStyle = '#1a2332';
  mapCtx.lineWidth = 0.5;
  const step = 20;
  for (let r = 0; r <= h; r += step) {
    mapCtx.beginPath(); mapCtx.moveTo(offsetX, offY + r * cellSize); mapCtx.lineTo(offsetX + mapPixelW, offY + r * cellSize); mapCtx.stroke();
  }
  for (let c = 0; c <= w; c += step) {
    mapCtx.beginPath(); mapCtx.moveTo(offsetX + c * cellSize, offY); mapCtx.lineTo(offsetX + c * cellSize, offY + mapPixelH); mapCtx.stroke();
  }

  // Dilated safety zone (robot radius ≈ 7.5cm)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (dilatedGrid[r * w + c] < 200 && localGrid[r * w + c] >= 200) {
        mapCtx.fillStyle = '#1a2020';
        mapCtx.fillRect(offsetX + c * cellSize, offY + r * cellSize, cellSize + 0.5, cellSize + 0.5);
      }
    }
  }

  // Obstacles (occupied cells)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (localGrid[r * w + c] < 200) {
        mapCtx.fillStyle = '#3a1a1a';
        mapCtx.fillRect(offsetX + c * cellSize, offY + r * cellSize, cellSize + 0.5, cellSize + 0.5);
      }
    }
  }

  // Navigation path
  if (navPath.length > 0) {
    mapCtx.strokeStyle = '#3b82f6';
    mapCtx.lineWidth = 3;
    mapCtx.beginPath();
    for (let i = 0; i < navPath.length; i++) {
      const px = worldToCanvasX(navPath[i][0], cellSize, offsetX);
      const py = worldToCanvasY(navPath[i][1], cellSize, offY);
      if (i === 0) mapCtx.moveTo(px, py);
      else mapCtx.lineTo(px, py);
    }
    mapCtx.stroke();
  }

  // Goal marker
  if (goalMarker) {
    const gpx = worldToCanvasX(goalMarker.x, cellSize, offsetX);
    const gpy = worldToCanvasY(goalMarker.y, cellSize, offY);
    mapCtx.fillStyle = '#f59e0b';
    mapCtx.beginPath(); mapCtx.arc(gpx, gpy, 8, 0, Math.PI * 2); mapCtx.fill();
    mapCtx.strokeStyle = '#f59e0b';
    mapCtx.lineWidth = 2;
    mapCtx.beginPath();
    mapCtx.moveTo(gpx - 12, gpy); mapCtx.lineTo(gpx + 12, gpy);
    mapCtx.moveTo(gpx, gpy - 12); mapCtx.lineTo(gpx, gpy + 12);
    mapCtx.stroke();
  }

  // AprilTag markers
  if (tagMap) {
    for (const [idStr, entry] of Object.entries(tagMap)) {
      const tpx = worldToCanvasX((entry as any).x, cellSize, offsetX);
      const tpy = worldToCanvasY(-(entry as any).y, cellSize, offY);
      const yaw = (entry as any).yaw || 0;
      // Ceiling tag: square outline (top-down projection)
      const hs = 7;
      mapCtx.strokeStyle = '#22c55e';
      mapCtx.lineWidth = 2;
      mapCtx.strokeRect(tpx - hs, tpy - hs, hs * 2, hs * 2);
      // Direction arrow
      mapCtx.beginPath();
      mapCtx.moveTo(tpx, tpy);
      mapCtx.lineTo(tpx + 16 * Math.cos(yaw), tpy - 16 * Math.sin(yaw));
      mapCtx.stroke();
      // Label with ceiling indicator
      mapCtx.fillStyle = '#22c55e';
      mapCtx.font = '10px sans-serif';
      mapCtx.fillText(`⬆#${idStr}`, tpx + 14, tpy + 4);
    }
  }

  // Robot
  const cx = worldToCanvasX(robot.position.x, cellSize, offsetX);
  const cy = worldToCanvasY(robot.position.y, cellSize, offY);
  mapCtx.fillStyle = '#3b82f6';
  mapCtx.beginPath();
  mapCtx.arc(cx, cy, 8, 0, Math.PI * 2);
  mapCtx.fill();

  const headingDeg = (robot.position.angle * 180 / Math.PI) % 360;
  const endX = cx + 25 * Math.cos(robot.position.angle);
  const endY = cy - 25 * Math.sin(robot.position.angle);  /* Y flipped */
  mapCtx.strokeStyle = '#ef4444';
  mapCtx.lineWidth = 3;
  mapCtx.beginPath();
  mapCtx.moveTo(cx, cy);
  mapCtx.lineTo(endX, endY);
  mapCtx.stroke();

  mapCtx.fillStyle = '#7a8ba0';
  mapCtx.font = '12px sans-serif';
  mapCtx.fillText(
    `位置: (${robot.position.x.toFixed(2)}, ${robot.position.y.toFixed(2)}) ` +
    `朝向: ${headingDeg.toFixed(1)}° ` +
    `目标: ${goalMarker ? `(${goalMarker.x.toFixed(2)},${goalMarker.y.toFixed(2)})` : '无'}`,
    10, 20);
}

/* ─── Obstacle drawing: drag on map ─────────────────────────── */
let obstaclePainting = false;
mapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
mapCanvas.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return;  /* right button only */
  const rect = mapCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  paintObstacleAt(mx, my);
  obstaclePainting = true;
});
mapCanvas.addEventListener('mousemove', (e) => {
  if (!obstaclePainting) return;
  const rect = mapCanvas.getBoundingClientRect();
  paintObstacleAt(e.clientX - rect.left, e.clientY - rect.top);
});
mapCanvas.addEventListener('mouseup', () => { obstaclePainting = false; });
mapCanvas.addEventListener('mouseleave', () => { obstaclePainting = false; });

function paintObstacleAt(mx: number, my: number) {
  const parent = mapCanvas.parentElement!;
  const cellSize = Math.min(mapCanvas.width / LOCAL_MAP_W, mapCanvas.height / LOCAL_MAP_H);
  const mpw = Math.ceil(cellSize * LOCAL_MAP_W), mph = Math.ceil(cellSize * LOCAL_MAP_H);
  const ox = Math.floor((mapCanvas.width - mpw) / 2), oy = Math.floor((mapCanvas.height - mph) / 2);
  const rx = mx - ox, ry = my - oy;
  if (rx < 0 || rx >= mpw || ry < 0 || ry >= mph) return;
  const c = Math.floor(rx / cellSize), r = Math.floor(ry / cellSize);
  if (c < 0 || c >= LOCAL_MAP_W || r < 0 || r >= LOCAL_MAP_H) return;
  localGrid[r * LOCAL_MAP_W + c] = 0;  /* occupied */
  dilateObstacles();
  drawMap();
}

// ─── Map import from image ───────────────────────────────────
document.getElementById('map-import-btn')!.addEventListener('click', () => {
  (document.getElementById('map-import-file') as HTMLInputElement).click();
});
document.getElementById('map-clear-btn')!.addEventListener('click', () => {
  localGrid.fill(255);
  dilateObstacles();
  drawMap();
  setText('map-import-status', '障碍已清除');
});
document.getElementById('map-import-file')!.addEventListener('change', (e: any) => {
  const file = e.target?.files?.[0];
  if (!file) return;

  // PGM format: parse binary directly
  if (file.name.toLowerCase().endsWith('.pgm')) {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = new Uint8Array(reader.result as ArrayBuffer);
      // Find header lines: P5, width height, maxval
      let pos = 0;
      while (buf[pos] !== 0x0A) pos++; pos++; // skip "P5" or "P2"
      while (buf[pos] === 0x23) { while (buf[pos] !== 0x0A) pos++; pos++; } // skip comments
      let dimEnd = pos; while (buf[dimEnd] !== 0x0A) dimEnd++;
      const dims = new TextDecoder().decode(buf.slice(pos, dimEnd)).trim().split(/\s+/);
      const pw = parseInt(dims[0]), ph = parseInt(dims[1]);
      pos = dimEnd + 1;
      while (buf[pos] === 0x23) { while (buf[pos] !== 0x0A) pos++; pos++; }
      let valEnd = pos; while (buf[valEnd] !== 0x0A) valEnd++;
      const maxVal = parseInt(new TextDecoder().decode(buf.slice(pos, valEnd)).trim());
      pos = valEnd + 1;

      const pixels = buf.slice(pos); // raw pixel data
      setText('map-import-status', `PGM: ${pw}×${ph}, max=${maxVal}`);
      // Store for "应用"
      (window as any)._importedPgm = { pixels, w: pw, h: ph, maxVal };
      (window as any)._importedMapImg = null;
    };
    reader.readAsArrayBuffer(file);
    return;
  }

  // Regular image (PNG/JPG)
  const img = new Image();
  img.onload = () => {
    (window as any)._importedMapImg = img;
    (window as any)._importedPgm = null;
    setText('map-import-status', `已加载: ${file.name} (${img.width}×${img.height}px)`);
  };
  img.src = URL.createObjectURL(file);
});
document.getElementById('map-apply-btn')!.addEventListener('click', () => {
  const pgm = (window as any)._importedPgm;
  const img = (window as any)._importedMapImg;
  if (!pgm && !img) { setText('map-import-status', '请先选择图片或PGM文件'); return; }

  const wM = parseFloat((document.getElementById('map-scale-w') as HTMLInputElement).value) || 4.0;
  const hM = parseFloat((document.getElementById('map-scale-h') as HTMLInputElement).value) || 4.0;
  const ox = parseFloat((document.getElementById('map-origin-x') as HTMLInputElement).value) || -2.0;
  const oy = parseFloat((document.getElementById('map-origin-y') as HTMLInputElement).value) || -2.0;
  LOCAL_MAP_OX = ox; LOCAL_MAP_OY = oy;
  LOCAL_MAP_RES = (wM + hM) / (LOCAL_MAP_W + LOCAL_MAP_H);

  let occupied = 0;

  if (pgm) {
    // PGM pixel data: 0=black(occupied), maxVal=white(free)
    const scaleX = pgm.w / LOCAL_MAP_W, scaleY = pgm.h / LOCAL_MAP_H;
    for (let r = 0; r < LOCAL_MAP_H; r++) {
      for (let c = 0; c < LOCAL_MAP_W; c++) {
        const pc = Math.round(c * scaleX), pr = Math.round(r * scaleY);
        const v = pgm.pixels[pr * pgm.w + pc];
        const norm = v / pgm.maxVal;
        localGrid[r * LOCAL_MAP_W + c] = (norm > 0.5) ? 255 : 0;
        if (norm <= 0.5) occupied++;
      }
    }
    setText('map-import-status', `✅ PGM ${pgm.w}×${pgm.h} → ${LOCAL_MAP_W}×${LOCAL_MAP_H}, ${occupied} 障碍像素`);
  } else {
    // Regular image
    const offscreen = document.createElement('canvas');
    offscreen.width = LOCAL_MAP_W; offscreen.height = LOCAL_MAP_H;
    const ctx = offscreen.getContext('2d')!;
    ctx.drawImage(img, 0, 0, LOCAL_MAP_W, LOCAL_MAP_H);
    const data = ctx.getImageData(0, 0, LOCAL_MAP_W, LOCAL_MAP_H);
    for (let r = 0; r < LOCAL_MAP_H; r++) {
      for (let c = 0; c < LOCAL_MAP_W; c++) {
        const i = (r * LOCAL_MAP_W + c) * 4;
        const bright = data.data[i] * 0.299 + data.data[i+1] * 0.587 + data.data[i+2] * 0.114;
        localGrid[r * LOCAL_MAP_W + c] = (bright < 128) ? 0 : 255;
        if (bright < 128) occupied++;
      }
    }
    setText('map-import-status', `✅ ${img.width}×${img.height} → ${LOCAL_MAP_W}×${LOCAL_MAP_H}, ${occupied} 障碍像素`);
  }

  dilateObstacles();
  drawMap();
});

// ─── Map click: obstacle-aware navigation ────────────────────
mapCanvas.addEventListener('click', async (e) => {
  if (e.button !== 0) return;
  const parent = mapCanvas.parentElement!;
  const w = LOCAL_MAP_W, h = LOCAL_MAP_H;
  const cellSize = Math.min(mapCanvas.width / w, mapCanvas.height / h);
  const mapPixelW = Math.ceil(cellSize * w);
  const mapPixelH = Math.ceil(cellSize * h);
  const offsetX = Math.floor((mapCanvas.width - mapPixelW) / 2);
  const offsetY = Math.floor((mapCanvas.height - mapPixelH) / 2);

  const rect = mapCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const rx = mx - offsetX;
  const ry = my - offsetY;
  if (rx < 0 || rx >= mapPixelW || ry < 0 || ry >= mapPixelH) return;

  const col = Math.floor(rx / cellSize);
  const row = Math.floor(ry / cellSize);
  if (col < 0 || col >= w || row < 0 || row >= h) return;

  const wx = col * LOCAL_MAP_RES + LOCAL_MAP_OX;
  const wy = LOCAL_MAP_OY + (LOCAL_MAP_H - 1 - row) * LOCAL_MAP_RES;
  goalMarker = { x: wx, y: wy };

  // Generate obstacle-aware path (prepend robot position for display)
  const robotPos = robot.position;
  navPath = generatePath(robotPos.x, robotPos.y, wx, wy);
  const waypoints = navPath.map(([px, py]) => ({ x: px, y: py }));
  logger.info(`导航 → (${wx.toFixed(2)},${wy.toFixed(2)}) — ${waypoints.length} 段`);
  // Prepend start point so the path line is always visible
  navPath = [[robotPos.x, robotPos.y], ...navPath];

  drawMap();
  try {
    const res = await fetch(`${API}/tag-nav/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waypoints }),
    });
    const data = await res.json();
    if (data.ok) logger.status(`导航已启动 (${waypoints.length} 段)`);
    else { logger.error(`导航失败: ${data.error || '未知错误'}`); goalMarker = null; navPath = []; }
  } catch (e) {
    logger.error(`请求失败: ${(e as Error).message}`);
    goalMarker = null; navPath = [];
  }
  drawMap();
});

// ─── Chat panel ──────────────────────────────────────────────
const chatMessagesContainer = document.getElementById('chat-messages')!;

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function addChatMessage(type: 'user' | 'ai' | 'system', content: string) {
  const div = document.createElement('div');
  div.className = `chat-msg chat-msg-${type}`;
  if (type === 'user') {
    div.innerHTML = `<div class="chat-msg-label">你</div><div class="chat-msg-bubble">${escapeHtml(content)}</div>`;
  } else if (type === 'ai') {
    div.innerHTML = `<div class="chat-msg-label">小E</div><div class="chat-msg-bubble">${escapeHtml(content)}</div>`;
  } else {
    div.innerHTML = `<div class="chat-msg-system">${escapeHtml(content)}</div>`;
  }
  chatMessagesContainer.appendChild(div);
  while (chatMessagesContainer.children.length > 200) {
    chatMessagesContainer.removeChild(chatMessagesContainer.firstChild!);
  }
  chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
}

// Sync TTS volume between chat and control panel
document.getElementById('chat-tts-volume')!.addEventListener('input', function () {
  (document.getElementById('tts-volume') as HTMLInputElement).value = this.value;
  document.getElementById('chat-tts-vol-val')!.textContent = this.value + '%';
  document.getElementById('tts-vol-val')!.textContent = this.value + '%';
});
document.getElementById('tts-volume')!.addEventListener('input', function () {
  (document.getElementById('chat-tts-volume') as HTMLInputElement).value = this.value;
  document.getElementById('chat-tts-vol-val')!.textContent = this.value + '%';
  document.getElementById('tts-vol-val')!.textContent = this.value + '%';
});

// Chat send handler
document.getElementById('chat-send')!.addEventListener('click', async () => {
  const input = document.getElementById('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addChatMessage('user', text);
  logger.llm(text);

  const ttsEnabled = (document.getElementById('chat-tts-toggle') as HTMLInputElement).checked;

  try {
    // Show typing indicator
    const typingDiv = document.createElement('div');
    typingDiv.className = 'chat-msg chat-msg-ai';
    typingDiv.innerHTML = `<div class="chat-msg-label">小E</div><div class="chat-msg-bubble" style="color:#5a6a80">思考中<span class="chat-dots">...</span></div>`;
    chatMessagesContainer.appendChild(typingDiv);
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;

    const resp = await fetch(`${API}/llm/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, session_id: 'default' }),
    });
    const data = await resp.json();

    // Remove typing indicator
    typingDiv.remove();

    const reply = data.reply || '(没有回复)';
    addChatMessage('ai', reply);
    logger.llmReply(reply);

    // TTS: 和手动"语音测试"完全相同的调用方式
    if (ttsEnabled && reply) {
      const vol = parseInt((document.getElementById('chat-tts-volume') as HTMLInputElement).value) / 100;
      fetch(`${API}/tts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: reply, volume: vol }),
      }).then(r => r.json()).then(d => {
        if (d.ok) addChatMessage('system', '🔊 已播报');
        else console.warn('[chat] TTS fail:', d.note);
      }).catch(e => console.warn('[chat] TTS error:', e));
    }

    if (data.executed) {
      const actionStr = data.cmd?.cmd === 'pick' ? `📦 取货: ${data.cmd.goods}` :
                        data.cmd?.cmd === 'goto' ? `📍 导航到: ${data.cmd.target}` :
                        data.cmd?.cmd === 'nav' ? `🧭 导航到 (${data.cmd.x},${data.cmd.y})` :
                        data.cmd?.cmd === 'stop' ? '🛑 停止' :
                        data.cmd?.cmd === 'return' ? '🏠 返回原点' : '';
      if (actionStr) {
        addChatMessage('system', `✅ ${actionStr}`);
        logger.status(`✅ ${actionStr}`);
      }
      // 有坐标 => 在地图画导航线
      if ((data.cmd?.cmd === 'goto' || data.cmd?.cmd === 'nav') && data.cmd?.x != null) {
        goalMarker = { x: data.cmd.x, y: data.cmd.y };
        const robotPos = robot.position;
        navPath = generatePath(robotPos.x, robotPos.y, data.cmd.x, data.cmd.y);
        navPath = [[robotPos.x, robotPos.y], ...navPath];
        drawMap();
      }
    }
  } catch (e) {
    addChatMessage('ai', `嗯？发送失败了：${(e as Error).message}，再试一次吧～`);
    logger.llmReply(`请求失败: ${(e as Error).message}`);
  }
});

(document.getElementById('chat-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') (document.getElementById('chat-send') as HTMLButtonElement).click();
});

// Chat clear
document.getElementById('chat-clear')!.addEventListener('click', () => {
  chatMessagesContainer.innerHTML = '<div class="chat-msg-system">💬 对话已清空</div>';
});

// ─── TTS test ────────────────────────────────────────────────
document.getElementById('tts-send')!.addEventListener('click', async () => {
  const input = document.getElementById('tts-text') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) { document.getElementById('tts-status')!.textContent = '请输入文字'; return; }
  const vol = parseInt((document.getElementById('tts-volume') as HTMLInputElement).value) / 100;
  document.getElementById('tts-status')!.textContent = '生成语音中...';
  try {
    const r = await fetch(`${API}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, volume: vol }),
    });
    const d = await r.json();
    document.getElementById('tts-status')!.textContent = d.ok ? `✅ 已发送: "${text}"` : `❌ ${d.error || '失败'}`;
  } catch (e) {
    document.getElementById('tts-status')!.textContent = `❌ 请求失败: ${(e as Error).message}`;
  }
});
(document.getElementById('tts-text') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') (document.getElementById('tts-send') as HTMLButtonElement).click();
});
// Volume slider
document.getElementById('tts-volume')!.addEventListener('input', function () {
  document.getElementById('tts-vol-val')!.textContent = this.value + '%';
});

// ─── Log clear ───────────────────────────────────────────────
document.getElementById('log-clear')!.addEventListener('click', () => {
  logList.innerHTML = '';
  logger.info('日志已清空');
});

// ─── POI ─────────────────────────────────────────────────────
async function loadPoi() {
  const r = await fetch(`${API}/poi`);
  const pois = await r.json() as any[];
  const list = document.getElementById('poi-list')!;
  list.innerHTML = pois.map((p: any) => `📍 <b>${p.name}</b> (${p.coord_x}, ${p.coord_y}) <button onclick="deletePoi('${p.name}')">×</button>`).join('<br>');
}
document.getElementById('poi-add')!.addEventListener('click', async () => {
  const name = (document.getElementById('poi-name') as HTMLInputElement).value;
  const x = parseFloat((document.getElementById('poi-x') as HTMLInputElement).value);
  const y = parseFloat((document.getElementById('poi-y') as HTMLInputElement).value);
  if (!name) return;
  await fetch(`${API}/poi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, coord_x: x, coord_y: y }) });
  loadPoi();
});
(window as any).deletePoi = async (name: string) => {
  await fetch(`${API}/poi/${name}`, { method: 'DELETE' });
  loadPoi();
};

// ─── Events engine ──────────────────────────────────────────
async function loadEvents() {
  try {
    const r = await fetch(`${API}/events`);
    const events = await r.json() as any[];
    const list = document.getElementById('events-list')!;
    if (events.length === 0) {
      list.innerHTML = '<div style="color:#7a8ba0">无事件</div>';
      return;
    }
    list.innerHTML = events.slice(0, 50).map((e: any) =>
      `<div>[${e.ts?.slice(11, 19) || ''}] ${e.type || e.event || 'event'}: ${e.message || JSON.stringify(e).slice(0, 80)}</div>`
    ).join('');
  } catch (e) { /* ignore */ }
}
document.getElementById('events-refresh')!.addEventListener('click', loadEvents);
document.getElementById('events-add')!.addEventListener('click', async () => {
  const msg = prompt('输入事件内容:');
  if (!msg) return;
  try {
    await fetch(`${API}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'manual', message: msg }),
    });
    loadEvents();
  } catch (e) { /* ignore */ }
});

// ─── WebSocket command ──────────────────────────────────────
function sendWs(obj: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ─── Motor control via WebSocket ────
function sendMotorWs(dir: string) {
  const speed = (document.getElementById('speed-slider') as HTMLInputElement).value;
  // STM32 frame format: $DIR,SPIN,_,_,_,_,SPEED,_,_,_#
  const frames: Record<string, string> = {
    fwd: `$1,0,0,0,0,0,${speed},0,0,0#`, back: `$2,0,0,0,0,0,${speed},0,0,0#`,
    left: `$3,0,0,0,0,0,${speed},0,0,0#`, right: `$4,0,0,0,0,0,${speed},0,0,0#`,
    spinL: `$0,1,0,0,0,0,${speed},0,0,0#`, spinR: `$0,2,0,0,0,0,${speed},0,0,0#`,
    stop: `$0,0,0,0,0,0,0,0,0,0#`,
  };
  const frame = frames[dir];
  if (!frame) return;
  sendWs({ type: 'motor', frame });
}

function sendStopRedundant() {
  sendWs({ type: 'motor', frame: '$0,0,0,0,0,0,0,0,0,0#' });
  setTimeout(() => sendWs({ type: 'motor', frame: '$0,0,0,0,0,0,0,0,0,0#' }), 30);
  setTimeout(() => sendWs({ type: 'motor', frame: '$0,0,0,0,0,0,0,0,0,0#' }), 80);
}

// ─── Manual Control ────────────────────────────────────────
document.querySelectorAll('.ctrl-btn').forEach(el => {
  const dir = (el as HTMLElement).dataset.dir!;
  el.addEventListener('mousedown', () => sendMotorWs(dir));
  el.addEventListener('mouseup', () => sendStopRedundant());
  el.addEventListener('mouseleave', () => sendStopRedundant());
  el.addEventListener('touchstart', (e) => { e.preventDefault(); sendMotorWs(dir); });
  el.addEventListener('touchend', (e) => { e.preventDefault(); sendStopRedundant(); });
});
document.querySelectorAll('.ctrl-btn-sm').forEach(el => {
  el.addEventListener('click', () => sendMotorWs((el as HTMLElement).dataset.dir!));
});
document.getElementById('send-raw')!.addEventListener('click', async () => {
  const frame = (document.getElementById('raw-frame') as HTMLInputElement).value.trim();
  if (!frame) return;
  const r = await fetch(`${API}/motor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frame }) });
  const d = await r.json();
  document.getElementById('ctrl-status')!.textContent = d.ok ? `TX: ${frame}` : 'ERR';
});

// ─── Emergency / cancel controls ────────────────────────────
document.getElementById('btn-emergency-stop')!.addEventListener('click', async () => {
  try {
    await fetch(`${API}/stop`, { method: 'POST' });
    sendStopRedundant();
    document.getElementById('ctrl-status')!.textContent = '🛑 紧急停止';
    logger.warn('🛑 紧急停止');
  } catch (e) {
    document.getElementById('ctrl-status')!.textContent = '停止失败: ' + (e as Error).message;
  }
});
document.getElementById('btn-cancel-nav')!.addEventListener('click', async () => {
  try {
    const r = await fetch(`${API}/tag-nav/cancel`, { method: 'POST' });
    const d = await r.json();
    goalMarker = null;
    drawMap();
    document.getElementById('ctrl-status')!.textContent = '导航已取消';
    logger.info('✖ 导航已取消');
  } catch (e) {
    document.getElementById('ctrl-status')!.textContent = '取消失败: ' + (e as Error).message;
  }
});
// ─── Coordinate navigation (direct) ─────────────────────────
function getNavXY(): { x: number; y: number } | null {
  const x = parseFloat((document.getElementById('nav-x') as HTMLInputElement).value);
  const y = parseFloat((document.getElementById('nav-y') as HTMLInputElement).value);
  if (isNaN(x) || isNaN(y)) {
    document.getElementById('nav-plan-info')!.textContent = '请输入有效的 X 和 Y';
    return null;
  }
  return { x, y };
}

document.getElementById('btn-nav-direct')!.addEventListener('click', async () => {
  const p = getNavXY();
  if (!p) return;
  try {
    const r = await fetch(`${API}/nav`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: p.x, y: p.y }),
    });
    const d = await r.json();
    if (d.ok) {
      goalMarker = { x: p.x, y: p.y };
      drawMap();
      logger.info(`🧭 直接导航 → (${p.x}, ${p.y})`);
      document.getElementById('nav-plan-info')!.textContent = `已发送: (${p.x}, ${p.y})`;
    } else {
      document.getElementById('nav-plan-info')!.textContent = `失败: ${d.error || ''}`;
    }
  } catch (e) {
    document.getElementById('nav-plan-info')!.textContent = '请求失败: ' + (e as Error).message;
  }
});

// ─── Patrol mode ────────────────────────────────────────────
function parsePatrolPoints(): [number, number][] | null {
  const text = (document.getElementById('patrol-points') as HTMLTextAreaElement).value;
  const pts: [number, number][] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/[,\s]+/).map(Number);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      pts.push([parts[0], parts[1]]);
    }
  }
  if (pts.length === 0) {
    document.getElementById('patrol-status')!.textContent = '请输入至少一个点 (x,y)';
    return null;
  }
  return pts;
}

document.getElementById('btn-patrol-start')!.addEventListener('click', async () => {
  const pts = parsePatrolPoints();
  if (!pts) return;
  try {
    const r = await fetch(`${API}/patrol/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: pts }),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('patrol-status')!.textContent = `巡逻启动: ${pts.length} 个点`;
      logger.info(`🔄 巡逻启动: ${pts.length} 个点`);
    } else {
      document.getElementById('patrol-status')!.textContent = `失败: ${d.error || ''}`;
    }
  } catch (e) {
    document.getElementById('patrol-status')!.textContent = '请求失败: ' + (e as Error).message;
  }
});

document.getElementById('btn-patrol-arrive')!.addEventListener('click', async () => {
  try {
    const r = await fetch(`${API}/patrol/arrive`, { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('patrol-status')!.textContent = `到达检查点 #${d.checkpoint}`;
    }
  } catch (e) {
    document.getElementById('patrol-status')!.textContent = '请求失败: ' + (e as Error).message;
  }
});


// 🛤️ 固定路径
document.querySelectorAll(".path-btn").forEach(el => {
  el.addEventListener("click", async () => {
    const n = el.getAttribute("data-path");
    document.getElementById("path-status")!.textContent = "路径" + n + " 启动中...";
    try {
      const r = await fetch(`${API}/path/${n}`, { method: "POST" });
      const d = await r.json();
      document.getElementById("path-status")!.textContent = d.ok ? "✅ 路径" + n + " 已启动" : "❌ 失败";
    } catch(e) {
      document.getElementById("path-status")!.textContent = "❌ 请求失败";
    }
  });
});
document.getElementById("btn-path-wait")!.addEventListener("click", async () => {
  try {
    const r = await fetch(`${API}/path/0`, { method: "POST" });
    const d = await r.json();
    document.getElementById("path-status")!.textContent = d.ok ? "⏸ 已暂停" : "❌ 失败";
  } catch(e) {
    document.getElementById("path-status")!.textContent = "❌ 请求失败";
  }
});
document.getElementById("btn-path-return")!.addEventListener("click", async () => {
  try {
    const r = await fetch(`${API}/path/0`, { method: "POST" });
    const d = await r.json();
    document.getElementById("path-status")!.textContent = d.ok ? "↩ 返程中" : "❌ 失败";
  } catch(e) {
    document.getElementById("path-status")!.textContent = "❌ 请求失败";
  }
});

document.getElementById("btn-path-stop")!.addEventListener("click", async () => {
  try {
    await fetch(`${API}/stop`, { method: "POST" });
    document.getElementById("path-status")!.textContent = "🛑 已停止";
  } catch(e) {
    document.getElementById("path-status")!.textContent = "❌ 请求失败";
  }
});

// ─── Pose setting ──────────────────────────────────────────
document.getElementById('pose-set')!.addEventListener('click', async () => {
  const x = parseFloat((document.getElementById('pose-x') as HTMLInputElement).value) || 0;
  const y = parseFloat((document.getElementById('pose-y') as HTMLInputElement).value) || 0;
  const a = parseFloat((document.getElementById('pose-a') as HTMLInputElement).value) || 0;
  try {
    const r = await fetch(`${API}/robot/position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y, angle: a * Math.PI / 180 }),
    });
    const d = await r.json();
    if (d.ok) {
      logger.info(`位姿设置: (${x}, ${y}) @ ${a}°`);
    } else {
      logger.error(`设置失败: ${d.error}`);
    }
  } catch (e) {
    logger.error(`请求失败: ${(e as Error).message}`);
  }
});

// ─── Keyboard navigation ───────────────────────────────────
const pressedMovementKeys = new Set<string>();
const keyToDir: Record<string, string> = {
  w: 'fwd', ArrowUp: 'fwd', s: 'back', ArrowDown: 'back',
  a: 'left', ArrowLeft: 'left', d: 'right', ArrowRight: 'right',
  q: 'spinL', e: 'spinR',
  ' ': 'stop',
};
let kbInterval: number | null = null;
const KB_INTERVAL_MS = 100;

function getCurrentDir(): string | null {
  for (const k of [...pressedMovementKeys].reverse()) {
    const d = keyToDir[k];
    if (d && d !== 'stop') return d;
  }
  return null;
}
function kbStop() {
  if (kbInterval !== null) { clearInterval(kbInterval); kbInterval = null; }
  sendStopRedundant();
}

document.addEventListener('keydown', e => {
  const dir = keyToDir[e.key];
  if (!dir) return;
  e.preventDefault();
  if (pressedMovementKeys.has(e.key)) return;
  pressedMovementKeys.add(e.key);
  if (e.key === ' ') { sendStopRedundant(); return; }
  if (!kbInterval) {
    sendMotorWs(dir);
    kbInterval = window.setInterval(() => {
      const d = getCurrentDir();
      if (d) sendMotorWs(d);
    }, KB_INTERVAL_MS);
  }
});
document.addEventListener('keyup', e => {
  if (!pressedMovementKeys.has(e.key)) return;
  pressedMovementKeys.delete(e.key);
  if (e.key === ' ') return;
  if (!getCurrentDir()) kbStop();
});
(document.getElementById('speed-slider') as HTMLInputElement).addEventListener('input', function () {
  document.getElementById('spd-val')!.textContent = this.value;
});

// ─── AprilTag Tags Management (integrated into map sidebar) ──
async function loadTags() {
  try {
    const r = await fetch(`${API}/tags`);
    tagMap = await r.json();
    const list = document.getElementById('tags-list')!;
    const entries = Object.entries(tagMap);
    list.innerHTML = entries.map(([id, entry]: [string, any]) =>
      `<div class="tag-chip" data-tag-id="${id}" title="(${entry.x?.toFixed(2) ?? 0}, ${(-(entry.y ?? 0)).toFixed(2)}) ${entry.desc || ''}">#${id}</div>`
    ).join('') || '<div style="font-size:11px;color:#7a8ba0">无标签</div>';
    list.querySelectorAll('.tag-chip').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-tag-id');
        if (id) selectTag(parseInt(id));
      });
    });
    if (currentTab === 'map') drawMap();
    refreshCeilingTags();
  } catch (e) {
    document.getElementById('tags-status')!.textContent = '加载失败: ' + (e as Error).message;
  }
}

function selectTag(id: number) {
  (document.getElementById('tag-id') as HTMLInputElement).value = id.toString();
  const entry = tagMap?.[id];
  if (entry) {
    (document.getElementById('tag-x') as HTMLInputElement).value = entry.x ?? 0;
    (document.getElementById('tag-y') as HTMLInputElement).value = (-(entry.y ?? 0)).toFixed(2);  // negate: UI Y ↑ = map ↑
    (document.getElementById('tag-z') as HTMLInputElement).value = (entry.z ?? 2.8).toFixed(1);
    (document.getElementById('tag-yaw') as HTMLInputElement).value = ((entry.yaw ?? 0) * 180 / Math.PI).toFixed(1);
    (document.getElementById('tag-desc') as HTMLInputElement).value = entry.desc ?? '';
  }
}

document.getElementById('tags-refresh')!.addEventListener('click', loadTags);
document.getElementById('tag-add')!.addEventListener('click', () => {
  (document.getElementById('tag-id') as HTMLInputElement).value = '';
  (document.getElementById('tag-x') as HTMLInputElement).value = '0';
  (document.getElementById('tag-y') as HTMLInputElement).value = '0';
  (document.getElementById('tag-z') as HTMLInputElement).value = '2.8';
  (document.getElementById('tag-yaw') as HTMLInputElement).value = '0';
  (document.getElementById('tag-desc') as HTMLInputElement).value = '';
  document.getElementById('tags-status')!.textContent = '请输入新标签参数并点击保存';
});
document.getElementById('tag-save')!.addEventListener('click', async () => {
  const id = parseInt((document.getElementById('tag-id') as HTMLInputElement).value);
  const x = parseFloat((document.getElementById('tag-x') as HTMLInputElement).value) || 0;
  const y = -(parseFloat((document.getElementById('tag-y') as HTMLInputElement).value) || 0);  // negate: UI Y ↑ = store -Z
  const z = parseFloat((document.getElementById('tag-z') as HTMLInputElement).value) ?? 2.8;
  const yaw = parseFloat((document.getElementById('tag-yaw') as HTMLInputElement).value) || 0;
  const desc = (document.getElementById('tag-desc') as HTMLInputElement).value || `tag-${id}`;
  if (isNaN(id) || id < 0) {
    document.getElementById('tags-status')!.textContent = '请输入有效的标签 ID';
    return;
  }
  try {
    const r = await fetch(`${API}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, x, y, z, yaw: yaw * Math.PI / 180, desc }),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('tags-status')!.textContent = `标签 #${id} 已保存`;
      loadTags();
      drawMap();
    } else {
      document.getElementById('tags-status')!.textContent = `保存失败: ${d.error}`;
    }
  } catch (e) {
    document.getElementById('tags-status')!.textContent = '请求失败: ' + (e as Error).message;
  }
});
document.getElementById('tag-delete')!.addEventListener('click', async () => {
  const id = parseInt((document.getElementById('tag-id') as HTMLInputElement).value);
  if (isNaN(id)) return;
  try {
    const r = await fetch(`${API}/tags/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('tags-status')!.textContent = `标签 #${id} 已删除`;
      loadTags();
      drawMap();
    }
  } catch (e) {
    document.getElementById('tags-status')!.textContent = '删除失败: ' + (e as Error).message;
  }
});

// ─── Camera Config ──────────────────────────────────────────
async function loadCameraConfig() {
  try {
    const r = await fetch(`${API}/camera`);
    const cfg = await r.json();
    (document.getElementById('cam-fx') as HTMLInputElement).value = cfg.fx || 900;
    (document.getElementById('cam-fy') as HTMLInputElement).value = cfg.fy || 900;
    (document.getElementById('cam-cx') as HTMLInputElement).value = cfg.cx || 640;
    (document.getElementById('cam-cy') as HTMLInputElement).value = cfg.cy || 360;
    (document.getElementById('cam-tag-size') as HTMLInputElement).value = cfg.tag_size_m || 0.168;
  } catch (e) {
    document.getElementById('cam-status')!.textContent = '加载失败，使用默认值';
  }
}
document.getElementById('cam-load')!.addEventListener('click', loadCameraConfig);
document.getElementById('cam-save')!.addEventListener('click', async () => {
  const cfg = {
    fx: parseFloat((document.getElementById('cam-fx') as HTMLInputElement).value) || 900,
    fy: parseFloat((document.getElementById('cam-fy') as HTMLInputElement).value) || 900,
    cx: parseFloat((document.getElementById('cam-cx') as HTMLInputElement).value) || 640,
    cy: parseFloat((document.getElementById('cam-cy') as HTMLInputElement).value) || 360,
    tag_size_m: parseFloat((document.getElementById('cam-tag-size') as HTMLInputElement).value) || 0.168,
  };
  try {
    const r = await fetch(`${API}/camera`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('cam-status')!.textContent = '配置已保存';
    } else {
      document.getElementById('cam-status')!.textContent = '保存失败';
    }
  } catch (e) {
    document.getElementById('cam-status')!.textContent = '请求失败: ' + (e as Error).message;
  }
});
document.getElementById('cam-reset')!.addEventListener('click', async () => {
  // 重新从 camera.json 加载已持久化的值（放弃未保存的编辑）
  await loadCameraConfig();
  document.getElementById('cam-status')!.textContent = '已从文件重新加载';
});

// ─── Motion Calibration ─────────────────────────────────────
async function loadCalibStatus() {
  try {
    const r = await fetch(`${API}/calib/status`);
    const d = await r.json();
    if (d.result) {
      calibResult = d.result;
      updateCalibDisplay();
    }
    document.getElementById('calib-phase')!.textContent = d.phase || 'idle';
  } catch (e) { /* ignore */ }
}

function updateCalibDisplay() {
  if (calibResult.turnDegPerSec > 0) {
    document.getElementById('calib-turn-speed')!.textContent = calibResult.turnDegPerSec.toFixed(1) + ' °/s';
    document.getElementById('calib-turn-ms')!.textContent = calibResult.turnMsPerDeg.toFixed(1);
    document.getElementById('calib-turn-count')!.textContent = calibResult.turnCount.toString();
  }
  if (calibResult.driveMmPerSec > 0) {
    document.getElementById('calib-drive-speed')!.textContent = calibResult.driveMmPerSec.toFixed(0) + ' mm/s';
    document.getElementById('calib-drive-ms')!.textContent = calibResult.driveMsPerMm.toFixed(2);
    document.getElementById('calib-drive-count')!.textContent = calibResult.driveCount.toString();
  }
}

document.getElementById('calib-turn')!.addEventListener('click', async () => {
  try {
    const r = await fetch(`${API}/calib/turn`, { method: 'POST' });
    const d = await r.json();
    document.getElementById('calib-message')!.textContent = d.ok ? '旋转校准已启动' : d;
  } catch (e) {
    document.getElementById('calib-message')!.textContent = '请求失败: ' + (e as Error).message;
  }
});
document.getElementById('calib-drive')!.addEventListener('click', async () => {
  try {
    const r = await fetch(`${API}/calib/drive`, { method: 'POST' });
    const d = await r.json();
    document.getElementById('calib-message')!.textContent = d.ok ? '前进校准已启动' : d;
  } catch (e) {
    document.getElementById('calib-message')!.textContent = '请求失败: ' + (e as Error).message;
  }
});
document.getElementById('calib-cancel')!.addEventListener('click', async () => {
  try {
    const r = await fetch(`${API}/calib/cancel`, { method: 'POST' });
    const d = await r.json();
    document.getElementById('calib-phase')!.textContent = 'idle';
    document.getElementById('calib-message')!.textContent = '校准已取消';
  } catch (e) { /* ignore */ }
});

// ─── Goods Management ────────────────────────────────────────
async function loadGoods() {
  try {
    const r = await fetch(`${API}/goods`);
    const goods = await r.json() as any[];
    const list = document.getElementById('goods-list')!;
    list.innerHTML = goods.map((g: any) => `
      <div class="goods-card" data-goods-id="${g.id}">
        <div class="goods-name">${g.name}</div>
        <div class="goods-info">位置: (${g.x?.toFixed(2) || 0}, ${g.y?.toFixed(2) || 0})</div>
        <div class="goods-info">货架: ${g.shelf || '-'} | Tag: ${g.tag ?? '-'}</div>
        <div class="goods-actions">
          <button class="ctrl-btn-sm" onclick="pickGoods('${g.id}')">取货</button>
          <button class="ctrl-btn-sm" onclick="selectGoods('${g.id}')">编辑</button>
        </div>
      </div>
    `).join('');
    // Load order status
    const sr = await fetch(`${API}/goods/status`);
    const sd = await sr.json();
    document.getElementById('goods-order-detail')!.textContent = sd.status + ': ' + (sd.message || '');
  } catch (e) {
    document.getElementById('goods-status')!.textContent = '加载失败: ' + (e as Error).message;
  }
}

(window as any).selectGoods = (id: string) => {
  fetch(`${API}/goods/${id}`).then(r => r.json()).then((g: any) => {
    (document.getElementById('goods-id') as HTMLInputElement).value = g.id;
    (document.getElementById('goods-name') as HTMLInputElement).value = g.name;
    (document.getElementById('goods-x') as HTMLInputElement).value = g.x || 0;
    (document.getElementById('goods-y') as HTMLInputElement).value = g.y || 0;
    (document.getElementById('goods-tag') as HTMLInputElement).value = g.tag || '';
    (document.getElementById('goods-shelf') as HTMLInputElement).value = g.shelf || '';
    (document.getElementById('goods-channel') as HTMLInputElement).value = g.dropChannel || '';
  });
};

(window as any).pickGoods = async (id: string) => {
  try {
    const r = await fetch(`${API}/goods/pick?goods=${id}`, { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      logger.info(`开始取货: ${d.goods?.name}`);
      loadGoods();
    } else {
      logger.error(`取货失败: ${d.error}`);
    }
  } catch (e) {
    logger.error(`请求失败: ${(e as Error).message}`);
  }
};

document.getElementById('goods-refresh')!.addEventListener('click', loadGoods);
document.getElementById('goods-add')!.addEventListener('click', () => {
  (document.getElementById('goods-id') as HTMLInputElement).value = '';
  (document.getElementById('goods-name') as HTMLInputElement).value = '';
  (document.getElementById('goods-x') as HTMLInputElement).value = '0';
  (document.getElementById('goods-y') as HTMLInputElement).value = '0';
  (document.getElementById('goods-tag') as HTMLInputElement).value = '';
  (document.getElementById('goods-shelf') as HTMLInputElement).value = '';
  (document.getElementById('goods-channel') as HTMLInputElement).value = '';
});
document.getElementById('goods-save')!.addEventListener('click', async () => {
  const id = (document.getElementById('goods-id') as HTMLInputElement).value;
  const name = (document.getElementById('goods-name') as HTMLInputElement).value;
  const x = parseFloat((document.getElementById('goods-x') as HTMLInputElement).value) || 0;
  const y = parseFloat((document.getElementById('goods-y') as HTMLInputElement).value) || 0;
  const tag = parseInt((document.getElementById('goods-tag') as HTMLInputElement).value);
  const shelf = (document.getElementById('goods-shelf') as HTMLInputElement).value;
  const dropChannel = parseInt((document.getElementById('goods-channel') as HTMLInputElement).value);
  if (!id || !name) {
    document.getElementById('goods-status')!.textContent = 'ID 和名称必填';
    return;
  }
  try {
    const r = await fetch(`${API}/goods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, x, y, tag, shelf, dropChannel }),
    });
    const d = await r.json();
    if (d.id) {
      document.getElementById('goods-status')!.textContent = `货物 ${id} 已保存`;
      loadGoods();
    } else {
      document.getElementById('goods-status')!.textContent = `保存失败: ${d.error}`;
    }
  } catch (e) {
    document.getElementById('goods-status')!.textContent = '请求失败: ' + (e as Error).message;
  }
});
document.getElementById('goods-delete')!.addEventListener('click', async () => {
  const id = (document.getElementById('goods-id') as HTMLInputElement).value;
  if (!id) return;
  try {
    const r = await fetch(`${API}/goods/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) {
      document.getElementById('goods-status')!.textContent = `货物 ${id} 已删除`;
      loadGoods();
    }
  } catch (e) { /* ignore */ }
});

// ─── Debug Panel (integrated into map sidebar) ──────────────
async function loadDebugData() {
  try {
    const r = await fetch(`${API}/debug`);
    debugData = await r.json();
    // Position + angle (sidebar)
    const px = debugData.position?.x?.toFixed(3) ?? '0';
    const py = debugData.position?.y?.toFixed(3) ?? '0';
    setText('dbg-pos', `(${px}, ${py})`);
    setText('dbg-angle', (debugData.angleDeg?.toFixed(1) ?? '0') + '°');
    // Odometry
    setText('dbg-left', (debugData.odom?.leftDist?.toFixed(1) ?? '0') + ' mm');
    setText('dbg-right', (debugData.odom?.rightDist?.toFixed(1) ?? '0') + ' mm');
    setText('dbg-dheading', (debugData.odom?.dHeading?.toFixed(1) ?? '0') + '°');
    setText('dbg-enc-delta', debugData.odom?.delta?.join(',') ?? '--');
    // Tag fusion
    setText('dbg-tag-seen', debugData.tagFusion?.hasTag ? '是' : '否');
    setText('dbg-tag-time', (debugData.tagFusion?.age ?? '--') + ' ms');
  } catch (e) {
    console.error('Debug load failed:', e);
  }
}

function setText(id: string, val: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ─── Debug polling (only while map tab is active) ───────────
let debugPollTimer: number | null = null;
const DEBUG_POLL_MS = 1000;
function startDebugPolling() {
  if (debugPollTimer !== null) return;
  debugPollTimer = window.setInterval(() => {
    if (currentTab === 'map') loadDebugData();
    else stopDebugPolling();
  }, DEBUG_POLL_MS);
}
function stopDebugPolling() {
  if (debugPollTimer !== null) { clearInterval(debugPollTimer); debugPollTimer = null; }
}

document.getElementById('dbg-refresh')!.addEventListener('click', loadDebugData);
document.getElementById('dbg-reset-pose')!.addEventListener('click', async () => {
  try {
    const r = await fetch(`${API}/robot/position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 0, y: 0, angle: 0 }),
    });
    const d = await r.json();
    if (d.ok) {
      logger.info('位姿已重置到原点');
      loadDebugData();
    }
  } catch (e) { /* ignore */ }
});
document.getElementById('dbg-trace-clear')!.addEventListener('click', () => {
  motionTrace = [];
  document.getElementById('dbg-trace-count')!.textContent = '0';
});

// ─── Video Panel ──────────────────────────────────────────
const videoCanvas = document.getElementById('video-canvas') as HTMLCanvasElement;
const videoCtx = videoCanvas.getContext('2d')!;
let videoFrameCount = 0;
let videoBytes = 0;
let videoLastStat = performance.now();
let lastFrameTime = 0;
let videoActive = false;

function updateVideoStats() {
  const now = performance.now();
  const dt = (now - videoLastStat) / 1000;
  if (dt < 0.5) return;
  const fps = Math.round(videoFrameCount / dt);
  const bitrate = Math.round(videoBytes * 8 / dt / 1024);
  document.getElementById('v-fps')!.textContent = fps.toString();
  document.getElementById('v-bitrate')!.textContent = bitrate.toString();
  document.getElementById('v-frames')!.textContent = videoFrameCount.toString();
  document.getElementById('v-latency')!.textContent = lastFrameTime > 0 ? Math.round(now - lastFrameTime).toString() : '--';
  videoFrameCount = 0;
  videoBytes = 0;
  videoLastStat = now;
}
setInterval(updateVideoStats, 2000);

let latestJpegBlob: Blob | null = null;
let atagEnabled = true;
let overlayEnabled = true;
const TAG_SIZE_MM = 168;

(document.getElementById('v-atag-toggle') as HTMLInputElement)?.addEventListener('change', (e: any) => { atagEnabled = e.target.checked; });
(document.getElementById('v-overlay-toggle') as HTMLInputElement)?.addEventListener('change', (e: any) => { overlayEnabled = e.target.checked; });

let currentTags: any[] = [];

async function drawVideoFrame() {
  try {
    if (!latestJpegBlob) return;
    const blob = latestJpegBlob;
    latestJpegBlob = null;
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(blob); } catch { return; }
    const w = bitmap.width, h = bitmap.height;
    videoCanvas.width = w;
    videoCanvas.height = h;
    videoCtx.drawImage(bitmap, 0, 0);
    bitmap.close();
    if (overlayEnabled && currentTags.length > 0) {
      for (const tag of currentTags) {
        if (tag.error) continue;
        const corners = tag.corners;
        if (!corners || corners.length < 4) continue;
        videoCtx.strokeStyle = '#22c55e';
        videoCtx.lineWidth = 3;
        videoCtx.beginPath();
        videoCtx.moveTo(corners[0][0], corners[0][1]);
        for (let i = 1; i < corners.length; i++) videoCtx.lineTo(corners[i][0], corners[i][1]);
        videoCtx.closePath();
        videoCtx.stroke();
        const cx = tag.center?.[0] ?? 0;
        const cy = tag.center?.[1] ?? 0;
        videoCtx.fillStyle = '#22c55e';
        videoCtx.beginPath(); videoCtx.arc(cx, cy, 5, 0, Math.PI * 2); videoCtx.fill();
        videoCtx.font = 'bold 16px sans-serif';
        videoCtx.fillStyle = '#22c55e';
        videoCtx.strokeStyle = '#000';
        videoCtx.lineWidth = 3;
        const label = `#${tag.id}`;
        videoCtx.strokeText(label, cx + 12, cy - 6);
        videoCtx.fillText(label, cx + 12, cy - 6);
        if (tag.size_px) {
          const distEst = (TAG_SIZE_MM * w) / (tag.size_px * 800);
          videoCtx.font = '12px sans-serif';
          videoCtx.fillStyle = '#f59e0b';
          videoCtx.fillText(`${distEst.toFixed(1)}m`, cx + 12, cy + 16);
        }
      }
    }
  } catch { /* keep alive */ }
  finally { requestAnimationFrame(drawVideoFrame); }
}
drawVideoFrame();

// ─── Tag navigation status poll ────────────────────────────
async function pollTagNav() {
  try {
    const r = await fetch(`${API}/tag-nav/status`);
    const s = await r.json();
    if (s.active) {
      const info = document.getElementById('map-info');
      if (info) info.textContent =
        `🏷️ 标签导航: 第${s.index+1}/${s.total}步`;
    }
  } catch { /* ignore */ }
  setTimeout(pollTagNav, 2000);
}
pollTagNav();

// ─── Init ─────────────────────────────────────────────────────
(async () => {
  try {
    const r = await fetch(`${API}/robot`);
    robot = await r.json();
    updateUI();
    loadPoi();
    await loadTags(); // populates tag chips + 3D ceiling markers + 2D map
    // fallback if loadTags fails
    if (!tagMap) { try { tagMap = await (await fetch(`${API}/tags`)).json(); refreshCeilingTags(); } catch { tagMap = {}; } }
    // Restore persisted map from server
    try {
      const metaResp = await fetch(`${API}/map`);
      if (metaResp.ok) {
        const meta = await metaResp.json();
        const dataResp = await fetch(`${API}/map/data`);
        if (dataResp.ok) {
          const buf = await dataResp.arrayBuffer();
          LOCAL_MAP_W = meta.width; LOCAL_MAP_H = meta.height;
          LOCAL_MAP_RES = meta.res; LOCAL_MAP_OX = meta.ox; LOCAL_MAP_OY = meta.oy;
          localGrid = new Uint8Array(buf);
          dilatedGrid = new Uint8Array(LOCAL_MAP_W * LOCAL_MAP_H).fill(255);
          dilateObstacles();
          drawMap();
          logger.info(`地图已恢复: ${meta.width}×${meta.height} @ ${meta.res}m`);
        }
      }
    } catch { /* no persisted map — use default empty grid */ }
    logger.info('系统启动');
  } catch {
    logger.error('API 连接失败');
  }
})();
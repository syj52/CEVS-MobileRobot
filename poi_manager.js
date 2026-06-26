/**
 * poi_manager.js — POI 标记管理（数字孪生场景标注）
 *
 * 功能：
 *   1. 从中央控制器加载已有 POI → Three.js 3D 标记
 *   2. Shift + 点击场景 → 在点击位置创建新 POI
 *   3. 点击已有标记 → 弹出信息面板（含删除）
 *
 * 依赖：Three.js (THREE)
 * 后端：Digital Twin Central Controller (FastAPI:8000)
 */

import * as THREE from 'three';

const API_BASE = 'http://localhost:8000';

export class PoiManager {
  constructor({ scene, camera, renderer, mapId = 'default', logger }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.mapId = mapId;
    this.log = logger;

    this.markers = new Map(); // name → { poi, sphere, ring, label }
    this._selectedPoi = null;
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // 不可见地面平面，确保 Shift+点击始终命中
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0;
    plane.name = 'poi_ground';
    this.scene.add(plane);
    this._groundPlane = plane;

    this._createInfoPanel();
    this._onClickBound = this._onClick.bind(this);
    this.renderer.domElement.addEventListener('click', this._onClickBound);
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /** 从控制器加载该 mapId 的所有 POI */
  async load() {
    try {
      const resp = await fetch(`${API_BASE}/api/poi?map_id=${this.mapId}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const pois = await resp.json();
      pois.forEach((p) => this._addMarker(p));
      this.log?.info(`加载 ${pois.length} 个 POI`);
    } catch (e) {
      this.log?.warn(`POI 加载失败: ${e.message}`);
    }
  }

  /** 每帧调用，让标记环始终面向相机 */
  update() {
    const campos = this.camera.position;
    for (const entry of this.markers.values()) {
      entry.ring.lookAt(campos);
    }
  }

  dispose() {
    this.renderer.domElement.removeEventListener('click', this._onClickBound);
    for (const entry of this.markers.values()) {
      this.scene.remove(entry.sphere);
      this.scene.remove(entry.ring);
      this.scene.remove(entry.label);
    }
    this.markers.clear();
    this.scene.remove(this._groundPlane);
    if (this._infoPanel?.parentNode) {
      this._infoPanel.parentNode.removeChild(this._infoPanel);
    }
  }

  // ---------------------------------------------------------------------------
  // 标记渲染
  // ---------------------------------------------------------------------------

  _addMarker(poi) {
    if (this.markers.has(poi.name)) return; // 幂等

    const pos = new THREE.Vector3(poi.coord_x, poi.coord_y, poi.coord_z || 0);
    const key = poi.name;

    // 发光球体
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 }),
    );
    sphere.position.copy(pos);
    sphere.userData.poiKey = key;
    this.scene.add(sphere);

    // 光环（始终面向相机，由 update() 驱动）
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.12, 24),
      new THREE.MeshBasicMaterial({
        color: 0x00ff88,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.position.copy(pos);
    ring.userData.poiKey = key;
    ring.userData.isRing = true;
    this.scene.add(ring);

    // 名称标签（Sprite）
    const label = this._makeLabel(poi.name);
    label.position.copy(pos).add(new THREE.Vector3(0, 0.15, 0));
    label.userData.poiKey = key;
    this.scene.add(label);

    this.markers.set(key, { poi, sphere, ring, label });
  }

  _makeLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // 半透明背景圆角矩形
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(4, 4, 248, 56, 8);
    ctx.fill();

    // 文字
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.5, 0.125, 1);
    return sprite;
  }

  // ---------------------------------------------------------------------------
  // 用户交互
  // ---------------------------------------------------------------------------

  _onClick(event) {
    if (event.shiftKey) {
      this._placePoi(event);
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.camera);

    // 检测是否点击到某个标记球体
    const spheres = Array.from(this.markers.values()).map((e) => e.sphere);
    const hits = this._raycaster.intersectObjects(spheres);
    if (hits.length > 0) {
      const key = hits[0].object.userData.poiKey;
      const entry = this.markers.get(key);
      if (entry) {
        this._showInfo(entry.poi);
        return;
      }
    }

    // 点到空白处 → 关闭信息面板
    this._infoPanel.style.display = 'none';
    this._selectedPoi = null;
  }

  async _placePoi(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.camera);

    const hits = this._raycaster.intersectObject(this._groundPlane);
    if (hits.length === 0) return;

    const pos = hits[0].point;
    const name = prompt('新地点名称:', '');
    if (!name || !name.trim()) return;

    try {
      const resp = await fetch(`${API_BASE}/api/poi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          coord_x: pos.x,
          coord_y: pos.y,
          coord_z: pos.z,
          map_id: this.mapId,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const poi = await resp.json();
      this._addMarker(poi);
      this.log?.info(
        `POI: ${poi.name} @ (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`,
      );
    } catch (e) {
      this.log?.error(`POI 创建失败: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 信息面板
  // ---------------------------------------------------------------------------

  _createInfoPanel() {
    const panel = document.createElement('div');
    panel.id = 'poi-info-panel';
    panel.style.cssText = `
      position: absolute; bottom: 150px; left: 10px;
      background: rgba(0,0,0,0.8); border: 1px solid #00ff88;
      border-radius: 6px; padding: 10px 14px;
      color: #ccc; font-size: 13px; font-family: monospace;
      z-index: 1002; display: none; min-width: 200px;
      backdrop-filter: blur(4px);
    `;
    panel.innerHTML = `
      <div style="color:#00ff88;font-weight:bold;margin-bottom:4px;" id="poi-info-title"></div>
      <div id="poi-info-body"></div>
      <div style="margin-top:6px;display:flex;gap:6px;">
        <button id="poi-info-delete" style="
          background:rgba(255,50,50,0.2);border:1px solid rgba(255,50,50,0.4);
          color:#ff6666;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:11px;
        ">删除</button>
        <button id="poi-info-close" style="
          background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);
          color:#aaa;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:11px;
        ">关闭</button>
      </div>
    `;
    document.body.appendChild(panel);
    this._infoPanel = panel;

    panel.querySelector('#poi-info-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    panel.querySelector('#poi-info-delete').addEventListener('click', () => {
      if (this._selectedPoi) {
        this._deletePoi(this._selectedPoi);
        panel.style.display = 'none';
      }
    });
  }

  _showInfo(poi) {
    this._selectedPoi = poi;
    document.getElementById('poi-info-title').textContent = `📍 ${poi.name}`;
    document.getElementById('poi-info-body').innerHTML = `
      <div style="margin:4px 0;color:#999;font-size:11px;">${poi.description || ''}</div>
      <div style="color:#888;font-size:11px;">
        X: ${poi.coord_x.toFixed(3)}<br>
        Y: ${poi.coord_y.toFixed(3)}<br>
        Z: ${(poi.coord_z || 0).toFixed(3)}<br>
        map: ${poi.map_id || 'default'}
      </div>
    `;
    this._infoPanel.style.display = 'block';
  }

  async _deletePoi(poi) {
    try {
      const resp = await fetch(
        `${API_BASE}/api/poi/${encodeURIComponent(poi.name)}`,
        { method: 'DELETE' },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const entry = this.markers.get(poi.name);
      if (entry) {
        this.scene.remove(entry.sphere);
        this.scene.remove(entry.ring);
        this.scene.remove(entry.label);
        this.markers.delete(poi.name);
      }
      this.log?.info(`删除 POI: ${poi.name}`);
    } catch (e) {
      this.log?.error(`POI 删除失败: ${e.message}`);
    }
  }
}

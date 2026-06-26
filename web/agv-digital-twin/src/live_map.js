/**
 * live_map.js — WebSocket client for LingBot-MAP real-time mapping.
 *
 * Connects to the Python demo_live_ws.py WebSocket server and renders
 * the incoming point cloud + camera poses in the Three.js scene.
 *
 * Usage in main.js:
 *   import { LiveMapClient } from './live_map.js';
 *   const liveMap = new LiveMapClient(scene, 'ws://localhost:9091');
 *   liveMap.start();
 */

import * as THREE from 'three';

export class LiveMapClient {
    constructor(scene, url = 'ws://localhost:9091') {
        this.scene = scene;
        this.url = url;
        this.ws = null;
        this.frameCount = 0;
        this.pointClouds = [];    // array of { frameIdx, points, mesh }
        this.cameraPoses = [];    // array of { frameIdx, t, q, fov, aspect }
        this._buf = null;         // partial message buffer
        this._needed = 0;         // bytes needed for current partial message
        this.statusEl = null;     // optional status display

        this._createStatusUI();
    }

    _createStatusUI() {
        const el = document.createElement('div');
        el.id = 'live-map-status';
        el.style.cssText =
            'position:absolute;bottom:10px;right:10px;z-index:1001;' +
            'color:#0f0;font-size:12px;font-family:monospace;' +
            'background:rgba(0,0,0,0.6);padding:4px 8px;border-radius:4px;' +
            'border:1px solid rgba(0,255,0,0.3);display:none;';
        el.textContent = 'Live map: idle';
        document.body.appendChild(el);
        this.statusEl = el;
    }

    set visible(v) {
        this.statusEl.style.display = v ? 'block' : 'none';
        // show/hide all point cloud meshes
        for (const pc of this.pointClouds) {
            if (pc.mesh) pc.mesh.visible = v;
        }
    }

    start() {
        if (this.ws) return;
        this.statusEl.style.display = 'block';
        this._connect();
    }

    stop() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.statusEl.style.display = 'none';
    }

    _connect() {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.statusEl.textContent = 'Live map: connected';
            this.statusEl.style.color = '#0f0';
        };

        this.ws.onmessage = (event) => this._onMessage(event.data);

        this.ws.onclose = () => {
            this.statusEl.textContent = 'Live map: disconnected';
            this.statusEl.style.color = '#f80';
            this.ws = null;
            // auto-reconnect after 2 seconds
            setTimeout(() => {
                if (!this.ws) this._connect();
            }, 2000);
        };

        this.ws.onerror = () => {
            this.statusEl.textContent = 'Live map: connection error';
            this.statusEl.style.color = '#f00';
        };
    }

    _onMessage(data) {
        const buf = new Uint8Array(data);
        if (buf.length === 0) return;

        const type = buf[0];

        switch (type) {
            case 0x01: // point cloud
                this._parsePointCloud(buf);
                break;
            case 0x02: // camera pose
                this._parseCamera(buf);
                break;
            case 0xFF: // done
                this.statusEl.textContent = `Live map: done (${this.frameCount} frames)`;
                break;
            default:
                console.warn('LiveMap: unknown message type', type);
        }
    }

    _parsePointCloud(buf) {
        const dv = new DataView(buf.buffer);
        const frameIdx = dv.getUint32(1, true);
        const numPoints = dv.getUint32(5, true);
        const positions = new Float32Array(numPoints * 3);
        const colors = new Uint8Array(numPoints * 3);
        let off = 9;
        for (let i = 0; i < numPoints; i++) {
            positions[i * 3]     = dv.getFloat32(off, true);
            positions[i * 3 + 1] = dv.getFloat32(off + 4, true);
            positions[i * 3 + 2] = dv.getFloat32(off + 8, true);
            off += 12;
            colors[i * 3]     = buf[off];
            colors[i * 3 + 1] = buf[off + 1];
            colors[i * 3 + 2] = buf[off + 2];
            off += 3;
        }

        // Create Three.js point cloud
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(
            new Float32Array(numPoints * 3).map((_, i) => colors[i] / 255), 3
        ));

        const material = new THREE.PointsMaterial({
            size: 0.005,
            vertexColors: true,
            sizeAttenuation: true,
            transparent: false,
        });
        const mesh = new THREE.Points(geometry, material);
        mesh.frustumCulled = false;
        this.scene.add(mesh);

        this.pointClouds.push({ frameIdx, mesh });
        this.frameCount = Math.max(this.frameCount, frameIdx + 1);
        this.statusEl.textContent = `Live map: ${this.frameCount} frames, ${this.pointClouds.reduce((s, p) => s + positions.length / 3, 0) | 0} pts`;
    }

    _parseCamera(buf) {
        const dv = new DataView(buf.buffer);
        const frameIdx = dv.getUint32(1, true);
        const t = new THREE.Vector3(
            dv.getFloat32(5, true),
            dv.getFloat32(9, true),
            dv.getFloat32(13, true),
        );
        const q = new THREE.Quaternion(
            dv.getFloat32(17, true),
            dv.getFloat32(21, true),
            dv.getFloat32(25, true),
            dv.getFloat32(29, true),
        );
        const fov = dv.getFloat32(33, true);
        const aspect = dv.getFloat32(37, true);

        this.cameraPoses.push({ frameIdx, t, q, fov, aspect });

        // Optional: add a small camera frustum marker
        const cone = new THREE.Mesh(
            new THREE.ConeGeometry(0.02, 0.05, 4),
            new THREE.MeshBasicMaterial({ color: 0x00ffff })
        );
        cone.position.copy(t);
        cone.quaternion.copy(q);
        this.scene.add(cone);
    }

    clear() {
        for (const pc of this.pointClouds) {
            if (pc.mesh) {
                this.scene.remove(pc.mesh);
                pc.mesh.geometry.dispose();
                pc.mesh.material.dispose();
            }
        }
        this.pointClouds = [];
        this.cameraPoses = [];
        this.frameCount = 0;
    }
}

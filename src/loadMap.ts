import fs from 'fs';
import path from 'path';
import type { GridMap } from './types.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadNavMap(): GridMap {
  // Prefer uploaded map (persisted from client slice), fall back to default
  const uploadedPgm = path.join(__dirname, '..', 'maps', 'uploaded_map.pgm');
  const uploadedYaml = path.join(__dirname, '..', 'maps', 'uploaded_map.yaml');
  let pgmPath: string, yamlPath: string;
  if (fs.existsSync(uploadedPgm) && fs.existsSync(uploadedYaml)) {
    pgmPath = uploadedPgm;
    yamlPath = uploadedYaml;
    console.log(`[map] Using uploaded map: ${pgmPath}`);
  } else {
    pgmPath = path.join(__dirname, '..', 'maps', 'nav2_map.pgm');
    yamlPath = path.join(__dirname, '..', 'maps', 'nav2_map.yaml');
    console.log(`[map] Using default map: ${pgmPath}`);
  }

  // Read YAML metadata
  const yamlRaw = fs.readFileSync(yamlPath, 'utf8');
  const yaml: Record<string, any> = {};
  for (const line of yamlRaw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m) yaml[m[1]] = m[2].trim();
  }

  const resolution = parseFloat(yaml.resolution || '0.05');
  const originRaw = (yaml.origin || '[-1, -1, 0]').replace(/[\[\]]/g, '').split(',').map(Number);
  const ox = originRaw[0] || 0;
  const oy = originRaw[1] || 0;
  const negate = parseInt(yaml.negate || '0');
  const occThresh = parseFloat(yaml.occupied_thresh || '0.65');
  const freeThresh = parseFloat(yaml.free_thresh || '0.196');

  // Read PGM binary (P5 = graymap)
  const buf = fs.readFileSync(pgmPath);
  // Find first "P5" header line end
  const lf1 = buf.indexOf(0x0A);
  const dimEnd = buf.indexOf(0x0A, lf1 + 1);
  const dimLine = buf.toString('ascii', lf1 + 1, dimEnd).trim();
  // PGM may have comment lines between header and dimensions — skip them
  let [w, h] = dimLine.split(/\s+/).map(Number);
  if (isNaN(w) || isNaN(h)) {
    console.warn('[map] Bad PGM header, treating WxH as 0');
    w = 0; h = 0;
  }

  // max val line
  const valEnd = buf.indexOf(0x0A, dimEnd + 1);
  const maxVal = parseInt(buf.toString('ascii', dimEnd + 1, valEnd).trim());

  // Pixel data starts after header
  const pixelData = buf.subarray(valEnd + 1);

  const data = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let v = pixelData[r * w + c];
      if (negate) v = maxVal - v;
      // Convert to 0=occupied, 254=free
      const norm = v / maxVal;
      if (norm > occThresh) data[r * w + c] = 0;
      else if (norm < freeThresh) data[r * w + c] = 254;
      else data[r * w + c] = 205; // unknown
    }
  }

  console.log(`[map] Loaded ${w}×${h} @ ${resolution}m/cell, origin=(${ox},${oy})`);
  return { width: w, height: h, res: resolution, ox, oy, data };
}

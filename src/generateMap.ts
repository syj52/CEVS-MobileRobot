import fs from 'fs';
import path from 'path';
import type { GridMap } from './types.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MapGenParams {
  sliceZMin?: number;
  sliceZMax?: number;
  resolution?: number;
  dilateRadius?: number;
}

/* Only used as server-side fallback when client fails to upload */
export function generateMapFromParams(_params: MapGenParams): GridMap {
  throw new Error('Server-side generation disabled; use client-side Three.js raycasting');
}

export function isPlyAvailable(): boolean {
  return false;
}

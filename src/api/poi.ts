import type { Request, Response } from 'express';
import { state } from '../state.js';

export const poiApi = {
  create(req: Request, res: Response) {
    const { name, coord_x, coord_y, description } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const idx = state.pois.findIndex(p => p.name === name);
    const poi = { name, coord_x, coord_y: coord_y || 0, coord_z: 0, description: description || '' };
    if (idx >= 0) state.pois[idx] = poi;
    else state.pois.push(poi);
    res.json(poi);
  },

  remove(req: Request, res: Response) {
    const idx = state.pois.findIndex(p => p.name === req.params.name);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    state.pois.splice(idx, 1);
    res.json({ ok: true });
  },
};

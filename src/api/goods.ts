/**
 * goods.ts — 货物取货管理
 *
 * 物流仓库智能导引:
 *   1. 每个货位定义一件货物 (goods) + 目标坐标 (可关联 tag)
 *   2. 用户扫货架上的静态二维码 → 打开确认页 /pick?goods=<id>
 *   3. 点"确认取货" → 小车用 tagNav 导航到货位
 *   4. 到位 → 通知投货芯片把货物丢到小车上
 *
 * 二维码内容(静态,提前打印贴货架):
 *   http://<server_ip>:8000/pick?goods=<id>
 */
import type { Request, Response } from 'express';
import { state } from '../state.js';
import { startTagNav, getTagNavStatus } from './tagNav.js';

// ─── 货物定义 ────────────────────────────────────────────────
export interface Goods {
  id: string;         // 货物唯一 ID (二维码里编码的值)
  name: string;       // 货物名称
  x: number;          // 货位世界坐标 x (m)
  y: number;          // 货位世界坐标 y (m)
  tag?: number;       // 关联的 AprilTag ID (可选, 用于精确定位)
  shelf?: string;     // 货架编号 (显示用)
  dropChannel?: number; // 投货通道号 (通知投货芯片用)
  trajectoryId?: string; // 到位后发送的固定轨迹 ID (如 "shelf_a", "dock")
}

// ─── 取货订单状态 ───────────────────────────────────────────
type PickStatus = 'idle' | 'navigating' | 'arrived' | 'dropping' | 'done' | 'error';

interface PickOrder {
  goodsId: string;
  status: PickStatus;
  startedAt: number;
  message: string;
}

// ─── 货物清单 (示例数据, 可通过 API 增删) ──────────────────
const GOODS: Record<string, Goods> = {
  '0': { id: '0', name: '货架A', x: -0.30, y:  0.80, tag: 0, shelf: '左上A', dropChannel: 1 },
  '1': { id: '1', name: '货架B', x:  0.30, y:  0.80, tag: 1, shelf: '右上B', dropChannel: 2 },
  '2': { id: '2', name: '货架C', x: -0.30, y: -0.80, tag: 2, shelf: '左下C', dropChannel: 3 },
  '3': { id: '3', name: '货架D', x:  0.30, y: -0.80, tag: 3, shelf: '右下D', dropChannel: 4 },
};

// ─── 当前取货订单 (单车系统, 一次一单) ──────────────────────
let currentOrder: PickOrder | null = null;

// ─── 投货通知回调 (由 main.ts 注入, 通过 TCP 发到 ESP32→投货芯片) ──
let dropNotifier: ((channel: number) => void) | null = null;
export function setDropNotifier(fn: (channel: number) => void) { dropNotifier = fn; }

// ─── 固定轨迹通知回调 (到位后发 $TRAJ:<id> 到 ESP32→STM32) ──
let trajectoryNotifier: ((trajectoryId: string) => void) | null = null;
export function setTrajectoryNotifier(fn: (trajectoryId: string) => void) { trajectoryNotifier = fn; }

// ─── 到位检测: tagNav 完成后触发投货 ────────────────────────
let arrivalCheckTimer: ReturnType<typeof setInterval> | null = null;

function startArrivalWatch(goods: Goods) {
  if (arrivalCheckTimer) clearInterval(arrivalCheckTimer);
  arrivalCheckTimer = setInterval(() => {
    if (!currentOrder || currentOrder.status !== 'navigating') {
      if (arrivalCheckTimer) { clearInterval(arrivalCheckTimer); arrivalCheckTimer = null; }
      return;
    }

    const nav = getTagNavStatus();
    // tagNav 完成 (active=false 且之前在导航) → 到位
    if (!nav.active) {
      currentOrder.status = 'arrived';
      currentOrder.message = `已到达货位 ${goods.shelf || goods.id}`;
      console.log(`[goods] 🎯 到位: ${goods.name} @ (${goods.x},${goods.y})`);

      // 触发投货
      triggerDrop(goods);
      if (arrivalCheckTimer) { clearInterval(arrivalCheckTimer); arrivalCheckTimer = null; }
    }
  }, 500);
}

function triggerDrop(goods: Goods) {
  if (!currentOrder) return;
  currentOrder.status = 'dropping';
  currentOrder.message = `正在执行...`;

  // 固定轨迹: 到位后发给 STM32 走预定路径
  if (goods.trajectoryId && trajectoryNotifier) {
    console.log(`[goods] 🛤️ 固定轨迹 ${goods.trajectoryId}: ${goods.name}`);
    trajectoryNotifier(goods.trajectoryId);
  }

  // 投货通道
  const channel = goods.dropChannel ?? 0;
  if (channel > 0) {
    console.log(`[goods] 📦 投货通道 ${channel}: ${goods.name}`);
    if (dropNotifier) {
      dropNotifier(channel);
    } else {
      console.warn('[goods] 投货通知未配置');
    }
  }

  // 假定动作 3 秒完成
  setTimeout(() => {
    if (currentOrder && currentOrder.goodsId === goods.id) {
      currentOrder.status = 'done';
      currentOrder.message = `取货完成: ${goods.name}`;
      console.log(`[goods] ✅ 完成: ${goods.name}`);
      state.updateRobot({ status: 'idle' });
    }
  }, 3000);
}

// ─── REST API ───────────────────────────────────────────────

export const goodsApi = {
  /** 列出所有货物 */
  list(_req: Request, res: Response) {
    res.json(Object.values(GOODS));
  },

  /** 查询单个货物 */
  get(req: Request, res: Response) {
    const g = GOODS[req.params.id];
    if (!g) return res.status(404).json({ error: '货物不存在' });
    res.json(g);
  },

  /** 增加/更新货物 */
  upsert(req: Request, res: Response) {
    const { id, name, x, y, tag, shelf, dropChannel, trajectoryId } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'id 和 name 必填' });
    GOODS[id] = { id, name, x: x ?? 0, y: y ?? 0, tag, shelf, dropChannel, trajectoryId };
    console.log(`[goods] 货物登记: ${id} = ${name} @ (${x},${y})`);
    res.json(GOODS[id]);
  },

  /** 删除货物 */
  remove(req: Request, res: Response) {
    if (!GOODS[req.params.id]) return res.status(404).json({ error: '货物不存在' });
    delete GOODS[req.params.id];
    res.json({ ok: true });
  },

  /** 发起取货 (扫码确认后调用) */
  pick(req: Request, res: Response) {
    const goodsId = req.body?.goodsId || req.query.goods;
    if (!goodsId) return res.status(400).json({ error: '缺少 goodsId' });

    const goods = GOODS[goodsId as string];
    if (!goods) return res.status(404).json({ error: '货物不存在' });

    // 检查是否有正在进行的订单
    if (currentOrder && ['navigating', 'arrived', 'dropping'].includes(currentOrder.status)) {
      return res.status(409).json({ error: '小车忙碌中', current: currentOrder });
    }

    // 创建订单
    currentOrder = {
      goodsId: goods.id,
      status: 'navigating',
      startedAt: Date.now(),
      message: `导航至货位 ${goods.shelf || goods.id}`,
    };

    // Tag-only navigation — shelf must have a tag
    if (goods.tag === undefined) {
      return res.status(400).json({ error: '货物没有关联 AprilTag' });
    }
    // Go to shelf → return to origin
    const waypoints = [{ tag: goods.tag }, { x: 0, y: 0 }];

    const navResult = startTagNav(waypoints);
    if ((navResult as any).error) {
      currentOrder.status = 'error';
      currentOrder.message = `导航失败: ${(navResult as any).error}`;
      return res.status(500).json({ error: currentOrder.message });
    }

    state.updateRobot({ status: 'moving' });
    startArrivalWatch(goods);

    console.log(`[goods] 🚚 取货开始: ${goods.name} → (${goods.x},${goods.y})`);
    res.json({ ok: true, goods, order: currentOrder });
  },

  /** 查询取货订单状态 */
  status(_req: Request, res: Response) {
    res.json(currentOrder || { status: 'idle', message: '空闲' });
  },

  /** 取消当前取货 */
  cancel(_req: Request, res: Response) {
    if (arrivalCheckTimer) { clearInterval(arrivalCheckTimer); arrivalCheckTimer = null; }
    currentOrder = null;
    state.updateRobot({ status: 'idle' });
    res.json({ ok: true });
  },
};

export function getGoods(id: string): Goods | undefined { return GOODS[id]; }

/** 语音取货: 通过货物名模糊匹配并直接派车 */
export function pickDirect(query: string) {
  // Try exact ID match first
  if (GOODS[query]) {
    goodsApi.pick({ body: { goodsId: query } } as any, { json: (v: any) => v } as any);
    return { ok: true, matched: 'id', goods: GOODS[query] };
  }
  // Fuzzy name match
  const q = query.toLowerCase();
  for (const [id, g] of Object.entries(GOODS)) {
    if (g.name.toLowerCase().includes(q) || g.shelf?.toLowerCase().includes(q)) {
      goodsApi.pick({ body: { goodsId: id } } as any, { json: (v: any) => v } as any);
      return { ok: true, matched: 'name', goods: g };
    }
  }
  return { ok: false, error: `未找到与"${query}"匹配的货物` };
}

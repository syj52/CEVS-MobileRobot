/**
 * dashscope.ts — 多 API 配置管理
 *
 * LLM: 火山引擎豆包 (Doubao/Volcengine)
 *   模型: doubao-seed-1.6-flash
 *   Endpoint: https://ai-gateway.vei.volces.com/v1
 *
 * STT: DashScope Fun-ASR-Flash（从 CSV 或环境变量加载）
 *
 * 两个 API 都是 OpenAI 兼容格式，统一用 chatCompletion() 接口。
 */
import fs from 'fs';
import path from 'path';

// ───── LLM 配置：火山引擎豆包 ───────────────────────────────
const LLM_API_KEY = 'sk-56f55fbb21f14707952a3af1609a7ea594xor8bot1070wx8';
const LLM_BASE_URL = 'https://ai-gateway.vei.volces.com/v1';
const LLM_MODEL = 'doubao-seed-1.6-flash';

// ───── STT 配置：DashScope Fun-ASR-Flash ────────────────────
// 从 CSV 或环境变量加载（兼容原有 DashScope 配置）

interface DSCfg {
  apiKey: string;
  dashscopeUrl: string; // DashScope 原生 URL（用于 STT）
}

let _sttCfg: DSCfg | null = null;
let _sttLoaded = false;

function loadSttConfig(): DSCfg | null {
  // 1. 环境变量
  const envKey = process.env.DASHSCOPE_API_KEY;
  const envWs = process.env.DASHSCOPE_WORKSPACE_ID;
  if (envKey && envWs) {
    return {
      apiKey: envKey,
      dashscopeUrl: `https://${envWs}.cn-beijing.maas.aliyuncs.com/api/v1`,
    };
  }

  // 2. CSV 文件
  const searchDirs = ['E:\\迅雷下载\\文档', 'C:\\Users\\ljq\\Downloads'];
  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.startsWith('默认业务空间-apiKey') && f.endsWith('.csv'))) {
        const text = fs.readFileSync(path.join(dir, f), 'utf-8');
        const map: Record<string, string> = {};
        for (const line of text.split('\n').filter(l => l.trim())) {
          const idx = line.indexOf(',');
          if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        if (map.apiKey) {
          return {
            apiKey: map.apiKey,
            dashscopeUrl: map.dashScope || `https://${map.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`,
          };
        }
      }
    } catch {}
  }
  return null;
}

function getSttCfg(): DSCfg {
  if (!_sttLoaded) {
    _sttCfg = loadSttConfig();
    _sttLoaded = true;
  }
  if (!_sttCfg) throw new Error('STT(DashScope) 未配置：请设置 DASHSCOPE_API_KEY 或将 CSV 放到下载目录');
  return _sttCfg;
}

// ───── 公开 API ─────────────────────────────────────────────

/** 调用豆包 LLM（OpenAI 兼容格式） */
export async function chatCompletion(
  messages: { role: string; content: string }[],
  model = LLM_MODEL,
): Promise<string> {
  const url = `${LLM_BASE_URL}/chat/completions`;
  console.log(`[llm] → ${model} ${messages[messages.length-1]?.content?.slice(0,60)}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LLM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`豆包 API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json() as any;
  const content = data?.choices?.[0]?.message?.content || '';
  console.log(`[llm] ← ${content.length}B`);
  return content;
}

/** 获取 DashScope API Key（给 STT Fun-ASR-Flash 用） */
export function getApiKey(): string {
  return getSttCfg().apiKey;
}

/** 获取 DashScope 原生 URL（给 STT 用） */
export function getDashScopeUrl(): string {
  return getSttCfg().dashscopeUrl;
}

/** 检查配置状态 */
export function getStatus() {
  let sttOk = false, sttErr = '';
  try { getSttCfg(); sttOk = true; } catch (e) { sttErr = (e as Error).message; }
  return {
    llm: { provider: '火山引擎豆包', model: LLM_MODEL, ready: true },
    stt: { provider: 'DashScope Fun-ASR-Flash', ready: sttOk, error: sttErr },
  };
}

/**
 * voiceService.ts — ESP32 语音 → Fun-ASR-Flash → LLM → 指令执行
 *
 * 流程:
 *   收到 $VOICE: 帧 (WAV PCM 16kHz mono 16bit)
 *   → Base64 → DashScope Fun-ASR-Flash (同步 HTTP API)
 *   → qwen2.5:7b 解析意图
 *   → 匹配指令并执行
 *
 * ⚠ 前置条件:
 *   1. 环境变量 DASHSCOPE_API_KEY — 阿里云百炼 API Key
 *   2. 环境变量 DASHSCOPE_WORKSPACE_ID — 百炼业务空间 ID
 *   见 https://help.aliyun.com/zh/model-studio/get-api-key
 */
import { broadcast } from './websocket.js';

// ─── Config ────────────────────────────────────────────────
const LLM_MODEL = 'qwen2.5:7b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || '';
const WORKSPACE_ID = process.env.DASHSCOPE_WORKSPACE_ID || '';
const DASHSCOPE_URL = `https://${WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`;

export function getVoiceStatus() {
  const ok = !!DASHSCOPE_API_KEY && !!WORKSPACE_ID;
  return {
    ready: ok,
    error: ok ? '' : 'DASHSCOPE_API_KEY 或 WORKSPACE_ID 未配置',
  };
}

export function initVoiceService() {
  if (!DASHSCOPE_API_KEY) {
    console.warn('[voice] ⚠ DASHSCOPE_API_KEY 未设置 — 语音识别不可用');
  }
  if (!WORKSPACE_ID) {
    console.warn('[voice] ⚠ DASHSCOPE_WORKSPACE_ID 未设置 — 语音识别不可用');
  }
  if (DASHSCOPE_API_KEY && WORKSPACE_ID) {
    console.log('[voice] ✅ Fun-ASR-Flash 就绪');
  }
}

// ─── WAV header for raw PCM ─────────────────────────────────
function makeWavHeader(pcmLen: number, sampleRate = 16000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmLen, 40);
  return header;
}

// ─── Fun-ASR-Flash STT ──────────────────────────────────────
async function transcribe(wavBuffer: Buffer): Promise<string> {
  const base64 = wavBuffer.toString('base64');
  const dataUri = `data:audio/wav;base64,${base64}`;

  try {
    const resp = await fetch(DASHSCOPE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'disable',
      },
      body: JSON.stringify({
        model: 'fun-asr-flash-2026-06-15',
        input: {
          messages: [{
            role: 'user',
            content: [{
              type: 'input_audio',
              input_audio: { data: dataUri },
            }],
          }],
        },
        parameters: { format: 'wav', sample_rate: '16000' },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[voice] DashScope API ${resp.status}: ${errText.slice(0, 200)}`);
      return '';
    }

    const result = await resp.json() as any;
    return result?.output?.text || '';
  } catch (e) {
    console.error('[voice] DashScope 请求失败:', (e as Error).message);
    return '';
  }
}

// ─── LLM 意图解析 ────────────────────────────────────────────
const SYSTEM_PROMPT = `你是一个仓库物流机器人的指令解析器。
根据用户的语音输入，输出一个 JSON 指令。支持:

1. 取货: {"cmd":"pick","goods":"货物名或编号"}
2. 导航: {"cmd":"nav","target":"位置描述","x":0,"y":0}
3. 停止: {"cmd":"stop"}
4. 返回: {"cmd":"return"}
5. 未知: {"cmd":"unknown"}

示例:
"去A03货架取螺丝" → {"cmd":"pick","goods":"螺丝"}
"到坐标3,2位置" → {"cmd":"nav","target":"(3,2)","x":3,"y":2}
"停车" → {"cmd":"stop"}
"回原点" → {"cmd":"return"}

只输出 JSON，不要额外解释。`;

async function llmParseCommand(text: string): Promise<any> {
  try {
    const resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        stream: false,
      }),
    });
    const data = await resp.json() as any;
    const reply = data.message?.content || '';
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { cmd: 'unknown', raw: reply };
  } catch (e) {
    return { cmd: 'unknown', error: (e as Error).message };
  }
}

// ─── Command execution ──────────────────────────────────────
type VoiceCommandHandler = (cmd: any, originalText: string) => void;
let cmdHandler: VoiceCommandHandler | null = null;
export function onVoiceCommand(fn: VoiceCommandHandler) { cmdHandler = fn; }

// ─── Public API ─────────────────────────────────────────────

export async function processVoicePcm(pcm: Buffer, sampleRate = 16000) {
  const t0 = Date.now();

  /* Wrap raw PCM in WAV header, Base64, send to Fun-ASR-Flash */
  const wavBuffer = Buffer.concat([makeWavHeader(pcm.length, sampleRate), pcm]);

  console.log(`[voice] 收到 ${pcm.length}B PCM (${wavBuffer.length}B WAV), 识别中...`);

  const t1 = Date.now();
  const text = await transcribe(wavBuffer);
  console.log(`[voice] STT 耗时 ${Date.now() - t1}ms`);

  if (!text) {
    console.log('[voice] 未识别到语音');
    broadcast({ type: 'voice_status', text: '', status: 'no_speech' });
    return;
  }

  console.log(`[voice] 🎤 "${text}"`);

  const t2 = Date.now();
  const cmd = await llmParseCommand(text);
  console.log(`[voice] LLM 耗时 ${Date.now() - t2}ms → ${JSON.stringify(cmd)}`);

  broadcast({ type: 'voice_status', text, status: 'recognized', cmd });

  if (cmdHandler) cmdHandler(cmd, text);
}

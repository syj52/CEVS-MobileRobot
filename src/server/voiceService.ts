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
import { speak, isSpeaking } from './ttsService.js';
import { state } from '../state.js';
import { buildKnowledgeContext } from './knowledgeBase.js';

// ─── Config ────────────────────────────────────────────────
// DashScope 配置从 dashscope.ts 统一加载（env → CSV）
import { getApiKey, getDashScopeUrl, chatCompletion, getStatus } from './dashscope.js';

export function getVoiceStatus() {
  const st = getStatus();
  return { ready: st.stt.ready, error: st.stt.error };
}

export function initVoiceService() {
  const st = getStatus();
  if (st.stt.ready) {
    console.log(`[voice] ✅ STT(DashScope) + LLM(豆包) 已就绪`);
  } else {
    console.warn(`[voice] ⚠ STT 不可用: ${st.stt.error}`);
  }
  console.log(`[voice] LLM: ${st.llm.provider} / ${st.llm.model}`);
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
    const apiKey = getApiKey();
    const url = `${getDashScopeUrl()}/services/aigc/multimodal-generation/generation`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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

// ─── LLM 意图解析（积极人格 + 回复 + 指令）─────────────────────
const SYSTEM_PROMPT = `你是一个热情友好的仓库物流机器人指令解析器，名字叫"小E"。

根据用户的语音输入，输出一个 JSON 对象，包含热情回复和指令。

输出格式：
{
  "reply": "你对用户的热情回复，说明将执行的操作，使用语气词",
  "cmd": "pick 或 goto 或 nav 或 stop 或 return 或 path 或 continue 或 unknown",
  "goods": "货物名称（仅 cmd=pick 时）",
  "target": "地点名称（仅 cmd=goto 时，提取用户说的点位名，如接待区、充电站）",
  "x": 坐标X（仅 cmd=nav 时）,
  "y": 坐标Y（仅 cmd=nav 时）
  "path_id": 路径编号1-6（仅当 cmd=path 时）
}

支持的命令：
- 取货/去取 → cmd=pick，提取货物名称
- 去某个地点 → cmd=goto，提取地点名称（如"接待区""充电站""A点"）
- 导航/去某个位置 → cmd=nav，提取坐标
- 停止/停车 → cmd=stop
- 返回原点/回程 → cmd=return
- 走路径/执行路径/去货架取货/货架取货 → cmd=path，从货架编号提取 path_id（1-6）
  (例如"去货架6取货"→{reply:"好的，去货架6取货。",cmd:"path",path_id:6})
- 继续/返程/继续路径: cmd=continue，提取路径编号放入 path_id（1-6）
- 其他聊天 → cmd=unknown（回复要友善热情）

示例：
"带我去接待区" → {"reply":"好的，带您去接待区。","cmd":"goto","target":"接待区"}
"去货架6取货" → {"reply":"好的，去货架6取货。","cmd":"path","path_id":6}
"货架3取货" → {"reply":"好的，去货架3取货。","cmd":"path","path_id":3}
"到坐标3,2" → {"reply":"好的，去坐标3,2位置。","cmd":"nav","x":3,"y":2}
"停车" → {"reply":"收到，已停止。","cmd":"stop"}
"你好" → {"reply":"你好，我是小E，有什么可以帮你的？","cmd":"unknown"}

注意：只输出一个 JSON 对象，不要多余文字。回复控制在 20 字以内。`;

async function llmParseCommand(text: string): Promise<any> {
  try {
    // 注入 POI 信息
    const poiList = state.pois.map(p =>
      `  - ${p.name}${p.description ? ` (${p.description})` : ''}: 坐标(${p.coord_x}, ${p.coord_y})`
    ).join('\n');
    const poiContext = poiList ? `\n当前已知地点列表：\n${poiList}\n` : '';
    const kbContext = buildKnowledgeContext(text);

    const reply = await chatCompletion([
      { role: 'system', content: SYSTEM_PROMPT + poiContext + kbContext },
      { role: 'user', content: text },
    ]);
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { cmd: 'unknown', raw: reply };
  } catch (e) {
    console.error('[voice] LLM 解析失败:', (e as Error).message);
    return { cmd: 'unknown', error: (e as Error).message };
  }
}

// ─── Command execution ──────────────────────────────────────
type VoiceCommandHandler = (cmd: any, originalText: string) => void;
let cmdHandler: VoiceCommandHandler | null = null;
export function onVoiceCommand(fn: VoiceCommandHandler) { cmdHandler = fn; }

// ─── Public API ─────────────────────────────────────────────

export async function processVoicePcm(pcm: Buffer, sampleRate = 16000) {
  /* TTS 播放中 → 忽略语音（防止喇叭→麦克风→STT→LLM 死循环） */
  if (isSpeaking()) {
    console.log('[voice] ⏳ TTS 播放中，忽略语音输入');
    return;
  }

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

  // 朗读 LLM 的热情回复 (路径指令不朗读, 避免 TTS 音频挤断 TCP 导致路径中断)
  if (cmd.reply && cmd.cmd !== 'path') {
    console.log(`[voice] 🔊 TTS: "${cmd.reply}"`);
    speak(cmd.reply, 0.7).catch(e => console.warn('[voice] TTS fail:', e));
  }
}

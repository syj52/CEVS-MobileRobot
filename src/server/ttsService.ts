/**
 * ttsService.ts — Text-to-Speech: generates PCM audio and sends to ESP32
 *
 * Uses edge-tts (Python CLI) for high-quality Chinese TTS.
 * Install: pip install edge-tts
 *
 * Output: 16kHz 16-bit mono PCM (matching ESP32 I2S speaker format).
 */
import { spawn } from 'child_process';
import { join } from 'path';
import { execSync } from 'child_process';
import { TcpServer } from './tcp.js';

const SAMPLE_RATE = 16000;

function findEdgeTts(): string {
  for (const py of ['python', 'python3']) {
    try {
      const out = execSync(`"${py}" -m edge_tts --help 2>&1`, { timeout: 3000, stdio: 'pipe' });
      if (out.length > 0) return `${py} -m edge_tts`;
    } catch { /* not found */ }
  }
  return '';
}

const EDGE_TTS_CMD = findEdgeTts();

export function getTtsStatus() {
  return { ready: !!EDGE_TTS_CMD, engine: EDGE_TTS_CMD || '(not found: pip install edge-tts)' };
}

async function generatePcm(text: string): Promise<Buffer | null> {
  if (!EDGE_TTS_CMD) {
    console.warn('[tts] edge-tts not available — install: pip install edge-tts');
    return null;
  }
  return new Promise((resolve) => {
    /* edge-tts 默认输出 MP3，需要转成 16kHz 16-bit mono PCM。
       --format 在旧版本 edge-tts 中不支持，所以用 ffmpeg 转换。 */
    const [cmd, ...args] = EDGE_TTS_CMD.split(' ');
    args.push('--text', text, '--voice', 'zh-CN-XiaoxiaoNeural', '--rate', '+0%',
              '--write-media', '-', '--write-subtitles', 'none');
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    /* 用 ffmpeg 将 edge-tts 的输出转为 16kHz 16-bit mono PCM */
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-loglevel', 'error',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stdout.pipe(ffmpeg.stdin);

    const pcmChunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => pcmChunks.push(chunk));

    let ffmpegErr = '';
    ffmpeg.stderr.on('data', (d: Buffer) => { ffmpegErr += d.toString(); });

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) console.log(`[tts:edge] ${s}`);
    });
    proc.on('error', () => { resolve(null); });

    ffmpeg.on('close', (code) => {
      if (code !== 0 || pcmChunks.length === 0) {
        console.warn(`[tts] ffmpeg exit=${code}: ${ffmpegErr.trim()}`);
        resolve(null);
        return;
      }
      const pcm = Buffer.concat(pcmChunks);
      console.log(`[tts] PCM: ${pcm.length}B (${(pcm.length / SAMPLE_RATE / 2).toFixed(1)}s @ ${SAMPLE_RATE}Hz)`);
      resolve(pcm);
    });

    setTimeout(() => {
      if (!proc.killed) { proc.kill(); ffmpeg.kill(); resolve(null); }
    }, 20000);
  });
}

let tcpServer: TcpServer | null = null;
export function setTcpServer(srv: TcpServer) { tcpServer = srv; }

/** Scale int16 PCM by volume factor (0.0–1.0) */
function scaleVolume(pcm: Buffer, vol: number): Buffer {
  if (vol >= 1.0) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    const scaled = Math.round(s * vol);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i);
  }
  return out;
}

export async function speak(text: string, volume = 1.0): Promise<boolean> {
  if (!tcpServer) { console.warn('[tts] TCP server not set'); return false; }
  const pcm = await generatePcm(text);
  if (!pcm || pcm.length === 0) return false;
  const out = scaleVolume(pcm, volume);
  const tag = (volume < 1.0) ? ` @ ${Math.round(volume * 100)}%` : '';
  const header = Buffer.from(`$TTS:${out.length}\r\n`);
  tcpServer.sendToAllRaw(Buffer.concat([header, out]));
  console.log(`[tts] Sent ${out.length}B TTS audio to ESP32${tag}`);
  return true;
}

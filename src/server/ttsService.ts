/**
 * ttsService.ts — Text-to-Speech: Windows SAPI → PCM → ESP32
 *
 * 使用 Windows 原生 SAPI 离线合成中文语音，零网络依赖。
 * 每条 TTS 发送后强制冷却，防止 TCP 粘包导致 ESP32 行缓冲错乱。
 */
import { spawn } from 'child_process';
import { TcpServer } from './tcp.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SAMPLE_RATE = 16000;
const TMP_PY = path.join(os.tmpdir(), `cevs_tts.py`);

// ─── TTS 冷却（防止声反馈 + TCP 粘包）─────────────────────────
let _coolUntil = 0;
/** TTS 是否正在冷却中（麦克风输入在此期间被忽略） */
export function isSpeaking(): boolean {
  return Date.now() < _coolUntil;
}

const PY_SCRIPT = `
import sys, os, tempfile, time
wav = os.path.join(tempfile.gettempdir(), 'cevs_tts_' + str(int(time.time()*1000)) + '.wav')
try:
    import win32com.client
    voice = win32com.client.Dispatch('SAPI.SpVoice')
    stream = win32com.client.Dispatch('SAPI.SpFileStream')
    stream.Open(wav, 3, False)
    voice.AudioOutputStream = stream
    voice.Speak(sys.argv[1], 0)
    stream.Close()
    with open(wav, 'rb') as f:
        sys.stdout.buffer.write(f.read())
except Exception as e:
    sys.stderr.write('SAPI_ERROR:' + str(e))
    sys.exit(1)
finally:
    try: os.remove(wav)
    except: pass
`;

try { fs.writeFileSync(TMP_PY, PY_SCRIPT, 'utf-8'); } catch {}

async function generatePcm(text: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const proc = spawn('python', [TMP_PY, text], { stdio: ['ignore', 'pipe', 'pipe'] });
    const wavChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => wavChunks.push(c));
    let errMsg = '';
    proc.stderr.on('data', (c: Buffer) => { errMsg += c.toString(); });
    proc.on('close', (code) => {
      if (code !== 0 || wavChunks.length === 0) {
        if (errMsg) console.warn(`[tts:sapi] ${errMsg.trim()}`);
        resolve(null);
        return;
      }
      const wav = Buffer.concat(wavChunks);
      const ff = spawn('ffmpeg', [
        '-f', 'wav', '-i', 'pipe:0',
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
        '-loglevel', 'error', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      ff.stdin.write(wav);
      ff.stdin.end();
      const pcm: Buffer[] = [];
      ff.stdout.on('data', (c: Buffer) => pcm.push(c));
      let ferr = '';
      ff.stderr.on('data', (c: Buffer) => { ferr += c.toString(); });
      ff.on('close', (fc) => {
        if (fc !== 0 || pcm.length === 0) {
          console.warn(`[tts] ffmpeg: ${ferr.trim()}`);
          resolve(null);
          return;
        }
        resolve(Buffer.concat(pcm));
      });
    });
    setTimeout(() => { if (!proc.killed) { proc.kill(); resolve(null); } }, 15000);
  });
}

// ─── 发送到 ESP32 ─────────────────────────────────────────

let tcpServer: TcpServer | null = null;
export function setTcpServer(srv: TcpServer) { tcpServer = srv; }

function scaleVolume(pcm: Buffer, vol: number): Buffer {
  if (vol >= 1.0) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * vol))), i);
  }
  return out;
}

export async function speak(text: string, volume = 1.0): Promise<boolean> {
  if (!tcpServer) { console.warn('[tts] TCP not set'); return false; }
  // 立即设冷却，防止 PCM 生成+ESP32缓存排空期间的麦克风音频被处理
  _coolUntil = Date.now() + 12000;
  const pcm = await generatePcm(text);
  if (!pcm || pcm.length === 0) return false;
  const out = scaleVolume(pcm, volume);

  // 分块发送：先发 $TTS: 头，再发 4KB 一块 + 10ms 间隔
  // 防止 SDIO 缓冲溢出 crash (assert sdio_rx_get_buffer)
  const CHUNK = 4096;
  tcpServer.sendToAllRaw(Buffer.from(`$TTS:${out.length}\r\n`));

  let offset = 0;
  while (offset < out.length) {
    const end = Math.min(offset + CHUNK, out.length);
    tcpServer.sendToAllRaw(out.subarray(offset, end));
    offset = end;
    if (offset < out.length) await new Promise(r => setTimeout(r, 10));
  }

  console.log(`[tts] Sent ${out.length}B in ${Math.ceil(out.length/CHUNK)} chunks`);

  // 冷却：播放时长 + 8s
  _coolUntil = Date.now() + Math.round(out.length / 32) + 8000;
  return true;
}

export function getTtsStatus() {
  return { ready: true, engine: 'Windows SAPI (离线)' };
}

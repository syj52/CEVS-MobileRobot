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
    const [cmd, ...args] = EDGE_TTS_CMD.split(' ');
    args.push('--text', text, '--voice', 'zh-CN-XiaoxiaoNeural', '--rate', '+0%', '--write-media', '-', '--write-subtitles', 'none');
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) { console.warn(`[tts] edge-tts exit=${code}`); resolve(null); return; }
      const wavBuf = Buffer.concat(chunks);
      const dataIdx = wavBuf.indexOf(Buffer.from('data'));
      if (dataIdx < 0) { resolve(wavBuf); return; }
      const pcmOffset = dataIdx + 8;
      const pcmLen = wavBuf.readUInt32LE(dataIdx + 4);
      let pcm = wavBuf.subarray(pcmOffset, pcmOffset + pcmLen);
      const sr = wavBuf.readUInt32LE(24);
      if (sr > SAMPLE_RATE) {
        const ratio = Math.round(sr / SAMPLE_RATE);
        const newLen = Math.floor(pcm.length / ratio / 2) * 2;
        const down = Buffer.alloc(newLen);
        for (let i = 0; i < newLen / 2; i++) down.writeInt16LE(pcm.readInt16LE(i * ratio * 2), i * 2);
        pcm = down;
        console.log(`[tts] Resampled ${sr}Hz → ${SAMPLE_RATE}Hz (ratio=${ratio})`);
      }
      console.log(`[tts] ${(pcm.length / SAMPLE_RATE / 2).toFixed(1)}s TTS (${pcm.length}B PCM)`);
      resolve(pcm);
    });
    proc.stderr.on('data', (d: Buffer) => { const s = d.toString().trim(); if (s) console.log(`[tts:edge] ${s}`); });
    setTimeout(() => { if (!proc.killed) { proc.kill(); resolve(null); } }, 15000);
  });
}

let tcpServer: TcpServer | null = null;
export function setTcpServer(srv: TcpServer) { tcpServer = srv; }

export async function speak(text: string): Promise<boolean> {
  if (!tcpServer) { console.warn('[tts] TCP server not set'); return false; }
  const pcm = await generatePcm(text);
  if (!pcm || pcm.length === 0) return false;
  const header = Buffer.from(`$TTS:${pcm.length}\r\n`);
  tcpServer.sendToAllRaw(Buffer.concat([header, pcm]));
  console.log(`[tts] Sent ${pcm.length}B TTS audio to ESP32`);
  return true;
}

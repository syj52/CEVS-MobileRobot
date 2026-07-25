#!/usr/bin/env python3
"""
whisper_server.py — 常驻 Whisper 语音识别进程

模型只加载一次, 之后循环从 stdin 读取 WAV 路径, 输出识别文字到 stdout。
避免每次转录都重新加载模型 (39MB, 耗时数秒)。

协议:
    stdin:  每行一个 WAV 文件路径
    stdout: 每行一个识别结果 (JSON: {"text": "..."})
    stderr: 状态/错误日志

用法 (Node.js):
    spawn('python', ['scripts/whisper_server.py', 'tiny'])
"""
import sys
import os
import json

os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
# 限制 Whisper 只用 2 个线程, 避免吃满 CPU 饿死 Node 服务器和浏览器渲染
os.environ.setdefault('OMP_NUM_THREADS', '2')

import whisper
import torch
try:
    torch.set_num_threads(2)
except Exception:
    pass

def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else 'tiny'
    sys.stderr.write(f"[whisper] loading model '{model_name}'...\n")
    sys.stderr.flush()

    model = whisper.load_model(model_name)

    sys.stderr.write("[whisper] ready\n")
    sys.stderr.flush()

    for line in sys.stdin:
        wav_path = line.strip()
        if not wav_path:
            continue
        try:
            result = model.transcribe(wav_path, language='zh', fp16=False)
            text = result['text'].strip()
            sys.stdout.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({"text": "", "error": str(e)}) + "\n")
            sys.stdout.flush()
            sys.stderr.write(f"[whisper] error: {e}\n")
            sys.stderr.flush()


if __name__ == '__main__':
    main()

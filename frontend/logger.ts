const LEVELS: Record<string, { label: string; color: string }> = {
  info:   { label: 'INFO',  color: '#00ccff' },
  warn:   { label: 'WARN',  color: '#ffaa00' },
  error:  { label: 'ERROR', color: '#ff4444' },
  status: { label: 'STAT',  color: '#44ff88' },
  llm:    { label: 'LLM',   color: '#cc88ff' },
};

class Logger {
  private container: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private maxEntries = 200;
  private filters: Record<string, boolean> = {};
  private pending: Array<{ level: string; time: string; message: string }> = [];
  private flushScheduled = false;

  constructor() {
    Object.keys(LEVELS).forEach(k => (this.filters[k] = true));
  }

  bind(container: HTMLElement, list: HTMLElement) {
    this.container = container;
    this.list = list;
  }

  private write(level: string, message: string) {
    const t = new Date();
    const time = t.toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${LEVELS[level]?.label || level}] ${message}`);
    if (!this.list) return;
    this.pending.push({ level, time, message });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  private flush() {
    this.flushScheduled = false;
    if (!this.list || this.pending.length === 0) return;
    const frag = document.createDocumentFragment();
    for (const { level, time, message } of this.pending) {
      const el = document.createElement('div');
      el.dataset.level = level;
      const cfg = LEVELS[level];
      const visible = this.filters[level] !== false;
      el.style.cssText = `font-size:11px;padding:1px 6px;line-height:1.6;color:${cfg?.color || '#ccc'};border-bottom:1px solid rgba(255,255,255,0.05);word-break:break-all;font-family:monospace;${visible ? '' : 'display:none;'}`;
      el.textContent = `[${time}][${cfg?.label || level}] ${message}`;
      frag.appendChild(el);
    }
    this.pending.length = 0;
    this.list.appendChild(frag);
    while (this.list.children.length > this.maxEntries) {
      this.list.removeChild(this.list.firstChild!);
    }
    this.container!.scrollTop = this.container!.scrollHeight;
  }

  info(m: string)    { this.write('info', m); }
  warn(m: string)    { this.write('warn', m); }
  error(m: string)   { this.write('error', m); }
  status(m: string)  { this.write('status', m); }
  llm(m: string)     { this.write('llm', `🤖 ${m}`); }
  llmReply(m: string) { this.write('llm', `🤖 → ${m}`); }
}

export const logger = new Logger();

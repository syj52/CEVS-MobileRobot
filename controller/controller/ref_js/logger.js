/**
 * 日志模块 — 为配套 LLM 实时场景分析预留接口
 *
 * 用法：
 *   import { logger } from './logger.js';
 *   logger.info('地图加载完成');
 *   logger.warn('目标点不可达');
 *   logger.error('导航失败');
 *
 * LLM 集成（未来）：
 *   logger.llm('前方有障碍物', imageData?)
 *   可扩展为将当前场景截图 + 提示词发送至 LLM API，
 *   并将分析结果追加到日志面板中。
 */

const LEVELS = {
    info:  { label: 'INFO',  color: '#00ccff' },
    warn:  { label: 'WARN',  color: '#ffaa00' },
    error: { label: 'ERROR', color: '#ff4444' },
    status:{ label: 'STAT',  color: '#44ff88' },
    llm:   { label: 'LLM',   color: '#cc88ff' },
};

class Logger {
    constructor() {
        this._container = null;
        this._list = null;
        this._maxEntries = 200;
        this._boundFn = null; // 预留 LLM 回调
        this._filters = {};   // { level: true/false }
        // 默认全部显示
        Object.keys(LEVELS).forEach(k => { this._filters[k] = true; });
    }

    /**
     * 绑定日志面板 DOM 元素（由页面初始化时调用）
     */
    bind(container, list) {
        this._container = container;
        this._list = list;
        this._renderFilterUI();
    }

    /**
     * 在面板标题栏下方渲染过滤器行
     */
    _renderFilterUI() {
        if (!this._container) return;
        // 避免重复创建
        let row = this._container.querySelector('.log-filter-row');
        if (!row) {
            row = document.createElement('div');
            row.className = 'log-filter-row';
            row.style.cssText = 'display:flex;gap:4px;padding:2px 6px;border-bottom:1px solid rgba(255,255,255,0.08);';
            const headerEl = this._container.querySelector('#log-header');
            headerEl?.parentNode?.insertBefore(row, headerEl?.nextSibling || null);
        }
        row.innerHTML = '';
        Object.entries(LEVELS).forEach(([key, cfg]) => {
            const label = document.createElement('label');
            label.style.cssText = 'font-size:10px;color:#aaa;cursor:pointer;display:flex;align-items:center;gap:2px;user-select:none;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = this._filters[key];
            cb.style.cssText = 'margin:0;accent-color:' + cfg.color;
            cb.addEventListener('change', () => {
                this._filters[key] = cb.checked;
                this._updateVisibility();
            });
            label.appendChild(cb);
            label.appendChild(document.createTextNode(cfg.label));
            row.appendChild(label);
        });
    }

    /**
     * 根据当前过滤器切换条目的显示/隐藏
     */
    _updateVisibility() {
        if (!this._list) return;
        const children = this._list.children;
        for (let i = 0; i < children.length; i++) {
            const el = children[i];
            const level = el.dataset?.level;
            el.style.display = (level && this._filters[level] === false) ? 'none' : '';
        }
    }

    /**
     * 注册 LLM 处理函数（未来使用）
     * fn(message, imageData?) → string
     */
    setLLMHandler(fn) {
        this._boundFn = fn;
    }

    /** 通用日志写入 */
    _write(level, message) {
        const t = new Date();
        const time = t.toLocaleTimeString('zh-CN', { hour12: false });
        const entry = document.createElement('div');
        entry.dataset.level = level;
        entry.style.cssText = `font-size:11px;padding:1px 6px;line-height:1.6;color:${
            LEVELS[level]?.color || '#ccc'
        };border-bottom:1px solid rgba(255,255,255,0.05);word-break:break-all;font-family:monospace;${
            this._filters[level] === false ? 'display:none;' : ''
        }`;
        entry.textContent = `[${time}][${LEVELS[level]?.label || level}] ${message}`;
        if (this._list) {
            this._list.appendChild(entry);
            while (this._list.children.length > this._maxEntries) {
                this._list.removeChild(this._list.firstChild);
            }
            this._container.scrollTop = this._container.scrollHeight;
            const badge = document.getElementById('log-badge');
            const visible = Array.from(this._list.children).filter(e => e.style.display !== 'none').length;
            if (badge) badge.textContent = `${this._list.children.length}`;
        }
        console.log(`[${LEVELS[level]?.label || level}] ${message}`);
    }

    info(m)    { this._write('info', m); }
    warn(m)    { this._write('warn', m); }
    error(m)   { this._write('error', m); }
    status(m)  { this._write('status', m); }

    /**
     * LLM 日志 — 目前仅记录消息，未来可扩展为：
     *   1. 截取当前渲染画面 → base64
     *   2. 调用 this._boundFn(message, imageData)
     *   3. 将 LLM 返回的分析追加到日志
     */
    llm(message, imageData) {
        this._write('llm', `🤖 ${message}`);
        if (this._boundFn) {
            // 未来在此处调用异步 LLM API
            // this._boundFn(message, imageData).then(reply => {
            //   this._write('llm', `🤖 → ${reply}`);
            // });
        }
    }

    /** 手动模拟 LLM 输出（测试用） */
    llmReply(message) {
        this._write('llm', `🤖 → ${message}`);
    }
}

export const logger = new Logger();

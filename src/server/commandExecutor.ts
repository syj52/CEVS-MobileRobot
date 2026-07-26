/**
 * commandExecutor.ts — 统一指令执行器
 *
 * 语音识别和文字聊天共享同一套指令执行逻辑。
 */
import { state } from '../state.js';
import { navApi } from '../api/navigation.js';
import { startTagNav } from '../api/tagNav.js';
import { pickDirect } from '../api/goods.js';
import { broadcast } from './websocket.js';

/** TCP 发送回调（由 main.ts 注入） */
let sendRawToEsp: ((msg: string) => void) | null = null;
export function setCommandSender(fn: (msg: string) => void) { sendRawToEsp = fn; }

export interface ParsedCmd {
  cmd: string;
  reply?: string;
  goods?: string;
  target?: string;
  x?: number;
  y?: number;
  path_id?: number | string;
}

/**
 * 执行 LLM 解析出的指令
 * @param cmd   LLM 返回的指令对象
 * @param text  原始用户输入（用于广播）
 * @returns     是否成功执行了指令
 */
export function executeCommand(cmd: ParsedCmd, text?: string): boolean {
  let executed = false;

  switch (cmd.cmd) {
    case 'pick':
      console.log(`[exec] → pick: ${cmd.goods}`);
      pickDirect(cmd.goods || '');
      executed = true;
      break;

    case 'goto':
      console.log(`[exec] → goto: ${cmd.target}`);
      (() => {
        const target = (cmd.target || '').toLowerCase();
        const poi = state.pois.find(p =>
          p.name.toLowerCase() === target ||
          p.name.toLowerCase().includes(target) ||
          (p.description || '').toLowerCase().includes(target)
        );
        if (poi) {
          startTagNav([{ x: poi.coord_x, y: poi.coord_y }]);
          state.updateRobot({ status: 'moving' });
          // 写回坐标供前端画地图
          cmd.x = poi.coord_x;
          cmd.y = poi.coord_y;
          executed = true;
        } else {
          console.log(`[exec] goto: POI "${cmd.target}" not found`);
        }
      })();
      break;

    case 'nav':
      console.log(`[exec] → nav: (${cmd.x}, ${cmd.y})`);
      startTagNav([{ x: cmd.x || 0, y: cmd.y || 0 }]);
      state.updateRobot({ status: 'moving' });
      executed = true;
      break;

    case 'path':
      console.log(`[exec] → path: ${cmd.path_id}`);
      (() => {
        const n = typeof cmd.path_id === 'number' ? cmd.path_id : parseInt(cmd.path_id || '0');
        if (n >= 1 && n <= 6 && sendRawToEsp) {
          sendRawToEsp(`!PATH:${n}#\r\n`);
          state.updateRobot({ status: 'moving' });
          executed = true;
        }
      })();
      break;

    case 'stop':
      console.log('[exec] → stop');
      navApi.stop();
      state.updateRobot({ status: 'idle' });
      executed = true;
      break;

    case 'return':
      console.log('[exec] → return');
      startTagNav([{ x: 0, y: 0 }]);
      state.updateRobot({ status: 'moving' });
      executed = true;
      break;
    case 'continue':
      console.log('[exec] -> continue (PATH continue)');
      if (sendRawToEsp) {
        sendRawToEsp("!PATH:0#\r\n");
        state.updateRobot({ status: 'moving' });
        executed = true;
      }
      break;

    default:
      console.log(`[exec] Ignored: ${cmd.cmd}`);
  }

  // 广播执行状态给前端
  if (text) {
    broadcast({ type: 'voice_status', text, status: 'executed', cmd });
  }

  return executed;
}

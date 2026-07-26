/**
 * knowledgeBase.ts — 内置知识库
 *
 * 仓库、机器人、系统操作等常见问答。
 * 关键词匹配 → 注入 LLM 上下文。
 */
interface Entry {
  category: string;
  keywords: string[];
  content: string;
}

const KNOWLEDGE: Entry[] = [
  {
    category: '退货流程',
    keywords: ['退货', '退换', '返品', '退回', '退', '换货', '退料', '退货单'],
    content: `## 退货流程
1. 填写退货单：扫描货品条码，填写退货原因。
2. 质检确认：退货部门检查货品完整性，判断可重新入库或需报废。
3. 重新上架或隔离：质检通过由机器人自动运回对应货位，需维修的送入待修区。
4. WMS更新库存：系统自动更新库存数量，退货单完成后状态变为"已完成"。
5. 退货货品与正常库存分开存放避免混淆。`,
  },
  {
    category: '机器人操作',
    keywords: ['机器人', '小车', 'AGV', '操作', '使用', '怎么用', '启动', '开机', '控制', '遥控', '小E'],
    content: `## 机器人基本操作
1. 启动：打开底盘电源，等 ESP32-P4 自检完成（约15秒），OLED 显示"Ready"即就绪。
2. 语音指令：直接说出需求，如"取货"或"带我去XX"。
3. Web控制台：浏览器打开中控地址，在"对话"面板输入文字指令。
4. 手动控制：在"手动控制"面板用方向键或 WASD 控制。
5. 紧急停止：点击"紧急停止"按钮或说"停车"。`,
  },
  {
    category: '系统功能',
    keywords: ['系统', '功能', '平台', '数字孪生', '3D', '监控', '管理', '全息'],
    content: `## 系统功能
- 3D数字孪生：Three.js 三维重建，实时显示机器人位置。
- 自然语言交互：语音/文字指令，系统自动匹配货位并规划路径。
- 自主导航：A*全局路径规划 + AprilTag 定位。
- POI管理：在"POI"面板增删货物标记，自动同步。`,
  },
  {
    category: '货物存取',
    keywords: ['存取', '取货', '放货', '拿', '搬', '运', '放', '归位', '归还'],
    content: `## 货物存取操作
1. 取货：说"取货"或提供货号，系统自动查货位、规划路径、前往取货。
2. 导航：说"带我去XX"查找对应 POI 位置并导航。
3. 任务查询：说"当前任务是什么"系统播报状态。`,
  },
  {
    category: '货品查询',
    keywords: ['查询', '查', '在哪里', '位置', '货架', '在哪', '找', '库存', '货号', 'point'],
    content: `## 货品查询方式
1. 名称查询：直接说地点名称，系统在 POI 列表中匹配坐标。
2. 坐标查询：系统内置 POI 可通过前端"POI"面板查看和编辑。
3. 如查询不到，系统提示"未找到该地点，请确认名称"。`,
  },
  {
    category: '安全机制',
    keywords: ['安全', '紧急', '急停', '避障', '碰撞', '故障', '报警', '危险', '停止', '停'],
    content: `## 安全机制
1. 三级安全：云端规划 → 边缘核验 → 底盘硬制动，三层独立互不依赖。
2. 超声波避障：障碍物<30cm时硬件直连毫秒级切断动力。
3. 急停按钮：红色按钮物理断电，独立于任何软件逻辑。
4. 电量保护：<10%时自动停止所有运动任务。
5. 通信校验：连续3帧丢失自动停车。`,
  },
];

/** 关键词匹配，返回 topK 条知识 */
export function searchKnowledge(query: string, topK = 2): Entry[] {
  const q = query.toLowerCase();
  const scored = KNOWLEDGE.map(entry => {
    let score = 0;
    for (const kw of entry.keywords) {
      if (q.includes(kw)) score += kw.length;
      // 部分匹配加分
      for (let i = 2; i < kw.length; i++) {
        if (q.includes(kw.slice(0, i))) score += 0.5;
      }
    }
    return { entry, score };
  });
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.entry);
}

/** 构建知识上下文（供 LLM system prompt 注入） */
export function buildKnowledgeContext(query: string): string {
  const matched = searchKnowledge(query);
  if (matched.length === 0) return '';
  const ctx = matched.map(e => `[${e.category}] ${e.content}`).join('\n\n');
  return `\n相关知识库内容：\n${ctx}\n`;
}

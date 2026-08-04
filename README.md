# 婊子打手召唤系统 · 酒馆化

暗黑洛可可 · 玄幻浮华风格的成人向卡牌召唤对战游戏，**全面酒馆化**为 SillyTavern 生态的 LLM 聊天驱动前端原型（纯前端，无后端）。

## 启动

```bash
npx http-server -p 8092 -c-1
# 或 python -m http.server 8092
```

浏览器打开 `http://localhost:8092`。

## 目录结构

```
├── index.html                 # 酒馆大堂（侧栏+聊天流+输入坞）+ 五游戏视图 + 九座模态框
├── css/
│   ├── style.css              # 暗黑洛可可设计系统（墨黑/浓金/胭脂红）
│   └── tavern.css             # 酒馆主题（SillyTavern 风格聊天界面）
├── js/
│   ├── data.js                # 12 角色卡（含 SillyTavern 字段）/ 世界书种子 / 叙事语料
│   ├── app.js                 # 聊天引擎 + 游戏联动（召唤/战斗/处置/图鉴/天赋）
│   └── sillytavern/           # ★ SillyTavern 生态核心（遵循 tavernlike skill 规范）
│       ├── types.js           #   类型：Lorebook/Preset/ChatSession/变量/默认值
│       ├── database.js        #   原生 IndexedDB 持久化（chats/lorebooks/presets/settings）
│       ├── lorebook-engine.js #   关键词扫描（primary/secondary keys、selective、递归）
│       ├── prompt-assembler.js#   prompt_order 有序组装 + {{user}}/{{char}} 宏 + 变量注入
│       ├── variables.js       #   <var> 标签提取 / 深合并 / 截断回档 / 分支 / ParsedTags
│       ├── stream-parser.js   #   流式 XML 标签状态机（maintext/option/sum/vars/thinking）
│       └── store.js           #   中央 Store：多会话/消息操作/世界书/预设/设置
└── favicon.svg
```

## SillyTavern 生态（来自 tavernlike skill）

| 能力 | 说明 |
|---|---|
| **角色卡** | 12 位角色各自携带 description / personality / scenario / exampleDialogue / greetings（多开场白可 swipe） |
| **多会话聊天** | 每角色独立会话线程，IndexedDB 持久化，刷新不丢 |
| **世界书 Lorebook** | 关键词触发知识注入：角色名/技能/位面/游戏术语（墨珠、召唤台、处置室…），支持编辑/新增/恒定条目 |
| **预设 Preset** | 采样参数（温度/上下文/最大回复）+ Main Prompt + prompt_order 拖序（10 块有序组装） |
| **变量系统** | 会话变量（战意/顺从度/欲望/好感度/墨珠）注入 `[当前状态]` 提示词；支持 `<var>` 标签自动更新与手动编辑 |
| **GameView 模式** | 远端灵枢模式下解析 `<maintext>/<option>/<sum>/<vars>/<thinking>` 六标签：正文+选项 UI、思考折叠 |
| **流式解析器** | 状态机逐字符解析（opaque thinking、未闭合兜底、纯文本透传） |
| **消息操作** | 每条消息：编辑并重新生成（截断+变量回档）、删除后续、从此分支（新会话） |
| **Swipe** | 每条回复支持「换一种说法」切换候选 |
| **重 roll / 继续** | 顶栏操作：重新生成上一条 / 续写 |

## 游戏机制（以聊天事件卡驱动）

```
酒馆大堂（聊天）                    ── 左侧角色卡开席，快捷回复条，输入坞
   │ 聊天触发/事件卡按钮
   ▼
召唤台 ── 回响之契 ── 卡牌翻转 ── 缔约 ──►「新卡入册」事件卡 + 自动开新会话
对战台 ── 先手指定 ── 月相沙盘 ── 胜利 ─►「战利品待裁决」事件卡 ──► 裁决之匣
   └────────── 裁决落定 ──────────►「裁决落定」事件卡 ──► 处置室
图鉴 / 天赋 / 处置室                ── 底部导航随时可入
```

- 战斗过程（技能命中/受创/月相/迷雾揭示）以「系统消息」实时写入当前会话
- 快捷回复条自动感知上下文：有待裁决战败时浮现「开启裁决之匣」事件入口
- 游戏状态 ↔ 会话变量双向同步：裁决/战斗改变情绪值，`<var>` 标签回写游戏

## 灵枢（LLM）接入

顶栏齿轮 → 灵枢秘藏：
- **模拟回响**（默认）：内置叙事引擎即时织就（角色专属关键词应答、好感度情绪基调、swipe 候选）
- **远端灵枢**：OpenAI 兼容端点流式接入，输出按 `DEFAULT_FORMAT_PROMPT` 的六标签约定解析为 GameView；失联自动回退

## 微交互

悬停金描边+光点、消息气泡流式打字+光标、swipe 淡入、模态翻页、输入坞墨迹涟漪、事件卡金/猩红双色、窄屏侧栏抽屉化、`prefers-reduced-motion` 降级。全部动画走 transform/opacity，零外链资源。

/* ═══════════════════════════════════════════════════════════════
   SillyTavern Web 生态 · 核心类型（vanilla 版）
   遵循 tavernlike /sillytavern-web skill 规范
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const USER_ROLE = 'user';

const POSITIONS = ['before_char','after_char','before_example','after_example','at_depth','example_msg_top','example_msg_bottom','outlet'];

/** 世界书条目（Lorebook Entry） */
function createDefaultEntry(over = {}) {
  return {
    id: 'e' + Math.random().toString(36).slice(2, 9),
    keys: [],
    secondaryKeys: [],
    content: '',
    comment: '',
    order: 100,
    position: 'before_char',
    depth: 0,
    role: 0,
    selective: false,
    selectiveLogic: 'and_any',
    constant: false,
    probability: 100,
    useProbability: false,
    addMemo: false,
    sticky: 0, cooldown: 0, delay: 0, weight: 0,
    scanDepth: 0,
    caseSensitive: false,
    matchWholeWords: false,
    excludeRecursion: false, preventRecursion: false,
    useGroupScoring: false,
    matchPersonaDescription: false, matchCharacterDescription: false,
    matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
    matchScenario: false, matchCreatorNotes: false,
    group: '',
    decorators: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
    ...over,
  };
}

/** 世界书（Lorebook） */
function createDefaultLorebook(over = {}) {
  return {
    id: 'lb' + Math.random().toString(36).slice(2, 9),
    name: '未命名的世界书',
    description: '',
    entries: [],
    recursiveScanning: false,
    caseSensitive: false,
    matchWholeWords: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

/** 预设（Chat Preset）— 存 SillyTavern 风格字段 */
const DEFAULT_PROMPT_ORDER = [
  { identifier: 'main', name: 'Main Prompt', role: 'system', enabled: true },
  { identifier: 'worldInfoBefore', name: 'World Info (Before)', role: 'system', enabled: true },
  { identifier: 'charDescription', name: 'Character Description', role: 'system', enabled: true },
  { identifier: 'charPersonality', name: 'Character Personality', role: 'system', enabled: true },
  { identifier: 'scenario', name: 'Scenario', role: 'system', enabled: true },
  { identifier: 'personaDescription', name: 'Persona Description', role: 'system', enabled: true },
  { identifier: 'dialogueExamples', name: 'Dialogue Examples', role: 'system', enabled: true },
  { identifier: 'chatHistory', name: 'Chat History', role: 'system', enabled: true },
  { identifier: 'worldInfoAfter', name: 'World Info (After)', role: 'system', enabled: true },
  { identifier: 'groupNudge', name: 'Group Nudge', role: 'system', enabled: true },
];

const DEFAULT_FORMAT_PROMPT = `你必须严格按照以下 XML 标签格式输出回复，不要使用 Markdown 包裹：
<thinking>……</thinking>     ← 可选；内部任何字符都视为思考过程，不被解析
<maintext>……</maintext>     ← 必填；本回合的剧情正文，可多段，保留换行
<option>选项 A
选项 B
选项 C</option>              ← 必填；至少 2 项，每行一个
<sum>……</sum>               ← 必填；本回合一句话总结
<vars>{ "墨珠": 4, "顺从度": 55 }</vars>   ← 选填；JSON 深合并`;

const DEFAULT_TAGS = ['maintext','option','sum','vars','thinking','think'];
const DEFAULT_OPAQUE_TAGS = ['thinking','think'];

function createDefaultPreset(over = {}) {
  return {
    id: 'pre' + Math.random().toString(36).slice(2, 9),
    name: '默认预设',
    description: '暗黑洛可可 · 玄幻浮华 · 中文角色扮演',
    settings: {
      temp_openai: 0.85,
      freq_pen_openai: 0.2,
      pres_pen_openai: 0.1,
      top_p_openai: 0.9,
      top_k_openai: 0,
      min_p_openai: 0,
      repetition_penalty_openai: 1,
      openai_max_context: 4096,
      openai_max_tokens: 2048,
      stream_openai: false,
      chat_completion_source: 'openai',
      openai_model: '',
      main: '你正在扮演 {{char}}，与 {{user}} 进行一场发生在诸界酒馆中的对话。请以她的口吻回应，保持暗黑洛可可的雅致与欲望张力。',
      prompts: [],
      prompt_order: DEFAULT_PROMPT_ORDER.map(p => ({ ...p })),
      ...(over.settings || {}),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

/** 应用设置 */
function createDefaultSettings(over = {}) {
  return {
    key: 'st-settings',
    api: { baseUrl: '', apiKey: '', model: '', timeout: 60000 },
    apiMode: 'single',
    activePresetId: null,
    activeLorebookIds: [],
    userName: '契约者',
    characterName: 'AI',
    theme: 'dark',
    language: 'zh',
    autoSave: true,
    autoSaveInterval: 30,
    uiMode: 'game',
    customTags: [...DEFAULT_TAGS],
    formatPromptTemplate: DEFAULT_FORMAT_PROMPT,
    thinkingDisplay: 'fold',
    ...over,
    api: { ...(createDefaultSettings.defaultApi), ...(over.api || {}) },
  };
}
createDefaultSettings.defaultApi = { baseUrl: '', apiKey: '', model: '', timeout: 60000 };

/** 会话消息 */
function createMessage(role, content, extra = {}) {
  return {
    id: 'm' + Math.random().toString(36).slice(2, 10),
    role,           // 'system' | 'user' | 'assistant'
    content,
    timestamp: Date.now(),
    variables: null,     // 该消息后的变量快照
    parsed: null,        // v3: 解析后的标签（maintext/options/sum/vars/thinking）
    swipe: [],           // v3: 候选回复（swipe）
    swipeIdx: -1,
    kind: null,          // 'chat' | 'event' | 'sys'
    event: null,         // 事件卡数据 {type, icon, title, body, actions}
    ...extra,
  };
}

/** 会话（Chat Session） */
function createChatSession(over = {}) {
  const { id, ...rest } = over || {};
  return {
    id: id || 'c' + Math.random().toString(36).slice(2, 10),
    name: '新对话',
    messages: [],
    characterId: null,       // 关联角色卡
    characterName: '',
    userName: '契约者',
    presetId: null,
    lorebookIds: [],
    variables: {},           // 游戏状态变量（墨珠/顺从度/欲望/战意/好感度…）
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...rest,
  };
}

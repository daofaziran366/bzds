/* ============================================================
   腐化 · SillyTavern 集成内核 ① 核心层
   ------------------------------------------------------------
   照搬 skill sillytavern-web：
     templates/react/sillytavern/types.ts          （类型常量 / 默认工厂）
     templates/react/sillytavern/editor-utils.ts   （条目/书本纯函数）
     templates/react/sillytavern/variables.ts      （会话回滚 / 变量块格式化）
     templates/react/sillytavern/importer.ts       （position / logic 映射表）

   刻意偏离：skill 的 <vars> JSON 深合并通道（vars-merger.ts 与
   extractVariables）已整体移除——变量操作由游戏层 js/vars.js 的
   <set> 命令协议承担（白名单校验、直接改写游戏状态）。

   本层无 DOM、无网络、无存储副作用。
   ============================================================ */
(function () {
  'use strict';

  var C = {};

  /* ============================================================
     0) 基础工具
     ============================================================ */
  C.uid = function () {
    if (typeof crypto !== 'undefined' && crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  /** editor-utils.ts: clampNumber */
  C.clampNumber = function (value, min, max, fallback) {
    var n = typeof value === 'number' ? value : Number(value);
    if (!isFinite(n)) return fallback === undefined ? min : fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  };

  C.esc = function (h) {
    return String(h == null ? '' : h)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  /* ============================================================
     1) position / selectiveLogic / role 映射表（importer.ts）
     ============================================================ */
  C.POSITION_MAP = {
    0: 'before_char', 1: 'after_char', 2: 'before_example', 3: 'after_example',
    4: 'at_depth', 5: 'example_msg_top', 6: 'example_msg_bottom', 7: 'outlet'
  };
  C.REVERSE_POSITION_MAP = {
    before_char: 0, after_char: 1, before_example: 2, after_example: 3,
    at_depth: 4, example_msg_top: 5, example_msg_bottom: 6, outlet: 7
  };
  C.POSITIONS = ['before_char', 'after_char', 'before_example', 'after_example',
    'at_depth', 'example_msg_top', 'example_msg_bottom', 'outlet'];

  C.LOGIC_MAP = { 0: 'and_any', 1: 'not_all', 2: 'not_any', 3: 'and_all' };
  C.REVERSE_LOGIC_MAP = { and_any: 0, not_all: 1, not_any: 2, and_all: 3 };
  C.LOGICS = ['and_any', 'not_all', 'not_any', 'and_all'];

  /* EntryForm.tsx 的下拉文案（照搬） */
  C.POSITION_LABEL = {
    before_char: 'before_char (角色前)',
    after_char: 'after_char (角色后)',
    before_example: 'before_example (示例前)',
    after_example: 'after_example (示例后)',
    at_depth: 'at_depth (按深度)',
    example_msg_top: 'example_msg_top',
    example_msg_bottom: 'example_msg_bottom',
    outlet: 'outlet'
  };
  C.LOGIC_LABEL = {
    and_any: 'and_any (与/任一)',
    not_all: 'not_all (非全部)',
    not_any: 'not_any (无任一)',
    and_all: 'and_all (与/全部)'
  };

  /* ST role：0 system / 1 user / 2 assistant */
  C.ROLE_BY_ID = { 0: 'system', 1: 'user', 2: 'assistant' };
  C.ROLE_ID_BY_NAME = { system: 0, user: 1, assistant: 2 };
  C.ROLES = ['system', 'user', 'assistant'];

  /* ============================================================
     2) types.ts: DEFAULT_PROMPT_ORDER（10 项标准顺序）
     ------------------------------------------------------------
     注意：skill 的标准顺序**不含** variablesBlock / formatPrompt 槽位。
     变量块与输出协议由 assemblePrompt 在 system 累加器末尾统一追加
     （见 prompt-assembler.ts 的 variablesBlock / extraVariables /
     formatPrompt 三段），这是 skill 的设计，不是遗漏。
     ============================================================ */
  C.DEFAULT_PROMPT_ORDER = [
    { identifier: 'main', name: 'Main Prompt', role: 'system' },
    { identifier: 'worldInfoBefore', name: 'World Info (Before)', role: 'system' },
    { identifier: 'charDescription', name: 'Character Description', role: 'system' },
    { identifier: 'charPersonality', name: 'Character Personality', role: 'system' },
    { identifier: 'scenario', name: 'Scenario', role: 'system' },
    { identifier: 'personaDescription', name: 'Persona Description', role: 'system' },
    /* worldInfoAfter 紧跟角色定义区——它的名字就是「After Character
       Definition」。skill 模板把它放在 chatHistory 之后，导致 after_char
       世界书（内置模板 28/31 条）全被挤到历史之后的中段 system 消息里，
       弱模型不服从——见 assembler.js 头注。此处为对 skill 的第三处刻意修正。 */
    { identifier: 'worldInfoAfter', name: 'World Info (After)', role: 'system' },
    { identifier: 'dialogueExamples', name: 'Dialogue Examples', role: 'system' },
    { identifier: 'chatHistory', name: 'Chat History', role: 'system' },
    { identifier: 'groupNudge', name: 'Group Nudge', role: 'system' }
  ];

  C.PROMPT_LABEL = {};
  C.DEFAULT_PROMPT_ORDER.forEach(function (p) { C.PROMPT_LABEL[p.identifier] = p.name; });
  /* resolvePromptContent 里可直接取值的其余 identifier */
  C.PROMPT_LABEL.impersonate = 'Impersonation Prompt';
  C.PROMPT_LABEL.quietPrompt = 'Quiet Prompt';
  C.PROMPT_LABEL.bias = 'Bias';
  C.PROMPT_LABEL.nsfw = 'NSFW';
  C.PROMPT_LABEL.jailbreak = 'Jailbreak';
  C.PROMPT_LABEL.enhanceDefinitions = 'Enhance Definitions';

  /* ============================================================
     2b) 模块总表（C.MODULES）
     ------------------------------------------------------------
     组装器能解析的**全部**槽位。skill 的 DEFAULT_PROMPT_ORDER 只列了
     10 项，其余字段（nsfw / jailbreak / 角色卡槽 / 变量块 / 输出协议 …）
     虽然 resolvePromptContent 认得，却不出现在任何列表里——于是用户
     「填了不注入、也看不见、更开关不了」。本表是 UI「模块」面板的唯一
     数据源：每一项都能勾选启用/停用、能排序、文本类还能就地编辑。

     source 取值：
       'dynamic'        引擎填充（世界书 / 历史 / 变量 / 协议）
       'settings:<k>'   从预设 settings.<k> 直取文本
       'custom'         用户自建块，存 settings.prompts[]
       'inert'          永不注入（bias）
     editable：文本类才可在模块面板里改内容。
     ============================================================ */
  C.MODULES = [
    { identifier: 'main', label: '主提示词', source: 'settings:main', dynamic: false, editable: true, std: true },
    { identifier: 'worldInfoBefore', label: '世界书（角色定义前）', source: 'dynamic', dynamic: true, editable: false, std: true },
    { identifier: 'charDescription', label: '角色描述', source: 'settings:character_description', dynamic: false, editable: true, std: true },
    { identifier: 'charPersonality', label: '角色性格', source: 'settings:character_personality', dynamic: false, editable: true, std: true },
    { identifier: 'scenario', label: '场景', source: 'settings:scenario', dynamic: false, editable: true, std: true },
    { identifier: 'personaDescription', label: '玩家设定', source: 'settings:persona_description', dynamic: false, editable: true, std: true },
    { identifier: 'worldInfoAfter', label: '世界书（角色定义后）', source: 'dynamic', dynamic: true, editable: false, std: true },
    { identifier: 'dialogueExamples', label: '对话示例', source: 'settings:dialogue_examples', dynamic: false, editable: true, std: true },
    { identifier: 'variablesBlock', label: '当前状态（变量块）', source: 'dynamic', dynamic: true, editable: false },
    { identifier: 'chatHistory', label: '对话历史', source: 'dynamic', dynamic: true, editable: false, std: true },
    { identifier: 'formatPrompt', label: '输出协议', source: 'dynamic', dynamic: true, editable: false },
    { identifier: 'groupNudge', label: '群组提示', source: 'settings:group_nudge_prompt', dynamic: false, editable: true, std: true },
    { identifier: 'nsfw', label: 'NSFW 提示', source: 'settings:nsfw', dynamic: false, editable: true },
    { identifier: 'jailbreak', label: '破限提示', source: 'settings:jailbreak', dynamic: false, editable: true },
    { identifier: 'enhanceDefinitions', label: '定义增强', source: 'settings:enhanceDefinitions', dynamic: false, editable: true },
    { identifier: 'impersonate', label: '代演提示', source: 'settings:impersonation_prompt', dynamic: false, editable: true },
    { identifier: 'quietPrompt', label: '静默提示', source: 'settings:quiet_prompt', dynamic: false, editable: true },
    { identifier: 'new_chat_prompt', label: '新对话提示', source: 'settings:new_chat_prompt', dynamic: false, editable: true },
    { identifier: 'new_group_chat_prompt', label: '新群聊提示', source: 'settings:new_group_chat_prompt', dynamic: false, editable: true },
    { identifier: 'new_example_chat_prompt', label: '新示例提示', source: 'settings:new_example_chat_prompt', dynamic: false, editable: true },
    { identifier: 'continue_nudge_prompt', label: '继续续写提示', source: 'settings:continue_nudge_prompt', dynamic: false, editable: true },
    { identifier: 'bias', label: '偏置（不注入）', source: 'inert', dynamic: false, editable: false }
  ];

  C.MODULE_BY_ID = {};
  C.MODULES.forEach(function (m) { C.MODULE_BY_ID[m.identifier] = m; });

  /** 模块 → settings 键（非文本模块返回 null） */
  C.moduleSettingsKey = function (identifier) {
    var m = C.MODULE_BY_ID[identifier];
    if (!m || m.source.indexOf('settings:') !== 0) return null;
    return m.source.slice('settings:'.length);
  };



  /* ============================================================
     4) types.ts: DEFAULT_SETTINGS
     ============================================================ */
  /* 输出协议标签。协议说明文本不在代码里——由用户的世界书提供。
     解析器只认这份名单：think=推演(折叠) text=正文 options=选项
     memo=本回合小记忆 events=长期记忆 set=变量命令 */
  C.DEFAULT_TAGS = ['maintext', 'option', 'sum', 'text', 'options', 'memo', 'events', 'set', 'think', 'thinking'];
  C.DEFAULT_OPAQUE_TAGS = ['thinking', 'think'];
  C.DEFAULT_FORMAT_PROMPT = '';

    C.DEFAULT_SETTINGS = {
    api: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-3.5-turbo',
      timeout: 60000
    },
    apiMode: 'single',
    activePresetId: null,
    activeLorebookIds: [],
    userName: '用户',
    characterName: 'AI',
    theme: 'dark',
    language: 'zh',
    autoSave: true,
    autoSaveInterval: 30,
    /* 流式兜底：预设的 stream_openai 未定义时（或根本没有预设）用这个。
       有预设时预设优先——这只是「没有预设就开不了流式」的逃生门。 */
    stream: false,
    uiMode: 'game',
    customTags: ['maintext', 'option', 'sum', 'text', 'options', 'memo', 'events', 'set', 'think', 'thinking'],
    formatPromptTemplate: C.DEFAULT_FORMAT_PROMPT,
    thinkingDisplay: 'fold',
  };

  /* ============================================================
     5) types.ts: createDefaultPreset
     ============================================================ */
  C.createDefaultPreset = function (name) {
    var now = Date.now();
    return {
      id: C.uid(),
      name: name || '默认预设',
      description: 'SillyTavern 兼容的默认 OpenAI 预设',
      createdAt: now,
      updatedAt: now,
      settings: {
        temp_openai: 0.8,
        freq_pen_openai: 0,
        pres_pen_openai: 0,
        top_p_openai: 0.9,
        top_k_openai: 0,
        top_a_openai: 0,
        min_p_openai: 0,
        repetition_penalty_openai: 1,
        openai_max_context: 4096,
        openai_max_tokens: 2048,
        stream_openai: false,
        max_context_unlocked: false,
        chat_completion_source: 'openai',
        openai_model: 'gpt-3.5-turbo',
        main: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
        nsfw: '',
        jailbreak: '',
        enhanceDefinitions: '',
        impersonation_prompt: '',
        new_chat_prompt: '',
        new_group_chat_prompt: '',
        new_example_chat_prompt: '',
        continue_nudge_prompt: '',
        wi_format: '',
        group_nudge_prompt: '',
        scenario_format: '',
        personality_format: '',
        prompts: [],
        prompt_order: C.DEFAULT_PROMPT_ORDER.map(function (p) {
          return { identifier: p.identifier, name: p.name, role: p.role, enabled: true };
        })
      }
    };
  };

  /* ============================================================
     6) editor-utils.ts: 世界书条目 / 书本纯函数
     ============================================================ */
  var ENTRY_DEFAULTS = {
    keys: [],
    secondaryKeys: [],
    content: '',
    order: 100,
    position: 'after_char',
    selective: false,
    selectiveLogic: 'and_any',
    constant: false,
    probability: 100,
    useProbability: false,
    addMemo: false,
    /* 条目级停用：skill 的 LorebookEntry 没有这个字段，但 SillyTavern 的
       导出格式有 disable / excluded，且用户需要单条开关而不必删条目。
       引擎在 scan() 里跳过 disabled===true 的条目；导入时它们被保留而非丢弃。 */
    disabled: false
  };

  C.createDefaultEntry = function () {
    var e = { id: C.uid() };
    Object.keys(ENTRY_DEFAULTS).forEach(function (k) {
      var v = ENTRY_DEFAULTS[k];
      e[k] = Array.isArray(v) ? v.slice() : v;
    });
    return e;
  };

  C.applyEntryDefaults = function (partial) {
    partial = partial || {};
    var e = { id: partial.id != null ? partial.id : C.uid() };
    Object.keys(ENTRY_DEFAULTS).forEach(function (k) {
      var v = ENTRY_DEFAULTS[k];
      e[k] = Array.isArray(v) ? v.slice() : v;
    });
    Object.keys(partial).forEach(function (k) { e[k] = partial[k]; });
    return e;
  };

  C.createDefaultLorebook = function (name) {
    var now = Date.now();
    return {
      id: C.uid(),
      name: name,
      entries: [],
      recursiveScanning: false,
      caseSensitive: false,
      matchWholeWords: false,
      createdAt: now,
      updatedAt: now
    };
  };

  /** 更新单条条目（返回新 book；未命中 id 时原样返回同一引用） */
  C.updateEntry = function (book, entryId, patch) {
    if (!book || !Array.isArray(book.entries)) return book;
    var idx = -1;
    for (var i = 0; i < book.entries.length; i++) {
      if (book.entries[i] && book.entries[i].id === entryId) { idx = i; break; }
    }
    if (idx < 0) return book;
    var nextEntries = book.entries.slice();
    var merged = {};
    Object.keys(nextEntries[idx]).forEach(function (k) { merged[k] = nextEntries[idx][k]; });
    Object.keys(patch || {}).forEach(function (k) { merged[k] = patch[k]; });
    nextEntries[idx] = merged;
    var out = {};
    Object.keys(book).forEach(function (k) { out[k] = book[k]; });
    out.entries = nextEntries;
    out.updatedAt = Date.now();
    return out;
  };

  C.removeEntry = function (book, entryId) {
    if (!book || !Array.isArray(book.entries)) return book;
    var idx = -1;
    for (var i = 0; i < book.entries.length; i++) {
      if (book.entries[i] && book.entries[i].id === entryId) { idx = i; break; }
    }
    if (idx < 0) return book;
    var nextEntries = book.entries.slice();
    nextEntries.splice(idx, 1);
    var out = {};
    Object.keys(book).forEach(function (k) { out[k] = book[k]; });
    out.entries = nextEntries;
    out.updatedAt = Date.now();
    return out;
  };

  /** editor-utils.ts: movePromptItem */
  C.movePromptItem = function (arr, from, to) {
    if (from === to) return arr;
    if (from < 0 || from >= arr.length) return arr;
    if (to < 0 || to >= arr.length) return arr;
    var next = arr.slice();
    var item = next.splice(from, 1)[0];
    next.splice(to, 0, item);
    return next;
  };

  /* ============================================================
     7) variables.ts: 会话回滚 + 变量块格式化
     ------------------------------------------------------------
     （旧 <vars> 深合并 / <var/> 抽取已整体移除——变量操作走
      js/vars.js 的 <set> 命令协议。此处只保留仍被组装器使用的
      变量块格式化与会话截断/分支纯函数。）
     ============================================================ */
  C.USER_ROLE = 'user';

  /** variables.ts: `[当前状态]\nk: v` */
  C.formatVariablesForPrompt = function (variables) {
    var keys = Object.keys(variables || {});
    if (!keys.length) return '';
    var lines = keys.map(function (k) {
      var v = variables[k];
      if (v && typeof v === 'object') {
        try { v = JSON.stringify(v); } catch (e) { v = String(v); }
      }
      return k + ': ' + v;
    });
    return '[当前状态]\n' + lines.join('\n');
  };

  C.truncateChatAt = function (chat, index, variables) {
    var truncated = (chat.messages || []).slice(0, index);
    var restoredVars = variables !== undefined ? variables
      : (truncated[truncated.length - 1] && truncated[truncated.length - 1].variables) || {};
    var out = {};
    Object.keys(chat).forEach(function (k) { out[k] = chat[k]; });
    out.messages = truncated;
    out.variables = restoredVars;
    out.updatedAt = Date.now();
    return out;
  };

  C.branchChat = function (source, index, options) {
    options = options || {};
    var now = Date.now();
    var slice = (source.messages || []).slice(0, index + 1).map(function (m) {
      var o = {};
      Object.keys(m).forEach(function (k) { o[k] = m[k]; });
      return o;
    });
    var lastMsg = source.messages[index];
    return {
      id: C.uid(),
      name: options.name,
      messages: slice,
      characterName: source.characterName,
      userName: source.userName,
      presetId: options.presetId !== undefined ? options.presetId : null,
      lorebookIds: (options.lorebookIds || []).slice(),
      variables: options.variables !== undefined ? options.variables
        : (lastMsg && lastMsg.variables) || {},
      createdAt: now,
      updatedAt: now
    };
  };

  C.createChatSession = function (opts) {
    opts = opts || {};
    var now = Date.now();
    return {
      id: C.uid(),
      name: opts.name || '新对话',
      messages: [],
      characterName: opts.characterName || '',
      userName: opts.userName || '',
      presetId: opts.presetId !== undefined ? opts.presetId : null,
      lorebookIds: (opts.lorebookIds || []).slice(),
      variables: opts.variables || {},
      createdAt: now,
      updatedAt: now
    };
  };

  /* ============================================================
     9) prompt-assembler.ts: replaceMacros / SUPPORTED_MACROS
     ============================================================ */
  C.replaceMacros = function (template, context) {
    context = context || {};
    var result = String(template == null ? '' : template)
      .replace(/\{\{user\}\}/g, context.userName == null ? '' : context.userName)
      .replace(/\{\{char\}\}/g, context.characterName == null ? '' : context.characterName)
      .replace(/\{\{original\}\}/g, context.userInput == null ? '' : context.userInput);

    if (context.variables) {
      result = result.replace(/\{\{([^{}]+)\}\}/g, function (match, key) {
        var value = context.variables[String(key).trim()];
        return value !== undefined ? String(value) : match;
      });
    }
    return result;
  };

  C.SUPPORTED_MACROS = [
    { name: '{{user}}', description: '用户名' },
    { name: '{{char}}', description: 'AI角色名' },
    { name: '{{original}}', description: '用户原始输入' },
    { name: '{{变量名}}', description: '自定义变量（例如 {{hp}}）' }
  ];

  /* ============================================================
     10) 条目显示名（LorebookEditorModal.tsx: entryLabel）
     ============================================================ */
  C.entryLabel = function (e) {
    if (!e) return '(未命名条目)';
    if (e.comment && String(e.comment).trim()) return String(e.comment).trim();
    if (e.content && String(e.content).trim()) return String(e.content).trim().slice(0, 30);
    if (e.keys && e.keys.length) return e.keys.join(', ');
    return '(未命名条目)';
  };

  window.ST_CORE = C;
})();

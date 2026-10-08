/* ============================================================
   腐化 · SillyTavern 集成内核 ⑧ 门面（window.ST）
   ------------------------------------------------------------
   收拢 ①~⑦，给 UI 层与适配层一个稳定接口。

   skill 的 React 路径用 useSillytavern Hook 在 onMounted 里异步
   loadAll()，之后所有读写都走 ref 快照。本项目无构建、无 React，
   等价做法是**内存缓存 + 异步落库**：

     · init() 时把 IndexedDB 的 settings / presets / lorebooks 读进内存
     · 同步读接口（getSettings / getPresets / getLorebooks）读缓存
       → app.js 的 TAVERN.ready() / renderTavern() 才能保持同步调用
     · 写接口先更新缓存，再异步 put 进 IndexedDB

   请求体构造照搬 useSillytavern.sendMessage（经 ST_PRESET.buildRequestBody）。
   ============================================================ */
(function () {
  'use strict';

  var C = window.ST_CORE;
  var L = window.ST_LOREBOOK;
  var P = window.ST_PRESET;
  var A = window.ST_ASSEMBLER;
  var R = window.ST_REPLY;
  var API = window.ST_API;
  var S = window.ST_STATE;

  var ST = {};

  /* ============================================================
     0) 内存缓存
     ============================================================ */
  var cache = {
    ready: false,
    settings: S.normalize(null),
    presets: [],
    lorebooks: []
  };

  ST.isReady = function () { return cache.ready; };

  /* ============================================================
     0.5) 旧输出协议自愈（幂等）
     ------------------------------------------------------------
     早期世界书/预设教的是 <maintext>/<option>/<sum>/<thinking> 旧标签，
     与现行 <text>/<options>/<memo>/<think> 协议混用，模型输出格式打架，
     选项列表和摘要会裸漏进正文。装载后按标记替换一次：
     条目里已没有旧标签时天然空转，无需迁移标记。
     ============================================================ */
  var HEAL_PAIRS = [
    ['<maintext>', '<text>'],
    ['</maintext>', '</text>'],
    ['<option>', '<options>'],
    ['</option>', '</options>'],
    ['<sum>', '<memo>'],
    ['</sum>', '</memo>'],
    ['<thinking>', '<think>'],
    ['</thinking>', '</think>']
  ];
  function healProtocolText(s) {
    if (typeof s !== 'string' || !s) return null;
    var out = s, hit = false;
    HEAL_PAIRS.forEach(function (p) {
      if (out.indexOf(p[0]) !== -1) { out = out.split(p[0]).join(p[1]); hit = true; }
    });
    return hit ? out : null;
  }
  function healProtocolDrift(lorebooks, presets) {
    var jobs = [];
    (lorebooks || []).forEach(function (b) {
      var touched = false;
      (b.entries || []).forEach(function (e) {
        var next = healProtocolText(e.content);
        if (next != null) { e.content = next; touched = true; }
      });
      if (touched) jobs.push(window.ST_DB.saveLorebook(b));
    });
    (presets || []).forEach(function (p) {
      var touched = false;
      ((p.settings && p.settings.prompts) || p.prompts || []).forEach(function (pr) {
        var next = healProtocolText(pr && pr.content);
        if (next != null) { pr.content = next; touched = true; }
      });
      if (touched) jobs.push(window.ST_DB.savePreset(p));
    });
    return jobs.length ? Promise.all(jobs) : Promise.resolve(false);
  }

  /** 首次装载：迁移旧数据 → 建库 → 读三张表进内存 */
  ST.init = function () {
    return S.init().then(function (settings) {
      return Promise.all([
        P.getPresets(),
        L.getLorebooks()
      ]).then(function (r) {
        cache.settings = settings;
        cache.presets = r[0];
        cache.lorebooks = r[1];
        cache.ready = true;
        healProtocolDrift(cache.lorebooks, cache.presets)
          .catch(function (e) { console.error('[ST] 旧协议自愈失败', e); });
        return settings;
      });
    }).catch(function (e) {
      cache.ready = false;
      throw e;
    });
  };

  /** 重新从库里拉一遍（导入/删除后调用） */
  ST.reload = function () {
    return Promise.all([
      S.loadSettings(), P.getPresets(), L.getLorebooks()
    ]).then(function (r) {
      cache.settings = r[0];
      cache.presets = r[1];
      cache.lorebooks = r[2];
      cache.ready = true;
      return r[0];
    });
  };

  /* ============================================================
     1) 同步读（读缓存）
     ============================================================ */
  ST.getSettings = function () { return cache.settings; };
  ST.getPresets = function () { return cache.presets.slice(); };
  ST.getLorebooks = function () { return cache.lorebooks.slice(); };
  ST.getPreset = function (id) {
    for (var i = 0; i < cache.presets.length; i++) if (cache.presets[i].id === id) return cache.presets[i];
    return null;
  };
  ST.getLorebook = function (id) {
    for (var i = 0; i < cache.lorebooks.length; i++) if (cache.lorebooks[i].id === id) return cache.lorebooks[i];
    return null;
  };
  ST.activePreset = function () { return P.resolvePreset(cache.presets, cache.settings); };
  ST.activeLorebooks = function () { return L.activeBooks(cache.lorebooks, cache.settings); };

  /* ============================================================
     2) 写（改缓存 + 异步落库）
     ============================================================ */
  ST.saveSettings = function (patch) {
    var next = Object.assign({}, cache.settings);
    Object.keys(patch || {}).forEach(function (k) {
      if (k === 'api' && patch[k] && typeof patch[k] === 'object') next.api = Object.assign({}, next.api, patch[k]);
      else if (patch[k] !== undefined) next[k] = patch[k];
    });
    cache.settings = S.normalize(next);
    return window.ST_DB.saveSettings(cache.settings).then(function () { return cache.settings; });
  };

  /* 注意：写缓存一律存深拷贝。UI 层是草稿制——若把草稿引用存进缓存，
     用户后续对草稿的原地修改（如改书名）会绕过保存流程污染缓存。 */
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  ST.savePreset = function (preset) {
    if (!preset.id) preset.id = C.uid();
    preset.updatedAt = Date.now();
    var at = -1;
    cache.presets.forEach(function (p, i) { if (p.id === preset.id) at = i; });
    if (at >= 0) cache.presets[at] = clone(preset); else cache.presets.push(clone(preset));
    return P.savePreset(preset).then(function () { return preset; });
  };

  ST.deletePreset = function (id) {
    cache.presets = cache.presets.filter(function (p) { return p.id !== id; });
    if (cache.settings.activePresetId === id) {
      cache.settings.activePresetId = cache.presets.length ? cache.presets[0].id : null;
      window.ST_DB.saveSettings(cache.settings);
    }
    return P.deletePreset(id);
  };

  ST.saveLorebook = function (lorebook) {
    if (!lorebook.id) lorebook.id = C.uid();
    lorebook.updatedAt = Date.now();
    var at = -1;
    cache.lorebooks.forEach(function (b, i) { if (b.id === lorebook.id) at = i; });
    if (at >= 0) cache.lorebooks[at] = clone(lorebook); else cache.lorebooks.push(clone(lorebook));
    return L.saveLorebook(lorebook).then(function () { return lorebook; });
  };

  ST.deleteLorebook = function (id) {
    cache.lorebooks = cache.lorebooks.filter(function (b) { return b.id !== id; });
    cache.settings.activeLorebookIds = (cache.settings.activeLorebookIds || []).filter(function (x) { return x !== id; });
    window.ST_DB.saveSettings(cache.settings);
    return L.deleteLorebook(id);
  };

  /** 切换世界书激活状态（skill：settings.activeLorebookIds） */
  ST.toggleLorebook = function (id) {
    var ids = L.toggleActive(cache.settings, id);
    cache.settings.activeLorebookIds = ids;
    return window.ST_DB.saveSettings(cache.settings).then(function () { return ids; });
  };

  ST.addPresetFromDefault = function (name) {
    var p = C.createDefaultPreset(name);
    p.createdAt = Date.now();
    p.updatedAt = Date.now();
    cache.presets.push(p);
    return P.savePreset(p).then(function () { return p; });
  };

  ST.createLorebook = function (name) {
    var lb = C.createDefaultLorebook(name);
    cache.lorebooks.push(lb);
    return L.saveLorebook(lb).then(function () { return lb; });
  };

  ST.importAndSave = function (data) {
    return L.importAndSave(data).then(function (lb) {
      cache.lorebooks.push(lb);
      return lb;
    });
  };

  ST.importMultipleAndSave = function (inputs) {
    return L.importMultipleAndSave(inputs).then(function (res) {
      res.successes.forEach(function (s) { cache.lorebooks.push(s.lorebook); });
      return res;
    });
  };

  ST.importPresetAndSave = function (data) {
    return P.importAndSave(data).then(function (p) {
      cache.presets.push(p);
      return p;
    });
  };

  ST.factoryReset = function () {
    return S.factoryReset().then(function (settings) {
      cache.settings = settings;
      return Promise.all([P.getPresets(), L.getLorebooks()]);
    }).then(function (r) {
      cache.presets = r[0];
      cache.lorebooks = r[1];
      return cache.settings;
    });
  };

  ST.importCoreTemplate = function () {
    return S.importCoreTemplate().then(function (lb) {
      var at = -1;
      cache.lorebooks.forEach(function (b, i) { if (b.id === lb.id) at = i; });
      if (at >= 0) cache.lorebooks[at] = lb; else cache.lorebooks.push(lb);
      return lb;
    });
  };

  ST.hasCoreTemplate = function () {
    for (var i = 0; i < cache.lorebooks.length; i++) {
      var b = cache.lorebooks[i];
      if (b.builtin === 'core' || b.name === S.CORE_LOREBOOK_NAME) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  };

  /* ============================================================
     3) 常量 / 纯函数转发
     ============================================================ */
  ST.uid = C.uid;
  ST.esc = C.esc;
  ST.clampNumber = C.clampNumber;
  ST.entryLabel = C.entryLabel;
  ST.movePromptItem = C.movePromptItem;
  ST.updateEntry = C.updateEntry;
  ST.removeEntry = C.removeEntry;
  ST.createDefaultEntry = C.createDefaultEntry;
  ST.applyEntryDefaults = C.applyEntryDefaults;
  ST.createDefaultLorebook = C.createDefaultLorebook;
  ST.createDefaultPreset = C.createDefaultPreset;
  ST.POSITIONS = C.POSITIONS;
  ST.POSITION_LABEL = C.POSITION_LABEL;
  ST.LOGICS = C.LOGICS;
  ST.LOGIC_LABEL = C.LOGIC_LABEL;
  ST.ROLES = C.ROLES;
  ST.DEFAULT_PROMPT_ORDER = C.DEFAULT_PROMPT_ORDER;
  ST.PROMPT_LABEL = C.PROMPT_LABEL;
  ST.DEFAULT_TAGS = C.DEFAULT_TAGS;
  ST.DEFAULT_OPAQUE_TAGS = C.DEFAULT_OPAQUE_TAGS;
  ST.DEFAULT_FORMAT_PROMPT = C.DEFAULT_FORMAT_PROMPT;
  ST.DEFAULT_SETTINGS = C.DEFAULT_SETTINGS;
  ST.SUPPORTED_MACROS = C.SUPPORTED_MACROS;
  ST.replaceMacros = C.replaceMacros;
  ST.formatVariablesForPrompt = C.formatVariablesForPrompt;

  ST.createLorebookEngine = L.createLorebookEngine;
  ST.importLorebook = L.importLorebook;
  ST.exportLorebook = L.exportLorebook;
  ST.importMultipleLorebooks = L.importMultipleLorebooks;
  ST.renameLorebook = L.renameLorebook;
  ST.importPreset = P.importPreset;
  ST.exportPreset = P.exportPreset;
  ST.buildRequestBody = P.buildRequestBody;
  ST.assemblePrompt = A.assemblePrompt;
  ST.previewPrompt = A.previewPrompt;
  ST.StreamTagParser = R.StreamTagParser;
  ST.aggregateEvents = R.aggregateEvents;
  ST.parseText = R.parseText;

  ST.normalizeBaseUrl = API.normalizeBaseUrl;
  ST.endpointFor = API.endpointFor;
  ST.chatCompletion = API.chatCompletion;
  ST.testConnection = API.testConnection;
  ST.fetchModels = API.fetchModels;
  ST.fallbackModels = API.fallbackModels;

  /* ============================================================
     4) 运行时：把腐化世界状态映射成 skill 的入参
     ------------------------------------------------------------
     TAVERN_CTX 由 app.js 提供（getContext / getHistory）。
     variablesBlock 槽的内容 = VARS.digest() 状态卡（游戏侧真相），
     不再是硬编码四变量——LLM 从卡里看到有哪些路径可写，才知道
     <set> 能往哪儿写。输出协议取 settings.formatPromptTemplate。
     ============================================================ */
  ST.buildRuntime = function () {
    var ctx = (window.TAVERN_CTX && window.TAVERN_CTX.getContext)
      ? window.TAVERN_CTX.getContext() : {};
    var s = cache.settings;

    /* 状态卡：优先游戏层 VARS.digest()；离线/未加载时退回最小形状 */
    var digest = '';
    if (window.VARS && typeof window.VARS.digest === 'function') {
      try { digest = window.VARS.digest() || ''; } catch (e) { digest = ''; }
    }
    if (!digest) {
      digest = C.formatVariablesForPrompt({
        '时间': ctx.time || '', '地点': ctx.loc || '',
        '金钱': ctx.money != null ? ctx.money : 0
      });
    }

    var extraVariables = {};
    if (ctx.focus) extraVariables['焦点目标档案'] = ctx.focus;
    /* 玩家自述人设：skill 的 AppSettings 无 persona 字段，
       这里作为 extraVariables 注入（预设的 persona_description 槽是另一条路，
       那条走 settings.persona_description，由用户在预设里填）。 */
    if (s.persona) extraVariables['玩家设定'] = s.persona;

    return {
      userName: s.userName || '用户',
      characterName: s.characterName || 'AI',
      /* variables 传空对象：状态卡已含全部变量，避免同一份数据注入两遍 */
      variables: {},
      digest: digest,
      extraVariables: extraVariables,
      /* formatPrompt：空则回落到默认精简标签协议（C.DEFAULT_FORMAT_PROMPT）。
         输出协议标签（think/text/options/memo/events/set）由用户世界书声明。 */
      /* 输出协议由用户世界书提供；代码与存档里的旧模板一律忽略 */
      formatPrompt: ''
    };
  };

  /** 组装发往模型的 messages（照搬 useSillytavern.sendMessage 的取数顺序） */
  ST.buildMessages = function (userText) {
    var rt = ST.buildRuntime();
    var s = cache.settings;
    var preset = ST.activePreset();
    var lorebooks = ST.activeLorebooks();

    var history = (window.TAVERN_CTX && window.TAVERN_CTX.getHistory)
      ? window.TAVERN_CTX.getHistory() : [];
    /* app.js 已把本回合指令写进历史末尾 → 去掉重复 */
    var last = history[history.length - 1];
    if (last && last.role === 'user' && String(last.content) === String(userText)) {
      history = history.slice(0, -1);
    }
        /* 历史压缩已由 app.js 的天道分段记忆（APP_SEGMENTED_HISTORY）完成，
       此处不再二次压缩——二次压缩会把小/大总结又压成概括。 */


    var result = A.assemblePrompt({
      userInput: userText,
      history: history,
      preset: preset,
      lorebooks: lorebooks,
      userName: rt.userName,
      characterName: rt.characterName,
      variables: rt.variables,
      digest: rt.digest,
      extraVariables: rt.extraVariables,
      formatPrompt: rt.formatPrompt
    });

    result.preset = preset;
    result.variables = rt.variables;
    return result;
  };

  /** 接口是否可用（skill 无此概念，腐化 app.js 需要同步判定）。
     规则：内核必须已初始化；Base URL 必须填了；模型能从预设或接口确定；
     且要么有密钥、要么是本地端点（localhost 直连常不带鉴权）。
     ——DEFAULT_SETTINGS 预填了 api.openai.com，但空密钥不可用，不能算就绪。 */
  ST.canRequest = function () {
    if (!cache.ready) return false;
    var api = cache.settings.api || {};
    if (!api.baseUrl) return false;
    var preset = ST.activePreset();
    var model = (preset && preset.settings && preset.settings.openai_model) || api.model;
    if (!model) return false;
    var isLocal = /localhost|127\.0\.0\.1|\[::1\]/i.test(api.baseUrl);
    return !!(api.apiKey || isLocal);
  };

  /**
   * 完整回合：组装 → 请求 → 解析
   * handlers: { onChunk, onDone, onError, signal }
   * 返回 Promise<{ parsed（含 commands 变量命令数组）, matchedEntries, messages, raw }>
   * 命令的执行与呈现（弹幕 / 失败弹窗）归游戏层 js/vars.js，本层不碰。
   */
  ST.chat = function (userText, handlers) {
    handlers = handlers || {};
    var built = ST.buildMessages(userText);
    var preset = built.preset;
    var s = cache.settings;

    var body = P.buildRequestBody(preset, s, built.messages);
    var cfg = { baseUrl: s.api.baseUrl, apiKey: s.api.apiKey, model: body.model };
    var params = {
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
      frequency_penalty: body.frequency_penalty,
      presence_penalty: body.presence_penalty,
      /* 预设没定义 stream_openai（或没有预设）→ 落 settings.stream 兜底，
         否则「没有预设流式就开不了」 */
      stream: body.stream !== undefined ? !!body.stream : !!s.stream
    };

    /* 流式仅用于实时显示：增量先过状态机，只把 <text> 交给 onChunk，
       避免把 <option>/<sum>/<set> 直接渲染进聊天区。 */
    var tags = C.DEFAULT_TAGS; /* 新旧协议并集：存档里的旧名单不再决定解析范围 */
    var parser = handlers.onChunk ? new R.StreamTagParser(tags, C.DEFAULT_OPAQUE_TAGS) : null;
    var onDelta = (handlers.onChunk && params.stream) ? function (delta) {
      var evs = parser.feed(delta);
      var buf = '';
      for (var i = 0; i < evs.length; i++) {
        var ev = evs[i];
        if (ev.type === 'tag-chunk' && (ev.tag === 'text' || ev.tag === 'maintext')) buf += ev.chunk;
        else if (ev.type === 'raw') buf += ev.chunk;
      }
      if (buf) handlers.onChunk(buf);
    } : null;

    /* handlers.signal：AbortSignal，供上层「中止生成」。
       中止时 fetch 抛 AbortError，这里打上 aborted 标记，
       让适配层能区分「用户取消」与「接口故障」，不去走错误回退。 */
    return API.chatCompletion(cfg, built.messages, onDelta, handlers.signal || null, params).then(function (full) {
      var text = full || '';
      var parsed = R.parseText(text, tags, C.DEFAULT_OPAQUE_TAGS);
      var out = {
        parsed: parsed,
        commands: parsed.commands || [],
        memo: parsed.memo || '',
        events: parsed.events || '',
        matchedEntries: built.matchedEntries,
        messages: built.messages,
        raw: text
      };
      if (handlers.onDone) handlers.onDone(out);
      return out;
    }).catch(function (err) {
      if (handlers.onError) handlers.onError(err);
      throw err;
    });
  };

  window.ST = ST;
})();

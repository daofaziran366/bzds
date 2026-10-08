/* ============================================================
   腐化 · SillyTavern 集成内核 ③ 预设层
   ------------------------------------------------------------
   照搬 skill sillytavern-web：
     templates/react/sillytavern/types.ts        （ChatPreset / createDefaultPreset）
     templates/react/sillytavern/importer.ts     （importPreset / exportPreset）
     templates/react/sillytavern/database.ts     （presets 表读写）
     templates/react/hooks/useSillytavern.ts     （sendMessage 里的请求体构造）

   skill 没有独立的 preset 引擎层：预设就是 ChatPreset
   { id, name, description, settings, createdAt, updatedAt }，
   settings 原样存放 SillyTavern 的预设 JSON。本层只做
   「读写 + 解析激活预设 + 构造请求体」，不做归一化、不加扩展字段。
   ============================================================ */
(function () {
  'use strict';

  var C = window.ST_CORE;
  var P = {};

  /* ============================================================
     1) 持久化（database.ts 的 presets 部分）
     ============================================================ */
  P.getPresets = function () { return window.ST_DB.getPresets(); };
  P.getPreset = function (id) { return window.ST_DB.getPreset(id); };

  P.savePreset = function (preset) {
    if (!preset) return Promise.resolve(null);
    if (!preset.id) preset.id = C.uid();
    if (!preset.settings) preset.settings = {};
    preset.updatedAt = Date.now();
    return window.ST_DB.savePreset(preset);
  };

  P.deletePreset = function (id) { return window.ST_DB.deletePreset(id); };

  /** 新建一份默认预设并落库（useSillytavern.addPresetFromDefault） */
  P.addPresetFromDefault = function (name) {
    var p = C.createDefaultPreset(name);
    p.createdAt = Date.now();
    p.updatedAt = Date.now();
    return P.savePreset(p).then(function () { return p; });
  };

  /* ============================================================
     2) 解析「当前预设」（useSillytavern.sendMessage 的同名逻辑）
     ------------------------------------------------------------
         presets.find(p => p.id === settings.activePresetId) || presets[0]
     ============================================================ */
  P.resolvePreset = function (presets, settings) {
    var list = presets || [];
    if (!list.length) return null;
    var activeId = settings && settings.activePresetId;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === activeId) return list[i];
    }
    return list[0];
  };

  /* ============================================================
     3) prompt_order / prompts 读取（assemblePrompt 的输入）
     ------------------------------------------------------------
     要兼容四种真实形态（前两种是 SillyTavern 现行导出格式，
     少了它们，导入的预设「在 ST 里启用的模块」一律读不到）：
       ① 扁平数组 [{identifier, enabled}, …]            （skill 标准形）
       ② 分组数组 [{character_id, order:[…]}, …]        （ST 新版）
       ③ 映射对象 {"8":[…], "0":[…]}                    （ST 现行！
          键是角色 ID——旧实现只认 system_prompt/user_prompt，
          于是导入后取到空数组，模块全丢，这就是「导入不生效」的根因）
       ④ 超旧对象 {system_prompt:[…], user_prompt:[…]}
     ②③ 都取条目最多的那一组（主聊天组）。
     ============================================================ */
  /* skill v20–v23 的标准 10 项顺序（worldInfoAfter 在 chatHistory 之后）。
     那是 skill 模板的位置错误：after_char 世界书会被挤到历史之后的中段
     system 消息，弱模型不服从。凡**逐字等于**该签名的顺序，读取时把
     worldInfoAfter 挪到 dialogueExamples 之前（角色定义区末尾）。
     只迁移未被动过的手动顺序——用户若亲手排过序，一律尊重。 */
  var LEGACY_ORDER_SIGNATURE = ['main', 'worldInfoBefore', 'charDescription', 'charPersonality',
    'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory', 'worldInfoAfter', 'groupNudge'];

  function migrateLegacyOrder(items) {
    if (!Array.isArray(items) || items.length !== LEGACY_ORDER_SIGNATURE.length) return items;
    for (var i = 0; i < items.length; i++) {
      if (!items[i] || items[i].identifier !== LEGACY_ORDER_SIGNATURE[i]) return items;
    }
    var out = items.slice();
    var at = -1;
    out.forEach(function (o, idx) { if (o.identifier === 'worldInfoAfter') at = idx; });
    if (at < 0) return items;
    var moved = out.splice(at, 1)[0];
    var insertAt = 0;
    out.forEach(function (o, idx) { if (o.identifier === 'personaDescription') insertAt = idx + 1; });
    out.splice(insertAt, 0, moved);
    return out;
  }

  P.getPromptOrder = function (settings) {
    var po = settings && settings.prompt_order;
    if (!po) return [];
    var items = null;
    if (Array.isArray(po)) {
      if (po.length && po[0] && Array.isArray(po[0].order)) {
        var main = po.reduce(function (a, b) {
          return ((b.order || []).length > (a.order || []).length ? b : a);
        }, po[0]);
        items = (main && main.order) || [];
      } else {
        items = po;
      }
    } else if (typeof po === 'object') {
      if (Array.isArray(po.system_prompt) || Array.isArray(po.user_prompt)) {
        items = [].concat(po.system_prompt || [], po.user_prompt || []);
      } else {
        var best = null;
        Object.keys(po).forEach(function (k) {
          var v = po[k];
          if (Array.isArray(v) && (!best || v.length > best.length)) best = v;
        });
        items = best || [];
      }
    }
    return migrateLegacyOrder(items || []);
  };

  P.getPrompts = function (settings) {
    return (settings && Array.isArray(settings.prompts)) ? settings.prompts : [];
  };

  /* ============================================================
     4) 导入 / 导出（照搬 importer.ts）
     ============================================================ */
  P.importPreset = function (data) {
    data = data || {};
    return {
      name: data.preset || data.name || '导入的预设',
      description: data.description,
      settings: data
    };
  };

  P.exportPreset = function (preset) {
    var out = {};
    Object.keys(preset.settings || {}).forEach(function (k) { out[k] = preset.settings[k]; });
    out.name = preset.name;
    if (preset.description !== undefined) out.description = preset.description;
    return out;
  };

  /** 落库版导入 */
  P.importAndSave = function (data) {
    var base = P.importPreset(data);
    var now = Date.now();
    var p = {
      id: C.uid(),
      name: base.name,
      description: base.description,
      settings: base.settings,
      createdAt: now,
      updatedAt: now
    };
    return P.savePreset(p).then(function () { return p; });
  };

  /* ============================================================
     5) 请求体构造（照搬 useSillytavern.sendMessage）
     ------------------------------------------------------------
     model 取预设的 openai_model，留空回落到接口设置的 model。
     其余采样字段「定义了才带上」，不塞默认值。
     ============================================================ */
  P.buildRequestBody = function (preset, settings, messages) {
    var s = (preset && preset.settings) || {};
    var api = (settings && settings.api) || {};
    var body = {
      model: s.openai_model || api.model,
      messages: messages
    };
    if (s.temp_openai !== undefined) body.temperature = s.temp_openai;
    if (s.openai_max_tokens !== undefined) body.max_tokens = s.openai_max_tokens;
    if (s.top_p_openai !== undefined) body.top_p = s.top_p_openai;
    if (s.freq_pen_openai !== undefined) body.frequency_penalty = s.freq_pen_openai;
    if (s.pres_pen_openai !== undefined) body.presence_penalty = s.pres_pen_openai;
    if (s.stream_openai !== undefined) body.stream = s.stream_openai;
    return body;
  };

  /** 上下文预算（assemblePrompt 的 maxContextTokens 同源） */
  P.maxContextTokens = function (preset) {
    var s = (preset && preset.settings) || {};
    return s.openai_max_context || s.max_length || 4096;
  };

  window.ST_PRESET = P;
})();

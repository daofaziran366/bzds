/* ============================================================
   腐化 · SillyTavern 集成内核 ④ 提示词组装层
   ------------------------------------------------------------
   照搬 skill sillytavern-web：
     templates/react/sillytavern/prompt-assembler.ts

   逐条对应关系：
     · scanText = userInput + ' ' + history.slice(-3) 的内容拼接
     · 每本书 new LorebookEngine(book).recursiveScan(scanText, 3)
     · 命中去重按 entry.id（Map 保序），再按 score 升序
     · 历史裁剪：token ≈ content.length / 4，预算 maxContextTokens * 0.8
     · 按 prompt_order 逐槽；chatHistory 是唯一拆进 messages 的槽
     · worldInfoBefore / worldInfoAfter **按 position 分流**（偏离 skill
       原文的一处刻意修正）：skill 让两槽各返回全部命中，结果是停用
       任意一槽都毫无可见变化——用户报告「勾选开关无效」。SillyTavern
       本体即按 position 分，这里对齐：before 槽 ← before_char/before_example，
       after 槽 ← after_char/after_example/example_msg_*，outlet 不进。
     · **at_depth 独立成消息插进对话流**（第三处修正）：旧实现把它归进 after 槽，
       于是 entry.depth / entry.role 完全失效——depth=1 与 depth=8 落在同一条
       消息同一位置。现在按 buildDepthInjections 计算插入点：depth = 距最新
       消息的条数，role 决定消息角色（0 system / 1 user / 2 assistant）。
     · worldInfoAfter 排在**角色定义区末尾、对话示例/历史之前**（第二处修正）：
       skill 模板把它放在 chatHistory 之后，分流后 after_char 设定（内置模板
       28/31 条）全被挤到历史中段，弱模型不服从——旧「两槽全量」的重复
       注入恰好掩盖了它。现在全部设定聚回头部 system 块；尾部只剩
       变量块 + 输出协议（近端效应更好）。存量预设由 getPromptOrder 按
       旧签名逐字匹配自动迁移，手动排过序的一律尊重。
     · WI 两槽缺席 prompt_order → 按启用补入（ensureWiSlots，缺席≠停用）
     · variablesBlock / formatPrompt 是一等槽位；缺席 prompt_order 时
       才按 skill 原样无条件追加在 system 尾
     · system 角色槽累加成一条；非 system 先冲刷累加器再单独成条
     · 末尾追加 variablesBlock / extraVariables / formatPrompt
     · 累加器最终 unshift 到 messages 头部
     · prompt_order 没有 chatHistory 时，历史补在尾部
     · 始终以 userInput 作为最后一条 user 消息
   ============================================================ */
(function () {
  'use strict';

  var C = window.ST_CORE;
  var L = window.ST_LOREBOOK;
  var P = window.ST_PRESET;
  var A = {};

  /* ---------- resolvePromptContent（照搬原文的 identifier 分派） ----------
     扩展一：variablesBlock / formatPrompt 在本层升级为**一等槽位**，这样
     模块面板才能对它们做「开关 + 排序」。二者缺席 prompt_order 时，
     由 assemblePrompt 末尾按 skill 原样无条件追加（向后兼容）。
     扩展二：worldInfoBefore / worldInfoAfter **按 position 分流**。
     skill 原文两槽都返回全部命中——后果是停用任何一个槽都毫无可见
     变化（另一个槽把同样的内容全注入），用户报告「勾选开关没用」。
     SillyTavern 本体就是按 position 分的，这里对齐真实行为：
       before 槽 ← before_char / before_example
       after  槽 ← after_char / after_example / at_depth / example_msg_*
       outlet     ← 两槽都不进（条目语义就是「不自动注入」） */
  var WI_BEFORE_POS = { before_char: 1, before_example: 1 };
  /* at_depth 已从这里移除：它现在按 entry.depth/role 真正插进对话流（见
     buildDepthInjections）。旧实现把它当 after_char 处理，depth=1 与 depth=8
     落在同一条消息同一位置，「按深度注入」名存实亡。 */
  var WI_AFTER_POS = {
    after_char: 1, after_example: 1,
    example_msg_top: 1, example_msg_bottom: 1
  };
  function wiSlotContent(uniqueEntries, posSet) {
    return uniqueEntries.filter(function (e) {
      return posSet[e.entry.position || 'after_char'];
    }).map(function (e) {
      return e.entry.content;
    }).join('\n\n') || null;
  }

  /* ---------- at_depth：按 depth / role 插进对话流 ----------
     真实 SillyTavern 语义：position='at_depth' 的条目**不进** worldInfoBefore/
     After 槽，而是作为独立消息插入历史，depth = 距离「最新消息」的条数
     （1 = 紧邻最新一条之前），role 决定它伪装成谁说的话（0 system / 1 user /
     2 assistant）。这样设定能贴近生成点，又不污染头部 system 块。

     实现：先算出每条 at_depth 条目在 recentHistory 里的插入下标，再在
     chatHistory 落地时一并展开（插在历史内部，不能只追加到末尾）。
     同 depth 的多条按 order 升序合并成一条消息，role 取该组第一条。 */
  function buildDepthInjections(uniqueEntries, historyLen) {
    var groups = {};
    var orderKeys = [];
    uniqueEntries.forEach(function (m) {
      var e = m.entry;
      if ((e.position || '') !== 'at_depth') return;
      var d = (e.depth == null ? 4 : Number(e.depth));
      if (!isFinite(d) || d < 0) d = 4;
      /* depth 是「距离最新消息的条数」，转成 history 内的绝对下标 */
      var idx = Math.max(0, historyLen - d);
      var key = idx + '|' + (e.role == null ? 0 : Number(e.role));
      if (!groups[key]) { groups[key] = { idx: idx, role: e.role, items: [] }; orderKeys.push(key); }
      groups[key].items.push(m);
    });
    return orderKeys.map(function (k) { return groups[k]; })
      .sort(function (a, b) { return a.idx - b.idx; });
  }
  function findPromptEntry(identifier, ctx) {
    var prompts = P.getPrompts(ctx.preset.settings || {});
    for (var i = 0; i < prompts.length; i++) {
      if (prompts[i] && prompts[i].identifier === identifier) return prompts[i];
    }
    return null;
  }
  function resolvePromptContent(identifier, ctx) {
    var uniqueEntries = ctx.matched;
    var preset = ctx.preset;
    var s = preset.settings || {};
    if (identifier === 'worldInfoBefore') return wiSlotContent(uniqueEntries, WI_BEFORE_POS);
    if (identifier === 'worldInfoAfter') return wiSlotContent(uniqueEntries, WI_AFTER_POS);
    if (identifier === 'variablesBlock') {
      var parts = [];
      /* 状态卡（VARS.digest）优先——它是游戏侧真相，含全部可写路径；
         没有卡时才退回 variables 键值对（旧调用方 / 纯单测路径） */
      var vb = ctx.digest || ctx.formatVariables(ctx.variables);
      if (vb) parts.push(vb);
      if (ctx.extraVariables && Object.keys(ctx.extraVariables).length) {
        var eb = ctx.formatVariables(ctx.extraVariables);
        if (eb) parts.push(eb);
      }
      return parts.join('\n\n') || null;
    }
    if (identifier === 'formatPrompt') {
      return ctx.formatPrompt || null;
    }
    if (identifier === 'charDescription') return s.character_description || null;
    if (identifier === 'charPersonality') return s.character_personality || null;
    if (identifier === 'scenario') return s.scenario || null;
    if (identifier === 'personaDescription') return s.persona_description || null;
    if (identifier === 'dialogueExamples') return s.dialogue_examples || null;
    if (identifier === 'groupNudge') return s.group_nudge_prompt || null;
    if (identifier === 'impersonate') return s.impersonation_prompt || null;
    if (identifier === 'quietPrompt') return s.quiet_prompt || null;
    if (identifier === 'bias') return null;

    var prompts = P.getPrompts(s);
    for (var i = 0; i < prompts.length; i++) {
      if (prompts[i] && prompts[i].identifier === identifier && prompts[i].content) {
        return prompts[i].content;
      }
    }
    var direct = s[identifier];
    if (typeof direct === 'string' && direct.trim()) return direct;
    return null;
  }

  /**
   * assemblePrompt(options) → { messages, matchedEntries, systemPrompt }
   *
   * options:
   *   userInput      string
   *   history        ChatMessage[]
   *   preset         ChatPreset
   *   lorebooks      Lorebook[]   （已激活的书，不是条目）
   *   userName       string
   *   characterName  string
   *   variables      Record<string, string|number>
   *   digest         string        状态卡（VARS.digest），优先于 variables 进 variablesBlock
   *   extraVariables Record<string, any>
   *   formatPrompt   string
   */
  A.assemblePrompt = function (options) {
    var userInput = options.userInput;
    var history = options.history || [];
    var preset = options.preset || { settings: {} };
    var lorebooks = options.lorebooks || [];
    var userName = options.userName;
    var characterName = options.characterName;
    var variables = options.variables;
    var digest = options.digest;
    var extraVariables = options.extraVariables;
    var formatPrompt = options.formatPrompt;

    /* ---------- 1) 世界书命中 ---------- */
    var allMatchedEntries = [];
    var tail = history.slice(-3).map(function (m) { return m.content; }).join(' ');
    var scanText = userInput + ' ' + tail;

    lorebooks.forEach(function (book) {
      var engine = L.createLorebookEngine(book);
      var matches = engine.recursiveScan(scanText, 3);
      allMatchedEntries = allMatchedEntries.concat(matches);
    });

    var dedup = {};
    var uniqueEntries = [];
    allMatchedEntries.forEach(function (e) {
      if (!dedup[e.entry.id]) { dedup[e.entry.id] = true; uniqueEntries.push(e); }
    });
    uniqueEntries = uniqueEntries.sort(function (a, b) { return a.score - b.score; });

    /* ---------- 2) 历史裁剪 ---------- */
    var maxContextTokens = P.maxContextTokens(preset);
    var currentTokens = 0;
    var recentHistory = [];
    for (var i = history.length - 1; i >= 0; i--) {
      var msg = history[i];
      if (msg.role === 'system') continue;
      var msgTokens = msg.content.length / 4;
      if (currentTokens + msgTokens > maxContextTokens * 0.8) break;
      recentHistory.unshift({ role: msg.role, content: msg.content });
      currentTokens += msgTokens;
    }

    /* ---------- 3) 按 prompt_order 逐槽组装 ---------- */
    var promptOrder = P.getPromptOrder(preset.settings);

    /* 运行时兜底：prompt_order **缺席** WI 两槽（≠ 显式停用）→ 按启用
       补到惯常落点。导入的怪预设若漏了世界书槽，曾经整本设定静默不注入；
       缺席代表文件没表态，引擎默认就是「激活的书要注入」。显式列了但
       enabled:false 的不在补列之列——那才是用户表态。 */
    function indexOfId(list, id) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].identifier === id) return i;
      }
      return -1;
    }
    (function ensureWiSlots() {
      var hasBefore = indexOfId(promptOrder, 'worldInfoBefore') !== -1;
      var hasAfter = indexOfId(promptOrder, 'worldInfoAfter') !== -1;
      if (hasBefore && hasAfter) return;
      var out = promptOrder.slice();
      if (!hasBefore) {
        var atMain = indexOfId(out, 'main');
        out.splice(atMain >= 0 ? atMain + 1 : 0, 0,
          { identifier: 'worldInfoBefore', name: 'World Info (Before)', role: 'system', enabled: true });
      }
      if (!hasAfter) {
        /* 补在角色定义区末尾：优先 dialogueExamples 之前，其次 chatHistory / groupNudge 之前 */
        var atAfter = -1;
        ['dialogueExamples', 'chatHistory', 'groupNudge'].some(function (anchor) {
          atAfter = indexOfId(out, anchor);
          return atAfter >= 0;
        });
        out.splice(atAfter >= 0 ? atAfter : out.length, 0,
          { identifier: 'worldInfoAfter', name: 'World Info (After)', role: 'system', enabled: true });
      }
      promptOrder = out;
    })();

    var assembledMessages = [];
    var systemAccumulator = '';
    var hasChatHistory = false;
    /* 是否已经中途冲出过一条 system。用完必须配合下面的 push/unshift 分支：
       skill 原文无条件 unshift——当中途冲出过一次后，after 槽等
       「历史之后才累积」的内容会被顶到 main 前面，槽序全乱。
       （旧语义下两槽都注全部命中，恰好把乱序遮住了；按 position
       分流后必须修正。） */
    var flushedOnce = false;
    /* 在 prompt_order 里出现过的 identifier（无论启用与否）。
       显式出现过 = 用户已表态，末尾兜底不得违背其意图。 */
    var consumed = {};

    function appendSystem(text) {
      systemAccumulator += (systemAccumulator ? '\n\n' : '') + text;
    }
    function flushSystem() {
      if (systemAccumulator) {
        assembledMessages.push({ role: 'system', content: systemAccumulator });
        systemAccumulator = '';
        flushedOnce = true;
      }
    }

    var slotCtx = {
      matched: uniqueEntries, preset: preset,
      variables: variables, digest: digest, extraVariables: extraVariables,
      formatPrompt: formatPrompt,
      formatVariables: C.formatVariablesForPrompt
    };

    promptOrder.forEach(function (item) {
      if (!item || !item.identifier) return;
      consumed[item.identifier] = true;
      if (item.enabled === false) return;

      if (item.identifier === 'chatHistory') {
        hasChatHistory = true;
        flushSystem();
        /* at_depth 条目：插进历史内部的指定位置（按 depth 从旧到新展开）。
           role 数值 → 名字：0 system / 1 user / 2 assistant。 */
        var depthInj = buildDepthInjections(uniqueEntries, recentHistory.length);
        var ROLE_BY_ID = C.ROLE_BY_ID || { 0: 'system', 1: 'user', 2: 'assistant' };
        var di = 0;
        for (var hi = 0; hi <= recentHistory.length; hi++) {
          while (di < depthInj.length && depthInj[di].idx === hi) {
            var g = depthInj[di];
            assembledMessages.push({
              role: ROLE_BY_ID[g.role == null ? 0 : Number(g.role)] || 'system',
              content: g.items.map(function (x) { return x.entry.content; }).join('\n\n')
            });
            di++;
          }
          if (hi < recentHistory.length) assembledMessages.push(recentHistory[hi]);
        }
        return;
      }

      var rawContent = resolvePromptContent(item.identifier, slotCtx);
      if (!rawContent) return;

      var content = C.replaceMacros(rawContent, {
        userName: userName, characterName: characterName,
        userInput: userInput, variables: variables
      });
      if (!content.trim()) return;

      /* SillyTavern 本体语义：消息角色取自 prompts 条目的 role 字段
         （导入的真实预设大量使用 role:"user"/"assistant" 的指令条目，
         order 项本身不带 role）。order 项显式带 role 时以其为准。 */
      var entry = findPromptEntry(item.identifier, slotCtx);
      var role = (entry && entry.role) || item.role || 'system';
      if (role === 'system') {
        appendSystem(content);
      } else {
        flushSystem();
        assembledMessages.push({ role: role, content: content });
      }
    });

    /* ---------- 4) 变量块 / 额外变量 / 输出协议 ----------
       prompt_order 未列出这两个槽 → 按 skill 原样无条件追加在 system 尾。
       列出了（哪怕被停用）→ 上面循环已按用户意图处理，这里不再插手。 */
    if (!consumed.variablesBlock) {
      var vb = resolvePromptContent('variablesBlock', slotCtx);
      if (vb) appendSystem(vb);
    }
    if (!consumed.formatPrompt && formatPrompt) appendSystem(formatPrompt);

    if (systemAccumulator) {
      var tailSystemMsg = { role: 'system', content: systemAccumulator };
      /* 中途冲出过 → 余量接在历史之后（保持槽位先后）；从未冲出 →
         按 skill 原样 unshift 到头（整段 system 都在余量里） */
      if (flushedOnce) assembledMessages.push(tailSystemMsg);
      else assembledMessages.unshift(tailSystemMsg);
      systemAccumulator = '';
    }

    /* ---------- 5) 兜底与收尾 ---------- */
    /* prompt_order 没有 chatHistory 槽 → 历史补在尾部；
       at_depth 条目同样要插进这段历史里，否则它们会整批丢失。 */
    if (!hasChatHistory) {
      var ROLE2 = C.ROLE_BY_ID || { 0: 'system', 1: 'user', 2: 'assistant' };
      if (recentHistory.length) {
        var depthInj2 = buildDepthInjections(uniqueEntries, recentHistory.length);
        var dj = 0;
        for (var hj = 0; hj <= recentHistory.length; hj++) {
          while (dj < depthInj2.length && depthInj2[dj].idx === hj) {
            var g2 = depthInj2[dj];
            assembledMessages.push({
              role: ROLE2[g2.role == null ? 0 : Number(g2.role)] || 'system',
              content: g2.items.map(function (x) { return x.entry.content; }).join('\n\n')
            });
            dj++;
          }
          if (hj < recentHistory.length) assembledMessages.push(recentHistory[hj]);
        }
      } else {
        /* 没有历史可插入：把 at_depth 条目退化为独立的 system 片段，
           总比静默丢弃强（旧实现正是把它们塞进 after 槽）。 */
        buildDepthInjections(uniqueEntries, 0).forEach(function (g3) {
          assembledMessages.push({
            role: ROLE2[g3.role == null ? 0 : Number(g3.role)] || 'system',
            content: g3.items.map(function (x) { return x.entry.content; }).join('\n\n')
          });
        });
      }
    }

    assembledMessages.push({ role: 'user', content: userInput });

    var systemPrompt = assembledMessages
      .filter(function (m) { return m.role === 'system'; })
      .map(function (m) { return m.content; })
      .join('\n\n');

    return {
      messages: assembledMessages,
      matchedEntries: uniqueEntries,
      systemPrompt: systemPrompt
    };
  };

  /* ============================================================
     调试：把组装结果渲染成可读文本（预设面板「预览」用）
     ============================================================ */
  A.previewPrompt = function (result) {
    if (!result) return '';
    var lines = [];
    result.messages.forEach(function (m, i) {
      lines.push('── [' + (i + 1) + '] ' + m.role + ' ──');
      lines.push(String(m.content || ''));
      lines.push('');
    });
    var head = '共 ' + result.messages.length + ' 条消息 · 世界书命中 '
      + (result.matchedEntries || []).length + ' 条';
    if (result.matchedEntries && result.matchedEntries.length) {
      head += '（' + result.matchedEntries.map(function (e) {
        return C.entryLabel(e.entry);
      }).join('、') + '）';
    }
    return head + '\n\n' + lines.join('\n');
  };

  /* ============================================================
     历史压缩（功能二）
     ------------------------------------------------------------
     规则（x = histFullTurns，y = histDigestTurns，均玩家可在酒馆页调）：
       · 最近 x 个回合      → 正文全文
       · 比 x 旧、比 y 新    → 玩家指令保留原文（短），AI 正文换成它的 <sum> 概括
       · 比 y 更旧          → 全部概括合并成一条「往事」system 消息，置于最前
     回合 = 一条 user 消息 + 其后所有 assistant 消息（开头的散装 assistant
     自成一个回合）。没有 sum 的回合（本地引擎 / 旧存档）退回截取正文。
     ============================================================ */
  window.ST_ASSEMBLER = A;
})();

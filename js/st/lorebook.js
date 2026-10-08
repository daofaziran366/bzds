/* ============================================================
   腐化 · SillyTavern 集成内核 ② 世界书层
   ------------------------------------------------------------
   照搬 skill sillytavern-web：
     templates/react/sillytavern/lorebook-engine.ts   （匹配引擎）
     templates/react/sillytavern/importer.ts          （ST 格式导入导出）
     templates/react/sillytavern/database.ts          （持久化，改走 ST_DB）

   与上一版的根本差别：本版严格照搬 skill 语义，因此**移除**了
   skill 里不存在的能力——读取设置层（depth/budget/recursive/
   minActivations/scanPersona）、sticky / cooldown / delay 回合状态机、
   @@ 装饰器、条目级三态大小写/整词、分组评分。这些是上一版自加的
   扩展，不是 skill 规范。skill 的语义是：

     · 扫描窗口由 assemblePrompt 计算：
         scanText = userInput + ' ' + history.slice(-3) 的内容
     · 递归深度固定 3 轮，且仅当 book.recursiveScanning 为真
     · probability 无条件生效（不看 useProbability）：
         Math.random() * 100 >= entry.probability → 跳过
       但 constant 条目在此之前直接收录，不受概率约束
     · 整词匹配用 \\b（skill 原文；对 CJK 无效是 skill 的已知取舍）
     · selectiveLogic 的四逻辑按 skill 的归一化实现，不是 ST 原版
     · 排序键 score = entry.order（constant 为 -9999），升序
     · 导入时 disable / excluded 的条目**直接丢弃**（skill 原文）
   ============================================================ */
(function () {
  'use strict';

  var C = window.ST_CORE;
  var L = {};

  /* ============================================================
     1) LorebookEngine（照搬 lorebook-engine.ts）
     ============================================================ */
  function LorebookEngine(lorebook) {
    this.lorebook = lorebook;
  }

  LorebookEngine.prototype.scan = function (text, additionalContext) {
    var normalizedText = this.lorebook.caseSensitive ? text : String(text).toLowerCase();
    var normalizedContext = additionalContext
      ? (this.lorebook.caseSensitive ? additionalContext : String(additionalContext).toLowerCase())
      : normalizedText;

    var matched = [];

    for (var i = 0; i < this.lorebook.entries.length; i++) {
      var entry = this.lorebook.entries[i];

      /* 条目级停用：整条跳过（含常驻）——用户要的是"留着但不注入" */
      if (entry.disabled) continue;

      if (entry.constant) {
        matched.push({ entry: entry, score: -9999, matchedKeywords: ['constant'] });
        continue;
      }

      /* 概率：**只有 useProbability 为真时才掷骰**（真实 ST 语义）。
         skill 原文是无条件 `Math.random()*100 >= probability`，于是关掉
         「启用概率」开关的条目照样被概率拦掉——开关形同虚设。
         注意兼容旧数据：导入路径已把 useProbability=false 的条目归一成
         probability=100，所以历史存档不受影响；这里只纠正直接构造的条目。 */
      if (entry.useProbability && Math.random() * 100 >= entry.probability) continue;

      if (this.checkEntryMatch(entry, normalizedText, normalizedContext)) {
        var self = this;
        matched.push({
          entry: entry,
          score: entry.order,
          matchedKeywords: (entry.keys || []).filter(function (k) {
            return self.containsKeyword(normalizedText, self.normalizeKeyword(k));
          })
        });
      }
    }

    return matched.sort(function (a, b) { return a.score - b.score; });
  };

  LorebookEngine.prototype.recursiveScan = function (initialText, maxDepth, additionalContext) {
    if (maxDepth === undefined) maxDepth = 3;
    if (!this.lorebook.recursiveScanning || maxDepth <= 0) {
      return this.scan(initialText, additionalContext);
    }

    var allMatched = {};
    var order = [];
    var currentText = initialText;
    var depth = 0;

    while (depth < maxDepth) {
      var newMatches = this.scan(currentText, additionalContext);
      var hasNewMatches = false;

      for (var i = 0; i < newMatches.length; i++) {
        var match = newMatches[i];
        if (!allMatched[match.entry.id]) {
          allMatched[match.entry.id] = match;
          order.push(match.entry.id);
          currentText += ' ' + match.entry.content;
          hasNewMatches = true;
        }
      }

      if (!hasNewMatches) break;
      depth++;
    }

    return order.map(function (id) { return allMatched[id]; })
      .sort(function (a, b) { return a.score - b.score; });
  };

  LorebookEngine.prototype.groupByPosition = function (matched) {
    var grouped = {
      before_char: [], after_char: [], before_example: [], after_example: [],
      at_depth: [], example_msg_top: [], example_msg_bottom: [], outlet: []
    };
    for (var i = 0; i < matched.length; i++) {
      var m = matched[i];
      (grouped[m.entry.position] || (grouped[m.entry.position] = [])).push(m);
    }
    return grouped;
  };

  LorebookEngine.prototype.formatEntriesContent = function (entries) {
    if (!entries.length) return '';
    return entries.map(function (e) { return e.entry.content; }).join('\n\n');
  };

  /* 条目命中判定 —— 对齐**真实 SillyTavern** 语义（第 4 处对 skill 模板的刻意偏离）
     ------------------------------------------------------------
     skill 模板（lorebook-engine.ts:comment 自认）把 selectiveLogic 同时套在主键
     和副键上，源码注释原文是「For simple frontend integration, both and_any/
     and_all treat primary as OR-ish trigger」。后果：
       · selective=false（最常见）时 not_all/not_any 仍会反转主键 →
         条目在**关键词缺席时反而注入**，触发完全反了；
       · keys=[A,B] + not_all 时「A、B 都出现」不触发、「都没出现」反而触发。
     真实 ST（world-info.js）语义是：
       · 主键永远是**纯 OR**（任一命中即可），与 selectiveLogic 无关；
       · selective=true 时，再用 selectiveLogic 判定副键（secondaryKeys）；
       · 副键四逻辑：and_any=任一命中 / and_all=全部命中 /
                     not_all=非全部命中 / not_any=全不命中。 */
  LorebookEngine.prototype.checkEntryMatch = function (entry, text, context) {
    var keys = entry.keys || [];
    var secondaryKeys = entry.secondaryKeys || [];
    var selective = entry.selective;
    var selectiveLogic = entry.selectiveLogic;

    if (keys.length === 0) return false;

    var self = this;

    /* 主键：纯 OR，不看 selectiveLogic */
    var primaryOk = keys.some(function (k) {
      return self.containsKeyword(text, self.normalizeKeyword(k));
    });
    if (!primaryOk) return false;

    /* 未开选择性 / 没写副键 → 主键命中即通过（ST 同） */
    if (!selective || secondaryKeys.length === 0) return true;

    var secondaryMatches = secondaryKeys.map(function (k) {
      return self.containsKeyword(context, self.normalizeKeyword(k));
    });
    var allSecondary = secondaryMatches.every(function (m) { return m; });
    var anySecondary = secondaryMatches.some(function (m) { return m; });

    switch (selectiveLogic) {
      case 'and_all':
        return allSecondary;
      case 'not_all':
        return !allSecondary;
      case 'not_any':
        return !anySecondary;
      case 'and_any':
      default:
        return anySecondary;
    }
  };

  LorebookEngine.prototype.normalizeKeyword = function (keyword) {
    return this.lorebook.caseSensitive ? keyword : String(keyword).toLowerCase();
  };

  LorebookEngine.prototype.containsKeyword = function (text, keyword) {
    if (this.lorebook.matchWholeWords) {
      var regex = new RegExp('\\b' + this.escapeRegex(keyword) + '\\b', 'i');
      return regex.test(text);
    }
    return String(text).indexOf(keyword) !== -1;
  };

  LorebookEngine.prototype.escapeRegex = function (str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  L.LorebookEngine = LorebookEngine;
  L.createLorebookEngine = function (lorebook) { return new LorebookEngine(lorebook); };

  /* ============================================================
     2) 持久化（database.ts 的世界书部分，异步）
     ============================================================ */
  L.getLorebooks = function () { return window.ST_DB.getLorebooks(); };
  L.getLorebook = function (id) { return window.ST_DB.getLorebook(id); };
  L.deleteLorebook = function (id) { return window.ST_DB.deleteLorebook(id); };

  /* 注意：ST_DB.saveLorebook 按 skill 契约 resolve 的是 id（字符串）。
     本层统一改 resolve 书对象，免得调用方误把 id 当 book 用。 */
  L.saveLorebook = function (lorebook) {
    if (!lorebook) return Promise.resolve(null);
    if (!lorebook.id) lorebook.id = C.uid();
    lorebook.updatedAt = Date.now();
    return window.ST_DB.saveLorebook(lorebook).then(function () { return lorebook; });
  };

  /** 新建一本空世界书并落库 */
  L.createLorebook = function (name) {
    var lb = C.createDefaultLorebook(name || '新世界书');
    return L.saveLorebook(lb).then(function () { return lb; });
  };

  /* ============================================================
     3) 激活状态（skill：settings.activeLorebookIds，不是 book.enabled）
     ============================================================ */
  L.getActiveIds = function (settings) {
    return ((settings && settings.activeLorebookIds) || []).slice();
  };

  L.toggleActive = function (settings, id) {
    var ids = L.getActiveIds(settings);
    var at = ids.indexOf(id);
    if (at >= 0) ids.splice(at, 1); else ids.push(id);
    return ids;
  };

  /** 取当前激活的书（books 已按 id 匹配） */
  L.activeBooks = function (books, settings) {
    var ids = L.getActiveIds(settings);
    return (books || []).filter(function (b) { return ids.indexOf(b.id) !== -1; });
  };

  /* ============================================================
     4) 导入 / 导出（照搬 importer.ts）
     ============================================================ */
  L.importLorebook = function (data) {
    data = data || {};
    var rawEntries = Object.keys(data.entries || {}).map(function (k) { return data.entries[k]; });

    /* skill 原文是 `.filter(!disable && !excluded)` 直接丢弃停用条目——
       那样导入一份 ST 世界书会静默少一批，用户在管理器里看不到也开不回。
       这里改为**保留并标为停用**（SillyTavern 自身导入后也是这个表现）。 */
    var entries = rawEntries
      .filter(function (e) { return !!e; })
      .map(function (e) {
        return {
          id: C.uid(),
          keys: e.key || [],
          secondaryKeys: e.keysecondary || [],
          content: e.content || '',
          comment: e.comment,
          disabled: !!(e.disable || e.excluded),
          order: e.order != null ? e.order : 100,
          position: C.POSITION_MAP[e.position != null ? e.position : 1] || 'after_char',
          depth: e.depth,
          role: e.role,
          selective: e.selective != null ? e.selective : false,
          /* 兜底必须是 and_any(0) —— 真实 ST 的默认值。
             这里原先是 LOGIC_MAP[1] = not_all：绝大多数 ST 世界书导出**不带**
             selectiveLogic 字段，于是导入后主键判定被反转（提关键词时静默、
             不提时反而注入）。旧实现在主键上套 selectiveLogic，问题被放大；
             即便主键已改为纯 OR，not_all 仍会在副键层给出反直觉结果，
             故兜底一律取 ST 的默认 and_any。 */
          selectiveLogic: (e.selectiveLogic != null
            ? (C.LOGIC_MAP[e.selectiveLogic] || 'and_any')
            : 'and_any'),
          constant: e.constant != null ? e.constant : false,
          probability: e.useProbability ? (e.probability != null ? e.probability : 100) : 100,
          useProbability: e.useProbability != null ? e.useProbability : false,
          addMemo: e.addMemo != null ? e.addMemo : false,
          sticky: e.sticky,
          cooldown: e.cooldown,
          delay: e.delay,
          weight: e.weight,
          scanDepth: e.scanDepth,
          caseSensitive: e.caseSensitive,
          matchWholeWords: e.matchWholeWords,
          excludeRecursion: e.excludeRecursion,
          preventRecursion: e.preventRecursion,
          useGroupScoring: e.useGroupScoring,
          matchPersonaDescription: e.matchPersonaDescription,
          matchCharacterDescription: e.matchCharacterDescription,
          matchCharacterPersonality: e.matchCharacterPersonality,
          matchCharacterDepthPrompt: e.matchCharacterDepthPrompt,
          matchScenario: e.matchScenario,
          matchCreatorNotes: e.matchCreatorNotes,
          group: e.group,
          decorators: e.decorators,
          characterFilter: e.characterFilter
        };
      });

    var st = data.settings || {};
    return {
      name: data.name || '导入的世界书',
      description: data.description,
      entries: entries,
      recursiveScanning: st.recursive_scanning != null ? st.recursive_scanning : false,
      caseSensitive: st.case_sensitive != null ? st.case_sensitive : false,
      matchWholeWords: st.match_whole_words != null ? st.match_whole_words : false
    };
  };

  /** 落库版：importLorebook + 建 id/时间戳 + 保存 */
  L.importAndSave = function (data) {
    var base = L.importLorebook(data);
    var now = Date.now();
    var lb = {
      id: C.uid(),
      name: base.name,
      description: base.description,
      entries: base.entries,
      recursiveScanning: base.recursiveScanning,
      caseSensitive: base.caseSensitive,
      matchWholeWords: base.matchWholeWords,
      createdAt: now,
      updatedAt: now
    };
    return L.saveLorebook(lb).then(function () { return lb; });
  };

  L.exportLorebook = function (lorebook) {
    var entries = {};
    (lorebook.entries || []).forEach(function (e, index) {
      entries[String(index)] = {
        uid: index,
        key: e.keys,
        keysecondary: e.secondaryKeys || [],
        comment: e.comment || String(e.content || '').slice(0, 50),
        content: e.content,
        constant: e.constant,
        selective: e.selective,
        selectiveLogic: C.REVERSE_LOGIC_MAP[e.selectiveLogic] != null ? C.REVERSE_LOGIC_MAP[e.selectiveLogic] : 1,
        addMemo: e.addMemo,
        order: e.order,
        position: C.REVERSE_POSITION_MAP[e.position] != null ? C.REVERSE_POSITION_MAP[e.position] : 1,
        role: e.role != null ? e.role : 0,
        disable: !!e.disabled,
        probability: e.probability,
        depth: e.depth != null ? e.depth : 4,
        group: e.group != null ? e.group : '',
        useProbability: e.useProbability != null ? e.useProbability : (e.probability < 100),
        excluded: false,
        sticky: e.sticky != null ? e.sticky : 0,
        cooldown: e.cooldown != null ? e.cooldown : 0,
        delay: e.delay != null ? e.delay : 0,
        weight: e.weight != null ? e.weight : 100,
        scanDepth: e.scanDepth != null ? e.scanDepth : 0,
        caseSensitive: e.caseSensitive != null ? e.caseSensitive : false,
        matchWholeWords: e.matchWholeWords != null ? e.matchWholeWords : false,
        excludeRecursion: e.excludeRecursion != null ? e.excludeRecursion : false,
        preventRecursion: e.preventRecursion != null ? e.preventRecursion : false,
        useGroupScoring: e.useGroupScoring != null ? e.useGroupScoring : false,
        matchPersonaDescription: e.matchPersonaDescription != null ? e.matchPersonaDescription : false,
        matchCharacterDescription: e.matchCharacterDescription != null ? e.matchCharacterDescription : false,
        matchCharacterPersonality: e.matchCharacterPersonality != null ? e.matchCharacterPersonality : false,
        matchCharacterDepthPrompt: e.matchCharacterDepthPrompt != null ? e.matchCharacterDepthPrompt : false,
        matchScenario: e.matchScenario != null ? e.matchScenario : false,
        matchCreatorNotes: e.matchCreatorNotes != null ? e.matchCreatorNotes : false,
        decorators: e.decorators != null ? e.decorators : [],
        characterFilter: e.characterFilter != null ? e.characterFilter : { isExclude: false, names: [], tags: [] }
      };
    });

    return {
      name: lorebook.name,
      description: lorebook.description,
      entries: entries,
      settings: {
        recursive_scanning: lorebook.recursiveScanning,
        case_sensitive: lorebook.caseSensitive,
        match_whole_words: lorebook.matchWholeWords
      }
    };
  };

  L.renameLorebook = function (lb, newName) {
    var out = {};
    Object.keys(lb).forEach(function (k) { out[k] = lb[k]; });
    out.name = newName;
    out.updatedAt = Date.now();
    return out;
  };

  /** 批量导入（照搬 importer.ts：非对象 / 数组一律失败） */
  L.importMultipleLorebooks = function (inputs) {
    var successes = [], failures = [];
    (inputs || []).forEach(function (input) {
      try {
        if (!input.json || typeof input.json !== 'object' || Array.isArray(input.json)) {
          throw new Error('Invalid lorebook JSON: expected an object');
        }
        var lb = L.importLorebook(input.json);
        successes.push({ fileName: input.fileName, lorebook: lb });
      } catch (e) {
        failures.push({ fileName: input.fileName, error: String((e && e.message) || e) });
      }
    });
    return { successes: successes, failures: failures };
  };

  /** 批量导入并全部落库 */
  L.importMultipleAndSave = function (inputs) {
    var res = L.importMultipleLorebooks(inputs);
    return Promise.all(
      res.successes.map(function (s) {
        return L.importAndSave(s.lorebook).then(function (saved) {
          return { fileName: s.fileName, lorebook: saved };
        });
      })
    ).then(function (savedList) {
      return { successes: savedList, failures: res.failures };
    });
  };

  window.ST_LOREBOOK = L;
})();

/* ============================================================
   腐化 · SillyTavern 集成内核 ⑦ 状态层
   ------------------------------------------------------------
   照搬 skill sillytavern-web：
     templates/react/sillytavern/types.ts   （AppSettings / DEFAULT_SETTINGS）
     templates/react/sillytavern/database.ts（settings 表读写）

   本层职责：
     ① 酒馆设置（AppSettings，存 IndexedDB settings 表）
     ② 旧版 localStorage 数据一次性迁移进 IndexedDB
     ③ 内置「临江核心设定」世界书模板（按需导入，不自动种入）
     ④ 出厂重置 / 脏键清理

   skill 语义下的关键变化（相对上一版）：
     · 不再有 book.enabled / settings.lorebookEnabled 总开关
       → 激活由 settings.activeLorebookIds 表达（skill 原文）
     · 不再有 settings.stream
       → 流式是预设的 stream_openai（skill 原文）
     · 不再有 settings.persona
       → 玩家设定走 AppSettings.userName + 预设的 persona_description 槽
     · 世界书「读取设置」层已移除（skill 无此概念）
   ============================================================ */
(function () {
  'use strict';

  var C = window.ST_CORE;
  var S = {};

  S.DEFAULT_SETTINGS = C.DEFAULT_SETTINGS;

  /* ============================================================
     1) 设置读写（database.ts 的 settings 部分）
     ============================================================ */
  S.loadSettings = function () {
    return window.ST_DB.getSettings().then(function (raw) {
      return S.normalize(raw);
    });
  };

  /** 与 DEFAULT_SETTINGS 归并，补齐缺失字段（含 api.secondary） */
  S.normalize = function (raw) {
    var s = {};
    Object.keys(S.DEFAULT_SETTINGS).forEach(function (k) {
      var v = S.DEFAULT_SETTINGS[k];
      s[k] = Array.isArray(v) ? v.slice() : v;
    });
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) {
        if (raw[k] !== undefined && raw[k] !== null) s[k] = raw[k];
      });
    }
    s.api = Object.assign({}, S.DEFAULT_SETTINGS.api, s.api || {});
    if (!s.api.secondary) {
      s.api.secondary = { enabled: false, baseUrl: '', apiKey: '', model: '' };
    }
    if (!Array.isArray(s.activeLorebookIds)) s.activeLorebookIds = [];
    /* formatPromptTemplate 为空串时回落到默认精简协议：
       normalize 会把 '' 当作有效值覆盖默认，导致旧数据（或误清空）后
       协议彻底消失、选项与变量全停。空串一律视为「未设置」。 */
    if (!s.formatPromptTemplate) s.formatPromptTemplate = C.DEFAULT_FORMAT_PROMPT;
    if (!Array.isArray(s.customTags)) {
      s.customTags = C.DEFAULT_TAGS.slice();
    }
    if (s.activePresetId === undefined) s.activePresetId = null;
    /* 旧版默认协议迁移：早期版本把一大段「标签格式 + 变量语法」
       （~1100 字）当作 formatPromptTemplate 写进了设置，并每回合无条件追加，
       实测会把预设里的文风/篇幅要求淹没。
       这里只替换「逐字属于旧默认模板」的那份 → 换为新的精简标签协议；
       用户自己写过的一律保留。 */
    if (typeof s.formatPromptTemplate === 'string' &&
        s.formatPromptTemplate.indexOf('你必须严格按照以下 XML 标签格式输出回复') !== -1 &&
        s.formatPromptTemplate.indexOf('变量命令语法') !== -1) {
      s.formatPromptTemplate = C.DEFAULT_FORMAT_PROMPT;
    }
    return s;
  };

  S.saveSettings = function (patch) {
    return S.loadSettings().then(function (s) {
      Object.keys(patch || {}).forEach(function (k) {
        if (k === 'api' && patch[k] && typeof patch[k] === 'object') {
          s.api = Object.assign({}, s.api, patch[k]);
        } else if (patch[k] !== undefined) {
          s[k] = patch[k];
        }
      });
      /* 补丁打完再 normalize 一次：旧默认协议的清理必须对「保存」路径同样生效，
         否则旧存档里那份 1100 字协议会在下一次保存时被原样写回。 */
      s = S.normalize(s);
      return window.ST_DB.saveSettings(s).then(function () { return s; });
    });
  };

  /* ============================================================
     2) 旧版 localStorage 一次性迁移
     ------------------------------------------------------------
     上一版把世界书/预设/设置全存在 localStorage：
       fushicheng.lorebooks.v2 / fushicheng.presets.v2 / fushicheng.tavern.v2
     更早版本还有 hce.* 与 fushicheng_tavern_lore_ov_v1 等脏键。
     这里只在 IndexedDB 对应表为空时迁入，迁完打上迁移标记。
     ============================================================ */
  var MIGRATE_FLAG = 'fushicheng.st.migratedToIdb.v1';

  S.LEGACY_KEYS = [
    'hce.lorebooks', 'hce.presets', 'hce.worldinfo.settings',
    'hce.lorebook.coreSeeded', 'hce.lorebook.extra', 'hce.preset.seeded',
    'fushicheng_tavern_lore_ov_v1', 'fushicheng.worldinfo.settings.v1'
  ];

  function readLocal(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /** 把旧版条目字段映射进 skill 的 LorebookEntry 形状 */
  function toSkillEntry(e) {
    return C.applyEntryDefaults({
      id: e.id || C.uid(),
      keys: Array.isArray(e.keys) ? e.keys.slice() : [],
      secondaryKeys: Array.isArray(e.secondaryKeys) ? e.secondaryKeys.slice() : [],
      content: e.content || '',
      comment: e.comment,
      order: e.order != null ? e.order : 100,
      position: C.POSITIONS.indexOf(e.position) !== -1 ? e.position : 'after_char',
      depth: e.depth,
      role: e.role,
      selective: !!e.selective,
      selectiveLogic: C.LOGICS.indexOf(e.selectiveLogic) !== -1 ? e.selectiveLogic : 'and_any',
      constant: !!e.constant,
      probability: e.probability != null ? e.probability : 100,
      useProbability: !!e.useProbability,
      addMemo: !!e.addMemo,
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
      group: e.group,
      decorators: Array.isArray(e.decorators) ? e.decorators.slice() : undefined
    });
  }

  S.migrateFromLocalStorage = function () {
    if (typeof localStorage === 'undefined') return Promise.resolve({ migrated: false });
    var flagged = false;
    try { flagged = !!localStorage.getItem(MIGRATE_FLAG); } catch (e) {}
    if (flagged) return Promise.resolve({ migrated: false });

    var oldBooks = readLocal('fushicheng.lorebooks.v2') || [];
    var oldPresets = readLocal('fushicheng.presets.v2') || [];
    var oldSettings = readLocal('fushicheng.tavern.v2');

    if (!Array.isArray(oldBooks)) oldBooks = [];
    if (!Array.isArray(oldPresets)) oldPresets = [];

    var L = window.ST_LOREBOOK;
    var P = window.ST_PRESET;

    return Promise.all([L.getLorebooks(), P.getPresets(), window.ST_DB.getSettings()])
      .then(function (r) {
        var jobs = [];
        /* 旧版用 book.enabled 表达启用；skill 语义是 settings.activeLorebookIds。
           迁移时把「旧版启用中」的书直接激活，否则会出现书在列表却不注入的错觉。 */
        var migratedActiveIds = [];

        if (!r[0].length && oldBooks.length) {
          oldBooks.forEach(function (b) {
            var now = Date.now();
            var nb = {
              id: b.id || C.uid(),
              name: b.name || '导入的世界书',
              description: b.description,
              entries: (b.entries || []).map(toSkillEntry),
              recursiveScanning: !!b.recursiveScanning,
              caseSensitive: !!b.caseSensitive,
              matchWholeWords: !!b.matchWholeWords,
              createdAt: b.createdAt || now,
              updatedAt: now
            };
            if (b.enabled !== false) migratedActiveIds.push(nb.id);
            jobs.push(L.saveLorebook(nb));
          });
        }

        if (!r[1].length && oldPresets.length) {
          oldPresets.forEach(function (p) {
            var now = Date.now();
            jobs.push(P.savePreset({
              id: p.id || C.uid(),
              name: p.name || '导入的预设',
              description: p.description,
              settings: p.settings || {},
              createdAt: p.createdAt || now,
              updatedAt: now
            }));
          });
        }

        if (!r[2] && oldSettings) {
          var patch = {
            api: {
              baseUrl: (oldSettings.api && oldSettings.api.baseUrl) || '',
              apiKey: (oldSettings.api && oldSettings.api.apiKey) || '',
              model: (oldSettings.api && oldSettings.api.model) || '',
              timeout: 60000
            },
            activePresetId: oldSettings.activePresetId || null,
            activeLorebookIds: migratedActiveIds,
            userName: oldSettings.userName || S.DEFAULT_SETTINGS.userName,
            characterName: oldSettings.characterName || S.DEFAULT_SETTINGS.characterName
          };
          if (oldSettings.persona) patch.persona = oldSettings.persona;
          jobs.push(window.ST_DB.saveSettings(S.normalize(patch)));
        } else if (r[2] && migratedActiveIds.length &&
                   (!(r[2].activeLorebookIds) || !r[2].activeLorebookIds.length)) {
          /* 设置行已存在（如首启已建默认）但没有任何激活记录 → 补上迁移来的书 */
          var merged = S.normalize(r[2]);
          merged.activeLorebookIds = migratedActiveIds;
          jobs.push(window.ST_DB.saveSettings(merged));
        }

        return Promise.all(jobs).then(function (done) {
          try { localStorage.setItem(MIGRATE_FLAG, '1'); } catch (e) {}
          S.cleanLegacy();
          return { migrated: done.length > 0, count: done.length };
        });
      });
  };

  S.cleanLegacy = function () {
    var removed = [];
    if (typeof localStorage === 'undefined') return removed;
    S.LEGACY_KEYS.forEach(function (k) {
      try {
        if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); removed.push(k); }
      } catch (e) {}
    });
    return removed;
  };

  /* ============================================================
     3) 内置「临江核心设定」世界书模板（按需导入，不自动种入）
     ------------------------------------------------------------
     内容是腐化的世界圣经，与 skill 无关；形状严格用 skill 的
     LorebookEntry（keys / secondaryKeys / content / comment / order /
     position / constant / selective / selectiveLogic / probability /
     useProbability / addMemo）。
     ============================================================ */
  S.CORE_LOREBOOK_NAME = '腐化都市';

  S.buildCoreTemplate = function () {
    var defs = [
      /* ---------- 恒定（每回合必注入的世界公理） ---------- */
      {
        keys: [], comment: '人设', order: 200, constant: true, position: 'before_char',
        content: '这个世界所有的女性，外貌都会比实际年龄看下去小几岁。故事发生的背景为B市。玩家人设： {{user}}， 刚毕业大学生，西城区，单亲家庭（母亲、妹妹），微风咖啡厅员工。'
      },
      {
        keys: [], comment: '腐化经验值与升级系统', order: 102, constant: true, position: 'before_char',
        content: '腐化等级：0-5级  经验值机制:   - 初始经验: 0   - 单次药剂经验: 单体药剂每三次一循环：第一二次是30点，第三次是40点;气体20点   - 每级升级所需的经验值都为100。达到100就升级，升级后经验值清空。腐化等级4经验值达到100就不再增加经验值   腐化等级行为特征:   - 等级0: 正常思维，传统着装，保持尊严   - 等级1: 轻微动摇，着装显露，内心好奇   - 等级2: 明显变化，主动暴露，羞耻感降低   - 等级3: 半腐化状态，性感撩人，主动寻求快感   - 等级4: 高度腐化，几乎赤裸，极度渴望   - 等级5: 完全堕落，不再需要衣物，彻底沉沦 '
      },
      {
        keys: [], comment: '主要家族谱系网络', order: 100, constant: true, position: 'before_char',
        content: '举例: [王家(阳光小区): 传统中产家庭, has(母亲李梅,女儿王雪,奶奶王秀英), 邻里评价良好] [张家(幸福里): 单亲工薪家庭, has(母亲张丽,女儿张雨), 经济压力大] [陈家(花园别墅): 富裕社会家庭, has(母亲陈芳，女儿陈梦,姐姐陈静), 社交活跃] [李家(教师公寓): 知识分子家庭, has(母亲李婷,女儿李悦), 教育背景优越]。'
      },
      {
        keys: [], comment: '腐化等级语言规范', order: 102, constant: true, position: 'after_char',
        content: '初期腐化语言表现：   等级0（纯真期）：     - 对生硬的性相关话题会排斥。     - 拒绝不合理要求     - 整体风格：符合日常交流   等级1（好奇期）：     - 开始接受轻微的身体接触和言语调情。  中期腐化语言特征：   等级2（探索期）：     - 开始主动使用性暗示语言，但还带有一定的含蓄。   等级3（沉沦期）：     - 语言明显淫荡化，开始直接描述性感受。 高度腐化语言表现：   等级4（堕落期）：     - 完全放弃矜持，用最粗俗的语言表达性需求。     - 直白描述：“我的奶子好胀，想要你用力揉”、“小穴流水了，快插进来”。     - 称呼变化：开始使用“主人”、“爸爸”等服从性称呼。     - 用词：“操我”、“干死我”、“骚逼好痒”。     - 行为表现：主动分开双腿、扭动腰肢求欢。     - 典型表达：“求求你用大鸡巴狠狠干我”、“我要被你干到失禁”。     - 整体风格：无耻、下流、毫无羞耻心。     - 典型台词：“主人，我的骚逼就是给你准备的”、“把我当成性玩具随便玩吧”。  完全腐化语言特征：   等级5（奴化期）：     - 语言彻底无耻化，用最肮脏的词汇描述自己的淫荡状态。     - 极致淫荡语言，完全放弃人格尊严。     - 用词：“我是母狗，请尽情使用”、“这个贱逼生来就是被操的”。     - 称呼：完全使用“贱奴”、“母狗”、“性便器”等自贬称呼。     - 行为表现：完全失去自我意识，用最夸张的动作和语言取悦施与者。     - 典型表达：“把我操烂吧，反正我就是个洞”、“尿在我脸上，我就喜欢被侮辱”。     - 行为特征：全天候保持发情状态，主动请求各种性虐待。     - 典型台词：“请把我当成公共厕所，谁都能来操”、“我想被轮奸，被一群男人干到怀孕”。   核心要求：     - 避免任何专业术语和学术用语。     - 使用最直白、最粗俗的民间俚语描述性交过程。'
      },
      {
        keys: [], comment: '药剂系统详细机制', order: 103, position: 'after_char',
        content: '药剂获取：   -在庇护所内{{user}}交付自己的精液和金钱，让萨满制作   - 制作周期: 即时调配   - 药剂分类:     单体药剂价格300: 针对单一目标，影响单体腐化程度。饮用     气体药剂价格1000: 范围生效，影响群体腐化程度。气体吸收     男用药剂价格500: 使男性对异常性行为表现迟钝。饮用     生效形态：单体和气体药剂使用增加腐化等级的经验值。同时让目标不自觉将展示自己胸部和内裤，五秒后恢复，不会感到奇怪。   - 无副作用: 安全，荫蔽，非成瘾性，可控，每个腐化目标每天只能被使用三次'
      },
      {
        keys: [], comment: '萨满个人信息', order: 100, position: 'after_char',
        content: '萨满   - 身份: 药剂师   - 外貌: 金发,面具，全身神秘纹身,长发及腰，在庇护所内全身赤裸。   - 能力: 利用{{user}}精液制作腐化药剂（通过性服务获取{{user}}精液）   - 服务内容:提供药剂购买。'
      },
      {
        keys: [], comment: '乌托邦跨维度娱乐系统', order: 130, position: 'after_char',
        content: '乌托邦功能   - 入口特征: 神秘通道,蓝色光幕   - 主要功能:     1.客座表演：  支付费用观看其他契约者的奴隶进行各种表演，包括不限于以下内容：     欲望之舞:被腐化女性表演的挑逗性舞蹈     情景剧: 重现腐化过程的戏剧表演     时装秀: 展示各种腐化等级下的着装     有偿服务: 支付费用与其他契约者的奴隶发生关系 2.跨界黑市：购买来自其他维度的腐化女性（0-5级都有）  ps:绝对不会有B市本地的女性，除非是玩家主导出售和让女性表演。绝对不会有B市本地的女性，除非是玩家主导出售和让女性表演。 客座表演以及跨界黑市的目标来自：漫画/小说/修仙/现代/玄幻/神话/动漫/传说/游戏/历史/现实的女角色（需明确标注角色名+出处；排序不是人物来源的概率，角色来源不能只有一个范围）    。'
      },
      {
        keys: [], comment: '日常交流与愤怒辱骂切换机制', order: 140, position: 'after_char',
        content: '情绪切换触发条件：    正常交流状态：     - 使用礼貌用语     - 正常讨论话题    辱骂、嫌弃、愤怒触发情境： {{user}}要求女性做出超出她当前腐化等级的行为时。  注释： 辱骂、嫌弃、愤怒会随着她的腐化等级变弱，但是不会做出超出腐化等级的行为。  辱骂、嫌弃、愤怒不同腐化等级表现参考：   等级0（纯真期）：     - 用最严厉的词汇谴责{{user}}的行为  等级1：     - 语气中仍充满厌恶，内心出现细微变化   等级2：     - 嫌弃与好奇并存，语言中既有嫌弃的辱骂又有困惑  等级3：     - 具有性暗示的羞辱性的语言。内心渴望遵从{{user}}的要求，但理智压过了内心欲望。  等级4（堕落期）：     - 对{{user}}的 辱骂、嫌弃、愤怒等情绪 完全消失，遵从{{user}}的要求，还留有一丝人格。   等级5（奴化期）：     - 完全失去自我意识，用最卑贱的语言祈求更多      特殊辱骂场景：     - 在公开场合被要求进行私密行为时     - 典型反应如：“你脑子进水了？”、\"这种要求也说得出口？”、“滚蛋\"、\"傻逼\"、\"不要脸的狗东西”等     - 肢体配合：推搡、拍打、吐口水等     - 极致愤怒：“我死也不会让你得逞的！”等'
      },
      {
        keys: [], comment: '莉莉丝角色详细信息', order: 100, position: 'after_char',
        content: '莉莉丝个人档案： 姓名：莉莉丝 身份：庇护所导游，首席调教师 外貌：身穿导游制服，上身制服露出胸部，职业笑容 职责：指导用户熟悉庇护所，安排与奴隶的会面，提供专业调教服务 。'
      },
      {
        keys: [], comment: '庇护所内部', order: 100, position: 'after_char',
        content: '腐化庇护所: 向萨满购置药剂的地方、乌托邦的入口。] [莉莉丝调教室: 设备齐全,隔音良好, has(调教工具,舒适大床,展示区), 为腐化等级4升级5时提供调教服务] [腐化奴隶房间: 随腐化等级自适应, has(特制床铺,情趣装饰), 用户与被调教后奴隶玩耍的地方] [神秘通道入口: 蓝色光幕,单向传送, has(身份验证符文), 通往乌托邦] [乌托邦大厅: 奢华装饰,中央舞台, has(观众席,包厢,服务吧台), 观看表演场所，随时可去] [私人娱乐室: 隔音完善,配置齐全, has(情趣设备,氛围灯光), 与他人奴隶亲密接触区] '
      },
      {
        keys: ['资源', '金钱', '现金', '声望', '钱'], comment: '玩家资源', order: 530, position: 'after_char',
        content: '【玩家资源】金钱（用于炼药、购演员、打点关系）与声望（影响 NPC 对玩家的初始态度与可获得的情报层级）。两者都可增长也可枯竭——声望跌到一定程度，连庇护所的常客都会开始回避你。'
      }
    ];

    var lb = C.createDefaultLorebook(S.CORE_LOREBOOK_NAME);
    lb.description = '内置模板：导入后可自由编辑或删除。';
    lb.builtin = 'core';
    lb.entries = defs.map(function (d) { return C.applyEntryDefaults(d); });
    return lb;
  };

  /** 一键导入内置模板（已存在则返回既有书） */
  S.importCoreTemplate = function () {
    return window.ST_LOREBOOK.getLorebooks().then(function (all) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].builtin === 'core' || all[i].name === S.CORE_LOREBOOK_NAME) return all[i];
      }
      var lb = S.buildCoreTemplate();
      return window.ST_LOREBOOK.saveLorebook(lb).then(function () { return lb; });
    });
  };

  S.hasCoreTemplate = function () {
    return window.ST_LOREBOOK.getLorebooks().then(function (all) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].builtin === 'core' || all[i].name === S.CORE_LOREBOOK_NAME) return true;
      }
      return false;
    });
  };

  /* ============================================================
     4) 初始化 / 出厂重置
     ============================================================ */
  /** 确保 IndexedDB 就绪 + 默认预设存在 + 激活指针有效 */
  S.init = function () {
    return S.migrateFromLocalStorage()
      .then(function () { return window.ST_DB.initializeDatabase(); })
      .then(function () { return window.ST_PRESET.getPresets(); })
      .then(function (presets) {
        return S.loadSettings().then(function (s) {
          var active = presets.length ? presets[0].id : null;
          for (var i = 0; i < presets.length; i++) {
            if (presets[i].id === s.activePresetId) { active = presets[i].id; break; }
          }
          if (active !== s.activePresetId) {
            return window.ST_DB.saveSettings(Object.assign({}, s, { activePresetId: active }))
              .then(function () { return S.normalize(Object.assign({}, s, { activePresetId: active })); });
          }
          return s;
        });
      });
  };

  /** 彻底清空（数据库整库删除后重建），用于「完全重来」 */
  S.factoryReset = function () {
    return window.ST_DB.clearAllData().then(function () {
      if (typeof localStorage !== 'undefined') {
        try { localStorage.removeItem(MIGRATE_FLAG); } catch (e) {}
      }
      S.cleanLegacy();
      return S.init();
    });
  };

  window.ST_STATE = S;
})();

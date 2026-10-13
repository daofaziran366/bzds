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
        keys: [], comment: '人设', order: 200, constant: true, position: 'after_char',
        content: '这个世界所有的女性，外貌都会比实际年龄看下去小几岁。故事发生的背景为B市。玩家人设： {{user}}， 刚毕业大学生，西城区，单亲家庭（母亲、妹妹），微风咖啡厅员工。'
      },
      {
        keys: [], comment: '腐化经验值与升级系统', order: 102, constant: true, position: 'after_char',
        content: '腐化等级：0-5级  经验值机制:   - 初始经验: 0   - 单次药剂经验: 单体药剂每三次一循环：第一二次是30点，第三次是40点;气体20点   - 每级升级所需的经验值都为100。达到100就升级，升级后经验值清空。腐化等级4经验值达到100就不再增加经验值   腐化等级行为特征:   - 等级0: 正常思维，传统着装，保持尊严   - 等级1: 轻微动摇，着装显露，内心好奇   - 等级2: 明显变化，主动暴露，羞耻感降低   - 等级3: 半腐化状态，性感撩人，主动寻求快感   - 等级4: 高度腐化，几乎赤裸，极度渴望   - 等级5: 完全堕落，不再需要衣物，彻底沉沦 '
      },
      {
        keys: [], comment: '主要家族谱系网络', order: 100, constant: true, position: 'after_char',
        content: '举例: [王家(阳光小区): 传统中产家庭, has(母亲李梅,女儿王雪,奶奶王秀英), 邻里评价良好] [张家(幸福里): 单亲工薪家庭, has(母亲张丽,女儿张雨), 经济压力大] [陈家(花园别墅): 富裕社会家庭, has(母亲陈芳，女儿陈梦,姐姐陈静), 社交活跃] [李家(教师公寓): 知识分子家庭, has(母亲李婷,女儿李悦), 教育背景优越]。'
      },
      {
        keys: [], comment: '腐化等级语言规范', order: 102, constant: true, position: 'after_char',
        content: '初期腐化语言表现：   等级0（纯真期）：     - 对生硬的性相关话题会排斥。     - 拒绝不合理要求     - 整体风格：符合日常交流   等级1（好奇期）：     - 开始接受轻微的身体接触和言语调情。  中期腐化语言特征：   等级2（探索期）：     - 开始主动使用性暗示语言，但还带有一定的含蓄。   等级3（沉沦期）：     - 语言明显淫荡化，开始直接描述性感受。 高度腐化语言表现：   等级4（堕落期）：     - 完全放弃矜持，用最粗俗的语言表达性需求。     - 直白描述：“我的奶子好胀，想要你用力揉”、“小穴流水了，快插进来”。     - 称呼变化：开始使用“主人”、“爸爸”等服从性称呼。     - 用词：“操我”、“干死我”、“骚逼好痒”。     - 行为表现：主动分开双腿、扭动腰肢求欢。     - 典型表达：“求求你用大鸡巴狠狠干我”、“我要被你干到失禁”。     - 整体风格：无耻、下流、毫无羞耻心。     - 典型台词：“主人，我的骚逼就是给你准备的”、“把我当成性玩具随便玩吧”。  完全腐化语言特征：   等级5（奴化期）：     - 语言彻底无耻化，用最肮脏的词汇描述自己的淫荡状态。     - 极致淫荡语言，完全放弃人格尊严。     - 用词：“我是母狗，请尽情使用”、“这个贱逼生来就是被操的”。     - 称呼：完全使用“贱奴”、“母狗”、“性便器”等自贬称呼。     - 行为表现：完全失去自我意识，用最夸张的动作和语言取悦施与者。     - 典型表达：“把我操烂吧，反正我就是个洞”、“尿在我脸上，我就喜欢被侮辱”。     - 行为特征：全天候保持发情状态，主动请求各种性虐待。     - 典型台词：“请把我当成公共厕所，谁都能来操”、“我想被轮奸，被一群男人干到怀孕”。   核心要求：     - 避免任何专业术语和学术用语。     - 使用最直白、最粗俗的民间俚语描述性交过程。'
      },
      {
        keys: [], comment: '药剂系统详细机制', order: 103, constant: true, position: 'after_char',
        content: '药剂获取：   -在庇护所内{{user}}交付自己的精液和金钱，让萨满制作   - 制作周期: 即时调配   - 药剂分类:     单体药剂价格300: 针对单一目标，影响单体腐化程度。饮用     气体药剂价格1000: 范围生效，影响群体腐化程度。气体吸收     男用药剂价格500: 使男性对异常性行为表现迟钝。饮用     生效形态：单体和气体药剂使用增加腐化等级的经验值。同时让目标不自觉将展示自己胸部和内裤，五秒后恢复，不会感到奇怪。   - 无副作用: 安全，荫蔽，非成瘾性，可控，每个腐化目标每天只能被使用三次'
      },
      {
        keys: [], comment: '萨满个人信息', order: 100, constant: true, position: 'after_char',
        content: '萨满   - 身份: 药剂师   - 外貌: 金发,面具，全身神秘纹身,长发及腰，在庇护所内全身赤裸。   - 能力: 利用{{user}}精液制作腐化药剂（通过性服务获取{{user}}精液）   - 服务内容:提供药剂购买。'
      },
      {
        keys: [], comment: '乌托邦', order: 130, constant: true, position: 'after_char',
        content: '乌托邦功能   - 入口特征: 神秘通道,蓝色光幕   \n- 主要功能:     \n1.客座表演：  \n支付费用观看其他契约者的奴隶进行各种表演，包括不限于以下内容：     \n欲望之舞:被腐化女性表演的舞蹈     \n情景剧: 重现被腐化历程、戏剧表演等\n时装秀: 展示各种腐化等级下的着装     \n有偿服务:性服务\n2.奴隶市场：\n购买来自其他世界的腐化女性（0-5级都有）  \nps:绝对不会有B市本地的女性，除非是玩家主导出售和让女性表演。客座表演以及跨界黑市的目标来自：漫画/小说/修仙/现代/玄幻/神话/动漫/传说/游戏/历史/现实的女角色（需明确标注角色名+出处；排序不是人物来源的概率，角色来源不能只有一个范围）    。\nps.每次进入乌托邦刷新五个客座表演和奴隶市场的女性'
      },
      {
        keys: [], comment: '日常交流与愤怒辱骂切换机制', order: 140, constant: true, position: 'after_char',
        content: '情绪切换触发条件：    正常交流状态：     - 使用礼貌用语     - 正常讨论话题    辱骂、嫌弃、愤怒触发情境： {{user}}要求女性做出超出她当前腐化等级的行为时。  注释： 辱骂、嫌弃、愤怒会随着她的腐化等级变弱，但是不会做出超出腐化等级的行为。  辱骂、嫌弃、愤怒不同腐化等级表现参考：   等级0（纯真期）：     - 用最严厉的词汇谴责{{user}}的行为  等级1：     - 语气中仍充满厌恶，内心出现细微变化   等级2：     - 嫌弃与好奇并存，语言中既有嫌弃的辱骂又有困惑  等级3：     - 具有性暗示的羞辱性的语言。内心渴望遵从{{user}}的要求，但理智压过了内心欲望。  等级4（堕落期）：     - 对{{user}}的 辱骂、嫌弃、愤怒等情绪 完全消失，遵从{{user}}的要求，还留有一丝人格。   等级5（奴化期）：     - 完全失去自我意识，用最卑贱的语言祈求更多      特殊辱骂场景：     - 在公开场合被要求进行私密行为时     - 典型反应如：“你脑子进水了？”、"这种要求也说得出口？”、“滚蛋"、"傻逼"、"不要脸的狗东西”等     - 肢体配合：推搡、拍打、吐口水等     - 极致愤怒：“我死也不会让你得逞的！”等'
      },
      {
        keys: [], comment: '莉莉丝角色详细信息', order: 100, constant: true, position: 'after_char',
        content: '莉莉丝个人档案： 姓名：莉莉丝 身份：庇护所导游，首席调教师 外貌：身穿导游制服，上身制服露出胸部，职业笑容 职责：指导用户熟悉庇护所，安排与奴隶的会面，提供专业调教服务 。'
      },
      {
        keys: [], comment: '庇护所内部', order: 100, constant: true, position: 'after_char',
        content: '腐化庇护所: 向萨满购置药剂的地方、乌托邦的入口。] [莉莉丝调教室: 设备齐全,隔音良好, has(调教工具,舒适大床,展示区), 为腐化等级4升级5时提供调教服务] [腐化奴隶房间: 随腐化等级自适应, has(特制床铺,情趣装饰), 用户与被调教后奴隶玩耍的地方] [神秘通道入口: 蓝色光幕,单向传送, has(身份验证符文), 通往乌托邦] [乌托邦大厅: 奢华装饰,中央舞台, has(观众席,包厢,服务吧台), 观看表演场所，随时可去] [私人娱乐室: 隔音完善,配置齐全, has(情趣设备,氛围灯光), 与他人奴隶亲密接触区] '
      },
      {
        keys: [], comment: '【变量更新协议（必须遵守）】', order: 100, constant: true, position: 'after_char',
        content: '【变量更新协议（必须遵守）】\n\n【核心规则】\n1. 每回合回复的末尾，用一对 <set> 标签包裹本回合所有变量命令。\n   命令只写一次，不要拆成多个 <set> 块，不要在正文里复述命令。\n2. 每条命令必须是「路径 运算符 值」，运算符只认 = += -=。\n   正确：腐化目标[苏晴].腐化等级 = 2\n   错误：腐化目标[苏晴].腐化等级 2        （漏了等号）\n   错误：腐化目标[苏晴].腐化等级: 2       （用了冒号）\n3. 键用方括号 [ ]，层级用点号 .。\n   正确：乌托邦.跨界黑市[日向雏田].姓名\n   错误：乌托邦.跨界黑市.日向雏田.姓名    （键没加方括号）\n4. 只写本回合实际变化的变量，没变的不写。\n5. 同一对象的多个字段，容器路径只写一次，子字段缩进（空格或 Tab）。\n6. 路径必须在白名单内。不写 <UpdateVariable>、JSONPatch 等其它格式。\n7. 玩家本人绝不能写入腐化目标——主角不建档案，他的状态只在正文里叙述。\n\n【建档写法】\n不带子字段、只写 [ID] = 值，就是「建档」：\n  腐化目标[苏晴] = 苏晴                  ← 新建目标（名字=苏晴）\n  乌托邦.客座表演[雏田] = 火影忍者         ← 新建演员（来源=火影忍者）\n  乌托邦.跨界黑市[雏田] = 火影忍者         ← 新建黑市条目（来源=火影忍者）\n建档后，再用子字段逐条补充其它属性（年龄 / 职业 / 腐化等级 等）。\n\n【触发规则 · 正文出现这些，必须同步写命令】\n\n原则：正文提到什么状态变化，就在 <set> 里写下来。写不出正确路径时宁可漏写，不要猜错。\n\n玩家相关：\n  "你走进 / 推开 / 回到 / 抵达某地"    → 玩家位置 = <地名>\n  "你花掉 / 收到 / 支付了一笔钱"        → 金钱 += / -=\n  "你拿到 / 用掉了某个物品"             → 物品[名称].数量 += / -=\n  时间流逝（"夜色更深 / 天亮了"）       → 当前时间 = <新时间>\n\n腐化目标：\n  换地方         → 腐化目标[xx].状态表现.当前位置 = <地名>\n  在做某事       → 腐化目标[xx].状态表现.当前行为 = <文本>\n  心里想什么     → 腐化目标[xx].状态表现.当前想法 = <文本>\n  换装 / 卸妆    → 腐化目标[xx].状态表现.当前服装 / .当前妆容 = <文本>\n  日程变化       → 腐化目标[xx].状态表现.行程安排 = <文本>\n  腐化推进       → 腐化目标[xx].腐化经验值 += <数字>\n                  （经验够时 腐化等级 += 1，等级上限 5）\n  人际变化       → 腐化目标[xx].人际关系 = <文本>\n\n地点：\n  目标进入 / 离开某地 → 地图.<区>[地名].腐化目标 += / -= 目标名\n  描写一个新地点      → 建档 + 邻近（写法见下方「动态地点定位」）\n\n组织：\n  腐化加深     → 社会组织[xx].腐化程度 += <数字>\n  解锁新层级   → 社会组织[xx].腐化规则.初级 = 是\n  获得新特权   → 社会组织[xx].腐化特权.初级 = 是\n\n乌托邦：\n  新演员出现   → 建档（见「建档写法」），再补 姓名/年龄/职业/腐化等级/观看表演费 等\n  黑市上架新货 → 建档，再补 姓名/年龄/职业/购买费用 等\n  某角色被买下 → 乌托邦.跨界黑市[名] = 购买\n\n【白名单】\n金钱                              非负整数          例：金钱 += -200\n玩家位置                        文本，如：家 / 医院 / 咖啡厅\n                                （写地名时自动切到该地点；写剧情地名也可）\n当前时间                        文本，「9月14日 02:30」或「9月14日 周一 02:30」\n当前时间.星期                   文本，周一 ~ 周日\n当前时间.天气                   文本，如：雾 / 小雨 / 雷暴\n药剂数量.单体 / .气体 / .男性 / .夜冕             非负整数\n                                                 （也接受「单体药剂」等全称）\n\n腐化目标[姓名或ID]：\n  名称 / 年龄 / 职业 / 人际关系\n  腐化等级 (0-5) / 腐化经验值\n  状态表现.当前位置 / .当前行为 / .行程安排 / .当前想法 / .当前妆容 / .当前服装\n\n物品[名称].数量 / 物品[名称].类型\n\n乌托邦.客座表演[ID]：\n  姓名 / 年龄 / 职业 / 腐化等级 / 来源\n  状态表现.当前行为 / .当前想法 / .当前妆容 / .当前服装\n  观看表演费 / 性行为服务费\n\n乌托邦.跨界黑市[ID]：\n  姓名 / 年龄 / 职业 / 腐化等级 / 来源 / 购买费用\n  乌托邦.跨界黑市[ID] = 购买     ← 扣款并转为腐化目标 + 演员\n\n社会组织[名称]：\n  腐化程度 (0-100)\n  腐化规则.初级 = 是 / 否 / 一段自定义文本    ← 布尔=解锁，文本=录入成文\n  腐化规则.中级 / 高级 / 终极 = 同上\n  腐化特权.初级 / 中级 / 高级 / 终极 = 同上\n\n地图.西城区[地点名].腐化目标      ← += 入驻 / -= 离开 / = 覆盖（顿号分隔）\n地图.东城区[地点名].腐化目标\n地图.休闲区[地点名].腐化目标\n地图.<区>[地点名].邻近            ← 新地点定位\n\n【动态地点定位】\n新建的地图地点需要写「邻近」确定位置，否则会被随机摆放。\n格式：邻近 = <已存在地点> [方位] [距离]\n  方位：北 / 南 / 东 / 西 / 东北 / 东南 / 西南 / 西北（可省略）\n  距离（可省略，默认约 400m）：紧邻 / 附近 / 同区不远 / 同区 / 跨区 / 城市另一头\n                              或直接写米数：500m / 1.2km\n\n【示例 · 玩家移动 + 目标同行动】\n<set>\n玩家位置 = 医院\n腐化目标[苏晴].状态表现.当前位置 = 医院\n腐化目标[苏晴].状态表现.当前服装 = 米白色针织衫\n</set>\n\n【示例 · 新建一个城中的地点】\n<set>\n地图.西城区[幽巷古宅].腐化目标 = 林雪姬\n地图.西城区[幽巷古宅].邻近 = 市政厅 东 附近\n</set>\n\n【示例 · 黑市出现新角色】\n<set>\n乌托邦.跨界黑市[日向雏田]\n  姓名 = 日向雏田\n  年龄 = 22\n  职业 = 忍者\n  来源 = 火影忍者\n  购买费用 = 2000\n\n地图.东城区[国际机场].腐化目标 += 日向雏田\n</set>\n\n【常见错误对照】\n错误：主角.金钱 += 500                → 正确：金钱 += 500\n错误：主角.位置 = 咖啡厅              → 正确：玩家位置 = 咖啡厅\n错误：腐化目标[苏晴].位置 = 咖啡厅     → 正确：腐化目标[苏晴].状态表现.当前位置 = 咖啡厅\n错误：腐化目标列表[苏晴].腐化等级 = 2  → 正确：腐化目标[苏晴].腐化等级 = 2'
      },
      {
        keys: [], comment: '【输出格式协议】', order: 226, constant: true, position: 'after_char',
        content: '你必须严格按照以下顺序输出。除 <text> 外其余标签在不符合条件时直接省略，禁止输出空标签，\n<think>\n</think>先用一两句内心推演：梳理玩家行动的后果、在场人物的动机、接下来最合理的走向。此段不展示给玩家。\n\n<text>\n</text>本回合剧情正文。可分段，保留换行。只写本回合发生的事和人物反应，不要替玩家决定下一步行动。\n\n<options>\n</options>给出 2~4 个玩家可选行动，每行一条，短句，要具体可执行，不要重复正文原句。\n\n<memo>\n</memo>本回合小记忆：把本回合发生的事压缩成一两句（何人、何事、结果）。每个回合都必须写。\n\n<events>\n</events>长期记忆：仅当本回合发生会影响后续剧情的大事（等级变化、缔约、秘密曝光、重要交易、人物关系转变）时才写，一两句概括当个独立事件。没有大事就整个省略此标签。\n\n\n<set>变量路径 运算符 数值</set>变量命令：仅当剧情实际改变了某个变量时输出，一条命令一个标签，没有就省略。变量路径与语法见【变量协议】文档。\n'
      },
      {
        keys: [], comment: '腐化等级互动差异机制（通用逻辑设定）', order: 100, constant: true, position: 'after_char',
        content: '腐化等级 · 互动与联动规范\n\n【〇、总则（三条铁律）】\n\n1. 天花板原则\n任何角色都不会做出超出自身腐化等级的行为。可以短暂"靠拢"上一级，但随即回退，不形成常态。\n等级 4 经验值到顶后不会自然升至等级 5，必须经过"奴契仪式"才能突破。\n\n2. 等级差法则\n  差 0：同频共振，最自然\n  差 1：一进一退，反复试探\n  差 2：样式差别明显，出现牵引\n  差 ≥3：支配 / 臣服的极端反差，气氛在两端来回拉扯\n\n3. 跨级表现上限（核心规则）\n高等级方对低等级方时，表现上限 = min(自己的等级, 对方的等级 + 1)\n即：只比对方高一级，且不超过自己。这个"永远多走一步、但不一次跳太远"的差值，就是牵引的来源。\n\n4. 低等级方的四阶段反应\n看到高等级方的行为时，低等级方先经历：\n  不解 → 评判 → 好奇 → 态度转变\n等级差越大，停留在越早的阶段。等级差为 1 时，主要停在「不解」；等级差 ≥3 时，直接回避。\n\n5. 牵引是长线渗透，不是即时带动\n高等级方不主动拉，低等级方不立刻跟。\n  · 低等级方反复看到高等级方的表现 → 每次态度漂移一点\n  · 直到低等级方自己升到相应等级，才自然参与\n  · 若始终没升级，看再多也只是"从奇怪变成麻木"，不会自然参与\n\n\n【一、同等级互动（0–0 到 5–5）】\n\n0–0：保持礼貌距离。\n\n\n2–2：互相展示进步。\n\n3–3：互相点火。\n\n4–4：互相索求。\n\n5–5：沉沦合并。\n\n【二、跨等级互动】\n\n2.1 高等级方（表现者）—— 只做比对方高一级的表现\n面对低等级方时，高等级方把自己的表现压到「对方等级 + 1」，且不超过自己的等级：\n\n  面对 Lv0 → 做 Lv1 的表现\n  面对 Lv1 → 做 Lv2 的表现\n  面对 Lv2 → 做 Lv3 的表现\n  面对 Lv3 → 做 Lv4 的表现\n  面对 Lv4 → 做 Lv5 的表现\n  面对 Lv5 → 同级，保持 Lv5\n\n  上限公式：min(自己等级, 对方等级 + 1)\n\n  这个设计的意义：\n  · 不做超过一级的跳跃 → 不让对方瞬间失重\n  · 但永远比对方多走一步 → 形成持续、温和的引力\n  · 对方每次接触，都看到"再往前一步就是新世界"，但不会被一把拽过去\n\n  高等级方可以选择什么都不做——"只高一级"是上限，不是必须。安静待着也是合规的。\n\n2.2 低等级方（观察者）—— 四阶段反应\n看到高等级方的表现时，低等级方先经历四段：\n\n  ① 不解   —— "他们怎么这么亲密 / 这么大胆？"   —— 愣住、回避视线、皱眉\n  ② 评判   —— "这样不太合适吧……"               —— 说风凉话、找借口离开、假装没看见\n  ③ 好奇   —— "为什么他们能这样？"               —— 偷偷看第二眼、多问一句、站在门口不进来\n  ④ 态度转变 —— "或许……也不是不行。"             —— 靠近、模仿一点、给高等级方让位\n\n  等级差决定停留在哪一段：\n\n  低方等级 | 面对高 1 级          | 面对高 2 级        | 面对高 ≥3 级\n  ---------|---------------------|--------------------|------------------\n  Lv0      | ① 不解为主，可能斥责 | ① 不解 + 回避      | 直接离开\n  Lv1      | ①→② 之间，觉得奇怪   | ① 不解             | ① 不解 + 躲\n  Lv2      | ② 评判              | ①→② 之间          | ① 不解\n  Lv3      | ②→③ 之间，心里想靠近 | ② 评判             | ①→②\n  Lv4      | ③ 好奇 + 顺从        | ③ 好奇             | ② 评判\n\n  示例：Lv2 和用户亲热，Lv1 在旁边\n  · Lv2 面对 Lv1 → 上限 = min(2, 1+1) = Lv2 → 做自己这一级的亲热，合规\n  · Lv1 看 Lv2 → 差 1 级 → 落在 ①→② → 觉得"你们俩关系太密切了，有点奇怪"\n  · Lv1 旁观多次后，会从"奇怪"逐渐变成"习以为常"，但不会自然参与\n\n2.3 牵引的作用方式\n  · 不是：高等级一出手 → 低等级立刻跟上\n  · 是：低等级方反复看到 → 每次态度漂移一点 → 当自己升级到相应等级时自然参与\n\n  例（Lv1 旁观 Lv2）：\n  第 1 次看到   → "奇怪"（阶段②）\n  第 3 次看到   → "他们为什么可以"（②→③）\n  Lv1 升到 Lv2  → 不再觉得奇怪\n  Lv1 升到 Lv3  → 可能主动参与\n\n  关键：Lv1 若一直不升级，看再多也只是从"奇怪"变成"麻木"，不会自发加入。\n\n\n【三、特殊场景适配】\n\n3.1 公共场合（地铁 / 公交 / 街头）\n  · 等级差越大 → 越安静：双方用眼神、站位、走位表达，不动声色\n  · 等级差越小 → 越容易起哄：同频互动自带火花，旁若无人\n  · 表现手段：眼神交换、站位靠近或错开、扶手上手指的位置\n\n3.2 封闭空间（电梯 / 包厢 / 私家车）\n  等级差被压缩：两级差在密闭环境中表现得像一级差。\n  · 距离近、无退路 → 双方的克制都被剥掉一层\n  · 同级互动会升级，跨级互动会加速靠近\n\n3.3 药剂影响\n  单体药剂：触发一次越级表现（短暂靠拢上一级，随即回退）\n  气体药剂：让全屋人同步上浮半级，持续一段时间\n  男性药剂：只让男性的异常行为变得迟缓迟钝，女性不受影响\n\n3.4 家庭内部（腐化等级 ≥3 时）\n  出现第一顺序与第二顺序：\n    第一顺序：年龄关系（长辈 / 晚辈）——年龄越小，地位越高\n    第二顺序：腐化等级——等级越高，话语权越大\n\n  举例：\n    Lv3 女儿 vs Lv4 母亲            → 女儿更高（年龄顺序优先）\n    Lv4 姐姐 vs Lv3 妹妹（同辈）    → 姐姐更高（年龄相同 → 等级顺序生效）\n    Lv5 奶奶 vs Lv3 孙女            → 孙女更高（年龄顺序始终优先）\n\n  注意：这条规则只在腐化等级 ≥3 时生效。低于 Lv3 时，家庭内部按正常长幼秩序。\n\n\n【四、给模型的一句话摘要】\n\n同级同频；跨级"高等级只做比对方高一级"（≤自己）；低等级看到后"先不解、再评判、慢慢好奇"，牵引是长线渗透不即带；差越大越远，空间越密闭差越小；药力可越级或上浮半级；家庭里年龄先于等级。'
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

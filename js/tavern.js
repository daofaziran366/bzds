/* ============================================================
   腐化 · 酒馆适配层（薄桥接）
   ------------------------------------------------------------
   照搬 skill sillytavern-web 的 useSillytavern.sendMessage 数据流：
     assemblePrompt → buildRequestBody → chatCompletion
     → StreamTagParser + aggregateEvents

   本层只做三件事，不参与任何提示词决策：
     1) 暴露 app.js 需要的 window.TAVERN 契约
        （ready / ask / renderTavern / saveSettings / syncStatusChip /
          _loadAll / getSettings）
     2) 把 skill 的 ParsedTags（options 是 string[]）转成 app.js 要的
        {label, prompt} 选项形状，并把游戏状态经 TAVERN_CTX 交给内核
     3) 把 <set> 变量命令交给游戏层 js/vars.js 执行（弹幕 / 失败弹窗）

   skill 语义带来的契约变化（相对上一版）：
     · 世界书激活 = settings.activeLorebookIds（不再是 book.enabled /
       settings.lorebookEnabled 总开关）
     · 流式 = 当前预设的 stream_openai；预设缺失该键或没有预设时，
       落 settings.stream 兜底（开关在主页始终可用）
     · 没有「读取设置」面板（skill 无世界书全局设置层）
   ============================================================ */
(function () {
  'use strict';

  var ST = window.ST;

  function esc(h) {
    return String(h == null ? '' : h)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function $(sel, root) { return (root || document).querySelector(sel); }

  /* ---------- app.js: TAVERN.ready()（同步判定） ---------- */
  function ready() {
    if (!ST.isReady()) return false;
    return ST.canRequest();
  }

  /* 正文净化：模型经常忘了用 <set> 包裹，把变量命令当普通句子写进正文。
     这里把「本来就是一条命令」的行从正文剥出、回收为命令。
     块式行（有缩进）必须整体保留缩进，否则展开时层级丢失。
     判定权交给 VARS.parseCommand（含白名单首段校验），避免误伤正常行文。 */
  function salvageBody(body) {
    var salvaged = [];
    var kept = String(body || '').split('\n').filter(function (line) {
      var s = line.trim();
      if (!s) return true;
      if (!window.VARS || typeof window.VARS.parseCommand !== 'function') return true;
      var c = window.VARS.parseCommand(s);
      /* 能解析成合法命令，且根落在白名单内 → 剥出正文，连同缩进一起回收。
         只认白名单根：「价格 = 300」这类行文不剥。 */
      if (c && !c.error && window.VARS.isWhitelisted && window.VARS.isWhitelisted(c)) {
        salvaged.push(line.replace(/\s+$/, ''));
        return false;
      }
      return true;
    });
    return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), salvaged: salvaged };
  }

  /* 正文净化 2：协议规定正文之后只允许 <options>/<memo>/<events>/<set>，
     模型偶尔不套标签、把选项列表和摘要裸写在正文尾部 → 玩家在正文里
     看到编号选项和「张参观了……」式的第三人称摘要。
     策略：找最后一个「编号块」（连续编号行，空行不断块）。
     合格 = ≥2 条编号行。本游戏选项行固定带「丨」分隔符：
       · 块内含丨 → 确定是裸选项，从块首切到文末（块后按协议只可能是
         裸摘要/事件，允许 ≤3 行短行；超出视为剧情，不切）；
       · 块内无丨 → 只在块后为空、或块后全部带摘要/事件标记时切，
         避免误伤剧情里以编号清单收尾的段落。
     命令行已由 salvageBody 先行回收，不受影响。 */
  function stripMetaTail(text) {
    var lines = String(text || '').split('\n');
    var n = lines.length, i, s;
    var runs = [], cur = null;
    for (i = 0; i < n; i++) {
      s = String(lines[i]).trim();
      if (/^\d{1,2}\s*[.、．)）]\s*\S/.test(s)) {
        if (!cur) cur = { start: i, end: i, len: 0, hasBar: false };
        cur.end = i; cur.len++;
        if (s.indexOf('丨') >= 0) cur.hasBar = true;
      } else if (s && cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
    var run = runs.length ? runs[runs.length - 1] : null;
    var marked = function (str) { return /^[【\[]?(摘要|小记忆|记忆|事件)[】\]]?[:：]/.test(str); };
    if (run && run.len >= 2) {
      var after = [];
      for (i = run.end + 1; i < n; i++) {
        s = String(lines[i]).trim();
        if (s) after.push(s);
      }
      var tailOk = run.hasBar
        ? after.length <= 3 && after.every(function (l) { return l.length <= 150; })
        : (after.length === 0 || after.every(marked));
      if (tailOk) {
        var cut = run.start;
        if (cut > 0) {
          var prev = String(lines[cut - 1]).trim();
          if (/^【?(选项|行动|行动选项)】?[:：]?$/.test(prev) ||
              (/[:：]$/.test(prev) && prev.length <= 24)) cut--;
        }
        return lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '').trim();
      }
    }
    /* 无编号块时：剥带标记的尾部摘要/事件行（「摘要：xxx」等） */
    var end = n, changed = false;
    while (end > 0 && !lines[end - 1].trim()) end--;
    while (end > 0) {
      s = String(lines[end - 1]).trim();
      if (marked(s)) { end--; changed = true; continue; }
      break;
    }
    return changed
      ? lines.slice(0, end).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '').trim()
      : String(text || '');
  }

  /* 正文净化 3：模型把 <options>/<memo> 嵌进 <text> 时（解析器已能
     恢复正文，但兜底提取路径仍可能带回裸内容），尾部逐行比对
     解析出的选项与摘要（忽略空白差异），匹配即剥——答案是模型
     自己交出的，零误伤，比编号块启发式更准。 */
  function normLine(s) { return String(s || '').replace(/\s+/g, ''); }
  function stripKnownMeta(text, knownLines) {
    var known = (knownLines || []).map(normLine).filter(function (s) { return s; });
    if (!known.length) return String(text || '');
    var lines = String(text || '').split('\n');
    var end = lines.length, matched = false;
    while (end > 0) {
      var s = lines[end - 1].trim();
      if (!s) { end--; continue; }
      if (known.indexOf(normLine(s)) !== -1) { end--; matched = true; continue; }
      break;
    }
    return matched
      ? lines.slice(0, end).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '').trim()
      : String(text || '');
  }

  /* 解析器没吐出正文时的兜底提取：状态机只认裸标签名，
     模型写出 <text lang="zh"> 这类带属性/空白的变体时会被当普通文本。
     先按正则把 <text>/<maintext> 的内容抓回来（含标签内混入的
     <options>/<memo> 等，交 stripMetaTail 继续处理），抓不到再剥全部标签。 */
  function extractTagged(raw, names) {
    var re = new RegExp('<(' + names.join('|') + ')(?:\\s[^>]*)?>([\\s\\S]*?)</\\1\\s*>', 'i');
    var m = re.exec(String(raw || ''));
    return m ? m[2] : '';
  }

  /* ---------- 解析结果 → 渲染形状（ask.onDone 与 TAVERN.parseRaw 共用） ---------- */
  /* 正文兜底链：状态机正文 → 正则抓 <text>/<maintext>（标签变体）
     → 整个 raw 剥标签。随后三级净化：
     ① salvageBody：把混进正文的裸变量命令行剥出（ salvaged 交调用方
        决定是否执行——生成路径执行，编辑重解析路径不执行）；
     ② stripMetaTail：把裸写在尾部的选项列表/摘要块剥掉；
     ③ stripKnownMeta：按解析出的选项/摘要/事件做精确尾部去重。 */
  function cleanReply(parsed, raw) {
    parsed = parsed || {};
    var mainSrc =
      String(parsed.text || '').trim() ||
      extractTagged(raw, ['text', 'maintext']).replace(/<\/?[a-zA-Z][^>]*>/g, '').trim() ||
      String(raw || '').replace(/<\/?[a-zA-Z][^>]*>/g, '').trim();
    var pick = salvageBody(mainSrc);
    pick.text = stripMetaTail(pick.text);
    pick.text = stripKnownMeta(pick.text, (parsed.options || [])
      .concat(parsed.memo ? [parsed.memo] : [])
      .concat(parsed.events ? [parsed.events] : []));
    /* 主正文与选项全空：把剥过标签的 raw 收编为正文，
       避免 app.js 兜底把带标签原文直接上屏。 */
    if (!pick.text && !(parsed.options || []).length) {
      pick.text = stripMetaTail(String(raw || '').replace(/<\/?[a-zA-Z][^>]*>/g, '').trim());
    }
    return {
      main: pick.text,
      /* skill 的 options 是字符串数组；app.js 要 {label, prompt} */
      options: (parsed.options || []).map(function (s) {
        var t = String(s || '').trim();
        return { label: t, prompt: t };
      }).filter(function (o) { return o.label; }),
      think: parsed.thinking || '',
      memo: parsed.memo || parsed.sum || '',
      events: parsed.events || '',
      commands: parsed.commands || [],
      salvaged: pick.salvaged || [],
      unknown: parsed.unknown || {},
      raw: String(raw || '')
    };
  }

  /* ---------- app.js: TAVERN.ask(text, { onChunk, onDone, onError }) ---------- */
  function ask(userText, handlers) {
    handlers = handlers || {};
    return ST.chat(userText, {
      signal: handlers.signal,     /* 中止信号直通内核 */
      onChunk: handlers.onChunk,
      onDone: function (out) {
        var parsed = out.parsed || {};
        var shaped = cleanReply(parsed, out.raw);
        /* 裸命令行回收：与 <set> 块里完全相同的行去重（模型经常两边都写，
           不去重会双倍扣款），随后统一执行。 */
        if (shaped.salvaged.length) {
          var seen = {};
          (parsed.commands || []).forEach(function (s) { seen[String(s).trim()] = 1; });
          var fresh = shaped.salvaged.filter(function (l) {
            var k = String(l).trim();
            if (seen[k]) return false;
            seen[k] = 1;
            return true;
          });
          shaped.commands = shaped.commands.concat(fresh);
        }
        /* 变量命令先执行：状态改写 + 弹幕 / 失败弹窗，随后 app.js 用新值渲染。
           内核不认识命令语法，执行与校验全在游戏层 js/vars.js。 */
        var res = { ok: [], fail: [] };
        if (window.VARS && typeof window.VARS.run === 'function' && shaped.commands && shaped.commands.length) {
          res = window.VARS.run(shaped.commands);
          if (typeof window.VARS.show === 'function') window.VARS.show(res);
        }
        if (!handlers.onDone) return;
        shaped.varResults = res;
        shaped.matched = (out.matchedEntries || []).map(function (e) { return ST.entryLabel(e.entry); });
        handlers.onDone(shaped);
      },
      onError: function (err) { if (handlers.onError) handlers.onError(err); }
    });
  }

  /* ---------- app.js 编辑器「原始字段」保存路径 ---------- */
  /* 整段原始输出重新走净化链：只解析、不执行 <set>——生成时命令已生效，
     重执行会二次扣款/改状态。正文/选项/摘要照常归位，供编辑后回填。 */
  function parseRaw(raw) {
    var parsed = (window.ST_REPLY && typeof ST_REPLY.parseText === 'function')
      ? ST_REPLY.parseText(String(raw || ''))
      : {};
    return cleanReply(parsed, String(raw || ''));
  }

  /* ---------- app.js: TAVERN.renderTavern() ---------- */
  function renderTavern() {
    var body = document.getElementById('tavern-body');
    if (!body) return;

    if (!ST.isReady()) {
      body.innerHTML = '<p class="tv-note">酒馆内核正在载入（IndexedDB 首次初始化）… 若长时间未就绪，可点下方重试。</p>' +
        '<div class="tv-row"><button class="btn btn-sm" id="tv-reload">重试初始化</button></div>';
      var retry = $('#tv-reload');
      if (retry) retry.onclick = function () { _loadAll(); };
      return;
    }

    var s = ST.getSettings();
    var presets = ST.getPresets();
    var preset = ST.activePreset();
    var books = ST.getLorebooks();
    var activeIds = s.activeLorebookIds || [];
    var activeBooks = ST.activeLorebooks();
    var entryCount = activeBooks.reduce(function (a, b) { return a + (b.entries || []).length; }, 0);
    var constCount = activeBooks.reduce(function (a, b) {
      return a + (b.entries || []).filter(function (e) { return e.constant; }).length;
    }, 0);
    var model = (preset && preset.settings && preset.settings.openai_model) || s.api.model || '';
    var ps = (preset && preset.settings) || {};

    var chip = $('#tavern-status');
    if (chip) {
      chip.textContent = ready() ? ('已接入 · ' + (model || '?')) : '本地引擎';
      chip.className = 'mi-status ' + (ready() ? 'mi-seep' : 'mi-clean');
    }

    /* 流式有效值：预设定义了 stream_openai 就用它；预设缺失该键或
       根本没有预设时，落 settings.stream 兜底。
       （旧实现把预设当唯一真相源——一个预设都没有时 writeStream 直接
       return false，开关点了毫无反应：「为什么没有预设流式就开不了」。） */
    function streamOn() {
      if (preset && preset.settings && preset.settings.stream_openai !== undefined) {
        return !!preset.settings.stream_openai;
      }
      return !!s.stream;
    }
    function writeStream(on) {
      if (preset) {
        if (!!preset.settings.stream_openai === !!on) return Promise.resolve(false);
        preset.settings.stream_openai = !!on;
        return ST.savePreset(preset).then(function () { return true; });
      }
      if (!!s.stream === !!on) return Promise.resolve(false);
      return ST.saveSettings({ stream: !!on }).then(function () { return true; });
    }

    var presetLine = preset
      ? '<b>' + esc(preset.name) + '</b>' +
        '<span class="tv-tag">temp ' + (ps.temp_openai != null ? ps.temp_openai : '—') + '</span>' +
        '<span class="tv-tag">max_tokens ' + (ps.openai_max_tokens != null ? ps.openai_max_tokens : '—') + '</span>' +
        '<span class="tv-tag">max_context ' + (ps.openai_max_context != null ? ps.openai_max_context : '—') + '</span>' +
        '<span class="tv-tag">' + (streamOn() ? '流式' : '非流式') + '</span>' +
        '<span class="tv-tag">' + ((ps.prompts || []).length) + ' 自定义块</span>' +
        '<span class="tv-tag">' + ((ps.prompt_order || []).length) + ' 槽位</span>'
      : '<span class="tv-note">尚未创建预设</span>';

    body.innerHTML =
      '<div class="tavern-grid">' +

      '<section class="panel tavern-card"><h3 class="panel-cap">接口 · OpenAI 兼容</h3>' +
      '<div class="tavern-form">' +
      '<label>接口地址 Base URL<input id="tv-base" type="text" placeholder="https://api.deepseek.com/v1" value="' + esc(s.api.baseUrl) + '"></label>' +
      '<label>API 密钥<input id="tv-key" type="password" placeholder="sk-…（本地端点可留空）" value="' + esc(s.api.apiKey) + '"></label>' +
      '<label>模型<input id="tv-model" type="text" placeholder="留空则用预设的 openai_model" value="' + esc(s.api.model) + '"></label>' +
      '<label>超时 (ms)<input id="tv-timeout" type="number" min="1000" step="1000" value="' + esc(s.api.timeout != null ? s.api.timeout : 60000) + '"></label>' +
      '<label class="tv-inline">流式输出（逐字上屏）<label class="switch"><input type="checkbox" id="tv-stream"' +
        (streamOn() ? ' checked' : '') + '><i></i></label></label>' +
      '<div class="tv-row"><button class="btn btn-primary" id="tv-save-api">保存接口</button>' +
      '<button class="btn btn-ghost" id="tv-test">测试连接</button>' +
      '<button class="btn btn-ghost" id="tv-models">拉取模型</button></div>' +
      '<p class="hint-chip" id="tv-model-hint"></p>' +
      '<p class="hint-chip" id="tv-test-result"></p>' +
      '<p class="tv-note">模型与采样由当前预设「' + esc(preset ? preset.name : '（无）') +
      '」决定（<code>openai_model</code> / <code>temp_openai</code>）；上方模型框仅在预设留空时兜底。' +
      '<b>流式</b>开关写入预设的 <code>stream_openai</code>；没有预设时记在全局开关，一样生效。' +
      '请求自动走同源动态代理（<code>/api/proxy</code>）绕开 CORS，请用「启动游戏.bat」经 http://localhost:8010 打开。</p>' +
      '</div></section>' +

      '<section class="panel tavern-card"><h3 class="panel-cap">预设 · 叙事风格</h3>' +
      '<div class="tavern-form">' +
      '<div class="tv-preset-summary">' + presetLine + '</div>' +
      '<div class="tv-row"><button class="btn btn-sm btn-primary" id="tv-open-preset">打开预设管理器</button></div>' +
      '<p class="tv-note">共 ' + presets.length + ' 个预设。预设承载：模型、采样、' +
      '<code>prompt_order</code> 注入顺序、各 Prompt 文本块与自定义 prompt。</p>' +
      '</div></section>' +

      '<section class="panel tavern-card tavern-card-wide"><h3 class="panel-cap">世界书 · 设定注入</h3>' +
      '<div class="tavern-form">' +
      '<div class="tv-preset-summary"><b>' + books.length + ' 本 · 激活 ' + activeIds.length + ' 本 · ' + entryCount + ' 条</b>' +
      '<span class="tv-tag">' + constCount + ' 常驻</span>' +
      '<span class="tv-tag">扫描窗口 当前输入 + 最近 3 条</span>' +
      '<span class="tv-tag">递归 ' + (activeBooks.some(function (b) { return b.recursiveScanning; }) ? '3 轮（已启用）' : '关') + '</span></div>' +
      '<div class="tv-row"><button class="btn btn-sm btn-primary" id="tv-open-lorebook">打开世界书管理</button></div>' +
      '<p class="tv-note">只有<b>已激活</b>的世界书参与注入。命中按条目「注入位置」分流进两个槽：' +
      '<code>before_char</code> → <code>worldInfoBefore</code>，' +
      '<code>after_char</code> / <code>at_depth</code> 等 → <code>worldInfoAfter</code>，' +
      '<code>outlet</code> 不自动注入。排序键为条目的 <code>order</code>，常驻条目恒命中且不受概率约束。</p>' +
      '</div></section>' +

      '</div>';

    /* ---------- 事件 ---------- */
    function readApiForm() {
      return {
        baseUrl: ($('#tv-base').value || '').trim(),
        apiKey: ($('#tv-key').value || '').trim(),
        model: ($('#tv-model').value || '').trim(),
        timeout: Number($('#tv-timeout').value) || 60000
      };
    }
    function setResult(kind, msg) {
      var el = $('#tv-test-result');
      if (!el) return;
      el.textContent = msg;
      el.className = 'hint-chip hint-' + kind;
    }

    var streamCb = $('#tv-stream');
    if (streamCb) streamCb.onchange = function () {
      writeStream(streamCb.checked).then(function (changed) {
        var p = ST.activePreset();
        setResult('info', changed
          ? ('流式已' + (streamCb.checked ? '开启' : '关闭') +
             (p ? '（写入预设「' + p.name + '」）' : '（暂无预设，记在全局开关）'))
          : '无改动。');
      });
    };

    var saveBtn = $('#tv-save-api');
    if (saveBtn) saveBtn.onclick = function () {
      var cb = $('#tv-stream');
      ST.saveSettings({ api: readApiForm() })
        .then(function () { return writeStream(cb ? cb.checked : false); })
        .then(function () {
          syncStatusChip();
          setResult(ready() ? 'success' : 'warn',
            ready() ? '接口已保存，可以测试连接。' : '接口已保存，但还缺 Base URL 或模型。');
          renderTavern();
        });
    };

    var testBtn = $('#tv-test');
    if (testBtn) testBtn.onclick = function () {
      var cfg = readApiForm();
      if (!cfg.baseUrl) { setResult('warn', '请先填 Base URL'); return; }
      if (!cfg.model) {
        var p = ST.activePreset();
        cfg.model = (p && p.settings && p.settings.openai_model) || '';
      }
      if (!cfg.model) { setResult('warn', '请填模型，或在预设里指定 openai_model'); return; }
      setResult('info', '正在测试…');
      ST.testConnection(cfg).then(function (r) {
        setResult('success', '连接成功：' + r.reply);
      }).catch(function (e) {
        setResult('error', '测试失败：' + ((e && e.message) || e));
      });
    };

    var modelsBtn = $('#tv-models');
    if (modelsBtn) modelsBtn.onclick = function () {
      var cfg = readApiForm();
      if (!cfg.baseUrl) { setResult('warn', '请先填 Base URL'); return; }
      setResult('info', '正在拉取模型列表…');
      ST.fetchModels(cfg).then(function (r) {
        if (r.source === 'remote') {
          setResult('success', '可用模型 ' + r.models.length + ' 个：' + r.models.slice(0, 6).join('、') +
            (r.models.length > 6 ? ' …' : ''));
        } else {
          setResult('warn', '无法拉取（' + (r.error || '未知') + '），常见模型：' + r.models.slice(0, 4).join('、'));
        }
      });
    };

    /* ---------- 接口卡 ---------- */
    function refreshModelHint() {
      var preset = ST.activePreset();
      var hint = $('#tv-model-hint');
      if (!hint) return;
      var model = (preset && preset.settings && preset.settings.openai_model) || ST.getSettings().api.model || '（未设置）';
      var temp = (preset && preset.settings && preset.settings.temp_openai != null) ? preset.settings.temp_openai : '—';
      var maxT = (preset && preset.settings && preset.settings.openai_max_tokens != null) ? preset.settings.openai_max_tokens : '—';
      hint.innerHTML = '模型与采样由当前预设「' + esc((preset && preset.name) || '默认预设') + '」决定（openai_model / temp_openai / openai_max_tokens）。当前模型：<b>' + esc(model) + '</b> · temp ' + esc(String(temp)) + ' · max_tokens ' + esc(String(maxT)) + '。上方模型框仅在预设留空时兜底。';
    }
    var saveApi = $('#tv-save-api');
    if (saveApi) saveApi.onclick = function () {
      var cfg = readApiForm();
      ST.saveSettings({ api: cfg }).then(function () {
        setResult('success', '接口已保存。');
        syncStatusChip();
        refreshModelHint();
      }).catch(function (e) { setResult('warn', '保存失败：' + e.message); });
    };
    var testBtn = $('#tv-test');
    if (testBtn) testBtn.onclick = function () {
      var cfg = readApiForm();
      ST.saveSettings({ api: cfg }).then(function () { return ST.testConnection(); }).then(function (msg) {
        setResult('success', '连接成功' + (msg ? '：' + msg : ''));
        syncStatusChip();
      }).catch(function (e) { setResult('warn', '连接失败：' + e.message); });
    };
    var pullBtn = $('#tv-models');
    if (pullBtn) pullBtn.onclick = function () {
      var cfg = readApiForm();
      setResult('info', '拉取模型列表中……');
      ST.fetchModels(cfg).then(function (list) {
        if (!list || !list.length) { setResult('warn', '接口未返回模型。'); return; }
        var sel = $('#tv-model');
        var cur = sel.value;
        sel.innerHTML = list.map(function (m) {
          var id = (typeof m === 'string') ? m : (m.id || m.name);
          return '<option value="' + esc(id) + '"' + (id === cur ? ' selected' : '') + '>' + esc(id) + '</option>';
        }).join('');
        setResult('success', '拉到 ' + list.length + ' 个模型，下拉选择即可。');
      }).catch(function (e) { setResult('warn', '拉取失败：' + e.message); });
    };
    var streamCb = $('#tv-stream');
    if (streamCb) streamCb.onchange = function () {
      ST.saveSettings({ stream: streamCb.checked }).then(function () {
        setResult('info', streamCb.checked ? '流式输出已开。' : '流式输出已关。');
      });
    };

    /* ---------- 管理器入口（弹窗在 js/st/ui.js） ---------- */
    var op = $('#tv-open-preset');
    if (op) op.onclick = function () { if (window.ST_UI) window.ST_UI.openPresetManager(); else setResult('warn', '内核 UI 未就绪。'); };
    var ol = $('#tv-open-lorebook');
    if (ol) ol.onclick = function () { if (window.ST_UI) window.ST_UI.openLorebookManager(); else setResult('warn', '内核 UI 未就绪。'); };

  }

  /* ============================================================
     app.js: TAVERN.renderMemory() — 天道记忆（独立左边栏页面）
     ============================================================ */
  function renderMemory() {
    var body = document.getElementById('pane-memory');
    if (!body) return;

    if (!ST.isReady()) {
      body.innerHTML = '<p class="tv-note">酒馆内核正在载入（IndexedDB 首次初始化）…</p>' +
        '<div class="tv-row"><button class="btn btn-sm" id="mem-reload">重试初始化</button></div>';
      var retry = $('#mem-reload');
      if (retry) retry.onclick = function () { _loadAll(); };
      return;
    }

    var s = ST.getSettings();

    function setMemResult(kind, msg) {
      var el = $('#mem-result');
      if (!el) return;
      el.textContent = msg;
      el.className = 'hint-chip hint-' + kind;
    }

    body.innerHTML =
      '<div class="tavern-grid">' +
      '<section class="panel tavern-card tavern-card-wide"><h3 class="panel-cap">记忆管理（天道总结）</h3>' +
      '<div class="tavern-form">' +
      '<div class="tv-preset-summary"><b>完整聊天 ' + esc(s.segmentedChatLayers != null ? s.segmentedChatLayers : 6) +
        ' 层</b><span class="tv-tag">大总结起点：倒数 ' + esc(s.segmentedLargeStart != null ? s.segmentedLargeStart : 14) + ' 层</span></div>' +
      '<label>最新完整聊天层数 X<input id="tv-seg-layers" type="number" min="1" max="60" value="' +
        esc(s.segmentedChatLayers != null ? s.segmentedChatLayers : 6) + '"></label>' +
      '<label>大总结起点 Y（倒数第 Y 层起只发大总结）<input id="tv-seg-large" type="number" min="2" max="200" value="' +
        esc(s.segmentedLargeStart != null ? s.segmentedLargeStart : 14) + '"></label>' +
      '<div class="tv-row"><button class="btn btn-sm" id="tv-save-seg">保存分段设置</button></div>' +
      '<div class="tv-mem-sec"><h5>小总结（较早 AI 回复 · 可编辑）</h5>' +
      '<div id="tv-small-list" class="tv-sum-list"><p class="tv-note">读取中…</p></div></div>' +
      '<div class="tv-mem-sec"><h5>大总结（更早 AI 回复 · 可编辑）</h5>' +
      '<div id="tv-large-list" class="tv-sum-list"><p class="tv-note">读取中…</p></div></div>' +
      '<div class="tv-mem-sec"><h5>手动补充（AI 忘写时，挂到最新回复）</h5>' +
      '<label>小总结<textarea id="tv-manual-small" rows="2"></textarea></label>' +
      '<label>大总结<textarea id="tv-manual-large" rows="2"></textarea></label>' +
      '<div class="tv-row"><button class="btn btn-sm" id="tv-manual-save">补充到最新回复</button></div></div>' +
      '<div class="tv-mem-sec"><h5>传统总结（调用总结 API 压缩历史为一条日志）</h5>' +
      '<label>总结提示词<textarea id="tv-sum-prompt" rows="2">' + esc(s.summaryPrompt || '') + '</textarea></label>' +
      '<div class="tv-row"><button class="btn btn-sm" id="tv-summary-run">总结最近 10 层</button></div>' +
      '<p class="tv-note" id="mem-result"></p></div>' +
      '<p class="tv-note">发送规则：最新 X 层完整聊天 → 较早 AI 回复发小总结 → 倒数 Y 层起发大总结。总结由主 AI 在 &lt;memo&gt; / &lt;events&gt; 标签里自写，也可在此手动补充或改写。总结属于当前对话——新开一局会随聊天一起清空。</p>' +
      '</div></section>' +
      '</div>';

    /* ---------- 事件 ---------- */
    function saveSegCfg() {
      ST.saveSettings({
        segmentedChatLayers: Number($('#tv-seg-layers').value) || 6,
        segmentedLargeStart: Number($('#tv-seg-large').value) || 14
      });
    }
    var saveSeg = $('#tv-save-seg');
    if (saveSeg) saveSeg.onclick = function () { saveSegCfg(); setMemResult('success', '分段记忆设置已保存。'); };

    function renderMemLists() {
      var aids = (window.APP_SEG_ASSISTANTS ? window.APP_SEG_ASSISTANTS() : []);
      var cfg = { layers: Number(($('#tv-seg-layers').value) || 6), large: Number(($('#tv-seg-large').value) || 14) };
      var n = aids.length;
      function row(t, kind) {
        var val = kind === 'large' ? (t.largeSummary || '') : (t.smallSummary || '');
        return '<div class="tv-sum-item" data-mid="' + t.id + '"><b>#' + t.id + ' 回复' + (t.smallSummary || t.largeSummary ? '' : ' · 未填') + '</b>' +
          '<textarea rows="2" data-mid="' + t.id + '" data-kind="' + kind + '">' + esc(val) + '</textarea></div>';
      }
      var smallBox = $('#tv-small-list'), largeBox = $('#tv-large-list');
      if (smallBox) {
        var smalls = aids.filter(function (_, i) { var fromEnd = n - i; return fromEnd > cfg.layers && fromEnd < cfg.large; });
        smallBox.innerHTML = smalls.length ? smalls.map(function (t) { return row(t, 'small'); }).join('') : '<p class="tv-note">暂无进入小总结窗口的回复。</p>';
      }
      if (largeBox) {
        var larges = aids.filter(function (_, i) { var fromEnd = n - i; return fromEnd >= cfg.large; });
        largeBox.innerHTML = larges.length ? larges.map(function (t) { return row(t, 'large'); }).join('') : '<p class="tv-note">暂无进入大总结窗口的回复。</p>';
      }
      [smallBox, largeBox].forEach(function (box) {
        if (!box) return;
        box.querySelectorAll('textarea').forEach(function (ta) {
          ta.addEventListener('change', function () {
            if (window.APP_MANUAL_FILL) window.APP_MANUAL_FILL(Number(ta.dataset.mid), ta.dataset.kind === 'small' ? ta.value : null, ta.dataset.kind === 'large' ? ta.value : null);
          });
        });
      });
    }
    setTimeout(renderMemLists, 80);
    if ($('#tv-seg-layers')) $('#tv-seg-layers').addEventListener('change', renderMemLists);
    if ($('#tv-seg-large')) $('#tv-seg-large').addEventListener('change', renderMemLists);

    var manualSave = document.getElementById('tv-manual-save');
    if (manualSave) manualSave.onclick = function () {
      var sm = $('#tv-manual-small').value.trim(), lg = $('#tv-manual-large').value.trim();
      if (!sm && !lg) { setMemResult('warn', '两个框都空着。'); return; }
      if (window.APP_MANUAL_FILL) window.APP_MANUAL_FILL(null, sm || null, lg || null);
      setMemResult('success', '已挂到最新 AI 回复。');
      renderMemLists();
    };

    var sumRun = $('#tv-summary-run');
    if (sumRun) sumRun.onclick = function () {
      var api = ST.getSettings().api || {};
      if (!api.baseUrl || !api.apiKey) { setMemResult('warn', '先在「酒馆 → 接口」保存 Base URL 与密钥。'); return; }
      var prompt = $('#tv-sum-prompt').value || '压缩成简明剧情记忆。';
      var aids = (window.APP_SEG_ASSISTANTS ? window.APP_SEG_ASSISTANTS() : []).slice(-10);
      if (!aids.length) { setMemResult('warn', '没有可总结的回复。'); return; }
      var text = aids.map(function (t) { return t.content; }).join('\n---\n');
      setMemResult('info', '总结中……');
      fetch(api.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + api.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: api.model || 'gpt-4o-mini', messages: [
          { role: 'user', content: '当前请暂停剧情扮演，进入总结模式，以上是需要总结的内容，（' + prompt + '）：\n\n' + text }
        ], max_tokens: 400 })
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          var res = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
          $('#mem-result').textContent = '〔总结〕' + res;
          if (window.APP_MANUAL_FILL) window.APP_MANUAL_FILL(null, res, null);
          setMemResult('success', '总结完成，已作为小总结挂到最新回复。');
        })
        .catch(function (e) { setMemResult('warn', '总结失败：' + e.message); });
    };
  }

  /* ---------- app.js: TAVERN.syncStatusChip() ---------- */
  function syncStatusChip() {
    var el = document.getElementById('chat-status-text');
    if (!el) return;
    el.textContent = ready() ? '酒馆已接入' : '本地引擎';
  }

  /* ---------- 契约挂载（app.js 依赖的完整入口） ---------- */
  window.TAVERN = {
    ready: ready,
    ask: ask,
    parseRaw: parseRaw,
    renderTavern: renderTavern,
    renderMemory: renderMemory,
    syncStatusChip: syncStatusChip,
    getSettings: function () { return ST.getSettings(); },
    saveSettings: function (patch) { return ST.saveSettings(patch); },
    _loadAll: function () { return ST.reload ? ST.reload() : (ST.init ? ST.init() : undefined); }
  };

})();

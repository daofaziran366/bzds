/* ============================================================
   腐化 · SillyTavern 集成内核 ⑨ UI 层
   ------------------------------------------------------------
   照搬 skill sillytavern-web 的五个编辑器组件：
     components/SillyTavern/EntryForm.tsx            （条目表单）
     components/SillyTavern/LorebookEditorModal.tsx  （单本编辑，草稿制）
     components/SillyTavern/LorebookModal.tsx        （书列表 + 激活）
     components/SillyTavern/PresetModal.tsx          （4 Tab 草稿制）
     components/SillyTavern/PromptOrderEditor.tsx    （prompt_order 排序）

   形状照搬 skill：字段集、显隐条件、草稿制（dirty 才能保存）、
   tryClose 的未保存确认、ChipInput 的 Enter/逗号/失焦提交。
   皮肤沿用腐化的暗色模态框（.modal / .modal-panel / .entry-form …），
   不搬 skill 的浅色内联样式——那是 React 演示壳，不是规范的一部分。

   skill 语义带来的取舍（相对上一版）：
     · 条目没有「停用」开关——skill 的 LorebookEntry 无 disabled 字段
     · 书没有「启用」开关——激活只在书列表的 activeLorebookIds
     · 没有「读取设置」面板——skill 无世界书全局设置层
     · 预设只有 4 个 Tab：采样 / Prompt 文本 / 自定义 Prompts / 排序
   ============================================================ */
(function () {
  'use strict';

  var C = window.ST_CORE;
  var ST = window.ST;
  var UI = {};

  var $1 = function (sel, root) { return (root || document).querySelector(sel); };
  var qa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = C.esc;

  function openModal(id) { var m = $1('#' + id); if (m) m.hidden = false; }
  function closeModal(id) { var m = $1('#' + id); if (m) m.hidden = true; }
  /* 模态框背后就是酒馆主页（统计数字 / 当前预设摘要 / 世界书本数）。
     任何一次增删改都要顺手回刷它，否则用户得切页才看得到变化。 */
  function refreshTavernPage() {
    try { if (window.TAVERN && window.TAVERN.renderTavern) window.TAVERN.renderTavern(); } catch (e) {}
  }
  function toast(kind, title, msg) {
    try { if (typeof notify === 'function') notify(kind || 'info', title || '', msg || ''); } catch (e) {}
  }
  function confirmBox(body) {
    return new Promise(function (resolve) {
      try {
        if (typeof confirmDialog === 'function') {
          confirmDialog({ title: '确认', body: body, okText: '确认', danger: true, onOk: function () { resolve(true); } });
          return;
        }
      } catch (e) {}
      resolve(!!(window.confirm && window.confirm(body)));
    });
  }
  function promptBox(body, dflt) {
    return (window.prompt ? window.prompt(body, dflt == null ? '' : dflt) : null);
  }
  function download(data, filename) {
    try {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { toast('error', '导出失败', String((e && e.message) || e)); }
  }
  function pickJson(cb) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.multiple = true;
    inp.onchange = function () {
      var files = Array.prototype.slice.call(inp.files || []);
      if (!files.length) return;
      var inputs = [];
      var pending = files.length;
      files.forEach(function (f) {
        f.text().then(function (text) {
          try { inputs.push({ fileName: f.name, json: JSON.parse(text) }); }
          catch (e) { inputs.push({ fileName: f.name, json: null }); }
        }).catch(function () { inputs.push({ fileName: f.name, json: null }); })
          .then(function () { if (--pending === 0) cb(inputs); });
      });
    };
    inp.click();
  }

  /* ============================================================
     1) 模态骨架
     ============================================================ */
  function ensureModals() {
    var root = document.getElementById('app-root') || document.body;
    var html = '';

    if (!$1('#st-modal-lorebook')) html +=
      '<div class="modal" id="st-modal-lorebook" hidden>' +
        '<div class="modal-backdrop" data-close="st-modal-lorebook"></div>' +
        '<div class="modal-panel modal-log">' +
          '<div class="modal-head"><div class="modal-head-text"><h2>世界书 Lorebook</h2>' +
          '<div class="modal-sub" id="st-lb-sub"></div></div>' +
          '<div class="modal-head-tools">' +
          '<button class="btn btn-sm btn-ghost" data-close="st-modal-lorebook">关闭</button>' +
          '</div></div>' +
          '<div class="modal-body">' +
          '<div class="st-toolbar" id="st-lb-toolbar">' +
          '<button class="btn btn-sm" data-act="lb-new">＋ 新建世界书</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="lb-import">导入 JSON</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="lb-template">导入内置设定</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="lb-backup">全量备份</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="lb-restore">从备份还原</button>' +
          '</div>' +
          '<div class="entry-form-list" id="st-lb-list"></div>' +
          '</div></div></div>';

    if (!$1('#st-modal-lorebook-editor')) html +=
      '<div class="modal" id="st-modal-lorebook-editor" hidden>' +
        '<div class="modal-backdrop" id="st-lbe-backdrop"></div>' +
        '<div class="modal-panel modal-log">' +
          '<div class="modal-head"><div class="modal-head-text"><h2>编辑世界书</h2>' +
          '<div class="modal-sub" id="st-lbe-sub"></div></div>' +
          '<div class="modal-head-tools">' +
          '<button class="btn btn-sm btn-primary" id="st-lbe-save" data-act="lbe-save">保存</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="lbe-close">关闭</button>' +
          '</div></div>' +
          '<div class="modal-body" id="st-lbe-body"></div>' +
        '</div></div>';

    if (!$1('#st-modal-preset')) html +=
      '<div class="modal" id="st-modal-preset" hidden>' +
        '<div class="modal-backdrop" id="st-pre-backdrop"></div>' +
        '<div class="modal-panel modal-log">' +
          '<div class="modal-head"><div class="modal-head-text"><h2>对话预设 Preset</h2>' +
          '<div class="modal-sub" id="st-pre-sub"></div></div>' +
          '<div class="modal-head-tools">' +
          '<button class="btn btn-sm btn-primary" id="st-pre-save" data-act="pre-save">保存</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="pre-close">关闭</button>' +
          '</div></div>' +
          '<div class="modal-body" id="st-pre-body"></div>' +
        '</div></div>';

    if (html) {
      var d = document.createElement('div');
      d.innerHTML = html;
      while (d.firstChild) root.appendChild(d.firstChild);
    }
    bindClose();
  }

  function bindClose() {
    qa('[data-close]').forEach(function (el) {
      if (el.getAttribute('data-bc')) return;
      el.setAttribute('data-bc', '1');
      el.addEventListener('click', function () { closeModal(el.getAttribute('data-close')); });
    });
  }

  /* ============================================================
     2) EntryForm（照搬 EntryForm.tsx 的字段集与显隐条件）
     ------------------------------------------------------------
     mount(container, entry, onPatch) → 渲染并可反复重渲
     ============================================================ */
  function chipInputHtml(label, field, values) {
    var chips = (values || []).map(function (v, i) {
      return '<span class="lb-chip" data-i="' + i + '">' + esc(v) +
        '<button type="button" data-chip-del="' + i + '" title="移除">×</button></span>';
    }).join('');
    return '<label class="preset-field preset-field--wide"><span>' + esc(label) + '</span>' +
      '<div class="lb-chips" data-chipfield="' + field + '">' + chips +
      '<input type="text" class="lb-chip-input" data-chip-input="' + field + '" placeholder="回车添加"></div></label>';
  }

  function rowSelect(label, field, options, current) {
    return '<label class="preset-field"><span>' + esc(label) + '</span><select data-f="' + field + '">' +
      options.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(current) === String(o[0]) ? ' selected' : '') + '>' +
          esc(o[1]) + '</option>';
      }).join('') + '</select></label>';
  }

  function rowNumber(label, field, value, min, max, fallback, width) {
    return '<label class="preset-field"><span>' + esc(label) + '</span>' +
      '<input type="number" data-f="' + field + '" value="' + esc(value) + '"' +
      ' min="' + min + '" max="' + max + '"' + (width ? ' style="max-width:' + width + 'px"' : '') + '></label>';
  }

  function chk(field, label, on) {
    return '<label class="st-inline"><input type="checkbox" data-f="' + field + '"' +
      (on ? ' checked' : '') + '> ' + esc(label) + '</label>';
  }

  /* 把「这条什么时候会被注入」用一句话说清楚。规则来自真实 SillyTavern 语义
     （主键纯 OR、常驻跳过概率、at_depth 插进历史），照着代码才看得出来的东西
     直接摆到界面上。 */
  function triggerHintHtml(e) {
    if (e.disabled) return '此条已<b>停用</b>：保留在书里但不参与注入。';

    var keys = e.keys || [];
    var sec = e.secondaryKeys || [];
    var posName = C.POSITION_LABEL[e.position || 'after_char'] || e.position;

    if (e.constant) {
      return '此条<b>常驻</b>：每回合都注入（不看关键词、不受概率影响），位置 ' + esc(posName) + '。';
    }
    if (!keys.length) {
      return '<b>永不注入</b>：既非常驻、又没有主关键词。给它加关键词，或勾选「常驻」。';
    }

    var s = '提及 <b>' + esc(keys.join(' 或 ')) + '</b> 时注入';
    if (e.selective && sec.length) {
      var lg = e.selectiveLogic || 'and_any';
      var phrase = {
        and_any: '且同时出现 ' + esc(sec.join(' 或 ')) + ' 之一',
        and_all: '且<b>同时</b>出现 ' + esc(sec.join(' 与 ')) + ' 全部',
        not_all: '且 ' + esc(sec.join(' 与 ')) + ' <b>没有全部</b>出现',
        not_any: '且 ' + esc(sec.join(' 或 ')) + ' <b>都不</b>出现',
      }[lg] || '';
      s += phrase;
    } else if (e.selective && !sec.length) {
      s += '（勾了选择性但没填副键 → 等同于不勾）';
    }
    if (e.useProbability && (e.probability == null ? 100 : e.probability) < 100) {
      s += '；另有 <b>' + (e.probability == null ? 100 : e.probability) + '%</b> 概率通过';
    }
    s += '。注入位置：' + esc(posName);
    if (e.position === 'at_depth') {
      s += '（作为独立消息插进对话流，距最新一条 ' + (e.depth == null ? 4 : e.depth) + ' 条，角色 ' +
        (C.ROLE_BY_ID[e.role == null ? 0 : Number(e.role)] || 'system') + '）';
    }
    if (e.position === 'outlet') s += '（outlet 不自动注入）';
    return s;
  }

  function entryFormHtml(e) {
    var isAtDepth = e.position === 'at_depth';
    var posOpts = C.POSITIONS.map(function (p) { return [p, C.POSITION_LABEL[p] || p]; });
    var logicOpts = C.LOGICS.map(function (l) { return [l, C.LOGIC_LABEL[l] || l]; });

    var MATCH_FIELDS = [
      ['matchPersonaDescription', '人设描述'],
      ['matchCharacterDescription', '角色描述'],
      ['matchCharacterPersonality', '角色性格'],
      ['matchCharacterDepthPrompt', '角色深度提示'],
      ['matchScenario', '场景'],
      ['matchCreatorNotes', '创建者备注']
    ];

    return '<div class="entry-form" data-eid="' + esc(e.id) + '">' +

      chipInputHtml('关键词 (主)', 'keys', e.keys) +
      chipInputHtml('次级关键词 (selective 时启用)', 'secondaryKeys', e.secondaryKeys) +

      '<label class="preset-field preset-field--wide"><span>备注 (comment)</span>' +
      '<input type="text" data-f="comment" value="' + esc(e.comment || '') + '" placeholder="留空时使用内容前 30 字"></label>' +

      '<label class="preset-field preset-field--wide"><span>内容 (content)</span>' +
      '<textarea class="ai-input lb-content-area" data-f="content" rows="10">' + esc(e.content || '') + '</textarea></label>' +

      '<div class="lb-edit-grid">' +
      rowSelect('位置 (position)', 'position', posOpts, e.position) +
      (isAtDepth ? rowNumber('深度 (depth)', 'depth', e.depth != null ? e.depth : 4, 0, 999, 4, 110) : '') +
      (isAtDepth ? rowSelect('角色 (role)', 'role',
        [[0, 'system'], [1, 'user'], [2, 'assistant']], e.role != null ? e.role : 0) : '') +
      rowNumber('优先级 (order)', 'order', e.order, 0, 9999, 100, 110) +
      '</div>' +

      '<div class="lb-edit-opts">' +
      '<label class="st-inline st-inline--danger"><input type="checkbox" data-f="disabled"' +
      (e.disabled ? ' checked' : '') + '> 停用此条（保留但不注入）</label>' +
      chk('constant', '常驻 (constant)', !!e.constant) +
      chk('selective', '选择性 (selective)', !!e.selective) +
      (e.selective ? rowSelect('副键逻辑', 'selectiveLogic', logicOpts, e.selectiveLogic || 'and_any') : '') +
      chk('useProbability', '启用概率', !!e.useProbability) +
      (e.useProbability ? rowNumber('概率 %', 'probability', e.probability, 0, 100, 100, 110) : '') +
      '</div>' +

      /* 触发规则说明：世界书的语义（主键纯 OR / 常驻跳过概率 / at_depth 插历史）
         不看代码是猜不出来的，直接把结论写在表单里。 */
      '<p class="lb-trigger-hint">' + triggerHintHtml(e) + '</p>' +

      '<details class="lb-advanced"><summary>高级设置</summary><div class="lb-advanced-body">' +

      rowNumber('扫描深度 (scanDepth)', 'scanDepth', e.scanDepth != null ? e.scanDepth : 0, 0, 999, 0, 110) +

      '<div class="lb-edit-opts">' +
      chk('caseSensitive', '区分大小写', !!e.caseSensitive) +
      chk('matchWholeWords', '全词匹配', !!e.matchWholeWords) +
      chk('excludeRecursion', '排除递归', !!e.excludeRecursion) +
      chk('preventRecursion', '阻止递归', !!e.preventRecursion) +
      chk('addMemo', '添加备注 (addMemo)', !!e.addMemo) +
      '</div>' +

      '<div class="lb-edit-grid">' +
      rowNumber('sticky', 'sticky', e.sticky != null ? e.sticky : 0, 0, 9999, 0, 110) +
      rowNumber('cooldown', 'cooldown', e.cooldown != null ? e.cooldown : 0, 0, 9999, 0, 110) +
      rowNumber('delay', 'delay', e.delay != null ? e.delay : 0, 0, 9999, 0, 110) +
      rowNumber('weight', 'weight', e.weight != null ? e.weight : 100, 0, 9999, 100, 110) +
      '</div>' +

      /* 诚实标注：这些字段能编辑、能随导入导出保真，但当前引擎不读取。
         不标出来的话，用户会以为自己调了却毫无变化。 */
      '<p class="lb-dead-note">以上字段随世界书导入导出保真保存，但本引擎当前' +
      '<b>不读取</b>它们（不参与命中判定）：scanDepth / excludeRecursion / preventRecursion / ' +
      'addMemo / sticky / cooldown / delay / weight / 分组 / 字符卡匹配 / decorators / characterFilter。' +
      '生效的是：关键词、常驻、选择性（副键逻辑）、概率、位置、优先级、区分大小写、全词匹配。</p>' +

      '<label class="preset-field preset-field--wide"><span>分组 (group)</span>' +
      '<input type="text" data-f="group" value="' + esc(e.group || '') + '"></label>' +
      chk('useGroupScoring', '分组评分', !!e.useGroupScoring) +

      '<fieldset class="lb-fieldset"><legend>字符卡匹配</legend><div class="lb-edit-opts">' +
      MATCH_FIELDS.map(function (mf) {
        return chk(mf[0], mf[1], !!e[mf[0]]);
      }).join('') +
      '</div></fieldset>' +

      '<label class="preset-field preset-field--wide"><span>decorators (逗号分隔)</span>' +
      '<input type="text" data-f="decoratorsCsv" value="' + esc((e.decorators || []).join(', ')) + '"></label>' +

      '<label class="preset-field preset-field--wide"><span>characterFilter (JSON，留空表示无)</span>' +
      '<textarea class="ai-input" data-f="characterFilter" rows="3">' +
      esc(e.characterFilter ? JSON.stringify(e.characterFilter, null, 2) : '') + '</textarea></label>' +

      '</div></details>' +
      '</div>';
  }

  /** 把表单事件绑到当前草稿上 */
  function bindEntryForm(root, entry, onPatch) {
    var form = $1('.entry-form', root) || root;

    function patch(p) { onPatch(p); }

    qa('[data-f]', form).forEach(function (el) {
      var f = el.getAttribute('data-f');
      if (el.tagName === 'SELECT') {
        el.addEventListener('change', function () {
          var v = el.value;
          if (f === 'role') v = Number(v);
          var p = {}; p[f] = v; patch(p);
        });
        return;
      }
      if (el.type === 'checkbox') {
        el.addEventListener('change', function () {
          var p = {}; p[f] = !!el.checked; patch(p);
        });
        return;
      }
      if (f === 'decoratorsCsv') {
        el.addEventListener('input', function () {
          patch({ decorators: el.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean) });
        });
        return;
      }
      if (f === 'characterFilter') {
        el.addEventListener('input', function () {
          var raw = el.value.trim();
          if (!raw) { patch({ characterFilter: undefined }); return; }
          try { patch({ characterFilter: JSON.parse(raw) }); } catch (e) { /* 输入过程中忽略 */ }
        });
        return;
      }
      el.addEventListener('input', function () {
        var v = el.value;
        if (el.type === 'number') {
          var lim = {
            depth: [0, 999, 4], order: [0, 9999, 100], probability: [0, 100, 100],
            scanDepth: [0, 999, 0], sticky: [0, 9999, 0], cooldown: [0, 9999, 0],
            delay: [0, 9999, 0], weight: [0, 9999, 100]
          }[f];
          v = lim ? C.clampNumber(v, lim[0], lim[1], lim[2]) : Number(v);
        }
        var p = {}; p[f] = v; patch(p);
      });
    });

    /* ChipInput：Enter / 逗号 / 失焦提交，× 删除 */
    qa('[data-chip-input]', form).forEach(function (inp) {
      var field = inp.getAttribute('data-chip-input');
      function commit() {
        var v = inp.value.trim();
        inp.value = '';
        if (!v) return;
        var list = (entry[field] || []).slice();
        if (list.indexOf(v) !== -1) return;
        var p = {}; p[field] = list.concat([v]);
        patch(p);
      }
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ',') { ev.preventDefault(); commit(); }
      });
      inp.addEventListener('blur', commit);
    });
    qa('[data-chip-del]', form).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var field = btn.closest('[data-chipfield]').getAttribute('data-chipfield');
        var i = Number(btn.getAttribute('data-chip-del'));
        var list = (entry[field] || []).slice();
        list.splice(i, 1);
        var p = {}; p[field] = list;
        patch(p);
      });
    });
  }

  /* ============================================================
     3) LorebookEditorModal（草稿制 + dirty 才可保存）
     ------------------------------------------------------------
     草稿必须是**浅拷贝**：外壳新对象、entries 数组新、但条目对象
     与原书共享引用。dirty 判定靠引用恒等（同 skill React 版：
     updateEntry 是 copy-on-write，改过的条目才会换引用）。
     深拷贝会让所有条目引用全变 → 一打开就"有改动"。
     ============================================================ */
  var edBook = null;        // 草稿
  var edOrig = null;        // 原始快照（判 dirty 用）
  var edSelectedId = null;

  function draftShallow(b) {
    var d = {};
    Object.keys(b).forEach(function (k) { d[k] = b[k]; });
    d.entries = (b.entries || []).slice();
    return d;
  }

  function isDirtyBook() {
    if (!edBook || !edOrig) return false;
    return edBook.name !== edOrig.name ||
      edBook.entries.length !== edOrig.entries.length ||
      edBook.entries.some(function (e, i) { return e !== edOrig.entries[i]; }) ||
      edBook.recursiveScanning !== edOrig.recursiveScanning ||
      edBook.caseSensitive !== edOrig.caseSensitive ||
      edBook.matchWholeWords !== edOrig.matchWholeWords;
  }

  function openLorebookEditor(bookId) {
    ensureModals();
    var book = ST.getLorebook(bookId);
    if (!book) { toast('warn', '世界书不存在', ''); return; }
    edOrig = draftShallow(book);
    edBook = draftShallow(book);
    edSelectedId = (edBook.entries[0] || {}).id || null;
    renderLorebookEditor();
    openModal('st-modal-lorebook-editor');
  }

  function renderLorebookEditor() {
    var body = $1('#st-lbe-body');
    if (!body || !edBook) return;
    var dirty = isDirtyBook();

    var saveBtn = $1('#st-lbe-save');
    if (saveBtn) {
      saveBtn.disabled = !dirty;
      saveBtn.classList.toggle('is-muted', !dirty);
      saveBtn.textContent = dirty ? '保存' : '已保存';
    }
    var sub = $1('#st-lbe-sub');
    if (sub) sub.textContent = edBook.entries.length + ' 条 · ' + (dirty ? '有未保存修改' : '无改动');

    var selected = null;
    edBook.entries.forEach(function (e) { if (e.id === edSelectedId) selected = e; });

    var rows = edBook.entries.map(function (e) {
      /* 行徽章要一眼看出「这条到底怎么触发」——尤其是导入的条目
         可能带着非默认的 selectiveLogic，而那是历史上出过反转 bug 的地方。 */
      var badges = '';
      if (e.disabled) badges += '<em class="st-badge st-badge--off">停用</em>';
      else if (e.constant) badges += '<em class="st-badge st-badge--gold">常驻</em>';
      else if (!(e.keys || []).length) badges += '<em class="st-badge st-badge--warn" title="没有关键词，也不会常驻——此条永不注入">无键</em>';
      else badges += '<em class="st-badge st-badge--key">' + (e.keys || []).length + '键</em>';

      if (!e.disabled && e.selective && (e.secondaryKeys || []).length) {
        var lg = e.selectiveLogic || 'and_any';
        badges += '<em class="st-badge st-badge--sel" title="副键逻辑：' + esc(C.LOGIC_LABEL[lg] || lg) + '">' +
          esc(lg.replace(/^(and|not)_/, '$1·')) + '</em>';
      }
      if (!e.disabled && e.useProbability && (e.probability == null ? 100 : e.probability) < 100) {
        badges += '<em class="st-badge st-badge--warn" title="每次触发有概率被跳过">' +
          (e.probability == null ? 100 : e.probability) + '%</em>';
      }
      if (!e.disabled && e.position === 'at_depth') {
        badges += '<em class="st-badge st-badge--pos" title="插入对话流：距最新消息 ' +
          (e.depth == null ? 4 : e.depth) + ' 条，角色 ' + (C.ROLE_BY_ID[e.role == null ? 0 : Number(e.role)] || 'system') + '">' +
          '深度' + (e.depth == null ? 4 : e.depth) + '</em>';
      } else if (!e.disabled && e.position && e.position !== 'after_char') {
        badges += '<em class="st-badge st-badge--pos" title="' + esc(C.POSITION_LABEL[e.position] || e.position) + '">' +
          esc(e.position.replace(/_char$|_example$/, '')) + '</em>';
      }

      return '<li class="st-entry-row' + (e.id === edSelectedId ? ' is-active' : '') +
        (e.disabled ? ' is-off' : '') + '"' +
        ' data-act="entry-sel" data-id="' + esc(e.id) + '">' +
        '<span class="st-entry-row__name">' + esc(C.entryLabel(e)) + '</span>' +
        badges +
        '<span class="st-entry-row__len">' + String(e.content || '').length + '</span></li>';
    }).join('');

    body.innerHTML =
      '<div class="st-toolbar st-toolbar--form">' +
      '<label class="preset-field preset-field--wide"><span>世界书名称</span>' +
      '<input type="text" class="ai-input" data-act="lbe-name" value="' + esc(edBook.name) + '"></label>' +
      '</div>' +
      '<div class="lb-edit-opts">' +
      chk('_bookRecursive', '递归扫描 (recursiveScanning)', !!edBook.recursiveScanning) +
      chk('_bookCase', '区分大小写 (caseSensitive)', !!edBook.caseSensitive) +
      chk('_bookWhole', '全词匹配 (matchWholeWords)', !!edBook.matchWholeWords) +
      '</div>' +
      '<div class="st-split">' +
      '<aside class="st-split__side">' +
      '<button class="btn btn-sm" data-act="lbe-add" style="width:100%;margin-bottom:8px;">＋ 新建条目</button>' +
      '<ul class="st-entry-list" id="st-entry-list">' + (rows || '<li class="empty-hint">暂无条目</li>') + '</ul>' +
      '</aside>' +
      '<main class="st-split__main" id="st-entry-form">' +
      (selected ? entryFormHtml(selected) : '<div class="empty-hint">左侧选择条目，或点「＋ 新建条目」。</div>') +
      '</main></div>' +
      (selected ? '<div class="st-toolbar"><button class="btn btn-sm btn-ghost is-danger" data-act="lbe-del-entry">删除此条目</button></div>' : '');

    bindLorebookEditor();
  }

  function bindLorebookEditor() {
    var body = $1('#st-lbe-body');
    if (!body || !edBook) return;

    var nm = $1('[data-act="lbe-name"]', body);
    if (nm) nm.addEventListener('input', function () {
      edBook.name = nm.value;
      edBook.updatedAt = Date.now();
      refreshEditorHead();
    });

    [['[data-f="_bookRecursive"]', 'recursiveScanning'],
     ['[data-f="_bookCase"]', 'caseSensitive'],
     ['[data-f="_bookWhole"]', 'matchWholeWords']].forEach(function (pair) {
      var cb = $1(pair[0], body);
      if (!cb) return;
      cb.addEventListener('change', function () {
        edBook[pair[1]] = !!cb.checked;
        edBook.updatedAt = Date.now();
        refreshEditorHead();
      });
    });

    qa('#st-entry-list [data-act="entry-sel"]', body).forEach(function (li) {
      li.addEventListener('click', function () {
        edSelectedId = li.getAttribute('data-id');
        renderLorebookEditor();
      });
    });

    var addBtn = $1('[data-act="lbe-add"]', body);
    if (addBtn) addBtn.addEventListener('click', function () {
      var e = C.createDefaultEntry();
      edBook.entries = edBook.entries.concat([e]);
      edBook.updatedAt = Date.now();
      edSelectedId = e.id;
      renderLorebookEditor();
    });

    var delBtn = $1('[data-act="lbe-del-entry"]', body);
    if (delBtn) delBtn.addEventListener('click', function () {
      confirmBox('确定删除此条目?').then(function (yes) {
        if (!yes) return;
        edBook = C.removeEntry(edBook, edSelectedId);
        var remaining = edBook.entries.filter(function (e) { return e.id !== edSelectedId; });
        edSelectedId = remaining.length ? remaining[0].id : null;
        renderLorebookEditor();
      });
    });

    var formRoot = $1('#st-entry-form');
    var selected = null;
    edBook.entries.forEach(function (e) { if (e.id === edSelectedId) selected = e; });
    if (formRoot && selected) {
      bindEntryForm(formRoot, selected, function (patch) {
        edBook = C.updateEntry(edBook, selected.id, patch);
        var chipField = patch.keys !== undefined ? 'keys'
          : (patch.secondaryKeys !== undefined ? 'secondaryKeys' : null);
        /* 显隐/徽章条件变了（position / selective / useProbability / constant / disabled）→ 整表单重渲 */
        if (patch.position !== undefined || patch.selective !== undefined ||
            patch.useProbability !== undefined || patch.constant !== undefined ||
            patch.disabled !== undefined) {
          renderLorebookEditor();
          return;
        }
        /* 芯片增删 → 重渲芯片区并找回焦点（否则新芯片不出现） */
        if (chipField) {
          renderLorebookEditor();
          var again = $1('[data-chip-input="' + chipField + '"]');
          if (again) again.focus();
          return;
        }
        refreshEditorHead();
        syncEntryRow(selected);
      });
    }
  }

  function refreshEditorHead() {
    var dirty = isDirtyBook();
    var saveBtn = $1('#st-lbe-save');
    if (saveBtn) {
      saveBtn.disabled = !dirty;
      saveBtn.textContent = dirty ? '保存' : '已保存';
    }
    var sub = $1('#st-lbe-sub');
    if (sub) sub.textContent = (edBook ? edBook.entries.length : 0) + ' 条 · ' + (dirty ? '有未保存修改' : '无改动');
  }

  /** 只更新左栏那一行的标题/字数/停用态，避免整表重渲丢焦点 */
  function syncEntryRow(entry) {
    var li = $1('#st-entry-list [data-id="' + entry.id + '"]');
    if (!li) return;
    var n = $1('.st-entry-row__name', li);
    if (n) n.textContent = C.entryLabel(entry);
    var len = $1('.st-entry-row__len', li);
    if (len) len.textContent = String(entry.content || '').length;
    li.classList.toggle('is-off', !!entry.disabled);
  }

  function saveLorebookEditor() {
    if (!edBook) return Promise.resolve(null);
    return ST.saveLorebook(edBook).then(function () {
      edOrig = draftShallow(edBook);   /* 共享条目引用 → dirty 归零 */
      refreshEditorHead();
      toast('success', '已保存', '「' + edBook.name + '」');
      renderLorebookList();
      return edBook;
    });
  }

  function tryCloseEditor() {
    if (!isDirtyBook()) { closeModal('st-modal-lorebook-editor'); return; }
    confirmBox('放弃未保存的修改?').then(function (yes) {
      if (yes) closeModal('st-modal-lorebook-editor');
    });
  }

  /* ============================================================
     4) LorebookModal（书列表；激活 = settings.activeLorebookIds）
     ============================================================ */
  function renderLorebookList() {
    var box = $1('#st-lb-list');
    if (!box) return;
    var books = ST.getLorebooks();
    var s = ST.getSettings();
    var activeIds = s.activeLorebookIds || [];
    var total = books.reduce(function (a, b) { return a + (b.entries || []).length; }, 0);

    var sub = $1('#st-lb-sub');
    if (sub) sub.textContent = '共 ' + books.length + ' 本 · ' + total + ' 条 · 已激活 ' + activeIds.length + ' 本';
    refreshTavernPage();   /* 列表一变，背后的酒馆主页同步跟上 */

    if (!books.length) {
      box.innerHTML = '<div class="empty-hint">尚无世界书。点「＋ 新建世界书」「导入 JSON」，或「导入内置设定」获得临江模板。</div>';
      return;
    }

    box.innerHTML = books.map(function (b) {
      var on = activeIds.indexOf(b.id) !== -1;
      var entries = b.entries || [];
      var n = entries.length;
      var offCount = entries.filter(function (e) { return e.disabled; }).length;
      var constCount = entries.filter(function (e) { return e.constant && !e.disabled; }).length;
      /* 「死条」= 既非常驻、又没主关键词 → 永远不会注入。
         这是最常见的白忙一场（用户建了条目却从不生效），列表里直接点出来。 */
      var deadCount = entries.filter(function (e) {
        return !e.disabled && !e.constant && !(e.keys || []).length;
      }).length;
      var depthCount = entries.filter(function (e) {
        return !e.disabled && e.position === 'at_depth';
      }).length;
      var outletCount = entries.filter(function (e) {
        return !e.disabled && e.position === 'outlet';
      }).length;

      return '<div class="lorebook-item' + (on ? ' is-on' : ' is-off') + '" data-book="' + esc(b.id) + '">' +
        '<label class="lorebook-toggle" title="激活/停用本书">' +
        '<input type="checkbox" data-act="lb-active" data-id="' + esc(b.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="lorebook-toggle__label">' + (on ? '已激活' : '未激活') + '</span></label>' +
        '<div class="lorebook-item__main">' +
        '<div class="lorebook-item__name">' + esc(b.name) +
        (b.builtin === 'core' ? ' <em class="st-badge st-badge--gold">内置</em>' : '') +
        (b.builtin === 'orgcharters' ? ' <em class="st-badge st-badge--gold">成文</em>' : '') +
        (!on && n ? ' <em class="st-badge st-badge--warn">未激活·不注入</em>' : '') + '</div>' +
        '<div class="lorebook-item__meta">' + n + ' 条' +
        (constCount ? ' · ' + constCount + ' 常驻' : '') +
        (depthCount ? ' · ' + depthCount + ' 深度注入' : '') +
        (outletCount ? ' · ' + outletCount + ' outlet(不注入)' : '') +
        (offCount ? ' · ' + offCount + ' 停用' : '') +
        (deadCount ? ' · <b class="lb-warn-text">' + deadCount + ' 条永不注入</b>' : '') +
        (b.description ? ' · ' + esc(b.description) : '') + '</div></div>' +
        '<div class="lorebook-item__actions">' +
        '<button class="btn btn-ghost btn-mini" data-act="lb-rename" data-id="' + esc(b.id) + '">改名</button>' +
        '<button class="btn btn-ghost btn-mini" data-act="lb-edit" data-id="' + esc(b.id) + '">编辑</button>' +
        '<button class="btn btn-ghost btn-mini" data-act="lb-export" data-id="' + esc(b.id) + '">导出</button>' +
        '<button class="btn btn-ghost btn-mini is-danger" data-act="lb-del" data-id="' + esc(b.id) + '">删除</button>' +
        '</div></div>';
    }).join('');
  }

  /* ============================================================
     5) PresetModal（2 Tab：采样 / 模块）
     ------------------------------------------------------------
     「Prompt 文本」与「自定义 Prompts」两个 Tab 已并入「模块」：
     模块面板里每一项展开就是它自己的编辑器，不再需要用户先在
     三处地方找同一个预设的不同侧面。
     ============================================================ */
  var TABS = [
    { id: 'sampling', label: '采样' },
    { id: 'modules', label: '模块' }
  ];

  var prDraft = null;
  var prOrig = null;
  var prTab = 'sampling';

  function isDirtyPreset() {
    if (!prDraft || !prOrig) return false;
    if (prDraft.name !== prOrig.name) return true;
    return JSON.stringify(prDraft.settings) !== JSON.stringify(prOrig.settings);
  }

  function numberField(label, key, value, step, min, max, fallback) {
    /* 导入预设的内容要如实显示：文件里没写的键显示为空（默认值只做
       placeholder 提示），不做「把兜底值伪装成已设置」的假回显 */
    return '<label class="preset-field"><span>' + esc(label) + '</span>' +
      '<input type="number" step="' + step + '" data-pnum="' + key + '" min="' + min + '" max="' + max + '"' +
      ' value="' + esc(value !== undefined ? value : '') + '" placeholder="默认 ' + esc(fallback) + '"></label>';
  }

  /** 建草稿对 {draft, orig}：先 normalize 再拍 prOrig 快照。
      顺序反了的话，「打开管理器补全模块表」这件事本身就会把草稿
      标成 dirty——用户什么都没改，切预设却弹「未保存修改」确认。 */
  function draftPairOf(p) {
    var d = p ? JSON.parse(JSON.stringify(p)) : null;
    if (d) {
      if (!d.settings) d.settings = {};
      normalizeModuleOrder(d.settings);
    }
    var o = d ? JSON.parse(JSON.stringify(d)) : null;
    return { draft: d, orig: o };
  }

  function renderPresetManager() {
    ensureModals();
    var body = $1('#st-pre-body');
    if (!body) return;

    var presets = ST.getPresets();
    var s = ST.getSettings();
    var activeId = s.activePresetId;
    var cur = null;
    presets.forEach(function (p) { if (p.id === activeId) cur = p; });
    if (!cur && presets.length) cur = presets[0];
    /* 只在「草稿不存在 / 草稿那份预设已被删除」时重置。
       旧守卫写的是 prDraft.id !== 激活预设.id —— 于是下拉切换到
       非激活预设后，这次重渲立刻把草稿踩回激活预设，
       表现为「预设页面切不了预设」。 */
    var draftAlive = prDraft && presets.some(function (p) { return p.id === prDraft.id; });
    if (!draftAlive) {
      var pair = draftPairOf(cur);
      prDraft = pair.draft;
      prOrig = pair.orig;
    }

    var dirty = isDirtyPreset();
    var saveBtn = $1('#st-pre-save');
    if (saveBtn) { saveBtn.disabled = !dirty; saveBtn.textContent = dirty ? '保存' : '已保存'; }
    var sub = $1('#st-pre-sub');
    if (sub) {
      sub.textContent = '共 ' + presets.length + ' 个 · 当前：' + (prDraft ? prDraft.name : '（无）') +
        (dirty ? ' · 有未保存修改' : '');
    }

    if (!prDraft) {
      body.innerHTML = '<div class="st-toolbar">' +
        '<button class="btn btn-sm" data-act="pre-new">新建预设</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="pre-import">导入</button></div>' +
        '<div class="empty-hint">无预设。点「新建预设」创建默认预设，或「导入」SillyTavern 预设 JSON。</div>';
      bindPresetToolbar(body);
      return;
    }

    var S = prDraft.settings;
    var opts = presets.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === prDraft.id ? ' selected' : '') + '>' +
        esc(p.name) + '</option>';
    }).join('');

    body.innerHTML =
      '<div class="st-toolbar">' +
      '<select class="ai-input st-select" data-act="pre-pick">' + (opts || '<option>（无预设）</option>') + '</select>' +
      '<button class="btn btn-sm" data-act="pre-new">新建</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="pre-import">导入</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="pre-export">导出</button>' +
      '<button class="btn btn-sm btn-ghost is-danger" data-act="pre-del">删除</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-sm btn-ghost" data-act="pre-activate">设为激活</button>' +
      '</div>' +
      '<label class="preset-field preset-field--wide"><span>预设名称</span>' +
      '<input type="text" class="ai-input" data-act="pre-name" value="' + esc(prDraft.name) + '"></label>' +
      '<div class="st-tabs" id="st-pre-tabs">' +
      TABS.map(function (t) {
        return '<button class="st-tab' + (prTab === t.id ? ' is-active' : '') + '" data-act="pre-tab" data-tab="' + t.id + '">' +
          t.label + '</button>';
      }).join('') + '</div>' +
      '<div class="st-pane" id="st-pre-pane"></div>';

    renderPresetPane();
    bindPresetToolbar(body);
    bindPresetPane();
  }

  function renderPresetPane() {
    var pane = $1('#st-pre-pane');
    if (!pane || !prDraft) return;
    var S = prDraft.settings;

    if (prTab === 'sampling') {
      pane.innerHTML =
        '<p class="tv-note" style="margin:0 0 10px">与 SillyTavern 预设面板同名同义。<b>留空的字段使用内置默认值：温度 0.85 · 最大回复 4096 · 上下文 4096 · 非流式</b>。' +
        '若你酒馆里的滑杆值（如上下文 200000 / 最大回复 32000）不在导出的 JSON 里，游戏读不到——在这里填一次即可。</p>' +
        '<div class="preset-grid">' +
        numberField('温度（temp_openai）', 'temp_openai', S.temp_openai, 0.05, 0, 2, 0.8) +
        numberField('Top P（top_p_openai）', 'top_p_openai', S.top_p_openai, 0.01, 0, 1, 0.9) +
        numberField('频率惩罚（freq_pen_openai）', 'freq_pen_openai', S.freq_pen_openai, 0.1, -2, 2, 0) +
        numberField('存在惩罚（pres_pen_openai）', 'pres_pen_openai', S.pres_pen_openai, 0.1, -2, 2, 0) +
        numberField('上下文长度（openai_max_context）', 'openai_max_context', S.openai_max_context, 256, 256, 2000000, 4096) +
        numberField('最大回复长度（openai_max_tokens）', 'openai_max_tokens', S.openai_max_tokens, 64, 32, 32768, 4096) +
        numberField('Top K（top_k_openai）', 'top_k_openai', S.top_k_openai, 1, 0, 500, 0) +
        numberField('Top A（top_a_openai）', 'top_a_openai', S.top_a_openai, 0.01, 0, 1, 0) +
        numberField('Min P（min_p_openai）', 'min_p_openai', S.min_p_openai, 0.01, 0, 1, 0) +
        numberField('重复惩罚（repetition_penalty_openai）', 'repetition_penalty_openai', S.repetition_penalty_openai, 0.05, 0, 2, 1) +
        '</div>' +
        '<label class="preset-field preset-field--wide"><span>模型（openai_model，留空用接口设置的模型）</span>' +
        '<input type="text" data-pstr="openai_model" value="' + esc(S.openai_model || '') + '" placeholder="gpt-3.5-turbo"></label>' +
        '<div class="lb-edit-opts">' +
        '<label class="st-inline"><input type="checkbox" data-pchk="stream_openai"' + (S.stream_openai ? ' checked' : '') + '> 流式传输（stream_openai）</label>' +
        '<label class="st-inline"><input type="checkbox" data-pchk="max_context_unlocked"' + (S.max_context_unlocked ? ' checked' : '') + '> 解锁上下文长度上限（max_context_unlocked）</label>' +
        '</div>';
      return;
    }

    /* modules（唯一的功能面板：全部模块 + 开关 + 排序 + 展开编辑） */
    normalizeModuleOrder(S);
    pane.innerHTML = renderModulesHtml();
  }

  /* ============================================================
     5b) 模块总控
     ------------------------------------------------------------
     skill 的 PromptOrderEditor 只列 prompt_order 里已有的 10 项，
     其余可解析字段（nsfw / 角色卡槽 / 变量块 / 输出协议 / 自定义块）
     既看不见也开关不了——填了也不注入。这里把「组装器能解析的一切
     模块」一次性摊开：分两段——「注入顺序」与「未启用模块」。
     ============================================================ */
  var openModules = {};

  /** 把「组装器能解析但预设里没写」的模块补进 prompt_order。
      ------------------------------------------------------------
      规则（用户要求：默认启用以导入文件为准）：
        · 文件里已列出的模块 → 顺序与 enabled 一律不动。读取走
          ST_PRESET.getPromptOrder —— 真实 ST 预设的 prompt_order 是
          {角色ID: 条目[]} 映射对象，直接 Array.isArray 判断会把
          整组文件信息当无物丢掉（「导入后不启用 ST 里的模块」根因）
        · variablesBlock / formatPrompt 缺席 → 补在尾部且 enabled:true
          （组装器今天本来就无条件追加它们，补进来只是让 UI 说的是实话）
        · 其余模块缺席 → 补在尾部、enabled:false（今天本来也不注入）
      补齐只在草稿里做，点「保存」才落库；映射/分组形态一律就地
      摊平成标准数组写回草稿（不改原库记录）。 */
  function normalizeModuleOrder(S) {
    var order = window.ST_PRESET.getPromptOrder(S).map(function (o) {
      var copy = {};
      Object.keys(o || {}).forEach(function (k) { copy[k] = o[k]; });
      return copy;
    });
    var ids = order.map(function (o) { return o && o.identifier; });
    /* 缺席即补启用的四个：变量块 / 输出协议 / 世界书两槽。
       前两个是引擎无条件追加的；后两个是「激活了世界书就要注入」的
       引擎默认——文件没表态（缺席）≠ 表态停用（enabled:false）。
       与 assembler.js 的 ensureWiSlots 保持一致。 */
    var AUTO_ON = { variablesBlock: true, formatPrompt: true,
      worldInfoBefore: true, worldInfoAfter: true };
    var add = [];
    C.MODULES.forEach(function (m) {
      if (ids.indexOf(m.identifier) !== -1) return;
      add.push({ identifier: m.identifier, name: m.label, role: 'system',
        enabled: !!AUTO_ON[m.identifier] });
    });
    (Array.isArray(S.prompts) ? S.prompts : []).forEach(function (p) {
      if (!p || !p.identifier || ids.indexOf(p.identifier) !== -1) return;
      if (add.some(function (a) { return a.identifier === p.identifier; })) return;
      add.push({ identifier: p.identifier, name: p.name || p.identifier,
        role: p.role || 'system', enabled: false });
    });
    S.prompt_order = order.concat(add);
  }

  /** 模块行数据（normalize 之后，prompt_order 就是唯一真相） */
  function moduleRows(S) {
    var order = Array.isArray(S.prompt_order) ? S.prompt_order : [];
    var prompts = Array.isArray(S.prompts) ? S.prompts : [];
    var customById = {};
    prompts.forEach(function (p) { if (p && p.identifier) customById[p.identifier] = p; });
    return order.map(function (o, i) {
      var known = C.MODULE_BY_ID[o.identifier];
      var cu = customById[o.identifier];
      var custom = !known && !!cu;
      return {
        idx: i, identifier: o.identifier,
        label: (known && known.label) || o.name || (cu && cu.name) || o.identifier,
        dynamic: !!(known && known.dynamic),
        editable: !!(known && known.editable) || custom,
        inert: !!(known && known.source === 'inert'),
        enabled: o.enabled !== false,
        role: o.role || (cu && cu.role) || 'system',
        name: o.name, custom: custom
      };
    });
  }

  /** 模块正文读写（文本模块 → settings.<key>；自定义块 → prompts[].content） */
  function moduleContent(S, identifier) {
    var key = C.moduleSettingsKey(identifier);
    if (key) return String(S[key] == null ? '' : S[key]);
    var p = (S.prompts || []).filter(function (x) { return x && x.identifier === identifier; })[0];
    return p ? String(p.content == null ? '' : p.content) : '';
  }
  function setModuleContent(S, identifier, val) {
    var key = C.moduleSettingsKey(identifier);
    if (key) { S[key] = val; return; }
    var list = Array.isArray(S.prompts) ? S.prompts : (S.prompts = []);
    var p = list.filter(function (x) { return x && x.identifier === identifier; })[0];
    if (p) p.content = val;
    else list.push({ identifier: identifier, name: identifier, role: 'system', content: val });
  }
  /** 开关：只翻 enabled —— 位置与内容都保留，随时可以再勾上 */
  function setModuleEnabled(S, identifier, on) {
    var order = (Array.isArray(S.prompt_order) ? S.prompt_order : []).slice();
    var at = -1;
    order.forEach(function (o, i) { if (o && o.identifier === identifier) at = i; });
    if (at >= 0) order[at] = Object.assign({}, order[at], { enabled: !!on });
    else {
      var m = C.MODULE_BY_ID[identifier];
      order.push({ identifier: identifier, name: (m && m.label) || identifier, role: 'system', enabled: !!on });
    }
    S.prompt_order = order;
  }
  function moveModule(S, idx, delta) {
    var next = C.movePromptItem(S.prompt_order || [], idx, idx + delta);
    if (next !== S.prompt_order) S.prompt_order = next;
  }
  function deleteCustomModule(S, identifier) {
    S.prompts = (S.prompts || []).filter(function (p) { return !p || p.identifier !== identifier; });
    S.prompt_order = (S.prompt_order || []).filter(function (o) { return !o || o.identifier !== identifier; });
  }

  function moduleRowHtml(item) {
    var S = prDraft.settings;
    var open = !!openModules[item.identifier];
    var content = (item.dynamic || item.inert) ? '' : moduleContent(S, item.identifier);
    var roleBadge = item.role === 'user' ? 'U' : (item.role === 'assistant' ? 'A' : 'S');
    var n = moduleRows(S).length;

    var head =
      '<div class="po-head" data-act="mod-toggle-open" data-mid="' + esc(item.identifier) + '">' +
      '<span class="po-chev"></span>' +
      '<input type="checkbox" class="po-toggle" data-act="mod-enable" data-mid="' + esc(item.identifier) + '"' +
        (item.enabled ? ' checked' : '') + ' title="' + (item.enabled ? '停用此模块' : '启用此模块') + '">' +
      '<span class="po-idx">' + (item.enabled ? (item.idx + 1) : '—') + '</span>' +
      '<span class="po-role' + (item.role === 'user' ? ' is-user' : '') + '">' + roleBadge + '</span>' +
      '<span class="po-name">' + esc(item.label) + '</span>' +
      '<code class="st-code">' + esc(item.identifier) + '</code>' +
      (item.inert ? '<em class="st-badge">不注入</em>'
        : item.dynamic ? '<em class="st-badge st-badge--gold">引擎填充</em>'
        : item.custom ? '<em class="st-badge">自定义块</em>' : '') +
      (item.dynamic || item.inert ? '' : '<span class="po-len">' + String(content).length + '字</span>') +
      '<button class="btn btn-mini" data-act="mod-up" data-mid="' + esc(item.identifier) + '"' +
        (item.idx === 0 ? ' disabled' : '') + ' title="上移">↑</button>' +
      '<button class="btn btn-mini" data-act="mod-down" data-mid="' + esc(item.identifier) + '"' +
        (item.idx >= n - 1 ? ' disabled' : '') + ' title="下移">↓</button>' +
      (item.custom ? '<button class="btn btn-mini is-danger" data-act="mod-del" data-mid="' +
        esc(item.identifier) + '" title="删除此自定义块">×</button>' : '') +
      '</div>';

    var body = '';
    if (open) {
      body =
        '<div class="po-body">' +
        '<div class="lb-edit-grid">' +
        '<label>显示名 name<input data-mod="' + esc(item.identifier) + '" data-mf="name" value="' +
          esc(item.name || item.label) + '"></label>' +
        '<label>角色 role<select data-mod="' + esc(item.identifier) + '" data-mf="role">' +
          ['system', 'user', 'assistant'].map(function (r) {
            return '<option value="' + r + '"' + (item.role === r ? ' selected' : '') + '>' + r + '</option>';
          }).join('') + '</select></label>' +
        '</div>' +
        (item.inert
          ? '<p class="preset-hint">此槽位组装器恒不注入（SillyTavern 的 bias 由 API 参数承载）。</p>'
          : item.dynamic
            ? '<p class="preset-hint">内容由引擎按当前世界书命中 / 对话历史 / 游戏状态动态生成，无需也不能手填。</p>'
            : '<label>内容<textarea class="ai-input po-editor" rows="6" data-mod="' + esc(item.identifier) +
                '" data-mf="content" placeholder="（留空 → 此模块不注入）">' + esc(content) + '</textarea></label>') +
        '</div>';
    }

    return '<div class="po-item' + (item.enabled ? '' : ' is-off') + (open ? ' is-open' : '') +
      '" data-mid="' + esc(item.identifier) + '">' + head + body + '</div>';
  }

  function renderModulesHtml() {
    var S = prDraft.settings;
    var list = moduleRows(S);
    var onCount = list.filter(function (o) { return o.enabled; }).length;
    return '<div class="preset-section"><div class="preset-section-head"><b>模块（' + onCount + ' / ' +
      list.length + ' 启用）</b>' +
      '<span class="preset-badge">勾选=注入 · ↑↓调顺序 · 点行展开改内容</span></div>' +
      '<div class="prompt-order" id="st-modules">' +
      (list.length
        ? list.map(function (it) { return moduleRowHtml(it); }).join('')
        : '<div class="empty-hint">没有模块。</div>') +
      '</div>' +
      '<div class="st-toolbar" style="margin-top:10px;padding:0 13px 13px;">' +
      '<button class="btn btn-sm" data-act="pre-add-prompt">＋ 新建自定义块</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="mod-reset-order">重置为标准顺序</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="mod-expand-all">全部展开</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="mod-collapse-all">全部折叠</button>' +
      '</div>' +
      '<p class="preset-hint" style="padding:0 13px 13px;">停用的模块只是不注入，位置与内容都保留；' +
      '变量块 / 输出协议由引擎填充，展开后没有内容框。</p>' +
      '</div>';
  }
  function bindPresetToolbar(body) {
    var pick = $1('[data-act="pre-pick"]', body);
    if (pick) pick.addEventListener('change', function () {
      var next = null;
      ST.getPresets().forEach(function (p) { if (p.id === pick.value) next = p; });
      if (isDirtyPreset()) {
        confirmBox('当前预设有未保存修改,确定切换?').then(function (yes) {
          if (!yes) { renderPresetManager(); return; }
          var pair = draftPairOf(next);
          prDraft = pair.draft; prOrig = pair.orig;
          renderPresetManager();
        });
        return;
      }
      var pair = draftPairOf(next);
      prDraft = pair.draft; prOrig = pair.orig;
      renderPresetManager();
    });

    var nb = $1('[data-act="pre-new"]', body);
    if (nb) nb.addEventListener('click', function () {
      var name = promptBox('新预设名称', '新预设');
      if (!name) return;
      ST.addPresetFromDefault(name).then(function (p) {
        var pair = draftPairOf(p);
        prDraft = pair.draft; prOrig = pair.orig;
        renderPresetManager();
        toast('success', '已创建', '「' + p.name + '」');
      refreshTavernPage();
      });
    });

    var im = $1('[data-act="pre-import"]', body);
    if (im) im.addEventListener('click', function () {
      pickJson(function (inputs) {
        var first = null;
        var jobs = [];
        inputs.forEach(function (it) {
          if (!it.json || typeof it.json !== 'object') return;
          /* 社区预设常不带 name/preset 字段——用文件名兜底，避免全叫「导入的预设」 */
          if (!it.json.preset && !it.json.name && it.fileName) {
            it.json.name = it.fileName.replace(/\.json$/i, '');
          }
          jobs.push(ST.importPresetAndSave(it.json).then(function (p) { if (!first) first = p; }));
        });
        Promise.all(jobs).then(function () {
          if (!first) { toast('warn', '导入失败', '不是 SillyTavern 预设 JSON'); return; }
          /* 社区分享的预设常不含采样参数（温度/最大回复/上下文/流式都在
             ST 的滑杆里，没保存进 JSON）——导入后明确告知默认值与去处 */
          var miss = [];
          if (first.settings.temp_openai === undefined) miss.push('温度');
          if (first.settings.openai_max_tokens === undefined) miss.push('最大回复长度');
          if (first.settings.openai_max_context === undefined) miss.push('上下文长度');
          if (first.settings.stream_openai === undefined) miss.push('流式传输');
          /* 导入即激活：用户的预期是「这份预设马上能用」，
             躺在列表里不点亮等于没导入（还要手动点一次「设为激活」）。 */
          return ST.saveSettings({ activePresetId: first.id }).then(function () {
            prDraft = JSON.parse(JSON.stringify(first));
            prOrig = JSON.parse(JSON.stringify(first));
            renderPresetManager();
            toast('success', '已导入并激活', first.name);
            if (miss.length) {
              toast('info', '此预设未包含采样参数', miss.join('、') + ' 已使用内置默认值（最大回复 4096）——如需与酒馆滑杆一致，打开预设管理器「采样」页填写。');
            }
            refreshTavernPage();
          });
        });
      });
    });

    var ex = $1('[data-act="pre-export"]', body);
    if (ex) ex.addEventListener('click', function () {
      if (!prDraft) return;
      download(ST.exportPreset(prDraft), (prDraft.name || 'preset') + '.json');
      toast('info', '已导出', '「' + prDraft.name + '」');
    });

    var dl = $1('[data-act="pre-del"]', body);
    if (dl) dl.addEventListener('click', function () {
      if (!prDraft) return;
      var nm = prDraft.name;
      confirmBox('删除预设 "' + nm + '"?').then(function (yes) {
        if (!yes) return;
        ST.deletePreset(prDraft.id).then(function () {
          prDraft = null; prOrig = null;
          renderPresetManager();
          toast('success', '已删除', '「' + nm + '」');
      refreshTavernPage();
        });
      });
    });

    var ac = $1('[data-act="pre-activate"]', body);
    if (ac) ac.addEventListener('click', function () {
      if (!prDraft) return;
      ST.saveSettings({ activePresetId: prDraft.id }).then(function () {
        toast('success', '已激活', '「' + prDraft.name + '」');
      refreshTavernPage();
        if (window.TAVERN) window.TAVERN.renderTavern();
      });
    });

    var pn = $1('[data-act="pre-name"]', body);
    if (pn) pn.addEventListener('input', function () {
      if (!prDraft) return;
      prDraft.name = pn.value;
      refreshPresetHead();
    });

    qa('[data-act="pre-tab"]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        prTab = btn.getAttribute('data-tab');
        qa('[data-act="pre-tab"]', body).forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        renderPresetPane();
        bindPresetPane();
      });
    });
  }

  function refreshPresetHead() {
    var dirty = isDirtyPreset();
    var saveBtn = $1('#st-pre-save');
    if (saveBtn) { saveBtn.disabled = !dirty; saveBtn.textContent = dirty ? '保存' : '已保存'; }
    var sub = $1('#st-pre-sub');
    if (sub && prDraft) {
      sub.textContent = '共 ' + ST.getPresets().length + ' 个 · 当前：' + prDraft.name +
        (dirty ? ' · 有未保存修改' : '');
    }
  }

  function patchSettings(p) {
    if (!prDraft) return;
    prDraft.settings = Object.assign({}, prDraft.settings, p);
    refreshPresetHead();
  }

  function bindPresetPane() {
    var pane = $1('#st-pre-pane');
    if (!pane || !prDraft) return;
    var S = prDraft.settings;

    qa('[data-pnum]', pane).forEach(function (el) {
      el.addEventListener('input', function () {
        var key = el.getAttribute('data-pnum');
        var lim = {
          temp_openai: [0, 2, 0.8], top_p_openai: [0, 1, 0.9], top_k_openai: [0, 500, 0],
          top_a_openai: [0, 1, 0], min_p_openai: [0, 1, 0], freq_pen_openai: [-2, 2, 0],
          pres_pen_openai: [-2, 2, 0], repetition_penalty_openai: [0, 2, 1],
          openai_max_context: [256, 2000000, 4096], openai_max_tokens: [32, 32768, 4096]
        }[key];
        /* 清空 = 删除该键：回到「导入文件没写」的状态，运行时走引擎兜底，
           不把兜底值伪造进预设 */
        if (!String(el.value).trim()) { delete S[key]; refreshPresetHead(); return; }
        S[key] = lim ? C.clampNumber(el.value, lim[0], lim[1], lim[2]) : Number(el.value);
        refreshPresetHead();
      });
    });
    qa('[data-pstr]', pane).forEach(function (el) {
      el.addEventListener('input', function () {
        S[el.getAttribute('data-pstr')] = el.value;
        refreshPresetHead();
      });
    });
    qa('[data-pchk]', pane).forEach(function (el) {
      el.addEventListener('change', function () {
        S[el.getAttribute('data-pchk')] = !!el.checked;
        refreshPresetHead();
      });
    });

    /* ---------- 模块面板 ---------- */
    function rerenderModules() {
      refreshPresetHead();
      renderPresetPane();
      bindPresetPane();
    }

    /* 新建自定义块 */
    var addBtn = $1('[data-act="pre-add-prompt"]', pane);
    if (addBtn) addBtn.addEventListener('click', function () {
      var current = Array.isArray(S.prompts) ? S.prompts : [];
      var id = promptBox('新自定义块的 identifier (英文/下划线)', 'custom_' + (current.length + 1));
      if (!id) return;
      if (current.some(function (p) { return p.identifier === id; }) || C.MODULE_BY_ID[id]) {
        toast('warn', 'identifier 已存在', id);
        return;
      }
      S.prompts = current.concat([{ identifier: id, name: id, role: 'system', content: '' }]);
      S.prompt_order = (S.prompt_order || []).concat(
        [{ identifier: id, name: id, role: 'system', enabled: true }]);
      openModules[id] = true;          /* 新建即展开，省一步 */
      rerenderModules();
    });

    /* 启用/停用（复选框走 change） */
    qa('.po-toggle[data-act="mod-enable"]', pane).forEach(function (cb) {
      cb.addEventListener('change', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        setModuleEnabled(S, cb.getAttribute('data-mid'), !!cb.checked);
        rerenderModules();
      });
    });

    /* 行头与行内按钮走委托 click */
    var modBox = $1('#st-modules', pane);
    if (modBox) {
      modBox.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute) return;
        /* 复选框由 change 处理；它的 click 必须让开，否则会抢先把模块强制启用 */
        if (t.type === 'checkbox') return;

        var act = t.getAttribute('data-act');
        if (act === 'mod-up' || act === 'mod-down' || act === 'mod-del') {
          if (ev.stopPropagation) ev.stopPropagation();
          var id = t.getAttribute('data-mid');
          var item = moduleRows(S).filter(function (o) { return o.identifier === id; })[0];
          if (act === 'mod-del') {
            confirmBox('删除自定义块「' + id + '」？其内容会一并移除。').then(function (yes) {
              if (!yes) return;
              deleteCustomModule(S, id);
              delete openModules[id];
              rerenderModules();
            });
            return;
          }
          if (!item) return;
          moveModule(S, item.idx, act === 'mod-up' ? -1 : 1);
          rerenderModules();
          return;
        }

        /* 其余落点（行头本身或其内部子节点）→ 展开 / 折叠 */
        var head = t.closest ? t.closest('[data-act="mod-toggle-open"]') : null;
        if (head) {
          if (ev.stopPropagation) ev.stopPropagation();
          var hid = head.getAttribute('data-mid');
          openModules[hid] = !openModules[hid];
          rerenderModules();
        }
      });
    }

    /* 全部展开 / 全部折叠 / 重置顺序 */
    var expAll = pane.querySelector('[data-act="mod-expand-all"]');
    if (expAll) expAll.addEventListener('click', function () {
      moduleRows(S).forEach(function (o) { openModules[o.identifier] = true; });
      rerenderModules();
    });
    var colAll = pane.querySelector('[data-act="mod-collapse-all"]');
    if (colAll) colAll.addEventListener('click', function () {
      openModules = {};
      rerenderModules();
    });
    /* 行内编辑：显示名 / role / 内容 */
    qa('[data-mod][data-mf]', pane).forEach(function (el) {
      var id = el.getAttribute('data-mod');
      var f = el.getAttribute('data-mf');
      var evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, function () {
        var order = S.prompt_order || [];
        if (f === 'name' || f === 'role') {
          var at = -1;
          order.forEach(function (o, i) { if (o && o.identifier === id) at = i; });
          if (at >= 0) {
            var patch = { enabled: order[at].enabled !== false };
            patch[f] = el.value;
            order[at] = Object.assign({}, order[at], patch);
            S.prompt_order = order.slice();
          } else {
            var cu = (S.prompts || []).filter(function (p) { return p && p.identifier === id; })[0];
            if (cu) cu[f] = el.value;
          }
          refreshPresetHead();
          return;
        }
        if (f === 'content') {
          setModuleContent(S, id, el.value);
          var row = el.closest ? el.closest('.po-item') : null;
          var lenEl = row && row.querySelector('.po-len');
          if (lenEl) lenEl.textContent = el.value.length + '字';
          refreshPresetHead();
        }
      });
    });

    var resetOrder = pane.querySelector('[data-act="mod-reset-order"]');
    if (resetOrder) resetOrder.addEventListener('click', function () {
      S.prompt_order = C.DEFAULT_PROMPT_ORDER.map(function (p) {
        return { identifier: p.identifier, name: p.name, role: p.role, enabled: true };
      });
      rerenderModules();
      toast('success', '已重置注入顺序', '标准 10 项启用，其余模块归入停用');
    });
  }

  function savePresetDraft() {
    if (!prDraft) return Promise.resolve(null);
    return ST.savePreset(prDraft).then(function () {
      return ST.saveSettings({ activePresetId: prDraft.id });
    }).then(function () {
      prOrig = JSON.parse(JSON.stringify(prDraft));
      refreshPresetHead();
      toast('success', '已保存并激活', '「' + prDraft.name + '」');
      refreshTavernPage();
      renderPresetManager();
      return prDraft;
    });
  }

  function tryClosePreset() {
    if (!isDirtyPreset()) { closeModal('st-modal-preset'); return; }
    confirmBox('放弃未保存的修改?').then(function (yes) {
      if (yes) closeModal('st-modal-preset');
    });
  }

  /* ============================================================
     6) 对外入口
     ============================================================ */
  function openLorebookManager() {
    ensureModals();
    renderLorebookList();

    var tb = $1('#st-lb-toolbar');
    if (tb && !tb._bound) {
      tb._bound = 1;
      tb.addEventListener('click', function (e) {
        var t = e.target;
        var act = t.getAttribute && t.getAttribute('data-act');
        if (act === 'lb-new') {
          var name = promptBox('新世界书之名：', '新世界书');
          if (!name) return;
          ST.createLorebook(name).then(function (lb) {
            renderLorebookList();
            ST.toggleLorebook(lb.id).then(function () {
              renderLorebookList();
              openLorebookEditor(lb.id);
            });
          });
          return;
        }
        if (act === 'lb-import') {
          pickJson(function (inputs) {
            ST.importMultipleAndSave(inputs).then(function (res) {
              renderLorebookList();
              var msg = '成功 ' + res.successes.length + ' 本';
              if (res.failures.length) msg += ' · 失败 ' + res.failures.length + ' 本（' + res.failures[0].error + '）';
              toast(res.successes.length ? 'success' : 'warn', '导入完成', msg);
            });
          });
          return;
        }
        if (act === 'lb-template') {
          ST.hasCoreTemplate().then(function (exists) {
            if (exists) { toast('info', '内置设定已存在', '「临江核心设定」'); return; }
            return ST.importCoreTemplate().then(function (lb) {
              var ids = (ST.getSettings().activeLorebookIds || []).concat([lb.id]);
              return ST.saveSettings({ activeLorebookIds: ids });
            }).then(function () {
              renderLorebookList();
              toast('success', '已导入内置设定', '「临江核心设定」');
            });
          });
          return;
        }
        if (act === 'lb-backup') {
          window.ST_DB.exportAllData().then(function (dump) {
            download(dump, 'fushicheng-st-backup.json');
            toast('info', '已导出全量备份', '世界书 / 预设 / 设置 / 会话');
          });
          return;
        }
        if (act === 'lb-restore') {
          pickJson(function (inputs) {
            var it = inputs[0];
            if (!it || !it.json) { toast('warn', '还原失败', '不是 JSON'); return; }
            confirmBox('从备份还原会覆盖现有世界书 / 预设 / 设置 / 会话，确定?').then(function (yes) {
              if (!yes) return;
              window.ST_DB.importAllData(it.json)
                .then(function () { return ST.reload(); })
                .then(function () {
                  renderLorebookList();
                  toast('success', '已还原', it.fileName);
                })
                .catch(function (err) { toast('error', '还原失败', String((err && err.message) || err)); });
            });
          });
          return;
        }
      });
    }

    var list = $1('#st-lb-list');
    if (list && !list._bound) {
      list._bound = 1;
      list.addEventListener('change', function (e) {
        var t = e.target;
        if (t.getAttribute && t.getAttribute('data-act') === 'lb-active') {
          ST.toggleLorebook(t.getAttribute('data-id')).then(function () { renderLorebookList(); });
        }
      });
      list.addEventListener('click', function (e) {
        var t = e.target;
        var act = t.getAttribute && t.getAttribute('data-act');
        if (!act) return;
        var id = t.getAttribute('data-id');
        if (act === 'lb-edit') { openLorebookEditor(id); return; }
        if (act === 'lb-rename') {
          var b = ST.getLorebook(id);
          if (!b) return;
          var nn = promptBox('新的书名：', b.name);
          if (!nn) return;
          ST.saveLorebook(ST.renameLorebook(b, nn)).then(function () { renderLorebookList(); });
          return;
        }
        if (act === 'lb-export') {
          var bk = ST.getLorebook(id);
          if (!bk) return;
          download(ST.exportLorebook(bk), (bk.name || 'lorebook') + '.json');
          toast('info', '已导出', '「' + bk.name + '」');
          return;
        }
        if (act === 'lb-del') {
          var book = ST.getLorebook(id);
          if (!book) return;
          confirmBox('确定删除世界书「' + book.name + '」？其下 ' + (book.entries || []).length + ' 条将一并删除。')
            .then(function (yes) {
              if (!yes) return;
              ST.deleteLorebook(id).then(function () {
                renderLorebookList();
                toast('success', '已删除', '「' + book.name + '」');
              });
            });
          return;
        }
      });
    }

    var saveEd = $1('#st-lbe-save');
    if (saveEd && !saveEd._bound) {
      saveEd._bound = 1;
      saveEd.addEventListener('click', function () { saveLorebookEditor(); });
    }
    var closeEd = $1('#st-modal-lorebook-editor [data-act="lbe-close"]');
    if (closeEd && !closeEd._bound) { closeEd._bound = 1; closeEd.addEventListener('click', tryCloseEditor); }
    var bdEd = $1('#st-lbe-backdrop');
    if (bdEd && !bdEd._bound) { bdEd._bound = 1; bdEd.addEventListener('click', tryCloseEditor); }

    var savePr = $1('#st-pre-save');
    if (savePr && !savePr._bound) {
      savePr._bound = 1;
      savePr.addEventListener('click', function () { savePresetDraft(); });
    }
    var closePr = $1('#st-modal-preset [data-act="pre-close"]');
    if (closePr && !closePr._bound) { closePr._bound = 1; closePr.addEventListener('click', tryClosePreset); }
    var bdPr = $1('#st-pre-backdrop');
    if (bdPr && !bdPr._bound) { bdPr._bound = 1; bdPr.addEventListener('click', tryClosePreset); }

    openModal('st-modal-lorebook');
  }

  function openPresetManager() {
    ensureModals();
    prTab = 'sampling';
    prDraft = null;
    prOrig = null;
    renderPresetManager();

    var savePr = $1('#st-pre-save');
    if (savePr && !savePr._bound) {
      savePr._bound = 1;
      savePr.addEventListener('click', function () { savePresetDraft(); });
    }
    var closePr = $1('#st-modal-preset [data-act="pre-close"]');
    if (closePr && !closePr._bound) { closePr._bound = 1; closePr.addEventListener('click', tryClosePreset); }
    var bdPr = $1('#st-pre-backdrop');
    if (bdPr && !bdPr._bound) { bdPr._bound = 1; bdPr.addEventListener('click', tryClosePreset); }

    openModal('st-modal-preset');
  }

  UI.ensureModals = ensureModals;
  UI.openLorebookManager = openLorebookManager;
  UI.openLorebookEditor = openLorebookEditor;
  UI.openPresetManager = openPresetManager;
  UI.renderLorebookList = renderLorebookList;
  UI.renderPresetManager = renderPresetManager;
  UI.entryFormHtml = entryFormHtml;
  UI.bindEntryForm = bindEntryForm;
  UI.renderModulesHtml = renderModulesHtml;
  UI.moduleRows = moduleRows;
  UI.moduleContent = moduleContent;
  UI.setModuleEnabled = setModuleEnabled;
  UI.isDirtyBook = isDirtyBook;
  UI.isDirtyPreset = isDirtyPreset;
  UI.drafts = function () { return { book: edBook, preset: prDraft }; };

  window.ST_UI = UI;
})();

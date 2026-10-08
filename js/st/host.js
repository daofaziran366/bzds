/* ============================================================
   腐化 · ST 宿主兼容层（st-chatu8 文生图插件专用）
   ------------------------------------------------------------
   插件按 SillyTavern 扩展的方式 import 四个宿主模块
   （script.js / extensions.js / st-context.js / world-info.js），
   那四个文件只是薄壳，真正的适配都在这里：
     · chat 数组 ↔ 游戏消息（CHAT_LOG / msg DOM）双向同步
     · eventSource / event_types ↔ 游戏聊天事件
     · extension_settings ↔ IndexedDB
     · toastr ↔ 游戏 notify
   插件加载前必须先载入本文件（window.ST_HOST 就绪）。
   ============================================================ */
(function () {
  'use strict';

  /* 调试窗口：st-chatu8 启动期错误收集（浏览器 console 亦可看） */
  window.__chatuBootErrors = [];
  window.addEventListener('unhandledrejection', function (e) {
    var m = 'rejection: ' + String((e.reason && e.reason.stack) || e.reason || '').slice(0, 400);
    window.__chatuBootErrors.push(m);
    console.error('[ST_HOST] 插件启动异常:', e.reason);
  });
  window.addEventListener('error', function (e) {
    window.__chatuBootErrors.push('error: ' + String((e.error && e.error.stack) || e.message || '').slice(0, 400));
  });

  /* ---------- 扩展设置（localStorage 同步恢复 + 游戏 KV/IDB 双写） ----------
     游戏的 KV_MEM 由 IndexedDB 异步填充，host.js 执行时还是空的；
     插件模块在页面加载后立即读取设置，所以必须用 localStorage 同步恢复。 */
  const EXT_KEY = 'chatu_ext_settings';
  const EXT_LS_KEY = 'chatu_ext_settings_ls';
  let extensionSettings = {};
  try {
    const raw = localStorage.getItem(EXT_LS_KEY);
    if (raw) extensionSettings = JSON.parse(raw) || {};
  } catch (e) { extensionSettings = {}; }
  let extSaveTimer = 0;
  function saveExtensionSettings() {
    if (extSaveTimer) return;
    extSaveTimer = setTimeout(function () {
      extSaveTimer = 0;
      try {
        localStorage.setItem(EXT_LS_KEY, JSON.stringify(extensionSettings));
        if (typeof kvSet === 'function') kvSet(EXT_KEY, extensionSettings);
      } catch (e) { console.error('[ST_HOST] 扩展设置保存失败', e); }
    }, 400);
  }
  /* 一次性迁移：游戏 IDB 启动完成后，把旧数据里缺失的键补回来（不覆盖已有值），
     并刷新插件 UI，保证老用户升级后设置不丢 */
  setTimeout(function () {
    try {
      if (typeof kvGet !== 'function') return;
      const stored = kvGet(EXT_KEY);
      if (!stored || typeof stored !== 'object') return;
      let changed = false;
      Object.keys(stored).forEach(function (extName) {
        const incoming = stored[extName];
        const current = extensionSettings[extName];
        if (current && typeof current === 'object' && incoming && typeof incoming === 'object') {
          Object.keys(incoming).forEach(function (k) {
            if (current[k] === undefined) { current[k] = incoming[k]; changed = true; }
          });
        } else if (current === undefined) {
          extensionSettings[extName] = incoming;
          changed = true;
        }
      });
      if (changed) {
        try { localStorage.setItem(EXT_LS_KEY, JSON.stringify(extensionSettings)); } catch (e) { }
        if (typeof window.loadSilterTavernChatu8Settings === 'function') {
          window.loadSilterTavernChatu8Settings();
        }
      }
    } catch (e) { console.warn('[ST_HOST] 旧设置迁移失败', e); }
  }, 2000);

  /* ---------- 事件系统 ---------- */
  const listeners = [];   // { type, fn, front }
  function emitEvent(type, ...args) {
    listeners.slice().filter(l => l.type === type).forEach(l => {
      try { l.fn(...args); } catch (e) { console.error('[ST_HOST] 事件回调异常', type, e); }
    });
  }

  /* ---------- chat 适配：与游戏消息一一对应 ---------- */
  /* chat[i] = { mes: 正文文本, extra: { images: [] }, swipe_id: 0, name, is_user }
     只映射 narr / user 两种楼层（choice 是游戏 UI 概念，不进 ST 语义）。 */
  const shimChat = [];
  const msgObjByMid = new Map();   // mid → shim 对象（跨同步复用 identity）

  function playableLogs() {
    return (typeof CHAT_LOG !== 'undefined')
      ? CHAT_LOG.filter(m => m && (m.type === 'narr' || m.type === 'user'))
      : [];
  }
  function makeMsgObj(log) {
    const obj = {
      name: log.type === 'user' ? ((G.player && G.player.name) || '你') : '叙事',
      is_user: log.type === 'user',
      swipe_id: 0,
      extra: { images: [] },
      _mid: log.mid
    };
    Object.defineProperty(obj, 'mes', {
      get() { return log.text || ''; },
      set(v) {
        /* 插件把 <image> 标签插进正文 → 写回游戏消息并重渲 DOM */
        log.text = String(v);
        const el = document.querySelector('.msg[data-mid="' + log.mid + '"] .msg-body');
        if (el && typeof proseHtml === 'function') el.innerHTML = proseHtml(log.text);
        if (typeof persistGameSoon === 'function') persistGameSoon();
      }
    });
    Object.defineProperty(obj, 'text', { get() { return log.text || ''; }, set(v) { obj.mes = v; } });
    return obj;
  }
  /* 全量对齐：增删改/读档后调用。返回变动是否发生。 */
  function syncChat() {
    const logs = playableLogs();
    let changed = shimChat.length !== logs.length;
    /* 清掉已消失的 */
    for (let i = shimChat.length - 1; i >= 0; i--) {
      const mid = shimChat[i]._mid;
      if (!logs.some(l => l.mid === mid)) { shimChat.splice(i, 1); changed = true; }
    }
    /* 按 logs 顺序补齐/对位 */
    logs.forEach((log, i) => {
      let obj = msgObjByMid.get(log.mid);
      if (!obj) { obj = makeMsgObj(log); msgObjByMid.set(log.mid, obj); changed = true; }
      if (shimChat[i] !== obj) { shimChat[i] = obj; changed = true; }
      /* 回填 ST 兼容的楼层定位属性：
         插件按 div.mes[mesid=N] 找楼层容器、按 .mes_text[data-mesid] 找正文区，
         游戏楼层是 .msg[data-mid]，这里补齐两套属性（插件 CSS 无裸 .mes 规则，加类安全） */
      const msgEl = document.querySelector('.msg[data-mid="' + log.mid + '"]');
      if (msgEl) {
        if (!msgEl.classList.contains('mes')) msgEl.classList.add('mes');
        if (msgEl.getAttribute('mesid') !== String(i)) msgEl.setAttribute('mesid', String(i));
        const mesText = msgEl.querySelector('.mes_text');
        if (mesText && mesText.getAttribute('data-mesid') !== String(i)) mesText.setAttribute('data-mesid', String(i));
      }
      const body = document.querySelector('.msg[data-mid="' + log.mid + '"] .mes-bodywrap');
      if (body && body.getAttribute('mesid') !== String(i)) body.setAttribute('mesid', String(i));
    });
    while (shimChat.length > logs.length) shimChat.pop();
    return changed;
  }
  function indexByMid(mid) { return shimChat.findIndex(o => o._mid === mid); }

  /* ---------- chatMetadata（插件图片兜底存储） ---------- */
  const shimMetadata = { variables: {} };

  /* ---------- getContext ---------- */
  function getContext() {
    return {
      chat: shimChat,
      chatMetadata: shimMetadata,
      extensionSettings,
      saveSettingsDebounced: function () { saveExtensionSettings(); },
      characters: [],
      characterId: null,
      loadWorldInfo: async function () { return null; },
      saveChatConditional: function () { if (typeof persistGame === 'function') persistGame(); return Promise.resolve(); },
      chatLength: shimChat.length
    };
  }

  /* ---------- 消息格式化（插件的图片预览等场景用） ---------- */
  function formatMessage(mes) {
    return String(mes == null ? '' : mes)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  /* ---------- 持久化 ---------- */
  function persistChat() {
    if (typeof persistGame === 'function') persistGame();
  }

  function saveChat() {
    if (typeof persistGame === 'function') persistGame();
  }

  /* ---------- 供游戏侧触发的事件名 ---------- */
  const EVENT = {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    CHAT_CHANGED: 'CHAT_CHANGED',
    GENERATION_STARTED: 'GENERATION_STARTED',
    GENERATION_ENDED: 'GENERATION_ENDED',
    GENERATION_STOPPED: 'GENERATION_STOPPED',
    STREAM_TOKEN_RECEIVED: 'STREAM_TOKEN_RECEIVED',
    WORLDINFO_ENTRIES_LOADED: 'WORLDINFO_ENTRIES_LOADED',
    APP_READY: 'APP_READY',
    SETTINGS_UPDATED: 'SETTINGS_UPDATED',
    SETTINGS_UPDATED_AFTER: 'SETTINGS_UPDATED_AFTER'
  };

  /* 游戏侧入口：消息入队后调用（js/app.js pushMsg） */
  function onGameMessage(type, mid) {
    syncChat();
    const i = indexByMid(mid);
    if (i < 0) return;
    if (type === 'user') emitEvent(EVENT.USER_MESSAGE_RENDERED, i);
    else {
      emitEvent(EVENT.MESSAGE_RECEIVED, i);
      emitEvent(EVENT.CHARACTER_MESSAGE_RENDERED, i);
    }
    /* 插件在 GENERATION_ENDED 后才扫描楼层注入「生成图片」按钮；
       游戏叙事没有这个概念，消息落地即视为本轮生成结束 */
    emitEvent(EVENT.GENERATION_ENDED, undefined);
  }
  /* 读档 / 新开档：整段聊天重建完成 */
  function onChatRestored() {
    msgObjByMid.clear();
    shimChat.length = 0;
    syncChat();
    emitEvent(EVENT.CHAT_CHANGED, 'restore');
  }
  function onMessageEdited(mid) {
    syncChat();
    const i = indexByMid(mid);
    if (i >= 0) emitEvent(EVENT.MESSAGE_EDITED, i);
  }

  /* ---------- toastr（插件提示 → 游戏 notify） ---------- */
  function toastBy(kind) {
    return function (msg, title, opts) {
      const text = typeof msg === 'string' ? msg : ((msg && msg.html) || String(msg || ''));
      if (typeof notify === 'function') {
        notify(kind === 'warning' ? 'warn' : kind === 'error' ? 'error' : kind === 'info' ? 'info' : 'success',
          title || '智绘姬', text);
      } else {
        console.log('[chatu8][' + kind + ']', title || '', text);
      }
      return true;
    };
  }
  window.toastr = {
    info: toastBy('info'),
    success: toastBy('success'),
    warning: toastBy('warning'),
    error: toastBy('error'),
    clear: function () {}
  };

  /* ---------- 暴露给 shim 模块 ---------- */
  window.ST_HOST = {
    extensionSettings,
    saveExtensionSettings,
    chat: shimChat,
    syncChat,
    getContext,
    formatMessage,
    persistChat,
    saveChat,
    EVENT,
    emit: emitEvent,
    on: function (type, fn, front) {
      const l = { type, fn, front: !!front };
      if (front) listeners.unshift(l); else listeners.push(l);
      return l;
    },
    off: function (l) {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    onGameMessage,
    onChatRestored,
    onMessageEdited
  };

  console.log('[ST_HOST] 宿主兼容层就绪');
})();

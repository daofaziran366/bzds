/* ============================================================
   腐化 · 应用层 v3（纯前端 · 本地叙事引擎模拟 LLM）
   ============================================================ */
'use strict';

/* ---------- 工具 ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const pad2 = n => String(n).padStart(2, '0');
const fmtMoney = n => '¥' + n.toLocaleString('zh-CN');
const ic = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#${name}"/></svg>`;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = h => String(h == null ? '' : h)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* 正文排版：模型文本一律转义后按空行分段。
   两件事都在这里解决：
     · 不转义时，正文里的 `<`（如「<b>」或数学符号）会被浏览器当标签吞掉，
       后面的文字整段消失 —— 表现为「显示成一坨 / 缺字」
     · 不 pre-wrap、不分段时，模型返回的换行被 HTML 折叠成一个长句 */
/* 本地兜底概括：取首句（或前 42 字），供历史压缩用。
   LLM 正常输出 <sum> 时用不到它；离线引擎 / 漏写 / 旧存档时顶上。 */
function localSummary(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^([^。！？!?；;]{4,60})[。！？!?；;]/.exec(t);
  if (m) return m[1].trim();
  return t.length > 42 ? t.slice(0, 42) + '…' : t;
}

function proseHtml(text) {
  const paras = String(text == null ? '' : text).replace(/\r/g, '').split(/\n{2,}/);
  const kept = paras.map(p => p.trim()).filter(Boolean);
  if (!kept.length) return '';
  return kept.map(p => '<p class="prose-p">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
}

/* ---------- 玩家档案（创建角色产出） ---------- */
/* ---------- IndexedDB 内存镜像：读走镜像，写穿 IndexedDB ----------
   IDB 是异步的，而渲染函数全是同步的——所以启动时装载全部键值对进
   KV_MEM，运行期读写都走内存，写入时异步直写 IDB。 */
const KV_MEM = {};
function kvGet(k) { return KV_MEM[k] !== undefined ? KV_MEM[k] : null; }
function kvSet(k, v) { KV_MEM[k] = v; if (window.IDB) IDB.set(k, v).catch(function () {}); }

function loadPlayer() { return kvGet('player'); }
function savePlayer(p) { kvSet('player', p); }

/* ---------- 全局状态 ---------- */
const BASE_ORG_CORR = {};
ORGS.forEach(o => { BASE_ORG_CORR[o.id] = o.corr; });

const G = {
  view: 'home',
  focusId: 'suwanqing',
  orgSel: null,
  trainId: null,
  tgtFilter: 'all',
  tgtPage: 1,
  tgtOpen: false,
  tgtQuery: '',
  trainedUtopia: false,
  maleDullHours: 0,
  bought: new Set(),
  upgrades: new Set(),
  potions: { single: POTIONS.single.count, gas: POTIONS.gas.count, male: POTIONS.male.count, oath: POTIONS.oath.count },
  methodPct: TRAIN_METHODS.map(m => ({ id: m.id, pct: m.pct })),
  schedule: SCHEDULE.map(s => ({ ...s })),
  targets: TARGETS.map(t => ({ ...t })),
  orgs: ORGS.map(o => ({ ...o })),
  settings: { fx: true, sandbox: false, ritual: true, dmColor: 'gold', dmSpeed: 'normal' },
  player: loadPlayer() || { name: '', gender: '保密', persona: '' }
};

/* 启动完成标志：在「已恢复自动存档」或「确无存档」之前为 false，
   防止启动过程中的渲染把出厂默认值覆盖掉已存的快照。 */
let gameReady = false;

const tgtById = id => G.targets.find(t => t.id === id);
const orgById = id => G.orgs.find(o => o.id === id);
const orgOfTgt = t => G.orgs.find(o => o.id === t.org);
const perfById = id => G.performers.find(p => p.id === id);
const LV_NAME = n => LV[n].name;
G.performers = PERFORMERS.map(p => ({ ...p }));
G.trainId = (G.targets.find(t => t.lv === 4) || {}).id || null;

/* ---------- 通知（应用内） ---------- */
function notify(type, title, msg) {
  const icons = { success: 'i-check', info: 'i-info', warn: 'i-alert', error: 'i-alert', corrupt: 'i-spark' };
  const el = document.createElement('div');
  el.className = 'toast t-' + type;
  el.innerHTML = `
    <div class="toast-ic">${ic(icons[type] || 'i-info')}</div>
    <div class="toast-body"><div class="toast-title">${title}</div><div class="toast-msg">${msg}</div></div>
    <time class="toast-time">${pad2(CITY.time.hour)}:${pad2(CITY.time.minute)}</time>`;
  $('#toast-stack').appendChild(el);
  const life = 4200;
  setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 340); }, life);
}

/* ---------- 模态框 ---------- */
function openModal(id) { const m = $('#' + id); if (m) m.hidden = false; }
function closeModal(id) { const m = $('#' + id); if (m) m.hidden = true; }
function bindModals() {
  $$('.modal [data-close]').forEach(el => el.addEventListener('click', () => closeModal(el.dataset.close)));
}
let confirmOk = null;
function confirmDialog({ title, body, okText = '确认', danger = true, onOk }) {
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#btn-confirm-ok').textContent = okText;
  $('#confirm-icon').innerHTML = ic(danger ? 'i-alert' : 'i-info');
  confirmOk = onOk || null;
  openModal('modal-confirm');
}
let eventChoices = null;
function eventDialog({ title, body, choices }) {
  $('#event-title').textContent = title;
  $('#event-body').textContent = body;
  eventChoices = choices;
  const box = $('#event-actions');
  box.innerHTML = choices.map((c, i) => `<button class="btn ${i === choices.length - 1 ? 'btn-ghost' : 'btn-primary'}" data-ev="${i}">${c.label}</button>`).join('');
  box.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', () => {
    const c = eventChoices[+b.dataset.ev];
    closeModal('modal-event');
    if (c.onClick) c.onClick();
  }));
  openModal('modal-event');
}

/* ---------- 页签路由 ---------- */
function switchView(view) {
  G.view = view;
  if (view !== 'targets') G.tgtOpen = false;
  if (typeof persistUi === 'function') persistUi();
  if (view === 'tavern' && window.TAVERN) TAVERN.renderTavern();
  if (view === 'memory' && window.TAVERN) TAVERN.renderMemory();
  $$('.dock-btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach(v => {
    const active = v.dataset.view === view;
    v.hidden = !active;
    v.classList.toggle('is-active', active);
  });
  if (view === 'map') renderMap();
  if (view === 'targets') renderTargets();
  if (view === 'orgs') renderOrgs();
  if (view === 'campaign') renderCampaign();
  if (view === 'sanctum') renderSanctum();
  if (view === 'bag') renderBackpack();
  if (view === 'utopia') { renderStage(); renderPerformers(); renderBusiness(); renderMarket(); }
}

/* ---------- HUD ---------- */
function renderHud() { persistOnRender();
  $('#hud-date').textContent = CITY.time.date + ' · ' + CITY.time.weekday;
  $('#hud-time').textContent = pad2(CITY.time.hour) + ':' + pad2(CITY.time.minute);
  $('#hud-weather').innerHTML = ic(CITY.time.weatherIc) + `<span>${CITY.time.weather}</span>`;
  $('#res-money-val').textContent = fmtMoney(RES.money);
  $('#res-potion-single-val').textContent = G.potions.single;
  $('#res-potion-gas-val').textContent = G.potions.gas;
  $('#res-potion-male-val').textContent = G.potions.male;
  $('#badge-targets').textContent = G.targets.length;
  $('#badge-orgs').textContent = G.orgs.filter(o => o.status === 'control').length;
  $('#chat-loc-text').textContent = CITY.playerLoc;
  /* 世界状态自动落盘：renderHud 是几乎全部状态变更的公共出口
     （advanceTime / gainXp / usePotionOn / renderForKinds… 都会走到这），
     在这里节流写一次快照，刷新页面就不丢。
     gameReady 之前不写：避免启动过程中把出厂默认值覆盖掉已存的快照。 */
  if (gameReady && typeof persistGameSoon === 'function') persistGameSoon();
}

/* 地点切换大字动画 */
function locSplash(name, sub) {
  const el = $('#loc-splash');
  if (!el) return;
  $('#loc-splash-name').textContent = name;
  $('#loc-splash-sub').textContent = sub || '';
  el.hidden = false;
  clearTimeout(locSplash._t);
  locSplash._t = setTimeout(() => { el.hidden = true; }, 2400);
}

function bandOfHour(h) { return h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'daytime' : h < 23 ? 'evening' : 'night'; }

function advanceTime(hours) {
  const prevBand = bandOfHour(CITY.time.hour);
  CITY.time.hour += hours;
  let newDay = false;
  const WEEKS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  while (CITY.time.hour >= 24) {
    CITY.time.hour -= 24;
    /* 日期通用进位（大小月简化为每月 30 日）+ 星期自动推进 */
    const md = /^(\d{1,2})月(\d{1,2})日$/.exec(CITY.time.date);
    if (md) {
      let mo = +md[1], d = +md[2] + 1;
      if (d > 30) { d = 1; mo = mo % 12 + 1; }
      CITY.time.date = `${mo}月${d}日`;
    }
    const wi = WEEKS.indexOf(CITY.time.weekday);
    CITY.time.weekday = WEEKS[(wi + 1) % WEEKS.length];
    newDay = true;
  }
  CITY.time.minute = randInt(0, 11) * 5;
  evolveWorld(hours, newDay);
  const band = bandOfHour(CITY.time.hour);
  if (band !== prevBand) {
    const B = WORLD_BANDS[band];
    notify('info', B.label, B.toast);
  }
  if (hours >= 4 && G.maleDullHours > 0) {
    G.maleDullHours = Math.max(0, G.maleDullHours - hours);
    if (G.maleDullHours === 0) notify('info', '药力消散', '男性药剂的效力已经退去。');
  }
  renderHud();
  var savedPlayer = kvGet('player');
  if (savedPlayer && savedPlayer.name) G.player = savedPlayer;
  if (window.TAVERN) { TAVERN._loadAll(); TAVERN.syncStatusChip(); }
  // 开始门：无角色档案时展示开始/创建流程
  if (G.player && G.player.name) {
    personalizeChat();
  } else {
    showGate();
  }
  if (G.view === 'targets') renderTargets();
}

/* ---------- 沙盒世界演化：城市自行呼吸 ---------- */
function evolveWorld(hours, newDay) {
  // 作息：所有目标按时段刷新行为与想法
  const B = WORLD_BANDS[bandOfHour(CITY.time.hour)];
  G.targets.forEach(t => {
    t.behavior = pick(B.behaviors);
    t.thought = pick(B.thoughts);
  });
  // 势力漂移：较长时间跨度下腐化度自然起伏
  if (hours >= 6) {
    G.orgs.forEach(o => {
      o.corr = Math.max(2, Math.min(94, o.corr + randInt(-2, 2)));
      o.status = o.corr >= 60 ? 'control' : o.corr >= 25 ? 'seep' : 'clean';
    });
    recomputeCity();
    if (G.view === 'orgs') renderOrgs();
  }
  // 乌托邦日营收：常驻演出每日自动入账
  if (newDay && G.performers.length) {
    const inc = Math.round(2500 * upgradeMul());
    RES.money += inc;
    notify('success', '乌托邦日营收', `常驻演出昨日入账 ¥${inc.toLocaleString()}。`);
    renderHud();
  }
}

/* ---------- 经验 / 等级 / 组织联动 ---------- */
function gainXp(t, amount, silentChat) {
  if (t.lv >= 5) return;
  t.xp += amount;
  checkLevelUp(t, silentChat);
  renderAllGame();
}
function checkLevelUp(t, silentChat) {
  let leveled = false;
  while (t.lv < 5 && t.xp >= LV_NEED[t.lv]) {
    t.xp -= LV_NEED[t.lv];
    t.lv += 1;
    leveled = true;
  }
  if (leveled) {
    notify('corrupt', '腐化升华', `${t.name} → Lv${t.lv}「${LV_NAME(t.lv)}」`);
    syncOrgFromTarget(t);
  }
}
function syncOrgFromTarget(t) {
  const org = orgById(t.org);
  if (!org) return;
  org.corr = Math.min(96, Math.max(0, (BASE_ORG_CORR[org.id] || 10) + t.lv * 8));
  org.status = org.corr >= 60 ? 'control' : org.corr >= 25 ? 'seep' : 'clean';
  recomputeCity();
}
function recomputeCity() {
  CITY.corruption = Math.round(G.orgs.reduce((a, o) => a + o.corr, 0) / G.orgs.length);
}
function renderAllGame() { persistOnRender();
  renderHud();
  if (G.view === 'targets') renderTargets();
  if (G.view === 'orgs') renderOrgs();
  if (G.view === 'campaign') renderCampaign();
  if (G.view === 'sanctum') renderSanctum();
  if (G.view === 'bag') renderBackpack();
  if (G.view === 'utopia') { renderStage(); }
}

/* ---------- 变量改写后的按类型回刷（<set> 专用） ----------
   renderAllGame 只刷**当前视图**的面板；而变量命令几乎总是发生在
   聊天页——玩家让 LLM 建了个目标，目标栏不刷新就得切页再看。
   这里按变更类型无条件回刷所有受影响面板（面板 DOM 是常驻的，
   刷了不会更贵，切过去就是新的）。

   kinds: VARS 结果里的 kind 去重集合；entities: 受影响的实体 id。 */
const KIND_RENDERERS = {
  money:  ['renderHud', 'renderBackpack', 'renderBusiness'],
  time:   ['renderHud'],
  /* potion 回刷四处：顶部栏药剂 chip（renderHud）、背包、庇护所炼金台
     （持有 ×N）与晋升面板（夜冕之酒 ×N）——药剂数量被 <set> 改写时同步 */
  potion: ['renderHud', 'renderBackpack', 'renderAlchemy', 'renderTraining'],
  target: ['renderTargets', 'renderOrgs', 'renderMap', 'renderHud', 'renderCampaign'],
  item:   ['renderBackpack'],
  stage:  ['renderPerformers', 'renderStage', 'renderMarket'],
  org:    ['renderOrgs', 'renderMap', 'renderCampaign'],
  map:    ['renderMap']
};

/* 新目标必须看得见：被当前筛选/搜索排除就先清掉，再把页码跳到它那一页。
   否则 LLM 建了人、目标栏却停在第 3 页 + 「高腐化」筛选上，
   玩家看到的是「没建成」的假象。 */
function revealTarget(id) {
  if (!id || typeof tgtFiltered !== 'function') return;
  const t = tgtById(id);
  if (!t) return;
  let list = tgtFiltered();
  if (!list.some(x => x.id === id)) {
    G.tgtQuery = '';
    G.tgtFilter = 'all';
    const q = $('#inp-target-search');
    if (q) q.value = '';
    $$('#tgt-filter .seg-btn').forEach(b =>
      b.classList.toggle('is-active', b.dataset.filter === 'all'));
    list = tgtFiltered();
  }
  const idx = list.findIndex(x => x.id === id);
  if (idx >= 0 && typeof TGT_PAGE_SIZE === 'number' && TGT_PAGE_SIZE > 0) {
    G.tgtPage = Math.floor(idx / TGT_PAGE_SIZE) + 1;
  }
}

function renderForKinds(kinds, entities) {
  const set = new Set(kinds || []);
  if (set.has('target') && entities && entities.length) {
    entities.forEach(id => revealTarget(id));
  }
  const called = new Set();
  set.forEach(kind => {
    (KIND_RENDERERS[kind] || []).forEach(name => {
      if (called.has(name)) return;
      called.add(name);
      if (typeof window[name] === 'function') {
        try { window[name](); } catch (e) { console.error('[回刷] ' + name + ' 失败', e); }
      }
    });
  });
  if (!set.size) renderHud();
  /* 势力成文也可能被变量命令改写（<set> 社会组织[警局].腐化规则.初级 = 文本），
     任何 org 类回刷后都顺带同步世界书条目。debounce 合并，避免连写多条时反复落库。 */
  if (set.has('org') && typeof scheduleOrgLorebookSync === 'function') scheduleOrgLorebookSync();
}

/* ---------- 背包（药剂 + 现金 + 变量物品） ---------- */
/* 【变量协议出口】G.items 的区域渲染。vars.js 的 物品[名称].数量/类型
   以前无任何界面出口，改在这里落到背包页底部的「随身物品」区。 */
const ITEM_TONE = { '消耗品': 'tone-cyan', '任务物品': 'tone-gold', '服装': 'tone-violet', '其他': '' };
const ITEM_ICON = { '消耗品': 'i-flask', '任务物品': 'i-key', '服装': 'i-mask', '其他': 'i-gem' };
function itemsHtml() {
  const all = Object.keys(G.items || {});
  if (!all.length) {
    return `<div class="section-title">随身物品</div>
      <p class="rel-empty">${ic('i-gem')}背包里空无一物——剧情中获得的东西会出现在这里。</p>`;
  }
  return `<div class="section-title">随身物品</div>
    <div class="bag-grid">
      ${all.map((name, i) => {
        const it = G.items[name] || {};
        const type = it.type || '其他';
        const tone = ITEM_TONE[type] || '';
        const icon = ITEM_ICON[type] || 'i-gem';
        return `
        <div class="bag-cell" style="--d:${i * 45}ms" role="img" tabindex="-1">
          <div class="bag-slot ${tone}">${ic(icon)}${it.qty > 0 ? `<span class="cnt">${it.qty}</span>` : ''}</div>
          <b>${esc(name)}</b>
          <span>${type}${it.qty > 0 ? ' · 持有 ' + it.qty : ' · 暂无存货'}</span>
        </div>`;
      }).join('')}
    </div>`;
}
function renderBackpack() { persistOnRender();
  const defs = [
    ...Object.values(POTIONS).map(p => ({ id: p.id, icon: p.icon, tone: p.tone, name: p.name, cnt: G.potions[p.id], act: null })),
    { id: 'money', icon: 'i-coin', tone: '', name: '现金', cnt: null, act: null }
  ];
  $('#pane-bag-view').innerHTML = `
    <p class="view-sub" style="margin:2px 0 16px">你的背包——随身携带的一切。药剂在庇护所的炼金台调配，消耗品可在聊天里让大模型经变量命令使用。</p>
    <div class="bag-grid">
      ${defs.map((s, i) => `
        <div class="bag-cell" style="--d:${i * 45}ms" role="img" tabindex="-1" data-bag="${s.id}">
          <div class="bag-slot ${s.tone ? 'tone-' + s.tone : ''}">${ic(s.icon)}${s.cnt !== null ? `<span class="cnt">${s.cnt}</span>` : `<span class="bag-amt">${fmtMoney(RES.money)}</span>`}</div>
          <b>${s.name}</b>
          <span>${s.cnt !== null ? (s.cnt > 0 ? '持有 ' + s.cnt : '暂无存货') : '调配与交易的通货'}</span>
        </div>`).join('')}
    </div>
    ${itemsHtml()}`;
}

/* ---------- 聊天引擎 ---------- */
function chatScroll() { const s = $('#chat-scroll'); s.scrollTop = s.scrollHeight; }
/* 模型侧对话历史（发给大模型的唯一真相）。DOM 每条消息用 data-mid 与这里
   的一条记录一一对应；删除 / 重发时必须同步，否则模型仍「记得」已删内容。 */
const CHAT_TURNS = [];
/* 可序列化的消息快照（含 choice/system），与 DOM 一一对应，用于存档 / 读档重建聊天区。 */
const CHAT_LOG = [];
const CHAT_AUTOKEY = 'fushicheng_chat_v1';
let msgSeq = 0;
let restoringChat = false;

/* ---------- 酒馆接口上下文桥（TAVERN_CTX） ----------
   向 tavern.js 暴露世界状态与对话历史，用于组装发往大模型的 Prompt。 */
/* ---------- 记忆：分段总结挂载与分层上下文 ---------- */
const SEG_KEY = 'fushicheng_segmented_v1';
function segCfg() {
  var s = (window.ST && ST.getSettings) ? ST.getSettings() : {};
  return {
    enabled: s.segmentedEnabled !== false,
    chatLayers: s.segmentedChatLayers || 6,
    largeStart: s.segmentedLargeStart || 14
  };
}
function mountSegmentedSummary(smallText, largeText) {
  for (var i = CHAT_TURNS.length - 1; i >= 0; i--) {
    if (CHAT_TURNS[i].role === 'assistant') {
      if (smallText) CHAT_TURNS[i].smallSummary = smallText;
      if (largeText) CHAT_TURNS[i].largeSummary = largeText;
      var logEntry = CHAT_LOG.find(function (x) { return x && x.mid === CHAT_TURNS[i].id; });
      if (logEntry) {
        if (smallText) logEntry.smallSummary = smallText;
        if (largeText) logEntry.largeSummary = largeText;
      }
      persistChat();
      return true;
    }
  }
  return false;
}
function manualFillSummary(mid, smallText, largeText) {
  var t = CHAT_TURNS.find(function (x) { return x.id === mid; });
  if (!t) return false;
  if (smallText != null) t.smallSummary = String(smallText).trim();
  if (largeText != null) t.largeSummary = String(largeText).trim();
  persistChat();
  return true;
}
function assistantLogs() { return CHAT_TURNS.filter(function (t) { return t.role === 'assistant'; }); }
/* 分层组装：最新 chatLayers 层全文；较早的倒数 largeStart 层内用小总结，其上用大总结 */
window.APP_SEGMENTED_HISTORY = function () {
  var cfg = segCfg();
  var turns = CHAT_TURNS;
  if (!cfg.enabled) return turns.map(function (t) { return { role: t.role, content: t.content }; });
  var n = turns.length;
  var out = [];
  var chatCut = Math.max(0, n - cfg.chatLayers * 2);   // 一层≈user+ai 两条
  var largeCut = Math.max(0, n - cfg.largeStart * 2);
  turns.forEach(function (t, i) {
    if (i >= chatCut) { out.push({ role: t.role, content: t.content }); return; }
    if (t.role === 'user') { out.push({ role: 'user', content: t.content }); return; }
    var useLarge = i < largeCut;
    var s = useLarge ? (t.largeSummary || t.smallSummary || '') : (t.smallSummary || t.largeSummary || t.sum || '');
    if (!s) s = String(t.content || '').slice(0, 60);
    out.push({ role: 'assistant', content: '〔' + (useLarge ? '大总结' : '小总结') + '〕' + s, compressed: true });
  });
  return out;
};
window.APP_CHAT_TURNS = function () { return CHAT_TURNS; };
window.APP_MANUAL_FILL = manualFillSummary;
window.APP_SEG_ASSISTANTS = assistantLogs;



window.TAVERN_CTX = {
  getContext() {
    const focus = focusTarget ? focusTarget() : null;
    return {
      time: (CITY.time.date || '') + ' ' + (CITY.time.hour != null ? pad2(CITY.time.hour) + ':' + pad2(CITY.time.minute || 0) : ''),
      corruption: CITY.corruption != null ? CITY.corruption : 0,
      loc: CITY.playerLoc || '',
      money: RES && RES.money != null ? RES.money : 0,
      rep: RES && RES.rep != null ? RES.rep : 0,
      focusName: focus ? focus.name : '',
      focus: focus ? (focus.name + (focus.title ? '（' + focus.title + '）' : '') + ' · Lv' + focus.lv + ' ' + (LV_NAME(focus.lv) || '') + ' · 信任 ' + focus.trust + ' · 状态：' + focus.behavior + '；想法：' + focus.thought) : ''
    };
  },
  /* sum 一并交出：内核的历史压缩（酒馆页 x/y）靠它把旧回合压成概括 */
  getHistory() {
    /* 分段记忆：唯一的历史出口（最新X层全文 → 较早小总结 → 更早大总结） */
    if (window.APP_SEGMENTED_HISTORY) return window.APP_SEGMENTED_HISTORY();
    return CHAT_TURNS.map(t => ({ role: t.role, content: t.content }));
  }
};

/* 构建选项楼层的按钮组（pushMsg 与「原始字段」编辑后重建共用）。
   只有 label 没有 action/prompt 的按钮是历史存档里的死选项，置灰。 */
function buildChoiceButtons(el, options) {
  el.innerHTML = options.map((o, i) => {
    const inert = !o.action && !o.prompt;
    return `<button class="choice-btn${inert ? ' is-inert' : ''}" data-choice="${i}"${inert ? ' title="存档中的历史选项"' : ''}>${esc(o.label)}</button>`;
  }).join('');
  el.querySelectorAll('[data-choice]').forEach(b => b.addEventListener('click', () => {
    const opt = options[+b.dataset.choice] || {};
    if (opt.action) opt.action();
    else if (opt.prompt) sendPrompt(opt.prompt);
    b.disabled = true; b.style.opacity = .45;
  }));
}

/* 原始字段重解析后：用新选项更新正文楼层紧随的选项楼层；
   后面没有就新建一条插到正文之后。CHAT_LOG 与 DOM 同步。 */
function rebuildChoiceAfter(el, options) {
  if (!options || !options.length) return;
  let next = el.nextElementSibling;
  while (next && !next.classList.contains('msg-choice')) next = next.nextElementSibling;
  const flat = options.map(o => ({ label: (o && o.label) || '', prompt: (o && o.prompt) || '' }));
  if (next) {
    const d = CHAT_LOG.find(x => x.mid === +next.dataset.mid);
    if (d) d.options = flat;
    buildChoiceButtons(next, options);
  } else {
    const el2 = document.createElement('div');
    el2.dataset.mid = String(++msgSeq);
    el2.className = 'msg msg-choice';
    buildChoiceButtons(el2, options);
    const at = CHAT_LOG.findIndex(x => x.mid === +el.dataset.mid);
    CHAT_LOG.splice(at + 1, 0, { type: 'choice', options: flat, mid: +el2.dataset.mid });
    el.insertAdjacentElement('afterend', el2);
  }
  persistChat();
}

function pushMsg(type, data) {  const log = $('#chat-log');
  const el = document.createElement('div');
  const mid = ++msgSeq;
  el.dataset.mid = String(mid);
  const desc = chatDescriptor(type, data);
  if (desc) { desc.mid = mid; CHAT_LOG.push(desc); }
  if (type === 'user') CHAT_TURNS.push({ id: mid, role: 'user', content: data.text });
  /* sum：本条正文的一句话概括，历史压缩时比 x 旧的回合只喂它。
     没给就本地兜底（取首句）——离线玩、旧存档、模型漏写 <sum> 时
     压缩链路仍然是实的，不会退化成「整段丢掉」。 */
  else if (type === 'narr') CHAT_TURNS.push({ id: mid, role: 'assistant',
    content: (data.name ? data.name + '：' : '') + (data.text || ''),
    sum: (data.sum || localSummary(data.text)),
    smallSummary: data.smallSummary || '',
    largeSummary: data.largeSummary || '' });
  if (type === 'narr') {
    el.className = 'msg msg-narr';
    el.dataset.text = data.text || '';
    el.dataset.raw = data.raw || '';
    el.innerHTML = `<span class="msg-tag">${ic('i-quill')}叙述</span>` +
      `<div class="mes-bodywrap" style="display:contents"><div class="msg-body mes_text">${proseHtml(data.text)}</div></div>`;
  } else if (type === 'user') {
    el.className = 'msg msg-user';
    el.dataset.text = data.text;
    el.innerHTML = `<span class="mu-label">指令</span>` +
      `<div class="mes-bodywrap" style="display:contents"><div class="msg-body mes_text">${proseHtml(data.text)}</div></div>`;
  } else if (type === 'choice') {
    el.className = 'msg msg-choice';
    buildChoiceButtons(el, data.options);
  }
  log.appendChild(el);
  attachMsgActions(el);
  chatScroll();
  /* st-chatu8 宿主桥：同步 chat 数组并派发渲染事件（mesid 由桥回填） */
  if (window.ST_HOST && (type === 'narr' || type === 'user')) {
    ST_HOST.onGameMessage(type, mid);
  }
  if (!restoringChat) {
    persistChat();
    /* 每生成一段新叙述后打一条世界状态快照（可退档） */
    if (type === 'narr') makeSnapshot();
  }
}

/* 把一条消息压成可 JSON 序列化的快照（choice 的 action 函数无法序列化，只留 label/prompt） */
function chatDescriptor(type, data) {
  if (!data) return null;
  if (type === 'user' || type === 'narr') return { type: type, text: data.text || '', raw: data.raw || '', sum: data.sum || '', smallSummary: data.smallSummary || '', largeSummary: data.largeSummary || '' };
  if (type === 'choice') return { type: type, options: (data.options || []).map(o => ({ label: (o && o.label) || '', prompt: (o && o.prompt) || '' })) };
  return null;
}

/* st-chatu8 扩展需要的工具函数 */
function reloadCurrentChat() {
  const persisted = loadPersistedChat();
  if (persisted && persisted.length) {
    restoreChat(persisted);
  }
}
/* 会话快照持久化：刷新页面也能保留聊天记录（聊天也随自动存档/存档槽落盘） */
function loadPersistedChat() { return kvGet('chat'); }
function persistChat() {
  kvSet('chat', CHAT_LOG.slice(-200));
}
/* 轻量 UI 状态持久化：视图 / 是否在详情页 / 焦点角色。
   与存档槽无关，每次视图切换或开详情时写一次，刷新页面后能回到原处。
   聊天记录已有 CHAT_* 持久化，这里只管「看哪一页」。 */
function persistUi() {
  kvSet('ui', {
    view: G.view, tgtOpen: !!G.tgtOpen, focusId: G.focusId,
    orgSel: G.orgSel, trainId: G.trainId,
    orgPage: G.orgPage, perfPage: G.perfPage, mktPage: G.mktPage
  });
}
function loadPersistedUi() { return kvGet('ui'); }
function restoreUi(state) {
  if (!state) return;
  if (state.view) G.view = state.view;
  if (state.focusId) G.focusId = state.focusId;
  if (state.orgSel) G.orgSel = state.orgSel;
  if (state.trainId) G.trainId = state.trainId;
  if (state.orgPage != null) G.orgPage = state.orgPage;
  if (state.perfPage != null) G.perfPage = state.perfPage;
  if (state.mktPage != null) G.mktPage = state.mktPage;
  G.tgtOpen = !!state.tgtOpen;
  if (G.view !== 'targets') G.tgtOpen = false;
}
/* 用快照重建聊天区，并同步 CHAT_TURNS / CHAT_LOG / msgSeq（读档与刷新共用） */
function restoreChat(list) {
  const box = $('#chat-log');
  if (!box) return;
  restoringChat = true;
  box.innerHTML = '';
  CHAT_TURNS.length = 0;
  CHAT_LOG.length = 0;
  msgSeq = 0;
  (list || []).forEach(d => {
    if (!d || !d.type) return;
    if (d.type === 'choice') pushMsg('choice', { options: (d.options || []).map(o => ({ label: o.label, prompt: o.prompt || undefined })) });
    else pushMsg(d.type, d);
  });
  restoringChat = false;
  persistChat();
  if (window.ST_HOST) ST_HOST.onChatRestored();
}

function attachMsgActions(el) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const mk = (icon, title, fn) => {
    const b = document.createElement('button');
    b.title = title; b.innerHTML = ic(icon);
    b.onclick = e => { e.stopPropagation(); fn(); };
    bar.appendChild(b);
  };
  mk('i-x', '删除此消息', () => { dropTurn(el); el.remove(); persistChat(); });

  const isUser = el.classList.contains('msg-user');
  const isGen = el.classList.contains('msg-narr');

  if (isUser) {
    mk('i-quill', '编辑并重发', () => beginEditMsg(el, { resend: true }));
    mk('i-refresh', '重新生成此回复', () => {
      const text = text_of(el);
      dropTurn(el);
      removeAllAfter(el);
      el.remove();
      sendPrompt(text);
    });
  } else if (isGen) {
    /* 生成的文本也能改：改完只更新这条与模型历史，不重发
       —— 玩家常常是想修掉模型的一句错话，而不是要一整轮新推演 */
    mk('i-quill', '编辑这段文本', () => beginEditMsg(el, { resend: false }));
    const prev = el.previousElementSibling;
    if (prev && prev.classList.contains('msg-user')) {
      mk('i-refresh', '重新生成回复', () => {
        const text = prev.dataset.text || '';
        dropTurn(prev);
        removeAllAfter(prev);
        prev.remove();
        sendPrompt(text);
      });
    }
  }
  el.appendChild(bar);
}

/* 就地编辑一条消息。resend=true（玩家指令）：保存后丢掉其后的一切并重发；
   resend=false（生成文本）：只改本文与模型历史，后续对话保持不动。
   生成文本带原始输出（dataset.raw）时给两个页签：
   「净化正文」= 玩家看到的版本；「原始字段」= 模型本回合的完整输出
   （含 <options>/<memo>/<set> 等），可查看可改，保存时整体重新解析——
   正文/选项/摘要归位，<set> 不再执行（生成时已生效，重执行会二次扣款）。 */
function beginEditMsg(el, opts) {
  if (el.dataset.editing) return;
  el.dataset.editing = '1';
  const isUser = el.classList.contains('msg-user');
  const raw = el.dataset.raw || '';
  const body = el.querySelector('.msg-body');
  if (!body) { delete el.dataset.editing; return; }

  const wasHtml = body.innerHTML;
  const hasRaw = !isUser && raw;
  body.innerHTML = (hasRaw
    ? '<div class="ed-tabs">' +
      '<button class="ed-tab is-active" data-t="clean">净化正文</button>' +
      '<button class="ed-tab" data-t="raw">原始字段</button></div>' +
      '<p class="ed-hint" hidden>模型本回合的完整原始输出。保存时整体重新解析：' +
      '正文与选项按标签归位；&lt;set&gt; 变量命令不再执行（生成时已生效）。</p>'
    : '') +
    '<textarea class="chat-input msg-editor" rows="4"></textarea>' +
    '<div class="dialog-actions" style="margin-top:6px">' +
    '<button class="btn btn-ghost" data-x="c">取消</button>' +
    '<button class="btn btn-primary" data-x="s">' +
    (isUser ? '保存并重发' : '保存') + '</button></div>';
  const ta = body.querySelector('textarea');
  let mode = 'clean';
  ta.value = text_of(el);
  ta.focus();
  if (ta.setSelectionRange) ta.setSelectionRange(ta.value.length, ta.value.length);

  const hint = body.querySelector('.ed-hint');
  const tabBtns = body.querySelectorAll('.ed-tab');
  tabBtns.forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.t;
    tabBtns.forEach(x => x.classList.toggle('is-active', x === b));
    ta.value = mode === 'raw' ? raw : text_of(el);
    if (hint) hint.hidden = mode !== 'raw';
    ta.focus();
  }));

  const restore = () => {
    body.innerHTML = wasHtml;
    delete el.dataset.editing;
  };
  body.querySelector('[data-x="c"]').onclick = restore;
  body.querySelector('[data-x="s"]').onclick = () => {
    const v = ta.value.trim();
    if (!v) return;
    if (isUser) {
      restore();
      dropTurn(el);
      removeAllAfter(el);
      el.remove();
      sendPrompt(v);
      return;
    }
    if (mode === 'raw' && v !== raw && window.TAVERN && typeof TAVERN.parseRaw === 'function') {
      restore();
      applyRawEdit(el, v);
      return;
    }
    /* 净化正文路径：改写 DOM + CHAT_TURNS + CHAT_LOG，三者必须同步，
       否则模型下一轮仍「记得」旧版本 */
    el.dataset.text = v;
    const t = turnOf(el);
    if (t) t.content = v;
    const mid = +el.dataset.mid;
    const d = CHAT_LOG.find(x => x.mid === mid);
    if (d) d.text = v;
    body.innerHTML = proseHtml(v);
    delete el.dataset.editing;
    persistChat();
    if (window.ST_HOST) ST_HOST.onMessageEdited(mid);
  };
}

/* 「原始字段」保存：整段重新走净化链（TAVERN.parseRaw），只解析不执行
   <set>。正文/摘要写回本楼层与历史；新选项更新（或新建）紧随的选项楼层。 */
function applyRawEdit(el, v) {
  const rep = TAVERN.parseRaw(v);
  const mid = +el.dataset.mid;
  el.dataset.text = rep.main;
  el.dataset.raw = v;
  const body = el.querySelector('.msg-body');
  if (body) body.innerHTML = proseHtml(rep.main);
  const t = turnOf(el);
  if (t) { t.content = rep.main; if (rep.memo) t.sum = rep.memo; }
  const d = CHAT_LOG.find(x => x.mid === mid);
  if (d) { d.text = rep.main; d.raw = v; if (rep.memo) d.sum = rep.memo; }
  rebuildChoiceAfter(el, rep.options);
  persistChat();
  if (window.ST_HOST) ST_HOST.onMessageEdited(mid);
}
function text_of(el) { return el.dataset ? (el.dataset.text || '') : ''; }
/* DOM ↔ 模型历史 同步：data-mid 对应 CHAT_TURNS 里的一条记录 */
function turnOf(el) {
  const mid = el && el.dataset ? +el.dataset.mid : NaN;
  if (!mid) return null;
  return CHAT_TURNS.find(t => t.id === mid) || null;
}
function dropTurn(el) {
  const mid = el && el.dataset ? +el.dataset.mid : NaN;
  if (!mid) return;
  const t = CHAT_TURNS.find(x => x.id === mid);
  if (t) { const i = CHAT_TURNS.indexOf(t); if (i >= 0) CHAT_TURNS.splice(i, 1); }
  const d = CHAT_LOG.findIndex(x => x.mid === mid);
  if (d >= 0) CHAT_LOG.splice(d, 1);
  persistChat();
}
function rebuildUserMsg(el, text) {
  el.dataset.text = text;
  const t = turnOf(el);
  if (t) t.content = text;
  const mid = el && el.dataset ? +el.dataset.mid : NaN;
  const d = CHAT_LOG.find(x => x.mid === mid);
  if (d) d.text = text;
  el.innerHTML = '<span class="mu-label">指令</span><div class="msg-body">' + proseHtml(text) + '</div>';
  persistChat();
}
function removeAllAfter(el) {
  let n = el.nextElementSibling;
  while (n) { const nx = n.nextElementSibling; dropTurn(n); n.remove(); n = nx; }
}

/* ---------- 生成中：中止控制 ----------
   PENDING.abort  = AbortController（酒馆路径）
   PENDING.timer  = 本地引擎的假延时（也能被中止）
   PENDING.liveEl = 正在逐字上屏的流式气泡（中止后转成正式消息保留） */
const PENDING = { abort: null, timer: null, liveEl: null, text: '' };

function setBusy(busy) {
  $('#chat-status').classList.toggle('is-busy', busy);
  $('#chat-status-text').textContent = busy ? '推演中' : '就绪';
  $('#chat-typing').hidden = !busy;
  /* 发送键在生成期间变成「旋转的中止键」——用户要能随时掐掉 */
  const btn = $('#btn-chat-send');
  if (!btn) return;
  if (busy) {
    btn.classList.add('is-abort');
    btn.title = '点击中止生成';
    btn.setAttribute('aria-label', '中止生成');
    btn.innerHTML = '<span class="spin-ring" aria-hidden="true"></span>' + ic('i-x');
  } else {
    btn.classList.remove('is-abort');
    btn.title = '发送指令';
    btn.setAttribute('aria-label', '发送指令');
    btn.innerHTML = ic('i-send');
  }
}

/* 发送键的唯一判定：生成中 → 中止；空闲 → 发送。
   抽成具名函数，好让回归测试能直接打到这条决策上
   （bindEvents 只在 DOMContentLoaded 里跑，测试环境不触发它）。 */
function onSendButton() {
  if (PENDING.abort || PENDING.timer) { abortPending(); return; }
  sendPrompt($('#chat-input').value);
}

/** 中止当前生成。已流出的正文保留为可编辑消息，不浪费用户读到的部分。 */
function abortPending() {
  /* 本地引擎路径只有一个假延时：掐掉后必须自己收尾，
     否则 setBusy(false) 没人调，界面永久卡在「推演中」 */
  if (PENDING.timer) {
    clearTimeout(PENDING.timer);
    clearPending();
    setBusy(false);
    notify('info', '生成已中止', '本地叙事引擎已停。');
    return;
  }
  if (PENDING.abort) { try { PENDING.abort.abort(); } catch (e) {} }
}
function clearPending() {
  PENDING.abort = null; PENDING.timer = null; PENDING.liveEl = null; PENDING.text = '';
}
/* 中止后把半成品气泡转正：保留文本 + 挂上编辑/删除，方便玩家接着改 */
function commitPartialLive() {
  const live = PENDING.liveEl;
  const partial = String(PENDING.text || '').trim();
  if (live) live.remove();
  if (partial) {
    pushMsg('narr', { text: partial });
    notify('info', '生成已中止', '已保留中止前的正文，可继续编辑。');
  } else {
    notify('info', '生成已中止', '尚未产出正文。');
  }
}

function sendPrompt(raw) {
  const text = (raw || '').trim();
  if (!text) return;
  if (PENDING.abort || PENDING.timer) return;      // 生成中不接受新指令
  pushMsg('user', { text });
  $('#chat-input').value = '';
  autoGrow();
  setBusy(true);
  if (window.TAVERN && TAVERN.ready()) {
    const ctrl = new AbortController();
    PENDING.abort = ctrl;
    /* 内核在 onError 交付后会 rethrow（方便 await 的调用方）。
       本层已经用 onError 兜住一切，这里必须把 rejection 接下来，
       否则每次中止/报错都会在控制台冒成 unhandled rejection。 */
    TAVERN.ask(text, {
      signal: ctrl.signal,
      onChunk: chunk => {
        if (!PENDING.liveEl) {
          const log = $('#chat-log');
          const liveEl = document.createElement('div');
          liveEl.className = 'msg msg-narr is-live';
          liveEl.innerHTML = '<span class="msg-tag">' + ic('i-quill') + '酒馆</span>' +
            '<span class="live-text"></span><i class="live-caret"></i>';
          log.appendChild(liveEl);
          PENDING.liveEl = liveEl;
        }
        PENDING.text += chunk;
        PENDING.liveEl.querySelector('.live-text').textContent = PENDING.text;
        chatScroll();
      },
      onDone: parsed => {
        if (PENDING.liveEl) PENDING.liveEl.remove();
        clearPending();
        setBusy(false);
        /* sum 跟着正文进 CHAT_TURNS：历史压缩到比 x 旧的回合时只喂它。
           raw（模型完整原始输出）随楼层保存：点「编辑」可查看/重解析。 */
        if (parsed.main) pushMsg('narr', { text: parsed.main, raw: parsed.raw || '' });
        if (parsed.options && parsed.options.length) pushMsg('choice', { options: parsed.options });
        if (!parsed.main && (!parsed.options || !parsed.options.length)) {
          /* 酒馆层兜底也产出空正文时才走到这：剥掉残留标签再上屏 */
          pushMsg('narr', { text: String(parsed.raw || '').replace(/<\/?[a-zA-Z][^>]*>/g, '').trim(), raw: parsed.raw || '' });
        }
        /* 分段记忆：AI 在 <memo>/<events> 里自写的总结挂到本条回复，
           发送上下文时较早楼层用小总结、更早用大总结替换原文 */
        mountSegmentedSummary(parsed.memo || '', parsed.events || '');
      },
      onError: err => {
        /* 用户主动中止 ≠ 接口故障：不弹错误、不回退本地引擎 */
        if (err && err.aborted) {
          if (PENDING.liveEl) PENDING.liveEl.remove();
          commitPartialLive();
          clearPending();
          setBusy(false);
          return;
        }
        if (PENDING.liveEl) PENDING.liveEl.remove();
        clearPending();
        setBusy(false);
        notify('error', '酒馆接口异常', err.message + ' —— 已回退本地叙事引擎。');
        const reply = replyFor(text);
        if (reply) applyReply(reply);
      }
    }).catch(function () { /* onError 已交付并处理，吞掉 rethrow */ });
    return;
  }
  const delay = Math.min(900 + text.length * 24, 2400);
  PENDING.timer = setTimeout(() => {
    PENDING.timer = null;
    const reply = replyFor(text);
    setBusy(false);
    if (reply) applyReply(reply);
  }, delay);
}
function applyReply(reply) {
  pushMsg(reply.type, reply);
  if (reply.then) setTimeout(() => reply.then.forEach(r => pushMsg(r.type, r)), 260);
  renderAllGame();
}
function autoGrow() {
  const ta = $('#chat-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function matchTarget(text) { return G.targets.find(t => text.includes(t.name)) || null; }
function focusTarget() { return tgtById(G.focusId); }

function replyFor(text) {
  if (/帮助|指令|怎么玩|示例/.test(text)) return { type: 'narr', text: NARR_REPLIES.help };

  if (/地图|街区|位置/.test(text)) {
    return { type: 'narr', text: NARR_REPLIES.mapHint, then: [{ type: 'choice', options: [{ label: '展开城市地图', action: () => switchView('map') }] }] };
  }
  if (/目标|名单|档案/.test(text)) {
    return { type: 'narr', text: NARR_REPLIES.targetHint, then: [{ type: 'choice', options: [{ label: '打开腐化目标', action: () => switchView('targets') }] }] };
  }
  if (/组织|势力|政府|部门/.test(text)) {
    return { type: 'narr', text: '八股势力盘踞临江：政务、执法、传媒、金融、教育、地下、慈善、文娱。腐化它们的关键人物，组织便会向你倾斜。', then: [{ type: 'choice', options: [{ label: '打开社会组织', action: () => switchView('orgs') }] }] };
  }
  if (/时间|几点|日期/.test(text)) {
    return { type: 'narr', text: `现在是 ${CITY.time.date} ${CITY.time.weekday} ${pad2(CITY.time.hour)}:${pad2(CITY.time.minute)}，天气：${CITY.time.weather}。可在顶部指令台推进时间。` };
  }
  if (/庇护所|炼金|调配|制作/.test(text)) {
    const which = /气体/.test('gas') && false ? null : null;
    const target = /男性/.test(text) ? 'male' : /气体/.test(text) ? 'gas' : /夜冕|晋升/.test(text) ? 'oath' : 'single';
    return { type: 'narr', text: `幽巷的暗门在身后合拢，炼金台的烛火为你亮起。${POTIONS[target].name}标价 ${fmtMoney(POTIONS[target].price)}，钱到位炉火就开。`, then: [{ type: 'choice', options: [{ label: '打开炼金台', action: () => { switchView('sanctum'); } }] }] };
  }
  if (/乌托邦|演出|表演|剧场/.test(text)) {
    return { type: 'narr', text: '乌托邦的幕布正在为你掀起——异界之伶与这座城的沦陷者，都将在那里献演。', then: [{ type: 'choice', options: [{ label: '进入乌托邦', action: () => switchView('utopia') }] }] };
  }
  if (/观察|打量|看/.test(text)) {
    const f = matchTarget(text) || focusTarget();
    if (!f) return { type: 'narr', text: '先在「腐化目标」中选定一位焦点人物，再下达观察指令。' };
    G.focusId = f.id;
    const rep = pick(NARR_REPLIES.observe).replace(/\{name\}/g, f.name).replace('{behavior}', f.behavior).replace('{thought}', f.thought);
    return { type: 'narr', text: rep };
  }
  if (/交谈|聊聊|搭话|聊天/.test(text)) {
    const f = matchTarget(text) || focusTarget();
    if (!f) return { type: 'narr', text: '先在「腐化目标」中选定一位焦点人物，再下达交谈指令。' };
    G.focusId = f.id;
    const feel = f.lv >= 3 ? '慵懒而松弛' : '带着一丝防备';
    const rep = pick(NARR_REPLIES.talk).replace(/\{name\}/g, f.name).replace('{feel}', feel);
    return { type: 'narr', text: rep, then: [
      { type: 'choice', options: [
        { label: '继续交谈', prompt: '继续与' + f.name + '交谈' },
        { label: '使用单人药剂', prompt: '对' + f.name + '使用单人药剂' },
        { label: '打开她的档案', action: () => { G.focusId = f.id; switchView('targets'); } }
      ] }
    ] };
  }
  if (/药剂|用药|下药/.test(text)) {
    const t = matchTarget(text);
    if (t) {
      const kind = /男性/.test(text) ? 'male' : /气体/.test(text) ? 'gas' : 'single';
      return usePotionOn(t.id, kind, true);
    }
    return { type: 'narr', text: '炉火已暖，账已算清。告诉我要为谁调配，或直接前往炼金台。', then: [{ type: 'choice', options: [{ label: '打开炼金台', action: () => switchView('sanctum') }] }] };
  }
  if (/前往|去|到|拜访/.test(text)) {
    const entry = Object.entries(PLACES).find(([, p]) => text.includes(p.name));
    if (entry) {
      const rep = travelTo(entry[0], true);
      return rep || { type: 'narr', text: `你已身在${PLACES[entry[0]].name}。` };
    }
    return { type: 'narr', text: '这座城里没有你说的那个地方。试试「医院」「警局」「乌托邦」。' };
  }
  const rep = pick(NARR_REPLIES.default);
  return { type: 'narr', text: rep };
}

/* ---------- 药剂使用 ---------- */
function usePotionOn(targetId, kind = 'single', fromChat) {
  const t = tgtById(targetId);
  if (!t) return null;
  const pot = POTIONS[kind];
  if (G.potions[kind] <= 0) {
    if (fromChat) return { type: 'narr', text: `${pot.name}已用尽——去庇护所的炼金台再配一批。` };
    notify('warn', '库存不足', `${pot.name}已用尽，请先调配。`);
    return null;
  }
  G.potions[kind]--;
  if (kind === 'single') {
    /* 经验值规则：满额 100，单体药剂一次 +1/3 */
    const xp = Math.round(100 / 3);
    const leveled = willLevel(t, xp);
    const rep = pick(NARR_REPLIES.potion).replace(/\{name\}/g, t.name).replace('{effect}', leveled ? '骤然急促' : '变得绵长而滚烫').replace('{xp}', xp);
    gainXp(t, xp, true);
    if (fromChat) return { type: 'narr', text: rep };
    pushMsg('narr', { text: rep });
    notify('corrupt', '药剂生效', `${t.name} 腐化经验 +${xp}`);
  } else if (kind === 'gas') {
    const here = targetsAtPlayerLoc();
    G.potions.gas++;
    if (!here.length) {
      notify('warn', '无处点燃', '此处没有目标在场。带她们到同一屋檐下再来。');
      return null;
    }
    G.potions.gas--;
    let total = 0;
    here.forEach(x => { const xp = 20; total += xp; gainXp(x, xp, true); });
    pushMsg('narr', { text: `雾气在密闭的房间里弥漫开，霓虹菌丝的冷香沁入每一口呼吸。在场的 ${here.length} 人眼神同时涣散了一瞬。` });
    notify('corrupt', '气体药剂', `${here.length} 人受到腐化，共 +${total} 经验`);
  } else if (kind === 'male') {
    G.maleDullHours = 8;
    pushMsg('narr', { text: '无色的液体在酒杯里散开。男人们的谈笑渐渐变得迟缓、宽容——对他们而言，接下来发生的一切都「再正常不过」。' });
    notify('success', '男性药剂生效', '在场的男性已昏沉迟钝，效力 8 小时。');
  }
  renderAllGame();
  return null;
}
function willLevel(t, xp) { let lv = t.lv, acc = t.xp + xp; while (lv < 5 && acc >= LV_NEED[lv]) { acc -= LV_NEED[lv]; lv++; } return lv > t.lv; }
function currentPlaceId() {
  const name = (CITY.playerLoc.split(' · ')[0] || '').trim();
  const entry = Object.entries(PLACES).find(([, p]) => p.name === name);
  return entry ? entry[0] : null;
}
function currentPlaceName() { const id = currentPlaceId(); return id ? PLACES[id].name : ''; }
function targetsAtPlayerLoc() {
  const pid = currentPlaceId();
  return pid ? placeTargets(pid) : [];
}

/* ---------- 腐化目标 ---------- */
function pipsHtml(lv, size) {
  let html = '';
  for (let i = 1; i <= 5; i++) html += `<span class="pip ${i <= lv ? 'on p' + i : ''}" style="width:${size}px;height:${size}px"></span>`;
  return html;
}
/* ---------- 社会组织 ---------- */
const ORG_PAGE_SIZE = 8;

function renderOrgs() { persistOnRender();
  const controlled = G.orgs.filter(o => o.status === 'control').length;
  const seep = G.orgs.filter(o => o.status === 'seep').length;
  $('#org-pill-count').textContent = controlled;
  $('#org-pill-seep').textContent = seep;
  $('#org-pill-clean').textContent = G.orgs.length - controlled - seep;
  $('#badge-orgs').textContent = controlled;

  /* 分页：8 个一页 */
  if (G.orgPage == null) G.orgPage = 0;
  const pages = Math.max(1, Math.ceil(G.orgs.length / ORG_PAGE_SIZE));
  G.orgPage = Math.min(G.orgPage, pages - 1);
  const list = G.orgs.slice(G.orgPage * ORG_PAGE_SIZE, (G.orgPage + 1) * ORG_PAGE_SIZE);

  $('#org-grid').innerHTML = list.map((o, i) => {
    const status = { clean: ['未接触', 's-clean'], seep: ['渗透中', 's-seep'], control: ['已控制', 's-control'] }[o.status] || ['未接触', 's-clean'];
    const cls = o.corr < 25 ? 'c-low' : o.corr < 60 ? 'c-mid' : 'c-high';
    return `
    <article class="org-card ${o.id === G.orgSel ? 'is-active' : ''}" data-org="${o.id}" role="button" tabindex="0" style="--d:${i * 45}ms">
      <div class="org-top">
        <span class="org-ic">${ic(o.icon || 'i-org')}</span>
        <div><div class="org-name">${esc(o.name)}</div><div class="org-type">${esc(o.type || '未知')}</div></div>
        <span class="org-status ${status[1]}">${status[0]}</span>
      </div>
      <div class="org-corr"><span class="org-corr-label">腐化程度</span><span class="sector-track"><span class="sector-fill" style="width:${o.corr}%;display:block"></span></span><span class="org-corr-num ${cls}">${o.corr}%</span></div>
    </article>`;
  }).join('');

  /* 分页条 */
  const pager = $('#org-pager');
  if (pager) {
    pager.hidden = pages <= 1;
    pager.innerHTML = `
      <button class="pager-btn" data-pg="prev" ${G.orgPage <= 0 ? 'disabled' : ''}>${ic('i-chevron-left')}</button>
      <span class="pager-num">${G.orgPage + 1} / ${pages}</span>
      <button class="pager-btn" data-pg="next" ${G.orgPage >= pages - 1 ? 'disabled' : ''}>${ic('i-chevron-right')}</button>`;
    $$('#org-pager [data-pg]').forEach(b => b.onclick = () => {
      G.orgPage += b.dataset.pg === 'next' ? 1 : -1;
      renderOrgs();
    });
  }

  $$('#org-grid .org-card').forEach(card => {
    card.addEventListener('click', () => { G.orgSel = card.dataset.org; persistUi(); renderOrgs(); });
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); } });
  });
  renderOrgDetail(G.orgSel);
}

/* 【变量协议出口】组织的「腐化规则 / 腐化特权」：四级阈值解锁。
   变量模型：腐化规则/特权的各等级是 布尔（是/否），只表示「该层级已解锁」。
   成文内容不自动生成（不用本地模板、也不调用 AI），一律由玩家在
   详情页点「编辑」自行撰写；直接写文本（字符串）仍兼容为自定义成文。 */
const ORG_TIERS = ['初级', '中级', '高级', '终极'];
const ORG_TIER_NEED = { '初级': 25, '中级': 50, '高级': 75, '终极': 95 };

function orgTiersHtml(o, kind) {
  const bag = kind === 'rule' ? (o.rules || {}) : (o.privs || {});
  const label = kind === 'rule' ? '腐化规则' : '腐化特权';
  const rows = ORG_TIERS.map(t => {
    const need = ORG_TIER_NEED[t];
    const reach = o.corr >= need;            /* 腐化达标 → 可编辑 */
    const raw = bag[t];
    /* 布尔（变量协议 是/否）只表示「该层级已解锁」，成文一律由玩家自行撰写 */
    const unlocked = raw === true;
    const text = typeof raw === 'string' ? raw : '';
    const btn = `<button class="org-tier-btn ${text ? 'is-open' : ''}" data-org="${o.id}" data-kind="${kind}" data-tier="${t}"
        ${reach ? '' : 'disabled'} title="${reach ? `编辑${label}·${t}的成文` : `腐化达到 ${need}% 后解锁`}">
        ${reach ? '编辑' : '未解锁'}</button>`;
    const hint = unlocked ? '<i>已解锁 · 点击「编辑」填写成文</i>'
               : reach ? '<i>点击「编辑」输入自定义文本</i>'
                       : `<i>腐化达到 ${need}% 后解锁</i>`;
    return `<div class="org-tier-row ${reach ? 'reach' : ''}" data-org="${o.id}" data-kind="${kind}" data-tier="${t}">
      <span class="otr-tier">${t}</span>
      <span class="otr-text">${text ? esc(text) : hint}</span>
      ${btn}</div>`;
  }).join('');
  return `<div class="od-section"><h4>${label}</h4>${rows}</div>`;
}

/* 成文注入状态提示：让玩家看得见「这些设定会不会被 AI 读到」。
   以前成文只存不用，是静默失效——这里把状态摊开，避免再次「写了却不知道有没有用」。 */
function orgCharterStatusHtml(o) {
  const hasText = orgCharterEntryContent(o) !== '';
  if (!hasText) return '';
  let active = false, ready = false;
  try {
    ready = !!(window.ST && ST.isReady && ST.isReady());
    if (ready) {
      const b = ST.getLorebooks().find(x => x.builtin === ORG_CHARTER_BUILTIN);
      const ids = (ST.getSettings() && ST.getSettings().activeLorebookIds) || [];
      active = !!(b && ids.indexOf(b.id) !== -1);
    }
  } catch (e) {}
  const cls = active ? 'is-on' : 'is-off';
  const msg = !ready
    ? '酒馆内核未就绪——成文暂不会提供给 AI（导入过一次世界书/预设后即可用）'
    : active
      ? '已镜像为世界书条目：叙事中提到「' + esc(o.name) + '」时会自动提供给 AI'
      : '世界书《' + ORG_CHARTER_BOOK + '》当前被停用——成文不会被 AI 读到，去「酒馆 → 世界书管理」启用它';
  return `<div class="od-charter ${cls}"><span class="od-charter-dot"></span>${msg}</div>`;
}

function renderOrgDetail(id) {
  const d = $('#org-detail');
  const o = id ? orgById(id) : null;
  if (!o) {
    d.innerHTML = `<div class="org-detail-empty">${ic('i-org')}<p>选择左侧组织<br>查看其腐化程度、规则与特权</p></div>`;
    return;
  }
  const status = { clean: ['未接触', 'mi-clean'], seep: ['渗透中', 'mi-seep'], control: ['已控制', 'mi-control'] }[o.status] || ['未接触', 'mi-clean'];
  d.innerHTML = `
    <h3>${esc(o.name)}</h3>
    <span class="mi-status ${status[1]}">${status[0]} · ${esc(o.type || '未知')}</span>
    <div class="od-section"><h4>腐化程度</h4>
      <div class="meter"><span class="meter-label">腐化</span><span class="meter-track"><span class="meter-fill lv" style="width:${o.corr}%;display:block"></span></span><span class="meter-num">${o.corr}%</span></div>
    </div>
    ${orgTiersHtml(o, 'rule')}
    ${orgTiersHtml(o, 'priv')}
    ${orgCharterStatusHtml(o)}`;
  /* 规则/特权成文：点击「编辑」→ 行内输入自定义文本（不再调用 AI 生成）。 */
  $$('#org-detail .org-tier-btn').forEach(b => b.onclick = () => {
    const o2 = orgById(b.dataset.org);
    if (!o2) return;
    const tier = b.dataset.tier;
    if (o2.corr < ORG_TIER_NEED[tier]) return;
    openOrgTierEditor(b.dataset.org, b.dataset.kind === 'rule' ? 'rule' : 'priv', tier);
  });
}

/* 行内编辑器：把该层级行的文本区换成 textarea + 保存/取消。
   原地编辑（不弹模态），保持「点哪改哪」的手感。
   保存写入 rules[tier] / privs[tier] 字符串；清空则删键 → 回到布尔解锁态。 */
function openOrgTierEditor(orgId, kind, tier) {
  const o = orgById(orgId);
  if (!o) return;
  const bag = kind === 'rule' ? (o.rules ??= {}) : (o.privs ??= {});
  const label = kind === 'rule' ? '腐化规则' : '腐化特权';
  const row = $(`#org-detail .org-tier-row[data-org="${orgId}"][data-kind="${kind}"][data-tier="${tier}"]`);
  if (!row || row.dataset.editing === '1') return;   /* 已在编辑中 */
  const cell = row.querySelector('.otr-text');
  const btn = row.querySelector('.org-tier-btn');
  if (!cell) return;

  row.dataset.editing = '1';
  const prevText = cell.innerHTML;
  const current = typeof bag[tier] === 'string' ? bag[tier] : '';
  cell.innerHTML = `<textarea class="org-tier-input ai-input" rows="2" maxlength="200"
      placeholder="输入${label} · ${tier} 的成文（最多 200 字）">${esc(current)}</textarea>
    <div class="otr-edit-actions">
      <button class="btn btn-sm btn-ghost" data-oe="c">取消</button>
      <button class="btn btn-sm btn-primary" data-oe="s">保存</button>
    </div>`;
  if (btn) btn.disabled = true;

  const ta = cell.querySelector('textarea');
  ta.focus();
  if (ta.setSelectionRange) ta.setSelectionRange(ta.value.length, ta.value.length);

  const close = () => {
    row.dataset.editing = '';
    cell.innerHTML = prevText;
    if (btn) btn.disabled = false;
  };
  const save = () => {
    const v = ta.value.trim();
    if (v) bag[tier] = v; else delete bag[tier];
    persistOnRender();
    /* 成文改了就立刻同步世界书条目（debounce 0 = 下一 tick），
       否则玩家刚写完、模型这边还看不到。 */
    scheduleOrgLorebookSync(0);
    notify(v ? 'corrupt' : 'info', `${label} · ${tier}`,
      v ? v + '（提及「' + o.name + '」时会作为设定提供给 AI）'
        : '已清空成文，该层级回到待填写状态。');
    row.dataset.editing = '';
    renderOrgDetail(orgId);          /* 重画，同步按钮与提示文案 */
  };

  cell.querySelector('[data-oe="c"]').onclick = close;
  cell.querySelector('[data-oe="s"]').onclick = save;
  /* 键盘：Ctrl/Cmd+Enter 保存，Esc 取消 */
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
}

/* ============================================================
   社会组织成文 → 世界书条目（按需注入）
   ------------------------------------------------------------
   玩家的自定义成文以前只存在 G.orgs[].rules/privs 里，只有详情页自己看得到；
   VARS.digest() 的状态卡对组织只输出「规✓———」这种勾选摘要，模型拿不到正文。
   这里把每条成文镜像成**世界书条目**，靠组织名 + 类型词触发：
   只有正文里提到该组织时那一条才注入，既不占常驻 token，
   又让 AI 真正按玩家写的设定叙事。

   设计要点：
     · 一本专用书（builtin='orgcharters'），与内置模板/玩家自建书分开，便于识别与重置
     · 条目内容 = 成文正文 + 一行来源标注，避免模型把规则误当成新剧情要素
     · 一组织一条：把该组织所有已填层级合并进同一条条目，
       命中一次就把该组织的全部成文给模型（比每层级一条更省条目、更连贯）
     · 常驻关闭（constant:false）、概率 100，纯关键词触发
     · 触发词 = 组织名（主键）。组织名如「市政厅」本身就是稳定专名，够精确
     · 书被激活（activeLorebookIds）才生效：首次创建时自动激活
   ============================================================ */
const ORG_CHARTER_BOOK = '社会组织成文';
const ORG_CHARTER_BUILTIN = 'orgcharters';
let orgSyncTimer = 0;

function orgCharterEntryContent(o) {
  const parts = [];
  ['rule', 'priv'].forEach(kind => {
    const bag = kind === 'rule' ? (o.rules || {}) : (o.privs || {});
    const label = kind === 'rule' ? '腐化规则' : '腐化特权';
    ORG_TIERS.forEach(t => {
      const v = bag[t];
      if (typeof v === 'string' && v.trim()) parts.push(`【${label}·${t}】${v.trim()}`);
    });
  });
  if (!parts.length) return '';
  return `社会组织「${o.name}」（${o.type || '未知'}）当前已被玩家掌握的设定：\n` +
    parts.join('\n') +
    `\n（以上为该组织既成事实，请在叙事中体现，不要另行改写或新增。）`;
}

/* 触发词：组织名 + 类型词。类型词（政务/执法/医疗…）单独命中也可，
   因为玩家叙事里常写「警局的人」而不带全名，但更常见的是直接写机构名。 */
function orgCharterKeys(o) {
  const keys = [o.name];
  if (o.type && !keys.includes(o.type)) keys.push(o.type);
  return keys.filter(Boolean);
}

/* 计算目标条目集合：只有「有已填成文」的组织才生成条目 */
function orgCharterDesired() {
  return (G.orgs || [])
    .map(o => ({ org: o, content: orgCharterEntryContent(o) }))
    .filter(x => x.content);
}

function scheduleOrgLorebookSync(delay) {
  if (orgSyncTimer) clearTimeout(orgSyncTimer);
  orgSyncTimer = setTimeout(function () {
    orgSyncTimer = 0;
    syncOrgCharters().catch(function (e) {
      console.error('[世界书] 组织成文同步失败', e);
    });
  }, delay == null ? 800 : delay);
}

/* 幂等同步：把当前成文状态刷进专用世界书。
   与目标保持一致——新增/改动则更新，清空的层级会自然从条目里消失，
   整个组织都没成文了就把条目删掉。 */
async function syncOrgCharters() {
  if (!window.ST || !ST.isReady || !ST.isReady()) return { skipped: 'not-ready' };
  if (typeof ST.saveLorebook !== 'function' || typeof ST.getLorebooks !== 'function') return { skipped: 'no-api' };

  const desired = orgCharterDesired();
  let book = ST.getLorebooks().find(b => b.builtin === ORG_CHARTER_BUILTIN);

  /* 没有任何成文：删掉遗留条目（书本身留着，玩家可能自己在里面加东西） */
  if (!desired.length) {
    if (book && (book.entries || []).some(e => e.orgCharterId)) {
      book.entries = (book.entries || []).filter(e => !e.orgCharterId);
      book.updatedAt = Date.now();
      await ST.saveLorebook(book);
      return { removed: 'all' };
    }
    return { noop: true };
  }

  if (!book) {
    book = window.ST_CORE.createDefaultLorebook(ORG_CHARTER_BOOK);
    book.description = '由「势力 → 腐化规则/特权」的成文自动维护。可直接编辑，但下次成文变动会被覆盖。';
    book.builtin = ORG_CHARTER_BUILTIN;
    book.entries = [];
  }
  book.entries = book.entries || [];

  let added = 0, updated = 0, removed = 0;
  const wanted = new Set();

  desired.forEach(({ org, content }) => {
    wanted.add(org.id);
    const keys = orgCharterKeys(org);
    let entry = book.entries.find(e => e.orgCharterId === org.id);
    if (!entry) {
      entry = window.ST_CORE.applyEntryDefaults({
        keys: keys,
        content: content,
        comment: '成文 · ' + org.name,
        order: 200,
        position: 'after_char',
        constant: false,
        probability: 100,
        useProbability: false,
        selective: false
      });
      entry.orgCharterId = org.id;      /* 自定义标记：识别「本功能维护的条目」 */
      book.entries.push(entry);
      added++;
    } else if (entry.content !== content || String(entry.keys) !== String(keys)) {
      entry.content = content;
      entry.keys = keys;
      entry.comment = '成文 · ' + org.name;
      updated++;
    }
  });

  /* 清理：组织不再有成文（或组织已被删）→ 移除对应条目 */
  const before = book.entries.length;
  book.entries = book.entries.filter(e => !e.orgCharterId || wanted.has(e.orgCharterId));
  removed = before - book.entries.length;

  book.updatedAt = Date.now();

  /* 首次创建才自动激活——玩家若手动关掉这本书，不能在下次同步时又给他打开。
     用书自身持久化的 autoActivated 标记（而非内存变量），刷新页面后依然尊重玩家的选择。 */
  let needActivate = false;
  if (!book.autoActivated) {
    book.autoActivated = true;
    needActivate = true;
  }
  await ST.saveLorebook(book);

  if (needActivate) {
    try {
      const s = ST.getSettings();
      const ids = (s && s.activeLorebookIds) || [];
      if (ids.indexOf(book.id) === -1) {
        await ST.saveSettings({ activeLorebookIds: ids.concat([book.id]) });
      }
    } catch (e) { console.error('[世界书] 自动激活失败', e); }
  }

  if (added || updated || removed) {
    console.log('[世界书] 组织成文已同步：新增 ' + added + ' · 更新 ' + updated + ' · 移除 ' + removed);
  }
  return { added, updated, removed };
}
window.SYNC_ORG_CHARTERS = syncOrgCharters;
window.ORG_CHARTER_BOOK = ORG_CHARTER_BOOK;

/* ---------- 市长竞选 ---------- */
/* 活动等级与组织的「腐化规则」同级同阈（ORG_TIER_NEED：初级25/中级50/高级75/终极95）。
   每个组织 × 每个等级 × 演讲/游行：只有第一次点击增加支持率（G.campaign.done 记录）。
   竞选本身需完成三项任务解锁：市长秘书 Lv3 / 贪腐性丑闻证据 / 市长夫人 Lv3 并表态支持。 */
const CAMPAIGN_GAIN = { '初级': 2, '中级': 4, '高级': 6, '终极': 9 };
function campaignTasks() {
  const roleOf = kw => G.targets.find(t => `${t.name}|${t.title || ''}`.includes(kw));
  const sec = roleOf('秘书');
  const wife = roleOf('夫人');
  const itemKeys = Object.keys(G.items || {});
  const scandal = itemKeys.some(k => k.includes('丑闻') || k.includes('贪腐'));
  const wifeSupport = !!wife && (String(wife.rel || '').includes('支持') ||
    itemKeys.some(k => k.includes('夫人') && k.includes('支持')));
  return [
    { ok: !!(sec && sec.lv >= 3), label: '「市长秘书」的腐化达到 Lv3',
      note: sec ? `${sec.name} · 当前 Lv${sec.lv}` : '腐化名单中还没有她' },
    { ok: scandal, label: '拿到市长的贪腐与性丑闻证据',
      note: '作为物品记入背包（如「性丑闻证据」「贪腐账本」）' },
    { ok: !!(wife && wife.lv >= 3 && wifeSupport), label: '「市长夫人」腐化至 Lv3 并获得她的支持',
      note: wife ? `${wife.name} · 当前 Lv${wife.lv}${wifeSupport ? ' · 已表态支持' : ' · 尚未在人际关系中表态支持'}` : '腐化名单中还没有她' }
  ];
}
function renderCampaign() { persistOnRender();
  G.campaign ??= { support: 0, unlocked: false, done: {} };
  G.campaign.done ??= {};
  const pane = $('#pane-campaign');
  const support = G.campaign.support || 0;
  const tasks = campaignTasks();
  const allDone = tasks.every(t => t.ok);
  if (allDone && !G.campaign.unlocked) {
    G.campaign.unlocked = true;
    notify('success', '市长竞选', '三项条件全部达成——市长竞选，正式开始！');
  }
  const banner = `<div class="camp-banner"><span>当前支持率</span><b>${support.toFixed(1)}%</b></div>`;
  if (!G.campaign.unlocked) {
    pane.innerHTML = banner + `
      <div class="section-title">${ic('i-lock')}竞选尚未解锁</div>
      <p class="view-sub" style="margin:2px 0 16px">完成以下三项任务后，市长竞选正式开始。任务状态由剧情与变量自动推进。</p>
      <div class="camp-tasks">
        ${tasks.map((t, i) => `
          <div class="camp-task ${t.ok ? 'is-done' : ''}">
            <span class="camp-task-ic">${t.ok ? ic('i-check') : ic('i-lock')}</span>
            <div><b>${i + 1}. ${t.label}</b><p>${t.note}</p></div>
          </div>`).join('')}
      </div>`;
    return;
  }
  pane.innerHTML = banner + `
    <div class="section-title">${ic('i-users')}增加支持率</div>
    <p class="view-sub" style="margin:2px 0 16px">通过在社会组织中进行腐化演讲或游行来增加支持率。演讲与游行各有初级到终极四个等级，解锁条件与该组织的腐化规则一致；同一组织的同一活动只有首次进行会增加支持率。</p>
    <div class="camp-grid">
      ${G.orgs.map(o => {
        const tierBtns = actName => ORG_TIERS.map(t => {
          const need = ORG_TIER_NEED[t];
          const key = o.id + '|' + actName + '|' + t;
          const done = !!G.campaign.done[key];
          const reach = o.corr >= need;
          return `<button class="camp-tier-btn ${done ? 'is-done' : reach ? '' : 'is-locked'}"
              data-camp-org="${o.id}" data-camp-act="${actName}" data-camp-tier="${t}"
              ${!reach || done ? 'disabled' : ''}
              title="${done ? '已进行——不再增加支持率' : reach ? `支持率 +${CAMPAIGN_GAIN[t]}` : `腐化达到 ${need}% 后解锁（与腐化规则一致）`}">${t}</button>`;
        }).join('');
        return `
        <div class="camp-card ${o.corr >= ORG_TIER_NEED['终极'] ? 'is-ultimate' : ''}">
          <div class="camp-card-head"><b>${esc(o.name)}</b><span class="camp-badge">${o.corr}% 渗透</span></div>
          <div class="camp-act-group">
            <div class="camp-act-title">${ic('i-volume')}腐化演讲</div>
            <div class="camp-tier-btns">${tierBtns('腐化演讲')}</div>
          </div>
          <div class="camp-act-group">
            <div class="camp-act-title">${ic('i-users')}腐化游行</div>
            <div class="camp-tier-btns">${tierBtns('腐化游行')}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  pane.querySelectorAll('[data-camp-tier]').forEach(b => b.addEventListener('click', () => {
    doCampaign(b.dataset.campOrg, b.dataset.campAct, b.dataset.campTier);
  }));
}
function doCampaign(orgId, act, tierName) {
  const o = G.orgs.find(x => x.id === orgId);
  if (!o) return;
  G.campaign ??= { support: 0, unlocked: true, done: {} };
  G.campaign.done ??= {};
  const key = orgId + '|' + act + '|' + tierName;
  if (G.campaign.done[key]) { notify('info', act, `${o.name} 的${tierName}${act}已经进行过，不再增加支持率。`); return; }
  const need = ORG_TIER_NEED[tierName];
  if (o.corr < need) { notify('warn', '条件不足', `${o.name} 的腐化需达到 ${need}% 才能进行${tierName}${act}（与腐化规则解锁一致）。`); return; }
  const before = G.campaign.support || 0;
  const after = Math.min(100, before + (CAMPAIGN_GAIN[tierName] || 0));
  G.campaign.support = after;
  G.campaign.done[key] = true;
  notify('corrupt', `${act} · ${o.name}`, `${tierName}活动完成，支持率 ${before.toFixed(1)}% → ${after.toFixed(1)}%。`);
  if (after >= 100 && before < 100) {
    notify('success', '市长竞选', '支持率已满——胜选在望，接下来交给故事的走向。');
  }
  renderCampaign();
}

/* ---------- 庇护所 ---------- */
/* 常驻 NPC：萨满（药剂师）与莉莉丝（导游/调教师）。
   img = 默认形象（远端链接，浏览器直接加载）；玩家上传的自定义图像优先生效，
   删除后回到默认形象。头像可点击 → NPC 详情页（无腐化等级，显示「未知」；
   人际关系只连用户）。 */
const SANCTUM_NPCS = {
  shaman: {
    id: 'shaman', name: '萨满', en: 'Shaman', role: '专属药剂师', roleEn: 'PHARMACIST',
    img: 'https://github.com/daofaziran366/fuhua/blob/main/saman.png?raw=true',
    quote: '我是您的药剂师。在这座庇护所里，我不需要衣物遮掩。看着身上的纹身吗？想要制作药剂的话，请尽管使用我的身体来获取那一块必须的精华原料吧。',
    title: '专属药剂师', age: 26, loc: '庇护所 · 炼金台', schedule: '常驻炼金台 · 深夜调香',
    behavior: '在幽蓝炉火前研磨发光的草药', thought: '下一锅精华原料还差一份「献祭」', makeup: '符文彩绘', outfit: '仅纹身与皮质围裙'
  },
  lilith: {
    id: 'lilith', name: '莉莉丝', en: 'Lilith', role: '庇护所导游 & 首席调教师', roleEn: 'GUIDE & TRAINER',
    img: 'https://github.com/daofaziran366/fuhua/blob/main/lilisi.png?raw=true',
    quote: '欢迎来到地下乐园，市长。这身制服是为了更好地为您服务——无论是安排女奴的会面，还是为您提供专业的调教服务。请尽管吩咐。',
    title: '庇护所导游 · 首席调教师', age: 24, loc: '庇护所 · 调教室', schedule: '随叫随到 · 深夜巡廊',
    behavior: '立于门侧擦拭着教鞭', thought: '今晚会有哪位女奴需要管教呢', makeup: '冷艳晚妆', outfit: '黑紫制式制服'
  }
};

function renderSanctum() {
  persistOnRender();
  G.craftQty ??= { single: 0, gas: 0, male: 0 };
  G.sanctumMode ??= 'service';
  const npcPane = $('#sanctum-npc'), main = $('#sanctum-main');
  if (G.sanctumNpc && SANCTUM_NPCS[G.sanctumNpc]) {
    renderNpcDetail(G.sanctumNpc);
    if (npcPane) npcPane.hidden = false;
    if (main) main.hidden = true;
    return;
  }
  if (npcPane) npcPane.hidden = true;
  if (main) main.hidden = false;
  renderNpcCard('shaman');
  renderNpcCard('lilith');
  renderAlchemy();
  renderTraining();
}

function renderNpcCard(id) {
  const n = SANCTUM_NPCS[id];
  const box = $('#npc-card-' + id);
  if (!box) return;
  const src = getCustomPortrait(id) || n.img;
  box.innerHTML = `
    <div class="npc-card">
      <div class="npc-avatar-wrap">
        <button class="npc-avatar" id="npc-avatar-${id}" title="查看${n.name}的人物详情" aria-label="查看${n.name}的人物详情"><span class="npc-avatar-empty">${ic('i-user')}</span>${src ? `<img class="npc-avatar-img" src="${src}" alt="${n.name}" onerror="this.remove()">` : ''}</button>
        <span class="npc-info-tag">INFO</span>
      </div>
      <div class="npc-meta">
        <h3 class="npc-name">${n.name} (${n.en})</h3>
        <p class="npc-role">${n.role} / ${n.roleEn}</p>
        <p class="npc-quote">“${n.quote}”</p>
      </div>
    </div>`;
  $('#npc-avatar-' + id).onclick = () => { G.sanctumNpc = id; renderSanctum(); };
}

/* NPC 详情页：形似腐化目标档案，但无腐化等级（显示「未知」）、
   无腐化经验条，人际关系只连接用户。 */
function renderNpcDetail(id) {
  const n = SANCTUM_NPCS[id];
  const pane = $('#sanctum-npc');
  const src = getCustomPortrait(id) || n.img;
  const custom = !!getCustomPortrait(id);
  pane.innerHTML = `
    <header class="detail-top">
      <button class="btn btn-ghost" id="btn-npc-back"><svg class="ic flip"><use href="#i-chevron-right"/></svg>返回庇护所</button>
      <span class="detail-crumb">人物档案 · ${n.role}</span>
    </header>
    <div class="detail-page">
      <aside class="detail-portrait">
        <div class="portrait-fallback"><span>${n.name.slice(1, 2)}</span><b>${n.name}</b><i>PORTRAIT</i></div>
        ${src ? `<img class="portrait-img" src="${src}" alt="${n.name}" onerror="this.remove()">` : ''}
        <div class="portrait-tools">
          <button class="pt-btn" id="btn-npc-portrait-upload">${ic('i-camera')}上传图片</button>
          ${custom ? `<button class="pt-btn danger" id="btn-npc-portrait-del">${ic('i-trash')}删除图片</button>` : ''}
        </div>
      </aside>
      <div class="detail-main">
        <div class="detail-name-line">
          <div class="detail-name">${n.name}<span class="lv-label lv-unknown">腐化等级 · 未知</span></div>
          <p class="detail-title-line">${n.title} · ${n.age} 岁</p>
          <div class="detail-lvline">
            <span class="hint-chip">${ic('i-map')}${n.loc}</span>
            <span class="hint-chip">${ic('i-ticket')}${n.schedule}</span>
          </div>
        </div>
        <p class="rel-note">${ic('i-info')}<span>“${n.quote}”</span></p>
        <div class="section-title">当前状态</div>
        <div class="detail-stats">
          <div class="stat-box"><span class="stat-ic">${ic('i-map')}</span><div><b>当前位置</b><p>${n.loc}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-wind')}</span><div><b>当前行为</b><p>${n.behavior}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-brain')}</span><div><b>当前想法</b><p>${n.thought}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-mask')}</span><div><b>当前妆容</b><p>${n.makeup}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-user')}</span><div><b>当前服装</b><p>${n.outfit}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-ticket')}</span><div><b>日程安排</b><p>${n.schedule}</p></div></div>
        </div>
        <div class="section-title">人际关系</div>
        <p class="rel-note">${ic('i-users')}<span>只与你有往来——她的一切都只向你敞开。</span></p>
      </div>
    </div>`;
  $('#btn-npc-back').onclick = () => { G.sanctumNpc = null; renderSanctum(); };
  /* 图片区整体可点 = 上传；已上传时右上角小删除钮（无独立功能区） */
  /* 图片框顶部的上传/删除按钮（不放底部功能区；存取按 id 键，NPC 与目标共用） */
  $('#btn-npc-portrait-upload').addEventListener('click', () => pickPortrait(id));
  const del = $('#btn-npc-portrait-del');
  if (del) del.addEventListener('click', () => delPortrait(id));
}

/* 药剂制作：三种药剂各设制作数量，底部合计金额一键制作 */
function renderAlchemy() { persistOnRender();
  const pane = $('#pane-alchemy');
  if (!G.craftQty) G.craftQty = { single: 0, gas: 0, male: 0 };
  const dull = G.maleDullHours > 0;
  const craftable = Object.values(POTIONS).filter(p => p.id !== 'oath');
  const total = craftable.reduce((s, p) => s + (G.craftQty[p.id] || 0) * p.price, 0);
  pane.innerHTML = `
    <p class="view-sub" style="margin-bottom:14px">庇护所的炼金台终年燃着幽蓝的炉火——每一瓶药剂，都是写往深渊的请柬。${dull ? '<b style="color:var(--cyan)">男性药剂生效中（剩余 ' + G.maleDullHours + ' 小时）</b>' : ''}</p>
    <div class="craft-panel">
      <h3 class="panel-cap">${ic('i-flask')}药剂制作</h3>
      ${craftable.map(p => `
        <div class="craft-card">
          <div class="craft-card-head"><b>${p.name}</b><span class="craft-en">${{ single: 'Single', gas: 'Gas', male: 'MaleDulling' }[p.id]}</span></div>
          <p class="craft-desc">${p.desc}</p>
          <div class="craft-card-line">
            <span class="craft-step">制作数量：
              <button class="step-btn" data-step="-1" data-craft="${p.id}" aria-label="减少">−</button>
              <b class="step-num">${G.craftQty[p.id] || 0}</b>
              <button class="step-btn" data-step="1" data-craft="${p.id}" aria-label="增加">+</button>
            </span>
            <span class="craft-own">${ic('i-box')}拥有: ${G.potions[p.id]}</span>
            <span class="craft-price">单价: ¥${p.price.toLocaleString()}</span>
          </div>
        </div>`).join('')}
      <div class="craft-total"><span>总计金额:</span><b>¥${total.toLocaleString()}</b></div>
      <button class="btn craft-brew" id="btn-brew" ${total > 0 && RES.money >= total ? '' : 'disabled'}>${ic('i-spark')}${total > 0 ? (RES.money >= total ? '注入精华并制作' : '现金不足') : '先设定制作数量'}</button>
    </div>`;
  pane.querySelectorAll('.step-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.craft;
    const next = Math.max(0, Math.min(9, (G.craftQty[id] || 0) + (+b.dataset.step)));
    G.craftQty[id] = next;
    renderAlchemy();
  }));
  $('#btn-brew').onclick = () => {
    if (total <= 0) return;
    if (RES.money < total) { notify('warn', '现金不足', `本次制作需要 ¥${total.toLocaleString()}。`); return; }
    RES.money -= total;
    const made = craftable.filter(p => G.craftQty[p.id] > 0)
      .map(p => { G.potions[p.id] += G.craftQty[p.id]; return `${p.name} ×${G.craftQty[p.id]}`; });
    notify('success', '调配完成', `萨满把制剂推到你面前：${made.join('、')}。`);
    G.craftQty = { single: 0, gas: 0, male: 0 };
    renderAlchemy(); renderHud(); renderBackpack();
  };
}

function renderTraining() { persistOnRender();
  const pane = $('#pane-training');
  /* 服务台模式：莉莉丝的「深度调教服务」入口面板；
     选定 Lv4 目标并预约后进入调教工作台（session）。 */
  if (G.sanctumMode !== 'session') {
    pane.innerHTML = `
      <div class="service-panel">
        <h3 class="service-title">深度调教服务</h3>
        <p class="service-en">PROFESSIONAL TRAINING</p>
        <button class="service-circle" id="btn-service-pick" aria-label="选择调教目标">
          <span>${G.trainId && tgtById(G.trainId) && tgtById(G.trainId).lv === 4 ? esc(tgtById(G.trainId).name) : '选择目标'}</span>
        </button>
        <div class="service-pick-list" id="service-pick-list" hidden>
          ${G.targets.filter(t => t.lv === 4).map(x => `
            <button class="service-pick-item" data-pick="${x.id}"><b>${esc(x.name)}</b><span>Lv4 · 沦陷</span></button>`).join('') ||
            '<p class="service-empty">还没有 Lv4「沦陷」的目标——先把某人带到那一步。</p>'}
        </div>
        <p class="service-desc"><b>奴隶管理 & 阶段调教</b><br>莉莉丝将亲自指导。<br>提升目标服从度，或安排特殊会面。</p>
        <button class="btn service-book" id="btn-service-book" ${G.trainId && tgtById(G.trainId) && tgtById(G.trainId).lv === 4 ? '' : 'disabled'}>${ic('i-mask')}选择目标后可预约</button>
      </div>`;
    pane.querySelector('#btn-service-pick').onclick = () => {
      const list = pane.querySelector('#service-pick-list');
      list.hidden = !list.hidden;
    };
    pane.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      G.trainId = b.dataset.pick;
      renderTraining();
    }));
    pane.querySelector('#btn-service-book').onclick = () => {
      G.sanctumMode = 'session';
      renderTraining();
    };
    return;
  }
  const trainable = G.targets.filter(t => t.lv === 4);
  const t = tgtById(G.trainId) || trainable[0];
  if (!t || t.lv !== 4) {
    G.sanctumMode = 'service';
    pane.innerHTML = `<div class="train-empty">调教室静候Lv4「沦陷」的造物。<br>先把某人带到那一步——例如通过药剂累积腐化经验。</div>`;
    return;
  }
  G.trainId = t.id;
  const avg = Math.round(G.methodPct.reduce((a, m) => a + m.pct, 0) / G.methodPct.length);
  const allDone = G.methodPct.every(m => m.pct >= 100);
  const step1 = allDone, step2 = G.trainedUtopia, step3 = G.potions.oath > 0;
  const canRise = step1 && step2 && step3;
  pane.innerHTML = `
    <div class="train-layout">
      <div>
        <div class="section-title">调教对象 · Lv4 沦陷</div>
        <div class="train-list">
          ${trainable.map(x => `
            <div class="train-card ${x.id === G.trainId ? 'is-active' : ''}" data-train="${x.id}" role="button" tabindex="0">
              <span class="tgt-glyph">${x.name.slice(1, 2)}</span><b>${x.name}</b><span class="lv-tag">Lv4·沦陷</span>
            </div>`).join('')}
        </div>
        <div class="ritual-banner">
          ${ic('i-crown')}
          <div>
            <b>晋升仪式 · 沦陷 → 契缚</b>
            <p>调教度圆满后，需在乌托邦完成一场登台献演，并饮下晋升秘药「夜冕之酒」，方可举行奴契仪式，将其彻底变为你的所有物。</p>
            <div class="ritual-steps">
              <span class="rstep ${step1 ? 'done' : 'cur'}">${step1 ? ic('i-check') : ''}调教度 100%</span>
              <span class="rstep ${step2 ? 'done' : ''}">${step2 ? ic('i-check') : ''}乌托邦登台</span>
              <span class="rstep ${step3 ? 'done' : ''}">${step3 ? ic('i-check') : ''}夜冕之酒 ×${G.potions.oath}</span>
            </div>
            ${t.lv === 4 ? `<button class="btn ${canRise ? 'btn-primary' : ''}" id="btn-ritual-rise" style="margin-top:12px" ${canRise ? '' : 'disabled'}>${ic('i-crown')}举行奴契仪式 · ${t.name} → Lv5</button>` : ''}
          </div>
        </div>
      </div>
      <div>
        <div class="train-hero">
          <span class="tgt-glyph" style="width:48px;height:48px;font-size:20px">${t.name.slice(1, 2)}</span>
          <div><b>${t.name}</b><p>${t.title} · 调教对象</p></div>
          <div class="train-ring">
            <svg viewBox="0 0 66 66" width="66" height="66" style="transform:rotate(-90deg)">
              <circle class="ring-track" cx="33" cy="33" r="27"/>
              <circle class="ring-fill" cx="33" cy="33" r="27" style="stroke-dasharray:169.6;stroke-dashoffset:${169.6 * (1 - avg / 100)}"/>
            </svg>
            <span class="train-ring-num">${avg}<span>%</span></span>
          </div>
        </div>
        <div class="section-title">调教方法</div>
        ${G.methodPct.map(m => {
          const def = TRAIN_METHODS.find(x => x.id === m.id);
          const done = m.pct >= 100;
          return `
          <div class="method-row">
            <span class="method-name">${ic(def.icon)}${def.name}</span>
            <span class="method-track"><span class="method-fill" style="width:${m.pct}%;display:block"></span></span>
            <span class="method-pct">${m.pct}%</span>
            <button class="btn" data-train-method="${m.id}" ${done ? 'disabled' : ''}>${done ? '已圆满' : '调教'}</button>
          </div>`;
        }).join('')}
      </div>
    </div>
    <button class="btn btn-ghost" id="btn-train-back" style="margin-top:14px">${ic('i-chevron-right')}返回服务台</button>`;
  pane.querySelector('#btn-train-back').onclick = () => { G.sanctumMode = 'service'; G.trainId = null; renderTraining(); };
  pane.querySelectorAll('[data-train]').forEach(c => c.addEventListener('click', () => { G.trainId = c.dataset.train; renderTraining(); }));
  pane.querySelectorAll('[data-train-method]').forEach(b => b.addEventListener('click', () => {
    const m = G.methodPct.find(x => x.id === b.dataset.trainMethod);
    m.pct = Math.min(100, m.pct + randInt(6, 10));
    const def = TRAIN_METHODS.find(x => x.id === m.id);
    notify('success', '调教进行', `${t.name} 的「${def.name}」进度 +6~10%。`);
    renderTraining();
  }));
  const rise = pane.querySelector('#btn-ritual-rise');
  if (rise) rise.addEventListener('click', () => {
    confirmDialog({
      title: '奴契仪式', okText: '举行仪式',
      body: `为 ${t.name} 举行奴契仪式：她将饮下夜冕之酒，在契书上按下指印，从「沦陷」彻底成为你的所有物（Lv5 契缚）。此事无可逆转。`,
      onOk: () => {
        G.potions.oath--;
        t.lv = 5; t.xp = 0;
        syncOrgFromTarget(t);
        pushMsg('narr', { text: `烛火压低，契书展开。${t.name}赤足踏上法阵，饮尽夜冕之酒——她在指印落下的那一刻颤栗出声，从此成为你在临江的第一件「所有物」。` });
        notify('corrupt', '奴契成立', `${t.name} 已成为你的契缚者（Lv5）。`);
        renderAllGame();
      }
    });
  });
}


/* ---------- 乌托邦 ---------- */
function setUtopiaTab(tab) {
  $$('#utopia-tabs .seg-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
  $$('#view-utopia .pane').forEach(p => { p.hidden = p.id !== 'pane-' + tab; });
  if (tab === 'stage') renderStage();
  if (tab === 'performers') renderPerformers();
  if (tab === 'business') renderBusiness();
  if (tab === 'market') renderMarket();
}
function upgradeMul() { return 1 + [...G.upgrades].reduce((a, id) => a + { neon: .25, vip: .4, vault: .6 }[id] || 0, 0); }

/* 乌托邦变量摘要：与目标渲染同款变量卡，读变量白名单 */
function stageVarsHtml() {
  try {
    var booked = G.schedule.filter(function (s) { return s.booked; }).length;
    var cells = [
      ['营收倍率', '×' + upgradeMul().toFixed(2)],
      ['已排场次', booked + ' / ' + G.schedule.length],
      ['今夜营收', '¥' + G.schedule.filter(function (s) { return s.booked; }).reduce(function (x, s) { return x + s.revenue; }, 0).toLocaleString()],
      ['在场演员', String(G.performers.length)],
      ['场馆升级', [...G.upgrades].length + ' / ' + UPGRADES.length],
      ['登台献演', G.trainedUtopia ? '已完成' : '未完成']
    ];
    return '<div class="section-title">乌托邦状态</div><div class="var-grid">' + cells.map(function (c) {
      return '<div class="var-cell"><b>' + esc(c[0]) + '</b><span>' + esc(c[1]) + '</span></div>';
    }).join('') + '</div>';
  } catch (e) { return ''; }
}

function renderStage() { persistOnRender();
  const pane = $('#pane-stage');
  const tonight = G.schedule[0] || { time: '—', name: '尚未开场', revenue: 0 };
  const perfOf = s => { if (!s || !s.perf) return null; const p = perfById(s.perf); return p ? p : null; };
  const tp = perfOf(tonight) || null;
  const todayRevenue = G.schedule.filter(s => s.booked).reduce((a, s) => a + s.revenue, 0);
  const perfName = s => {
    if (!s || !s.perf) return null;
    const p = perfById(s.perf);
    if (p) return { name: p.name, world: p.world, icon: p.icon };
    const t = tgtById(s.perf);
    return t ? { name: t.name, world: '临江 · 本世界', icon: 'i-crown' } : null;
  };
  const tn = perfName(tonight);
  pane.innerHTML = `
    <div class="stage-hero">
      <span class="stage-hero-glyph">${ic(tn ? tn.icon : 'i-stage')}</span>
      <div class="stage-hero-text">
        <span class="stage-tag">${ic('i-ticket')}今夜主秀 · ${tonight.time}</span>
        <div class="stage-showname">${tonight.name}</div>
        <div class="stage-info">
          ${tn ? `<span>${ic('i-user')}${tn.name} · ${tn.world}</span><span>${ic('i-music')}技艺 ${perfOf(tonight) ? perfOf(tonight).skill : 88}</span>` : '<span>尚未排定主演</span>'}
        </div>
      </div>
      <div class="stage-revenue"><b>¥${todayRevenue.toLocaleString()}</b><span>今夜营收</span></div>
    </div>
    <div class="stage-vars" id="stage-vars">${stageVarsHtml()}</div>
    <div class="section-title">今夜排期 · 点击为空场安排演出</div>
    <div class="slot-grid">
      ${G.schedule.map((s, i) => {
        const p = perfName(s);
        return `
        <article class="slot-card" style="--d:${i * 55}ms">
          <div class="slot-time">${s.time}</div>
          <div class="slot-name">${s.name}</div>
          ${p ? `
            <div class="slot-perf">${ic(p.icon)}${p.name} · ${p.world}</div>
            <div class="slot-perf gold">${ic('i-trend')}营收 ¥${s.revenue.toLocaleString()}</div>`
          : `
            <div class="slot-empty">${ic('i-ticket')}暂未排期</div>
            <button class="btn" data-book-slot="${i}">${ic('i-plus')}安排演出</button>`}
        </article>`;
      }).join('')}
    </div>
    ${G.trainedUtopia ? `<p class="hint-chip" style="margin-top:14px">${ic('i-crown')}本世界 Lv4 目标已完成登台献演——晋升仪式条件之一已达成。</p>` : ''}`;
  pane.querySelectorAll('[data-book-slot]').forEach(b => b.addEventListener('click', () => {
    const idx = +b.dataset.bookSlot;
    const choices = [
      ...G.performers.map(p => ({ label: `${p.name} · ${p.world}`, onClick: () => assignShow(idx, 'perf', p.id) })),
      ...G.targets.filter(t => t.lv === 4).map(t => ({ label: `${t.name} · 本世界 Lv4（晋升献演）`, onClick: () => assignShow(idx, 'target', t.id) }))
    ];
    if (!choices.length) { notify('warn', '无人可演', '既无空闲演员，也无 Lv4 沦陷者。'); return; }
    eventDialog({ title: '安排演出', body: '选择登台的伶人——本世界 Lv4 目标的献演，将解锁晋升仪式的一环。', choices });
  }));
}
function assignShow(idx, kind, id) {
  const slot = G.schedule[idx];
  if (kind === 'target') {
    const t = tgtById(id);
    slot.perf = id;
    slot.booked = true;
    slot.revenue = Math.round(9000 * upgradeMul());
    G.trainedUtopia = true;
    RES.money += slot.revenue;
    notify('corrupt', '晋升献演', `${t.name} 在乌托邦完成登台——她的最后一层防线在聚光灯下瓦解。`);
  } else {
    const p = perfById(id);
    slot.perf = id;
    slot.booked = true;
    slot.revenue = Math.round(p.fee * 24 * (1 + p.skill / 100) * upgradeMul());
    RES.money += slot.revenue;
    notify('success', '排期完成', `${p.name} 将于 ${slot.time} 登台，营收 ¥${slot.revenue.toLocaleString()}。`);
  }
  renderStage(); renderHud();
}

/* ---------- 整卡图通用（演员 / 黑市：与目标卡同库，键前缀区分） ---------- */
const PERF_PAGE_SIZE = 5;
const MKT_PAGE_SIZE = 5;

function cardFillHtml(key, icon, name) {
  const img = getCustomPortrait(key);
  return img
    ? `<img class="tg-img" src="${img}" alt="${esc(name || '')}">`
    : `<span class="tg-fallback"><b>${esc((name || '?').slice(1, 2))}</b><i>未上传图像</i></span>`;
}
function pickEntityPortrait(key, rerender) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.hidden = true;
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (f) handlePhotoFile(f, key, rerender, () => notify('warn', '保存失败', '浏览器存储空间不足，图像未能保存。'));
  };
  document.body.appendChild(inp);
  inp.click();
  setTimeout(() => inp.remove(), 60000);
}
function delEntityPortrait(key, name, rerender) {
  confirmDialog({
    title: '删除图像', okText: '删除',
    body: `${esc(name)} 的卡面图像将被删除，恢复默认样式，此操作不可撤销。`,
    onOk: () => { setCustomPortrait(key, null); notify('info', '已删除', `${esc(name)} 的图像已移除。`); rerender(); }
  });
}
/* 悬停工具：上传图 / 删图 / 删卡（表演者与黑市卡通用） */
function entityHoverTools(key, name, rerender, delKind) {
  const has = !!getCustomPortrait(key);
  const bare = key.replace(/^(perf|mkt):/, '');
  return `<div class="tg-hover">
    <b class="tg-name">${esc(name)}</b>
    <div class="tg-tools">
      <button class="qbtn" data-ent-upload="${key}" title="上传图像">${ic('i-camera')}</button>
      ${has ? `<button class="qbtn" data-ent-delimg="${key}" title="删除图像">${ic('i-trash')}</button>` : ''}
      <button class="qbtn qbtn-del" data-ent-del="${delKind}:${bare}" title="删除此卡">${ic('i-x')}</button>
    </div>
  </div>`;
}
function bindEntityImageTools(rerender) {
  $$('[data-ent-upload]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); pickEntityPortrait(b.dataset.entUpload, rerender); }));
  $$('[data-ent-delimg]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const name = b.closest('article')?.querySelector('.tg-name')?.textContent || '该人物';
    delEntityPortrait(b.dataset.entDelimg, name, rerender);
  }));
  $$('[data-ent-del]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const [kind, ...rest] = b.dataset.entDel.split(':');
    const key = rest.join(':').replace(/^(perf|mkt):/, '');   // 图像键自带前缀，剥掉
    const name = b.closest('article')?.querySelector('.tg-name')?.textContent || '该人物';
    if (kind === 'perf') deletePerformer(key, name, rerender);
    if (kind === 'mkt') deleteMarketItem(key, name, rerender);
    if (kind === 'tgt') deleteTargetCard(key, name, rerender);
  }));
}
function deletePerformer(id, name, rerender) {
  confirmDialog({
    title: '删除演员', okText: '删除',
    body: `将把「${esc(name)}」从乌托邦演员名录中移除，此操作不可撤销。`,
    onOk: () => {
      const i = G.performers.findIndex(p => p.id === id || p.name === id);
      if (i >= 0) G.performers.splice(i, 1);
      setCustomPortrait('perf:' + id, null);
      notify('info', '已删除', `「${esc(name)}」已离开乌托邦。`);
      rerender();
    }
  });
}
function deleteMarketItem(id, name, rerender) {
  confirmDialog({
    title: '下架商品', okText: '下架',
    body: `将把「${esc(name)}」从跨界黑市货架撤下，此操作不可撤销。`,
    onOk: () => {
      const i = MARKET.findIndex(m => m.id === id || m.name === id);
      if (i >= 0) MARKET.splice(i, 1);
      setCustomPortrait('mkt:' + id, null);
      notify('info', '已下架', `「${esc(name)}」已从黑市撤下。`);
      rerender();
    }
  });
}
function deleteTargetCard(id, name, rerender) {
  confirmDialog({
    title: '删除目标', okText: '删除',
    body: `将删除「${esc(name)}」的整份腐化目标档案（含图像），此操作不可撤销。`,
    onOk: () => {
      const i = G.targets.findIndex(t => t.id === id);
      if (i >= 0) G.targets.splice(i, 1);
      setCustomPortrait(id, null);
      if (G.focusId === id) { G.focusId = null; G.tgtOpen = false; }
      notify('info', '档案已销毁', `「${esc(name)}」的档案已从名单中抹去。`);
      rerender();
      if (typeof renderHud === 'function') renderHud();
    }
  });
}
/* 服务行：观看表演 / 性行为服务 —— 默认档位滚动选择（各档价格不同）+ 生成正文 */
/* 表演档位：她的腐化等级多少，就有 Lv1..Lv 几的时装秀，情景再现同样分等级
   （重演她堕落到该等级的那一刻），同级再现比时装秀贵一半。 */
function svcSelectHtml(p, kind) {
  const opt = o => `<option value="${esc(o.label)}" data-price="${o.price}">${esc(o.label)} · ${o.price > 0 ? '¥' + o.price.toLocaleString() : '价格面议'}</option>`;
  if (kind === 'show') {
    const fee = p.fee || 0;
    const lv = Math.min(p.lv != null ? p.lv : 0, 5);
    if (lv < 1) {
      return `<select data-svc-sel="${p.id}:show">${opt({ label: '素人首演', price: fee })}</select>`;
    }
    const shows = [], reens = [];
    for (let k = 1; k <= lv; k++) {
      const show = Math.round(fee * (0.4 + 0.6 * k / lv) / 10) * 10;
      shows.push({ label: `Lv${k} 时装秀`, price: show });
      reens.push({ label: `Lv${k} 情景再现`, price: Math.round(show * 1.5 / 10) * 10 });
    }
    return `<select data-svc-sel="${p.id}:show">
      <optgroup label="时装秀">${shows.map(opt).join('')}</optgroup>
      <optgroup label="情景再现">${reens.map(opt).join('')}</optgroup>
    </select>`;
  }
  /* 性行为档位：手 / 口 / 胸 / 性交，价格各不相同 */
  const s = p.svcFee || 0;
  const r10 = v => Math.round(v / 10) * 10;
  return `<select data-svc-sel="${p.id}:sex">
    ${[{ label: '手', price: r10(s * 0.4) }, { label: '口', price: r10(s * 0.6) }, { label: '胸', price: r10(s * 0.8) }, { label: '性交', price: s }].map(opt).join('')}
  </select>`;
}
function svcRowHtml(p, kind) {
  return `<div class="svc-row">
    <span class="svc-label">${kind === 'show' ? '观看表演' : '性行为服务'}</span>
    <div class="svc-in">
      ${svcSelectHtml(p, kind)}
      <button class="svc-go" data-svc-go="${p.id}:${kind}" title="生成正文">生成正文</button>
    </div>
  </div>`;
}
function bindSvcRows() {
  $$('[data-svc-go]').forEach(b => b.addEventListener('click', () => {
    const [pid, kind] = b.dataset.svcGo.split(':');
    const p = perfById(pid);
    if (!p) return;
    const sel = document.querySelector(`[data-svc-sel="${pid}:${kind}"]`);
    if (!sel) return;
    const opt = sel.options[sel.selectedIndex];
    const label = opt ? opt.value : '';
    const price = opt ? +opt.dataset.price || 0 : 0;
    const pay = price > 0 ? `——支付 ¥${price.toLocaleString()}。` : '——价格由她开。';
    const line = kind === 'show'
      ? `我要观看${p.name}的「${label}」${pay}`
      : `我要${p.name}为我提供${label}服务${pay}`;
    switchView('home');
    sendPrompt(line);
  }));
}
/* 静默刷新：让大模型按变量协议补充名单——不进入正文、不写聊天记录 */
async function aiRefreshRoster(kind) {
  if (!(window.TAVERN && TAVERN.ready && TAVERN.ready())) {
    notify('warn', '接口未接入', '先到「酒馆」页配置接口，才能让大模型补充名单。'); return;
  }
  const btnId = kind === 'market' ? '#btn-mkt-refresh' : '#btn-perf-refresh';
  const btn = $(btnId);
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
  notify('info', '正在刷新', kind === 'market' ? '大模型正在为黑市补五件货……' : '大模型正在招募五位新演员……');
  const askText = kind === 'market'
    ? '（系统请求·不进入正文）为跨界黑市一次性补充五位新的异界商品。不要输出任何正文与思考，只输出变量命令，每位格式：先 <set>乌托邦.跨界黑市[姓名] = 来源世界</set> 建档，再补充她各自的 年龄、职业、腐化等级、购买费用 等字段。'
    : '（系统请求·不进入正文）为乌托邦一次性招募五位新的客座演员。不要输出任何正文与思考，只输出变量命令，每位格式：先 <set>乌托邦.客座表演[姓名] = 来源世界</set> 建档，再补充她各自的 年龄、职业、腐化等级、观看表演费、性行为服务费、状态表现 等字段。';
  try {
    await TAVERN.ask(askText, {});
    notify('success', '刷新完成', kind === 'market' ? '黑市货架已补充五件新货。' : '演员名录已补充五位新人。');
  } catch (e) {
    notify('error', '刷新失败', String((e && e.message) || e || '请求失败'));
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    if (kind === 'market') renderMarket(); else renderPerformers();
  }
}
function entityPagerHtml(page, pages, ctlPrev, ctlNext) {
  return `<div class="tgt-pager">
    <button class="btn" id="${ctlPrev}" ${page <= 0 ? 'disabled' : ''}>上一页</button>
    <span class="pager-jump">第 ${page + 1} / ${pages} 页</span>
    <button class="btn" id="${ctlNext}" ${page >= pages - 1 ? 'disabled' : ''}>下一页</button>
  </div>`;
}

function renderPerformers() { persistOnRender();
  if (G.perfPage == null) G.perfPage = 0;
  const pages = Math.max(1, Math.ceil(G.performers.length / PERF_PAGE_SIZE));
  G.perfPage = Math.min(G.perfPage, pages - 1);
  const list = G.performers.slice(G.perfPage * PERF_PAGE_SIZE, (G.perfPage + 1) * PERF_PAGE_SIZE);
  const rerender = renderPerformers;

  $('#pane-performers').innerHTML = `
    <div class="pane-head-row">
      <p class="view-sub">来自不同世界的被腐化女性，在此以技艺换得庇护与沉溺 · 共 ${G.performers.length} 名</p>
      <button class="btn btn-sm" id="btn-perf-refresh">${ic('i-refresh')}刷新名单（补五人）</button>
    </div>
    <div class="perf-grid five">
      ${Array.from({ length: PERF_PAGE_SIZE }, (_, i) => {
        const p = list[i];
        if (!p) return `<div class="perf-card is-empty"><span class="perf-empty-hint">${ic('i-stage')}<i>虚位以待</i></span></div>`;
        const key = 'perf:' + p.id;
        const lv = p.lv != null ? p.lv : null;
        return `
        <article class="perf-card has-img" data-perf-id="${esc(p.id)}">
          <div class="card-face">
            ${cardFillHtml(key, p.icon || 'i-stage', p.name)}
            <span class="perf-lv-badge ${lv != null ? 'l' + lv : ''}">${lv != null ? 'Lv' + lv + ' ' + LV_NAME(lv) : '客座'}</span>
            <div class="face-info">
              <div class="ci-name">${esc(p.name)}<span class="ci-world">${ic('i-globe')}${esc(p.world || '未知界域')}</span></div>
              <div class="ci-meta">${p.age != null ? p.age + ' 岁' : '年龄 —'} · ${esc(p.job || '职业 —')}</div>
              <div class="ci-state">
                ${p.behavior ? `<span><b>行为</b>${esc(p.behavior)}</span>` : ''}
                ${p.thought ? `<span><b>想法</b>${esc(p.thought)}</span>` : ''}
                ${p.makeup ? `<span><b>妆容</b>${esc(p.makeup)}</span>` : ''}
                ${p.outfit ? `<span><b>服装</b>${esc(p.outfit)}</span>` : ''}
              </div>
            </div>
            ${entityHoverTools(key, p.name, rerender, 'perf')}
          </div>
          <div class="card-ops">
            ${svcRowHtml(p, 'show')}
            ${svcRowHtml(p, 'sex')}
          </div>
        </article>`;
      }).join('')}
    </div>
    ${entityPagerHtml(G.perfPage, pages, 'perf-prev', 'perf-next')}`;

  $('#perf-prev').onclick = () => { G.perfPage--; renderPerformers(); };
  $('#perf-next').onclick = () => { G.perfPage++; renderPerformers(); };
  $('#btn-perf-refresh').onclick = () => aiRefreshRoster('perf');
  bindEntityImageTools(renderPerformers);
  bindSvcRows();
}

function renderBusiness() { persistOnRender();
  const todayRevenue = G.schedule.filter(s => s.booked).reduce((a, s) => a + s.revenue, 0);
  $('#pane-business').innerHTML = `
    <div class="biz-summary">
      <div class="biz-cell"><b>¥${todayRevenue.toLocaleString()}</b><span>今夜总营收</span></div>
      <div class="biz-cell"><b>${G.schedule.filter(s => s.booked).length}/${G.schedule.length}</b><span>已排场次</span></div>
      <div class="biz-cell"><b>×${upgradeMul().toFixed(2)}</b><span>当前营收倍率</span></div>
    </div>
    <div class="section-title">场馆升级 · 永久提升每场营收</div>
    <div class="upg-list">
      ${UPGRADES.map((u, i) => {
        const owned = G.upgrades.has(u.id);
        return `
        <div class="upg-row" style="--d:${i * 55}ms">
          <span class="upg-ic">${ic(u.icon)}</span>
          <div class="upg-main"><b>${u.name}</b><p>${u.desc}</p></div>
          ${owned ? `<span class="owned-tag">${ic('i-check')}已建成</span>`
            : `<span class="upg-price">${ic('i-coin')} ¥${u.price.toLocaleString()}</span>
               <button class="btn ${RES.money >= u.price ? 'btn-primary' : ''}" data-upg="${u.id}" ${RES.money >= u.price ? '' : 'disabled'}>建造</button>`}
        </div>`;
      }).join('')}
    </div>`;
  $$('#pane-business [data-upg]').forEach(b => b.addEventListener('click', () => {
    const u = UPGRADES.find(x => x.id === b.dataset.upg);
    if (RES.money < u.price) { notify('error', '资金不足', `建造「${u.name}」需要 ¥${u.price.toLocaleString()}。`); return; }
    RES.money -= u.price;
    G.upgrades.add(u.id);
    notify('success', '建造完成', `「${u.name}」已投入使用。`);
    renderBusiness(); renderHud();
  }));
}

function renderMarket() { persistOnRender();
  if (G.mktPage == null) G.mktPage = 0;
  const pages = Math.max(1, Math.ceil(MARKET.length / MKT_PAGE_SIZE));
  G.mktPage = Math.min(G.mktPage, pages - 1);
  const list = MARKET.slice(G.mktPage * MKT_PAGE_SIZE, (G.mktPage + 1) * MKT_PAGE_SIZE);
  const rerender = renderMarket;

  $('#pane-market').innerHTML = `
    <div class="pane-head-row">
      <p class="view-sub">以现金购入其他世界的腐化女性——买下即跨过世界之门，货架随买随空 · 现有 ${MARKET.length} 件</p>
      <button class="btn btn-sm" id="btn-mkt-refresh">${ic('i-refresh')}刷新货架（补五件）</button>
    </div>
    <div class="perf-grid five">
      ${Array.from({ length: MKT_PAGE_SIZE }, (_, i) => {
        const m = list[i];
        if (!m) return `<div class="perf-card is-empty"><span class="perf-empty-hint">${ic('i-portal')}<i>等待补货</i></span></div>`;
        const key = 'mkt:' + m.id;
        const rarity = m.rarity === 'legend' ? '传说' : m.rarity === 'epic' ? '奇珍' : m.rarity ? '稀有' : '';
        const afford = RES.money >= (m.price || 0);
        return `
        <article class="perf-card has-img market-card" data-mkt-id="${esc(m.id)}">
          <div class="card-face">
            ${cardFillHtml(key, 'i-portal', m.name)}
            ${rarity ? `<span class="perf-lv-badge r-${esc(m.rarity)}">${rarity}</span>` : ''}
            ${m.lv != null ? `<span class="perf-lv-badge corner-2 ${'l' + m.lv}">Lv${m.lv} ${LV_NAME(m.lv)}</span>` : ''}
            <div class="face-info">
              <div class="ci-name">${esc(m.name)}<span class="ci-world">${ic('i-globe')}${esc(m.world || '未知界域')}</span></div>
              <div class="ci-meta">${m.age != null ? m.age + ' 岁' : '年龄 —'} · ${esc(m.job || '职业 —')}</div>
            </div>
            ${entityHoverTools(key, m.name, rerender, 'mkt')}
          </div>
          <div class="card-ops">
            <div class="svc-row">
              <span class="svc-label">购买费用</span><span class="svc-fee">${ic('i-coin')}¥${m.price != null ? m.price.toLocaleString() : '—'}</span>
              <button class="btn btn-sm ${afford ? 'btn-primary' : 'btn-ghost'} btn-buy" data-buy="${m.id}" ${afford ? '' : 'disabled'}>${ic('i-portal')}黑市购买</button>
            </div>
          </div>
        </article>`;
      }).join('')}
    </div>
    ${entityPagerHtml(G.mktPage, pages, 'mkt-prev', 'mkt-next')}`;

  $('#mkt-prev').onclick = () => { G.mktPage--; renderMarket(); };
  $('#mkt-next').onclick = () => { G.mktPage++; renderMarket(); };
  $('#btn-mkt-refresh').onclick = () => aiRefreshRoster('market');
  $$('#pane-market [data-buy]').forEach(b => b.addEventListener('click', () => {
    const m = MARKET.find(x => x.id === b.dataset.buy);
    if (!m) return;
    if (RES.money < (m.price || 0)) { notify('error', '资金不足', `购入 ${m.name} 需要 ¥${(m.price || 0).toLocaleString()}。`); return; }
    RES.money -= (m.price || 0);
    /* 买下即下架：条目从货架移除，跨过世界之门成为目标 + 演员 */
    const i = MARKET.indexOf(m);
    if (i >= 0) MARKET.splice(i, 1);
    const t = { id: 't' + m.id, name: m.name, title: m.job || '异界来客', age: m.age || 22,
                loc: '乌托邦', lv: m.lv ?? 3, xp: 0, rel: '',
                behavior: '刚跨过世界之门', thought: '……', makeup: '异界浓妆',
                outfit: '流光戏服', schedule: '待定' };
    G.targets.push(t);
    if (!perfById(m.id))
      G.performers.push({ id: m.id, name: m.name, world: m.world, icon: 'i-portal',
                          skill: randInt(80, 96), charm: randInt(82, 95), loyalty: randInt(55, 70),
                          fee: Math.round((m.price || 0) / 4), svcFee: Math.round((m.price || 0) / 8), lv: m.lv ?? 3 });
    /* 她的卡面图像跟随本人：黑市图 → 演员图 */
    const img = getCustomPortrait('mkt:' + m.id);
    if (img) { setCustomPortrait('perf:' + m.id, img); setCustomPortrait('mkt:' + m.id, null); }
    notify('success', '异界交易', `${m.name} 已跨越世界之门——加入演员名录，档案同步建立。`);
    renderMarket(); renderPerformers(); renderTargets(); renderHud();
  }));
  bindEntityImageTools(renderMarket);
}

/* ---------- 城市地图 ---------- */
let mapSel = 'west';
let placeSel = null;

/* 【变量协议出口】中文地名 ↔ 地点 id 双向映射。
   vars.js 写的是「地图.西城区[市政厅].腐化目标」，键是中文地名；
   而地图渲染用的是 PLACES 的英文 id。这里搭一层桥，两边都能寻址。 */
const PLACE_ALIAS = (function () {
  const m = {};
  Object.keys(PLACES).forEach(id => {
    m[PLACES[id].name] = id;
    m[id] = id;
  });
  return m;
})();
/* 【变量协议出口】地点 id → vars.js 用的「区名」桶键（西城区/东城区/休闲区）。
   DISTRICTS[].name 带后缀（如“西城 · 权力岸”），不能直接当桶键，必须映射。 */
const DISTRICT_BUCKET = { west: '西城区', east: '东城区', leisure: '休闲区' };
function placeIdOf(nameOrId) { return PLACE_ALIAS[nameOrId] || null; }

/* 【变量协议出口】某地点当前的腐化目标键列表：
   以 vars.js 写入的 G.mapPlaces[区][中文地名] 为准，渲染只认这里的返回，
   保证「改了变量，地图立刻变」。 */
function placeCharIds(placeId) {
  const p = PLACES[placeId];
  if (!p) return [];
  const bucket = (G.mapPlaces && G.mapPlaces[DISTRICT_BUCKET[p.district]]) || {};
  return (bucket[p.name] || []).slice();
}

/* 【沙盒拓展】大模型经变量命令写入的「新地点」（G.mapPlaces 里
   不属于静态 PLACES 的中文地名）：给出确定性的空闲网格坐标，
   让地图无需改代码就能长出新节点。 */
const DYN_ICON_POOL = ['i-map', 'i-leaf', 'i-key', 'i-gem', 'i-music', 'i-wine', 'i-eye', 'i-anchor'];
function dynPlacesOf(districtId) {
  const bucket = (G.mapPlaces && G.mapPlaces[DISTRICT_BUCKET[districtId]]) || {};
  const staticNames = new Set((DISTRICTS.find(d => d.id === districtId) || { places: [] }).places.map(pl => pl[1]));
  const occupied = new Set((DISTRICTS.find(d => d.id === districtId) || { places: [] }).places.map(pl => pl[3] + ',' + pl[4]));
  const out = [];
  Object.keys(bucket).forEach(name => {
    if (staticNames.has(name)) return;   // 本区静态地点走静态渲染
    if (!bucket[name] || !bucket[name].length) return;   // 空地点不占节点
    /* 网格扫描：60px 步进，从上到下找第一个未被占用的交点 */
    let pos = null;
    for (let gy = 180; gy <= MAP_H - 60 && !pos; gy += 60)
      for (let gx = 120; gx <= MAP_W - 120 && !pos; gx += 60)
        if (!occupied.has(gx + ',' + gy)) { pos = [gx, gy]; occupied.add(gx + ',' + gy); }
    if (!pos) pos = [MAP_W / 2, MAP_H / 2];
    out.push({ name, x: pos[0], y: pos[1], icon: DYN_ICON_POOL[[...name].reduce((a, c) => a + c.codePointAt(0), 0) % DYN_ICON_POOL.length] });
  });
  return out;
}
function dynPlaceNames(districtId) { return dynPlacesOf(districtId).map(p => p.name); }

/* 【变量协议出口】地图渲染时用的人物列表：把 id 解析成真实目标，
   并以 id / 名称双寻址兼容（LLM 有时写 ID，有时写中文名）。 */
function placeTargets(placeId) {
  return placeCharIds(placeId)
    .map(k => tgtById(k) || G.targets.filter(t => t.name === k)[0])
    .filter(Boolean);
}
const MAP_W = 900, MAP_H = 620;
const mapView = { x: 0, y: 0, w: MAP_W, h: MAP_H };
let mapDragSuppress = false;
function mapViewApply() { const s = $('#city-map-svg'); if (s) s.setAttribute('viewBox', mapView.x + ' ' + mapView.y + ' ' + mapView.w + ' ' + mapView.h); }
function mapZoomAt(cx, cy, factor) {
  const nw = Math.max(MAP_W / 2.6, Math.min(MAP_W, mapView.w * factor));
  const nh = nw * MAP_H / MAP_W;
  const k = nw / mapView.w;
  mapView.x = Math.max(0, Math.min(MAP_W - nw, cx - (cx - mapView.x) * k));
  mapView.y = Math.max(0, Math.min(MAP_H - nh, cy - (cy - mapView.y) * k));
  mapView.w = nw; mapView.h = nh;
  mapViewApply();
}
function mapSvgPoint(clientX, clientY) {
  const s = $('#city-map-svg');
  const r = s.getBoundingClientRect();
  return [(clientX - r.left) / r.width * mapView.w + mapView.x, (clientY - r.top) / r.height * mapView.h + mapView.y];
}
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function renderMap() {
  const svg = $('#city-map-svg');
  svg.innerHTML = '';
  mapView.x = 0; mapView.y = 0; mapView.w = MAP_W; mapView.h = MAP_H;
  svg.setAttribute('viewBox', '0 0 ' + MAP_W + ' ' + MAP_H);
  const d = DISTRICTS.find(x => x.id === mapSel) || DISTRICTS[0];
  const statusClass = { clean: 'd-clean', seep: 'd-seep', control: 'd-control' };

  // 网格：地点只落在横纵交点上
  for (let gx = 0; gx <= MAP_W; gx += 60) svg.appendChild(svgEl('line', { x1: gx, y1: 0, x2: gx, y2: MAP_H, class: 'map-gridline' + (gx % 180 === 0 ? ' major' : '') }));
  for (let gy = 0; gy <= MAP_H; gy += 60) svg.appendChild(svgEl('line', { x1: 0, y1: gy, x2: MAP_W, y2: gy, class: 'map-gridline' + (gy % 180 === 0 ? ' major' : '') }));

  // 本城区轮廓
  svg.appendChild(svgEl('path', { d: d.d, class: 'map-district ' + (statusClass[d.status] || 'd-clean') }));
  const label = svgEl('text', { class: 'map-region-label', x: 300, y: 96 });
  label.textContent = d.name;
  svg.appendChild(label);

  // 地点节点（静态）
  d.places.forEach(([pid, , picon, x, y]) => {
    const g = svgEl('g', { class: 'map-node', 'data-place': pid, transform: `translate(${x},${y})` });
    const core = svgEl('circle', { class: 'node-core', r: 9, fill: 'rgba(201,164,92,.92)' });
    const use = svgEl('use', { href: '#' + picon, class: 'node-ic', x: -6, y: -6, width: 12, height: 12 });
    const cnt = placeCharIds(pid).length;
    const nl = svgEl('text', { class: 'node-label', x: 0, y: 24 });
    nl.textContent = PLACES[pid].name + (cnt ? ` ·${cnt}` : '');
    g.append(core, use, nl);
    g.addEventListener('click', () => { if (mapDragSuppress) { mapDragSuppress = false; return; } placeSel = pid; renderMapInfo(); });
    svg.appendChild(g);
  });

  // 地点节点（沙盒动态：大模型经变量命令开拓的新地点）
  dynPlacesOf(d.id).forEach(dp => {
    const g = svgEl('g', { class: 'map-node is-dyn', 'data-place': 'dyn:' + dp.name, transform: `translate(${dp.x},${dp.y})` });
    const core = svgEl('circle', { class: 'node-core', r: 9, fill: 'rgba(201,164,92,.92)' });
    const use = svgEl('use', { href: '#' + dp.icon, class: 'node-ic', x: -6, y: -6, width: 12, height: 12 });
    const cnt = ((G.mapPlaces[DISTRICT_BUCKET[d.id]] || {})[dp.name] || []).length;
    const nl = svgEl('text', { class: 'node-label', x: 0, y: 24 });
    nl.textContent = dp.name + (cnt ? ` ·${cnt}` : '');
    g.append(core, use, nl);
    g.addEventListener('click', () => { if (mapDragSuppress) { mapDragSuppress = false; return; } placeSel = 'dyn:' + dp.name; renderMapInfo(); });
    svg.appendChild(g);
  });

  // 玩家标记（位于本城区时显示）
  const here = playerHere(d);
  if (here) {
    const pg = svgEl('g', { transform: `translate(${here[0]},${here[1]})` });
    pg.appendChild(svgEl('circle', { r: 15, fill: 'rgba(229,72,77,.16)' }));
    pg.appendChild(svgEl('circle', { r: 7, fill: '#e5484d', class: 'map-player', style: 'filter:drop-shadow(0 0 8px rgba(229,72,77,.8));transform-origin:center;transform-box:fill-box' }));
    svg.appendChild(pg);
  }

  renderMapInfo();
}

function playerHere(d) {
  const pid = currentPlaceId();
  if (pid && PLACES[pid] && PLACES[pid].district === d.id) {
    const found = d.places.find(pl => pl[0] === pid);
    if (found) return [found[3], found[4]];
  }
  /* 动态地点：玩家坐标的地名命中本区大模型开拓的新地点 */
  const hereName = (CITY.playerLoc.split(' · ')[0] || '').trim();
  const dyn = dynPlacesOf(d.id).find(p => p.name === hereName);
  return dyn ? [dyn.x, dyn.y] : null;
}

function renderMapInfo() { persistOnRender();
  const info = $('#map-info');
  const d = DISTRICTS.find(x => x.id === mapSel) || DISTRICTS[0];
  const st = { clean: ['未接触', 'mi-clean'], seep: ['渗透中', 'mi-seep'], control: ['已控制', 'mi-control'] }[d.status];
  const hint = $('#map-hint');
  if (hint) hint.innerHTML = '<b>切换城区</b>' + d.hint;

  // 地点详情：直接展示在地图页面侧栏（非弹窗）
  if (placeSel && String(placeSel).startsWith('dyn:')) {
    const name = String(placeSel).slice(4);
    const bucket = (G.mapPlaces && G.mapPlaces[DISTRICT_BUCKET[d.id]]) || {};
    const rawNames = (bucket[name] || []).slice();
    const members = rawNames
      .map(k => tgtById(k) || G.targets.filter(t => t.name === k)[0])
      .filter(Boolean);
    const here = CITY.playerLoc.includes(name);
    info.innerHTML = `
      <button class="btn btn-ghost" id="btn-map-back" style="margin-bottom:14px">${ic('i-chevron-right')}返回${d.name}</button>
      <h3>${esc(name)}</h3>
      <span class="mi-status ${st[1]}">${st[0]} · ${d.name} · 沙盒地点</span>
      <p style="margin-top:10px">此地由大模型经变量命令开拓，故事尚未成形——在正文里写下你在这里的遭遇吧。</p>
      <p class="hint-chip" style="margin-top:8px">${ic('i-users')}当前驻留 ${rawNames.length} 人</p>
      <button class="btn btn-primary map-go" id="btn-map-go" ${here ? 'disabled' : ''} style="margin-top:10px">${ic('i-arrow-right')}${here ? '已在此处' : '前往此地'}</button>
      <div class="od-section"><h4>此处之人（点击互动）</h4>
        <div class="mi-people">${rawNames.length ? rawNames.map(nm => {
          const tt = tgtById(nm) || G.targets.filter(t => t.name === nm)[0];
          return tt
            ? `<button class="pc-card" data-pc-target="${tt.id}"><span class="pc-lv l${tt.lv}">Lv${tt.lv} ${LV_NAME(tt.lv)}</span><span class="pc-name">${esc(tt.name)}</span><span class="pc-title">${esc(tt.title)}</span></button>`
            : `<span class="pc-card is-nameonly"><span class="pc-name">${esc(nm)}</span><span class="pc-title">暂无档案</span></span>`;
        }).join('') : '<span class="pc-empty">此地点暂无驻留之人</span>'}</div>
      </div>`;
    $('#btn-map-back').onclick = () => { placeSel = null; renderMapInfo(); };
    $('#btn-map-go').onclick = () => { travelTo('dyn:' + name); renderMapInfo(); };
    $$('#map-info [data-pc-target]').forEach(el => el.addEventListener('click', () => {
      const t = tgtById(el.dataset.pcTarget);
      if (!t) return;
      G.focusId = t.id;
      switchView('targets');
    }));
    return;
  }
  if (placeSel && PLACES[placeSel] && PLACES[placeSel].district === d.id) {
    const p = PLACES[placeSel];
    const rawNames = placeCharIds(placeSel);
    const members = rawNames
      .map(k => tgtById(k) || G.targets.filter(t => t.name === k)[0])
      .filter(Boolean);
    const here = CITY.playerLoc.includes(p.name);
    let linkBtn = '';
    if (p.link) {
      linkBtn = `<button class="btn map-go" id="btn-map-link" style="margin-top:10px">${ic(p.link.mode === 'metro' ? 'i-metro' : 'i-plane')}${p.link.label}</button>`;
    }
    info.innerHTML = `
      <button class="btn btn-ghost" id="btn-map-back" style="margin-bottom:14px">${ic('i-chevron-right')}返回${d.name}</button>
      <h3>${p.name}</h3>
      <span class="mi-status ${st[1]}">${st[0]} · ${d.name}</span>
      <p style="margin-top:10px">${p.desc}</p>
      <p class="hint-chip" style="margin-top:8px">${ic('i-users')}当前驻留 ${rawNames.length} 人</p>
      ${linkBtn}
      <button class="btn btn-primary map-go" id="btn-map-go" ${here ? 'disabled' : ''} style="margin-top:10px">${ic('i-arrow-right')}${here ? '已在此处' : '前往此地'}</button>
      <div class="od-section"><h4>此处之人（点击互动）</h4>
        <div class="mi-people">${rawNames.length ? rawNames.map(nm => {
          const tt = tgtById(nm) || G.targets.filter(t => t.name === nm)[0];
          return tt
            ? `<button class="pc-card" data-pc-target="${tt.id}"><span class="pc-lv l${tt.lv}">Lv${tt.lv} ${LV_NAME(tt.lv)}</span><span class="pc-name">${esc(tt.name)}</span><span class="pc-title">${esc(tt.title)}</span></button>`
            : `<span class="pc-card is-nameonly"><span class="pc-name">${esc(nm)}</span><span class="pc-title">暂无档案</span></span>`;
        }).join('') : '<span class="pc-empty">此地点暂无驻留之人</span>'}</div>
      </div>`;
    const back = $('#btn-map-back');
    back.onclick = () => { placeSel = null; renderMapInfo(); };
    const lk = $('#btn-map-link');
    if (lk) lk.onclick = () => { placeSel = p.link.to; travelTo(p.link.to); renderMapInfo(); };
    $('#btn-map-go').onclick = () => { travelTo(placeSel); renderMapInfo(); };
    $$('#map-info [data-pc-target]').forEach(el => el.addEventListener('click', () => {
      const t = tgtById(el.dataset.pcTarget);
      if (!t) return;
      G.focusId = t.id;
      switchView('targets');
    }));
    return;
  }

  // 城区总览
  info.innerHTML = `
    <h3>${d.name}</h3>
    <span class="mi-status ${st[1]}">${st[0]} · 腐化 ${d.corr}%</span>
    <div class="od-section"><h4>本区地点（点击查看详情）</h4><div class="mi-places">
      ${d.places.map(pl => {
        const pp = PLACES[pl[0]];
        return `<div class="mi-place" data-mi-place="${pl[0]}">${ic(pp.icon)}<b>${pp.name}</b><span class="mi-place-count">${placeCharIds(pl[0]).length}</span></div>`;
      }).join('')}
      ${dynPlacesOf(d.id).map(dp => `
        <div class="mi-place is-dyn" data-mi-place="dyn:${esc(dp.name)}">${ic(dp.icon)}<b>${esc(dp.name)}</b><span class="mi-place-count">${((G.mapPlaces[DISTRICT_BUCKET[d.id]] || {})[dp.name] || []).length}</span></div>`).join('')}
    </div></div>`;
  $$('#map-info [data-mi-place]').forEach(el => el.addEventListener('click', () => { placeSel = el.dataset.miPlace; renderMapInfo(); }));
}

/* ---------- 旅行 ---------- */
function travelTo(placeId, fromChat) {
  /* 沙盒动态地点：'dyn:中文名' */
  if (String(placeId).startsWith('dyn:')) {
    const name = String(placeId).slice(4);
    const d = DISTRICTS.find(x => dynPlaceNames(x.id).includes(name));
    CITY.playerLoc = name + ' · ' + (d ? d.name : '');
    $('#chat-loc-text').textContent = CITY.playerLoc;
    $('#map-sub').textContent = '临江市 · 当前坐标：' + CITY.playerLoc;
    renderHud();
    if (d) { mapSel = d.id; if (G.view === 'map') renderMap(); }
    const rep2 = pick(NARR_REPLIES.go).replace('{road}', '霓虹与车流交织的街道').replace('{place}', name).replace('{scene}', '一片尚未成形的新天地');
    notify('info', '抵达', name);
    locSplash(name, d ? d.name : '');
    if (fromChat) return { type: 'narr', text: rep2 };
    pushMsg('narr', { text: rep2 });
    return null;
  }
  const p = PLACES[placeId];
  if (!p) return null;
  const dist = DISTRICTS.find(d => d.id === p.district);
  CITY.playerLoc = p.name + ' · ' + (dist ? dist.name : '');
  $('#chat-loc-text').textContent = CITY.playerLoc;
  $('#map-sub').textContent = '临江市 · 当前坐标：' + CITY.playerLoc;
  renderHud();
  mapSel = p.district;
  if (G.view === 'map') renderMap();
  const rep = pick(NARR_REPLIES.go).replace('{road}', '霓虹与车流交织的街道').replace('{place}', p.name).replace('{scene}', p.desc);
  notify('info', '抵达', p.name);
  locSplash(p.name, dist ? dist.name : '');
  if (fromChat) return { type: 'narr', text: rep };
  pushMsg('narr', { text: rep });
  return null;
}

/* ---------- 存档 ---------- */
/* ---------- 命名档案制：任意数量的存档，按名存取 ---------- */
let currentArchive = kvGet('active_archive') || null;   // 当前档案名
/* 用户删掉当前档案后置真：自动存档停摆，不再自愈重建——
   否则删掉的存档会在下一次渲染时原样复活。 */
let autosaveSuppressed = false;
function archiveKey(name) { return 'archive:' + name; }
function archiveNames() {
  return Object.keys(KV_MEM).filter(function (k) { return k.indexOf('archive:') === 0; }).map(function (k) { return k.slice(8); });
}
function loadArchive(name) {
  const data = kvGet(archiveKey(name));
  if (!data) return false;
  applySave(data);
  SNAPSHOTS = Array.isArray(data.snapshots) ? data.snapshots.slice() : [];
  currentArchive = name;
  autosaveSuppressed = false;
  kvSet('active_archive', name);
  return true;
}
function saveToArchive(name) {
  const d = attachSnapshots(collectSave());
  d.archivedName = name;
  kvSet(archiveKey(name), d);
  currentArchive = name;
  autosaveSuppressed = false;
  kvSet('active_archive', name);
}
function deleteArchive(name) {
  delete KV_MEM[archiveKey(name)];
  if (window.IDB) IDB.del(archiveKey(name));
  if (currentArchive === name) { currentArchive = null; kvSet('active_archive', null); }
}
/* 深拷贝：collectSave 必须交出「快照那一刻的值」，不能交出活引用。
   曾经这里直接写 G.targets / CITY.time / G.orgs …，于是快照的 data 与
   正在运行的世界指向同一批对象：世界一变，历史快照跟着一起变，
   「退档到此」就等于什么都没退（时间/名单/势力腐化/药剂/物品/地图全不还原），
   而且所有快照共享同一份对象、任何过去都回不去。
   structuredClone 覆盖不到时（老浏览器）退回 JSON 深拷贝。 */
function deepCopy(v) {
  if (v === null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch (e) { /* 含函数/不可克隆 → 走 JSON */ }
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}
function collectSave() {
  return {
    when: Date.now(),
    city: { time: deepCopy(CITY.time), playerLoc: CITY.playerLoc, corruption: CITY.corruption },
    res: { ...RES },
    targets: deepCopy(G.targets), orgs: deepCopy(G.orgs),
    potions: deepCopy(G.potions), methodPct: deepCopy(G.methodPct),
    schedule: deepCopy(G.schedule), performers: deepCopy(G.performers),
    bought: [...G.bought], upgrades: [...G.upgrades],
    /* 跨界黑市货架也是变量数据，不落档刷新就「补货」回出厂 */
    market: MARKET.map(m => ({ ...m })),
    trainedUtopia: G.trainedUtopia, maleDullHours: G.maleDullHours,
    /* 变量内核的新容器：不落存档的话读档后白名单整片空 */
    items: deepCopy(G.items), events: deepCopy(G.events), mapPlaces: deepCopy(G.mapPlaces),
    focusId: G.focusId, trainId: G.trainId,
    /* 视图书签：不存的话刷新/读档后详情页被关、回到默认视图，
       表现为「渲染到目标里的角色页面一刷新就没了」。 */
    view: G.view, tgtOpen: G.tgtOpen, orgSel: G.orgSel,
    playerName: (G.player && G.player.name) || '',
    player: G.player ? { ...G.player } : null,
    chat: deepCopy(CHAT_LOG)
    /* 注意：这里故意【不含】snapshots。
       collectSave 会被 makeSnapshot 调用（快照里存整个存档），
       若把 snapshots 也放进来就会自我嵌套：每条快照都装着之前所有快照，
       指数膨胀。快照集由 saveToArchive 单独附加（见 attachSnapshots）。 */
  };
}
/* 快照集随档封存：只有「写档案」时才带上，且深拷贝，避免共享同一份数组。 */
function attachSnapshots(d) {
  d.snapshots = deepCopy(SNAPSHOTS);
  return d;
}
/* ============================================================
   自动存档：游戏状态持久化（刷新页面不丢）
   ------------------------------------------------------------
   以前只有聊天记录 / UI 视图书签 / 玩家档案 / 设置写了 localStorage，
   世界状态（G.targets / 势力 / 资源 / 地图…）全在内存，
   刷新后直接回出厂值 —— 表现为「左侧目标一刷新就没了」。
   这里给世界状态加一份自动快照（与手动存档槽分离）。
   ============================================================ */
let autosaveTimer = 0;
/* 写快照（IndexedDB）。节流：同一帧内多次变更只写一次。 */
function persistGame() {
  /* 当前进度写进当前命名档案。
     ① 用户删掉了当前档案（autosaveSuppressed）→ 停摆，不再自动重建；
     ② 没有任何活动档案（首次进入 / 档案被删光）→ 同样不落盘，
        等玩家「新的游戏」或读取某个档案时再建档——
        旧的「自动兜底建 自动进度」会让删除操作形同虚设。 */
  if (autosaveSuppressed) return;
  var name = currentArchive || kvGet('active_archive');
  if (!name) return;
  currentArchive = name;
  kvSet('active_archive', name);
  kvSet(archiveKey(name), attachSnapshots(collectSave()));
}
function persistGameSoon() {
  if (autosaveTimer) return;
  autosaveTimer = setTimeout(function () { autosaveTimer = 0; persistGame(); }, 300);
}
/* 渲染即存档：任何 render* 之后 300ms 落盘一次（覆盖全部交互路径）。 */
function persistOnRender() { if (gameReady) persistGameSoon(); }
function loadPersistedGame() {
  var name = kvGet('active_archive') || currentArchive;
  return name ? kvGet(archiveKey(name)) : null;
}

/* 新开档：把世界状态退回出厂值（与启动时 G 的初值一致）。
   不重置的话，自动存档恢复的上一局数据会被带进新档。 */
function resetWorldState() {
  G.targets = TARGETS.map(t => ({ ...t }));
  G.orgs = ORGS.map(o => ({ ...o }));
  G.performers = PERFORMERS.map(p => ({ ...p }));
  G.potions = { single: POTIONS.single.count, gas: POTIONS.gas.count,
    male: POTIONS.male.count, oath: POTIONS.oath.count };
  G.methodPct = TRAIN_METHODS.map(m => ({ id: m.id, pct: m.pct }));
  G.schedule = SCHEDULE.map(s => ({ ...s }));
  MARKET.length = 0;   /* 黑市货架完全由变量生成，新档清空 */
  G.bought = new Set(); G.upgrades = new Set();
  G.trainedUtopia = false; G.maleDullHours = 0;
  G.items = {}; G.events = { queue: [], mayor: { triggered: false }, random: {} };
  G.mapPlaces = { '西城区': {}, '东城区': {}, '休闲区': {} };
  G.view = 'home'; G.tgtOpen = false; G.orgSel = null; G.trainId = null;
  G.focusId = 'suwanqing';
  RES.money = 28400; RES.rep = 34;
  CITY.corruption = 31;
  CITY.time = { date: '9月13日', weekday: '周日', hour: 21, minute: 0, weather: '雾', weatherIc: 'i-cloud' };
  CITY.playerLoc = '家 · 西城 ';
  if (window.VARS && window.VARS.init) window.VARS.init();
}

function applySave(data, opts) {
  opts = opts || {};
  Object.assign(CITY.time, data.city.time);
  CITY.playerLoc = data.city.playerLoc;
  CITY.corruption = data.city.corruption;
  Object.assign(RES, data.res);
  /* 深拷贝落库的对象再交给运行时：否则读档后「存档里的对象」与「正在玩的对象」
     是同一份，改动会就地写回存档缓冲，快照退档又退不动。 */
  G.targets = deepCopy(data.targets); G.orgs = deepCopy(data.orgs);
  G.potions = deepCopy(data.potions); G.methodPct = deepCopy(data.methodPct);
  G.schedule = deepCopy(data.schedule); G.performers = deepCopy(data.performers);
  G.bought = new Set(data.bought); G.upgrades = new Set(data.upgrades);
  if (Array.isArray(data.market)) { MARKET.length = 0; MARKET.push(...data.market); }
  G.trainedUtopia = data.trainedUtopia; G.maleDullHours = data.maleDullHours || 0;
  G.items = deepCopy(data.items) || {}; G.events = deepCopy(data.events) || { queue: [], mayor: { triggered: false }, random: {} };
  G.mapPlaces = deepCopy(data.mapPlaces) || { '西城区': {}, '东城区': {}, '休闲区': {} };
  G.focusId = data.focusId || G.focusId; G.trainId = data.trainId;
  /* 档案自带快照集；但「退档到某条快照」时传入的是快照自己的 data，
     它不含 snapshots —— 此时必须保留现有快照列表，否则一退档快照就全没了。 */
  if (Array.isArray(data.snapshots)) SNAPSHOTS = deepCopy(data.snapshots);
  /* 视图恢复：view 与 tgtOpen 必须成对恢复，否则会出现「在详情页但视图是 home」
     或「视图是 targets 但详情页被重置」的错位。 */
  G.view = data.view || G.view;
  G.tgtOpen = !!data.tgtOpen;
  G.orgSel = data.orgSel || G.orgSel;
  if (G.view !== 'targets') G.tgtOpen = false;
  if (window.VARS && window.VARS.init) window.VARS.init();   // 旧存档缺新字段 → 补齐
  /* 恢复该档的玩家身份（多档可能是不同角色） */
  if (data.player && data.player.name) { G.player = { ...data.player }; savePlayer(G.player); }
  /* opts.silent：刷新恢复时不要重刷聊天区（聊天另走 CHAT_* 快照，
     这里重刷会把还没恢复的聊天区清掉）。 */
  if (opts.silent) return;
  renderAllGame();
  renderMap(); renderStage(); renderPerformers(); renderBusiness(); renderMarket();
  /* 切回存档时的视图（renderAllGame 只刷内容不切显隐）。
     switchView 会按 view 重渲，含 targets 下的 tgtOpen 分支。 */
  switchView(G.view);
  if (Array.isArray(data.chat)) restoreChat(data.chat);
  $('#map-sub').textContent = '临江市 · 当前坐标：' + CITY.playerLoc;
}
/* ============================================================
   世界状态快照（退档）
   ------------------------------------------------------------
   每次生成一段新叙述后自动打点一条，快照含世界状态 + 对话。
   快照属于「当前存档」：新开档清空、读档替换为该档的快照集、
   手动存档时随存档一起封存 —— 因此列表里只会有当前存档的内容。
   ============================================================ */
const SNAPSHOT_KEY = 'fushicheng_snapshots_v1';
const SNAPSHOT_MAX = 30;
let SNAPSHOTS = [];
/* 快照集随「档案」持久化（attachSnapshots → archive 的 data.snapshots），
   这是唯一真正被读回的通路；这里的独立键只作旧数据留存，不再假装是权威副本。 */
function persistSnapshots() { kvSet('snapshots', SNAPSHOTS); kvSet(SNAPSHOT_KEY, SNAPSHOTS); }
/* 快照时刻的正文：最近一条叙述 */
function latestNarrText() {
  for (let i = CHAT_LOG.length - 1; i >= 0; i--) {
    if (CHAT_LOG[i] && CHAT_LOG[i].type === 'narr') return CHAT_LOG[i].text || '';
  }
  return '';
}
function snapshotSignature() {
  return [CITY.time.date, CITY.time.hour, CITY.time.minute,
    CITY.corruption, RES.money, G.targets.length, CHAT_LOG.length].join('|');
}
/* 每次生成新叙述后打一条快照；同一状态不重复打点。 */
function makeSnapshot() {
  if (!gameReady) return;
  const sig = snapshotSignature();
  if (SNAPSHOTS.length && SNAPSHOTS[0].sig === sig) return;
  SNAPSHOTS.unshift({
    id: 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    when: Date.now(),
    sig: sig,
    city: CITY.time.date + ' ' + pad2(CITY.time.hour) + ':' + pad2(CITY.time.minute),
    text: latestNarrText(),
    data: collectSave()
  });
  while (SNAPSHOTS.length > SNAPSHOT_MAX) SNAPSHOTS.pop();
  persistSnapshots();
  if ($('#modal-snapshot') && !$('#modal-snapshot').hidden) renderSnapshotList();
}
function renderSnapshotList() {
  const box = $('#snapshot-list');
  if (!box) return;
  const scope = $('#snap-scope');
  if (scope) scope.textContent = SNAPSHOTS.length ? ('共 ' + SNAPSHOTS.length + ' 条 · 仅当前存档') : '仅当前存档';
  box.innerHTML = SNAPSHOTS.length ? SNAPSHOTS.map(s => `
    <div class="snap-item">
      <div class="snap-main">
        <div class="snap-head"><time>${new Date(s.when).toLocaleString('zh-CN')}</time><span>${esc(s.city || '')}</span></div>
        <p>${s.text ? esc(s.text.length > 90 ? s.text.slice(0, 90) + '…' : s.text) : '<i>（无正文）</i>'}</p>
      </div>
      <button class="btn btn-ghost" data-load-snap="${s.id}">${ic('i-refresh')}读取</button>
    </div>`).join('')
    : '<p class="snap-empty">尚无快照——生成一段叙述后会自动打点。</p>';
  box.querySelectorAll('[data-load-snap]').forEach(b => b.addEventListener('click', () => {
    const s = SNAPSHOTS.find(x => x.id === b.dataset.loadSnap);
    if (!s || !s.data) return;
    confirmDialog({
      title: '读取快照', okText: '退档到此',
      body: '将回到 ' + new Date(s.when).toLocaleString('zh-CN') + ' 的世界状态与对话。当前进度会先存为一条快照，可再退回来。',
      onOk: () => {
        makeSnapshot();                 // 退档前先存当前，可反悔
        applySave(s.data);
        notify('info', '退档完成', '城市回到了该快照的时刻。');
        closeModal('modal-snapshot');
      }
    });
  }));
}
function clearSnapshots() {
  confirmDialog({
    title: '清空快照', okText: '清空',
    body: '将删除当前存档的全部世界状态快照。此操作不可撤销。',
    onOk: () => {
      SNAPSHOTS = [];
      persistSnapshots();
      renderSnapshotList();
      notify('info', '已清空', '世界状态快照已全部删除。');
    }
  });
}

/* 存档管理（HUD 弹窗）：另存为 + 命名档案卡片 */
/* 档案名单一真相：开始菜单与游戏内存档弹窗共用同一排序（最近写入在前），
   保证两边渲染顺序、徽章、元信息完全一致。 */
function sortedArchiveNames() {
  return archiveNames().slice().sort(function (a, b) {
    var wa = (kvGet(archiveKey(a)) || {}).when || 0;
    var wb = (kvGet(archiveKey(b)) || {}).when || 0;
    if (wb !== wa) return wb - wa;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
/* 档案变化后两处列表一起重渲 */
function renderArchiveLists() {
  renderSaveSlots();
  renderGateSlots();
}
function renderSaveSlots() {
  const box = document.getElementById('save-slots');
  if (!box) return;
  var names = sortedArchiveNames();
  var cur = currentArchive || kvGet('active_archive') || '';
  var head = document.createElement('div');
  head.className = 'archive-saveas';
  head.innerHTML = '<input id="arc-name" type="text" maxlength="16" placeholder="为当前进度起个存档名（留空 = 自动命名）">' +
    '<button class="btn btn-primary" id="arc-save-as">' + ic('i-save') + '封存</button>';
  box.innerHTML = '';
  box.appendChild(head);
  var list = document.createElement('div');
  list.className = 'archive-list';
  list.innerHTML = names.length ? names.map(function (n) {
    var d = kvGet(archiveKey(n)) || {};
    var sel = n === cur;
    var meta = archiveMetaLine(d);
    var row = document.createElement('div');
    row.className = 'archive-row' + (sel ? ' is-current' : '');
    row.innerHTML = '<span class="arc-glyph">' + esc((d.playerName || n).slice(0, 1)) + '</span>' +
      '<div class="arc-info">' +
      '<b>' + esc(n) + (sel ? '<span class="arc-cur">当前</span>' : '') + '</b>' +
      '<p class="arc-meta">' + ic('i-user') + meta.player + '<i class="dot-sep"></i>' + ic('i-calendar') + meta.time + '</p>' +
      '<p class="arc-meta">' + ic('i-coin') + meta.money + '<i class="dot-sep"></i>' + ic('i-users') + meta.targets + '</p>' +
      '</div>' +
      '<div class="arc-tools">' +
      (sel ? '<span class="owned-tag">' + ic('i-check') + '当前进度</span>' : '<button class="btn" data-arc-load="' + esc(n) + '">' + ic('i-refresh') + '读取</button>') +
      '<button class="btn btn-ghost" data-arc-overwrite="' + esc(n) + '" title="把当前进度覆盖到这里">' + ic('i-save') + '</button>' +
      '<button class="btn btn-ghost slot-del" data-arc-del="' + esc(n) + '" title="删除">' + ic('i-x') + '</button>' +
      '</div>';
    return row.outerHTML;
  }).join('') : '<p class="arc-empty">还没有存档——上方为当前进度命名并封存。</p>';
  box.appendChild(list);
  var saveAs = document.getElementById('arc-save-as');
  if (saveAs) saveAs.onclick = function () {
    var name = (document.getElementById('arc-name').value || '').trim() || ('档案 · ' + new Date().toLocaleString('zh-CN'));
    saveToArchive(name);
    notify('success', '封存完成', '进度已封存为「' + name + '」。');
    renderArchiveLists();
  };
  box.querySelectorAll('[data-arc-load]').forEach(function (b) { b.onclick = function () {
    if (loadArchive(b.dataset.arcLoad)) { notify('info', '读取完成', '已回到「' + b.dataset.arcLoad + '」。'); renderArchiveLists(); }
  }; });
  box.querySelectorAll('[data-arc-overwrite]').forEach(function (b) { b.onclick = function () {
    kvSet(archiveKey(b.dataset.arcOverwrite), attachSnapshots(collectSave()));
    notify('success', '覆盖完成', '「' + b.dataset.arcOverwrite + '」已更新为当前进度。');
    renderArchiveLists();
  }; });
  box.querySelectorAll('[data-arc-del]').forEach(function (b) { b.onclick = function () {
    var name = b.dataset.arcDel;
    var wasCurrent = name === (currentArchive || kvGet('active_archive'));
    confirmDialog({ title: '删除存档', okText: '删除', body: '将删除存档「' + name + '」及其快照。此操作不可撤销。', onOk: function () {
      deleteArchive(name);
      notify('info', '已删除', '存档「' + name + '」已清除。');
      if (wasCurrent) {
        /* 删的是当前进度：自动存档停摆 + 清掉聊天/快照缓存（否则刷新后
           会凭残留快照复活成新档案），然后回到开始菜单。 */
        autosaveSuppressed = true;
        restoreChat([]);
        SNAPSHOTS = [];
        persistSnapshots();
        renderArchiveLists();
        returnToMenu();
      } else {
        renderArchiveLists();
      }
    } });
  }; });
}

/* 档案卡元信息行：角色 · 游戏内时间 · 现金 · 目标数 */
function archiveMetaLine(d) {
  var t = (d.city && d.city.time) || {};
  return {
    player: d.playerName || '无名者',
    time: (t.date || '') + (t.hour != null ? ' ' + pad2(t.hour) + ':' + pad2(t.minute || 0) : ''),
    money: fmtMoney((d.res && d.res.money) || 0),
    targets: ((d.targets && d.targets.length) || 0) + ' 名目标'
  };
}

/* ---------- 设置 ---------- *//* ---------- 设置 ---------- */
const SET_KEY = 'fushicheng_settings_v1';
/* ---------- 智绘姬悬浮球开关（读写文生图扩展的设置） ---------- */
function chatuFabEnabled() {
  const es = window.ST_HOST && ST_HOST.extensionSettings;
  const cfg = es && es['st-chatu8'];
  if (!cfg || cfg.enable_chatu8_fab === undefined) return true;   /* 默认显示 */
  return !(cfg.enable_chatu8_fab === false || String(cfg.enable_chatu8_fab) === 'false');
}
function setChatuFab(on) {
  const es = window.ST_HOST && ST_HOST.extensionSettings;
  if (es) {
    es['st-chatu8'] = es['st-chatu8'] || {};
    es['st-chatu8'].enable_chatu8_fab = on;
    if (typeof ST_HOST.saveExtensionSettings === 'function') ST_HOST.saveExtensionSettings();
  }
  /* 立即生效；扩展下次启动也会读到同一份设置 */
  const fab = document.getElementById('st-chatu8-fab');
  if (fab) fab.style.display = on ? 'flex' : 'none';
}

function loadSettings() {
  const s = kvGet('settings') || {};
  if (typeof s.fx === 'boolean') G.settings.fx = s.fx;
  if (typeof s.sandbox === 'boolean') G.settings.sandbox = s.sandbox;
  if (typeof s.ritual === 'boolean') G.settings.ritual = s.ritual;
  if (typeof s.dmColor === 'string') G.settings.dmColor = s.dmColor;
  if (typeof s.dmSpeed === 'string') G.settings.dmSpeed = s.dmSpeed;
}
function saveSettings() { kvSet('settings', G.settings); }
function renderSettings() {
  $('#settings-body').innerHTML = `
    <div class="setting-row">
      <div><b>浮尘粒子</b><p>背景中缓慢上浮的鎏金微尘（关闭可提升低端设备性能）</p></div>
      <label class="switch"><input type="checkbox" id="set-fx" ${G.settings.fx ? 'checked' : ''}><i></i></label>
    </div>
    <div class="setting-row">
      <div><b>秘仪法阵</b><p>背景深处缓慢旋转的法阵纹样</p></div>
      <label class="switch"><input type="checkbox" id="set-ritual" ${G.settings.ritual ? 'checked' : ''}><i></i></label>
    </div>
    <div class="setting-row">
      <div><b>风灵月影</b><p>解锁风灵月影面板：自由改写资源、等级与势力，跳过养成直接体验全部系统</p></div>
      <label class="switch"><input type="checkbox" id="set-sandbox" ${G.settings.sandbox ? 'checked' : ''}><i></i></label>
    </div>
    <div class="setting-row">
      <div><b>智绘姬悬浮球</b><p>屏幕上的智绘姬文生图悬浮球（设置保存在文生图扩展中）</p></div>
      <label class="switch"><input type="checkbox" id="set-chatu-fab" ${chatuFabEnabled() ? 'checked' : ''}><i></i></label>
    </div>
    <div class="setting-row">
      <div><b>变量弹幕</b><p>LLM 用 &lt;set&gt; 改写状态时，从右往左飘一条确认</p></div>
      <span class="hint-chip">${ic('i-spark')}已启用</span>
    </div>
    <div class="setting-row">
      <div><b>弹幕颜色</b><p>飘过文字的色调</p></div>
      <select class="ai-input" id="set-dm-color">
        ${[['gold', '鎏金'], ['jade', '翡翠'], ['blood', '猩红'], ['cyan', '青蓝'], ['violet', '紫罗兰'], ['ivory', '素白']]
          .map(c => `<option value="${c[0]}" ${G.settings.dmColor === c[0] ? 'selected' : ''}>${c[1]}</option>`).join('')}
      </select>
    </div>
    <div class="setting-row">
      <div><b>弹幕速度</b><p>横穿屏幕耗时</p></div>
      <select class="ai-input" id="set-dm-speed">
        ${[['fast', '疾（5.5 秒）'], ['normal', '常（9 秒）'], ['slow', '缓（14 秒）']]
          .map(c => `<option value="${c[0]}" ${G.settings.dmSpeed === c[0] ? 'selected' : ''}>${c[1]}</option>`).join('')}
      </select>
    </div>
    <div class="setting-row">
      <div><b>叙事引擎</b><p>本地离线推演 · v3.0（LLM 接口预留）</p></div>
      <span class="hint-chip">${ic('i-info')}内置</span>
    </div>`;
  $('#set-fx').addEventListener('change', e => {
    G.settings.fx = e.target.checked;
    saveSettings();
    fxSetEnabled(G.settings.fx);
  });
  $('#set-ritual').addEventListener('change', e => {
    G.settings.ritual = e.target.checked;
    saveSettings();
    document.querySelector('.ritual').style.display = G.settings.ritual ? '' : 'none';
  });
  $('#set-sandbox').addEventListener('change', e => setSandbox(e.target.checked));
  $('#set-chatu-fab').addEventListener('change', e => {
    setChatuFab(e.target.checked);
    notify(e.target.checked ? 'success' : 'info', '智绘姬悬浮球', e.target.checked ? '悬浮球已显示。' : '悬浮球已隐藏——随时可以回这里打开。');
  });
  $('#set-dm-color').addEventListener('change', e => { G.settings.dmColor = e.target.value; saveSettings(); });
  $('#set-dm-speed').addEventListener('change', e => { G.settings.dmSpeed = e.target.value; saveSettings(); });
}

/* ---------- 风灵月影模式 ---------- */
function setSandbox(on) {
  G.settings.sandbox = on;
  saveSettings();
  $('#btn-hud-sandbox').hidden = !on;
  notify(on ? 'success' : 'info', on ? '风灵月影已开启' : '风灵月影已关闭',
    on ? '点击顶栏的圆形法阵图标，打开风灵月影面板。' : '世界参数回归常规推演。');
  if (on) renderSandboxPanel();
}

function renderSandboxPanel() {
  const box = $('#sandbox-body');
  box.innerHTML = `
    <div class="sandbox-sec">
      <h4>资源</h4>
      <div class="sandbox-actions">
        <button class="btn" data-sb-money="10000">${ic('i-coin')}现金 +1万</button>
        <button class="btn" data-sb-money="100000">${ic('i-coin')}现金 +10万</button>
        <button class="btn" data-sb-money="zero">${ic('i-refresh')}现金清零</button>
      </div>
    </div>
    <div class="sandbox-sec">
      <h4>药剂补给</h4>
      <div class="sandbox-actions">
        <button class="btn" data-sb-potion="5">${ic('i-flask')}全部药剂 +5</button>
        <button class="btn" data-sb-potion="clear">${ic('i-x')}药剂清空</button>
      </div>
    </div>
    <div class="sandbox-sec">
      <h4>目标腐化等级</h4>
      <select class="sb-select" id="sb-target"></select>
      <div class="sandbox-actions">
        <button class="btn" data-sb-lv="0">Lv0 冰清</button>
        <button class="btn" data-sb-lv="1">Lv1 涟漪</button>
        <button class="btn" data-sb-lv="2">Lv2 暗涌</button>
        <button class="btn" data-sb-lv="3">Lv3 沉沦</button>
        <button class="btn" data-sb-lv="4">Lv4 沦陷</button>
        <button class="btn" data-sb-lv="5">Lv5 契缚</button>
        <button class="btn" data-sb-xpmax>${ic('i-trend')}经验拉满</button>
      </div>
      <div class="sandbox-actions">
        <button class="btn btn-primary" data-sb-ritualready>${ic('i-crown')}一键满足晋升条件（Lv4 · 调教圆满 · 登台 · 夜冕之酒）</button>
      </div>
    </div>
    <div class="sandbox-sec">
      <h4>社会组织</h4>
      <div class="sandbox-actions">
        <button class="btn" data-sb-org="max">${ic('i-crown')}全部已控制</button>
        <button class="btn" data-sb-org="seep">${ic('i-wind')}全部渗透中</button>
        <button class="btn" data-sb-org="zero">${ic('i-refresh')}全部归零</button>
      </div>
    </div>
    <div class="sandbox-sec">
      <h4>时间</h4>
      <div class="sandbox-actions">
        <button class="btn" data-sb-time="6">推进 6 小时</button>
        <button class="btn" data-sb-time="24">推进 1 日</button>
      </div>
    </div>`;
  const sel = $('#sb-target');
  sel.innerHTML = G.targets.map(t => `<option value="${t.id}" ${t.id === G.focusId ? 'selected' : ''}>${t.name} · Lv${t.lv}（${t.title}）</option>`).join('');
  const curTgt = () => tgtById(sel.value) || G.targets[0];

  box.querySelectorAll('[data-sb-money]').forEach(b => b.addEventListener('click', () => {
    RES.money = b.dataset.sbMoney === 'zero' ? 0 : RES.money + (+b.dataset.sbMoney);
    renderHud(); renderBackpack(); renderAlchemy();
    notify('success', '风灵月影 · 资源改写', `现金现为 ${fmtMoney(RES.money)}。`);
  }));
  box.querySelector('[data-sb-potion]').addEventListener('click', () => {
    Object.keys(G.potions).forEach(k => G.potions[k] += 5);
    renderHud(); renderBackpack(); renderAlchemy(); renderTraining();
    notify('success', '风灵月影 · 药剂补给', '全部药剂 +5。');
  });
  box.querySelector('[data-sb-potion="clear"]').addEventListener('click', () => {
    Object.keys(G.potions).forEach(k => G.potions[k] = 0);
    renderHud(); renderBackpack(); renderAlchemy(); renderTraining();
    notify('info', '风灵月影 · 药剂清空', '背包里的药剂已全部清空。');
  });
  box.querySelectorAll('[data-sb-lv]').forEach(b => b.addEventListener('click', () => {
    const t = curTgt();
    t.lv = +b.dataset.sbLv;
    t.xp = 0;
    if (t.lv === 4 && !tgtById(G.trainId)) G.trainId = t.id;
    syncOrgFromTarget(t);
    notify('corrupt', '风灵月影 · 等级改写', `${t.name} → Lv${t.lv}「${LV_NAME(t.lv)}」`);
    renderSandboxPanel(); renderAllGame();
  }));
  box.querySelector('[data-sb-xpmax]').addEventListener('click', () => {
    const t = curTgt();
    if (t.lv >= 5) { notify('info', '已圆满', `${t.name} 已是 Lv5 契缚。`); return; }
    t.xp = LV_NEED[t.lv] - 1;
    notify('success', '风灵月影 · 经验拉满', `${t.name} 的腐化经验已填至 99%，下一次行动即可升华。`);
    renderAllGame();
  });
  box.querySelector('[data-sb-ritualready]').addEventListener('click', () => {
    const t = curTgt();
    t.lv = Math.max(t.lv, 4);
    if (t.lv >= 5) { notify('info', '无需准备', `${t.name} 已是 Lv5 契缚。`); renderSandboxPanel(); return; }
    t.xp = 0;
    G.methodPct.forEach(m => m.pct = 100);
    G.trainedUtopia = true;
    G.potions.oath = Math.max(G.potions.oath, 3);
    G.trainId = t.id;
    syncOrgFromTarget(t);
    notify('corrupt', '风灵月影 · 晋升就绪', `${t.name} 的三项晋升条件已全部满足——去调教室举行奴契仪式。`);
    renderSandboxPanel(); renderAllGame();
  });
  box.querySelectorAll('[data-sb-org]').forEach(b => b.addEventListener('click', () => {
    const mode = b.dataset.sbOrg;
    G.orgs.forEach(o => {
      if (mode === 'max') { o.corr = 92; o.status = 'control'; }
      else if (mode === 'seep') { o.corr = 45; o.status = 'seep'; }
      else { o.corr = 0; o.status = 'clean'; }
    });
    recomputeCity();
    notify('success', '风灵月影 · 势力改写', mode === 'max' ? '八股势力尽数掌控。' : mode === 'seep' ? '八股势力均处渗透中。' : '八股势力腐化归零。');
    renderOrgs(); renderHud();
  }));
  box.querySelectorAll('[data-sb-time]').forEach(b => b.addEventListener('click', () => {
    advanceTime(+b.dataset.sbTime);
    notify('info', '风灵月影 · 时间推进', `已推进 ${b.dataset.sbTime} 小时。`);
  }));
}

/* ---------- 浮尘粒子 ---------- */
const FX = { canvas: null, ctx: null, parts: [], raf: 0, enabled: true };
function fxInit() {
  FX.canvas = $('#fx-canvas');
  FX.ctx = FX.canvas.getContext('2d');
  fxResize();
  window.addEventListener('resize', fxResize);
  document.addEventListener('visibilitychange', () => { document.hidden ? fxStop() : fxStart(); });
  /* 刷新/关页前同步写一次：节流窗口（300ms）内刷新也不会丢。
     pagehide 比 beforeunload 在移动端更可靠，两个都挂。 */
  window.addEventListener('beforeunload', function () { if (gameReady) persistGame(); });
  window.addEventListener('pagehide', function () { if (gameReady) persistGame(); });
  fxSetEnabled(G.settings.fx && !reducedMotion);
}
function fxResize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  FX.canvas.width = innerWidth * dpr;
  FX.canvas.height = innerHeight * dpr;
  FX.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function fxSpawn() {
  return {
    x: Math.random() * innerWidth,
    y: innerHeight + Math.random() * 60,
    r: Math.random() * 1.6 + .4,
    v: Math.random() * .34 + .12,
    drift: (Math.random() - .5) * .22,
    a: Math.random() * .5 + .15,
    gold: Math.random() > .3
  };
}
function fxTick() {
  FX.ctx.clearRect(0, 0, innerWidth, innerHeight);
  for (const p of FX.parts) {
    p.y -= p.v; p.x += p.drift;
    if (p.y < -12) Object.assign(p, fxSpawn(), { y: innerHeight + 10 });
    FX.ctx.beginPath();
    FX.ctx.arc(p.x, p.y, p.r, 0, 7);
    FX.ctx.fillStyle = p.gold ? `rgba(201,164,92,${p.a})` : `rgba(229,120,120,${p.a})`;
    FX.ctx.fill();
  }
  FX.raf = requestAnimationFrame(fxTick);
}
function fxStart() {
  if (!FX.enabled || FX.raf) return;
  FX.parts = Array.from({ length: 42 }, fxSpawn);
  FX.raf = requestAnimationFrame(fxTick);
}
function fxStop() { cancelAnimationFrame(FX.raf); FX.raf = 0; FX.ctx && FX.ctx.clearRect(0, 0, innerWidth, innerHeight); }
function fxSetEnabled(on) {
  FX.enabled = on;
  on ? fxStart() : fxStop();
}

/* ---------- 初始化 ---------- */
function initChat() {
  pushMsg('choice', { options: [
    { label: '打开腐化目标', action: () => switchView('targets') },
    { label: '进入腐化庇护所', action: () => switchView('sanctum') },
    { label: '巡视城市地图', action: () => switchView('map') },
    { label: '推进时间 4 小时', action: () => advanceTime(4) }
  ] });
}

function bindEvents() {
  // 页签
  $$('.dock-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));
  // 时间
  $('#btn-time-1h').addEventListener('click', () => advanceTime(1));
  $('#btn-time-4h').addEventListener('click', () => advanceTime(4));
  $('#btn-time-1d').addEventListener('click', () => advanceTime(24));
  // HUD 工具
  $('#btn-hud-sandbox').addEventListener('click', () => { renderSandboxPanel(); openModal('modal-sandbox'); });
  $('#btn-hud-save').addEventListener('click', () => { renderSaveSlots(); openModal('modal-save'); });
  $('#btn-hud-snapshot').addEventListener('click', () => { renderSnapshotList(); openModal('modal-snapshot'); });
  $('#btn-hud-settings').addEventListener('click', () => { renderSettings(); openModal('modal-settings'); });
  $('#btn-hud-fullscreen').addEventListener('click', () => {
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  });
  // 聊天
  /* 同一个键两用，外观与可用性由 setBusy 切换 */
  $('#btn-chat-send').addEventListener('click', onSendButton);
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt($('#chat-input').value); }
  });
  $('#chat-input').addEventListener('input', autoGrow);
  // 脉搏
  // 目标筛选
  $$('#tgt-filter .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#tgt-filter .seg-btn').forEach(x => x.classList.remove('is-active'));
    b.classList.add('is-active');
    G.tgtFilter = b.dataset.filter;
    G.tgtPage = 1;
    renderTargets();
  }));
  $('#inp-target-search').addEventListener('input', e => { G.tgtQuery = e.target.value; G.tgtPage = 1; renderTargets(); });
  // 乌托邦页内页签
  $$('#utopia-tabs .seg-btn').forEach(b => b.addEventListener('click', () => setUtopiaTab(b.dataset.tab)));
  // 存档面板：快照打点 / 清空
  $('#btn-snap-now').addEventListener('click', () => {
    makeSnapshot();
    renderSnapshotList();
    notify('success', '快照已打点', '当前世界状态与对话已封存。');
  });
  $('#btn-snap-clear').addEventListener('click', clearSnapshots);
  // 存档面板：返回主菜单
  $('#btn-save-tomenu').addEventListener('click', () => { closeModal('modal-save'); returnToMenu(); });
  // 开始菜单与创建角色
  $('#btn-gate-continue').addEventListener('click', continueGame);
  $('#btn-gate-new').addEventListener('click', showCreate);
  $('#btn-gate-load').addEventListener('click', showGateLoad);
  $('#btn-gate-load-back').addEventListener('click', showGate);
  $('#btn-create-done').addEventListener('click', finishCreate);
  // 创建目标（沙盒）
  $('#btn-tgt-create').addEventListener('click', () => {
    const panel = document.querySelector('#tgt-create');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      const sel = document.querySelector('#ct-org');
      sel.innerHTML = '<option value="">无</option>' + G.orgs.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
      document.querySelector('#ct-name').focus();
    }
  });
  document.querySelector('#ct-done').addEventListener('click', () => {
    const name = document.querySelector('#ct-name').value.trim();
    if (!name) { notify('warn', '需要名字', '至少要有一个名字。'); return; }
    const orgId = document.querySelector('#ct-org').value || null;
    const lv = +(document.querySelector('#ct-lv').value || 0);
    G.targets.push({
      id: 't' + Date.now(),
      name,
      title: document.querySelector('#ct-title').value.trim() || '新面孔',
      org: orgId,
      age: +(document.querySelector('#ct-age').value || 24),
      loc: document.querySelector('#ct-loc').value.trim() || '临江某处',
      lv, xp: 0, trust: 0,
      behavior: '初来临江，正在熟悉这座城市的呼吸',
      thought: '那个新出现的人……是谁',
      makeup: '素颜', outfit: '日常装束',
      schedule: '待定'
    });
    const t = G.targets[G.targets.length - 1];
    if (orgId) { ORG_KEY[orgId] = t.id; syncOrgFromTarget(t); }
    G.focusId = t.id;
    G.tgtPage = Math.max(1, Math.ceil(G.targets.length / 15));
    notify('corrupt', '目标已创建', name + ' 进入名单。');
    renderTargets(); renderOrgs();
    document.querySelector('#tgt-create').hidden = true;
  });
  // 确认弹窗
  $('#btn-confirm-cancel').addEventListener('click', () => closeModal('modal-confirm'));
  $('#btn-confirm-ok').addEventListener('click', () => { closeModal('modal-confirm'); if (confirmOk) confirmOk(); confirmOk = null; });
  // 地图缩放与拖拽（不捕获指针，保证节点可点击）
  const mapSvgEl = $('#city-map-svg');
  mapSvgEl.addEventListener('wheel', e => {
    e.preventDefault();
    const pt = mapSvgPoint(e.clientX, e.clientY);
    mapZoomAt(pt[0], pt[1], e.deltaY > 0 ? 1.18 : 0.85);
  }, { passive: false });
  let mapDrag = null;
  mapSvgEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    mapDrag = { vx: mapView.x, vy: mapView.y, cx: e.clientX, cy: e.clientY, moved: false };
  });
  window.addEventListener('pointermove', e => {
    if (!mapDrag) return;
    const dx = e.clientX - mapDrag.cx, dy = e.clientY - mapDrag.cy;
    if (!mapDrag.moved && Math.abs(dx) + Math.abs(dy) > 5) mapDrag.moved = true;
    if (!mapDrag.moved) return;
    const r = mapSvgEl.getBoundingClientRect();
    mapView.x = Math.max(0, Math.min(MAP_W - mapView.w, mapDrag.vx - dx * mapView.w / r.width));
    mapView.y = Math.max(0, Math.min(MAP_H - mapView.h, mapDrag.vy - dy * mapView.h / r.height));
    mapViewApply();
  });
  ['pointerup', 'pointercancel'].forEach(ev => window.addEventListener(ev, () => {
    if (mapDrag && mapDrag.moved) {
      mapDragSuppress = true;
      setTimeout(() => { mapDragSuppress = false; }, 180);
    }
    mapDrag = null;
  }));
  $('#map-zoom-in').addEventListener('click', () => mapZoomAt(mapView.x + mapView.w / 2, mapView.y + mapView.h / 2, 0.8));
  $('#map-zoom-out').addEventListener('click', () => mapZoomAt(mapView.x + mapView.w / 2, mapView.y + mapView.h / 2, 1.25));
  $('#map-zoom-reset').addEventListener('click', () => { mapView.x = 0; mapView.y = 0; mapView.w = MAP_W; mapView.h = MAP_H; mapViewApply(); });

  // Esc 关闭最上层弹窗
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = $$('.modal:not([hidden])');
    if (open.length) closeModal(open[open.length - 1].id);
  });
}

/* ---------- 开始菜单 / 选择存档 / 创建角色 ---------- */
function showGate() {
  document.querySelector('#gate-start').hidden = false;
  document.querySelector('#gate-create').hidden = true;
  document.querySelector('#gate-load').hidden = true;
  /* 继续游戏：当前档案里必须真有对话数据——没聊过天就只能「新的游戏」。
     光有自动落盘的空档案不算进度。 */
  const contBtn = document.querySelector('#btn-gate-continue');
  const hint = document.querySelector('#gate-continue-hint');
  var activeName = kvGet('active_archive') || currentArchive;
  var d = activeName ? kvGet(archiveKey(activeName)) : null;
  var has = !!d && Array.isArray(d.chat) && d.chat.length > 0;
  if (contBtn) contBtn.disabled = !has;
  if (hint) hint.textContent = has ? ('继续：' + activeName) : '尚无对话进度 · 请「新的游戏」开始';
  renderGateSlots();
}
function showCreate() {
  document.querySelector('#gate-start').hidden = true;
  document.querySelector('#gate-load').hidden = true;
  document.querySelector('#gate-create').hidden = false;
  const n = document.querySelector('#cr-name');
  if (n) n.focus();
}
function showGateLoad() {
  document.querySelector('#gate-start').hidden = true;
  document.querySelector('#gate-create').hidden = true;
  document.querySelector('#gate-load').hidden = false;
  renderGateSlots();
}
function hideGates() {
  document.querySelector('#gate-start').hidden = true;
  document.querySelector('#gate-create').hidden = true;
  document.querySelector('#gate-load').hidden = true;
}
/* 返回主菜单：先把当前进度落盘（可被「继续游戏」找回），再关掉所有弹窗、显示开始菜单 */
function returnToMenu() {
  persistGame();
  $$('.modal:not([hidden])').forEach(m => { m.hidden = true; });
  showGate();
}
/* 开始菜单里的「选择存档」列表：列出全部档案（含当前档案并标注），
   只有一个存档时也照样有「读取」按键可点。 */
function renderGateSlots() {
  const box = document.querySelector('#gate-slots');
  if (!box) return;
  var cur = currentArchive || kvGet('active_archive');
  var names = sortedArchiveNames();
  box.innerHTML = names.length ? names.map(function (n) {
    var d = kvGet(archiveKey(n)) || {};
    var meta = archiveMetaLine(d);
    var isCur = n === cur;
    var row = document.createElement('div');
    row.className = 'gate-slot' + (isCur ? ' is-current' : '');
    row.innerHTML = '<span class="arc-glyph">' + esc((d.playerName || n).slice(0, 1)) + '</span>' +
      '<div class="arc-info">' +
      '<b>' + esc(n) + (isCur ? '<span class="arc-cur">当前</span>' : '') + '</b>' +
      '<p class="arc-meta">' + ic('i-user') + meta.player + '<i class="dot-sep"></i>' + ic('i-calendar') + meta.time + '</p>' +
      '<p class="arc-meta">' + ic('i-coin') + meta.money + '<i class="dot-sep"></i>' + ic('i-users') + meta.targets + '</p>' +
      '</div>' +
      '<button class="btn btn-primary" data-gate-load="' + esc(n) + '">' + ic('i-refresh') + '读取</button>';
    return row.outerHTML;
  }).join('') : '<p class="arc-empty">暂无档案——「新的游戏」将建立第一个。</p>';
  box.querySelectorAll('[data-gate-load]').forEach(function (b) { b.onclick = function () {
    if (loadArchive(b.dataset.gateLoad)) { hideGates(); notify('info', '读取完成', '已回到「' + b.dataset.gateLoad + '」。'); }
  }; });
}
function continueGame() {
  var name = kvGet('active_archive') || currentArchive;
  if (name && loadArchive(name)) {
    hideGates();
    notify('info', '继续游戏', '已回到「' + name + '」。');
    return;
  }
  notify('warn', '无可继续的进度', '请先开始新的游戏。');
}

function finishCreate() {
  const name = document.querySelector('#cr-name').value.trim();
  if (!name) { notify('warn', '需要名字', '至少告诉我你的名字。'); return; }
  G.player = {
    name,
    gender: document.querySelector('#cr-gender').value,
    persona: document.querySelector('#cr-persona').value.trim()
  };
  savePlayer(G.player);
  // 新开档不再重置酒馆（接口 / 预设 / 世界书全部保留），
  // 只把新的角色名与人设写进酒馆的全局设定。
  if (window.TAVERN) TAVERN.saveSettings({ userName: name, persona: G.player.persona });
  hideGates();
  restoreChat([]);   // 新开档：清空上一局遗留的会话快照
  /* 新开档：快照也清空（快照属于当前存档，不跨档） */
  SNAPSHOTS = [];
  persistSnapshots();
  /* 新开档：世界状态退回出厂值，并把当前状态当作新起点落盘。
     否则自动存档恢复的上一局目标/势力会被带进新档。 */
  resetWorldState();
  initChat();
  currentArchive = name + '的档案';
  autosaveSuppressed = false;   // 新档建档：恢复自动存档
  kvSet('active_archive', currentArchive);
  persistGame();   // 新档立即建档，可被继续游戏
  notify('corrupt', '踏入临江', name + '，这座城市的名单还是空白的——去创造它。');
}
function personalizeChat() {
  const t = document.querySelector('#chat-log');
  if (!t || t.children.length) return;
  pushMsg('narr', { text: '临江的夜雨刚停。' + G.player.name + '，你的名单还是空白的——目标、势力、航线，都等你亲手写下。' });
  pushMsg('choice', { options: [
    { label: '创建第一个目标', action: () => switchView('targets') },
    { label: '打开酒馆', action: () => switchView('tavern') },
    { label: '巡视城市地图', action: () => switchView('map') }
  ] });
}

document.addEventListener('DOMContentLoaded', async () => {
  /* 先装 IndexedDB：全部键值对进 KV_MEM，旧 localStorage 数据一并迁入 */
  if (window.IDB) {
    try {
      Object.assign(KV_MEM, await IDB.loadAll());
      const LEGACY = {
        autosave: 'fushicheng_autosave_v1', chat: 'fushicheng_chat_v1',
        snapshots: 'fushicheng_snapshots_v1', settings: 'fushicheng_settings_v1',
        player: 'fushicheng_player_v1', ui: 'fushicheng_ui_state_v1',
        last_save: 'fushicheng_last_save_v1', portraits: 'fushicheng_portraits_v3'
      };
      for (const k in LEGACY) {
        if (KV_MEM[k] === undefined) {
          try {
            const raw = localStorage.getItem(LEGACY[k]);
            if (raw) { KV_MEM[k] = JSON.parse(raw); await IDB.set(k, KV_MEM[k]); }
          } catch (e) {}
        }
      }
      window.PORTRAITS_MEM = KV_MEM.portraits || {};
      /* 旧槽位/自动进度 → 命名档案迁移 */
      if (!KV_MEM['active_archive']) {
        if (KV_MEM.autosave) { KV_MEM['archive:自动进度'] = KV_MEM.autosave; KV_MEM.active_archive = '自动进度'; }
        for (var si = 1; si <= 3; si++) {
          var oldSlot = KV_MEM['save_' + si];
          if (oldSlot && oldSlot.playerName) { KV_MEM['archive:' + oldSlot.playerName + '的旧档'] = oldSlot; }
        }
      }
      window.PERSIST_PORTRAITS = function (m) { kvSet('portraits', m); };
    } catch (e) { console.error('[IDB] 装载失败，回退内存模式', e); }
  }
  loadSettings();
  // 变量内核：补惰性容器字段 + 挂弹幕层与失败弹窗
  if (window.VARS) {
    if (window.VARS.init) window.VARS.init();
    if (window.VARS.mount) window.VARS.mount();
  }
  // 酒馆内核初始化（异步）：IndexedDB 建库 + 旧版 localStorage 迁移 + 确保默认预设存在。
  // 世界书不自动种入，由用户在「酒馆 → 世界书管理」按需导入内置模板。
  // 唯一例外：社会组织成文（见 syncOrgCharters）——它是玩家自己的设定，
  // 必须镜像成世界书条目才可能进模型上下文，因此内核就绪后自动同步一次。
  if (window.ST && window.ST.init) {
    window.ST.init()
      .then(function () { return syncOrgCharters(); })
      .catch(function (e) { console.error('[酒馆] 内核初始化失败', e); });
  }
  $('#btn-hud-sandbox').hidden = !G.settings.sandbox;
  document.querySelector('.ritual').style.display = G.settings.ritual ? '' : 'none';
  bindModals();
  bindEvents();
  fxInit();
  /* 申请持久化存储（对齐参考实现）：降低浏览器在空间紧张时清掉存档的概率 */
  try {
    if (navigator.storage && navigator.storage.persist && window.isSecureContext) {
      navigator.storage.persisted().then(function (ok) {
        if (!ok) return navigator.storage.persist();
      }).catch(function () {});
    }
  } catch (e) {}
  /* 先恢复世界状态快照（静默：不动聊天区），再渲染各面板。
     否则各 render* 会先把出厂默认值画上去，且 persistGameSoon 把快照冲掉。 */
  var autoSave = loadPersistedGame();
  if (autoSave) applySave(autoSave, { silent: true });
  /* 聊天区恢复：优先用自动存档里的正文日志，回退独立聊天快照。
     （applySave 的 silent 模式刻意不碰聊天区，这里单独补上——
       参考实现的 loadChatHistory：刷新后正文、选项、折叠记忆全部回屏。） */
  var chatSnap = (autoSave && Array.isArray(autoSave.chat) && autoSave.chat.length)
    ? autoSave.chat : loadPersistedChat();
  if (chatSnap && chatSnap.length) { restoringChat = true; restoreChat(chatSnap); restoringChat = false; }
  gameReady = true;

  renderHud();
 
  renderTargets();
  renderOrgs();
  renderAlchemy(); renderTraining(); renderBackpack();
  renderStage(); renderPerformers(); renderBusiness(); renderMarket();
  renderMap();
  renderSaveSlots();
  renderSnapshotList();
  /* 刷新页面后回到上次所在的视图/详情页（不依赖存档槽）。
     必须在各 render* 之后：switchView 会重渲对应面板。 */
  restoreUi(loadPersistedUi());
  switchView(G.view);
  /* 启动流程：一律先进开始菜单（继续游戏 / 新的游戏 / 选择存档）。
     自动存档已在上面静默恢复，供「继续游戏」使用。 */
  hideGates();
  showGate();
});

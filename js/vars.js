/* ============================================================
   腐化 · 变量内核
   命令：<set>路径 运算符 值</set>    运算符：= · += · -=
   ============================================================ */
(function () {
  'use strict';

  const V = {};

  /* ---------- 工具 ---------- */
  const num = v => typeof v === 'number' ? v : Number(String(v).replace(/[¥￥,\s，]/g, ''));
  const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const parseBool = v => /^(true|是|1|开|yes|已触发|已完成)$/i.test(String(v).trim()) ? true
                        : /^(false|否|0|关|no|未触发|未完成)$/i.test(String(v).trim()) ? false : null;
  const parseVal = s => {
    s = String(s ?? '').trim();
    if (/^-?[\d,，]+(\.\d+)?$/.test(s)) return num(s);
    const b = parseBool(s); if (b !== null) return b;
    const m = /^[“"『「](.*)[”"』」]$/.exec(s); return m ? m[1] : s;
  };
  const isInt = v => { const n = num(v); return Number.isInteger(n) ? n : null; };

  /* ---------- 惰性初始化 ---------- */
  V.init = () => {
    if (typeof G === 'undefined') return;
    G.items ??= {};
    G.potions ??= { single: 0, gas: 0, male: 0, oath: 0 };
    G.bought ??= new Set();
    G.mapPlaces ??= { 西城区: {}, 东城区: {}, 休闲区: {} };
    G.orgs.forEach(o => { o.rules ??= {}; o.privs ??= {}; o.corr ??= 0; });
  };

  /* ---------- 挂载反馈层：弹幕层 + 失败弹窗 ----------
     由 app.js 启动流程调用（VARS.init() → VARS.mount()）。
     弹幕层与失败弹窗原先写在 index.html 里，某次改动后从 HTML 丢失，
     导致 V.show 的两条反馈分支全部静默失效（弹幕不飘、失败不弹）。
     这里改为按需自建，避免再与 index.html 失联。
     注意：本函数在 app.js bindModals() 之前执行，
     因此新建弹窗的 [data-close] 能被统一绑定。 */
  V.mount = () => {
    if (typeof document === 'undefined') return;

    if (!document.getElementById('danmaku-layer')) {
      const layer = document.createElement('div');
      layer.id = 'danmaku-layer';
      layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(layer);
    }

    if (!document.getElementById('modal-varfail')) {
      const m = document.createElement('div');
      m.className = 'modal';
      m.id = 'modal-varfail';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-modal', 'true');
      m.setAttribute('aria-labelledby', 'varfail-title');
      m.hidden = true;
      m.innerHTML =
        '<div class="modal-backdrop" data-close="modal-varfail"></div>' +
        '<section class="modal-panel modal-sm">' +
          '<header class="modal-head">' +
            '<div class="modal-head-text">' +
              '<h2 id="varfail-title">变量更新失败</h2>' +
              '<p class="modal-sub">命令未通过白名单或语法校验</p>' +
            '</div>' +
            '<button class="icon-btn" data-close="modal-varfail" title="关闭">' +
              '<svg class="ic"><use href="#i-x"/></svg></button>' +
          '</header>' +
          '<div class="modal-body"><ul class="varfail-list" id="varfail-list"></ul></div>' +
        '</section>';
      document.body.appendChild(m);
    }
  };

  /* ---------- 路径解析：a.b[k].c ---------- */
  function parsePath(s) {
    const segs = [], re = /([^.\[\]]+)|\[([^\]]*)\]/g;
    let m, last = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last && /[^\s.\[]/.test(s.slice(last, m.index))) return null;
      segs.push(m[1] !== undefined ? { seg: m[1].trim() } : { key: (m[2] || '').trim() });
      last = re.lastIndex;
    }
    return segs.length && last === s.length ? segs : null;
  }

  /* ---------- 命令解析 ---------- */
  V.parse = line => {
    let s = String(line ?? '').trim().replace(/^[-*·]\s+/, '');
    if (!s) return null;

    let m = /^(.+?)\s*(\+=|-=|=)\s*(.*)$/.exec(s);
    /* 容错：冒号当作 = */
    if (!m) {
      const mc = /^([^.\[\]:：]+(?:[.\[][^:：]*)*)\s*[：:]\s*(.*)$/.exec(s);
      if (mc && /(\.[^.\[\]]+|\][^.\[\]]+)$/.test(mc[1]))
        m = /^(.+?)\s*(=)\s*(.*)$/.exec(mc[1].trim() + ' = ' + mc[2].trim());
    }
    /* 容错：漏运算符，路径有字段尾时补 = */
    if (!m) {
      const sp = /^(\S+)\s+(.+)$/.exec(s);
      if (sp && /(\.[^.\[\]]+|\][^.\[\]]+)$/.test(sp[1]) && sp[2].trim().length <= 60)
        m = /^(.+?)\s*(=)\s*(.*)$/.exec(sp[1] + ' = ' + sp[2].trim());
    }
    if (!m) return { raw: s, error: '命令格式错误（应为：路径 运算符 值）' };

    const path = parsePath(m[1].trim());
    if (!path) return { raw: s, error: '路径解析失败：「' + m[1].trim() + '」' };
    return { raw: s, op: m[2], path, rawVal: m[3].trim(), value: parseVal(m[3]) };
  };

  /* ---------- 块式展开 ---------- */
  V.expand = lines => {
    const arr = (lines || []).map(l => String(l ?? ''));
    if (!arr.some(l => /^\s+\S/.test(l))) return arr;
    const out = [], stack = [];
    for (const raw of arr) {
      if (!raw.trim()) continue;
      const indent = (raw.match(/^\s*/) || [''])[0].replace(/\t/g, '    ').length;
      const body = raw.trim();
      while (stack.length && stack.at(-1).col >= indent) stack.pop();
      if (!/\s*(?:\+=|-=|=)\s*\S|[：:]\s*\S/.test(body)) { stack.push({ col: indent, path: body }); continue; }
      out.push([...stack.map(s => s.path), body].join('.'));
    }
    return out;
  };

  /* ---------- 白名单根 + 字段表 ---------- */
  const ROOTS = ['金钱', '当前时间', '药剂数量', '腐化目标', '物品', '乌托邦', '社会组织', '地图'];
  const POTS  = { 单体: 'single', 气体: 'gas', 男性: 'male', 夜冕: 'oath' };
  const TGT   = { 名称: 'name', 年龄: 'age', 职业: 'title', 人际关系: 'rel',
                  腐化等级: 'lv', 腐化经验值: 'xp',
                  '状态表现.当前位置': 'loc', '状态表现.当前行为': 'behavior',
                  '状态表现.行程安排': 'schedule', '状态表现.当前想法': 'thought',
                  '状态表现.当前妆容': 'makeup', '状态表现.当前服装': 'outfit' };
  const PERF  = { 姓名: 'name', 年龄: 'age', 职业: 'job', 腐化等级: 'lv', 来源: 'world',
                  '状态表现.当前行为': 'behavior', '状态表现.当前想法': 'thought',
                  '状态表现.当前妆容': 'makeup', '状态表现.当前服装': 'outfit',
                  观看表演费: 'fee', 性行为服务费: 'svcFee', 购买费用: 'price' };
  const TIER  = ['初级', '中级', '高级', '终极'];
  const ITEM_TYPES = ['消耗品', '任务物品', '服装', '其他'];
  const DIST  = { 西城区: 1, 东城区: 1, 休闲区: 1 };

  const find = (arr, k) => arr.find(x => x.id === k || x.name === k) || null;
  const BAD_KEY = k => k === '__proto__' || k === 'constructor' || k === 'prototype';

  /* 天气文本 → HUD 图标 */
  const WEATHER_ICONS = [
    [/雨|雷|雹/, 'i-droplet'],
    [/晴|烈|阳/, 'i-sun'],
    [/风/, 'i-wind'],
    [/雪|霜/, 'i-cloud'],
  ];
  function timeWeatherIcon(w) {
    for (const [re, ic] of WEATHER_ICONS) if (re.test(w)) return ic;
    return 'i-cloud';   // 云 / 阴 / 雾 / 霾 及未知天气
  }

  /* ---------- 字段赋值（统一数值/文本校验） ---------- */
  function assign(obj, prop, op, val, { min = 0, max, text } = {}) {
    if (text) {
      if (typeof val === 'number') val = String(val);
      if (typeof val !== 'string') return '须为文本';
      obj[prop] = val; return null;
    }
    const n = isInt(val);
    if (n === null) return '须为整数';
    const next = op === '=' ? n : (Number(obj[prop]) || 0) + (op === '+=' ? n : -n);
    if (next < min) return `不能低于 ${min}`;
    if (max !== undefined && next > max) return `不能超过 ${max}`;
    obj[prop] = next; return null;
  }

  /* ============================================================
     各根处理：返回 { kind, display, entity?, also?, created? }
     校验失败直接 throw 字符串，由 V.exec 统一捕获
     ============================================================ */
  const H = {
    金钱({ op, value }) {
      const n = isInt(value); if (n === null) throw '金钱须为整数';
      const before = RES.money;
      const next = op === '=' ? n : before + (op === '+=' ? n : -n);
      if (next < 0) throw `金钱不足（当前 ¥${before.toLocaleString()}）`;
      RES.money = next;
      const diff = next - before;
      return { kind: 'money', display: `金钱 ${diff >= 0 ? '+' : ''}${diff} → ¥${next.toLocaleString()}` };
    },
    当前时间({ path, op, value, rawVal }) {
      const sub = path[1]?.seg;
      /* 当前时间.星期 = 周一 */
      if (sub === '星期' || sub === '周') {
        if (op !== '=') throw '星期只支持 =';
        const w = String(value ?? '').trim();
        const m = /^(周|星期)([一二三四五六日天])$/.exec(w);
        if (!m) throw '星期应为 周一 ~ 周日（或 星期一 ~ 星期天）';
        CITY.time.weekday = '周' + m[2];
        return { kind: 'time', display: `星期 → ${CITY.time.weekday}` };
      }
      /* 当前时间.天气 = 小雨 */
      if (sub === '天气') {
        if (op !== '=') throw '天气只支持 =';
        const w = String(value ?? '').trim();
        if (!w || w.length > 12) throw '天气应为简短文本（如：雾 / 小雨 / 雷暴）';
        CITY.time.weather = w;
        CITY.time.weatherIc = timeWeatherIcon(w);
        return { kind: 'time', display: `天气 → ${w}` };
      }
      if (sub) throw '当前时间只有 星期 / 天气 两个子字段';
      if (op !== '=') throw '当前时间只支持 =';
      /* 9月14日 [周一] 02:30 —— 星期可写可不写 */
      const m = /^(\d{1,2})月(\d{1,2})日(?:[ 　]+((?:周|星期)[一二三四五六日天]))?[ 　]*(\d{1,2})[:：点](\d{1,2})?$/.exec(String(rawVal));
      if (!m) throw '时间格式应为「9月14日 02:30」或「9月14日 周一 02:30」';
      const [mo, d] = [Number(m[1]), Number(m[2])];
      const h = Number(m[4]), mi = m[5] ? Number(m[5]) : 0;
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) throw '时间数值越界';
      /* 只改字段，不清掉星期 / 天气 */
      CITY.time.date = `${mo}月${d}日`;
      CITY.time.hour = h;
      CITY.time.minute = mi;
      if (m[3]) {
        const wk = /^(周|星期)([一二三四五六日天])$/.exec(m[3]);
        CITY.time.weekday = '周' + wk[2];
      }
      return { kind: 'time', display: `时间 → ${CITY.time.date} ${CITY.time.weekday || ''} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`.replace(/\s+/g, ' ') };
    },
    药剂数量({ path, op, value }) {
      const name = path[1]?.seg, k = POTS[name];
      if (!k) throw '药剂只认：单体 / 气体 / 男性 / 夜冕';
      const n = isInt(value); if (n === null) throw '药剂数量须为整数';
      const next = op === '=' ? n : (G.potions[k] || 0) + (op === '+=' ? n : -n);
      if (next < 0) throw '库存不足';
      G.potions[k] = next;
      return { kind: 'potion', display: `药剂·${name} → ${next}` };
    },
    腐化目标({ path, op, value }) {
      const key = path[1]?.key; if (!key) throw '腐化目标需要 [ID或名称]';
      /* 玩家本人不是腐化目标——有些模型会把主角写进来 */
      if (G.player && G.player.name && (key === G.player.name))
        throw `「${cut(key, 12)}」是你自己，不能作为腐化目标建档`;
      let t = find(G.targets, key), created = false;
      if (!t) {
        t = { id: /^[A-Za-z][\w-]{1,40}$/.test(key) ? key : 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
              name: key, title: '新面孔', age: 24, loc: '临江某处', lv: 0, xp: 0, rel: '',
              behavior: '初来临江', thought: '……', makeup: '素颜',
              outfit: '日常装束', schedule: '待定' };
        G.targets.push(t); created = true;
      }
      if (path.length === 2) {
        if (op !== '=' || typeof value !== 'string') throw '腐化目标[ID] = 名称';
        t.name = value;
        return { kind: 'target', entity: t.id, created, display: `目标 ${value} 建档` };
      }
      const f = path.slice(2).map(s => s.seg).join('.');
      const prop = TGT[f]; if (!prop) throw `未知字段「${cut(f, 20)}」`;
      /* 也不许把已有目标改名成玩家本人 */
      if (prop === 'name' && G.player && G.player.name && String(value).trim() === G.player.name)
        throw `不能把目标改名为你自己（${cut(value, 12)}）`;
      const text = !['age', 'lv', 'xp'].includes(prop);
      /* 年龄下限由 16 放宽到 0（用户要求）。上限仍是 99。
         注意：年龄是整数语义，min 走 assign 的数值校验分支。 */
      const err = assign(t, prop, op, value, {
        text, min: prop === 'age' ? 0 : 0,
        max: prop === 'lv' ? 5 : prop === 'age' ? 99 : undefined
      });
      if (err) throw err;
      if (prop === 'lv' && typeof syncOrgFromTarget === 'function' && t.org) syncOrgFromTarget(t);
      return { kind: 'target', entity: t.id, created,
               display: `${t.name} · ${cut(f.replace('状态表现.', ''), 10)} → ${cut(t[prop], 24)}` };
    },
    物品({ path, op, value }) {
      const name = path[1]?.key; if (!name) throw '物品需要 [名称]';
      if (BAD_KEY(name)) throw '非法名称';
      const it = G.items[name] ??= { qty: 0, type: '其他' };
      if (path.length === 2) {
        const n = isInt(value); if (op !== '=' || n === null || n < 0) throw '物品[X] = 非负整数';
        it.qty = n;
        return { kind: 'item', display: `物品[${name}] × ${n}` };
      }
      const f = path[2]?.seg;
      if (f === '数量') { const e = assign(it, 'qty', op, value); if (e) throw e; return { kind: 'item', display: `物品[${name}] × ${it.qty}` }; }
      if (f === '类型') {
        if (op !== '=' || !ITEM_TYPES.includes(value)) throw `类型只认：${ITEM_TYPES.join(' / ')}`;
        it.type = value;
        return { kind: 'item', display: `物品[${name}] 类型 → ${value}` };
      }
      throw '物品只有 数量 / 类型';
    },
    乌托邦({ path, op, value }) {
      const branch = path[1]?.seg, key = path[2]?.key;
      if (!key) throw '乌托邦需要 [ID]';

      if (branch === '客座表演') {
        let p = find(G.performers, key);
        if (!p) {
          p = { id: key, name: key, world: '未知界域', age: 22, job: '异界来客', lv: 3,
                fee: 1000, svcFee: 500, behavior: '后台默背台词', thought: '……',
                makeup: '异界浓妆', outfit: '流光戏服' };
          G.performers.push(p);
        }
        /* 建档：客座表演[名] = 来源世界 */
        if (path.length === 3) {
          if (op !== '=') throw '演员建档只支持 =';
          p.world = String(value ?? '').trim() || p.world;
          return { kind: 'stage', entity: p.id, created: true, display: `客座演员 ${p.name} 已录入（来自${p.world}）` };
        }
        const f = path.slice(3).map(s => s.seg).join('.'); const prop = PERF[f];
        if (!prop) throw `未知演员字段「${cut(f, 16)}」`;
        const text = !['age', 'lv', 'fee', 'svcFee', 'price'].includes(prop);
        /* 年龄下限 16 → 0（用户要求），与腐化目标一致 */
        const e = assign(p, prop, op, value, { text, min: 0, max: prop === 'age' ? 99 : undefined });
        if (e) throw e;
        return { kind: 'stage', display: `${p.name} · ${cut(f, 12)} → ${cut(p[prop], 22)}` };
      }

      if (branch === '跨界黑市') {
        let m = find(MARKET, key);
        if (!m) { m = { id: key, name: key, world: '未知界域', price: 0, desc: '' }; MARKET.push(m); }

        /* 购买：黑市[ID] = 购买（买下即下架） */
        if (path.length === 3 && String(value) === '购买' && op === '=') {
          if (RES.money < m.price) throw `金钱不足（需 ¥${m.price.toLocaleString()}）`;
          RES.money -= m.price;
          const i = MARKET.indexOf(m);
          if (i >= 0) MARKET.splice(i, 1);
          const t = { id: 't' + m.id, name: m.name, title: m.job || '异界来客', age: m.age || 22,
                      loc: '乌托邦', lv: m.lv ?? 3, xp: 0, rel: '',
                      behavior: '刚跨过世界之门', thought: '……', makeup: '异界浓妆',
                      outfit: '流光戏服', schedule: '待定' };
          G.targets.push(t);
          if (!find(G.performers, m.id))
            G.performers.push({ id: m.id, name: m.name, world: m.world, icon: 'i-portal',
                                skill: 88, charm: 88, loyalty: 60, fee: Math.round(m.price / 4) });
          return { kind: 'stage', entity: t.id, created: true, also: ['money', 'target'],
                   display: `黑市 → ${m.name} 已购入（¥${m.price.toLocaleString()}）` };
        }
        /* 建档：跨界黑市[名] = 来源世界 */
        if (path.length === 3) {
          if (op !== '=') throw '黑市建档只支持 =';
          m.world = String(value ?? '').trim() || m.world;
          return { kind: 'stage', created: true, display: `黑市上架 ${m.name}（来自${m.world}）` };
        }
        const f = path.slice(3).map(s => s.seg).join('.'); const prop = PERF[f];
        if (!prop) throw `未知黑市字段「${cut(f, 16)}」`;
        const text = !['price', 'lv', 'age'].includes(prop);
        /* 年龄下限 16 → 0（用户要求），与腐化目标/客座演员一致 */
        const e = assign(m, prop, op, value, { text, min: 0, max: prop === 'age' ? 99 : undefined });
        if (e) throw e;
        return { kind: 'stage', display: `黑市[${key}] · ${cut(f, 12)} → ${cut(m[prop], 22)}` };
      }
      throw '乌托邦只有 客座表演 / 跨界黑市';
    },
    社会组织({ path, op, value }) {
      /* 沙盒：未知组织按变量自动建档拓展 */
      let o = find(G.orgs, path[1]?.key);
      if (!o) {
        if (BAD_KEY(path[1]?.key)) throw '非法组织名';
        o = { id: 'org_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
              name: path[1].key, type: '未明', icon: 'i-org', corr: 0, status: 'clean', rules: {}, privs: {} };
        G.orgs.push(o);
      }
      const f1 = path[2]?.seg;

      if (f1 === '腐化程度') {
        const n = isInt(value); if (n === null) throw '腐化程度须为整数';
        o.corr = Math.min(100, Math.max(0, op === '=' ? n : o.corr + (op === '+=' ? n : -n)));
        o.status = o.corr >= 60 ? 'control' : o.corr >= 15 ? 'seep' : 'clean';
        return { kind: 'org', display: `${o.name} 腐化 ${o.corr}%` };
      }
      if (f1 === '腐化规则' || f1 === '腐化特权') {
        const tier = path[3]?.seg;
        if (!TIER.includes(tier)) throw `${f1} 只分 ${TIER.join(' / ')}`;
        if (op !== '=') throw `${f1}.${tier} 只支持 =`;
        const bag = f1 === '腐化规则' ? o.rules : o.privs;
        /* 变量模型：等级是布尔（是/否），只表示「该层级已解锁」。
           成文内容不自动生成（不用模板、也不调用 AI），由玩家在详情页
           点「编辑」自行撰写；直接写文本仍兼容（自定义成文）。 */
        const b = parseBool(value);
        if (b === null) {
          const text = String(value ?? '').trim();
          if (!text) { delete bag[tier]; return { kind: 'org', display: `${o.name} ${f1}·${tier} 已收回` }; }
          bag[tier] = text;
          return { kind: 'org', display: `${o.name} ${f1}·${tier} 已录入「${cut(text, 18)}」` };
        }
        if (b) {
          if (typeof bag[tier] !== 'string' || !bag[tier]) bag[tier] = true;
          return { kind: 'org', display: `${o.name} ${f1}·${tier} 已解锁（待填写成文）` };
        }
        delete bag[tier];
        return { kind: 'org', display: `${o.name} ${f1}·${tier} 已收回` };
      }
      throw '组织只有 腐化程度 / 腐化规则 / 腐化特权';
    },
    地图({ path, op, value, rawVal }) {
      const district = path[1]?.seg;
      if (!DIST[district]) throw '地图只分 西城区 / 东城区 / 休闲区';
      /* 容错：地图.休闲区.乌托邦.腐化目标 → 地点名当 key */
      if (path[2]?.seg && path[3]?.seg === '腐化目标')
        path = [path[0], path[1], { key: path[2].seg }, path[3]];
      const place = path[2]?.key; if (!place) throw `地图.${district} 需要 [地点]`;
      if (BAD_KEY(place)) throw '非法地点名';
      const arr = (G.mapPlaces[district][place] ??= []);
      const f = path[3]?.seg;
      if (f && f !== '腐化目标') throw `${place} 只有 腐化目标`;

      if (op === '+=') {
        if (typeof value !== 'string' || !value) throw '追加须为文本';
        if (!arr.includes(value)) arr.push(value);
      } else if (op === '-=') {
        const i = arr.indexOf(String(value));
        if (i < 0) throw `${value} 不在此地`;
        arr.splice(i, 1);
      } else {
        G.mapPlaces[district][place] =
          String(rawVal).split(/[、；;]/).map(s => s.trim()).filter(Boolean);
      }
      return { kind: 'map', display: `${district} · ${place} → ${G.mapPlaces[district][place].join('、') || '空无一人'}` };
    }
  };

  /* ============================================================
     执行 + 批量
     ============================================================ */
  V.exec = cmd => {
    if (cmd.error) return { ok: false, raw: cmd.raw, error: cmd.error };
    const root = cmd.path[0]?.seg;
    if (!ROOTS.includes(root)) return { ok: false, raw: cmd.raw, error: `未知变量根「${cut(root, 12)}」` };
    try {
      const r = H[root]({ path: cmd.path, op: cmd.op, value: cmd.value, rawVal: cmd.rawVal });
      return { ok: true, raw: cmd.raw, ...r };
    } catch (e) {
      return { ok: false, raw: cmd.raw, error: String(e?.message ?? e) };
    }
  };

  V.run = commands => {
    const ok = [], fail = [];
    V.expand(commands || []).forEach(line => {
      const cmd = V.parse(line); if (!cmd) return;
      const r = V.exec(cmd);
      (r.ok ? ok : fail).push(r);
    });
    return { ok, fail };
  };

  /* ============================================================
     结果反馈：弹幕 + 失败弹窗 + 面板回刷
     ============================================================ */
  const DM_SPEED = { slow: 14, normal: 9, fast: 5.5 };
  const DM_COLOR = { gold: '#e9cd8e', jade: '#3ddba4', blood: '#e5484d',
                     cyan: '#56c8e8', violet: '#a78bfa', ivory: '#efe7d8' };

  V.show = res => {
    const layer = document.getElementById('danmaku-layer');
    if (layer) {
      const speed = DM_SPEED[G.settings?.dmSpeed] || DM_SPEED.normal;
      const color = DM_COLOR[G.settings?.dmColor] || DM_COLOR.gold;
      res.ok.forEach((r, i) => {
        const el = document.createElement('div');
        el.className = 'dm dm-' + (r.kind || 'info');
        el.textContent = r.display;
        Object.assign(el.style, {
          color, animationDuration: speed + 's',
          animationDelay: i * 0.45 + 's', top: 86 + (i % 6) * 34 + 'px'
        });
        layer.appendChild(el);
        setTimeout(() => el.remove(), (speed + i * 0.45) * 1000 + 400);
      });
    }
    if (res.fail.length) {
      const list = document.getElementById('varfail-list');
      if (list) {
        list.innerHTML = res.fail.map(f =>
          `<li><code>${esc(f.raw)}</code><em>${esc(f.error)}</em></li>`).join('');
        const t = document.getElementById('varfail-title');
        if (t) t.textContent = `变量更新失败（${res.fail.length} 条）`;
        if (typeof openModal === 'function') openModal('modal-varfail');
      }
    }
    const kinds = [], entities = [];
    res.ok.forEach(r => {
      if (r.kind && !kinds.includes(r.kind)) kinds.push(r.kind);
      (r.also || []).forEach(k => !kinds.includes(k) && kinds.push(k));
      if (r.entity && !entities.includes(r.entity)) entities.push(r.entity);
    });
    const render = typeof renderForKinds === 'function' ? renderForKinds : renderAllGame;
    if (typeof render === 'function') render(kinds, entities);
  };

  /* ---------- 状态卡（注入 system） ---------- */
  V.digest = () => {
    if (typeof G === 'undefined') return '';
    const L = [];
    const pn = { single: '单体', gas: '气体', male: '男性', oath: '夜冕' };
    L.push(`〔全局〕金钱 ¥${RES.money.toLocaleString()} · ` +
           `时间 ${CITY.time.date} ${String(CITY.time.hour).padStart(2, '0')}:${String(CITY.time.minute).padStart(2, '0')} · ` +
           `药剂 ${Object.keys(pn).map(k => pn[k] + (G.potions?.[k] || 0)).join('/')}`);

    if (G.targets.length) {
      L.push('〔腐化目标〕');
      G.targets.slice(0, 20).forEach(t => L.push(
        ` ${t.id} ${t.name} ${t.age}岁 ${t.title} Lv${t.lv} xp${t.xp}` +
        (t.rel ? ` 关系:${cut(t.rel, 10)}` : '') +
        ` @${t.loc} ｜${cut(t.behavior, 16)}`));
      if (G.targets.length > 20) L.push(` …另 ${G.targets.length - 20} 名`);
    }
    const items = Object.keys(G.items || {}).filter(k => G.items[k].qty > 0 || G.items[k].type !== '其他');
    if (items.length) L.push('〔物品〕' + items.map(k => `${k}×${G.items[k].qty}(${G.items[k].type})`).join(' · '));

    if (G.performers.length) {
      L.push('〔客座表演〕');
      G.performers.slice(0, 12).forEach(p => L.push(
        ` ${p.id} ${p.name} ${p.age}岁 ${p.job} Lv${p.lv} 来源:${p.world} ` +
        `台费${p.fee} 服务费${p.svcFee} ｜${cut(p.behavior, 14)}`));
    }
    const mkt = MARKET.filter(m => !G.bought.has(m.id));
    if (mkt.length) L.push('〔跨界黑市〕' + mkt.slice(0, 8).map(m =>
      `${m.id} ${m.name}(${m.world} ¥${m.price.toLocaleString()})`).join(' · '));

    L.push('〔社会组织〕' + G.orgs.map(o => {
      const mk = b => TIER.map(t => b?.[t] ? '✓' : '—').join('');
      return `${o.name} ${o.corr || 0}% 规${mk(o.rules)} 特${mk(o.privs)}`;
    }).join(' · '));

    ['西城区', '东城区', '休闲区'].forEach(d => {
      const places = G.mapPlaces?.[d] || {};
      const nz = Object.keys(places).filter(p => places[p].length);
      if (nz.length) L.push(`〔地图·${d}〕` + nz.map(p => `${p}[${places[p].join('、')}]`).join(' · '));
    });
    return L.join('\n');
  };

  /* 供酒馆层 salvageBody 使用：剥出正文里裸写的命令行 */
  V.parseCommand = line => V.parse(line);
  V.isWhitelisted = cmd => !!cmd && !cmd.error && ROOTS.includes(cmd.path?.[0]?.seg);

  window.VARS = V;
})();
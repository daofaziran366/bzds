/* ============================================================
   腐化 · 目标图鉴模块（卡片分页 / 图像上传 / 档案页 / 人际关系图）
   依赖：data.js（TARGETS/RELATIONS/LV…）、app.js 工具（$/$$/ic/notify…）
   ============================================================ */
'use strict';

/* ---------- 目标图像（IndexedDB 持久化 · 按人物 id 键） ---------- */
function getCustomPortrait(id) {
  const m = window.PORTRAITS_MEM || {};
  return m[id] || null;
}
function setCustomPortrait(id, dataURL) {
  const m = window.PORTRAITS_MEM || (window.PORTRAITS_MEM = {});
  if (dataURL) m[id] = dataURL; else delete m[id];
  if (typeof window.PERSIST_PORTRAITS === 'function') window.PERSIST_PORTRAITS(m);
  return true;
}
function handlePhotoFile(file, id, onOk, onFail) {
  if (!file || !file.type.startsWith('image/')) { notify('warn', '格式不支持', '请选择图片文件（JPG / PNG / WebP）。'); return; }
  if (file.size > 8 * 1024 * 1024) { notify('warn', '文件过大', '图片需小于 8MB，请压缩后再试。'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const W = 450, H = 600; // 3:4 竖版，居中裁切
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const ratio = W / H;
      let cw, ch;
      if (img.width / img.height > ratio) { ch = img.height; cw = img.height * ratio; }
      else { cw = img.width; ch = img.width / ratio; }
      ctx.drawImage(img, (img.width - cw) / 2, (img.height - ch) / 2, cw, ch, 0, 0, W, H);
      const dataURL = cv.toDataURL('image/jpeg', .82);
      if (setCustomPortrait(id, dataURL)) { if (onOk) onOk(); }
      else if (onFail) onFail();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
let _tgFileInput = null;
function pickPortrait(id) {
  if (!_tgFileInput) {
    _tgFileInput = document.createElement('input');
    _tgFileInput.type = 'file'; _tgFileInput.accept = 'image/*'; _tgFileInput.hidden = true;
    document.body.appendChild(_tgFileInput);
    _tgFileInput.onchange = () => {
      const file = _tgFileInput.files && _tgFileInput.files[0];
      const pid = _tgFileInput._pid;
      _tgFileInput.value = '';
      if (file) handlePhotoFile(file, pid, () => {
        notify('success', '图像已上传', '人物图像已保存，卡片与档案同步显示。');
        /* 目标 → 刷新图鉴；庇护所 NPC → 刷新庇护所（含详情页） */
        const isNpc = typeof SANCTUM_NPCS !== 'undefined' && SANCTUM_NPCS[pid];
        if (isNpc) { if (typeof renderSanctum === 'function') renderSanctum(); }
        else renderTargets();
      }, () => notify('warn', '保存失败', '浏览器存储空间不足，图像未能保存。'));
    };
  }
  _tgFileInput._pid = id;
  _tgFileInput.click();
}
function portraitName(id) {
  const t = tgtById(id);
  if (t) return t.name;
  const npc = (typeof SANCTUM_NPCS !== 'undefined') ? SANCTUM_NPCS[id] : null;
  return npc ? npc.name : null;
}
function delPortrait(id) {
  const name = portraitName(id);
  if (!name) return;
  confirmDialog({
    title: '删除图像', okText: '删除',
    body: `${name} 的自定义图像将被删除，卡片与档案恢复默认样式，此操作不可撤销。`,
    onOk: () => {
      if (!setCustomPortrait(id, null)) return;
      notify('info', '已删除', `${name} 的图像已移除。`);
      const isNpc = typeof SANCTUM_NPCS !== 'undefined' && SANCTUM_NPCS[id];
      if (isNpc) { if (typeof renderSanctum === 'function') renderSanctum(); }
      else renderTargets();
    }
  });
}

/* ---------- 腐化目标 · 图鉴（卡片分页）与档案页 ---------- */
const TGT_PAGE_SIZE = 15;
function tgtFiltered() {
  const q = G.tgtQuery.trim();
  return G.targets.filter(t => {
    if (q && !(t.name.includes(q) || t.loc.includes(q) || t.title.includes(q))) return false;
    if (G.tgtFilter === 'action') return t.lv < 5;
    if (G.tgtFilter === 'high') return t.lv >= 3;
    if (G.tgtFilter === 'fallen') return t.lv >= 5;
    return true;
  });
}
function renderTargets() {
  const detail = $('#target-detail');
  if (G.tgtOpen) {
    $('#tgt-grid-wrap').hidden = true;
    detail.hidden = false;
    renderTargetDetail(G.focusId);
    return;
  }
  detail.hidden = true;
  $('#tgt-grid-wrap').hidden = false;

  const list = tgtFiltered();
  const pages = Math.max(1, Math.ceil(list.length / TGT_PAGE_SIZE));
  G.tgtPage = Math.max(1, Math.min(pages, G.tgtPage || 1));
  const pageList = list.slice((G.tgtPage - 1) * TGT_PAGE_SIZE, G.tgtPage * TGT_PAGE_SIZE);

  $('#target-grid').innerHTML = pageList.map((t, i) => {
    const custom = getCustomPortrait(t.id);
    return `
    <article class="tg-card" data-tgt="${esc(t.id)}" role="button" tabindex="0" style="--d:${i * 45}ms">
      ${custom
        ? `<img class="tg-img" src="${custom}" alt="${esc(t.name)}">`
        : `<span class="tg-fallback"><b>${esc(t.name)}</b><i>未上传图像</i></span>`}
      <span class="tg-lv l${t.lv}">Lv${t.lv} · ${LV_NAME(t.lv)}</span>
      <div class="tg-hover">
        <b class="tg-name">${esc(t.name)}</b>
        <span class="tg-title">${esc(t.title)}</span>
        <div class="tg-tools">
          <button class="qbtn" data-tg-upload="${t.id}" title="上传图像">${ic('i-camera')}</button>
          ${custom ? `<button class="qbtn" data-tg-delimg="${t.id}" title="删除图像">${ic('i-trash')}</button>` : ''}
          <button class="qbtn qbtn-del" data-tg-del="${esc(t.id)}" title="删除档案">${ic('i-x')}</button>
        </div>
      </div>
    </article>`;
  }).join('') || '<div class="train-empty">未找到匹配的目标</div>';
  $('#targets-sub').textContent = `城中的女性关键人物 · 共 ${G.targets.length} 名 · 显示 ${list.length} 名`;

  $$('#target-grid .tg-card').forEach(card => {
    card.addEventListener('click', () => openTargets(card.dataset.tgt));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); } });
  });
  $$('#target-grid [data-tg-upload]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); pickPortrait(b.dataset.tgUpload); }));
  $$('#target-grid [data-tg-delimg]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); delPortrait(b.dataset.tgDelimg); }));
  $$('#target-grid [data-tg-del]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    if (typeof deleteTargetCard === 'function') deleteTargetCard(b.dataset.tgDel, tgtById(b.dataset.tgDel)?.name || '该目标', renderTargets);
  }));

  $('#tgt-pager').innerHTML = `
    <button class="btn" id="tg-prev" ${G.tgtPage <= 1 ? 'disabled' : ''}>上一页</button>
    <label class="pager-jump">第 <input type="number" id="tg-page-inp" min="1" max="${pages}" value="${G.tgtPage}"> / ${pages} 页</label>
    <button class="btn" id="tg-next" ${G.tgtPage >= pages ? 'disabled' : ''}>下一页</button>`;
  $('#tg-prev').onclick = () => { G.tgtPage--; renderTargets(); };
  $('#tg-next').onclick = () => { G.tgtPage++; renderTargets(); };
  $('#tg-page-inp').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    if (isNaN(v)) return;
    G.tgtPage = Math.max(1, Math.min(pages, v));
    renderTargets();
  });
}

function openTargets(id) {
  G.focusId = id;
  G.tgtOpen = true;
  if (typeof persistUi === 'function') persistUi();
  if (G.view === 'targets') renderTargets();
  else switchView('targets');
}

function renderTargetDetail(id) {
  const t = tgtById(id);
  const d = $('#target-detail');
  if (!t) {
    d.innerHTML = `<header class="detail-top"><button class="btn btn-ghost" id="btn-tgt-back">返回图鉴</button></header>
      <div class="detail-empty">${ic('i-target')}<p>名单为空——这座城市暂时没有你可腐蚀的人。</p></div>`;
    $('#btn-tgt-back').onclick = () => { G.tgtOpen = false; persistUi(); renderTargets(); };
    return;
  }
  const custom = getCustomPortrait(t.id);
  const need = t.lv >= 5 ? 0 : LV_NEED[t.lv];
  const xpPct = t.lv >= 5 ? 100 : Math.min(100, t.xp / need * 100);
  d.innerHTML = `
    <header class="detail-top">
      <button class="btn btn-ghost" id="btn-tgt-back"><svg class="ic flip"><use href="#i-chevron-right"/></svg>返回图鉴</button>
      <span class="detail-crumb">人物档案 · ${esc(t.title)}</span>
    </header>
    <div class="detail-page">
      <aside class="detail-portrait">
        ${custom
          ? `<img class="portrait-img" src="${custom}" alt="${esc(t.name)}">`
          : `<div class="portrait-fallback"><span>${esc(t.name)}</span><b>未上传图像</b><i>PORTRAIT</i></div>`}
        <div class="portrait-tools">
          <button class="pt-btn" id="btn-portrait-upload">${ic('i-camera')}上传图像</button>
          ${custom ? `<button class="pt-btn danger" id="btn-portrait-del">${ic('i-trash')}删除图像</button>` : ''}
        </div>
      </aside>
      <div class="detail-main">
        <div class="detail-name-line">
          <div class="detail-name">${esc(t.name)}<span class="lv-label l${t.lv}">Lv${t.lv} · ${LV_NAME(t.lv)}</span></div>
          <p class="detail-title-line">${esc(t.title)} · ${t.age} 岁 · ${esc(t.schedule)}</p>
          <div class="detail-lvline">
            <span class="pips">${pipsHtml(t.lv, 13)}</span>
            <span class="lv-label l${t.lv}">${LV[t.lv].desc}</span>
            <span class="hint-chip">${ic('i-map')}${esc(t.loc)}</span>
          </div>
          <div class="meter" style="margin-top:12px"><span class="meter-label">腐化经验</span><span class="meter-track"><span class="meter-fill lv" style="width:${xpPct}%;display:block"></span></span><span class="meter-num">${t.lv >= 5 ? '已圆满' : t.xp + ' / ' + need}</span></div>
        </div>
        <div class="detail-actions">
          <button class="btn act-btn" id="btn-act-observe">${ic('i-eye')}观察</button>
          <button class="btn act-btn" id="btn-act-talk">${ic('i-chat')}交谈</button>
          <button class="btn act-btn" id="btn-act-potion">${ic('i-flask')}使用单人药剂 ×${G.potions.single}</button>
          <button class="btn act-btn" id="btn-act-oath" ${t.lv >= 4 && t.lv < 5 ? '' : 'disabled'}>${ic(t.lv >= 4 ? 'i-crown' : 'i-lock')}奴契仪式 · 需 Lv4</button>
        </div>
        <div class="section-title">当前状态</div>
        <div class="detail-stats">
          <div class="stat-box"><span class="stat-ic">${ic('i-map')}</span><div><b>当前位置</b><p>${esc(t.loc)}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-wind')}</span><div><b>当前行为</b><p>${esc(t.behavior)}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-brain')}</span><div><b>当前想法</b><p>${esc(t.thought)}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-mask')}</span><div><b>当前妆容</b><p>${esc(t.makeup)}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-user')}</span><div><b>当前服装</b><p>${esc(t.outfit)}</p></div></div>
          <div class="stat-box"><span class="stat-ic">${ic('i-ticket')}</span><div><b>日程安排</b><p>${esc(t.schedule)}</p></div></div>
        </div>
        <div class="section-title">人际关系</div>
        ${t.rel ? `<p class="rel-note">${ic('i-users')}<span>${esc(t.rel)}</span></p>` : ''}
        ${relGraphHtml(t)}
      </div>
    </div>`;

  $('#btn-tgt-back').onclick = () => { G.tgtOpen = false; persistUi(); renderTargets(); };
  const up = $('#btn-portrait-upload');
  if (up) up.onclick = () => pickPortrait(t.id);
  const del = $('#btn-portrait-del');
  if (del) del.onclick = () => delPortrait(t.id);

  /* 观察/交谈：只以浮层提示情报，不加经验值、不往正文区插消息——
     经验与剧情推进一律走大模型的变量命令 */
  $('#btn-act-observe').onclick = () => {
    notify('info', '观察 · ' + t.name, `她${t.behavior}。心里正想着：${t.thought}`);
  };
  $('#btn-act-talk').onclick = () => {
    notify('info', '交谈 · ' + t.name, `谈笑间她眼底藏着一层没有说破的东西。`);
  };
  $('#btn-act-potion').onclick = () => { G.focusId = t.id; usePotionOn(t.id, 'single'); };
  $('#btn-act-oath').onclick = () => {
    if (t.lv < 4 || t.lv >= 5) return;
    G.trainId = t.id;
    switchView('sanctum');
    notify('info', '奴契仪式', '仪式需三项条件：调教圆满 · 乌托邦登台 · 服下夜冕之酒。条件与仪式都在调教室完成。');
  };
  $$('#rel-graph [data-rel]').forEach(n => n.addEventListener('click', () => openTargets(n.dataset.rel)));
}

/* 人际关系图：中心为当前目标；双向箭头 + 双向标注，分清“谁是谁的什么” */
function relGraphHtml(t) {
  const W = 660, H = 340, cx = W / 2, cy = H / 2 + 6;
  const others = G.targets.filter(x => x.id !== t.id);
  const RX = 250, RY = 116;
  const pos = {};
  others.forEach((o, i) => {
    const ang = -Math.PI / 2 + i * (Math.PI * 2 / others.length);
    pos[o.id] = [cx + Math.cos(ang) * RX, cy + Math.sin(ang) * RY];
  });
  /* RELATIONS 是硬编码的静态表，里面引用了一批并不存在于 G.targets 的 ID
     （luoxingye / wenshuyao …）。原版沙盒名单为空、走不到这里；LLM 用 <set>
     建了目标后，一旦建出的 ID 撞上这张表，pos[otherId] 就是 undefined →
     解构抛错，整个档案页打不开。所以只画两端都真实存在的边。 */
  const rels = RELATIONS.filter(r => {
    if (r.a !== t.id && r.b !== t.id) return false;
    return !!tgtById(r.a === t.id ? r.b : r.a);
  });

  let svg = `<defs>
    <marker id="arr-gold" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="rgba(201,164,92,.85)"/>
    </marker>
  </defs>`;

  rels.forEach(r => {
    const otherId = r.a === t.id ? r.b : r.a;
    const [x2, y2] = pos[otherId];
    // 方向语义：O 是 C 的 X（箭头 O→C）；C 是 O 的 Y（箭头 C→O）
    const oIsA = r.a === otherId;
    const relOC = oIsA ? r.ab : r.ba; // O 对 C 而言的身份
    const relCO = oIsA ? r.ba : r.ab; // C 对 O 而言的身份
    const dx = cx - x2, dy = cy - y2;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux; // 垂直单位向量
    const rO = 25, rC = 32, off = 5;
    // 线 1：O → C（箭头指向 C）＝“O 是 C 的 relOC”，标注靠近起点 O
    const l1x1 = x2 + ux * rO + px * off, l1y1 = y2 + uy * rO + py * off;
    const l1x2 = cx - ux * rC + px * off, l1y2 = cy - uy * rC + py * off;
    svg += `<line class="rel-edge" x1="${l1x1}" y1="${l1y1}" x2="${l1x2}" y2="${l1y2}" marker-end="url(#arr-gold)"/>`;
    svg += `<text class="rel-edge-label" x="${l1x1 + (l1x2 - l1x1) * .3 + px * 10}" y="${l1y1 + (l1y2 - l1y1) * .3 + py * 10 + 3}" text-anchor="middle">${relOC}</text>`;
    // 线 2：C → O（箭头指向 O）＝“C 是 O 的 relCO”，标注靠近起点 C
    const l2x1 = cx - ux * rC - px * off, l2y1 = cy - uy * rC - py * off;
    const l2x2 = x2 + ux * rO - px * off, l2y2 = y2 + uy * rO - py * off;
    svg += `<line class="rel-edge" x1="${l2x1}" y1="${l2y1}" x2="${l2x2}" y2="${l2y2}" marker-end="url(#arr-gold)"/>`;
    svg += `<text class="rel-edge-label" x="${l2x1 + (l2x2 - l2x1) * .3 - px * 10}" y="${l2y1 + (l2y2 - l2y1) * .3 - py * 10 + 3}" text-anchor="middle">${relCO}</text>`;
  });

  svg += `<g class="rel-node center"><circle cx="${cx}" cy="${cy}" r="30"/><text x="${cx}" y="${cy + 4}" text-anchor="middle">${esc(t.name)}</text></g>`;
  svg += others.map(o => {
    const [x, y] = pos[o.id];
    const linked = rels.some(r => r.a === o.id || r.b === o.id);
    return `<g class="rel-node ${linked ? 'linked' : 'dim'}" data-rel="${esc(o.id)}">
      <circle cx="${x}" cy="${y}" r="23"/>
      <text x="${x}" y="${y + 4}" text-anchor="middle">${esc(o.name)}</text>
      <text class="rel-lv" x="${x}" y="${y + 40}" text-anchor="middle">Lv${o.lv}</text>
    </g>`;
  }).join('');
  /* 名单里只有她自己时，画一个孤零零的圆没意义 —— 给一句可读的提示 */
  if (!others.length) {
    return `<p class="rel-empty">${ic('i-users')}这座城市里还没有其他人认识她——用 &lt;set&gt; 建立更多腐化目标后，关系网会自己长出来。</p>`;
  }
  return `<svg class="rel-graph" id="rel-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.name)} 的人际关系">${svg}</svg>`;
}

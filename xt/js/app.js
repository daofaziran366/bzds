/* ═══════════════════════════════════════════════════════════════
   婊子打手召唤系统 · 酒馆化应用逻辑
   聊天大堂（SillyTavern 风格）+ 游戏视图联动 + 灵枢 LLM 桥
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ───────────── 工具 ───────────── */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const rnd = (a,b)=>a+Math.random()*(b-a);
const pick = arr => arr[Math.floor(Math.random()*arr.length)];
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const icon = id => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
const charById = id => CHARS.find(c=>c.id===id);
const CN_DIGITS='零一二三四五六七八九';
function cnNum(n){
  if(n<10)return CN_DIGITS[n];
  if(n<20)return '十'+(n%10?CN_DIGITS[n%10]:'');
  if(n<100)return CN_DIGITS[Math.floor(n/10)]+'十'+(n%10?CN_DIGITS[n%10]:'');
  return String(n);
}
const nowLabel = () => {
  const d = new Date();
  const h = d.getHours();
  const day = h<4?'深夜':h<8?'凌晨':h<12?'上午':h<18?'午后':h<21?'黄昏':'夜晚';
  return `${day} ${String(h).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
};
const fmtTime = ts => { const d = new Date(ts); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };

/* ───────────── 音效（WebAudio 合成） ───────────── */
const A = {
  ctx:null, enabled:true,
  ensure(){
    if(!this.ctx){ try{ this.ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
    if(this.ctx&&this.ctx.state==='suspended'){ try{ this.ctx.resume(); }catch(e){} }
    return this.ctx&&this.ctx.state==='running' ? this.ctx : null;
  },
  tone(freq,dur,type='sine',gain=.06,when=0,slide=0){
    if(!this.enabled||!this.ensure())return;
    const t = this.ctx.currentTime+when;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type=type; o.frequency.setValueAtTime(freq,t);
    if(slide)o.frequency.exponentialRampToValueAtTime(Math.max(30,freq+slide),t+dur);
    g.gain.setValueAtTime(gain,t);
    g.gain.exponentialRampToValueAtTime(.0001,t+dur);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t+dur+.02);
  },
  noise(dur,gain=.05,when=0){
    if(!this.enabled||!this.ensure())return;
    const t = this.ctx.currentTime+when;
    const n = Math.floor(this.ctx.sampleRate*dur);
    const buf = this.ctx.createBuffer(1,n,this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i=0;i<n;i++)d[i]=(Math.random()*2-1)*(1-i/n);
    const src = this.ctx.createBufferSource(); src.buffer=buf;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(gain,t);
    g.gain.exponentialRampToValueAtTime(.0001,t+dur);
    const f = this.ctx.createBiquadFilter(); f.type='lowpass'; f.frequency.value=900;
    src.connect(f).connect(g).connect(this.ctx.destination); src.start(t);
  },
  click(){ this.tone(340,.06,'triangle',.04); },
  hover(){ this.tone(520,.03,'sine',.02); },
  chime(){ this.tone(880,.5,'sine',.05); this.tone(1318,.7,'sine',.035,.09); this.tone(1760,.9,'sine',.02,.18); },
  boom(){ this.tone(70,.8,'sine',.12,0,-30); this.noise(.5,.06); },
  whoosh(){ this.noise(.35,.035); this.tone(240,.3,'sine',.02,0,140); },
  toggle(){ this.enabled=!this.enabled; this.click(); return this.enabled; },
};
window.addEventListener('pointerdown',()=>A.ensure(),{once:true});
window.addEventListener('keydown',()=>A.ensure(),{once:true});

/* ───────────── 粒子特效 ───────────── */
const FX = {
  layer:null,
  init(){ this.layer = $('#fx-layer'); },
  spark(x,y,opts={}){
    if(!this.layer)this.init();
    const n = opts.n||1;
    for(let i=0;i<n;i++){
      const s = document.createElement('span');
      s.className='fx-spark';
      const size = opts.size? rnd(opts.size*.6,opts.size) : rnd(1.6,3.6);
      s.style.width=s.style.height=size+'px';
      s.style.left=x+'px'; s.style.top=y+'px';
      const ang = rnd(0,Math.PI*2), dist = opts.spread? rnd(10,opts.spread) : rnd(18,90);
      const dx = Math.cos(ang)*dist, dy = Math.sin(ang)*dist*.7 - (opts.up? rnd(20,60):0);
      const life = rnd(600,1400);
      s.animate([
        {transform:'translate(-50%,-50%) scale(1)',opacity:1},
        {transform:`translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) scale(.1)`,opacity:0}
      ],{duration:life,easing:'cubic-bezier(.2,.7,.4,1)',fill:'forwards'});
      this.layer.appendChild(s);
      setTimeout(()=>s.remove(),life+50);
    }
  },
  burstAt(el,opts={}){
    const r = el.getBoundingClientRect();
    this.spark(r.left+r.width/2, r.top+r.height/2, opts);
  },
  ambient(){
    const m = $('#chat-main');
    if(!m)return;
    let last=0;
    const tick = t=>{
      if(t-last>700){
        last=t;
        const r = m.getBoundingClientRect();
        if(r.width<10)return;
        this.spark(rnd(r.left+40,r.right-40), rnd(r.top+60,r.bottom-80), {n:1,size:1.6,spread:14});
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
};

/* ───────────── 游戏状态（localStorage） ───────────── */
const SAVE_KEY = 'dfzr-state-v2';
const S = {
  pearls:SEED.pearls, victories:SEED.victories,
  owned:[...SEED.owned], stationed:SEED.stationed,
  disposals:SEED.disposals.map(d=>({...d})),
  talents:Object.fromEntries(TALENTS.map(t=>[t.id,t.level])),
  llm:{mode:'mock',endpoint:'',key:'',model:'',temp:0.85},
  sound:true,
  seen:SEED.owned.concat(SEED.disposals.map(d=>d.charId)),
};
function saveState(){ try{ localStorage.setItem(SAVE_KEY,JSON.stringify(S)); }catch(e){} }
function loadState(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(!raw)return;
    const s = JSON.parse(raw);
    Object.assign(S,{
      pearls:s.pearls??S.pearls, victories:s.victories??S.victories,
      owned:s.owned??S.owned, stationed:s.stationed??S.stationed,
      disposals:s.disposals??S.disposals,
      talents:{...S.talents,...(s.talents||{})},
      llm:{...S.llm,...(s.llm||{})},
      sound:s.sound??true,
      seen:Array.from(new Set([...S.seen,...(s.seen||[])]).values()),
    });
  }catch(e){}
}
/* 角色当前情绪（可变，处置/战斗会影响） */
const MOOD = {};
function charMood(id){
  if(!MOOD[id]){ const c = charById(id); MOOD[id] = { 战意:c.morale, 顺从度:c.obedience, 欲望:c.desire, 好感度:c.affection }; }
  return MOOD[id];
}
function setMood(id, updates){
  const m = charMood(id);
  for(const [k,v] of Object.entries(updates)) m[k]=clamp((m[k]||0)+v,0,100);
  const chat = ST.activeChat;
  if(chat && chat.characterId===id) syncChatVars(chat);
  renderChatHeader();
}

/* ───────────── 视图路由（lobby + 游戏视图） ───────────── */
let currentView='lobby';
function go(view,opts={}){
  if(view==='lobby'){
    $('#tavern-layout').style.display='';
    $('#game-shell').style.display='none';
  }else{
    $('#tavern-layout').style.display='none';
    $('#game-shell').style.display='';
    $$('.view').forEach(v=>v.classList.remove('active'));
    const target = $('#view-'+view);
    if(target)target.classList.add('active');
    if(view==='codex'){ renderCodexFilters(); renderCodex(); }
    if(view==='disposal')renderDisposal();
    if(view==='talent')renderTalents();
    if(view==='arena' && Battle.state==='idle')startBattle();
    if(view==='summon')A.whoosh();
  }
  currentView=view;
  $$('.nav-item').forEach(n=>n.classList.toggle('is-active',n.dataset.view===view));
  $$('#nav-drawer-items .drawer-item').forEach(n=>n.classList.toggle('is-active',n.dataset.view===view));
  closeDrawer();
  A.whoosh();
}
$$('.nav-item').forEach(b=>b.addEventListener('click',()=>{ A.click(); go(b.dataset.view); }));

/* ───────────── 立绘挂载 ───────────── */
function mountPortrait(el,charId,{crop='full'}={}){
  const c = charById(charId);
  if(!el||!c)return;
  el.innerHTML = portraitSVG(c, charId);
  const svg = el.querySelector('svg');
  if(crop==='bust'){ svg.style.transform='scale(1.62)'; svg.style.transformOrigin='50% 10%'; }
  return c;
}

/* ═══════════════════════════════════════════════════════════════
   酒馆 · 侧栏（角色卡 + 会话列表）
   ═══════════════════════════════════════════════════════════════ */
function renderSidebar(){
  const kw = ($('#char-search').value||'').trim();
  const list = $('#char-list');
  list.innerHTML = CHARS.filter(c=>!kw || c.name.includes(kw) || c.plane.includes(kw)).map(c=>{
    const owned = S.owned.includes(c.id);
    const seen = S.seen.includes(c.id);
    const stationed = S.stationed===c.id;
    const active = ST.activeChat?.characterId===c.id;
    const chats = ST.chats.filter(ch=>ch.characterId===c.id);
    const dotCls = stationed?'stationed':owned?'owned':seen?'seen':'new';
    const dotTitle = stationed?'驻场':owned?'已缔约':seen?'已相遇':'未遇';
    return `<button class="char-card ${active?'is-active':''}" data-char="${c.id}" aria-label="${esc(c.name)}">
      <span class="char-card__port" data-port="${c.id}"></span>
      <span class="char-card__meta">
        <span class="char-card__name">${esc(c.name)}</span>
        <span class="char-card__sub">${esc(c.plane)}</span>
      </span>
      <span class="char-card__state" title="${dotTitle}"><span class="state-dot state-dot--${dotCls}"></span></span>
      ${chats.length?`<span class="char-card__msgcount">${chats.reduce((a,ch)=>a+ch.messages.filter(m=>m.role==='assistant').length,0)}</span>`:''}
    </button>`;
  }).join('');
  list.querySelectorAll('.char-card').forEach(card=>{
    mountPortrait(card.querySelector('[data-port]'),card.dataset.char,{crop:'bust'});
    card.addEventListener('click',()=>{ A.click(); openCharChat(card.dataset.char); });
  });
  $('#char-count').textContent = CHARS.length;
  renderChatList();
}

function renderChatList(){
  const list = $('#chat-list');
  const chats = ST.chats.slice().sort((a,b)=>b.updatedAt-a.updatedAt);
  if(!chats.length){
    list.innerHTML = '<div class="chat-list__empty">尚无会话<br>点选角色卡即可开席</div>';
    return;
  }
  list.innerHTML = chats.map(ch=>`
    <div class="chat-item ${ch.id===ST.activeChatId?'is-active':''}" data-chat="${ch.id}">
      <span class="chat-item__name">${esc(ch.name)}</span>
      <span class="chat-item__time">${fmtTime(ch.updatedAt)}</span>
      <button class="chat-item__del" data-del="${ch.id}" aria-label="删除会话">${icon('i-trash')}</button>
    </div>`).join('');
  list.querySelectorAll('.chat-item').forEach(it=>{
    it.addEventListener('click',e=>{
      if(e.target.closest('.chat-item__del'))return;
      A.click();
      ST.loadChat(it.dataset.chat).then(()=>renderAll());
    });
  });
  list.querySelectorAll('.chat-item__del').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      openConfirm({title:'弃置会话',text:'此会话将被焚毁，不可复原。是否继续？',yes:'焚毁',fn:async()=>{
        await ST.deleteChat(btn.dataset.del);
        renderSidebar(); renderChat();
      }});
    });
  });
}

/* ═══════════════════════════════════════════════════════════════
   酒馆 · 聊天引擎
   ═══════════════════════════════════════════════════════════════ */
let streamAbort = null;

async function openCharChat(charId, opts={}){
  const c = charById(charId);
  if(!c)return;
  const existing = ST.chats.filter(ch=>ch.characterId===charId).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  let chat = existing;
  if(!chat){
    const card = CHAR_CARDS[charId] || {};
    const greeting = opts.greeting || pick(card.greetings || [LORE_POOL.welcome ? '……' : '']);
    const mood = charMood(charId);
    chat = await ST.createChat({
      name: `${c.name} · ${opts.name || '初逢'}`,
      characterId: charId,
      characterName: c.name,
      variables: {...mood},
    });
    if(greeting){
      chat.messages.push(createMessage('assistant', greeting, {
        kind:'chat', variables:{...chat.variables},
        parsed:{maintext:greeting,options:quickOptionsFor(charId),sum:'',thinking:'',optionsRaw:[]},
        swipe:swipeCandidates(charId,'greeting'),
      }));
      chat.variables = {...chat.variables};
      await ST.persistChat(chat);
    }
  }
  await ST.loadChat(chat.id);
  renderAll();
  closeDrawer();   // 窄屏下收起侧栏
}

/** 快捷选项（GameView option 模式）：角色话术 + 上下文事件 */
function quickOptionsFor(charId){
  const card = CHAR_CARDS[charId]||{};
  const opts = (card.quickReplies||[]).slice(0,3);
  if(Battle.pendingVictim) opts.push('📜 开启裁决之匣'.replace('📜',''));
  if(S.pearls>0) opts.push('○ 前往召唤台'.replace('○',''));
  return opts.length?opts:['……'];
}
function quickRepliesFor(chat){
  const c = chat?charById(chat.characterId):null;
  const items = [];
  if(c){
    const card = CHAR_CARDS[c.id]||{};
    (card.quickReplies||[]).slice(0,4).forEach(t=>items.push({text:t,event:false}));
  }
  if(Battle.pendingVictim) items.push({text:`开启裁决之匣 · ${Battle.pendingVictim.name}`,event:true,action:'verdict'});
  if(items.length<2) items.push({text:'聊点什么……',event:false});
  return items;
}

/** 确保 chat-empty 占位存在（scroll.innerHTML 重建会抹掉它） */
const EMPTY_HTML = `<div class="chat-empty" id="chat-empty">
  <svg class="chat-empty__sigil" aria-hidden="true"><use href="#i-chat"/></svg>
  <p class="chat-empty__title">诸界酒馆 · 静候来客</p>
  <p class="chat-empty__sub">点选左侧角色卡开席，或进入召唤台，以意象钓一缕新魂。</p>
</div>`;
function ensureEmpty(){
  let e = $('#chat-empty');
  if(!e){ $('#chat-scroll').insertAdjacentHTML('afterbegin', EMPTY_HTML); e = $('#chat-empty'); }
  return e;
}

/** 消息渲染 */
function renderChat(){
  const chat = ST.activeChat;
  const scroll = $('#chat-scroll');
  if(!chat){
    ensureEmpty();
    $('#chat-empty').style.display='';
    scroll.querySelectorAll('.msg').forEach(el=>el.remove());
    $('#chat-header').classList.add('is-empty');
    $('#chat-char-name').textContent='—';
    $('#chat-char-plane').textContent='请从左侧选择一位来客，或轻触回响之契';
    $('#chat-char-badges').innerHTML='';
    $('#quick-replies').innerHTML='';
    $('#btn-chat-roll').classList.add('is-disabled');
    $('#btn-chat-continue').classList.add('is-disabled');
    return;
  }
  scroll.innerHTML = chat.messages.map((m,i)=>renderMessage(m,i,chat)).join('');
  ensureEmpty();
  $('#chat-empty').style.display='none';
  $('#chat-header').classList.remove('is-empty');
  const c = charById(chat.characterId);
  $('#chat-char-name').textContent = chat.characterName;
  $('#chat-char-plane').textContent = c ? `${c.plane} · ${c.epithet}` : '';
  renderChatHeader();
  scroll.innerHTML = chat.messages.map((m,i)=>renderMessage(m,i,chat)).join('');
  scroll.querySelectorAll('[data-swipe]').forEach(btn=>btn.addEventListener('click',()=>swipeMessage(btn.dataset.swipe)));
  scroll.querySelectorAll('.msg__option').forEach(b=>b.addEventListener('click',()=>sendMessage(b.textContent)));
  scroll.querySelectorAll('[data-act-edit]').forEach(b=>b.addEventListener('click',()=>startEditMsg(b.dataset.actEdit)));
  scroll.querySelectorAll('[data-act-del]').forEach(b=>b.addEventListener('click',()=>ST.deleteMessagesFrom(b.dataset.actDel).then(renderAll)));
  scroll.querySelectorAll('[data-act-branch]').forEach(b=>b.addEventListener('click',async()=>{
    const branch = await ST.branchFromMessage(b.dataset.actBranch);
    if(branch){ renderSidebar(); renderChat(); notify('whisper','灵质低语',`已从该处生出分支：「${branch.name}」。`); }
  }));
  scroll.querySelectorAll('.msg__edit-confirm').forEach(b=>b.addEventListener('click',confirmEditMsg));
  scroll.querySelectorAll('.msg__edit-cancel').forEach(b=>b.addEventListener('click',cancelEditMsg));
  scroll.querySelectorAll('.event-card__btn[data-ev]').forEach(b=>b.addEventListener('click',()=>eventAction(b.dataset.ev,b.dataset.arg)));
  renderQuickReplies();
  const last = chat.messages[chat.messages.length-1];
  $('#btn-chat-roll').classList.toggle('is-disabled', !last || last.role!=='assistant' || ST.isSending);
  $('#btn-chat-continue').classList.toggle('is-disabled', !last || last.role!=='assistant' || ST.isSending);
  scroll.scrollTop = scroll.scrollHeight;
}

function renderMessage(m,i,chat){
  const c = charById(chat.characterId);
  const time = fmtTime(m.timestamp);
  const card = CHAR_CARDS[chat.characterId]||{};
  const display = m.swipe && m.swipe.length && m.swipeIdx>=0 ? m.swipe[m.swipeIdx] : m.content;
  const acts = `
    <div class="msg__actions">
      ${m.role===USER_ROLE?`<button class="msg__act" data-act-edit="${m.id}">${icon('i-edit')}编辑并重新生成</button>`:''}
      <button class="msg__act" data-act-del="${m.id}">${icon('i-trash')}删除后续</button>
      <button class="msg__act" data-act-branch="${m.id}">${icon('i-branch')}从此分支</button>
    </div>`;

  if(m.kind==='sys'){
    return `<div class="msg msg--sys">
      <div class="msg__bubble">${icon(m.event?.icon||'i-feather')}<span>${esc(m.content)}</span></div>
    </div>`;
  }
  if(m.kind==='event'){
    const ev = m.event||{};
    const scarlet = ev.tone==='scarlet';
    const actions = (ev.actions||[]).map(a=>`<button class="event-card__btn ${a.cls||''}" data-ev="${ev.type}" data-arg="${a.arg||''}">${icon(a.icon)}<span>${a.label}</span></button>`).join('');
    return `<div class="msg msg--event">
      <article class="event-card ${scarlet?'event-card--scarlet':''}">
        <div class="event-card__top">
          <span class="event-card__icon">${icon(ev.icon||'i-scepter')}</span>
          <span class="event-card__title">${esc(ev.title)}</span>
          <span class="event-card__time">${time}</span>
        </div>
        <div class="event-card__body">${esc(ev.body||'')}</div>
        ${actions?`<div class="event-card__actions">${actions}</div>`:''}
      </article>
    </div>`;
  }
  const optsHtml = (m.parsed && m.parsed.options && m.parsed.options.length && i===chat.messages.length-1)
    ? `<div class="msg__options">${m.parsed.options.map(o=>`<button class="msg__option">${esc(o)}</button>`).join('')}</div>` : '';
  const swipeHtml = (m.role==='assistant' && m.swipe && m.swipe.length>1)
    ? `<div class="msg__swipe">
        <button class="msg__swipe-btn" data-swipe="${m.id}">${icon('i-swap')}换一种说法</button>
        <span class="msg__swipe-count">${(m.swipeIdx||0)+1} / ${m.swipe.length}</span>
      </div>` : '';

  if(m.role===USER_ROLE){
    return `<div class="msg msg--me">
      <div class="msg__meta"><span class="msg__name">${esc(chat.userName||'契约者')}</span><span class="msg__time">${time}</span></div>
      ${m.editing?`<div class="msg__edit-row">
          <textarea class="msg__edit-input">${esc(m.content)}</textarea>
          <button class="btn-primary btn-primary--gold msg__edit-confirm" data-edit-id="${m.id}">重发</button>
          <button class="btn-ghost msg__edit-cancel">取消</button>
        </div>`:`<div class="msg__bubble">${esc(display)}</div>`}
      ${acts}
    </div>`;
  }
  return `<div class="msg msg--them">
    <div class="msg__meta">
      <span class="msg__meta-port" data-mport="${c?c.id:''}"></span>
      <span class="msg__name">${esc(m.role==='assistant'?chat.characterName:'灵枢')}</span>
      <span class="msg__time">${time}</span>
    </div>
    <div class="msg__bubble ${m.streaming?'is-streaming':''}">${esc(display)}</div>
    ${optsHtml}
    ${swipeHtml}
    ${acts}
  </div>`;
}

/* 追加消息（直接渲染尾部） */
function appendMsgEl(chat,m){
  const scroll = $('#chat-scroll');
  const empty = $('#chat-empty');
  if(empty)empty.style.display='none';
  const wrap = document.createElement('div');
  wrap.innerHTML = renderMessage(m, chat.messages.length-1, chat);
  const el = wrap.firstElementChild;
  scroll.appendChild(el);
  // 绑定新元素事件
  el.querySelectorAll('[data-swipe]').forEach(b=>b.addEventListener('click',()=>swipeMessage(b.dataset.swipe)));
  el.querySelectorAll('.msg__option').forEach(b=>b.addEventListener('click',()=>sendMessage(b.textContent)));
  el.querySelectorAll('[data-act-edit]').forEach(b=>b.addEventListener('click',()=>startEditMsg(b.dataset.actEdit)));
  el.querySelectorAll('[data-act-del]').forEach(b=>b.addEventListener('click',()=>ST.deleteMessagesFrom(b.dataset.actDel).then(renderAll)));
  el.querySelectorAll('[data-act-branch]').forEach(b=>b.addEventListener('click',async()=>{
    const branch = await ST.branchFromMessage(b.dataset.actBranch);
    if(branch){ renderSidebar(); renderChat(); notify('whisper','灵质低语',`已从该处生出分支：「${branch.name}」。`); }
  }));
  el.querySelectorAll('.event-card__btn[data-ev]').forEach(b=>b.addEventListener('click',()=>eventAction(b.dataset.ev,b.dataset.arg)));
  if(m.role==='assistant'){
    const port = el.querySelector('[data-mport]');
    if(port && chat.characterId) mountPortrait(port, chat.characterId, {crop:'bust'});
  }
  scroll.scrollTop = scroll.scrollHeight;
  return el;
}

function renderAll(){
  renderSidebar();
  renderChat();
  renderChatHeader();
}

/* ── 发送 ── */
async function sendMessage(text){
  const chat = ST.activeChat;
  if(!chat){ notify('whisper','灵质低语','先选一位来客入座，再开口不迟。'); return; }
  if(ST.isSending || !text.trim())return;
  A.click();
  const msg = createMessage('user', text.trim(), { kind:'chat', variables:{...chat.variables} });
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  await ST.persistChat(chat);
  appendMsgEl(chat, msg);
  $('#chat-input').value='';
  autoGrowInput();
  await replyStream(chat, msg);
}

/** 流式回复（mock 或 remote，远端解析 XML 标签） */
async function replyStream(chat, userMsg, opts={}){
  ST.isSending = true;
  $('#btn-chat-send').classList.add('is-busy');
  renderChatHeader();
  const c = charById(chat.characterId);
  const card = CHAR_CARDS[chat.characterId]||{};

  const asst = createMessage('assistant', '', {
    kind:'chat', streaming:true, variables:null,
    parsed:null, swipe:[], swipeIdx:0,
  });
  chat.messages.push(asst);
  const el = appendMsgEl(chat, asst);
  const bubble = el.querySelector('.msg__bubble');

  const onText = acc => { bubble.textContent = acc; $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight; };

  let finalText = '';
  if(S.llm.mode==='remote' && S.llm.endpoint && S.llm.key && S.llm.model){
    // 远端：流式 + XML 标签解析（skill GameView 模式）
    const preset = ST.presets.find(p=>p.id===chat.presetId) || ST.presets[0];
    const books = ST.lorebooks.filter(b=>(ST.settings.activeLorebookIds||[]).includes(b.id));
    const { messages: prompt } = assemblePrompt({
      userInput: userMsg.content, history: chat.messages.slice(0,-1),
      preset, lorebooks: books, character: card,
      userName: chat.userName, characterName: chat.characterName,
      variables: chat.variables,
      formatPrompt: ST.settings.formatPromptTemplate,
    });
    const parser = new StreamTagParser(ST.settings.customTags, DEFAULT_OPAQUE_TAGS);
    const allEvents = [];
    let show = '';
    try{
      finalText = await Llm.streamRemote(prompt, chunk=>{
        for(const ev of parser.feed(chunk)){
          allEvents.push(ev);
          if(ev.type==='raw') show += ev.chunk;
          else if(ev.type==='tag-chunk' && ev.tag==='maintext') show += ev.chunk;
        }
        bubble.textContent = show;
        $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
      }, ()=>{ if(streamAbort){ streamAbort.abort(); } });
      allEvents.push(...parser.finish());
      const parsed = aggregateEvents(allEvents);
      if(parsed.maintext){ show = parsed.maintext; finalText = parsed.maintext; }
      asst.parsed = {
        thinking: parsed.thinking, maintext: parsed.maintext || show,
        options: parsed.options.length?parsed.options:quickOptionsFor(chat.characterId),
        sum: parsed.sum, thinkingShow: parsed.thinking,
      };
      asst.swipe = [finalText];
      if(parsed.varsCommands && Object.keys(parsed.varsCommands.merge).length){
        chat.variables = mergeVariables(chat.variables, parsed.varsCommands.merge);
        syncGameStateFromVars(chat);
      }
    }catch(e){
      finalText = mockChatReply(chat, userMsg.content);
      asst.parsed = {maintext:finalText, options:quickOptionsFor(chat.characterId), thinking:'', sum:''};
      asst.swipe = [finalText];
    }
  }else{
    // 模拟回响：内置引擎
    finalText = mockChatReply(chat, userMsg.content);
    asst.parsed = {maintext:finalText, options:quickOptionsFor(chat.characterId), thinking:'', sum:''};
    asst.swipe = swipeCandidates(chat.characterId, null, userMsg.content);
    // 流式打字
    const chars = [...finalText];
    if(!reduceMotion){
      let i=0;
      await new Promise(res=>{
        const step=()=>{
          const n=Math.max(2,Math.round(rnd(1,3)));
          i=Math.min(chars.length,i+n);
          bubble.textContent=chars.slice(0,i).join('');
          $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
          if(i<chars.length)setTimeout(step,rnd(14,30));
          else res();
        };
        step();
      });
    }else{
      bubble.textContent = finalText;
    }
  }

  asst.content = finalText;
  asst.streaming = false;
  bubble.classList.remove('is-streaming');
  bubble.textContent = finalText;
  asst.variables = {...chat.variables};
  chat.updatedAt = Date.now();
  await ST.persistChat(chat);
  ST.isSending = false;
  $('#btn-chat-send').classList.remove('is-busy');
  renderChat();  // 全量重渲染（选项/swipe/操作条）
  renderSidebar();
  A.chime();
}

/** swipe 候选（mock 变体） */
function swipeCandidates(charId, kind, userText){
  const card = CHAR_CARDS[charId]||{};
  const pool = kind==='greeting' ? (card.greetings||[]) : [mockChatReply({characterId:charId,characterName:charById(charId)?.name},userText||'')];
  const out = [];
  for(let i=0;i<Math.max(2,pool.length);i++){ const t=pool[i%pool.length]; if(t && !out.includes(t))out.push(t); }
  if(out.length<2) out.push(out[0]||'……');
  return out;
}

async function swipeMessage(id){
  const chat = ST.activeChat;
  if(!chat)return;
  const m = chat.messages.find(x=>x.id===id);
  if(!m || !m.swipe || !m.swipe.length)return;
  A.click();
  m.swipeIdx = ((m.swipeIdx||0)+1) % m.swipe.length;
  m.content = m.swipe[m.swipeIdx];
  await ST.persistChat(chat);
  renderChat();
  FX.burstAt($('#chat-scroll'),{n:8,size:2,up:true,spread:50});
}

/* ── 继续 / 重roll ── */
async function continueLast(){
  const chat = ST.activeChat;
  if(!chat||ST.isSending)return;
  const last = chat.messages[chat.messages.length-1];
  if(!last || last.role!=='assistant')return;
  A.click();
  await ST.truncateTo(last.id);
  const m = createMessage('user','（她沉默了片刻，似有未尽之言）',{kind:'chat',variables:{...chat.variables}});
  chat.messages.push(m);
  await ST.persistChat(chat);
  renderChat();
  await replyStream(chat, m);
}
async function rollLast(){
  const chat = ST.activeChat;
  if(!chat||ST.isSending)return;
  const last = chat.messages[chat.messages.length-1];
  if(!last || last.role!=='assistant')return;
  A.click();
  await ST.truncateTo(last.id);
  await replyStream(chat, {content:'（重新回应）', role:'user'});
}

/* ── 编辑消息 ── */
function startEditMsg(id){
  const chat = ST.activeChat; if(!chat)return;
  const m = chat.messages.find(x=>x.id===id);
  if(!m)return;
  m.editing = true;
  renderChat();
  const ta = $('.msg__edit-input');
  if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length,ta.value.length); }
}
function cancelEditMsg(){ const chat=ST.activeChat; if(chat){chat.messages.forEach(m=>m.editing=false);} renderChat(); }
async function confirmEditMsg(e){
  const chat = ST.activeChat; if(!chat)return;
  const id = e.target.dataset.editId;
  const ta = e.target.closest('.msg__edit-row').querySelector('.msg__edit-input');
  const text = ta.value.trim();
  if(!text)return;
  await ST.editMessage(id, text);
  renderAll();
}

/* ── 聊天 header ── */
function renderChatHeader(){
  const chat = ST.activeChat;
  const badges = $('#chat-char-badges');
  if(!chat){
    badges.innerHTML='';
    return;
  }
  const v = chat.variables||{};
  const mk = (k,val,cls,ic)=>{ if(val==null)return ''; return `<span class="chat-badge ${cls}" title="${esc(k)}">${icon(ic)}${k} ${val}</span>`; };
  badges.innerHTML =
    mk('战意',v['战意'],'','i-flame') +
    mk('顺从度',v['顺从度'],'','i-chain') +
    mk('欲望',v['欲望'],'chat-badge--desire','i-rose') +
    mk('好感度',v['好感度'],'','i-heart') +
    (S.pearls!=null?`<span class="chat-badge" title="墨珠">${icon('i-orb')}墨珠 ${S.pearls}</span>`:'');
}

/* ── 快捷回复 ── */
function renderQuickReplies(){
  const chat = ST.activeChat;
  const zone = $('#quick-replies');
  if(!chat){ zone.innerHTML=''; return; }
  zone.innerHTML = quickRepliesFor(chat).map((q,i)=>`
    <button class="qr-chip ${q.event?'is-event':''}" data-q="${i}" style="animation-delay:${i*40}ms">${esc(q.text)}</button>`).join('');
  zone.querySelectorAll('[data-q]').forEach(b=>b.addEventListener('click',()=>{
    const q = quickRepliesFor(ST.activeChat)[+b.dataset.q];
    if(!q)return;
    if(q.action==='verdict'){ eventAction('verdict',''); }
    else sendMessage(q.text);
  }));
}

/* ═══════════════════════════════════════════════════════════════
   酒馆 · 事件卡（游戏机制以聊天卡片驱动）
   ═══════════════════════════════════════════════════════════════ */
async function chatEvent(ev){
  let chat = ST.activeChat;
  if(!chat){
    // 无会话时创建驻场者会话
    const c = charById(S.stationed);
    chat = await ST.createChat({
      name:`${c.name} · 新会话`, characterId:c.id, characterName:c.name,
      variables:{...charMood(c.id)},
    });
  }
  const m = createMessage('system', '', { kind:'event', event:ev, variables:{...chat.variables} });
  chat.messages.push(m);
  chat.updatedAt = Date.now();
  await ST.persistChat(chat);
  renderAll();
  A.chime();
}

function eventAction(type,arg){
  A.click();
  switch(type){
    case 'summon-meet': {           // 与新角色会面
      const c = charById(arg);
      if(c) openCharChat(arg,{name:'初逢'});
      break;
    }
    case 'summon-go': go('summon'); break;
    case 'encounter': go('arena'); break;      // 踏入沙盘
    case 'verdict': openVerdict(Battle.pendingVictim); break;
    case 'disposal-go': go('disposal'); break;
    case 'battle-again': Battle.state='idle'; go('arena'); break;
    case 'chat-go': go('lobby'); break;
  }
}

/* 事件卡构造器 */
function evSummoned(c){
  chatEvent({
    type:'summon-meet', tone:'gold', icon:'i-summon',
    title:`新卡入册 · ${c.name}`,
    body:`回响之契牵来一缕新魂——${c.name}，自${c.plane}而来。契约已成，她在酒馆为你留了一席。`,
    actions:[
      {label:'与她初次会面', icon:'i-chat', arg:c.id},
      {label:'继续垂钓', icon:'i-summon', arg:'', cls:'event-card__btn--ghost'},
    ],
  });
}
function evEncounter(foes){
  chatEvent({
    type:'encounter', tone:'scarlet', icon:'i-arena',
    title:'沙盘遭遇 · 未知之敌',
    body:`对战台的月相沙盘泛起涟漪——${foes.map(f=>'？？？').join('、')}的气息在彼端若隐若现。\n灵质扫描显示：敌方 ${foes.length} 名召唤物待战。`,
    actions:[{label:'踏入沙盘', icon:'i-gavel', arg:'', cls:'event-card__btn--rouge'}],
  });
}
function evVictory(c){
  chatEvent({
    type:'verdict', tone:'scarlet', icon:'i-gavel',
    title:`战利品待裁决 · ${c.name}`,
    body:`沙盘尘埃落定。${c.name}伏于灵光之中，战意尽溃——\n胜者执笔，败者听命。裁决之匣已为你敞开。`,
    actions:[{label:'开启裁决之匣', icon:'i-gavel', arg:'', cls:'event-card__btn--rouge'}],
  });
}
function evDisposal(c,d){
  chatEvent({
    type:'disposal-go', tone:'gold', icon:'i-disposal',
    title:`裁决落定 · ${c.name} · ${d.name}`,
    body:`处置已毕。${c.name}自此去向已定：${d.name}。\n处置室的卷轴上，多了一行墨迹未干的名字。`,
    actions:[{label:'前往处置室', icon:'i-disposal', arg:'', cls:'event-card__btn--ghost'}],
  });
}

/* ═══════════════════════════════════════════════════════════════
   模拟回响 · 聊天回复引擎（内置叙事）
   ═══════════════════════════════════════════════════════════════ */
const REPLY_POOL = {
  greet:['她抬眼看了看你，眉梢微微一动："来了？坐。"','她没抬头，声音却先一步抵达："嗯，我听见你推门了。"','"这一句，比上一句有诚意。"她点评道，唇角有极淡的弧度。'],
  tease:['她笑了一声，笑意却不及眼底："巧言令色——不过，我不讨厌。"','她偏过头，目光在你身上停了一瞬："继续。我倒要看看，你这张嘴能甜到几时。"'],
  war:['她的眸子亮了一瞬，又压下去："想打？"她慢条斯理地活动着手腕，"沙盘还是别处——你挑。"','"战意不错。"她难得地夸了一句，"不过，先陪我把这杯喝完。打架，也得有个好开局。"'],
  mood:['她沉默了片刻，声音低了几分："……今天，风有点凉。可能是想你了。别多想，是风。"','她捻着衣角，欲言又止："你这个人……有时候，比沙盘上的敌人还难应付。"'],
  cold:['"嗯。"她只应了一个字，却也没走开，就那么安静地坐着。','她没接话，只是把面前的灯芯拨亮了些。'],
  consent:['她垂下眼帘，片刻后，声音很轻："……随你。反正，我也拦不住你。"','她没立刻回答，最后把脸埋进臂弯里，闷闷地应了一声："嗯。"'],
  mystery:['她望着窗外，好一会儿才说："这个问题，等望月之夜，我再回答你。"','"有些答案，"她顿了顿，"得用一件事换。你确定要问？"'],
};
function mockChatReply(chat, text){
  const c = chat?charById(chat.characterId):null;
  const card = c?CHAR_CARDS[c.id]:null;
  // 1. 角色专属关键词
  if(card && card.keywordReplies){
    for(const [kw,replies] of Object.entries(card.keywordReplies)){
      if(text.includes(kw)) return pick(replies);
    }
  }
  // 2. 通用关键词
  if(/战|打|沙盘|较量/.test(text)) return pick(REPLY_POOL.war);
  if(/月/.test(text)) return c&&c.id==='zhu'
    ? '她望向窗外："月相又要轮替了。望月之夜……我不闭眼。"'
    : pick(REPLY_POOL.mood);
  if(/想|念|抱|吻/.test(text)) return pick(REPLY_POOL.tease);
  if(/契约|缔约|誓/.test(text)) return pick(REPLY_POOL.consent);
  if(/真|秘密|你是谁|过去/.test(text)) return pick(REPLY_POOL.mystery);
  // 3. 依据好感度选情绪基调
  const mood = chat.variables||{};
  const aff = mood['好感度']||40;
  if(aff<25 && Math.random()<.5) return pick(REPLY_POOL.cold);
  if(aff>70 && Math.random()<.5) return pick(REPLY_POOL.mood);
  // 4. 问候基调
  return pick(REPLY_POOL.greet);
}

/* ═══════════════════════════════════════════════════════════════
   灵枢 LLM 桥（远端流式 / 模拟回响）
   ═══════════════════════════════════════════════════════════════ */
const Llm = {
  async streamRemote(prompt, onChunk, abortCb){
    const {endpoint,key,model}=S.llm;
    const base = endpoint.replace(/\/+$/,'');
    const ctrl = new AbortController();
    if(abortCb){ streamAbort = ctrl; }
    const res = await fetch(base+'/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify({model,messages:prompt,stream:true,temperature:S.llm.temp??0.85}),
      signal:ctrl.signal,
    });
    if(!res.ok) throw new Error('HTTP '+res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let acc='', buf='';
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      buf+=dec.decode(value,{stream:true});
      const lines=buf.split('\n'); buf=lines.pop()||'';
      for(const line of lines){
        const m = line.match(/^data:\s*(.*)$/);
        if(!m||m[1]==='[DONE]')continue;
        try{
          const j=JSON.parse(m[1]);
          const d=j.choices?.[0]?.delta?.content||'';
          if(d){acc+=d; onChunk?.(d);}
        }catch(e){}
      }
    }
    return acc.trim();
  },
};

/* ═══════════════════════════════════════════════════════════════
   游戏状态 ↔ 会话变量 同步
   ═══════════════════════════════════════════════════════════════ */
function syncChatVars(chat){
  const mood = charMood(chat.characterId);
  chat.variables = mergeVariables(chat.variables||{}, {...mood});
  return chat;
}
function syncGameStateFromVars(chat){
  const v = chat.variables||{};
  const mood = charMood(chat.characterId);
  for(const k of ['战意','顺从度','欲望','好感度']){
    if(v[k]!=null) mood[k]=clamp(Number(v[k])||0,0,100);
  }
  if(v['墨珠']!=null && S.pearls!==Number(v['墨珠'])){ S.pearls=clamp(Number(v['墨珠'])||0,0,99); saveState(); $('#ink-pearl-num').textContent=S.pearls; }
  renderChatHeader();
}

/* ═══════════════════════════════════════════════════════════════
   通知系统（定制通知框）
   ═══════════════════════════════════════════════════════════════ */
function notify(type,title,text,when='',opts={}){
  const zone = $('#notification-zone');
  const el = document.createElement('div');
  const icons = {whisper:'i-feather',scarlet:'i-blade',decree:'i-scepter'};
  el.className = `notice notice--${type}`;
  el.setAttribute('role',type==='scarlet'?'alert':'status');
  el.innerHTML = `
    <button class="notice__close" aria-label="关闭通知">${icon('i-close')}</button>
    <div class="notice__row">
      <span class="notice__icon">${icon(icons[type]||'i-feather')}</span>
      <div>
        <div class="notice__title">${esc(title)}</div>
        <div class="notice__text">${esc(text)}</div>
      </div>
      <span class="notice__time">${esc(when||nowLabel())}</span>
    </div>`;
  zone.appendChild(el);
  requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('in')));
  A.chime();
  const nav = opts.view;
  el.addEventListener('click',e=>{
    if(e.target.closest('.notice__close')){ dismiss(); return; }
    if(nav) go(nav);
    dismiss();
  });
  const dismiss=()=>{ el.classList.remove('in'); setTimeout(()=>el.remove(),600); };
  setTimeout(dismiss,opts.ttl||5600);
  while(zone.children.length>4)zone.firstChild.remove();
  return el;
}

/* ───────────── 模态框管理 ───────────── */
const modalStack=[];
function openModal(id){
  const m = document.getElementById(id);
  if(!m)return;
  m.hidden=false;
  document.getElementById('modal-layer').classList.add('has-modal');
  void m.offsetWidth; m.classList.add('open');
  modalStack.push(m);
  const f = m.querySelector('[data-close],button');
  if(f)f.focus({preventScroll:true});
  A.click();
}
function closeModal(m){
  if(!m)return;
  const i = modalStack.indexOf(m);
  if(i>=0)modalStack.splice(i,1);
  m.classList.remove('open');
  setTimeout(()=>{ m.hidden=true; },500);
  if(!modalStack.length)document.getElementById('modal-layer').classList.remove('has-modal');
}
const closeTop = ()=>{ const m=modalStack[modalStack.length-1]; if(m)closeModal(m); };
$$('#modal-layer [data-close]').forEach(b=>b.addEventListener('click',e=>{
  const m = b.closest('.modal'); if(m)closeModal(m);
}));
$('#modal-backdrop').addEventListener('click',closeTop);

function openConfirm({title,text,yes,fn}){
  $('#confirm-title').textContent=title;
  $('#confirm-text').textContent=text;
  openModal('modal-confirm');
  const y=$('#btn-confirm-yes');
  y.onclick=()=>{
    closeModal($('#modal-confirm'));
    fn();
  };
}

/* ═══════════════════════════════════════════════════════════════
   召唤台
   ═══════════════════════════════════════════════════════════════ */
const Summon={ source:SOURCES[0], result:null, casting:false };
const RUNES=['M0 -7 v14 M-5 -3 l5 3 5 -3','M-6 -6 l6 12 6 -12','M0 -7 v14 M-7 -2 h14','M-6 -2 v-6 h12 v12 h-12 v-6','M-7 -7 l14 14 M7 -7 l-14 14','M-7 -7 v14 h14 v-14 z','M-6 0 h12 M0 -7 v14','M-5 -7 c5 4 5 10 0 14 M5 -7 c-5 4 -5 10 0 14','M-7 -7 l7 7 7 -7 M0 0 v7','M-7 7 l7 -7 7 7 M0 -7 v7','M-6 -7 v14 M-6 -7 h14 v14 h-14','M-7 -7 h14 v14 h-14 z M-3 -3 h6 v6 h-6 z'];

function buildSummonArray(){
  const g=$('#summon-array-static');
  const C=280;
  let s='';
  const rings=[{r:272,cls:'ring'},{r:250,cls:'ring ring--fine'},{r:226,cls:'band'},{r:198,cls:'ring'},{r:150,cls:'ring ring--fine'},{r:108,cls:'ring'}];
  for(const ring of rings) s+=`<circle class="${ring.cls}" cx="${C}" cy="${C}" r="${ring.r}"/>`;
  for(let i=0;i<12;i++){
    const a=i/12*Math.PI*2-Math.PI/2;
    const x=C+Math.cos(a)*236, y=C+Math.sin(a)*236;
    s+=`<path class="rune-mark" transform="translate(${x} ${y}) rotate(${i*30})" d="${RUNES[i%RUNES.length]}"/>`;
  }
  for(let i=0;i<8;i++){
    const a=i/8*Math.PI*2-Math.PI/2;
    const x=C+Math.cos(a)*174, y=C+Math.sin(a)*174;
    const b=(i%3+1), h=26, w=30, gap=5;
    let trig='';
    for(let j=0;j<3;j++){
      const fill = (b>>(2-j))&1;
      if(fill) trig+=`<rect x="${-w/2}" y="${-h/2+j*(h/3+gap)+1.5}" width="${w}" height="${h/3-3}" rx="1.5"/>`;
    }
    s+=`<g class="trigram" transform="translate(${x} ${y}) rotate(${i*45})">${trig}</g>`;
  }
  s+=`<path class="ring" d="M280 178 L382 280 L280 382 L178 280 Z" opacity=".5"/>`;
  s+=`<path class="ring" d="M280 210 L350 280 L280 350 L210 280 Z" opacity=".35"/>`;
  s+=`<circle class="rune-mark" cx="280" cy="280" r="34"/>`;
  s+=`<path class="rune-mark" d="M280 252 v56 M254 280 h52"/>`;
  g.innerHTML=s;
}

function buildSourceTabs(){
  const tabs=$('#source-tabs');
  tabs.innerHTML=SOURCES.map((s,i)=>`
    <button class="source-tab ${i===0?'is-active':''}" data-source="${s.id}" role="tab" aria-selected="${i===0}">
      ${icon(s.icon)}<span>${s.name}</span>
    </button>`).join('');
  $('#source-stage-icon').innerHTML=icon(SOURCES[0].icon);
  $('#source-stage-name').textContent=SOURCES[0].name+'位面';
  $('#source-stage-desc').textContent=SOURCES[0].desc;
  renderRiteChips(SOURCES[0]);
}
$('#source-tabs').addEventListener('click',e=>{
  const b=e.target.closest('.source-tab');
  if(!b)return;
  A.click();
  $$('.source-tab').forEach(x=>{x.classList.remove('is-active');x.setAttribute('aria-selected','false');});
  b.classList.add('is-active'); b.setAttribute('aria-selected','true');
  Summon.source=SOURCES.find(s=>s.id===b.dataset.source);
  const st=$('#source-stage');
  st.classList.remove('wipe'); void st.offsetWidth; st.classList.add('wipe');
  $('#source-stage-icon').innerHTML=icon(Summon.source.icon);
  $('#source-stage-name').textContent=Summon.source.name+'位面';
  $('#source-stage-desc').textContent=Summon.source.desc;
  renderRiteChips(Summon.source);
});
function renderRiteChips(src){
  const chips=$('#rite-chips');
  chips.innerHTML=src.chips.slice(0,4).map(c=>`<button class="rite-chip" data-imagery="${esc(c)}">${esc(c)}</button>`).join('');
  chips.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    A.click(); $('#rite-imagery').value=b.dataset.imagery;
  }));
}

function weightedChar(){
  const pool = CHARS.filter(c=>!S.owned.includes(c.id));
  if(!pool.length)return null;
  const same = pool.filter(c=>c.source===Summon.source.id);
  const base = same.length?same:pool;
  const arcane = S.talents.arcane>0;
  const w = base.map(c=>({c,w:({n:1,r:2,sr:4,ssr:7}[c.rarity]||2)*(arcane?1.35:1)}));
  const total=w.reduce((a,b)=>a+b.w,0);
  let r=Math.random()*total;
  for(const e of w){ r-=e.w; if(r<=0)return e.c; }
  return base[base.length-1];
}

async function castSummon(){
  if(Summon.casting)return;
  if(S.pearls<1){
    notify('scarlet','绯红宣告','墨珠不足 —— 回响无法启动。可通过处置室之交易与献祭换取墨珠。','',{view:'disposal'});
    return;
  }
  Summon.casting=true;
  closeModal($('#modal-summon'));
  A.boom();
  const arr=$('#summon-array');
  arr.style.animation='none'; void arr.offsetWidth;
  arr.style.animation='arraySurge 1.6s var(--ease-out)';
  const r=arr.getBoundingClientRect();
  FX.spark(r.left+r.width/2,r.top+r.height/2,{n:26,spread:180,size:3.4});
  await new Promise(res=>setTimeout(res,1500));
  arr.style.animation='';
  S.pearls-=1; saveState(); $('#ink-pearl-num').textContent=S.pearls;
  const c = weightedChar();
  if(!c){
    notify('whisper','灵质低语','诸界之线已尽数缔约。此台再无未缚之魂——或该唤名待归者。');
    Summon.casting=false; return;
  }
  S.seen.push(c.id);
  showReveal(c);
}

function showReveal(c){
  const scene=document.createElement('div');
  scene.className='reveal-scene';
  scene.innerHTML=`
    <div class="flip3d"><div class="flip3d__inner">
      <div class="flip3d__face flip3d__face--front">${icon('i-summon')}</div>
      <div class="flip3d__face flip3d__face--back">
        <div class="reveal-card">
          <div class="reveal-card__rarity" style="background:${RARITY[c.rarity].color};box-shadow:0 0 16px ${RARITY[c.rarity].color}"></div>
          <div class="reveal-card__port"></div>
          <div class="reveal-card__body">
            <div class="reveal-card__name">${esc(c.name)}</div>
            <div class="reveal-card__plane">${esc(c.plane)}</div>
            <div class="reveal-card__tags">${icon(ELEMENTS[c.element].icon)}<span>${ELEMENTS[c.element].name}</span><span class="tag">${RARITY[c.rarity].name}</span></div>
          </div>
        </div>
      </div>
    </div></div>`;
  $('#view-summon').appendChild(scene);
  mountPortrait(scene.querySelector('.reveal-card__port'),c.id,{crop:'bust'});
  setTimeout(()=>{
    const inner=scene.querySelector('.flip3d__inner');
    inner.classList.add('is-flipped');
    A.chime();
  },600);
  setTimeout(()=>{ scene.remove(); Summon.result=c; openPact(c); },2600);
}

function openPact(c){
  $('#pact-card-name').textContent=c.name;
  $('#pact-card-plane').textContent=c.plane+' · '+ELEMENTS[c.element].name+'属性';
  $('#pact-card-tags').innerHTML=`<span class="tag">${RARITY[c.rarity].name}</span><span class="tag">${esc(c.talent.name)}</span>`;
  mountPortrait($('#pact-card-port'),c.id,{crop:'bust'});
  $('#pact-binding').innerHTML='';
  openModal('modal-pact');
}
async function confirmPact(pact){
  const c=Summon.result;
  if(!c)return;
  A.chime();
  const bind=$('#pact-binding');
  bind.innerHTML=`<div class="pact-binding__text" id="pact-binding-text"></div>`;
  const txt=$('#pact-binding-text');
  const card=CHAR_CARDS[c.id]||{};
  const lines = pact==='equal' ? LORE_POOL.pactEqual : LORE_POOL.pactMaster;
  txt.textContent = fillName(pick(lines),c);
  S.owned.push(c.id);
  S.stationed=c.id;
  saveState();
  $('#contract-count-num').textContent=S.owned.length;
  notify('decree','鎏金敕令',`契约落成 —— ${c.name} 已入麾下，自此为${pact==='equal'?'并肩之人':'主仆之属'}。`,nowLabel(),{ttl:6000});
  Summon.casting=false;
  setTimeout(async()=>{
    closeModal($('#modal-pact'));
    go('lobby');
    await openCharChat(c.id,{name:pact==='equal'?'并肩初逢':'主仆初逢'});
    evSummoned(c);            // 酒馆事件卡（入新角色会话）
  },1800);
}
$('#pact-equal').addEventListener('click',()=>confirmPact('equal'));
$('#pact-master').addEventListener('click',()=>confirmPact('master'));

/* ═══════════════════════════════════════════════════════════════
   对战台 · 沙盘模拟引擎
   ═══════════════════════════════════════════════════════════════ */
const Battle={
  state:'idle', round:1, phase:0, ally:[], foe:[],
  aIdx:0,fIdx:0,aGauge:0,fGauge:0,aSwapped:false,
  declaration:null, over:false, busy:false,
  pendingVictim:null,
};
const PHASES=[
  {name:'朔月',icon:'i-moon-new',boost:'圣 · 灵 之属威势微涨'},
  {name:'蛾眉',icon:'i-moon-cre',boost:'风 · 幻 之气灵动'},
  {name:'上弦',icon:'i-moon-half',boost:'火 · 雷 之属灵力渐盛'},
  {name:'盈凸',icon:'i-moon-cre',boost:'魅 · 暗 之息渐浓'},
  {name:'望月',icon:'i-moon-full',boost:'魅 · 暗 之属威势大涨'},
];
function charStats(c,scale=1){
  const m=RARITY[c.rarity].mult;
  return {
    hp:Math.round(m.hp*scale), hpMax:Math.round(m.hp*scale),
    mp:Math.round(m.mp*scale), mpMax:Math.round(m.mp*scale),
    atk:Math.round(m.atk*scale), def:Math.round(m.def*scale),
    spd:m.spd, statuses:[], guard:false, reveal:0,
  };
}
function isCaged(id){ return S.disposals.some(d=>d.charId===id&&d.method==='cage'); }
function startBattle(){
  const owned=S.owned.filter(id=>!isCaged(id));
  const mine = owned.length? owned : S.owned;
  const foePool = CHARS.filter(c=>!S.owned.includes(c.id));
  const foes = [];
  while(foes.length<Math.min(2,foePool.length)){
    const c=pick(foePool);
    if(!foes.includes(c.id))foes.push(c.id);
  }
  Object.assign(Battle,{
    state:'lineup', round:1, phase:0, aGauge:0,fGauge:0,aSwapped:false,
    declaration:null, over:false, busy:false,
    ally:mine.slice(0,3).map(id=>{const c=charById(id);return {char:c,st:charStats(c)};}),
    foe:foes.map(id=>{const c=charById(id);return {char:c,st:charStats(c,0.72)};}),
    aIdx:0,fIdx:0,
  });
  buildLineup();
}
function buildLineup(){
  const allySlots=$('#lineup-ally-slots'), foeSlots=$('#lineup-foe-slots');
  allySlots.innerHTML=Battle.ally.map((e,i)=>`
    <button class="lineup-card ${i===0?'is-picked':''}" data-slot="${i}" data-side="ally" aria-pressed="${i===0}">
      <div class="lineup-card__port"></div>
      <div class="lineup-card__name">${esc(e.char.name)}</div>
    </button>`).join('');
  Battle.ally.forEach((e,i)=>mountPortrait(allySlots.querySelectorAll('.lineup-card__port')[i],e.char.id,{crop:'bust'}));
  foeSlots.innerHTML=Battle.foe.map(()=>`
    <div class="lineup-card lineup-card--foe">
      <div class="lineup-card__port"></div>
      <div class="lineup-card__name">？？？</div>
    </div>`).join('');
  Battle.foe.forEach((e,i)=>mountPortrait(foeSlots.querySelectorAll('.lineup-card__port')[i],e.char.id,{crop:'bust'}));
  allySlots.querySelectorAll('.lineup-card').forEach(card=>{
    card.addEventListener('click',()=>{
      A.click();
      const picked=allySlots.querySelectorAll('.is-picked');
      if(picked.length>=2 && !card.classList.contains('is-picked'))return;
      card.classList.toggle('is-picked');
      card.setAttribute('aria-pressed',card.classList.contains('is-picked'));
    });
  });
  openModal('modal-lineup');
}
$('#btn-lineup-confirm').addEventListener('click',()=>{
  const idx=[...$('#lineup-ally-slots').querySelectorAll('.is-picked')].map(b=>+b.dataset.slot);
  if(!idx.length){ notify('scarlet','绯红宣告','至少指派一名召唤物出战 —— 沙盘不接待空阵。'); return; }
  A.boom();
  closeModal($('#modal-lineup'));
  Battle.state='fighting';
  Battle.ally=Battle.ally.filter((e,i)=>idx.includes(i));
  Battle.aIdx=0;
  enterArena();
});

function enterArena(){
  renderArena();
  const foe = Battle.foe[Battle.fIdx];
  chatSys(`沙盘开启 —— 月相轮替开始。敌方召唤物气息：${foe.char.name} 的伪装仍在迷雾之后。`);
}
function chatSys(text){
  const chat = ST.activeChat;
  if(!chat)return;
  const m = createMessage('system', text, { kind:'sys', event:{icon:'i-feather'}, variables:{...chat.variables} });
  chat.messages.push(m);
  chat.updatedAt=Date.now();
  ST.persistChat(chat).then(renderAll);
}

function renderArena(){
  const a=Battle.ally[Battle.aIdx], f=Battle.foe[Battle.fIdx];
  mountPortrait($('#ally-card-port'),a.char.id,{crop:'bust'});
  $('#ally-card-name').textContent=a.char.name;
  $('#ally-card-hp').textContent=`${a.st.hp}/${a.st.hpMax}`;
  $('#ally-hp-bar').style.width=(a.st.hp/a.st.hpMax*100)+'%';
  $('#ally-mp-bar').style.width=(a.st.mp/a.st.mpMax*100)+'%';
  $('#ally-skills').innerHTML=a.char.skills.map((s,i)=>`
    <button class="skill-ico ${a.st.mp<s.mp?'is-disabled':''}" data-skill="${i}" title="${esc(s.name)}（${s.mp} 灵力）">${icon(s.icon)}</button>`).join('');
  $('#ally-skills').querySelectorAll('.skill-ico').forEach(b=>b.addEventListener('click',()=>playerSkill(+b.dataset.skill)));
  $('#ally-status').innerHTML=a.st.statuses.map(s=>statusChip(s)).join('');
  $('#ally-bench').innerHTML=Battle.ally.map((e,i)=>`
    <button class="bench-card ${i===Battle.aIdx?'is-active':''}" data-bench="${i}" title="切换至 ${esc(e.char.name)}">
      <div class="bench-card__port"></div>
      <div class="bench-card__name">${esc(e.char.name)}</div>
    </button>`).join('');
  Battle.ally.forEach((e,i)=>{
    const p=$('#ally-bench').querySelectorAll('.bench-card__port')[i];
    if(p)mountPortrait(p,e.char.id,{crop:'bust'});
  });
  $('#ally-bench').querySelectorAll('.bench-card').forEach(b=>b.addEventListener('click',()=>playerSwap(+b.dataset.bench)));

  const rev = f.reveal||0;
  mountPortrait($('#foe-card-port'),f.char.id,{crop:'bust'});
  $('#foe-card-name').textContent = rev>=60? f.char.name : '？？？';
  $('#foe-card-hp').textContent = rev>=30? `${f.st.hp}/${f.st.hpMax}` : '？？？';
  $('#foe-hp-bar').style.width=(f.st.hp/f.st.hpMax*100)+'%';
  $('#foe-mp-bar').style.width=(f.st.mp/f.st.mpMax*100)+'%';
  $('#foe-hp-bar').classList.toggle('stat-bar__fill--fog',rev<30);
  $('#foe-mp-bar').classList.toggle('stat-bar__fill--fog',rev<30);
  $('#foe-skills').innerHTML = rev>=50
    ? f.char.skills.map(s=>`<span class="skill-ico is-disabled" title="${esc(s.name)}">${icon(s.icon)}</span>`).join('')
    : '<span class="skill-ico is-disabled" style="color:var(--sepia)">?</span>'.repeat(3);
  $('#foe-status').innerHTML=f.st.statuses.map(s=>statusChip(s)).join('');
  $('#foe-bench').innerHTML=Battle.foe.map((e,i)=>`
    <div class="bench-card bench-card--foe ${i===Battle.fIdx?'is-active':''}">
      <div class="bench-card__port"></div>
      <div class="bench-card__name">？？？</div>
    </div>`).join('');
  Battle.foe.forEach((e,i)=>{
    const p=$('#foe-bench').querySelectorAll('.bench-card__port')[i];
    if(p)mountPortrait(p,e.char.id,{crop:'bust'});
  });
  const fog=$('#foe-fog');
  fog.classList.toggle('partial',rev>0&&rev<55);
  fog.classList.toggle('gone',rev>=55);

  $$('#moongauge-phases .moongauge__moon').forEach((m,i)=>{
    m.classList.toggle('is-active',i===Battle.phase);
    m.classList.toggle('is-past',i<Battle.phase);
  });
  $('#moongauge-label').textContent=PHASES[Battle.phase].name;
  $('#moongauge-count').textContent='第'+cnNum(Battle.round)+'回合';
  $('#arena-ally-title').textContent=PHASES[Battle.phase].boost;
  $('#btn-act-ult').classList.toggle('is-locked',Battle.aGauge<100);
  $('#btn-act-swap').classList.toggle('is-locked',Battle.aSwapped||Battle.ally.length<2);
}
function statusChip(s){
  const map={burn:['灼烧','i-flame','burn'],chill:['霜寒','i-snow','chill'],charm:['魅惑','i-mask','charm'],venom:['中毒','i-drop','burn'],break:['溃散','i-bolt','break']};
  const [n,i,cls]=map[s.k]||[s.k,'i-eye','break'];
  return `<span class="status-chip status-chip--${cls}">${icon(i)}${n}${s.dur?'·'+s.dur:''}</span>`;
}
function calcDamage(atk,atkEl,def,defEl,dmg,status){
  let d=atk*dmg;
  const el = ELEMENTS[atkEl]?.vs?.[defEl]||1;
  d*=el; d*=rnd(.88,1.12);
  d*=1-def/(def+110);
  const crit=Math.random()<.1;
  if(crit)d*=1.6;
  if(status==='burn')d*=1.15;
  return {d:Math.max(1,Math.round(d)),el,crit};
}
function applyStatus(target,key,dur){
  const has=target.statuses.find(s=>s.k===key);
  if(has)has.dur=Math.max(has.dur,dur||2);
  else target.statuses.push({k:key,dur:dur||2});
}
function tickStatuses(e){
  for(const s of [...e.statuses]){
    if(s.k==='burn'){ const d=Math.max(1,Math.round(e.hpMax*.06)); e.hp=Math.max(0,e.hp-d); }
    if(s.k==='venom'){ e.mp=Math.max(0,e.mp-10); }
    s.dur--;
    if(s.dur<=0)e.statuses.splice(e.statuses.indexOf(s),1);
  }
}
function addReveal(n){
  const f=Battle.foe[Battle.fIdx];
  const before=f.reveal||0;
  f.reveal=clamp((f.reveal||0)+n,0,100);
  if(Math.floor(f.reveal/20)!==Math.floor(before/20)||f.reveal===100){
    const part = f.reveal>=100?'一切虚实':f.reveal>=60?'真名':f.reveal>=50?'技法':f.reveal>=30?'灵质':'气息';
    chatSys(`迷雾松动 —— 敌方${part}显现：${f.char.name}，${ELEMENTS[f.char.element].name}属性。`);
  }
  renderArena();
}
function flash(el,color){
  el.animate([{boxShadow:`0 0 0 0 ${color}66`},{boxShadow:`0 0 0 14px ${color}00`}],{duration:650,easing:'ease-out'});
}

async function playerSkill(i){
  if(Battle.state!=='fighting'||Battle.busy)return;
  const a=Battle.ally[Battle.aIdx], f=Battle.foe[Battle.fIdx];
  const sk=a.char.skills[i];
  if(!sk)return;
  if(a.st.mp<sk.mp){ notify('whisper','灵质低语',`${a.char.name}的灵力不足以施展「${sk.name}」。`); return; }
  A.click();
  a.st.mp-=sk.mp;
  Battle.busy=true;
  if(sk.effect==='probe'){ addReveal(26); }
  if(sk.dmg>0){
    const r=calcDamage(a.st.atk,a.char.element,f.st.def,f.char.element,sk.dmg,sk.effect);
    f.st.hp=Math.max(0,f.st.hp-r.d);
    flash($('#foe-card-slot'),r.crit?'#f7ecc9':'#e0605f');
    Battle.aGauge=clamp(Battle.aGauge+22,0,100);
    if(sk.effect==='burn'&&Math.random()<.4)applyStatus(f.st,'burn',2);
    if(sk.effect==='chill'&&Math.random()<.4)applyStatus(f.st,'chill',2);
    if(sk.effect==='break'&&Math.random()<.45)applyStatus(f.st,'break',2);
    if(sk.effect==='venom'&&Math.random()<.4)applyStatus(f.st,'venom',2);
    if(sk.effect==='charm'&&Math.random()<.35)applyStatus(f.st,'charm',1);
    addReveal(12);
    chatSys(`${a.char.name}以「${sk.name}」命中敌方，造成 ${r.d} 点伤害${r.el!==1?'（属性克制）':''}${r.crit?'，暴击！':''}。`);
  }
  renderArena();
  if(f.st.hp<=0){ Battle.busy=false; await enemyDown(); return; }
  setTimeout(()=>enemyTurn(),650);
}
async function playerGuard(){
  if(Battle.state!=='fighting'||Battle.busy)return;
  const a=Battle.ally[Battle.aIdx];
  Battle.busy=true;
  a.st.guard=true;
  addReveal(24);
  chatSys(`${a.char.name}横臂入防，灵光凝幕。迷雾在试探中剥落一层。`);
  renderArena();
  setTimeout(()=>enemyTurn(),600);
}
async function playerUlt(){
  if(Battle.state!=='fighting'||Battle.busy)return;
  if(Battle.aGauge<100){ notify('whisper','灵质低语','必杀咏唱未成 —— 灵烛尚未燃满。'); return; }
  const a=Battle.ally[Battle.aIdx], f=Battle.foe[Battle.fIdx];
  Battle.busy=true;
  Battle.aGauge=0;
  FX.burstAt($('#btn-act-ult'),{n:24,size:3,up:true,spread:120});
  const r=calcDamage(a.st.atk,a.char.element,f.st.def,f.char.element,a.char.ult.dmg,a.char.ult.effect);
  f.st.hp=Math.max(0,f.st.hp-r.d);
  flash($('#foe-card-slot'),'#f0d489');
  if(a.char.ult.effect==='burn')applyStatus(f.st,'burn',2);
  if(a.char.ult.effect==='chill')applyStatus(f.st,'chill',2);
  if(a.char.ult.effect==='charm')applyStatus(f.st,'charm',2);
  if(a.char.ult.effect==='venom')applyStatus(f.st,'venom',2);
  if(a.char.ult.effect==='break')applyStatus(f.st,'break',2);
  if(a.char.ult.effect==='heal')a.st.hp=Math.min(a.st.hpMax,a.st.hp+Math.round(a.st.hpMax*.25));
  addReveal(20);
  chatSys(`${a.char.name}的「${a.char.ult.name}」倾泻而出，敌方遭受 ${r.d} 点重创${r.crit?'，暴击！':''}！`);
  renderArena();
  if(f.st.hp<=0){ Battle.busy=false; await enemyDown(); return; }
  setTimeout(()=>enemyTurn(),700);
}
function playerSwap(bi){
  if(Battle.state!=='fighting'||Battle.busy||Battle.aSwapped)return;
  if(bi===Battle.aIdx||bi>=Battle.ally.length)return;
  A.click();
  Battle.aSwapped=true;
  Battle.aIdx=bi;
  chatSys(`${Battle.ally[bi].char.name}应召上场。`);
  renderArena();
}
function playerDeclare(){
  const body=$('#declare-body');
  body.innerHTML=DISPOSALS.map(d=>`
    <button class="verdict-tab ${Battle.declaration===d.id?'is-active':''}" data-declare="${d.id}">${icon(d.icon)}<span>${d.name}</span></button>`).join('');
  body.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    A.click();
    Battle.declaration=b.dataset.declare;
    body.querySelectorAll('button').forEach(x=>x.classList.toggle('is-active',x===b));
  }));
  openModal('modal-declare');
}
$('#btn-declare-confirm').addEventListener('click',()=>{
  const d=DISPOSALS.find(x=>x.id===Battle.declaration);
  closeModal($('#modal-declare'));
  if(d){
    chatSys(`战前之誓已立：胜后当以「${d.name}」发落败者。`);
    notify('whisper','灵质低语',`处置声明已烙印于沙盘契约 —— 胜后将以「${d.name}」落笔。`);
  }
});

async function enemyTurn(){
  if(Battle.state!=='fighting')return;
  const a=Battle.ally[Battle.aIdx], f=Battle.foe[Battle.fIdx];
  Battle.busy=true;
  await new Promise(r=>setTimeout(r,450));
  if(f.st.statuses.some(s=>s.k==='charm')){
    chatSys('敌方为媚术所惑，怔立当场。');
  }else if(f.st.guard){
    chatSys('敌方举守，纹丝不动。');
  }else{
    const roll=Math.random();
    if(roll<.55){
      const sk=pick(f.char.skills.filter(s=>s.mp<=f.st.mp))||f.char.skills[0];
      f.st.mp-=sk.mp;
      const r=calcDamage(f.st.atk,f.char.element,a.st.def,a.char.element,sk.dmg,sk.effect);
      let dealt=r.d;
      if(a.st.guard){ dealt=Math.max(1,Math.round(dealt*.5)); a.st.guard=false; }
      a.st.hp=Math.max(0,a.st.hp-dealt);
      Battle.fGauge=clamp(Battle.fGauge+20,0,100);
      if(sk.effect==='burn'&&Math.random()<.4)applyStatus(a.st,'burn',2);
      if(sk.effect==='chill'&&Math.random()<.4)applyStatus(a.st,'chill',2);
      if(sk.effect==='charm'&&Math.random()<.35)applyStatus(a.st,'charm',1);
      if(sk.effect==='venom'&&Math.random()<.4)applyStatus(a.st,'venom',2);
      if(sk.effect==='break'&&Math.random()<.45)applyStatus(a.st,'break',2);
      if(sk.effect==='heal')f.st.hp=Math.min(f.st.hpMax,f.st.hp+Math.round(f.st.hpMax*.2));
      flash($('#ally-card-slot'),'#c23a3c');
      chatSys(`敌方以「${sk.name}」反击，${a.char.name}受 ${dealt} 点伤害${r.crit?'（暴击）':''}。`);
      if(a.st.hp<=0){ Battle.busy=false; await allyDown(); return; }
    }else if(roll<.8){
      f.st.guard=true;
      chatSys('敌方凝神入防。');
    }else if(f.st.mp>=f.char.ult.mp){
      f.st.mp-=f.char.ult.mp;
      const r=calcDamage(f.st.atk,f.char.element,a.st.def,a.char.element,f.char.ult.dmg,f.char.ult.effect);
      let dealt=r.d;
      if(a.st.guard){ dealt=Math.max(1,Math.round(dealt*.5)); a.st.guard=false; }
      a.st.hp=Math.max(0,a.st.hp-dealt);
      flash($('#ally-card-slot'),'#e0605f');
      chatSys(`敌方咏唱禁咒「${f.char.ult.name}」！${a.char.name}受 ${dealt} 点重创！`);
      if(a.st.hp<=0){ Battle.busy=false; await allyDown(); return; }
    }else{
      chatSys('敌方按兵不动，蓄力而待。');
    }
  }
  roundEnd();
}
async function roundEnd(){
  const a=Battle.ally[Battle.aIdx], f=Battle.foe[Battle.fIdx];
  tickStatuses(a.st); tickStatuses(f.st);
  a.st.mp=clamp(a.st.mp+16,0,a.st.mpMax);
  f.st.mp=clamp(f.st.mp+14,0,f.st.mpMax);
  Battle.aSwapped=false;
  Battle.round++;
  Battle.phase=(Battle.phase+1)%PHASES.length;
  Battle.busy=false;
  renderArena();
  if(a.st.hp<=0){ await allyDown(); return; }
  if(f.st.hp<=0){ await enemyDown(); return; }
}
async function enemyDown(){
  Battle.busy=false;
  const f=Battle.foe[Battle.fIdx];
  chatSys(`敌方召唤物 ${f.char.name} 灵光溃散，单膝跪地。`);
  if(Battle.fIdx<Battle.foe.length-1){
    Battle.fIdx++;
    Battle.fGauge=0;
    await new Promise(r=>setTimeout(r,800));
    renderArena();
    chatSys(`彼方第二位召唤物登场 —— 迷雾之后，气息深沉。`);
    return;
  }
  endBattle(true);
}
async function allyDown(){
  Battle.busy=false;
  const a=Battle.ally[Battle.aIdx];
  chatSys(`${a.char.name} 力竭倒下。`);
  if(Battle.ally.length>1){
    Battle.ally.splice(Battle.aIdx,1);
    Battle.aIdx=0;
    await new Promise(r=>setTimeout(r,800));
    renderArena();
    return;
  }
  endBattle(false);
}
function endBattle(win){
  if(Battle.over)return;
  Battle.over=true;
  Battle.state='over';
  S.victories+=win?1:0;
  saveState();
  $('#victory-count-num').textContent=S.victories;
  const banner=document.createElement('div');
  banner.className='battle-banner on';
  banner.innerHTML=`<div class="battle-banner__text ${win?'':'battle-banner__text--defeat'}">${win?'大胜':'溃败'}</div>`;
  $('#arena-stage').appendChild(banner);
  A[win?'chime':'boom']();
  if(win){
    const victim = Battle.foe[Battle.fIdx].char;
    Battle.pendingVictim = victim;
    setTimeout(()=>{
      banner.remove();
      evVictory(victim);
      notify('decree','鎏金敕令',`沙盘大胜 —— ${victim.name} 已被俘获，待你裁决。`,nowLabel(),{view:'lobby',ttl:6500});
    },1300);
  }else{
    setTimeout(()=>{
      banner.remove();
      notify('scarlet','绯红宣告','战败 —— 沙盘业已收场。重整旗鼓，再战一轮？',nowLabel(),{view:'arena'});
    },1400);
  }
}

/* ═══════════════════════════════════════════════════════════════
   裁决之匣
   ═══════════════════════════════════════════════════════════════ */
let verdictTarget=null, verdictExecuted=false;
function openVerdict(c){
  verdictTarget=c; verdictExecuted=false;
  $('#verdict-victim-name').textContent=c.name;
  $('#verdict-victim-plane').textContent=c.plane+' · '+ELEMENTS[c.element].name+'属性';
  $('#verdict-victim-state').textContent='战意尽溃 · 听候发落';
  mountPortrait($('#verdict-victim-port'),c.id,{crop:'bust'});
  buildVerdictTabs();
  selectVerdictTab(Battle.declaration||DISPOSALS[0].id,true);
  renderVerdictHistory();
  openModal('modal-verdict');
}
function buildVerdictTabs(){
  $('#verdict-tabs').innerHTML=DISPOSALS.map(d=>`
    <button class="verdict-tab ${Battle.declaration===d.id?'is-recommend':''}" data-verdict="${d.id}" ${Battle.declaration===d.id?'title="循战前声明"':''}>
      ${icon(d.icon)}<span>${d.name}</span>
    </button>`).join('');
  $('#verdict-tabs').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    A.click(); selectVerdictTab(b.dataset.verdict);
  }));
}
function selectVerdictTab(id,initial){
  $$('#verdict-tabs .verdict-tab').forEach(b=>b.classList.toggle('is-active',b.dataset.verdict===id));
  const d=DISPOSALS.find(x=>x.id===id);
  const el=$('#verdict-consequence');
  const mark = Battle.declaration===id && !initial ? '<span style="color:var(--gold-300);letter-spacing:.1em">〔循战前声明〕</span>' : '';
  el.innerHTML=`${mark}${esc(d.desc)}`;
  el.dataset.verdict=id;
}
async function executeVerdict(){
  if(!verdictTarget||verdictExecuted)return;
  const d=DISPOSALS.find(x=>x.id===$('#verdict-consequence').dataset.verdict);
  if(!d)return;
  verdictExecuted=true;
  const c=verdictTarget;
  A.boom();
  const ink=$('#ink-overlay');
  ink.classList.add('on');
  setTimeout(()=>ink.classList.remove('on'),700);
  const scene=document.createElement('div');
  scene.className='ink-scene on';
  scene.innerHTML='<div class="ink-blot bursting"></div>';
  document.body.appendChild(scene);
  setTimeout(()=>scene.remove(),1500);
  $('#verdict-consequence').innerHTML='<span style="color:var(--sepia);letter-spacing:.2em">墨落定音 · 裁决刻印中……</span>';
  await new Promise(r=>setTimeout(r,1150));
  const narr=fillName(pick(d.narr),c);
  const narrEl=document.createElement('div');
  narrEl.className='whisper-msg whisper-msg--them';
  narrEl.style.cssText='max-width:100%;background:rgba(30,22,38,.5);border-color:rgba(123,106,158,.4);color:#cbb9e2;font-size:13px;line-height:2.1;padding:14px 18px;border-radius:3px;border:1px solid;animation:fadeUp .5s var(--ease-out)';
  $('#verdict-consequence').innerHTML='';
  $('#verdict-consequence').appendChild(narrEl);
  narrEl.textContent = narr;
  const rec={id:uid(),charId:c.id,method:d.id,when:'此刻',narrative:narr};
  S.disposals.unshift(rec);
  S.seen.push(c.id);
  if(d.id==='recruit'&&!S.owned.includes(c.id))S.owned.push(c.id);
  if(d.id==='trade')S.pearls+=2;
  if(d.id==='sacrifice')S.pearls+=3;
  if(d.id==='train'){ const ch=charById(c.id); if(ch)setMood(c.id,{顺从度:30,好感度:-5}); }
  if(d.id==='intimate'){ const ch=charById(c.id); if(ch)setMood(c.id,{欲望:18,好感度:15}); }
  if(d.id==='recruit'){ setMood(c.id,{顺从度:25,好感度:20}); }
  saveState();
  $('#ink-pearl-num').textContent=S.pearls;
  $('#contract-count-num').textContent=S.owned.length;
  renderVerdictHistory();
  Battle.pendingVictim=null;
  const btn=$('#btn-verdict-execute');
  btn.innerHTML=`${icon('i-close')}<span>合上匣盖</span>`;
  btn.onclick=()=>{
    closeModal($('#modal-verdict'));
    evDisposal(c,d);
    notify('decree','鎏金敕令',`裁决落定 —— ${c.name} 已被「${d.name}」。`,nowLabel(),{view:'lobby',ttl:6000});
    go('lobby');
  };
  const d2=DISPOSALS.find(x=>x.id===d.id);
  notify('decree','鎏金敕令',`裁决之匣闭合 —— ${c.name} 去向已定：「${d2.name}」。`,nowLabel(),{ttl:5000});
}
function renderVerdictHistory(){
  $('#verdict-history-list').innerHTML=S.disposals.slice(0,8).map(rec=>{
    const c=charById(rec.charId); const d=DISPOSALS.find(x=>x.id===rec.method);
    return `<li class="vh-item" data-replay="${rec.id}">
      <span class="vh-item__name">${c?esc(c.name):'???'}</span>
      <span class="vh-item__method">${d?esc(d.name):'???'}</span>
      <span class="vh-item__time">${esc(rec.when)}</span>
    </li>`;
  }).join('');
  $$('#verdict-history-list .vh-item').forEach(el=>el.addEventListener('click',()=>openReplay(el.dataset.replay)));
}
$('#btn-verdict-execute').addEventListener('click',executeVerdict);
$('#btn-verdict-free').addEventListener('click',()=>{
  if(verdictTarget)notify('whisper','灵质低语',`${verdictTarget.name} 暂押处置室底狱 —— 请择日再审。`);
  closeModal($('#modal-verdict'));
  if(Battle.declaration)notify('whisper','灵质低语','战前声明未履 —— 沙盘契约上多了一道未干的墨痕。');
});

function openReplay(id){
  const rec=S.disposals.find(r=>r.id===id);
  if(!rec)return;
  const c=charById(rec.charId), d=DISPOSALS.find(x=>x.id===rec.method);
  $('#replay-sub').textContent=`${c?c.name:'???'} · ${d?d.name:''} · ${rec.when}`;
  $('#replay-stamp').innerHTML=`<span class="replay-stamp__seal">${d?esc(d.name):''}</span>`;
  const narr=$('#replay-narrative');
  narr.textContent='';
  openModal('modal-replay');
  typeText(narr, rec.narrative||rec.fate||'……', {speed:18});
}
function renderDisposal(){
  const kept=S.disposals.filter(d=>d.method==='recruit').length;
  const caged=S.disposals.filter(d=>d.method==='cage').length;
  $('#dstat-total').textContent=S.disposals.length;
  $('#dstat-kept').textContent=kept;
  $('#dstat-caged').textContent=caged;
  const tl=$('#disposal-timeline');
  tl.innerHTML=S.disposals.map((rec,i)=>{
    const c=charById(rec.charId), d=DISPOSALS.find(x=>x.id===rec.method);
    const cls = rec.method==='cage'?'is-caged':rec.method==='exile'?'is-exiled':'';
    const mcls = rec.method==='sacrifice'?'--sacrifice':rec.method==='exile'?'--exile':rec.method==='cage'?'--cage':'';
    return `<li class="timeline-item ${cls}" style="animation-delay:${i*90}ms">
      <article class="timeline-card">
        <button class="timeline-card__replay" data-replay="${rec.id}" aria-label="回放此次处置" title="回放">${icon('i-return')}</button>
        <div class="timeline-card__top">
          <span class="timeline-card__method timeline-card__method${mcls}">${d?esc(d.name):'???'}</span>
          <span class="timeline-card__name">${c?esc(c.name):'???'}</span>
        </div>
        <div class="timeline-card__meta">
          <span>${esc(rec.when)}</span>
          <span>${c?esc(c.plane):''}</span>
        </div>
        <p class="timeline-card__fate">${esc(rec.fate||rec.narrative||'')}</p>
      </article>
    </li>`;
  }).join('');
  tl.querySelectorAll('[data-replay]').forEach(b=>b.addEventListener('click',()=>openReplay(b.dataset.replay)));
}

/* ═══════════════════════════════════════════════════════════════
   图鉴
   ═══════════════════════════════════════════════════════════════ */
const Codex={plane:null,element:null,stage:null};
function codexChars(){
  return CHARS.filter(c=>{
    if(Codex.plane&&c.source!==Codex.plane)return false;
    if(Codex.element&&c.element!==Codex.element)return false;
    if(Codex.stage!=null&&c.stage!==Codex.stage)return false;
    return true;
  });
}
function buildFilter(panelId,labelId,items,current,onPick){
  const panel=$(panelId);
  panel.innerHTML=items.map(it=>`
    <li data-v="${it.v}" class="${it.v===current?'is-active':''}"><span>${it.label}</span></li>`).join('');
  panel.querySelectorAll('li').forEach(li=>li.addEventListener('click',()=>{
    A.click();
    $(labelId).textContent=items.find(x=>x.v===li.dataset.v).label;
    panel.classList.remove('open');
    $(panelId).closest('.filter-group').querySelector('.filter-trigger').setAttribute('aria-expanded','false');
    onPick(li.dataset.v==='all'?null:li.dataset.v);
    renderCodex();
  }));
}
function renderCodexFilters(){
  buildFilter('#filter-plane-panel','#filter-plane-label',
    [{v:'all',label:'来源位面 · 全部'}].concat(SOURCES.map(s=>({v:s.id,label:s.name}))),
    Codex.plane, v=>Codex.plane=v);
  buildFilter('#filter-element-panel','#filter-element-label',
    [{v:'all',label:'战斗属性 · 全部'}].concat(Object.entries(ELEMENTS).map(([k,e])=>({v:k,label:e.name}))),
    Codex.element, v=>Codex.element=v);
  buildFilter('#filter-stage-panel','#filter-stage-label',
    [{v:'all',label:'调教阶段 · 全部'}].concat(STAGES.map((s,i)=>({v:i,label:s}))),
    Codex.stage, v=>Codex.stage=v);
  $$('.filter-trigger').forEach(t=>t.addEventListener('click',()=>{
    A.click();
    const open=t.getAttribute('aria-expanded')==='true';
    $$('.filter-panel').forEach(p=>p.classList.remove('open'));
    $$('.filter-trigger').forEach(x=>x.setAttribute('aria-expanded','false'));
    if(!open){
      t.setAttribute('aria-expanded','true');
      t.parentElement.querySelector('.filter-panel').classList.add('open');
    }
  }));
}
$('#filter-reset').addEventListener('click',()=>{
  A.click();
  Codex.plane=Codex.element=Codex.stage=null;
  renderCodexFilters();
  renderCodex();
});
function renderCodex(){
  const list=codexChars();
  $('#codex-count').textContent=`共 ${list.length} 位 · 已缔约 ${S.owned.length} 位`;
  const grid=$('#codex-grid');
  grid.innerHTML=list.map((c,i)=>{
    const owned=S.owned.includes(c.id);
    const unknown=!owned&&!S.seen.includes(c.id);
    return `<article class="codex-card ${unknown?'codex-card--unknown':''}" data-id="${c.id}" data-rarity="${c.rarity}" tabindex="0" role="button" aria-label="${esc(c.name)}" style="animation-delay:${Math.min(i*50,500)}ms">
      <div class="codex-card__rarity" aria-hidden="true"></div>
      ${unknown?'<span class="codex-card__unknown-badge">未遇</span>':''}
      <div class="codex-card__port"></div>
      <div class="codex-card__body">
        <div class="codex-card__name">${esc(c.name)}</div>
        <div class="codex-card__plane">${esc(c.plane)}</div>
        <div class="codex-card__stage"><span class="stage-chip stage-chip--${c.stage}">${STAGES[c.stage]}</span></div>
      </div>
    </article>`;
  }).join('');
  grid.querySelectorAll('.codex-card').forEach(card=>{
    const c=charById(card.dataset.id);
    mountPortrait(card.querySelector('.codex-card__port'),c.id,{crop:'bust'});
    card.addEventListener('click',()=>{ A.click(); openSheet(c.id); });
    card.addEventListener('keydown',e=>{ if(e.key==='Enter'){A.click();openSheet(c.id);} });
  });
}
function openSheet(id){
  const c=charById(id);
  const owned=S.owned.includes(id);
  $('#charsheet-plane-sub').textContent=c.plane+' · 位面档案';
  mountPortrait($('#charsheet-port'),c.id);
  $('#cs-name').textContent=c.name;
  const rb=$('#cs-rarity');
  rb.dataset.rarity=c.rarity;
  rb.textContent=RARITY[c.rarity].name;
  $('#cs-plane').textContent=c.plane+' · '+ELEMENTS[c.element].name+'属性'+(owned?'':' · 尚未缔约');
  $('#cs-affection').style.width=(owned?charMood(id).好感度:0)+'%';
  $('#cs-affection-num').textContent=owned?charMood(id).好感度:'—';
  $('#cs-obedience').style.width=(owned?charMood(id).顺从度:0)+'%';
  $('#cs-obedience-num').textContent=owned?charMood(id).顺从度:'—';
  $('#cs-stage').innerHTML=`<span class="stage-chip stage-chip--${c.stage}">调教阶段 · ${STAGES[c.stage]}</span>`;
  $('#cs-lore').textContent=c.lore;
  $('#cs-talent').innerHTML=`
    <div class="cs-talent" data-rarity="${c.rarity}">
      <div class="cs-talent__head">${icon('i-talent')}<span class="cs-talent__name">${esc(c.talent.name)}</span></div>
      <div class="cs-talent__desc">${esc(c.talent.desc)}</div>
    </div>`;
  $('#cs-skills').innerHTML=c.skills.map(s=>`
    <div class="cs-skill">
      ${icon(s.icon)}
      <div class="cs-skill__name">${esc(s.name)}</div>
      <div class="cs-skill__desc">${esc(s.desc)}</div>
    </div>`).join('');
  openModal('modal-charsheet');
}

/* ═══════════════════════════════════════════════════════════════
   天赋星图
   ═══════════════════════════════════════════════════════════════ */
const TALENT_POS=[{x:26,y:24},{x:66,y:52},{x:50,y:84},{x:18,y:74},{x:40,y:42},{x:70,y:26}];
let talentSel=null;
function renderTalents(){
  const wrap=$('#talent-plates');
  wrap.innerHTML=TALENTS.map((t,i)=>{
    const lv=S.talents[t.id]||0;
    const unlocked=lv>0;
    const pos=TALENT_POS[i];
    return `<div class="talent-plate-wrap" style="left:${pos.x}%;top:${pos.y}%" data-talent="${t.id}">
      <button class="talent-plate ${unlocked?'is-unlocked':'is-locked'}" aria-label="${esc(t.name)}（${unlocked?'Lv'+lv:'未觉醒'}）">
        ${unlocked?'<span class="talent-plate__glow" aria-hidden="true"></span>':''}
        ${icon(t.icon)}
        <span class="talent-plate__name">${esc(t.name)}</span>
        <span class="talent-plate__lv ${unlocked?'is-on':''}">${unlocked?'Lv '+lv:'未觉醒'}</span>
      </button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.talent-plate').forEach(b=>{
    b.addEventListener('click',()=>{
      A.click();
      selectTalent(b.closest('.talent-plate-wrap').dataset.talent);
    });
  });
  if(talentSel)selectTalent(talentSel,true);
  else showTalentEmpty();
}
function selectTalent(id,silent){
  talentSel=id;
  const t=TALENTS.find(x=>x.id===id);
  const lv=S.talents[id]||0;
  $$('.talent-plate-wrap').forEach(w=>w.classList.toggle('is-selected',w.dataset.talent===id));
  const d=$('#talent-info-detail');
  d.hidden=false;
  $('#talent-info-empty').style.display='none';
  $('#tinfo-name').textContent=t.name;
  $('#tinfo-meta').innerHTML=`
    <span class="chip">${lv>0?'已觉醒':'未觉醒'}</span>
    <span class="chip">等级 ${lv} / ${t.max}</span>
    ${lv>0?'<span class="chip" style="color:var(--copper)">生效中</span>':''}`;
  $('#tinfo-desc').textContent=t.desc;
  $('#tinfo-level').innerHTML=Array.from({length:t.max},(_,i)=>`<span class="lv-dot ${i<lv?'on':''}"></span>`).join('')+`<span class="lv-num">Lv ${lv} / ${t.max}</span>`;
  const br=$('#tinfo-branch');
  br.hidden=false;
  br.innerHTML=`<div class="talent-branch__title">衍生分支</div>`+t.branch.map(b=>
    `<div class="talent-branch__item ${lv>=b.on?'':'is-locked'}">${esc(b.name)} — ${esc(b.desc)}</div>`).join('');
  if(!silent){
    const plate=document.querySelector(`.talent-plate-wrap[data-talent="${id}"] .talent-plate`);
    if(plate)FX.spark(plate.getBoundingClientRect().left+50,plate.getBoundingClientRect().top+50,{n:10,size:2,up:true,spread:60});
  }
}
function showTalentEmpty(){
  $('#talent-info-empty').style.display='';
  $('#talent-info-detail').hidden=true;
}
$('#talent-info').addEventListener('click',e=>{
  if(!talentSel)return;
  if(e.target.closest('.lv-dot')||e.target.closest('.lv-num')){
    const t=TALENTS.find(x=>x.id===talentSel);
    const lv=S.talents[talentSel]||0;
    if(lv>=t.max){ notify('whisper','灵质低语',`「${t.name}」已臻圆满 —— 秘仪深处再无余韵。`); return; }
    openConfirm(lv===0
      ? {title:'觉醒刻印',text:`是否觉醒天赋「${t.name}」？刻印之力将即刻生效。`,yes:'觉醒',fn:()=>{S.talents[talentSel]=1; unlockFx();}}
      : {title:'升华刻印',text:`是否将「${t.name}」升华至 Lv${lv+1}？（耗墨珠 1）`,yes:'升华',fn:()=>{
          if(S.pearls<1){notify('scarlet','绯红宣告','墨珠不足 —— 升华暂缓。');return;}
          S.pearls-=1; $('#ink-pearl-num').textContent=S.pearls;
          S.talents[talentSel]=(S.talents[talentSel]||0)+1; unlockFx(); }});
  }
});
function unlockFx(){
  saveState();
  const t=TALENTS.find(x=>x.id===talentSel);
  const plate=document.querySelector(`.talent-plate-wrap[data-talent="${talentSel}"] .talent-plate`);
  if(plate){
    plate.classList.remove('is-bursting'); void plate.offsetWidth;
    plate.classList.add('is-bursting');
    FX.burstAt(plate,{n:26,size:3,up:true,spread:130});
  }
  A.chime();
  renderTalents();
  notify('decree','鎏金敕令',`刻印觉醒 —— 「${t.name}」之力已烙印于魂。`,nowLabel(),{view:'talent'});
}

/* ═══════════════════════════════════════════════════════════════
   灵枢秘藏（设置）
   ═══════════════════════════════════════════════════════════════ */
function renderSettings(){
  $$('#settings-mode .mode-chip').forEach(c=>{
    const on=c.dataset.mode===S.llm.mode;
    c.classList.toggle('is-active',on);
    c.setAttribute('aria-checked',on?'true':'false');
  });
  $('#set-endpoint').value=S.llm.endpoint;
  $('#set-key').value=S.llm.key;
  $('#set-model').value=S.llm.model;
  $('#set-temp').value=S.llm.temp??0.85;
  $('#set-temp-val').textContent=(S.llm.temp??0.85).toFixed(2);
  $('#settings-fields').style.opacity=S.llm.mode==='remote'?1:.4;
  $('#settings-fields').style.pointerEvents=S.llm.mode==='remote'?'auto':'none';
  $('#settings-status').textContent = S.llm.mode==='mock'
    ? '当前：灵质回响 · 模拟模式 —— 所有叙事均由内置引擎即时织就，可即刻体验完整流程。'
    : `当前：远端灵枢 —— 叙事将交由 ${S.llm.model||'未配置模型'} 织就。`;
}
$$('#settings-mode .mode-chip').forEach(c=>c.addEventListener('click',()=>{
  A.click();
  S.llm.mode=c.dataset.mode;
  renderSettings();
}));
$('#set-temp').addEventListener('input',e=>{
  $('#set-temp-val').textContent=Number(e.target.value).toFixed(2);
});
$('#btn-settings-save').addEventListener('click',()=>{
  S.llm.endpoint=$('#set-endpoint').value.trim();
  S.llm.key=$('#set-key').value.trim();
  S.llm.model=$('#set-model').value.trim();
  S.llm.temp=Number($('#set-temp').value);
  saveState();
  closeModal($('#modal-settings'));
  notify('whisper','灵质低语',`灵枢秘藏已封存 —— 回响源：${S.llm.mode==='mock'?'内置引擎':'远端灵枢'}。`);
});
$('#btn-settings-test').addEventListener('click',async()=>{
  A.click();
  $('#settings-status').textContent='连通测试中……';
  if(S.llm.mode==='mock'){
    setTimeout(()=>{ $('#settings-status').textContent='内置引擎响应正常 —— 叙事即刻可织。'; A.chime(); },500);
    return;
  }
  try{
    const base=S.llm.endpoint.replace(/\/+$/,'');
    const res=await fetch(base+'/models',{headers:{'Authorization':'Bearer '+S.llm.key}});
    if(res.ok){ $('#settings-status').textContent='远端灵枢响应正常 —— 通道畅通。'; A.chime(); }
    else $('#settings-status').textContent='远端灵枢返回异常（'+res.status+'）—— 请核对地址与密钥。';
  }catch(e){
    $('#settings-status').textContent='无法抵达远端灵枢 —— 已建议转回模拟回响。';
    notify('scarlet','绯红宣告','远端灵枢失联 —— 秘藏已自动保留模拟回响。');
  }
});

/* ═══════════════════════════════════════════════════════════════
   世界书 / 预设 / 变量 模态（skill 规范）
   ═══════════════════════════════════════════════════════════════ */
function renderLorebook(){
  const active = ST.settings.activeLorebookIds||[];
  const books = ST.lorebooks;
  $('#lorebook-count').textContent = `${books.length} 本世界书 · ${books.reduce((a,b)=>a+b.entries.length,0)} 条条目`;
  const list = $('#lorebook-list');
  list.innerHTML = books.length? '' : '<div class="chat-list__empty">尚无世界书。战败者与诸界秘辛，皆可载入。</div>';
  for(const book of books){
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="sidebar-section-title" style="cursor:pointer" data-book-toggle="${book.id}">
        ${icon(active.includes(book.id)?'i-eye':'i-lock')} ${esc(book.name)} <span style="margin-left:auto;opacity:.7">${book.entries.length} 条</span>
      </div>
      <div class="lorebook-list" data-book-entries="${book.id}" style="${active.includes(book.id)?'':'display:none'}"></div>`;
    const entriesZone = wrap.querySelector('[data-book-entries]');
    entriesZone.innerHTML = book.entries.map(e=>`
      <div class="lore-item ${e.constant?'is-constant':''}" data-entry="${e.id}" data-book="${book.id}">
        <span class="lore-item__keys">${esc((e.keys||[]).join(' / ')||'（无关键词）')}</span>
        <span class="lore-item__preview">${esc(String(e.content||'').slice(0,46))}</span>
        <span class="lore-item__pos">${e.position==='before_char'?'前置':e.position==='after_char'?'后置':'注入'}</span>
        <button class="lore-item__del" data-del-entry="${e.id}" data-book="${book.id}" aria-label="删除条目">${icon('i-trash')}</button>
      </div>`).join('');
    entriesZone.querySelectorAll('[data-del-entry]').forEach(b=>b.addEventListener('click',async e=>{
      e.stopPropagation();
      const bk = ST.lorebooks.find(x=>x.id===b.dataset.book);
      if(!bk)return;
      bk.entries = bk.entries.filter(x=>x.id!==b.dataset.delEntry);
      bk.updatedAt=Date.now();
      await ST.saveLorebook(bk);
      renderLorebook();
    }));
    entriesZone.querySelectorAll('[data-entry]').forEach(item=>item.addEventListener('click',()=>editLoreEntry(item.dataset.book,item.dataset.entry)));
    wrap.querySelector('[data-book-toggle]').addEventListener('click',async e=>{
      if(e.target.closest('[data-del-entry]'))return;
      const id = e.currentTarget.dataset.bookToggle;
      const on = active.includes(id);
      const next = on ? active.filter(x=>x!==id) : [...active,id];
      await ST.updateSettings({activeLorebookIds:next});
      renderLorebook();
    });
    list.appendChild(wrap);
  }
}
function editLoreEntry(bookId, entryId){
  const book = ST.lorebooks.find(x=>x.id===bookId);
  const entry = book?.entries.find(x=>x.id===entryId);
  if(!entry)return;
  const item = document.querySelector(`[data-entry="${entryId}"]`);
  if(!item)return;
  item.classList.add('is-editing');
  item.innerHTML = `
    <div class="lore-edit">
      <label>关键词（空格分隔）<input class="le-keys" value="${esc((entry.keys||[]).join(' '))}"></label>
      <label>内容<textarea class="le-content" rows="4">${esc(entry.content||'')}</textarea></label>
      <div class="lore-edit__row">
        <label>位置
          <select class="le-pos">
            <option value="before_char" ${entry.position==='before_char'?'selected':''}>前置（角色前）</option>
            <option value="after_char" ${entry.position==='after_char'?'selected':''}>后置（角色后）</option>
            <option value="outlet" ${entry.position==='outlet'?'selected':''}>出口</option>
          </select>
        </label>
        <label>顺序 <input class="le-order" type="number" value="${entry.order}" style="width:90px"></label>
      </div>
      <div class="lore-edit__checks">
        <label><input type="checkbox" class="le-constant" ${entry.constant?'checked':''}> 恒定注入</label>
        <label><input type="checkbox" class="le-selective" ${entry.selective?'checked':''}> 选择性</label>
      </div>
      <div class="lore-edit__row">
        <button class="btn-primary btn-primary--gold lore-edit__save" data-save-entry="${entry.id}">保存</button>
        <button class="btn-ghost le-cancel">取消</button>
      </div>
    </div>`;
  item.querySelector('.le-cancel').addEventListener('click',()=>renderLorebook());
  item.querySelector('[data-save-entry]').addEventListener('click',async()=>{
    entry.keys = item.querySelector('.le-keys').value.trim().split(/\s+/).filter(Boolean);
    entry.content = item.querySelector('.le-content').value;
    entry.position = item.querySelector('.le-pos').value;
    entry.order = Number(item.querySelector('.le-order').value)||100;
    entry.constant = item.querySelector('.le-constant').checked;
    entry.selective = item.querySelector('.le-selective').checked;
    book.updatedAt=Date.now();
    await ST.saveLorebook(book);
    renderLorebook();
    notify('whisper','灵质低语','条目已刻入世界书 —— 灵枢将依关键词查阅。');
  });
}
$('#btn-lore-add').addEventListener('click',async()=>{
  let book = ST.lorebooks[0];
  if(!book){
    book = buildSeedLorebook();
    await ST.saveLorebook(book);
    await ST.updateSettings({activeLorebookIds:[...new Set([...(ST.settings.activeLorebookIds||[]),book.id])]});
  }
  const entry = createDefaultEntry({keys:['新关键词'],content:'新条目内容……'});
  book.entries.push(entry);
  await ST.saveLorebook(book);
  renderLorebook();
  editLoreEntry(book.id, entry.id);
});

/* ── 预设 ── */
function renderPresets(){
  $('#preset-list').innerHTML = ST.presets.map(p=>`
    <button class="preset-chip ${p.id===ST.settings.activePresetId?'is-active':''}" data-preset="${p.id}">${esc(p.name)}</button>`).join('');
  $('#preset-list').querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{
    A.click();
    ST.updateSettings({activePresetId:b.dataset.preset});
    renderPresets();
  }));
  const p = ST.presets.find(x=>x.id===ST.settings.activePresetId)||ST.presets[0];
  if(p){
    $('#pre-temp').value = p.settings.temp_openai??0.85;
    $('#pre-ctx').value = p.settings.openai_max_context??4096;
    $('#pre-max').value = p.settings.openai_max_tokens??2048;
    $('#pre-main').value = p.settings.main||'';
    $('#pre-format').value = ST.settings.formatPromptTemplate||DEFAULT_FORMAT_PROMPT;
    const order = p.settings.prompt_order||[];
    $('#preset-order-list').innerHTML = order.map((item,i)=>`
      <div class="preset-order-item">
        <input type="checkbox" data-oi="${i}" ${item.enabled===false?'':'checked'}>
        <span class="preset-order-item__id">${esc(item.identifier)}</span>
        <span>${esc(item.name||'')}</span>
        <button class="preset-order-item__up" data-up="${i}" aria-label="上移">${icon('i-chev')}</button>
        <button class="preset-order-item__down" data-down="${i}" aria-label="下移">${icon('i-chev')}</button>
      </div>`).join('');
    $('#preset-order-list').querySelectorAll('[data-oi]').forEach(cb=>cb.addEventListener('change',()=>{
      order[+cb.dataset.oi].enabled = cb.checked;
    }));
    $('#preset-order-list').querySelectorAll('[data-up]').forEach(b=>b.addEventListener('click',()=>{
      const i=+b.dataset.up; if(i>0){ const t=order[i]; order[i]=order[i-1]; order[i-1]=t; renderPresets(); }
    }));
    $('#preset-order-list').querySelectorAll('[data-down]').forEach(b=>b.addEventListener('click',()=>{
      const i=+b.dataset.down; if(i<order.length-1){ const t=order[i]; order[i]=order[i+1]; order[i+1]=t; renderPresets(); }
    }));
  }
}
$$('.preset-tab').forEach(t=>t.addEventListener('click',()=>{
  A.click();
  $$('.preset-tab').forEach(x=>x.classList.toggle('is-active',x===t));
  ['sample','prompt','order'].forEach(p=>$('#preset-pane-'+p).hidden = p!==t.dataset.ptab);
}));
$('#btn-preset-save').addEventListener('click',async()=>{
  const p = ST.presets.find(x=>x.id===ST.settings.activePresetId)||ST.presets[0];
  if(!p)return;
  p.settings.temp_openai = Number($('#pre-temp').value);
  p.settings.openai_max_context = Number($('#pre-ctx').value);
  p.settings.openai_max_tokens = Number($('#pre-max').value);
  p.settings.main = $('#pre-main').value;
  p.updatedAt = Date.now();
  await ST.savePreset(p);
  await ST.updateSettings({formatPromptTemplate: $('#pre-format').value});
  renderPresets();
  notify('whisper','灵质低语',`预设「${p.name}」已封存 —— 灵枢将依此织话。`);
});
$('#btn-preset-apply').addEventListener('click',()=>{
  A.click();
  closeModal($('#modal-preset'));
  notify('decree','鎏金敕令','预设已套用 —— 回响风格即刻生效。');
});

/* ── 变量 ── */
let varsDraft=[];
function renderVars(){
  const chat = ST.activeChat;
  const vars = chat? (chat.variables||{}) : {};
  const zone = $('#vars-list');
  if(!chat){
    zone.innerHTML='<div class="chat-list__empty">请先选择会话，再管理其变量。</div>';
    return;
  }
  const rows = Object.keys(vars).length? Object.entries(vars) : [['新变量','']];
  varsDraft = rows.map(([k,v])=>[k,String(v)]);
  zone.innerHTML = varsDraft.map(([k,v],i)=>`
    <div class="vars-row" data-row="${i}">
      <input class="var-key" value="${esc(k)}" placeholder="名称" aria-label="变量名">
      <input class="var-val" value="${esc(v)}" placeholder="值" aria-label="变量值">
      <button class="vars-row__del" data-del-var="${i}" aria-label="删除">${icon('i-trash')}</button>
    </div>`).join('');
  zone.querySelectorAll('[data-del-var]').forEach(b=>b.addEventListener('click',()=>{
    varsDraft.splice(+b.dataset.delVar,1);
    renderVars();
  }));
}
$('#btn-vars-add').addEventListener('click',()=>{ varsDraft.push(['','']); renderVars(); });
$('#btn-vars-save').addEventListener('click',async()=>{
  const chat = ST.activeChat;
  if(!chat)return;
  const updates={};
  $$('#vars-list .vars-row').forEach(row=>{
    const k=row.querySelector('.var-key').value.trim();
    const v=row.querySelector('.var-val').value.trim();
    if(k) updates[k] = Number.isNaN(Number(v)) || v==='' ? v : Number(v);
  });
  chat.variables = mergeVariables(chat.variables, updates);
  syncGameStateFromVars(chat);
  await ST.persistChat(chat);
  closeModal($('#modal-vars'));
  renderAll();
  notify('whisper','灵质低语','变量已镌刻 —— 下一轮回响将携带它们。');
});

/* ═══════════════════════════════════════════════════════════════
   打字机
   ═══════════════════════════════════════════════════════════════ */
async function typeText(el,text,{speed=14,instant=false}={}){
  if(reduceMotion||instant||text.length<30){ el.textContent=text; return; }
  let i=0;
  const caret=document.createElement('span');
  caret.className='typing-caret';
  const done=()=>{ caret.remove(); };
  el.appendChild(caret);
  await new Promise(res=>{
    const step=()=>{
      const chunk=Math.max(2,Math.round(rnd(1,3.2)));
      i=Math.min(text.length,i+chunk);
      el.textContent=text.slice(0,i);
      if(i<text.length)setTimeout(step,speed);
      else{ done(); res(); }
    };
    step();
  });
}
function fillName(t,char){
  return t.replaceAll('{name}',char?char.name:'她')
          .replaceAll('{ult}',char&&char.ult?char.ult.name:'禁咒')
          .replaceAll('{part}',['真名','灵力','弱点','意图'][Math.floor(Math.random()*4)])
          .replaceAll('{value}',['高深莫测','暗流涌动','一触即溃','深藏不露'][Math.floor(Math.random()*4)]);
}
const uid = () => 'u'+Math.random().toString(36).slice(2,9);

/* ═══════════════════════════════════════════════════════════════
   初始化
   ═══════════════════════════════════════════════════════════════ */
async function init(){
  loadState();
  A.enabled=S.sound;
  $('#btn-sound-toggle').style.color=S.sound?'':'rgba(160,138,94,.5)';
  $('#ink-pearl-num').textContent=S.pearls;
  $('#contract-count-num').textContent=S.owned.length;
  $('#victory-count-num').textContent=S.victories;

  // 抽屉菜单
  if(!$('#btn-menu')){
    const menu=document.createElement('button');
    menu.id='btn-menu';
    menu.className='icon-btn';
    menu.setAttribute('aria-label','打开导航');
    menu.innerHTML=icon('i-menu');
    $('#top-bar .top-bar__brand').appendChild(menu);
  }
  const items=[
    ['lobby','酒馆大堂','i-chat','聊天 · 事件'],
    ['summon','召唤台','i-summon','诸界垂钓'],
    ['arena','对战台','i-arena','沙盘演武'],
    ['codex','图鉴','i-codex','芳名录'],
    ['disposal','处置室','i-disposal','裁决与记录'],
    ['talent','天赋','i-talent','秘仪刻印'],
  ];
  $('#nav-drawer-items').innerHTML=items.map(([v,l,i,s])=>`
    <button class="drawer-item" data-view="${v}">
      ${icon(i)}
      <span class="drawer-item__label">${l}</span>
      <span class="drawer-item__sub">${s}</span>
    </button>`).join('');
  $$('#nav-drawer-items .drawer-item').forEach(b=>b.addEventListener('click',()=>go(b.dataset.view)));

  // ST 初始化
  await ST.loadAll();
  await ST.ensureSettings();
  let seeded = false;
  if(!ST.chats.length){
    const seed = buildSeedChat();
    ST.chats.push(seed);
    await DB.saveChat(seed);
    seeded = true;
  }
  if(!ST.lorebooks.length){
    const lb = buildSeedLorebook();
    await ST.saveLorebook(lb);
    await ST.updateSettings({activeLorebookIds:[lb.id]});
  }
  if(seeded) await ST.loadChat('c-seed-zhu');

  FX.init();
  buildSummonArray();
  renderSidebar();
  renderChat();
  initEvents();
  FX.ambient();

  setTimeout(()=>{
    notify('whisper','灵质低语','欢迎归来，契约者。酒馆已备好灯火——点选左侧角色卡即可开席。','',{ttl:8000});
  },900);
  setTimeout(()=>{
    notify('decree','鎏金敕令','世界书《诸界见闻录》已装入灵枢 —— 提及关键词即可触发秘辛。','',{view:'lobby',ttl:7000});
  },2800);
}

function initEvents(){
  // 顶栏
  $('#btn-settings').addEventListener('click',()=>{ A.click(); renderSettings(); openModal('modal-settings'); });
  $('#btn-sound-toggle').addEventListener('click',()=>{
    const on=A.toggle(); S.sound=on; saveState();
    $('#btn-sound-toggle').style.color=S.sound?'':'rgba(160,138,94,.5)';
  });
  // 侧栏
  $('#char-search').addEventListener('input',renderSidebar);
  $('#btn-sidebar-toggle').addEventListener('click',()=>{
    A.click();
    $('#tavern-sidebar').classList.toggle('on');
  });
  // 聊天输入
  const input=$('#chat-input');
  input.addEventListener('input',autoGrowInput);
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(input.value); }
  });
  $('#btn-chat-send').addEventListener('click',()=>sendMessage($('#chat-input').value));
  // header 操作
  $('#btn-chat-roll').addEventListener('click',rollLast);
  $('#btn-chat-continue').addEventListener('click',continueLast);
  $('#btn-chat-new').addEventListener('click',async()=>{
    const chat = ST.activeChat;
    if(!chat){ notify('whisper','灵质低语','先选一位来客。'); return; }
    A.click();
    const c = charById(chat.characterId);
    const card = CHAR_CARDS[chat.characterId]||{};
    const greeting = pick(card.greetings||[]);
    const mood = charMood(chat.characterId);
    const nch = await ST.createChat({
      name:`${c.name} · 新对话 ${ST.chats.filter(x=>x.characterId===c.id).length+1}`,
      characterId:c.id, characterName:c.name, variables:{...mood},
    });
    if(greeting){
      nch.messages.push(createMessage('assistant',greeting,{kind:'chat',variables:{...nch.variables},swipe:swipeCandidates(c.id,'greeting')}));
      await ST.persistChat(nch);
    }
    renderAll();
  });
  // 召唤
  $('#btn-summon').addEventListener('click',()=>{
    A.click();
    if(S.pearls<1){
      notify('scarlet','绯红宣告','墨珠不足 —— 回响无法启动。可于处置室通过交易、献祭换取墨珠。','',{view:'disposal'});
      return;
    }
    buildSourceTabs();
    openModal('modal-summon');
  });
  $('#btn-rite-cast').addEventListener('click',castSummon);
  // 战斗
  $('#btn-act-guard').addEventListener('click',playerGuard);
  $('#btn-act-ult').addEventListener('click',playerUlt);
  $('#btn-act-swap').addEventListener('click',()=>{
    if(Battle.ally.length>1)notify('whisper','灵质低语','点按左侧待机栏中的卡牌即可换阵。');
  });
  $('#btn-act-summon').addEventListener('click',()=>{
    if(Battle.ally.length>1)notify('whisper','灵质低语','待机召唤物在左下方 —— 点按卡牌即行换阵。');
    else notify('whisper','灵质低语','当前麾下无待机召唤物可唤。');
  });
  $('#btn-act-declare').addEventListener('click',playerDeclare);
  // 世界书 / 预设 / 变量
  $('#btn-tool-lorebook').addEventListener('click',()=>{ A.click(); renderLorebook(); openModal('modal-lorebook'); });
  $('#btn-tool-preset').addEventListener('click',()=>{ A.click(); renderPresets(); openModal('modal-preset'); });
  $('#btn-tool-vars').addEventListener('click',()=>{ A.click(); renderVars(); openModal('modal-vars'); });
  // 抽屉
  $('#btn-menu').addEventListener('click',()=>{
    A.click();
    $('#nav-drawer').classList.add('on');
    $('#drawer-backdrop').classList.add('on');
  });
  $('#btn-drawer-close').addEventListener('click',closeDrawer);
  $('#drawer-backdrop').addEventListener('click',closeDrawer);
  // 键盘
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){ closeTop(); return; }
    if(Battle.state==='fighting'&&currentView==='arena'){
      const map={'1':'#btn-act-summon','2':'#btn-act-swap','3':'#btn-act-guard','4':'#btn-act-ult','5':'#btn-act-declare'};
      const sel=map[e.key];
      if(sel){ e.preventDefault(); $(sel).click(); }
    }
  });
  // 悬停音
  $$('.act-btn,.nav-item,.icon-btn,.btn-primary,.verdict-tab,.source-tab,.pact-option,.char-card,.chat-act,.qr-chip').forEach(el=>{
    el.addEventListener('mouseenter',()=>A.hover());
  });
}
function closeDrawer(){
  $('#nav-drawer').classList.remove('on');
  $('#drawer-backdrop').classList.remove('on');
  $('#tavern-sidebar').classList.remove('on');
}
function autoGrowInput(){
  const input=$('#chat-input');
  input.style.height='auto';
  input.style.height=Math.min(140,Math.max(48,input.scrollHeight))+'px';
}

document.addEventListener('DOMContentLoaded',init);

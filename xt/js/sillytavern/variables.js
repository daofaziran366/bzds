/* ═══════════════════════════════════════════════════════════════
   SillyTavern 生态 · 变量系统
   提取 <var name="…" value="…" /> / 深合并 / prompt 注入 / 截断回档 / 分支
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/** 从文本提取 <var> 标签，返回清理后文本与更新 */
function extractVariables(text) {
  const updates = {};
  const re = /<var\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, name, raw] = m;
    const num = Number(raw);
    updates[name] = Number.isNaN(num) ? raw : num;
  }
  const cleaned = text.replace(re, '').replace(/\n{2,}/g, '\n').trim();
  return { cleanedText: cleaned, updates };
}

/** 深合并变量（支持 JSON 补丁式 {key: +10} / {key: 55} / {key: {…}}） */
function mergeVariables(base = {}, updates = {}) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const [k, v] of Object.entries(updates || {})) {
    if (typeof v === 'object' && v !== null) {
      out[k] = mergeVariables(out[k] || {}, v);
    } else if (typeof v === 'string' && /^[+-]/.test(v) && /^\d+$/.test(v.slice(1))) {
      const d = parseInt(v, 10);
      out[k] = clampNum((Number(out[k]) || 0) + d);
    } else if (typeof v === 'number' && typeof out[k] === 'number' && Math.abs(v) < 1000 && out[k] > 100) {
      out[k] = clampNum(out[k] + v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
function clampNum(n) { return Math.max(0, Math.min(999, Math.round(n * 10) / 10)); }

/** 变量块注入（[当前状态]） */
function formatVariablesForPrompt(variables) {
  const entries = Object.entries(variables || {});
  if (!entries.length) return '';
  return '[当前状态]\n' + entries.map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** 从消息索引处截断会话并回档变量快照 */
function truncateChatAt(chat, index, variables) {
  const truncated = chat.messages.slice(0, index);
  const restored = variables ?? truncated[truncated.length - 1]?.variables ?? chat.variables ?? {};
  return { ...chat, messages: truncated, variables: restored, updatedAt: Date.now() };
}

/** 从消息索引处创建分支会话 */
function branchChat(source, index, options) {
  return {
    ...createChatSession({
      id: undefined,
      name: options.name,
      messages: source.messages.slice(0, index + 1).map(m => JSON.parse(JSON.stringify(m))),
      characterId: source.characterId,
      characterName: source.characterName,
      userName: source.userName,
      presetId: options.presetId,
      lorebookIds: [...options.lorebookIds],
      variables: options.variables ?? source.messages[index]?.variables ?? source.variables ?? {},
    }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** v3: 将流式解析事件聚合为 ParsedTags */
function aggregateEvents(events) {
  const parsed = { thinking: '', maintext: '', options: [], sum: '', varsRaw: '', varsCommands: { merge: {} }, unknown: {} };
  for (const ev of events) {
    if (ev.type === 'tag-close') {
      if (ev.tag === 'thinking' || ev.tag === 'think') parsed.thinking = ev.full;
      else if (ev.tag === 'maintext') parsed.maintext = ev.full;
      else if (ev.tag === 'sum') parsed.sum = ev.full;
      else if (ev.tag === 'vars') {
        parsed.varsRaw = ev.full;
        try { parsed.varsCommands = { merge: JSON.parse(ev.full) }; } catch (e) { parsed.varsCommands = { merge: {} }; }
      } else if (ev.tag !== 'option') parsed.unknown[ev.tag] = ev.full;
    } else if (ev.type === 'option-line') {
      parsed.options.push(ev.line);
    }
  }
  return parsed;
}

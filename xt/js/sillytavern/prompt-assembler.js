/* ═══════════════════════════════════════════════════════════════
   SillyTavern 生态 · Prompt 组装器
   prompt_order 有序组装 + 宏替换 + 变量注入 + 世界书注入
   ═══════════════════════════════════════════════════════════════ */
'use strict';

function replaceMacros(template, ctx) {
  let out = String(template)
    .replace(/\{\{user\}\}/g, ctx.userName)
    .replace(/\{\{char\}\}/g, ctx.characterName)
    .replace(/\{\{original\}\}/g, ctx.userInput || '');
  if (ctx.variables) {
    out = out.replace(/\{\{([^{}]+)\}\}/g, (m, key) => {
      const v = ctx.variables[key.trim()];
      return v !== undefined ? String(v) : m;
    });
  }
  return out;
}

/**
 * 组装 prompt：
 * @param {object} o { userInput, history, preset, lorebooks, character, userName, characterName, variables, formatPrompt }
 * @returns { messages, matchedEntries, systemPrompt }
 */
function assemblePrompt(o) {
  const { userInput, history = [], preset, lorebooks = [], character = null, userName, characterName, variables = {}, formatPrompt } = o;

  // 1. 世界书扫描（近 3 条消息 + 当前输入）
  const allMatched = [];
  const scanText = userInput + ' ' + history.slice(-3).map(m => m.content).join(' ');
  for (const book of lorebooks) {
    const engine = createLorebookEngine(book);
    allMatched.push(...engine.recursiveScan(scanText, 3));
  }
  const uniqueEntries = Array.from(new Map(allMatched.map(e => [e.entry.id, e])).values())
    .sort((a, b) => a.score - b.score);

  // 2. 近端历史（token 预算 80%）
  const maxTokens = (preset.settings.openai_max_context || 4096) * 0.8;
  let used = 0;
  const recent = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'system' || msg.kind === 'sys') continue;
    const t = String(msg.content || '').length / 4;
    if (used + t > maxTokens) break;
    recent.unshift({ role: msg.role, content: msg.content || '' });
    used += t;
  }

  // 3. 按 prompt_order 组装
  const order = preset.settings.prompt_order || DEFAULT_PROMPT_ORDER;
  const prompts = preset.settings.prompts || [];
  const resolve = id => {
    if (id === 'worldInfoBefore' || id === 'worldInfoAfter')
      return uniqueEntries.map(e => e.entry.content).join('\n\n') || null;
    if (id === 'charDescription') return character?.description || null;
    if (id === 'charPersonality') return character?.personality || null;
    if (id === 'scenario') return character?.scenario || null;
    if (id === 'personaDescription') return character?.persona || null;
    if (id === 'dialogueExamples') return character?.exampleDialogue || null;
    if (id === 'groupNudge') return null;
    const custom = prompts.find(p => p.identifier === id);
    if (custom?.content) return custom.content;
    const direct = preset.settings[id];
    return typeof direct === 'string' && direct.trim() ? direct : null;
  };

  const assembled = [];
  let sysAcc = '';
  const pushSys = () => { if (sysAcc.trim()) { assembled.push({ role: 'system', content: sysAcc.trim() }); sysAcc = ''; } };

  for (const item of order) {
    if (item.enabled === false) continue;
    if (item.identifier === 'chatHistory') {
      pushSys();
      assembled.push(...recent);
      continue;
    }
    const raw = resolve(item.identifier);
    if (!raw) continue;
    const content = replaceMacros(raw, { userName, characterName, userInput, variables });
    if (!content.trim()) continue;
    const role = item.role || 'system';
    if (role === 'system') sysAcc += (sysAcc ? '\n\n' : '') + content;
    else { pushSys(); assembled.push({ role, content }); }
  }

  // 4. 变量块 + 格式约定
  const varsBlock = formatVariablesForPrompt(variables);
  if (varsBlock) sysAcc += (sysAcc ? '\n\n' : '') + varsBlock;
  if (formatPrompt) sysAcc += (sysAcc ? '\n\n' : '') + formatPrompt;
  pushSys();

  assembled.push({ role: 'user', content: userInput });

  return {
    messages: assembled,
    matchedEntries: uniqueEntries,
    systemPrompt: assembled.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
  };
}

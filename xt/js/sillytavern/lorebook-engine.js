/* ═══════════════════════════════════════════════════════════════
   SillyTavern 生态 · Lorebook 关键词匹配引擎
   （移植自 skill 模板 lorebook-engine.ts）
   ═══════════════════════════════════════════════════════════════ */
'use strict';

class LorebookEngine {
  constructor(lorebook) { this.lorebook = lorebook; }

  scan(text, additionalContext) {
    const lb = this.lorebook;
    const norm = s => lb.caseSensitive ? s : String(s).toLowerCase();
    const t = norm(text);
    const ctx = additionalContext != null ? norm(additionalContext) : t;
    const matched = [];

    for (const entry of lb.entries) {
      if (entry.constant) { matched.push({ entry, score: -9999, matchedKeywords: ['恒定'] }); continue; }
      if (entry.useProbability && Math.random() * 100 >= entry.probability) continue;
      if (this.checkEntryMatch(entry, t, ctx)) {
        matched.push({
          entry,
          score: entry.order,
          matchedKeywords: entry.keys.filter(k => this.containsKeyword(t, this.normKey(k))),
        });
      }
    }
    return matched.sort((a, b) => a.score - b.score);
  }

  recursiveScan(initialText, maxDepth = 3, additionalContext) {
    if (!this.lorebook.recursiveScanning || maxDepth <= 0) return this.scan(initialText, additionalContext);
    const all = new Map();
    let current = initialText, depth = 0;
    while (depth < maxDepth) {
      const fresh = this.scan(current, additionalContext);
      let added = false;
      for (const m of fresh) {
        if (!all.has(m.entry.id)) { all.set(m.entry.id, m); current += ' ' + m.entry.content; added = true; }
      }
      if (!added) break;
      depth++;
    }
    return Array.from(all.values()).sort((a, b) => a.score - b.score);
  }

  groupByPosition(matched) {
    const g = {};
    for (const p of POSITIONS) g[p] = [];
    for (const m of matched) (g[m.entry.position] || g.before_char).push(m);
    return g;
  }

  formatEntriesContent(entries) {
    if (!entries.length) return '';
    return entries.map(e => e.entry.content).join('\n\n');
  }

  checkEntryMatch(entry, text, context) {
    const { keys, secondaryKeys, selective, selectiveLogic } = entry;
    if (!keys || !keys.length) return false;
    const primaries = keys.map(k => this.containsKeyword(text, this.normKey(k)));
    const allP = primaries.every(Boolean), anyP = primaries.some(Boolean);
    let primaryOk;
    switch (selectiveLogic) {
      case 'not_all': primaryOk = !allP; break;
      case 'not_any': primaryOk = !anyP; break;
      default: primaryOk = anyP;
    }
    if (!primaryOk) return false;
    if (!selective || !secondaryKeys || !secondaryKeys.length) return true;
    const secondaries = secondaryKeys.map(k => this.containsKeyword(context, this.normKey(k)));
    const allS = secondaries.every(Boolean), anyS = secondaries.some(Boolean);
    switch (selectiveLogic) {
      case 'and_all': case 'not_all': return allS;
      default: return anyS;
    }
  }

  normKey(k) { return this.lorebook.caseSensitive ? k : k.toLowerCase(); }
  containsKeyword(text, kw) {
    if (this.lorebook.matchWholeWords) {
      try { return new RegExp('\\b' + this.escapeRegex(kw) + '\\b', 'i').test(text); } catch (e) { return text.includes(kw); }
    }
    return text.includes(kw);
  }
  escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}

function createLorebookEngine(lb) { return new LorebookEngine(lb); }

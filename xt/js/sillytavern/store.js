/* ═══════════════════════════════════════════════════════════════
   SillyTavern 生态 · 中央 Store（vanilla 单例）
   会话 / 世界书 / 预设 / 设置 / 消息操作（编辑·删除·分支·swipe·继续）
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const ST = {
  lorebooks: [], presets: [], settings: null, chats: [],
  activeChatId: null, isSending: false, isLoading: true,
  _listeners: new Set(),

  subscribe(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); },
  notify() { this._listeners.forEach(cb => { try { cb(); } catch (e) {} }); },
  get activeChat() { return this.chats.find(c => c.id === this.activeChatId) || null; },

  async loadAll() {
    this.isLoading = true; this.notify();
    await DB.initializeDatabase();
    const [l, p, s, c] = await Promise.all([DB.getLorebooks(), DB.getPresets(), DB.getSettings(), DB.getChats()]);
    this.lorebooks = l; this.presets = p; this.settings = s; this.chats = c;
    this.isLoading = false; this.notify();
    return this;
  },

  async ensureSettings() {
    if (!this.settings) {
      this.settings = createDefaultSettings({ activePresetId: this.presets[0]?.id || null });
      await DB.saveSettings(this.settings);
    }
    if (!this.presets.length) {
      const p = createDefaultPreset({ name: '默认预设 · 酒馆' });
      this.presets.push(p);
      await DB.savePreset(p);
      if (!this.settings.activePresetId) { this.settings.activePresetId = p.id; await DB.saveSettings(this.settings); }
    }
  },

  async updateSettings(updates) {
    this.settings = { ...this.settings, ...updates };
    await DB.saveSettings(this.settings);
    this.notify();
  },

  // ── 会话 ──
  async createChat(opts = {}) {
    await this.ensureSettings();
    const chat = createChatSession({
      name: opts.name || `${opts.characterName || this.settings.characterName} · 新对话`,
      characterId: opts.characterId || null,
      characterName: opts.characterName || this.settings.characterName,
      presetId: opts.presetId ?? this.settings.activePresetId,
      lorebookIds: [...(this.settings.activeLorebookIds || [])],
      variables: opts.variables || {},
    });
    this.chats.push(chat);
    this.activeChatId = chat.id;
    await DB.saveChat(chat);
    this.notify();
    return chat;
  },

  async loadChat(id) {
    if (this.activeChatId === id) return;
    this.activeChatId = id;
    this.notify();
  },

  async deleteChat(id) {
    await DB.deleteChat(id);
    this.chats = this.chats.filter(c => c.id !== id);
    if (this.activeChatId === id) this.activeChatId = null;
    this.notify();
  },

  async persistChat(chat) {
    await DB.saveChat(chat);
    this.notify();
  },

  // ── 世界书 ──
  async saveLorebook(lb) {
    const i = this.lorebooks.findIndex(x => x.id === lb.id);
    if (i >= 0) this.lorebooks[i] = lb; else this.lorebooks.push(lb);
    await DB.saveLorebook(lb);
    this.notify();
  },
  async deleteLorebook(id) {
    await DB.deleteLorebook(id);
    this.lorebooks = this.lorebooks.filter(x => x.id !== id);
    this.settings.activeLorebookIds = (this.settings.activeLorebookIds || []).filter(x => x !== id);
    await DB.saveSettings(this.settings);
    this.notify();
  },

  // ── 预设 ──
  async savePreset(p) {
    const i = this.presets.findIndex(x => x.id === p.id);
    if (i >= 0) this.presets[i] = p; else this.presets.push(p);
    await DB.savePreset(p);
    this.notify();
  },
  async deletePreset(id) {
    await DB.deletePreset(id);
    this.presets = this.presets.filter(x => x.id !== id);
    this.notify();
  },

  // ── 变量 ──
  async updateVariables(updates) {
    const chat = this.activeChat;
    if (!chat) return;
    chat.variables = mergeVariables(chat.variables, updates);
    chat.updatedAt = Date.now();
    await this.persistChat(chat);
  },

  // ── 消息操作 ──
  /** 编辑用户消息并重新生成（截断至该条，变量回档） */
  async editMessage(messageId, newContent, { generate = true } = {}) {
    const chat = this.activeChat;
    if (!chat) return;
    const idx = chat.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    const vars = chat.messages[idx].variables ?? chat.variables;
    const truncated = truncateChatAt(chat, idx, vars);
    this.chats = this.chats.map(c => c.id === chat.id ? truncated : c);
    await DB.saveChat(truncated);
    this.notify();
    if (generate) await this.sendMessage(newContent);
  },

  /** 删除从某条消息起的后续 */
  async deleteMessagesFrom(messageId) {
    const chat = this.activeChat;
    if (!chat) return;
    const idx = chat.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    const truncated = truncateChatAt(chat, idx);
    this.chats = this.chats.map(c => c.id === chat.id ? truncated : c);
    await DB.saveChat(truncated);
    this.notify();
  },

  /** 从此消息分支创建新会话 */
  async branchFromMessage(messageId, name) {
    const chat = this.activeChat;
    if (!chat) return null;
    const idx = chat.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    const count = this.chats.filter(c => c.characterId === chat.characterId).length;
    const branch = branchChat(chat, idx, {
      name: name || `${chat.characterName} · 分支 ${count + 1}`,
      presetId: this.settings.activePresetId,
      lorebookIds: [...(this.settings.activeLorebookIds || [])],
      variables: chat.messages[idx]?.variables ?? chat.variables,
    });
    this.chats.push(branch);
    this.activeChatId = branch.id;
    await DB.saveChat(branch);
    this.notify();
    return branch;
  },

  /** 截断到目标消息（swipe/继续/重roll 的底层操作） */
  async truncateTo(messageId) {
    const chat = this.activeChat;
    if (!chat) return null;
    const idx = chat.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    const vars = chat.messages[idx]?.variables ?? chat.variables;
    const truncated = truncateChatAt(chat, idx + 1, vars);
    this.chats = this.chats.map(c => c.id === chat.id ? truncated : c);
    await DB.saveChat(truncated);
    this.notify();
    return truncated;
  },
};

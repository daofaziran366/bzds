/* ═══════════════════════════════════════════════════════════════
   SillyTavern 生态 · IndexedDB 持久化层（原生实现，无 dexie 依赖）
   存储：chats / lorebooks / presets / settings
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const DB_NAME = 'dfzr-tavern';
const DB_VERSION = 1;

const DB = {
  db: null,
  ready: null,

  open() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('lorebooks')) db.createObjectStore('lorebooks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('presets')) db.createObjectStore('presets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = e => { this.db = e.target.result; resolve(this.db); };
      req.onerror = e => reject(e.target.error);
    });
    return this.ready;
  },

  _tx(store, mode) {
    return this.db.transaction(store, mode).objectStore(store);
  },
  _req(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  _getAll(store) { return this.open().then(() => this._req(this._tx(store, 'readonly').getAll())); },
  _put(store, val) { return this.open().then(() => this._req(this._tx(store, 'readwrite').put(val))); },
  _del(store, key) { return this.open().then(() => this._req(this._tx(store, 'readwrite').delete(key))); },

  async initializeDatabase() { await this.open(); },

  // ── chats ──
  getChats() { return this._getAll('chats'); },
  saveChat(chat) { return this._put('chats', chat); },
  deleteChat(id) { return this._del('chats', id); },

  // ── lorebooks ──
  getLorebooks() { return this._getAll('lorebooks'); },
  saveLorebook(lb) { return this._put('lorebooks', lb); },
  deleteLorebook(id) { return this._del('lorebooks', id); },

  // ── presets ──
  getPresets() { return this._getAll('presets'); },
  savePreset(p) { return this._put('presets', p); },
  deletePreset(id) { return this._del('presets', id); },

  // ── settings ──
  async getSettings() {
    const all = await this._getAll('settings');
    return all[0] || null;
  },
  saveSettings(s) { return this._put('settings', s); },
};

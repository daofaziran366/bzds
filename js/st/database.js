/* ============================================================
   腐化 · SillyTavern 集成内核 ⓪ 数据层（IndexedDB）
   ------------------------------------------------------------
   照搬 skill sillytavern-web：templates/react/sillytavern/database.ts

   与模板的唯一差别：本项目无构建、无 npm，故不引入 Dexie，
   改用原生 IndexedDB 手写 Promise 封装。表结构、索引、版本号、
   升级路径、对外函数名与 database.ts 一一对应：

     DB_NAME    = 'SillyTavernWebDB'      （同模板）
     DB_VERSION = 3                        （同模板）
     lorebooks 'id, name, updatedAt'
     presets   'id, name, updatedAt'
     settings  'key'
     chats     'id, name, updatedAt'

   v3 的 upgrade 迁移（补 uiMode / customTags / thinkingDisplay /
   formatPromptTemplate / api.secondary）也照搬。
   ============================================================ */
(function () {
  'use strict';

  var DB_NAME = 'SillyTavernWebDB';
  var DB_VERSION = 3;

  var STORES = {
    lorebooks: ['id', 'name', 'updatedAt'],
    presets: ['id', 'name', 'updatedAt'],
    settings: ['key'],
    chats: ['id', 'name', 'updatedAt']
  };

  var dbInstance = null;
  var openPromise = null;

  /* ---------- IDBRequest → Promise ---------- */
  function req(txRequest) {
    return new Promise(function (resolve, reject) {
      txRequest.onsuccess = function () { resolve(txRequest.result); };
      txRequest.onerror = function () { reject(txRequest.error); };
    });
  }

  function openDatabase() {
    if (openPromise) return openPromise;
    openPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('此浏览器不支持 IndexedDB'));
        return;
      }
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (ev) {
        /* 用 ev.target.result 而非闭包里的 request.result：部分实现在
           upgradeneeded 阶段 request.result 尚未就绪 */
        var db = ev.target.result;
        Object.keys(STORES).forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) {
            var store = db.createObjectStore(name, { keyPath: STORES[name][0] });
            STORES[name].slice(1).forEach(function (idx) { store.createIndex(idx, idx); });
          }
        });
        /* v3 升级：补齐 settings 里的 v3 字段（照搬 database.ts 的 upgrade） */
        if (ev.oldVersion < 3) {
          var tx = request.transaction;
          var done = false;
          var finish = function () { if (!done) { done = true; resolve(db); } };
          try {
            var sStore = tx.objectStore('settings');
            var cursorReq = sStore.openCursor();
            cursorReq.onsuccess = function () {
              var cursor = cursorReq.result;
              if (!cursor) { finish(); return; }
              var s = cursor.value || {};
              if (s.uiMode === undefined) s.uiMode = 'game';
              if (s.customTags === undefined || s.customTags.indexOf('vars') !== -1) {
                s.customTags = ['think', 'text', 'options', 'memo', 'events', 'set'];
              }
              if (s.thinkingDisplay === undefined) s.thinkingDisplay = 'fold';
              if (s.formatPromptTemplate === undefined) s.formatPromptTemplate = '';
              if (s.api && s.api.secondary === undefined) {
                s.api.secondary = { enabled: false, baseUrl: '', apiKey: '', model: '' };
              }
              cursor.update(s);
              cursor.continue();
            };
          } catch (e) { finish(); }
          tx.oncomplete = finish;
          tx.onerror = function () { reject(tx.error); };
          return;
        }
      };

      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('IndexedDB 升级被其它标签页阻塞')); };
    }).then(function (db) {
      dbInstance = db;
      return db;
    });
    return openPromise;
  }

  function getDb() {
    if (dbInstance && dbInstance.readyState === 'open') return Promise.resolve(dbInstance);
    return openDatabase();
  }

  /** 单 store 事务。
     注意：IndexedDB 的 request.result 要在 onsuccess 里取，
     且 Promise 只能在 tx.oncomplete 时定案 —— 直接把 IDBRequest
     resolve 出去是不会被自动解包的（这是本层最容易踩的坑）。 */
  function withStore(name, mode, fn) {
    return getDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, mode);
        var result;
        var settled = false;
        var done = function (err, val) {
          if (settled) return;
          settled = true;
          if (err) reject(err); else resolve(val);
        };
        tx.oncomplete = function () { done(null, result); };
        tx.onerror = function () { done(tx.error); };
        tx.onabort = function () { done(tx.error || new Error('事务已中止')); };
        var request;
        try { request = fn(tx.objectStore(name)); }
        catch (e) { done(e); return; }
        if (request) {
          request.onsuccess = function () { result = request.result; };
          request.onerror = function () { done(request.error); };
        }
      });
    });
  }

  /** 多 store 事务（供 importAllData 用） */
  function withStores(names, mode, fn) {
    return getDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(names, mode);
        var settled = false;
        var done = function (err) {
          if (settled) return;
          settled = true;
          if (err) reject(err); else resolve();
        };
        tx.oncomplete = function () { done(null); };
        tx.onerror = function () { done(tx.error); };
        tx.onabort = function () { done(tx.error || new Error('事务已中止')); };
        try { fn(names.reduce(function (acc, n) { acc[n] = tx.objectStore(n); return acc; }, {})); }
        catch (e) { done(e); }
      });
    });
  }

  function all(name) { return withStore(name, 'readonly', function (s) { return s.getAll(); }); }
  function getOne(name, key) { return withStore(name, 'readonly', function (s) { return s.get(key); }); }
  function putOne(name, value) { return withStore(name, 'readwrite', function (s) { return s.put(value); }); }
  function delOne(name, key) { return withStore(name, 'readwrite', function (s) { return s.delete(key); }); }
  function countOf(name) { return withStore(name, 'readonly', function (s) { return s.count(); }); }
  function clearOf(name) { return withStore(name, 'readwrite', function (s) { return s.clear(); }); }

  var DB = {};

  DB.getDatabase = getDb;
  DB.DB_NAME = DB_NAME;
  DB.DB_VERSION = DB_VERSION;

  /* ============================================================
     首次初始化：种入默认预设 + 默认设置（照搬 initializeDatabase）
     ============================================================ */
  DB.initializeDatabase = function () {
    return getDb().then(function () {
      return countOf('presets');
    }).then(function (presetCount) {
      if (presetCount === 0) {
        var C = window.ST_CORE;
        var defaultPreset = C.createDefaultPreset();
        return putOne('presets', Object.assign({}, defaultPreset, {
          id: C.uid(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        })).then(function () { return null; });
      }
      return null;
    }).then(function () {
      return countOf('settings');
    }).then(function (settingsCount) {
      if (settingsCount === 0) {
        var S = window.ST_STATE;
        return putOne('settings', Object.assign({}, S.DEFAULT_SETTINGS, { key: 'settings' }));
      }
      return null;
    });
  };

  /** 整库删除后重建。deleteDatabase 在 indexedDB 上，不在 db 上。 */
  DB.clearAllData = function () {
    return getDb().then(function (db) {
      try { db.close(); } catch (e) {}
      dbInstance = null;
      openPromise = null;
      return new Promise(function (resolve, reject) {
        var del = indexedDB.deleteDatabase(DB_NAME);
        del.onsuccess = function () { resolve(); };
        del.onerror = function () { reject(del.error); };
        del.onblocked = function () { reject(new Error('删除数据库被其它标签页阻塞')); };
      });
    }).then(function () { return openDatabase(); });
  };

  /* ============================================================
     全量备份 / 还原（照搬 exportAllData / importAllData + FullBackup）
     ============================================================ */
  DB.exportAllData = function () {
    return Promise.all([
      all('lorebooks'), all('presets'), all('settings'), all('chats')
    ]).then(function (r) {
      return {
        version: DB_VERSION,
        exportedAt: Date.now(),
        lorebooks: r[0],
        presets: r[1],
        settings: r[2],
        chats: r[3]
      };
    });
  };

  DB.importAllData = function (backup) {
    /* 坏格式走 rejection 而非同步 throw：调用方统一用 .catch 接住 */
    if (!backup || typeof backup !== 'object') return Promise.reject(new Error('备份格式无效'));
    return withStores(['lorebooks', 'presets', 'settings', 'chats'], 'readwrite', function (s) {
      ['lorebooks', 'presets', 'settings', 'chats'].forEach(function (n) { s[n].clear(); });
      if (Array.isArray(backup.lorebooks)) backup.lorebooks.forEach(function (x) { s.lorebooks.put(x); });
      if (Array.isArray(backup.presets)) backup.presets.forEach(function (x) { s.presets.put(x); });
      if (Array.isArray(backup.settings)) backup.settings.forEach(function (x) { s.settings.put(x); });
      if (Array.isArray(backup.chats)) backup.chats.forEach(function (x) { s.chats.put(x); });
    });
  };

  /* ============================================================
     表级 CRUD（函数名与 database.ts 完全一致）
     ============================================================ */
  DB.getLorebooks = function () { return all('lorebooks'); };
  DB.saveLorebook = function (lorebook) {
    return putOne('lorebooks', lorebook).then(function () { return lorebook.id; });
  };
  DB.deleteLorebook = function (id) { return delOne('lorebooks', id); };
  DB.getLorebook = function (id) { return getOne('lorebooks', id); };

  DB.getPresets = function () { return all('presets'); };
  DB.savePreset = function (preset) {
    return putOne('presets', preset).then(function () { return preset.id; });
  };
  DB.deletePreset = function (id) { return delOne('presets', id); };
  DB.getPreset = function (id) { return getOne('presets', id); };

  DB.getSettings = function () {
    return all('settings').then(function (rows) { return rows[0]; });
  };
  DB.saveSettings = function (settings) {
    return putOne('settings', Object.assign({}, settings, { key: 'settings' }));
  };

  DB.getChats = function () { return all('chats'); };
  DB.saveChat = function (chat) {
    return putOne('chats', chat).then(function () { return chat.id; });
  };
  DB.deleteChat = function (id) { return delOne('chats', id); };
  DB.getChat = function (id) { return getOne('chats', id); };

  DB.setVariables = function (chatId, variables) {
    return getOne('chats', chatId).then(function (chat) {
      if (!chat) return null;
      chat.variables = variables;
      chat.updatedAt = Date.now();
      return putOne('chats', chat);
    });
  };

  window.ST_DB = DB;
})();

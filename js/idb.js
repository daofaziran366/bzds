/* ============================================================
   腐化 · IndexedDB 持久化层（存档 / 聊天 / 快照 / 图像 / 设置）
   localStorage → IndexedDB 的统一出口：内存镜像 + 异步直写。
   ============================================================ */
'use strict';

window.IDB = (function () {

  const DB_NAME = 'FushiCorruptionDB';
  const DB_VERSION = 1;
  const STORE = 'kv';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function get(key) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      t.onsuccess = () => resolve(t.result === undefined ? null : t.result);
      t.onerror = () => reject(t.error);
    }));
  }

  function set(key, value) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
      t.onsuccess = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  }

  function del(key) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
      t.onsuccess = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  }

  /* 装载全部键值对 → { key: value } */
  function loadAll() {
    return open().then(db => new Promise((resolve, reject) => {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const vals = store.getAll();
      const keys = store.getAllKeys();
      let v = null, k = null, done = 0;
      const finish = () => {
        if (done < 2) return;
        const map = {};
        (k || []).forEach((key, i) => { map[key] = (v || [])[i]; });
        resolve(map);
      };
      vals.onsuccess = () => { v = vals.result; done++; finish(); };
      vals.onerror = () => reject(vals.error);
      keys.onsuccess = () => { k = keys.result; done++; finish(); };
      keys.onerror = () => reject(keys.error);
    }));
  }

  return { open, get, set, del, loadAll };
})();

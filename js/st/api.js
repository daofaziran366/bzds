/* ============================================================
   腐化 · SillyTavern 集成内核 ⑥ API 层
   ------------------------------------------------------------
   OpenAI 兼容 /chat/completions（SSE 流式）+ 透明代理自动路由
   + 连接测试 + 模型列表 + 可操作的错误诊断
   对应 skill sillytavern-web：
     templates/react/sillytavern/api-router.ts
     templates/react/sillytavern/api-tools.ts
   ============================================================ */
(function () {
  'use strict';

  var API = {};

  /* ============================================================
     1) 地址规范化 / 路由
     ============================================================ */
  API.normalizeBaseUrl = function (url) {
    var u = String(url || '').trim().replace(/\/+$/, '');
    u = u.replace(/\/chat\/completions$/i, '');
    u = u.replace(/\/models$/i, '');
    return u;
  };

  /** 页面经本地服务器打开 → 走同源 /api/proxy 绕开 CORS；否则直连 */
  API.endpointFor = function (baseUrl, path) {
    var base = API.normalizeBaseUrl(baseUrl);
    if (!base) return '';
    var p = path || '/chat/completions';
    var loc = (typeof location !== 'undefined' && location) ? location : {};
    var proto = loc.protocol || '';
    var host = loc.hostname || '';
    var isLocalServer = (proto === 'http:' || proto === 'https:') &&
      (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
    if (isLocalServer) {
      return loc.origin + '/api/proxy?target=' + encodeURIComponent(base) + '&path=' + encodeURIComponent(p);
    }
    return base + p;
  };

  API.buildHeaders = function (cfg) {
    var h = { 'Content-Type': 'application/json' };
    if (cfg && cfg.apiKey) h['Authorization'] = 'Bearer ' + cfg.apiKey;
    return h;
  };

  /* ============================================================
     2) SSE 消费
     ============================================================ */
  function consumeSSE(res, onDelta) {
    return new Promise(function (resolve, reject) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buf = '';
      var full = '';
      var reasoning = '';
      var done = false;

      function pump() {
        reader.read().then(function (r) {
          if (r.done) { resolve(full || reasoning); return; }
          buf += decoder.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === '[DONE]') { done = true; resolve(full || reasoning); return; }
            try {
              var json = JSON.parse(payload);
              var delta = json.choices && json.choices[0] && json.choices[0].delta;
              var dContent = delta && delta.content;
              var dReason = delta && delta.reasoning_content;
              if (dContent) { full += dContent; if (onDelta) onDelta(dContent); }
              else if (dReason) { reasoning += dReason; }
            } catch (e) { /* 不完整 JSON，忽略 */ }
          }
          if (done) return;
          pump();
        }).catch(reject);
      }
      pump();
    });
  }

  /* ============================================================
     3) 错误诊断（可操作提示）
     ============================================================ */
  function describeError(err, url) {
    var msg = String((err && err.message) || err || '');
    if (err && err.name === 'TypeError' && /fetch/i.test(msg)) {
      return '无法连接到 ' + url + '（Failed to fetch）。常见原因：' +
        '① 接口地址填错或服务未启动；' +
        '② 浏览器 CORS 跨域拦截——请用「启动游戏.bat」经 http://localhost:8010 打开（请求会自动走同源代理）；' +
        '③ 页面用 file:// 打开或 https 页面请求 http 接口。';
    }
    return msg;
  }

  /* ============================================================
     4) chatCompletion
     ------------------------------------------------------------
     cfg     : { baseUrl, apiKey, model }
     messages: [{role,content}]
     onDelta : 流式增量回调（传 null → 非流式）
     signal  : AbortSignal
     params  : { temperature, max_tokens, top_p, top_k, frequency_penalty,
                 presence_penalty, rep_pen, stream }
     返回 Promise<string> 完整文本
     ============================================================ */
  API.chatCompletion = function (cfg, messages, onDelta, signal, params) {
    params = params || {};
    cfg = cfg || {};
    var url = API.endpointFor(cfg.baseUrl, '/chat/completions');
    if (!url) return Promise.reject(new Error('未配置接口地址（Base URL）'));

    var useStream = !!(onDelta && params.stream !== false);
    var body = {
      model: cfg.model || 'gpt-4o-mini',
      messages: messages,
      temperature: params.temperature !== undefined ? params.temperature : 0.85,
      /* 4096：推理类模型（DeepSeek R1 等）的思考过程也计入 max_tokens，
         上限太小会把额度全部花在思考上、正文为空。预设/设置未指定时的兜底。 */
      max_tokens: params.max_tokens || 4096,
      stream: useStream
    };
    if (params.top_p !== undefined) body.top_p = params.top_p;
    if (params.top_k !== undefined) body.top_k = params.top_k;
    if (params.top_a !== undefined && params.top_a > 0) body.top_a = params.top_a;
    if (params.min_p !== undefined && params.min_p > 0) body.min_p = params.min_p;
    if (params.frequency_penalty !== undefined) body.frequency_penalty = params.frequency_penalty;
    if (params.presence_penalty !== undefined) body.presence_penalty = params.presence_penalty;
    /* rep_pen(1.0=中性) → OpenAI frequency_penalty 近似映射 */
    if (params.rep_pen !== undefined && params.rep_pen !== 1) {
      body.frequency_penalty = Math.min(2, Math.max(0, (Number(params.rep_pen) - 1) * 1.5));
    }

    return fetch(url, {
      method: 'POST',
      headers: API.buildHeaders(cfg),
      body: JSON.stringify(body),
      signal: signal || undefined
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var detail = '';
          try {
            var j = JSON.parse(t);
            detail = (j.error && (j.error.message || j.error.type)) || j.message || '';
          } catch (e) { detail = t.slice(0, 200); }
          throw new Error('API ' + res.status + (detail ? '：' + detail : ''));
        });
      }
      if (!useStream) {
        return res.json().then(function (data) {
          var c = data.choices && data.choices[0] && data.choices[0].message;
          var txt = (c && c.content) || '';
          /* 推理模型（DeepSeek R1 等）：思考计入 max_tokens，正文可能为空
             而 reasoning_content 有值——回退思考内容，绝不空手而归 */
          if (!txt && c && c.reasoning_content) txt = c.reasoning_content;
          return txt;
        });
      }
      return consumeSSE(res, onDelta);
    }).catch(function (e) {
      /* 用户中止：原样抛出并打标，不要伪装成接口故障 */
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) {
        var ae = new Error('生成已中止');
        ae.aborted = true;
        throw ae;
      }
      throw new Error(describeError(e, url));
    });
  };

  /* ============================================================
     5) 连接测试 / 模型列表
     ============================================================ */
  API.testConnection = function (cfg) {
    return API.chatCompletion(cfg, [
      { role: 'system', content: '只回复两个字符：OK' },
      { role: 'user', content: 'ping' }
    ], null, null, { max_tokens: 8, temperature: 0, stream: false })
      .then(function (reply) { return { ok: true, reply: String(reply || '').slice(0, 50) }; });
  };

  var COMMON_MODELS = [
    { match: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { match: 'moonshot', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
    { match: 'kimi', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
    { match: 'dashscope', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
    { match: 'qwen', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
    { match: 'openai', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'] },
    { match: 'anthropic', models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'] },
    { match: 'gemini', models: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'] }
  ];
  var FALLBACK_MODELS = ['gpt-4o-mini', 'deepseek-chat', 'qwen-plus', 'moonshot-v1-8k'];

  API.fallbackModels = function (baseUrl) {
    var u = String(baseUrl || '').toLowerCase();
    for (var i = 0; i < COMMON_MODELS.length; i++) {
      if (u.indexOf(COMMON_MODELS[i].match) !== -1) return COMMON_MODELS[i].models.slice();
    }
    return FALLBACK_MODELS.slice();
  };

  API.fetchModels = function (cfg) {
    var url = API.endpointFor(cfg && cfg.baseUrl, '/models');
    if (!url) return Promise.resolve({ models: API.fallbackModels(''), source: 'fallback', error: '未填写 Base URL' });
    return fetch(url, { headers: API.buildHeaders(cfg) })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var models = ((data && data.data) || []).map(function (m) { return m && m.id; })
          .filter(Boolean).sort();
        if (models.length) return { models: models, source: 'remote' };
        return { models: API.fallbackModels(cfg.baseUrl), source: 'fallback' };
      })
      .catch(function (e) {
        return { models: API.fallbackModels(cfg && cfg.baseUrl), source: 'fallback', error: String(e && e.message || e) };
      });
  };

  window.ST_API = API;
})();

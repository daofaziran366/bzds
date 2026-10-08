/* ============================================================
   腐化 · SillyTavern 集成内核 ⑤ 输出解析层
   ------------------------------------------------------------
   照搬 skill sillytavern-web：
     templates/react/sillytavern/stream-parser.ts   （流式标签状态机）
     templates/react/sillytavern/variables.ts       （aggregateEvents）

   刻意偏离：旧 <vars> JSON 通道已移除——<set> 标签每个是一条
   变量命令，aggregateEvents 收进 parsed.commands（字符串数组），
   由游戏层 js/vars.js（window.VARS）校验执行。本层不认识命令语法。
   流式与非流式仍走同一条状态机路径。

   产出形状：
     { thinking, text, options: string[], memo, events,
       commands: string[], unknown }
   ============================================================ */
(function () {
  'use strict';

  var C = window.ST_CORE;
  var R = {};

  var PARTIAL_LIMIT = 64;

  /* ============================================================
     1) StreamTagParser（照搬 stream-parser.ts）
     ------------------------------------------------------------
     状态：
       NORMAL      标签外；字符以 raw 事件吐出
       BUFFER_TAG  读到 '<'，累积标签名直到 '>'（超长判定为普通文本）
       TAGGED      透明标签内；字符以 tag-chunk 吐出，嵌套 '<' 重入 BUFFER_TAG
       OPAQUE      thinking/think 内；内部 '<…>' 不再解析，只等 </tag>
     ============================================================ */
  function StreamTagParser(tags, opaqueTags) {
    this.tags = tags || C.DEFAULT_TAGS;
    this.opaqueTags = opaqueTags || C.DEFAULT_OPAQUE_TAGS;
    this.state = 'NORMAL';
    this.prevState = 'NORMAL';
    this.partial = '';
    this.currentTag = '';
    this.currentBuf = '';
    this.optionBuf = '';
    this.events = [];
  }

  StreamTagParser.prototype.feed = function (chunk) {
    this.events = [];
    var s = String(chunk == null ? '' : chunk);
    for (var i = 0; i < s.length; i++) this.consumeChar(s[i]);
    return this.events;
  };

  StreamTagParser.prototype.finish = function () {
    this.events = [];
    if (this.state === 'BUFFER_TAG' && this.partial) {
      this.events.push({ type: 'raw', chunk: '<' + this.partial });
      this.partial = '';
    }
    if (this.state === 'TAGGED' || this.state === 'OPAQUE') {
      if (this.state === 'TAGGED' && this.currentTag === 'options' || this.currentTag === 'option' && this.optionBuf) {
        this.events.push({ type: 'option-line', line: this.optionBuf });
        this.optionBuf = '';
      }
      this.events.push({ type: 'tag-close', tag: this.currentTag, full: this.currentBuf });
      this.currentBuf = '';
      this.currentTag = '';
    }
    this.state = 'NORMAL';
    return this.events;
  };

  StreamTagParser.prototype.consumeChar = function (ch) {
    if (this.state === 'NORMAL') {
      if (ch === '<') { this.prevState = 'NORMAL'; this.state = 'BUFFER_TAG'; this.partial = ''; }
      else this.events.push({ type: 'raw', chunk: ch });
      return;
    }
    if (this.state === 'BUFFER_TAG') {
      if (ch === '>') { this.flushTagBuffer(); return; }
      if (this.partial.length >= PARTIAL_LIMIT) {
        this.events.push({ type: 'raw', chunk: '<' + this.partial + ch });
        if (this.prevState === 'TAGGED' && this.currentTag) {
          this.currentBuf += '<' + this.partial + ch;
        }
        this.partial = '';
        this.state = this.prevState;
        return;
      }
      this.partial += ch;
      return;
    }
    if (this.state === 'OPAQUE') {
      this.currentBuf += ch;
      var closeMarker = '</' + this.currentTag + '>';
      if (this.currentBuf.slice(-closeMarker.length) === closeMarker) {
        var full = this.currentBuf.slice(0, -closeMarker.length);
        this.events.push({ type: 'tag-chunk', tag: this.currentTag, chunk: ch });
        this.events.push({ type: 'tag-close', tag: this.currentTag, full: full });
        this.state = 'NORMAL';
        this.currentBuf = '';
        this.currentTag = '';
      } else {
        this.events.push({ type: 'tag-chunk', tag: this.currentTag, chunk: ch });
      }
      return;
    }
    if (this.state === 'TAGGED') {
      if (ch === '<') { this.prevState = 'TAGGED'; this.state = 'BUFFER_TAG'; this.partial = ''; return; }
      if ((this.currentTag === 'options' || this.currentTag === 'option') && ch === '\n') {
        this.events.push({ type: 'option-line', line: this.optionBuf });
        this.optionBuf = '';
      } else if (this.currentTag === 'options' || this.currentTag === 'option') {
        this.optionBuf += ch;
      }
      this.currentBuf += ch;
      this.events.push({ type: 'tag-chunk', tag: this.currentTag, chunk: ch });
      return;
    }
  };

  StreamTagParser.prototype.flushTagBuffer = function () {
    var tagText = this.partial;
    this.partial = '';
    var isClose = tagText.charAt(0) === '/';
    /* 模型偶尔写出 <text >、< text>、<text lang="zh"> 之类的变体：
       trim 后再取首段，只留纯标签名，其余当未知标签落回正文。 */
    var name = (isClose ? tagText.slice(1) : tagText).trim().split(/\s+/)[0];

    if (isClose) {
      if (this.currentTag && this.currentTag === name) {
        if (this.currentTag === 'options' || this.currentTag === 'option' && this.optionBuf) {
          this.events.push({ type: 'option-line', line: this.optionBuf });
          this.optionBuf = '';
        }
        this.events.push({ type: 'tag-close', tag: this.currentTag, full: this.currentBuf });
        this.currentBuf = '';
        this.currentTag = '';
        this.state = 'NORMAL';
      } else {
        this.events.push({ type: 'raw', chunk: '</' + name + '>' });
        /* 已知标签内出现不匹配的闭标签（模型嵌套/行内标记）：
           原样记入内容并留在原标签内，避免正文从这里被截断。 */
        if (this.prevState === 'TAGGED' && this.currentTag) {
          this.currentBuf += '</' + name + '>';
          this.state = 'TAGGED';
        } else {
          this.state = 'NORMAL';
        }
      }
      return;
    }

    if (this.tags.indexOf(name) === -1) {
      this.events.push({ type: 'raw', chunk: '<' + name + '>' });
      if (this.prevState === 'TAGGED' && this.currentTag) {
        this.currentBuf += '<' + name + '>';
        this.state = 'TAGGED';
      } else {
        this.state = 'NORMAL';
      }
      return;
    }

    /* 已知标签在 <text> 内嵌套打开（模型把 <options>/<memo> 写进正文里）：
       先把已累积的正文作为 text 结算吐出再切换，否则缓冲被覆盖、
       parsed.text 变空，整段正文只能走兜底、嵌套内容随之漏进正文。 */
    if (this.prevState === 'TAGGED' && this.currentTag === 'text' && this.currentBuf.trim()) {
      this.events.push({ type: 'tag-close', tag: 'text', full: this.currentBuf });
    }

    this.currentTag = name;
    this.currentBuf = '';
    this.optionBuf = '';
    this.events.push({ type: 'tag-open', tag: name });
    this.state = (this.opaqueTags.indexOf(name) !== -1) ? 'OPAQUE' : 'TAGGED';
  };

  R.StreamTagParser = StreamTagParser;

  /* ============================================================
     2) aggregateEvents（照搬 variables.ts 的分派骨架；
        <vars> 分支替换为 <set> 命令收集）
     ============================================================ */
  R.aggregateEvents = function (events) {
    var parsed = {
      thinking: '', text: '', options: [], memo: '', events: '',
      commands: [], unknown: {}
    };
    for (var i = 0; i < (events || []).length; i++) {
      var ev = events[i];
      if (ev.type === 'tag-close') {
        if (ev.tag === 'think' || ev.tag === 'thinking') parsed.thinking = ev.full;
        else if (ev.tag === 'text' || ev.tag === 'maintext') {
          /* 嵌套场景可能产生多次 text 结算（合成 close + 真 close）：
             首个非空者生效，避免后者把已恢复的正文冲掉。 */
          if (!parsed.text || !parsed.text.trim()) parsed.text = ev.full;
        }
        else if (ev.tag === 'memo') parsed.memo = ev.full;
        else if (ev.tag === 'sum') parsed.memo = parsed.memo || ev.full;
        else if (ev.tag === 'events') parsed.events = ev.full;
        else if (ev.tag === 'set') {
          /* 每个 <set> 标签 = 一个命令块；标签内允许多行，
             块式（缩进）在此原样保留，交给 vars.js 的 expandBlock 展开。 */
          String(ev.full || '').split('\n').forEach(function (line) {
            if (line.trim()) parsed.commands.push(line.replace(/\s+$/, ''));
          });
        } else if (ev.tag === 'option') {
          /* option-line 事件在下方累积选项 */
        } else {
          parsed.unknown[ev.tag] = ev.full;
        }
      } else if (ev.type === 'option-line') {
        parsed.options.push(ev.line);
      }
    }
    return parsed;
  };

  /** 整段解析：喂给状态机全部文本后 finish + 聚合（流式/非流式同一路径） */


    R.parseText = function (text, tags, opaqueTags) {
    var parser = new StreamTagParser(tags, opaqueTags);
    var events = parser.feed(text || '');
    events = events.concat(parser.finish());
    return R.aggregateEvents(events);
  };

  window.ST_REPLY = R;
})();

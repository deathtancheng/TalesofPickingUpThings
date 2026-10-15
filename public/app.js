/* 爱莉希雅 · 前端逻辑 v3.1：对话优先
 * ------------------------------------------------------------------
 * 对话感的三条实现原则：
 *   1. 助手消息没有气泡——平铺正文，像人说话；用户消息才用气泡
 *   2. 工具调用收进每轮一个「活动块」，平时只占一行摘要，展开才见细节
 *   3. 深度思考默认折叠成一行「已深度思考 N 字」，点开才展开
 * 另有：会话历史（localStorage）、危险工具的行内确认卡、
 *       生成中的回合可以切到别的会话（后台继续、回来接上）。
 */

const $ = (sel) => document.querySelector(sel);
const chat = $('#chat');
const input = $('#input');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const modelSel = $('#modelSel');
const tempRange = $('#tempRange');
const tempVal = $('#tempVal');
const toolToggle = $('#toolToggle');
const statusText = $('#statusText');

// ── 工具函数 ─────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* 行内 markdown：行内代码 / 加粗 / 链接（只放行 http/https） */
function inlineMd(text) {
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]\n]{1,80})\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

/* 块级 markdown：标题 / 列表 / 引用 / 分割线 / 表格 / 围栏代码 */
function renderMd(src) {
  const parts = String(src).split('```');
  let out = '';
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      const nl = p.indexOf('\n');
      const lang = nl >= 0 ? p.slice(0, nl).trim() : '';
      const code = nl >= 0 ? p.slice(nl + 1) : p;
      const id = 'cb' + Math.random().toString(36).slice(2, 8);
      out += `<div class="codeblock" data-raw="${esc(code)}">`
        + `<div class="codeblock-head"><span>${esc(lang || '代码')}</span>`
        + `<button class="codeblock-copy" data-for="${id}">复制</button></div>`
        + `<pre><code id="${id}">${esc(code)}</code></pre></div>`;
      return;
    }
    out += renderBlocks(p);
  });
  return out;
}

function renderBlocks(text) {
  const lines = text.split('\n');
  let html = '';
  let list = null;          // 'ul' | 'ol' | null
  let quote = false;
  let table = false;

  const closeAll = () => {
    if (list) { html += `</${list}>`; list = null; }
    if (quote) { html += '</blockquote>'; quote = false; }
    if (table) { html += '</tbody></table>'; table = false; }
  };

  for (const raw of lines) {
    const ln = raw.trimEnd();
    const t = ln.trim();

    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      closeAll();
      const lv = Math.min(h[1].length, 3);
      html += `<h${lv}>${inlineMd(h[2])}</h${lv}>`;
      continue;
    }
    if (/^(---+|\*\*\*+)$/.test(t)) { closeAll(); html += '<hr>'; continue; }
    if (/^>/.test(t)) {
      if (list) { html += `</${list}>`; list = null; }
      if (table) { html += '</tbody></table>'; table = false; }
      if (!quote) { html += '<blockquote>'; quote = true; }
      html += `<p>${inlineMd(t.replace(/^>\s?/, ''))}</p>`;
      continue;
    }
    // 表格行：| a | b |
    if (/^\|.*\|$/.test(t)) {
      closeListQuote();
      const cells = t.slice(1, -1).split('|').map((c) => c.trim());
      if (/^\|[\s:|-]+\|$/.test(t)) continue;          // 分隔行
      if (!table) {
        html += '<table><tbody>';
        table = true;
        html += `<tr>${cells.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr>`;
        continue;
      }
      html += `<tr>${cells.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`;
      continue;
    }
    const m1 = /^[-*]\s+(.*)$/.exec(t);
    const m2 = /^\d+[.)]\s+(.*)$/.exec(t);
    if (m1 || m2) {
      closeQuoteTable();
      const want = m1 ? 'ul' : 'ol';
      if (list !== want) {
        if (list) html += `</${list}>`;
        html += `<${want}>`;
        list = want;
      }
      html += `<li>${inlineMd((m1 || m2)[1])}</li>`;
      continue;
    }
    if (!t.trim()) { closeAll(); continue; }
    closeAll();
    html += `<p>${inlineMd(t)}</p>`;
  }
  closeAll();
  return html;

  function closeListQuote() {
    if (list) { html += `</${list}>`; list = null; }
    closeQuoteTable();
  }
  function closeQuoteTable() {
    if (quote) { html += '</blockquote>'; quote = false; }
    if (table) { html += '</tbody></table>'; table = false; }
  }
}

// 代码块复制（事件委托，流式渲染出来的按钮也能用）
chat.addEventListener('click', (e) => {
  const btn = e.target.closest('.codeblock-copy');
  if (!btn) return;
  const pre = btn.closest('.codeblock').querySelector('pre');
  navigator.clipboard.writeText(pre.textContent).then(() => {
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  });
});

/* 活动块：每轮一个。头部是摘要行，身体是逐条工具调用 */
function makeActs() {
  const wrap = document.createElement('div');
  wrap.className = 'acts';
  wrap.innerHTML =
    '<div class="acts-head"><span class="gear">⚙</span>'
    + '<span class="acts-sum">准备调用工具…</span><span class="chev">▶</span></div>'
    + '<div class="acts-body"></div>';
  wrap.querySelector('.acts-head').addEventListener('click', () => wrap.classList.toggle('open'));
  return {
    el: wrap,
    body: wrap.querySelector('.acts-body'),
    sum: wrap.querySelector('.acts-sum'),
    items: [],
    start(name, args) {
      const argText = Object.entries(args || {})
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)}`)
        .join(', ');
      const row = document.createElement('div');
      row.className = 'act open';
      row.innerHTML =
        `<div class="act-head"><span class="a-name">${esc(name)}</span>`
        + `<span class="a-args">${esc(argText)}</span>`
        + '<span class="a-state run">运行中…</span></div>'
        + '<pre class="act-out"></pre>';
      row.querySelector('.act-head').addEventListener('click', () => row.classList.toggle('open'));
      this.body.appendChild(row);
      this.items.push(row);
      this.sum.innerHTML = `正在调用 <b>${esc(name)}</b>…`;
      return row;
    },
    end(row, result, ok) {
      if (!row) return;
      const st = row.querySelector('.a-state');
      st.textContent = ok === false ? '失败' : '完成';
      st.className = 'a-state ' + (ok === false ? 'fail' : 'done');
      row.querySelector('.act-out').textContent = String(result || '（无输出）');
    },
    settle() {
      const n = this.items.length;
      if (!n) return;
      const names = {};
      this.body.querySelectorAll('.a-name').forEach((el) => {
        names[el.textContent] = (names[el.textContent] || 0) + 1;
      });
      const brief = Object.entries(names)
        .map(([k, v]) => (v > 1 ? `${esc(k)} ×${v}` : esc(k)))
        .join('、');
      this.sum.innerHTML = `已执行 <b>${n}</b> 次工具 · ${brief}`;
      this.el.classList.remove('open');   // 结束后收起，只留一行摘要
    },
  };
}

/**
 * 逐行读 NDJSON 流。
 * onEvent 可以是 async：confirm_request 必须在这里原地等人类表态。
 */
async function readNdjson(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
    let i;
    while ((i = raw.indexOf('\n')) >= 0) {
      const line = raw.slice(0, i).trim();
      raw = raw.slice(i + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      await onEvent(evt);
    }
  }
}

function setStatus(kind, text) {
  statusText.textContent = text;
  const card = $('#agentCard');
  const title = $('#agentTitle');
  if (card) {
    card.classList.toggle('live', kind === 'busy');
    card.classList.toggle('err', kind === 'err');
  }
  if (title) title.textContent = kind === 'busy' ? '思考中…' : '爱莉希雅';
}

// ── 会话历史（localStorage） ─────────────────────────────
const SESSIONS_KEY = 'hxn.sessions.v1';
let sessions = loadSessions();
let curId = null;
let history = [];      // 当前会话的消息数组（直接引用）

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY)) || []; }
  catch { return []; }
}
function persist() {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 50))); }
  catch { /* 存储满了就算了 */ }
}
function curSession() { return sessions.find((s) => s.id === curId) || null; }

function renderWelcome(head = '你好，我是爱莉希雅 💗', sub) {
  chat.innerHTML = `
    <div class="welcome">
      <h1>${esc(head)}</h1>
      <p>${esc(sub || '模型跑在你自己的电脑上，数据不出本机。我可以搜索网页、读写沙箱文件、执行代码、管理定时任务。')}</p>
      <div class="chips">
        <button class="chip" data-q="上网搜一下：qwen3 一共有哪几个模型尺寸，各自适合什么场景">🔍 搜索：qwen3 模型尺寸</button>
        <button class="chip" data-q="用 run_js 算一下 2026 年还有多少天过完">⌨️ 跑段代码算日期</button>
        <button class="chip" data-q="在沙箱里写一个 notes/plan.md，内容是本周的三条学习计划">📝 写一份计划文件</button>
        <button class="chip" data-q="帮我每天早上 9 点总结一次沙箱 notes 目录里有什么文件">⏰ 建一个每日任务</button>
      </div>
    </div>`;
}

function renderSessions() {
  const box = $('#sessionsList');
  if (!sessions.length) {
    box.innerHTML = '<div class="sess-empty">还没有对话</div>';
    return;
  }
  box.innerHTML = '';
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'sess' + (s.id === curId ? ' on' : '');
    row.innerHTML =
      `<span class="sess-title">${esc(s.title || '新对话')}</span>`
      + '<button class="sess-del" title="删除">✕</button>';
    row.querySelector('.sess-title').addEventListener('click', () => switchSession(s.id));
    row.querySelector('.sess-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeSession(s.id);
    });
    box.appendChild(row);
  }
}

function replaySession(s) {
  chat.innerHTML = '';
  for (const m of s.messages) {
    if (m.role === 'user') addUser(m.content);
    else addAiText(m.content);
  }
  // 这个会话还有正在生成的回合：把它的 DOM 原样接回来，流还在往里写
  if (liveRun && liveRun.sessId === s.id && liveRun.msgEl) {
    chat.appendChild(liveRun.msgEl);
  }
  if (!chat.children.length) renderWelcome();
  chat.scrollTop = chat.scrollHeight;
}

function switchSession(id) {
  if (id === curId) return;
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  curId = id;
  history = s.messages;
  persist();
  renderSessions();
  replaySession(s);
  // 生成中的任务不会被打断：在哪个会话就显示对应状态
  if (liveRun) setStatus('busy', liveRun.sessId === id ? '生成中…' : '后台生成中…');
}

function removeSession(id) {
  if (liveRun && liveRun.sessId === id) {
    liveRun.controller.abort();   // 正在生成的那个先停掉，避免往已删除的会话里写
  }
  sessions = sessions.filter((s) => s.id !== id);
  if (curId === id) {
    if (sessions.length) switchSession(sessions[0].id);
    else newSession(false);
  }
  persist();
  renderSessions();
}

function newSession(callReset = true) {
  const s = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: '新对话', messages: [], at: Date.now() };
  sessions.unshift(s);
  curId = s.id;
  history = s.messages;
  persist();
  renderSessions();
  renderWelcome();
  if (callReset) {
    // 聊天窗跑在 Harness 上：前端重开的同时服务端会话树也重开
    fetch('/api/harness/reset', { method: 'POST' }).catch(() => {});
  }
  return s;
}

// ── 消息渲染 ─────────────────────────────────────────────
function addUser(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble">${inlineMd(text)}</div>`;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

/** 静态渲染一条助手消息（回放历史用） */
function addAiText(text) {
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.innerHTML = '<div class="avatar"></div><div class="content"></div>';
  el.querySelector('.content').innerHTML = renderMd(text);
  chat.appendChild(el);
}

/* 流式中的一轮：全部状态收进 liveRun 对象。
 * 关键设计——生成中的回合属于「会话」而不属于「屏幕」：
 * 用户切到别的会话时，这个回合只是离开视野，流照常接收、
 * 最终回答照常写回原会话的消息数组；切回来时 DOM 原样接回。 */
let liveRun = null;    // { sessId, msgs, controller, msgEl, content, mdEl, buf, finalText, thinkEl, thinkBuf, acts, actsSettled, actRows, actSeq }
let rafPending = false;

function beginTurn(R) {
  const msg = document.createElement('div');
  msg.className = 'msg ai';
  msg.innerHTML = '<div class="avatar"></div><div class="content"></div>';
  R.msgEl = msg;
  R.content = msg.querySelector('.content');
  R.mdEl = null;
  R.buf = '';
  R.finalText = '';
  R.thinkEl = null;
  R.thinkBuf = '';
  chat.appendChild(msg);
}

function ensureMd(R) {
  if (R.mdEl) return R.mdEl;
  R.mdEl = document.createElement('div');
  R.mdEl.className = 'md';
  // 稳定区（已定格，只在增长时渲染一次）+ 活跃尾巴（每帧重画）
  // ——整块 innerHTML 重画会让代码块/列表不断重建而闪烁
  R.stableEl = document.createElement('div');
  R.tailEl = document.createElement('div');
  R.mdEl.append(R.stableEl, R.tailEl);
  R.stableLen = 0;
  R.cbLang = '';
  R.content.appendChild(R.mdEl);
  return R.mdEl;
}

/* 找「定格切点」：最后一个不在 ``` 围栏内的空行。
 * 围栏内不打切点（代码块要整体长在尾巴里），空行天然结束段落/列表/表格 */
function stableCut(buf) {
  let cut = -1, fences = 0, i = 0;
  for (;;) {
    const f = buf.indexOf('```', i);
    let n = buf.indexOf('\n\n', i);
    if (f !== -1 && (n === -1 || f < n)) { fences++; i = f + 3; continue; }
    if (n === -1) break;
    if (fences % 2 === 0) cut = n;
    i = n + 2;
  }
  return cut;
}

function flushRender() {
  rafPending = false;
  const R = liveRun;
  if (!R || !R.mdEl) return;
  const cut = stableCut(R.buf);
  if (cut > R.stableLen) {                       // 稳定区变长：定格渲染一次
    R.stableLen = cut;
    R.stableEl.innerHTML = renderMd(R.buf.slice(0, R.stableLen));
    R.cbLang = '';
  }
  const tail = R.buf.slice(R.stableLen);
  const open = /^```[^\n]*\n?/.exec(tail);       // 尾巴是正在生成的代码块？
  if (open && (tail.match(/```/g) || []).length % 2 === 1) {
    const lang = open[0].trim().slice(3).trim();
    let cb = R.tailEl.querySelector('.codeblock');
    if (!cb || R.cbLang !== lang) {              // 只在建块时重建 DOM，之后只改文本
      R.tailEl.innerHTML = renderMd(tail);
      cb = R.tailEl.querySelector('.codeblock');
      cb.dataset.lang = lang;
      R.cbLang = lang;
    }
    cb.querySelector('code').textContent = tail.slice(open[0].length);
  } else {
    R.cbLang = '';
    R.tailEl.innerHTML = renderMd(tail) + '<span class="caret"></span>';
  }
  if (R.msgEl.isConnected) chat.scrollTop = chat.scrollHeight;   // 切走了就不抢滚动条
}

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(flushRender);
}

// ── 深度思考流：一行折叠的「💭 深思中 · N 字」 ────────────
function ensureThink(R) {
  if (R.thinkEl) return R.thinkEl;
  const wrap = document.createElement('div');
  wrap.className = 'think';
  wrap.innerHTML =
    '<div class="think-head">💭 深思中…</div>'
    + '<div class="think-body"></div>';
  wrap.querySelector('.think-head').addEventListener('click', () => wrap.classList.toggle('open'));
  R.content.insertBefore(wrap, R.content.firstChild);
  R.thinkEl = wrap;
  return wrap;
}

function appendThinking(R, text) {
  if (!text) return;
  ensureThink(R);
  R.thinkBuf += text;
  R.thinkEl.querySelector('.think-head').textContent = `💭 深思中 · ${R.thinkBuf.length} 字`;
  const body = R.thinkEl.querySelector('.think-body');
  body.textContent = R.thinkBuf;
  body.scrollTop = body.scrollHeight;
  if (R.msgEl.isConnected) chat.scrollTop = chat.scrollHeight;
}

function endThinking(R) {
  if (!R.thinkEl) return;
  R.thinkEl.querySelector('.think-head').textContent = `💭 已深度思考 ${R.thinkBuf.length} 字（点击展开）`;
  R.thinkEl = null;
}

// ── 危险工具的行内确认卡 ─────────────────────────────────
function askChatConfirm(info, R) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'confirm-card';
    wrap.innerHTML =
      `<div class="cc-title">⚠️ 需要你的许可</div>`
      + `<div class="cc-body">爱莉希雅想运行 <b><code>${esc(info.name)}</code></b>（${esc(info.levelLabel)}操作）`
      + `<code class="cc-args">${esc(JSON.stringify(info.args).slice(0, 220))}</code></div>`
      + `<div class="cc-actions">`
      + `<button class="cc-btn allow">✓ 允许</button>`
      + `<button class="cc-btn always">本轮总是允许</button>`
      + `<button class="cc-btn deny">✕ 拒绝</button></div>`;
    R.content.appendChild(wrap);
    if (R.msgEl.isConnected) chat.scrollTop = chat.scrollHeight;
    const done = (allow, always) => {
      wrap.remove();
      const note = document.createElement('div');
      note.className = 'cc-note';
      note.textContent = allow ? (always ? `已允许 ${info.name}（本轮）` : `已允许 ${info.name}`) : `已拒绝 ${info.name}`;
      R.content.appendChild(note);
      resolve({ allow, always });
    };
    wrap.querySelector('.allow').onclick = () => done(true, false);
    wrap.querySelector('.always').onclick = () => done(true, true);
    wrap.querySelector('.deny').onclick = () => done(false, false);
  });
}

async function answerChatConfirm(id, allow, always) {
  await fetch('/api/chat/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, allow, always }),
  });
}

// ── 发送 ─────────────────────────────────────────────────
async function send(text) {
  if (!text.trim()) return;
  if (liveRun) {
    // 已有一轮在跑（可能在别的会话后台）。提示而不是静默吞掉。
    const n = document.createElement('div');
    n.className = 'cc-note';
    n.textContent = liveRun.sessId === curId
      ? '上一条还在生成中，等它说完…'
      : '另一个对话还在后台生成中，完成后就能在这里发消息';
    chat.appendChild(n);
    chat.scrollTop = chat.scrollHeight;
    setTimeout(() => n.remove(), 2600);
    return;
  }

  const s = curSession() || newSession(false);
  if (chat.querySelector('.welcome')) chat.innerHTML = '';

  addUser(text);
  s.messages.push({ role: 'user', content: text });
  if (s.title === '新对话') {
    s.title = text.slice(0, 20) || '新对话';
    renderSessions();
  }
  persist();

  // 本轮的所有状态都挂在 R 上：消息数组是原会话的引用，
  // 就算中途切走，回答也一定落回原来的会话
  const R = {
    sessId: s.id,
    msgs: s.messages,
    controller: null,
    msgEl: null, content: null, mdEl: null,
    buf: '', finalText: '',
    thinkEl: null, thinkBuf: '',
    acts: null, actsSettled: false,
    actRows: new Map(), actSeq: 0,
  };
  liveRun = R;

  beginTurn(R);
  R.controller = new AbortController();
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  setStatus('busy', '生成中…');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: R.msgs,
        model: modelSel.value,
        temperature: Number(tempRange.value),
        useTools: toolToggle.checked,
      }),
      signal: R.controller.signal,
    });

    await readNdjson(res, async (evt) => {
      switch (evt.type) {
        case 'thinking':
          appendThinking(R, evt.text);
          break;
        case 'tool_start':
          if (!R.acts) {
            R.acts = makeActs();
            R.content.insertBefore(R.acts.el, R.mdEl);
          } else if (R.actsSettled) {
            R.actsSettled = false;
            R.acts.el.classList.add('open');
          }
          R.actRows.set(R.actSeq++, R.acts.start(evt.name, evt.args));
          break;
        case 'tool_end':
          // 找到最早一个还在「运行中」的活动行
          for (const [seq, row] of R.actRows) {
            const st = row.querySelector('.a-state');
            if (st && st.classList.contains('run')) {
              R.acts.end(row, evt.result, !/^(错误|Error|执行失败)/.test(String(evt.result || '')));
              R.actRows.delete(seq);
              break;
            }
          }
          break;
        case 'confirm_request': {
          const { allow, always } = await askChatConfirm(evt, R);
          await answerChatConfirm(evt.id, allow, always);
          break;
        }
        case 'token':
          if (R.thinkEl && !R.buf) endThinking(R);   // 正文开始，思考行定格
          if (R.acts && !R.actsSettled && R.acts.items.length) {
            R.acts.settle();                          // 正文开始，活动块收成一行摘要
            R.actsSettled = true;
          }
          R.buf += evt.text;
          R.finalText += evt.text;
          ensureMd(R);
          scheduleRender();
          break;
        case 'error':
          ensureMd(R);
          R.buf += `\n\n⚠️ ${evt.message}`;
          flushRender();
          break;
        default:
          break;   // 'done' 等只需走完流
      }
    });

    if (R.buf) {
      R.mdEl.innerHTML = renderMd(R.buf);
      R.msgs.push({ role: 'assistant', content: R.finalText });
      persist();
    }
    if (R.acts) R.acts.settle();
    setStatus('ok', '就绪');
  } catch (err) {
    if (err.name !== 'AbortError') {
      ensureMd(R);
      R.buf += `\n\n⚠️ 请求失败：${err.message}`;
      flushRender();
      setStatus('err', '连接失败');
    } else {
      setStatus('ok', '已停止');
      if (R.buf) {
        R.msgs.push({ role: 'assistant', content: R.buf });
        persist();
      }
    }
  } finally {
    liveRun = null;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    if (R.thinkEl) endThinking(R);
    if (R.msgEl && R.msgEl.isConnected) chat.scrollTop = chat.scrollHeight;
  }
}

// ── 事件绑定 ─────────────────────────────────────────────
sendBtn.addEventListener('click', () => {
  const text = input.value;
  input.value = '';
  autoGrow();
  send(text);
});

stopBtn.addEventListener('click', () => liveRun && liveRun.controller.abort());

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}
input.addEventListener('input', autoGrow);

// 滑杆：把当前值画进 --fill，让轨道左侧显示已选颜色
function paintRange() {
  const min = Number(tempRange.min) || 0;
  const max = Number(tempRange.max) || 100;
  const pct = ((Number(tempRange.value) - min) / (max - min)) * 100;
  tempRange.style.setProperty('--fill', pct + '%');
}
tempRange.addEventListener('input', () => {
  tempVal.textContent = tempRange.value;
  paintRange();
});

// 欢迎屏的建议 chip（事件委托，welcome 会被反复重建）
chat.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  input.value = chip.dataset.q;
  autoGrow();
  sendBtn.click();
});

$('#newChat').addEventListener('click', () => newSession(true));

// ── 视觉面板（YOLO 实时检测） ─────────────────────────────
const visionEl = $('#drawerVision');
const harnessDrawer = $('#drawerHarness');
const driftEl = $('#drift');
const camStream = $('#camStream');
const camFallback = $('#camFallback');
const camStats = $('#camStats');
const camDetections = $('#camDetections');
let visionTimer = null;
let lastSummary = '';

const CAM_HINT = '摄像头服务未启动，先跑：python yolo/camera_server.py';

function renderDetections(items) {
  if (!items || !items.length) {
    camDetections.textContent = '画面中没有检测到目标。';
    return;
  }
  const counts = {};
  for (const d of items) counts[d.label] = (counts[d.label] || 0) + 1;
  camDetections.innerHTML = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="tag">${esc(k)} ×${v}</span>`)
    .join('');
}

async function refreshDetection() {
  try {
    const r = await fetch('/api/camera/detect');
    const j = await r.json();
    if (j.error) {
      camStats.textContent = '摄像头不可用';
      camFallback.textContent = j.error;
      camFallback.classList.add('show');
      return;
    }
    camFallback.classList.remove('show');
    camStats.textContent = `${j.latency_ms} ms · ${j.fps} FPS · ${j.detections.length} 个目标`;
    renderDetections(j.detections);
    lastSummary = j.summary;
  } catch {
    camStats.textContent = '摄像头服务未启动';
    camFallback.textContent = CAM_HINT;
    camFallback.classList.add('show');
  }
}

// ── 抽屉：同一时刻只开一个 ───────────────────────────────
function openDrawer(which) {
  const target = which === 'vision' ? visionEl : harnessDrawer;
  const other = which === 'vision' ? harnessDrawer : visionEl;
  if (!other.hidden) closeDrawer(other === visionEl ? 'vision' : 'harness');
  if (!target.hidden) return;

  target.hidden = false;
  driftEl.classList.add('show');
  requestAnimationFrame(() => target.classList.add('on'));

  const btn = which === 'vision' ? $('#visionToggle') : $('#harnessToggle');
  if (btn) btn.classList.add('on');

  if (which === 'vision') {
    camStream.src = '/api/camera/video?t=' + Date.now();
    refreshDetection();
    visionTimer = setInterval(refreshDetection, 2500);
  } else {
    loadHarnessState();
    loadAutomations();
    loadSkills();
    initModelSelect();
  }
}

function closeDrawer(which) {
  const el2 = which === 'vision' ? visionEl : harnessDrawer;
  if (el2.hidden) return;
  el2.classList.remove('on');
  const btn = which === 'vision' ? $('#visionToggle') : $('#harnessToggle');
  if (btn) btn.classList.remove('on');

  setTimeout(() => {
    if (el2.classList.contains('on')) return;   // 又被打开了，别真关
    el2.hidden = true;
    if (visionEl.hidden && harnessDrawer.hidden) driftEl.classList.remove('show');
  }, 240);

  if (which === 'vision') {
    camStream.removeAttribute('src');
    clearInterval(visionTimer);
    visionTimer = null;
  }
}

const openVision = () => openDrawer('vision');
const closeVision = () => closeDrawer('vision');
const openHarness = () => openDrawer('harness');
const closeHarness = () => closeDrawer('harness');

$('#visionToggle').addEventListener('click', () => (visionEl.hidden ? openVision() : closeVision()));
$('#harnessToggle').addEventListener('click', () => (harnessDrawer.hidden ? openHarness() : closeHarness()));
document.querySelectorAll('.drawer-close').forEach((b) => {
  b.addEventListener('click', () => closeDrawer(b.dataset.close === 'drawerVision' ? 'vision' : 'harness'));
});
driftEl.addEventListener('click', () => { closeVision(); closeHarness(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeVision(); closeHarness(); }
});
$('#btnRefreshDetect').addEventListener('click', refreshDetection);
camStream.addEventListener('error', () => {
  camFallback.textContent = CAM_HINT;
  camFallback.classList.add('show');
});

$('#btnAskVision').addEventListener('click', async () => {
  await refreshDetection();
  input.value = `这是我摄像头当前画面里 YOLO 检测到的内容：${lastSummary || '（没有检测到目标）'}。`
    + `请你据此推断画面可能是什么场景，用两三句中文描述一下，并给一句应景的提醒。`;
  autoGrow();
  sendBtn.click();
});

// ── 初始化 ───────────────────────────────────────────────
(async function init() {
  autoGrow();
  paintRange();
  if (sessions.length) {
    // 回放最近一次会话
    curId = sessions[0].id;
    history = sessions[0].messages;
    renderSessions();
    replaySession(sessions[0]);
  } else {
    newSession(false);
  }
  try {
    const r = await fetch('/api/models');
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    modelSel.innerHTML = j.models
      .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
      .join('');
    const prefer = j.models.find((m) => m.startsWith('qwen3')) || j.models[0];
    if (prefer) modelSel.value = prefer;
    setStatus('ok', j.models.length ? `${j.models.length} 个模型已就绪` : '无模型');
  } catch (err) {
    setStatus('err', 'Ollama 未连接');
    modelSel.innerHTML = `<option value="qwen3:8b">qwen3:8b</option>`;
  }
})();

// ── Agent 面板（Harness 抽屉） ───────────────────────────
const hEl = harnessDrawer;
const hTimeline = $('#hTimeline');
const hState = $('#hState');
const hConfirm = $('#hConfirm');
const hResult = $('#hResult');
const hGoal = $('#hGoal');
const hRun = $('#hRun');
const hAbort = $('#hAbort');

let hRunning = false;

// 时间线里的深度思考行：同一个轮次的 thinking 事件累积到同一行里
let hThinkRow = null;
let hThinkTxt = '';

function hThinking(text) {
  if (!text) return;
  if (!hThinkRow) {
    hThinkRow = document.createElement('div');
    hThinkRow.className = 'h-ev h-think';
    hThinkRow.innerHTML =
      '<span class="lv">💭</span><span class="tag2">深思</span>'
      + '<span class="txt"></span>';
    hTimeline.appendChild(hThinkRow);
    hThinkTxt = '';
  }
  hThinkTxt += text;
  const txt = hThinkRow.querySelector('.txt');
  txt.textContent = hThinkTxt.slice(-400).replace(/\s+/g, ' ');
  txt.title = hThinkTxt.slice(-1200);
  hTimeline.scrollTop = hTimeline.scrollHeight;
}

function hLine(level, tag, text, extra = '') {
  if (hTimeline.querySelector('.h-empty')) hTimeline.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'h-ev';
  const kind = tag === '工具' ? 'tool' : tag === '错误' ? 'err' : tag === '压缩' ? 'warn' : '';
  row.innerHTML =
    `<span class="lv">${esc(level)}</span>`
    + `<span class="tag2 ${kind}">${esc(tag)}</span>`
    + `<span class="txt">${esc(text)}</span>`
    + (extra ? `<span class="ms">${esc(extra)}</span>` : '');
  hTimeline.appendChild(row);
  hTimeline.scrollTop = hTimeline.scrollHeight;
}

async function loadHarnessState() {
  try {
    const j = await (await fetch('/api/harness/state')).json();
    if (j.error) throw new Error(j.error);
    const byLevel = {};
    for (const t of j.tools) byLevel[t.level] = (byLevel[t.level] || 0) + 1;
    hState.innerHTML =
      `模型 <b>${esc(j.model)}</b> · 工作区 <code>${esc(j.root.split(/[\\/]/).pop())}</code><br>`
      + `工具 <b>${j.tools.length}</b> 个（只读 ${byLevel.safe || 0} / 写入 ${byLevel.write || 0} / 危险 ${byLevel.danger || 0}）<br>`
      + `扩展 <b>${j.extensions.map((e) => e.name).join(', ') || '无'}</b><br>`
      + `记忆 ${j.memory ? `<b>${j.memory.facts}</b> 事实 / <b>${j.memory.episodes}</b> 条经历` : '未启用'} · `
      + `会话 <b>${j.session.nodes}</b> 节点`
      + `<div class="chip-line">${j.tools.map((t) => `<span class="tag2">${esc(t.name)}</span>`).join('')}</div>`;
  } catch (err) {
    hState.textContent = 'Harness 装载失败：' + err.message;
  }
}

function askHuman(info) {
  return new Promise((resolve) => {
    $('#hConfirmBody').innerHTML =
      `工具 <code>${esc(info.name)}</code> 属于「${esc(info.levelLabel)}」操作。<br>`
      + `参数：<code>${esc(JSON.stringify(info.args).slice(0, 300))}</code>`;
    hConfirm.hidden = false;
    const done = (allow) => {
      hConfirm.hidden = true;
      resolve(allow);
    };
    $('#hAllow').onclick = () => done(true);
    $('#hDeny').onclick = () => done(false);
  });
}

// ── 模型热切换 ───────────────────────────────────────────
const hModel = $('#hModel');

async function initModelSelect() {
  let current = '';
  try {
    const j = await (await fetch('/api/harness/state')).json();
    current = j.model || '';
  } catch { /* Harness 未就绪也先把列表摆出来 */ }
  try {
    const j = await (await fetch('/api/models')).json();
    const models = j.models || [];
    hModel.innerHTML = (models.length ? models : [current || 'qwen3:8b'])
      .map((m) => `<option value="${esc(m)}">${esc(m)}</option>`)
      .join('');
    if (current && models.includes(current)) hModel.value = current;
  } catch {
    hModel.innerHTML = `<option>${esc(current || 'Ollama 未连接')}</option>`;
  }
}

hModel.addEventListener('change', async () => {
  const model = hModel.value;
  hModel.disabled = true;
  try {
    const j = await (await fetch('/api/harness/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    })).json();
    if (j.error) throw new Error(j.error);
    hLine('·', '模型', `已切换到 ${j.model}（长期记忆与技能不受影响）`);
  } catch (err) {
    hLine('!', '模型', `切换失败：${err.message}`);
  }
  hModel.disabled = false;
  loadHarnessState();
});

// ── 定时任务面板 ─────────────────────────────────────────
const hAutos = $('#hAutos');

function fmtSchedule(s) {
  if (!s) return '?';
  if (s.every_minutes) return `每 ${s.every_minutes} 分钟`;
  if (s.daily) return `每天 ${s.daily}`;
  if (s.once) return `一次性 ${s.once}`;
  return JSON.stringify(s);
}

async function loadAutomations() {
  try {
    const j = await (await fetch('/api/harness/automations')).json();
    if (!j.tasks || !j.tasks.length) {
      hAutos.innerHTML = '<div class="h-empty">还没有定时任务。对它说"每天 9 点帮我查 xx"，或让它用 automation 工具创建。</div>';
      return;
    }
    hAutos.innerHTML = '';
    for (const t of j.tasks) {
      const row = document.createElement('div');
      row.className = 'h-auto' + (t.enabled ? '' : ' off');
      row.innerHTML =
        `<div class="h-auto-main">`
        + `<b>${esc(t.name)}</b> <span class="ms">${esc(fmtSchedule(t.schedule))}</span><br>`
        + `<span class="ms">下次 ${t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'}`
        + ` · 上次 ${t.lastRun ? (t.lastOk ? '✓ 成功' : '✗ 失败') : '未跑过'}</span>`
        + `</div>`
        + `<div class="h-auto-btns">`
        + `<button class="link-btn" data-act="toggle">${t.enabled ? '停用' : '启用'}</button>`
        + `<button class="link-btn" data-act="run_now">立即跑</button>`
        + `<button class="link-btn" data-act="remove">删除</button>`
        + `</div>`;
      row.querySelectorAll('.link-btn').forEach((b) => {
        b.addEventListener('click', async () => {
          await fetch('/api/harness/automations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: b.dataset.act, id: t.id }),
          });
          loadAutomations();
        });
      });
      hAutos.appendChild(row);
    }
  } catch (err) {
    hAutos.textContent = '读取失败：' + err.message;
  }
}

$('#hAutosRefresh').addEventListener('click', loadAutomations);

// ── 技能包面板 ───────────────────────────────────────────
const hSkills = $('#hSkills');
const hSkillMsg = $('#hSkillMsg');

async function loadSkills() {
  try {
    const j = await (await fetch('/api/harness/skills')).json();
    if (!j.skills || !j.skills.length) {
      hSkills.innerHTML = '<div class="h-empty">还没有技能包。粘贴 SKILL.md 网址从网上安装，'
        + '或对它说"把 xxx 的操作方法整理成一个技能"。</div>';
      return;
    }
    hSkills.innerHTML = '';
    for (const s of j.skills) {
      const row = document.createElement('div');
      row.className = 'h-auto';
      row.innerHTML =
        `<div class="h-auto-main"><b>${esc(s.name)}</b><br>`
        + `<span class="ms">${esc(s.description || '（无描述）')}</span></div>`
        + `<div class="h-auto-btns"><button class="link-btn" data-act="remove">删除</button></div>`;
      row.querySelector('.link-btn').addEventListener('click', async () => {
        await fetch('/api/harness/skills/' + encodeURIComponent(s.name), { method: 'DELETE' });
        loadSkills();
      });
      hSkills.appendChild(row);
    }
  } catch (err) {
    hSkills.textContent = '读取失败：' + err.message;
  }
}
$('#hSkillsRefresh').addEventListener('click', loadSkills);

$('#hSkillInstall').addEventListener('click', async () => {
  const v = $('#hSkillUrl').value.trim();
  if (!v) { hSkillMsg.textContent = '先填网址或粘贴 SKILL.md 内容'; return; }
  const payload = /^https?:\/\//i.test(v) ? { url: v } : { content: v };
  const name = $('#hSkillName').value.trim();
  if (name) payload.name = name;
  hSkillMsg.textContent = '安装中…';
  try {
    const r = await fetch('/api/harness/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j.ok) {
      hSkillMsg.textContent = `已安装为「${j.name}」，模型马上就能用`;
      $('#hSkillUrl').value = '';
      $('#hSkillName').value = '';
    } else {
      hSkillMsg.textContent = j.error || '安装失败';
    }
  } catch (err) {
    hSkillMsg.textContent = '安装失败：' + err.message;
  }
  loadSkills();
});

async function answerConfirm(id, allow) {
  await fetch('/api/harness/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, allow }),
  });
}

async function runHarness() {
  const goal = hGoal.value.trim();
  if (!goal || hRunning) return;

  hRunning = true;
  hRun.hidden = true;
  hAbort.hidden = false;
  hResult.hidden = true;
  hTimeline.innerHTML = '';
  hThinkRow = null;
  setStatus('busy', 'Harness 运行中');
  hLine('·', '目标', goal);

  try {
    const res = await fetch('/api/harness/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal }),
    });

    await readNdjson(res, async (evt) => {
      if (evt.type === 'confirm_request') {
        // 关键：这里必须阻塞等待人类表态，agent 那边正挂着等这个答案
        hLine('!', '门禁', `${evt.name} 请求授权（${evt.levelLabel}）`, '等待中');
        const allow = await askHuman(evt);
        await answerConfirm(evt.id, allow);
        hLine('!', '门禁', allow ? `已放行 ${evt.name}` : `已拒绝 ${evt.name}`);
        return;
      }

      switch (evt.type) {
        case 'trace':
          if (evt.phase === 'start') hLine('▶', 'trace', String(evt.goal).slice(0, 60));
          break;
        case 'thinking':
          hThinking(evt.text);
          break;
        case 'automation':
          hLine(evt.ok ? '⏰' : '!', '自动化', `${evt.name}：${evt.summary || (evt.ok ? '完成' : '失败')}`);
          break;
        case 'turn':
          hThinkRow = null; // 新的一轮，思考另起一行
          hLine(`t${evt.turn}`, '轮次', evt.phase === 'start' ? '开始' : evt.final ? '输出最终回答' : '等待下一轮');
          break;
        case 'content':
          if (evt.text) hLine(`t${evt.turn}`, '思考', evt.text.slice(0, 80));
          break;
        case 'tool_call':
          hLine(`t${evt.turn}`, '工具', `调用 ${(evt.call?.function || {}).name}`);
          break;
        case 'tool': {
          if (evt.phase !== 'end') break;
          const flag = evt.ok ? '✓' : evt.blocked ? '⊘' : '✗';
          const out = String(evt.output || '').replace(/\s+/g, ' ').slice(0, 90);
          hLine(`t${evt.turn}`, '工具', `${flag} ${evt.name} — ${out}`, `${evt.ms}ms`);
          break;
        }
        case 'compact':
          hLine(`t${evt.turn}`, '压缩', `上下文压缩至 ${evt.tokens} tokens`);
          break;
        case 'error':
          hLine('!', '错误', evt.message);
          break;
        case 'final':
          showHarnessResult(evt);
          break;
      }
    });
    loadHarnessState();
  } catch (err) {
    hLine('!', '错误', err.message);
  }

  hRunning = false;
  hRun.hidden = false;
  hAbort.hidden = true;
  setStatus('ok', '就绪');
}

function showHarnessResult(r) {
  hResult.hidden = false;
  const metrics =
    `${r.turns} 轮 · ${r.toolCalls} 次工具 · 压缩 ${r.compactions} 次 · ${(r.ms / 1000).toFixed(1)}s`
    + (r.reportPath ? ` · 报告 ${r.reportPath}` : '')
    + (r.aborted ? ' · 已中断' : '');
  hResult.innerHTML =
    `<div class="metric">${esc(metrics)}</div>`
    + (r.error ? `<p style="color:#c2563f">出错：${esc(r.error)}</p>` : '')
    + renderMd(r.text || '（无文本输出）');
}

$('#hClear').addEventListener('click', () => { hTimeline.innerHTML = '<div class="h-empty">已清空。</div>'; });
$('#hReset').addEventListener('click', async () => {
  await fetch('/api/harness/reset', { method: 'POST' });
  hTimeline.innerHTML = '<div class="h-empty">已开启新会话（长期记忆保留）。</div>';
  loadHarnessState();
});
hAbort.addEventListener('click', async () => {
  await fetch('/api/harness/abort', { method: 'POST' });
  hLine('!', '中断', '已请求中断');
});
hGoal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runHarness();
});

/* 爱莉希雅桌宠 v5.3 · 静态原图版
 * ------------------------------------------------------------------
 * 应用户要求：不再做关节纸娃娃动画，直接显示完整的原始立绘
 * （elysia-static.png = 只修掉了水晶弓的干净原图）。
 * 保留的互动：
 *   · 按住拖到任意位置（位置记忆，双击复位）；
 *   · 点她一下 → 说一句爱莉希雅的台词（气泡）。
 * 没有任何关节动作 / 待机动画。
 */
(function () {
  const root = document.getElementById('mascot');
  const drag = document.getElementById('eDrag');
  const lean = document.getElementById('eLean');
  const shadow = document.getElementById('eShadow');
  const state = document.getElementById('eState');
  if (!root || !drag || !lean) return;

  const VER = '5.3.0';
  const CW = 542, CH = 640;               // 素材画布
  const KEY = 'elysiaMascotPos';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ── 静态立绘：单张原图，不再切件 ── */
  lean.style.aspectRatio = CW + ' / ' + CH;
  const img = document.createElement('img');
  img.src = '/public/img/elysia-static.png?v=' + VER;
  img.draggable = false;
  img.alt = '爱莉希雅';
  img.style.cssText = 'width:100%;height:100%;display:block;object-fit:contain;';
  lean.appendChild(img);

  /* ── 拖动（桌宠模式）────────────────────────────────────── */
  function applyPos(x, y) {
    root.classList.add('free');
    root.style.left = clamp(x, 4, innerWidth - 60) + 'px';
    root.style.top = clamp(y, 4, innerHeight - 60) + 'px';
    root.style.bottom = 'auto';
  }
  function applySaved() {
    try {
      const pos = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) applyPos(pos.x, pos.y);
    } catch { /* 坏数据当没存过 */ }
  }
  applySaved();
  addEventListener('resize', () => {
    if (root.classList.contains('free')) {
      applyPos(parseFloat(root.style.left) || 4, parseFloat(root.style.top) || 4);
    }
  });

  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  drag.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    const r = root.getBoundingClientRect();
    if (!root.classList.contains('free')) {
      root.classList.add('free');
      root.style.left = r.left + 'px';
      root.style.top = r.top + 'px';
      root.style.bottom = 'auto';
      ox = r.left; oy = r.top;
    } else {
      ox = parseFloat(root.style.left) || 0;
      oy = parseFloat(root.style.top) || 0;
    }
    sx = e.clientX; sy = e.clientY;
    drag.setPointerCapture(e.pointerId);
    document.body.classList.add('mascot-grabbing');
  });
  drag.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4) moved = true;
    applyPos(ox + e.clientX - sx, oy + e.clientY - sy);
  });
  function endDrag(cancelled) {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('mascot-grabbing');
    if (moved) {
      try {
        localStorage.setItem(KEY, JSON.stringify({
          x: parseFloat(root.style.left), y: parseFloat(root.style.top),
        }));
      } catch { /* 存不了就算了 */ }
    } else if (!cancelled) {
      sayLine();                             // 没拖动 = 点了她一下
      if (state) state.textContent = '点我试试 ✨';
    }
  }
  drag.addEventListener('pointerup', () => endDrag(false));
  drag.addEventListener('pointercancel', () => endDrag(true));
  drag.addEventListener('dblclick', () => {
    try { localStorage.removeItem(KEY); } catch { /* 同上 */ }
    root.classList.remove('free');
    root.style.left = '';
    root.style.top = '';
    root.style.bottom = '';
  });

  /* ── 爱莉希雅的台词（参考崩坏3·往世乐土）────────────────── */
  const LINES = [
    '你好呀，可爱的你～我是爱莉希雅哦',
    '哎呀，被我抓到你在偷偷看我了吗？',
    '无论何时何地，爱莉希雅都会陪在你身边哦',
    '真正的魔法，是为所爱之人绽放的花朵',
    '要一起欣赏这可爱的世界吗？',
    '嘿嘿，是不是又被我迷住了呀？',
    '漂亮的女孩，愿意赏脸跳一支舞吗？',
    '往前走，别回头——我会一直在你身后哦',
    '这份美丽，就是我存在的意义！',
    '累了的话，就把肩膀借我靠一下吧～',
    '送你一朵花，今天也要元气满满哦',
    '粉色的约定，可是永远不会凋谢的',
    '危机的时候，就要相信奇迹呀',
    '不要害怕，把手交给我吧',
    '往世乐土的故事，想听吗？',
    '每一个可爱的灵魂，都值得被记住哦',
    '诶嘿，被你夸奖了，好开心呀',
    '生活已经很苦了，要记得给自己加点甜哦',
    '可爱即是正义！这可是爱莉希雅的专属台词',
    '想我了的话，就戳戳我吧，我一直在哦',
    '今天也想成为照亮你的那束粉色光芒',
    '女孩子的心愿，是要用一生去实现的哦',
  ];
  let lastLine = -1, bubbleTimer = null;
  function sayLine(text) {
    let b = root.querySelector('.e-bubble');
    if (!b) {
      b = document.createElement('div');
      b.className = 'e-bubble';
      root.appendChild(b);
    }
    if (!text) {
      let i;
      do { i = Math.floor(Math.random() * LINES.length); } while (i === lastLine && LINES.length > 1);
      lastLine = i;
      text = LINES[i];
    }
    b.textContent = text;
    b.classList.remove('show');
    void b.offsetWidth;                        // 重置过渡
    b.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => b.classList.remove('show'), 3800);
  }

  if (state) state.textContent = '点我试试 ✨';
})();

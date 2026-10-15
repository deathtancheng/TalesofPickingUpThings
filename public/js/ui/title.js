/**
 * 开场：标题画面
 * ------------------------------------------------------------------
 * GalGame 的规矩——先告诉玩家这是个什么游戏，再让他推门。
 * 开局和「重开一局」都先落在这屏：
 *
 *   推门进阁   接着当前这一局（有存档就是继续，没有就是新的一天）
 *   重开这一局 这一局的进度归零（周目和遗物留着）
 *   回到第一周目 连周目、遗物一起清
 *   更新日志   看看这一版改了什么
 *
 * 这一屏不碰任何规则：它只决定"什么时候开始渲染游戏"。
 */

import { el } from '../dom.js';
import { S } from '../store.js';

/** @type {{onStart?:Function, onNew?:Function, onCycle?:Function, onLog?:Function}|null} */
let handlers = null;
/** 默认动作：重开之后再弹标题屏时只传了 onStart，其余按钮得还在 */
let defaults = {};

/**
 * 把这一局的处境写进标题屏：接着玩的时候玩家得知道自己接的是什么。
 */
function paintNote() {
  const st = S.state;
  if (!el.tsNote) return;
  if (!st) {
    el.tsNote.textContent = '天光有时辰，走得比你想的快。';
    return;
  }
  if (st.over) {
    el.tsNote.textContent = '上一局已经收场了——推门就是新的一局。';
    return;
  }
  const where = st.phase === 'night' ? '妖物正趴在梁上'
    : st.phase === 'hall' ? '人在阁里'
      : `人在旧宅第 ${st.maze ? st.maze.depth : 1} 层`;
  el.tsNote.textContent = `第 ${st.day} 天 · ${where} · 体力 ${st.playerHp}`;
}

function paintLegacy() {
  if (!el.tsLegacy) return;
  const lg = S.legacy;
  const cyc = Math.max(1, Number(S.state && S.state.cycle) || Number(lg && lg.cycle) || 1);
  const bits = [`第 ${cyc} 周目`];
  if (lg && Array.isArray(lg.relics) && lg.relics.length) bits.push(`遗物 ${lg.relics.length} 件`);
  if (lg && lg.bestDays) bits.push(`最好熬到第 ${lg.bestDays} 天`);
  el.tsLegacy.textContent = bits.join(' · ');
}

/**
 * 显示标题屏。
 * @param {{onStart?:Function, onNew?:Function, onCycle?:Function, onLog?:Function}} hs
 */
export function showTitle(hs = {}) {
  if (!el.titleScreen) { if (hs.onStart) hs.onStart(); return; }
  handlers = { ...defaults, ...hs };
  paintNote();
  paintLegacy();
  el.titleScreen.hidden = false;
  // 下一帧再挂 open class，过渡动画才跑得起来
  requestAnimationFrame(() => el.titleScreen.classList.add('open'));
}

/** 收起标题屏，进游戏 */
export function hideTitle() {
  if (!el.titleScreen) return;
  el.titleScreen.classList.remove('open');
  const done = () => { el.titleScreen.hidden = true; };
  setTimeout(done, 420);
}

/** 绑定四个按钮。整个前端只有这里认识它们。
 *  onStart 允许返回 Promise（要先连服务再进游戏的那种）：
 *  异步时收屏的时机由 handler 自己决定——连接失败得留在标题屏重试。 */
export function bindTitle() {
  if (!el.titleScreen) return;
  el.tsStart.onclick = () => {
    if (!handlers || !handlers.onStart) return;
    const r = handlers.onStart();
    if (!(r && typeof r.then === 'function')) hideTitle();
  };
  el.tsNew.onclick = () => { if (handlers && handlers.onNew) handlers.onNew(); };
  el.tsCycle.onclick = () => { if (handlers && handlers.onCycle) handlers.onCycle(); };
  el.tsLog.onclick = () => { if (handlers && handlers.onLog) handlers.onLog(); };
}

/** 标题屏是不是还盖着（键盘/其它入口要知道） */
export function titleOpen() {
  return !!(el.titleScreen && !el.titleScreen.hidden);
}

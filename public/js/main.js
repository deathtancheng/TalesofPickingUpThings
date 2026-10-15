/**
 * 前端组装入口
 * ------------------------------------------------------------------
 * 这个文件只做三件事：
 *   1. 把 store 和渲染绑起来（订阅）
 *   2. 把 DOM 事件绑到对应的动作上
 *   3. 起看门狗、起摄像头轮询、跑启动序列
 *
 * 它不认识任何一条游戏规则，也不自己算任何数值——
 * 伤害、克制、架势、饱食、精神、价钱全在 src/game/rules 里，前端只负责把结果画出来。
 *
 * v4 的按钮分三组，跟三块界面一一对应：
 *   迷宫：四个方向键 / 顺着梯子下去 / 带着东西回阁
 *   阁楼：再出门一趟 / 入夜守阁（阁内的小按钮由 hall.js 自己绑）
 *   夜战：献祭此物 / 咒术 / 说话
 * 其中阁楼那一屏的按钮在这一层绑，是因为它们要"换屏"，属于组装的事。
 */

import { el } from './dom.js';
import { S, set } from './store.js';
import { VERSION } from './version.js';
import { bindRender } from './ui/render.js';
import { startWatchdog, setTurn } from './ui/hud.js';
import { act } from './ui/act.js';
import { travel, doRoom, descend, returnHall, mazeNeedsItem, mazePendingFoe } from './ui/maze.js';
import { backToMaze, goNight } from './ui/hall.js';
import { pollDetect, setManual, startCamFeed } from './ui/offering.js';
import { showChangelog, confirmDialog } from './ui/modal.js';
import { addLog } from './ui/fx.js';
import { startMotes } from './ui/ambience.js';
import { boot, enterGame, resetGame, resetToFirstCycle } from './ui/session.js';
import { showTitle, hideTitle, bindTitle } from './ui/title.js';
import { startClockTicker } from './ui/clock.js';

/** 按钮灰着被点时说明在忙什么——总比"点了没反应"好 */
function noteBusy() {
  const secs = Math.round((Date.now() - (S.busySince || Date.now())) / 1000);
  addLog({
    idx: '×',
    html: secs > 3
      ? `上一步已经跑了 ${secs} 秒还没回（服务卡住了？）。稍等几秒会自动解锁，或刷新页面。`
      : '上一件事还没做完，稍等一下。',
    right: '',
    fresh: true,
  });
}

/** 订阅：store 一变就重画。整个前端只有这一处订阅 */
bindRender();

// ── 献祭 / 递物：同一个按钮，两重身份 ─────────────────────
// 迷宫阶段把东西交给脚下的房间（拾物间收进来、砸妖物）；
// 夜战阶段才是真正的"献祭"，那一次会惊动模型。
el.btnOffer.addEventListener('click', () => {
  if (!S.offering || S.busy) return;
  const o = S.offering;
  const payload = {
    label: o.label,
    conf: o.conf,
    area_ratio: Number((o.ratio * 100).toFixed(1)),
  };
  const phase = S.state && S.state.phase;
  if (phase === 'maze') {
    if (!(mazeNeedsItem() || mazePendingFoe())) return;
    doRoom(payload);
    return;
  }
  if (phase !== 'night') return;
  act({ offering: o });
});

// ── 迷宫：四个方向 ──────────────────────────────────────────
el.mzDpad.addEventListener('click', (ev) => {
  const b = ev.target.closest('.dbtn[data-dir]');
  if (!b || S.busy) return;
  travel(b.dataset.dir);
});

// ── 迷宫：下去 / 回阁 ───────────────────────────────────────
// 忙的时候点击要出声：静默返回 = 玩家以为按钮坏了
el.btnDescend.addEventListener('click', () => { if (!S.busy) descend(); });
el.btnReturn.addEventListener('click', () => {
  if (S.busy) { noteBusy(); return; }
  returnHall();
});

// ── 阁楼：再出门 / 入夜 ─────────────────────────────────────
el.btnBackMaze.addEventListener('click', () => { if (!S.busy) backToMaze(); });
el.btnNight.addEventListener('click', () => { if (!S.busy) goNight(); });

// ── 去向三选一：这一祭想转化成什么（只在夜战里有意义）──────
el.intents.addEventListener('click', (ev) => {
  const b = ev.target.closest('.intent');
  if (!b) return;
  set({ intent: b.dataset.intent }, 'intent');
  el.intents.querySelectorAll('.intent').forEach((x) => x.classList.toggle('on', x === b));
});

// ── 版本号 → 更新日志 ───────────────────────────────────────
el.verChip.textContent = 'v' + VERSION;
el.verChip.addEventListener('click', () => showChangelog(VERSION));
// 直接把更新日志甩给别人看：/game.html#changelog
if (location.hash === '#changelog') showChangelog(VERSION);

// ── 手动举物：没摄像头 / 想演示特定克制关系时的降级入口 ─────
el.mItems.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.m-item');
  if (!btn || S.busy || (S.state && S.state.over)) return;
  setManual(btn);
});

// ── 说话（不消耗祭品，也不限于夜战）────────────────────────
el.btnSay.addEventListener('click', () => {
  const v = el.chat.value.trim();
  if (!v || S.busy) return;
  el.chat.value = '';
  act({ talk: true, prompt: v });
});
el.chat.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnSay.click();
});

// ── 重开 ────────────────────────────────────────────────────
el.btnReset.addEventListener('click', () => resetGame());

// ── 周目：点一下能回到第一周目 ──────────────────────────────
// 「重开一局」动不了周目和遗物（跨局累积，只会往上加），
// 所以周目本身要有个入口能退回去——不然玩到第十周目就再也回不来了。
el.cyclePill.addEventListener('click', async () => {
  if (!S.state || S.busy) return;
  const cyc = Math.max(1, Number(S.state.cycle) || 1);
  const hard = cyc > 1;
  const ok = await confirmDialog({
    title: hard ? '回到第一周目？' : '重开这一局？',
    body: hard
      ? `现在是第 ${cyc} 周目。回去会把周目、已解锁的遗物、通关次数一并清零`
        + `（历次成绩留着），然后从第一周目重新开始。`
      : '现在就是第一周目。这里只会重开一局，把这一局的进度丢掉。',
    yes: hard ? '回到第一周目' : '重开一局',
    no: '再想想',
  });
  if (!ok) return;
  if (hard) resetToFirstCycle();
  else resetGame();
});

/** boot 带超时：超时/失败都返回 false，绝不卡住启动序列。
 *  v4.9.1 的教训：bindTitle 曾排在 await boot() 之后，服务没就绪时
 *  标题屏四个按钮一个都绑不上——「按键按不了了」就是这么来的。 */
function bootWithin(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    boot()
      .then(() => { clearTimeout(timer); resolve(true); })
      .catch((err) => {
        console.warn('[boot] 没连上：', err);
        clearTimeout(timer);
        resolve(false);
      });
  });
}

/** 启动。由 public/game.js 调一次 */
export async function start() {
  startMotes(document.getElementById('motes'));  // 纯装饰，先跑起来
  startWatchdog();      // 兜底解锁，防「点不动了」
  bindTitle();          // 标题屏按钮先绑：boot 卡住/失败也能点（v4.9.1 修复）
  pollDetect();         // 摄像头轮询自循环，失败也只是把取景框标灰
  startClockTicker();   // 时辰秒表：本地自己走，时间到由后端翻页
  startCamFeed();       // 取景框画面：MJPEG 优先，不动就自动换快照
  setTurn('player');

  // boot 失败不再是死局：标题屏照常亮，推门时自动重试
  const bootOk = await bootWithin(12000);

  // ?play=1 可以直接进游戏（截图 / 调试用）。
  const jump = new URLSearchParams(location.search).has('play');
  if (jump) {
    if (!bootOk) {
      await boot().catch((err) => {
        const box = document.getElementById('speech');
        if (box) box.textContent = '起不来：' + err.message + '（确认 server.js 与 camera_server.py 都在跑）';
      });
    }
    if (S.state) enterGame();
    return;
  }
  showTitle({
    onStart: async () => {
      if (!S.state) {
        el.tsNote.textContent = '正在连接服务……';
        const ok = await bootWithin(20000);
        if (!ok) {
          el.tsNote.textContent = '连不上服务——确认 server.js 在跑，再点一次「推门进阁」重试。';
          return;   // 留在标题屏，按钮还能再点
        }
      }
      hideTitle();
      enterGame();
    },
    onNew: () => resetGame(),
    onCycle: () => resetToFirstCycle(),
    onLog: () => showChangelog(VERSION),
  });
}

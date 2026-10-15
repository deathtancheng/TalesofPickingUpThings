/**
 * 通用 HUD：忙锁、回合指示、妖物攻击演出
 * ------------------------------------------------------------------
 * v4 把「五层进度点」整块删掉了——那一排点已经被顶栏的「第 N 天」取代
 * （存活天数才是肉鸽的成绩）。这里只留下三样通用的东西。
 *
 * 忙锁是这个文件最要紧的东西：任何一个请求发出去都要 setBusy(true)，
 * 回来一定要 setBusy(false)。历史上「献祭一次之后就再也点不动」
 * 就是某条路径漏了解锁，所以除了 try/finally 之外还有一道看门狗兜底。
 *
 * 注意：忙锁**不去动献祭按钮**。按钮的可用条件依赖当前阶段和脚下房间，
 * 那是 offering.js 的判断；这里只管把 busy 写进 store，
 * render.js 收到 'busy' 变化后会调 syncOfferButton()。这样就不会
 * hud ↔ offering ↔ maze 相互 import 成环。
 */

import { el } from '../dom.js';
import { S, set } from '../store.js';
import { bump, centerOf, floatDamage, flash, heroFlinch, logConnError } from './fx.js';

/**
 * 所有「一次普通请求」的统一外壳：忙就不重入 → 上锁 → 跑 → 解锁。
 *
 * 以前这段骨架在每个动作函数里各抄一遍（maze 四个、hall 三个），
 * 抄漏一个 finally 就是「点一次之后就再也点不动」。收成一处之后，
 * 漏解锁在结构上不再可能发生 —— 这也是这个文件存在的理由。
 *
 * @param {() => Promise<any>} run 真正干活的部分（发请求 + 写 store + 记流水）
 */
export async function guard(run) {
  if (S.busy) return;
  setBusy(true);
  try {
    await run();
  } catch (err) {
    logConnError(err.message);
  } finally {
    setBusy(false);
  }
}

/** 锁/解锁所有会发请求的按钮 */
export function setBusy(on) {
  if (on) S.busySince = Date.now();
  set({ busy: on }, 'busy');       // ← render.js 收到后会去同步献祭按钮
  if (el.btnSay) el.btnSay.disabled = on;
  if (el.hDot) el.hDot.className = 'dot' + (on ? ' busy' : '');
  if (el.hStat) el.hStat.textContent = on ? '阁里正在裁定……' : 'Harness 待命';
  if (!on) setTurn('player');      // 解锁 = 轮到玩家
}

/** 回合指示：谁在动 */
export function setTurn(who, note) {
  if (!el.turnBanner) return;
  const enemy = who === 'enemy';
  el.turnBanner.classList.toggle('enemy', enemy);
  el.turnLabel.textContent = enemy ? '妖物的回合' : '你的回合';
  el.turnNote.textContent = note || (enemy ? '它在蓄势' : '举起东西');
}

/**
 * 取景框开合。
 * 摄像头不该常驻在画面里——它只在"要献东西"的时候才有意义
 * （夜战、或者走进一个等你举物的房间）。其余时候收起来，视线留给地图和阁楼。
 */
export function setCam(on) {
  if (!document.body) return;
  document.body.classList.toggle('cam-open', !!on);
}

/**
 * 妖物攻击演出：前扑 → 墨弹飞向旅人 → 血条受击。
 * 墨弹落地时玩家才受击——「顺序感」比「同时发生」重要得多。
 */
export function enemyAttack(o) {
  if (!el.guardianBox || !o || o.counter <= 0) return;
  setTurn('enemy', o.special ? '蓄力重击！' : '它反手一击');
  el.guardianBox.classList.remove('attack');
  void el.guardianBox.offsetWidth;
  el.guardianBox.classList.add('attack');

  const from = centerOf(el.gPortrait || el.guardianBox);
  const to = el.pBarWrap ? centerOf(el.pBarWrap) : from;
  const b = el.bolt;
  b.className = 'bolt' + (o.special ? ' special' : '');
  b.style.left = from.x - 9 + 'px';
  b.style.top = from.y - 9 + 'px';
  b.style.setProperty('--tx', (to.x - from.x) + 'px');
  b.style.setProperty('--ty', (to.y - from.y) + 'px');
  void b.offsetWidth;
  b.classList.add('fly');

  if (o.special) bump(el.pBarWrap, 'hit');
  setTimeout(() => {
    bump(el.pBarWrap, 'hit');
    heroFlinch();   // 墨弹落地：挨打的是主角，左边的立绘得晃一下（v4.5.3）
    floatDamage(`-${o.counter}`, to.x - 20, to.y, 'counter');
    flash('red');
    setTimeout(() => setTurn('player'), 700);
  }, 480);
}

/**
 * 看门狗：万一哪条路径漏了解锁（流挂死、异常没兜住），
 * 忙超过 45 秒就强制恢复可点，附带一句"哪一步卡住了"的提示。
 * 45 秒是权衡出来的：正常的夜战回合约 30-60 秒（模型在写叙事），
 * 但那些走的是 /act 的流、按钮本来就有 180 秒的独立超时；
 * 到这里还锁着的都是普通请求，早该回来了。
 */
export function startWatchdog(seconds = 45) {
  setInterval(() => {
    if (S.busy && Date.now() - S.busySince > seconds * 1000) {
      setBusy(false);
      el.speech.textContent = '（刚才那一步卡住了，按钮已经解开。可以再点一次，或者重开一局。）';
    }
  }, 2000);
}

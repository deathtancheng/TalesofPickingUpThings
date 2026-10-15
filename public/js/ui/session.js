/**
 * 一局的开始与结束（v4：迷宫 / 阁楼 / 夜战 三阶段）
 * ------------------------------------------------------------------
 * 重开要清干净的东西比想象中多：流水、战报、上一局的房间卡片、
 * 胜负特效、上一局的血量记忆（不然新一局满血会被当成"回血"闪一下）、
 * 以及上一局的结算（绝不能留到下一局）。
 *
 * v4 的一局不再有「开场白要等模型」这一步：模型只在夜战出场。
 * 白天（迷宫 + 阁楼）整条链路是毫秒级的纯规则，一进页面就该能玩，
 * 不该为了听一句寒暄先干等十几秒。
 */

import { el } from '../dom.js';
import { S, set } from '../store.js';
import { getState, postReset } from '../net/api.js';
import { setBusy, setTurn } from './hud.js';
import { loadLegacy } from './stance.js';
import { resetSpeech } from './act.js';
import { clearManual } from './offering.js';
import { subscribeState } from '../net/stream.js';
import { renderAll } from './render.js';
import { showEnding } from './modal.js';
import { showTitle } from './title.js';

/** 拉一次完整局面并写进 store */
export async function fetchState() {
  const j = await getState();
  if (!j.ok) throw new Error(j.error || '取不到局面');
  set({
    state: j.state,
    guardian: j.guardian || null,
    elements: j.elements || {},
    // 物件名 → 属性：手动举物要用它标属性，后端推什么就是什么
    labelElement: j.labelElement || {},
  }, 'state');
  return j;
}

/** 清掉跟"上一局"有关的前端界面态 */
function clearLocal() {
  clearManual();
  resetSpeech();
  Object.assign(S, {
    round: 0,
    winReport: null,
    room: null,
    sceneAt: null,
    sceneClosed: false,
    prev: { gHp: null, pHp: null, phase: null, atk: null, portraitLv: null, label: null, day: null },
  });
  if (el.endingFx) el.endingFx.className = 'ending-fx';
  if (el.endSeal) el.endSeal.textContent = '';
}

/**
 * 重开一局。
 * 跨局的周目/遗物不会被动——那是 legacy.json，重开只会往上加。
 * 想回到第一周目，得走 resetToFirstCycle()。
 */
export async function resetGame() {
  setBusy(true);
  el.speech.textContent = '阁门重新开启……';
  el.log.innerHTML = '';
  clearLocal();
  try {
    await postReset(false);
    await fetchState();
    await loadLegacy();   // 重开可能解锁了新遗物，遗物栏要跟上
  } catch (err) {
    // 重开失败（多半是服务没跑）也要把界面解卡，别让玩家面对一排灰按钮
    el.speech.textContent = '重开失败：' + err.message + '（服务可能没在跑，双击 game.bat）';
    return;
  } finally {
    setBusy(false);
  }
  // v4.5：重开之后回到标题画面——新的一局该有个"开始"的动作，
  // 也顺便让玩家看清自己是第几周目、带着几件遗物。
  showTitle({ onStart: enterGame });
}

/**
 * 回到第一周目。
 * 「重开一局」动不了周目和遗物（那是跨局累积的，只会往上加），
 * 所以单开一个出口：周目、遗物、通关次数清零，历次成绩保留。
 */
export async function resetToFirstCycle() {
  setBusy(true);
  el.speech.textContent = '把阁里的旧账都翻过去了……';
  el.log.innerHTML = '';
  clearLocal();
  try {
    await postReset(true);
    await fetchState();
    await loadLegacy();
  } catch (err) {
    el.speech.textContent = '回到第一周目失败：' + err.message;
    return;
  } finally {
    setBusy(false);
  }
  showTitle({ onStart: enterGame });
}

/**
 * 启动序列。
 * 顺序有讲究：先拿局面 → 挂遗物 → 订阅推送。
 * 订阅必须早于任何玩家操作，否则后端推来的局面会被本地的旧快照盖回去。
 *
 * v4.5：这里**不直接铺第一屏**了——先停在标题画面，等玩家推门。
 * 铺屏的动作挪到 enterGame()，由标题屏那个按钮来叫。
 */
export async function boot() {
  if (bootDone) return;   // 幂等：start() 超时后台跑完的那次不能重复订阅
  await fetchState();
  await loadLegacy();     // 遗物是跨局的，一进页面就该挂上
  subscribeState();       // 后端之后推什么都直接进 store
  bootDone = true;
}
let bootDone = false;

/** 推门进阁：把这一局铺到屏幕上 */
export function enterGame() {
  renderAll('boot');

  const { state } = S;
  greet();
  if (state.over) {
    // 上一局是死在夜里的——刷页面时把结算补回给玩家看
    setTimeout(() => showEnding(), 400);
  }
  setTurn('player');
}

/** 按阶段铺一句开场旁白。不惊动模型——模型只在夜战出场 */
function greet() {
  const state = S.state;
  if (!state || !el.speech) return;
  if (state.over) {
    el.speech.textContent = '这一局已经结束了。点右上角「重开一局」。';
    return;
  }
  // 脚下就是一间还没处理的房间时别开口——舞台已经把这格的话说完了，
  // 开场白会把它盖掉（v4.4 舞台常驻后暴露的）。
  const here = state.maze && state.maze.here;
  if (here && here.blocking) return;
  if (state.phase === 'maze') {
    el.speech.textContent = '阁门在你身后合上了。走一格，揭一片——想回去，得先找到标着「歇」的那间。';
  } else if (state.phase === 'hall') {
    el.speech.textContent = '阁里静着。货仓、祭坛、丹房，都等你打理。';
  } else if (state.phase === 'night') {
    const b = S.guardian || (state.night || null);
    el.speech.textContent = b
      ? `${b.name} 顺着阁墙爬上来，在梁上停住了。举东西砸它。`
      : '夜还没过去，梁上有东西在动。';
  }
}

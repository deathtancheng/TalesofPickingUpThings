/**
 * 万物阁（白天的经营界面）
 * ------------------------------------------------------------------
 * 四块：营造（盖房）、货仓（卖 / 炼）、精怪（喂 / 送走）、日常（吃 / 睡 / 悟）。
 *
 * 这一屏是「策略」的落点：铜钱只有一份，盖丹房还是盖祭坛，
 * 今晚之前必须选一个。数值和价格全部由后端算好塞在 state.hall 里，
 * 前端只是把按钮排出来——连"下一级多少钱"都不在这里算。
 */

import { el } from '../dom.js';
import { S, set } from '../store.js';
import { postHall, postNight, postLeave } from '../net/api.js';
import { guard } from './hud.js';
import { addLog } from './fx.js';

const ELE_CN = {
  wood: '木', fire: '火', earth: '土', metal: '金', water: '水',
  volt: '电', life: '活', lore: '知', guard: '护', unknown: '?',
};

export function renderHall() {
  const st = S.state;
  if (!st || !st.hall) return;

  el.hlTitle.textContent = st.hall.title || '一间空阁';
  el.hlCoin.textContent = st.coin || 0;
  el.hlStoreCap.textContent = `${(st.store || []).length} / ${st.storeCap}`;
  el.hlSpiritCap.textContent = `${(st.spirits || []).length} / ${st.spiritSlots}`;

  renderFacilities(st);
  renderStore(st);
  renderSpirits(st);
  renderDaily(st);
}

/* ── 营造 ───────────────────────────────────────────────────── */

function renderFacilities(st) {
  const list = (st.hall && st.hall.facilities) || [];
  el.hlFacilities.innerHTML = list.map((f) => {
    const afford = !f.maxed && (st.coin || 0) >= (f.cost || 0);
    const cls = ['fac'];
    if (f.lv > 0) cls.push('built');
    if (f.maxed) cls.push('maxed');
    if (!f.maxed && !afford) cls.push('poor');
    const right = f.maxed ? '<small>已满</small>'
      : `<small>${f.cost} 文</small>`;
    return `<button class="${cls.join(' ')}" data-build="${f.id}" ${f.maxed ? 'disabled' : ''}>`
      + `<span class="fi">${f.icon}</span>`
      + `<span class="fn">${f.name}<i>${f.lv}/${f.max}</i></span>`
      + right
      + `<span class="fd">${f.desc}</span>`
      + '</button>';
  }).join('');
  el.hlFacilities.querySelectorAll('[data-build]').forEach((b) => {
    b.onclick = () => act('build', b.dataset.build);
  });
}

/* ── 货仓 ───────────────────────────────────────────────────── */

function renderStore(st) {
  const store = st.store || [];
  const hasAltar = (st.spiritSlots || 0) > 0;
  if (!store.length) {
    el.hlStore.innerHTML = '<div class="hl-empty">仓库是空的。出门拾几件回来。</div>';
    return;
  }
  el.hlStore.innerHTML = store.map((it) => (
    `<div class="item" title="${it.name}">
       <span class="ie ie-${it.element}">${ELE_CN[it.element] || '?'}</span>
       <span class="in">${it.label}<i>品质 ${it.quality}</i></span>
       <div class="ia">
         <button class="mini" data-sell="${it.id}">卖 ${it.price}</button>
         <button class="mini" data-melt="${it.id}" ${hasAltar ? '' : 'disabled'} title="${hasAltar ? '在祭坛上炼成精怪' : '要先盖祭坛'}">炼</button>
       </div>
     </div>`
  )).join('');
  el.hlStore.querySelectorAll('[data-sell]').forEach((b) => {
    b.onclick = () => act('sell', b.dataset.sell);
  });
  el.hlStore.querySelectorAll('[data-melt]').forEach((b) => {
    b.onclick = () => act('melt', b.dataset.melt);
  });
}

/* ── 精怪 ───────────────────────────────────────────────────── */

function renderSpirits(st) {
  const list = st.spirits || [];
  const slots = st.spiritSlots || 0;
  if (!slots) {
    el.hlSpirits.innerHTML = '<div class="hl-empty">还没有祭坛，养不了精怪。</div>';
    return;
  }
  if (!list.length) {
    el.hlSpirits.innerHTML = '<div class="hl-empty">货仓里挑一件，点「炼」就能化出精怪。</div>';
    return;
  }
  const traits = {
    burn: '每回合灼烧', heal: '每回合回气', bind: '削弱反击', ward: '减免伤害',
    edge: '献祭加伤', haste: '偶尔抢一下', shield: '每夜挡首击', insight: '看破架势',
    vigor: '夜里回精神', misc: '杂学',
  };
  el.hlSpirits.innerHTML = list.map((sp) => (
    `<div class="spirit">
       <span class="ie ie-${sp.element}">${ELE_CN[sp.element] || '?'}</span>
       <span class="in">${sp.name}<i>${sp.lv} 级 · ${traits[sp.trait] || sp.trait}</i></span>
       <div class="ia">
         <button class="mini" data-feed="${sp.id}">喂</button>
         <button class="mini ghost" data-release="${sp.id}">送走</button>
       </div>
     </div>`
  )).join('');
  el.hlSpirits.querySelectorAll('[data-feed]').forEach((b) => {
    b.onclick = () => act('feed', b.dataset.feed);
  });
  el.hlSpirits.querySelectorAll('[data-release]').forEach((b) => {
    b.onclick = () => act('release', b.dataset.release);
  });
}

/* ── 日常 ───────────────────────────────────────────────────── */

function renderDaily(st) {
  const used = (st.hall && st.hall.used) || {};
  const h = st.hall || {};
  const coin = st.coin || 0;
  const incMax = st.incenseMax || 0;
  const inc = st.incense || 0;
  const items = [
    { id: 'eat', name: '进食', desc: h.kitchenHeal ? `+${h.kitchenHeal} 饱食` : '要有丹房', ok: !!h.kitchenHeal && !used.eat },
    { id: 'sleep', name: '歇息', desc: h.bedchamberHeal ? `+${h.bedchamberHeal} 精神` : '要有卧房', ok: !!h.bedchamberHeal && !used.sleep },
    // 添香：把铜钱换成"今晚还能献几次"。这是夜战唯一的弹药补给
    {
      id: 'incense',
      name: '添香',
      desc: h.incenseQuota
        ? `${h.incensePrice} 文一炷 · 今天还能添 ${h.incenseQuota} 炷（${inc}/${incMax}）`
        : '要有祭坛才能供香',
      ok: !!h.incenseQuota && coin >= (h.incensePrice || 0) && inc < incMax,
    },
    { id: 'study', name: '参悟', desc: h.studyTimes ? `今天还可悟 ${Math.max(0, h.studyTimes - (used.study || 0))} 次` : '要有书斋', ok: !!h.studyTimes && (used.study || 0) < h.studyTimes },
  ];
  el.hlDaily.innerHTML = items.map((it) => (
    `<button class="daily" data-daily="${it.id}" ${it.ok ? '' : 'disabled'}>`
    + `<b>${it.name}</b><small>${it.desc}</small></button>`
  )).join('');
  el.hlDaily.querySelectorAll('[data-daily]').forEach((b) => {
    b.onclick = () => act(b.dataset.daily);
  });
}

/* ══════════════════════════════════════════════════════════════
   动作
   —— 共用 hud.js 的 guard()（忙锁 + 断连兜底），本体只做两件事：
      发请求、把结果记一笔。
   ══════════════════════════════════════════════════════════════ */

function act(action, id) {
  return guard(async () => {
    const j = await postHall(action, id);
    if (j.state) set({ state: j.state }, 'hall');
    if (j.msg) addLog({ idx: j.ok ? '阁' : '×', html: j.msg, right: '', fresh: j.ok });
  });
}

/** 再出门一趟：从阁回到迷宫（还是刚才那张图，刚记住的路不白记） */
export function backToMaze() {
  return guard(async () => {
    const j = await postLeave();
    if (j.state) set({ state: j.state, room: null }, 'back');
  });
}

/** 入夜 */
export function goNight() {
  return guard(async () => {
    const j = await postNight();
    // 顺手把 guardian 一起写进去：无头快照/关掉 SSE 时也能立刻画出妖物
    if (j.state) set({ state: j.state, guardian: j.beast || null, room: null }, 'night');
    if (j.beast) addLog({ idx: '夜', html: `<b>${j.beast.name}</b> 顺着阁墙爬上来了。`, right: '守夜' });
    if (!j.ok && j.msg) addLog({ idx: '×', html: j.msg, right: '' });
  });
}

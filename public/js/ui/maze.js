/**
 * 旧宅迷宫（白天的主界面）
 * ------------------------------------------------------------------
 * 随机房间 + 迷雾：只看得见自己周围一圈，走一步揭开一格。
 *
 * v4.1 起这一屏有了「场景层」：走进妖物、拾物处、神龛、箱笼、商贩、
 * 歇脚处这些**有事发生的房间**，会先弹出一屏过场（一张场景图 + 旁白 + 选项），
 * 处理完才能合上继续走。普通空房不打断玩家——那是走路，不是事件。
 *
 * 三条硬规矩（都是被玩家钻空子逼出来的）：
 *   1. 非普通房间没处理完，不许走 —— 后端 walk() 会拒，前端也把方向键按住
 *   2. 妖物房没有"绕开"选项 —— 进去就得打散它，遇妖才算遇妖
 *   3. 陷阱在图上和空房长得一模一样 —— 看得见的陷阱不叫陷阱
 *
 * 这个文件只管「画地图 / 弹场景 / 把点击变成一次请求」，
 * 房间里面发生什么全在后端裁决，前端一个字都不算。
 */

import { el } from '../dom.js';
import { S, set } from '../store.js';
import { postTravel, postRoom, postDescend, postReturn } from '../net/api.js';
import { guard, setCam } from './hud.js';
import { addLog } from './fx.js';

const DIR_CN = { up: '上', down: '下', left: '左', right: '右' };

/** 房间类型的色调，用来给格子配色 */
const TONE = {
  start: 'gate', stair: 'gate', item: 'good', chest: 'good', rest: 'good',
  foe: 'bad', trap: 'bad', shrine: 'odd', shop: 'odd', empty: 'plain',
  doctor: 'odd', bard: 'odd', hermit: 'gold',
};

/** 会弹场景的房间：除普通格（空房/阁门/楼梯）以外的全部
 *  art：这张房的场景图（水墨奇幻风，public/assets/scene/ 下）
 *  没有图的房型会退回 tone 渐变——图是锦上添花，不是依赖 */
const SCENE = {
  item:   { tone: 'good', mark: '拾', name: '拾物处', art: 'assets/scene/item.jpg' },
  foe:    { tone: 'bad',  mark: '妖', name: '妖物',   art: 'assets/scene/foe.jpg' },
  trap:   { tone: 'bad',  mark: '阱', name: '陷阱',   art: 'assets/scene/trap.jpg' },
  chest:  { tone: 'gold', mark: '箱', name: '箱笼',   art: 'assets/scene/chest.jpg' },
  shrine: { tone: 'odd',  mark: '龛', name: '神龛',   art: 'assets/scene/shrine.jpg' },
  shop:   { tone: 'odd',  mark: '贩', name: '行脚商', art: 'assets/scene/shop.jpg' },
  forge:  { tone: 'gold', mark: '炉', name: '熔炉间', art: 'assets/scene/forge.jpg' },
  mirror: { tone: 'odd',  mark: '镜', name: '铜镜间', art: 'assets/scene/mirror.jpg' },
  guest:  { tone: 'good', mark: '宿', name: '借宿',   art: 'assets/scene/guest.jpg' },
  // v4.5.1：三个会跟你打交道的 NPC
  // v4.5.3：不再借行脚商/借宿/铜镜间的图——各给各的场景，
  // 不然走进郎中家看见的是行脚商的摊子，场景全撞车。
  doctor:  { tone: 'odd',  mark: '医', name: '游方郎中', art: 'assets/scene/doctor.jpg' },
  bard:    { tone: 'odd',  mark: '谈', name: '说书人',   art: 'assets/scene/bard.jpg' },
  hermit:  { tone: 'gold', mark: '隐', name: '传功人',   art: 'assets/scene/hermit.jpg' },
  rest:   { tone: 'good', mark: '歇', name: '歇脚处', art: 'assets/scene/rest.jpg' },
};


/* ══════════════════════════════════════════════════════════════
   迷宫
   ══════════════════════════════════════════════════════════════ */

export function renderMaze() {
  const st = S.state;
  if (!st || !st.maze) return;
  const mz = st.maze;

  el.mzDepth.textContent = mz.depth;
  renderGrid(mz);
  renderRoomCard();

  // 站在梯子上才给「下去」的按钮——不然玩家不知道自己在哪
  const onStair = mz.cells.some((c) => c.x === mz.px && c.y === mz.py && c.type === 'stair');
  el.btnDescend.hidden = !onStair;

  syncMazeLock();

  const unseen = mz.cells.filter((c) => !c.seen).length;
  el.mzHint.textContent = st.dark
    ? '天黑透了——体力一直在掉，快找「歇」回阁！'
    : onStair
    ? '梯子就在脚下——下去更深，或者找歇脚处回阁。'
    : mz.onRest
      ? '这里能歇脚，也能就此收工回阁。'
      : unseen
        ? `还有 ${unseen} 间屋子没看过`
        : '这一层走遍了——找歇脚处回阁。';

  el.mzDpad.classList.toggle('locked', !mz.canLeave);
  renderNav(mz.landmarks);
  renderScene();
}

/** 十字视野下的方向感：梯子 / 歇脚处 / 阁门各在哪个方向 */
function renderNav(lm) {
  if (!el.mzNav) return;
  if (!lm) { el.mzNav.innerHTML = ''; return; }
  const part = (label, v) => (v ? `<span>${label} <b>${v}</b></span>` : '');
  el.mzNav.innerHTML = part('梯', lm.stair) + part('歇', lm.rest) + part('阁门', lm.gate);
}

/**
 * 回阁按钮的可用性。
 *
 * 这段以前是长在 renderMaze() 里面的——于是踩了个很隐蔽的坑：
 * 一次动作成功时，set() 先跑（那时 S.busy 还是 true，按钮被置灰），
 * setBusy(false) 晚一步、只触发 renderAll('busy')，那条路径**不重画迷宫**，
 * 于是按钮就以"灰"的状态一直留着——S.busy 已经是 false，看门狗也救不回来。
 * 表现：明明站在歇脚处、提示也写着"能就此收工回阁"，按钮却按不动。
 * 所以它必须是独立可调用的：忙锁一变就重算一次。
 */
export function syncMazeLock() {
  const mz = S.state && S.state.maze;
  if (!mz || !el.btnReturn) return;
  const onRest = !!mz.onRest;
  el.btnReturn.disabled = !!S.busy || !onRest;
  el.btnReturn.title = S.busy
    ? '上一件事还没做完（若卡住了，45 秒后会自动解开）'
    : onRest ? '收工回阁' : '得先走到「歇脚处」——图上写着「歇」的那格';
  if (el.mzWarn) {
    el.mzWarn.hidden = onRest;
    el.mzWarn.textContent = onRest ? '' : '回阁要走到「歇脚处」（图上写着「歇」的那格）。';
  }
}

function renderGrid(mz) {
  const html = mz.cells.map((c) => {
    const cls = ['mz-cell'];
    if (!c.seen) cls.push('fog');
    else cls.push('t-' + (TONE[c.type] || 'plain'));
    if (c.solved && c.seen) cls.push('done');
    if (c.x === mz.px && c.y === mz.py) cls.push('here');
    if (c.foeHp != null && c.foeHp > 0) cls.push('has-foe');
    if (c.blocking) cls.push('blocking');
    return `<div class="${cls.join(' ')}" data-x="${c.x}" data-y="${c.y}">`
      + `<span class="mz-icon">${c.seen ? c.icon : ''}</span>`
      + (c.x === mz.px && c.y === mz.py ? '<span class="mz-me"></span>' : '')
      + '</div>';
  }).join('');
  el.mzGrid.style.setProperty('--cols', mz.w);
  el.mzGrid.innerHTML = html;
}

/** 不弹场景的格子（空房/阁门/楼梯）在这儿出一行反馈，省得玩家翻流水 */
function renderRoomCard() {
  const st = S.state;
  const r = S.room;
  if (!el.roomCard) return;
  if (!r || !st || st.phase !== 'maze' || SCENE[r.type]) {
    el.roomCard.hidden = true;
    return;
  }
  const lines = (r.text || []).map((t) => `<p>${t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`).join('');
  el.roomCard.hidden = false;
  el.roomCard.innerHTML = `<div class="rc-body">${lines}</div>`;
}

/* ══════════════════════════════════════════════════════════════
   场景层 —— 非普通房间的强制过场
   ══════════════════════════════════════════════════════════════ */

/**
 * 现在这一格要展示的房间。
 * 优先用"刚走完这一步"的结果（S.room）；如果玩家是刷新页面进来的，
 * S.room 是空的——那就用后端快照里重建出来的待办（maze.here）。
 * 少了这条兜底，刷新的玩家会站在妖物房里、场景不弹、却被扣着走不了。
 */
function currentRoom() {
  if (S.room) return S.room;
  const h = S.state && S.state.maze && S.state.maze.here;
  return h && h.blocking ? h : null;
}

/** 场景这类房间是不是还在等玩家再出一手 */
export function mazeNeedsItem() {
  return !!(currentRoom() || {}).needOffering;
}

/** 妖物还站着——允许继续砸它 */
export function mazePendingFoe() {
  const r = currentRoom();
  return !!(r && r.type === 'foe' && r.foe && r.foe.hp > 0);
}

/**
 * 舞台（v4.4：场景层不再是遮罩，直接占中央那一大片）
 * ------------------------------------------------------------------
 *  GalGame 的看法：舞台是常驻的，不该因为"有没有事件"就整块消失。
 *  · 背景 = 当前这间房的场景画；没事的时候用旧宅走廊那张
 *  · 立绘 = 旅人永远在左，遇到对手才在右出现（左右对峙）
 *  · 底下对话框 = 名字条 + 旁白 + 选项（模型写的话也进这里）
 */
export function renderScene() {
  const st = S.state;
  if (!el.galStage) return;
  const r = st && st.phase === 'maze' && !st.over ? currentRoom() : null;
  const art = r ? SCENE[r.type] : null;
  const show = !!(st && !st.over && st.phase !== 'over');

  // 取景框常驻左栏（v4.4.2：就待在地图下面）。
  // 原先"要举东西才抬起来"的结果是它几乎不出现——拾物格边上找不到取景框，
  // 玩家不知道镜头在不在看。
  if (st && st.phase === 'maze') setCam(true);

  // 一格要你举物时，把左栏滚到取景框那儿。
  // 对话框写着"点左边「递上此物」"，那一块就必须真的在视野里——
  // 窗口矮的时候地图正好把取景框顶到滚动区外面，玩家找不到按钮，
  // 表现就是"拾不了物"。左栏是滚动容器，让浏览器算最小滚动量。
  if (r && r.needOffering && el.camBody && el.camBody.scrollIntoView) {
    el.camBody.scrollIntoView({ block: 'nearest' });
  }

  // 背景：有事就用这间房的画，没事用旧宅走廊；夜里换成暗调的那张
  const idleBg = st && st.phase === 'night' ? 'assets/scene/shrine.jpg' : 'assets/scene/rest.jpg';
  el.gsBg.style.backgroundImage = art && art.art
    ? `url('${art.art}')`
    : `url('${idleBg}')`;
  el.gsBadge.textContent = art ? sceneSub(r) : stageIdleText(st);
  el.gsBadge.hidden = !show;

  // 立绘：旅人常驻左边；对手只在有对手的时候站到右边
  // 房型 → 右侧那位的立绘。商贩、神龛、熔炉、借宿各有自己的一张；
  // 没配人形的三间（拾物/箱笼/陷阱/歇脚）右侧空着——
  // 背景画本身够看，别拿妖物硬凑。
  const CAST = {
    shop:   { src: 'assets/figure/shopkeeper.png', name: '行脚商' },
    shrine: { src: 'assets/figure/shrine.png',    name: '守龛人' },
    forge:  { src: 'assets/figure/forge.png',     name: '铸器匠' },
    guest:  { src: 'assets/figure/guest.png',     name: '借宿的旅人' },
    // v4.5.2：三个新 NPC 也该有个人站在那儿——复用现有人形，按人物染色相
    doctor: { src: 'assets/figure/shrine.png',    name: '游方郎中', hue: -30 },
    bard:   { src: 'assets/figure/guest.png',     name: '说书人',   hue: 40 },
    hermit: { src: 'assets/figure/forge.png',     name: '传功人',   hue: 110 },
  };
  const foeArt = r && r.type === 'foe' && r.foe;
  // 夜战的守阁灵也是对手：galgame 的对峙感在夜里最要紧
  const beast = (st && st.phase === 'night' && st.night) ? st.night : null;
  const cast = r ? CAST[r.type] : null;
  const foeName = foeArt ? r.foe.name : (beast ? beast.name : (cast ? cast.name : null));
  const foeHp = foeArt ? r.foe.hp : (beast ? beast.hp : null);
  const foeMax = foeArt ? r.foe.maxHp : (beast ? beast.maxHp : null);
  const foeEle = foeArt ? r.foe.element : (beast ? beast.element : null);

  el.gsFoe.hidden = !foeName;
  if (foeName) {
    el.gsFoe.src = foeArt || beast ? 'assets/figure/foe.png' : cast.src;
    el.gsFoe.alt = foeName;
    // NPC 立绘按人物染色相（同一张底图也分得清谁是谁）
    if (cast && !foeArt && !beast) {
      el.gsFoe.style.filter = cast.hue ? `hue-rotate(${cast.hue}deg) saturate(1.1)` : '';
      el.gsFoe.classList.remove('enter');
      void el.gsFoe.offsetWidth;
      el.gsFoe.classList.add('enter');       // 走进来的那一下
    } else if (!foeArt && !beast) {
      el.gsFoe.style.filter = '';
    }
    // 按属性染色：同一张立绘，不同属性的对手颜色不同（省素材）
    const hue = { fire: 8, water: 200, earth: 28, metal: 210, wood: 96, volt: 265, lore: 300, life: 330 }[foeEle];
    if (hue) el.gsFoe.style.filter = `hue-rotate(${hue}deg) saturate(1.15)`;
    else if (!cast) el.gsFoe.style.filter = '';   // NPC 那一份色调在上面设过，别抹掉
    el.gsTier.hidden = false;
    el.gsFoeName.textContent = foeName;
    // 血条只给真对手（妖物 / 守阁灵）。匠人、神龛、旅人不是来打的，
    // 给他们挂条血是误导——"待交易"那种占位更没必要，整条藏掉。
    if (el.gsHpWrap) el.gsHpWrap.hidden = !foeMax;
    if (foeMax) {
      const pct = Math.max(0, Math.round(foeHp / foeMax * 100));
      el.gsFoeHp.style.width = pct + '%';
      el.gsFoeHpTxt.textContent = `${foeHp}/${foeMax}`;
    } else {
      el.gsFoeHp.style.width = '100%';
      el.gsFoeHpTxt.textContent = '';
    }
  } else {
    el.gsTier.hidden = true;
  }

  if (!show) {
    el.gdName.textContent = '这一局';
    el.scActs.innerHTML = '';
    return;
  }

  if (r && !S.sceneClosed) {
    el.gdName.textContent = art.name;
    el.gdName.className = 'gd-name' + (r.type === 'foe' ? ' foe' : '');
    // 旁白进对话框；模型叙事写的是同一个 #speech，所以夜战时它自带内容
    if (st.phase !== 'night') {
      el.speech.innerHTML = (r.text || [])
        .map((t) => `<p>${t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`)
        .join('') || '<p>……</p>';
    }
    el.scActs.innerHTML = sceneActs(r);
    bindSceneActs();
  } else if (st.phase === 'night') {
    // 夜战：名字条交给守阁灵，正文是模型写的（#speech 由 act.js 流式更新）
    el.gdName.textContent = (S.guardian && S.guardian.name) || '妖物';
    el.gdName.className = 'gd-name foe';
    el.scActs.innerHTML = '';
  } else if (st.phase === 'hall') {
    el.gdName.textContent = '万物阁';
    el.gdName.className = 'gd-name';
    el.speech.innerHTML = '<p>阁里静着。货仓、祭坛、丹房，都等你打理。</p>';
    el.scActs.innerHTML = '';
  } else {
    el.gdName.textContent = '旧宅';
    el.gdName.className = 'gd-name';
    el.speech.innerHTML = `<p>${stageIdleText(st)}</p>`;
    el.scActs.innerHTML = '';
  }
}

/** 没事发生的时候，右上角小标写一句当前的处境 */
function stageIdleText(st) {
  if (!st) return '';
  if (st.over) return '这一局已经结束';
  if (st.phase === 'hall') return '在阁里';
  if (st.phase === 'night') return '夜里 · 守阁';
  const mz = st.maze;
  if (!mz) return '';
  return mz.onRest ? '这里能歇脚，也能就此收工回阁' : '旧宅第 ' + mz.depth + ' 层';
}

/** 场景图右下角那行小字：妖物报血量，别的报状态 */
function sceneSub(r) {
  if (r.type === 'foe' && r.foe) {
    const f = r.foe;
    return `${S.elements[f.element] ? S.elements[f.element].name : '?'} 属 · 体力 ${f.hp}/${f.maxHp}`;
  }
  if (r.type === 'shop') return '挑担子的行脚商';
  if (r.type === 'doctor') return '艾草味飘了一地';
  if (r.type === 'bard') return '醒木还没放下';
  if (r.type === 'hermit') return '蒲团空着一个';
  if (r.type === 'forge') return '火还没灭';
  if (r.type === 'mirror') return '镜面发乌';
  if (r.type === 'guest') return '火堆压得很低';
  if (r.type === 'rest') return '这里能回阁';
  if (r.type === 'trap') return '来得突然';
  if (r.type === 'item') return '收，还是不收';
  if (r.type === 'shrine') return '拜，还是掀';
  if (r.type === 'chest') return '开出来的看运气';
  return '';
}

/** 场景底部的选项 */
function sceneActs(r) {
  // ⓪ 已经了结（告辞了 / 买成了 / 妖物散了 / 陷阱踩过了）：
  //   必须最先判——商贩的结果里还带着 stock，不先判 solved 会永远停在货摊上
  if (r.solved) {
    return '<div class="sc-row"><button class="btn primary" data-sc="close">继续</button></div>';
  }
  // ① 还在等东西：把取景框抬起来，让玩家举物
  //   妖物还活着也算"等东西"——万一哪条路径漏了 needOffering 字段，
  //   也不能让玩家面对一个"继续"按钮关掉场景、然后被堵死在这一格
  if (r.needOffering || (r.type === 'foe' && r.foe && r.foe.hp > 0)) {
    const skip = (r.type === 'item' || r.type === 'forge')
      ? `<button class="btn ghost" data-sc="skip">${r.type === 'forge' ? '不熔了，走' : '不捡了，走'}</button>`
      : '';
    const tip = r.type === 'forge'
      ? '取景框已经抬起来了 —— 举起东西，点左边「递上此物」，丢进坩埚熔成护符。'
      : '取景框已经抬起来了 —— 举起东西，点左边「递上此物」。';
    return `<div class="sc-tip">${tip}</div>`
      + `<div class="sc-row">${skip}</div>`;
  }
  // ② 抉择：后端下发了选项表（郎中/说书人/传功人这类 NPC）就照着画；
  //    神龛 / 铜镜 / 借宿的固定抉择保留在下面
  if (r.needChoice && Array.isArray(r.choices) && r.choices.length) {
    const btns = r.choices.map((c) => (
      `<button class="btn" data-sc="choice" data-val="${c.id}">${c.label}</button>`
    )).join('');
    return `<div class="sc-row">${btns}</div>`
      + '<div class="sc-row"><button class="btn ghost" data-sc="skip">告辞，走</button></div>';
  }
  if (r.needChoice) {
    if (r.type === 'mirror') {
      return '<div class="sc-row">'
        + '<button class="btn" data-sc="look">照一照（+精神、+术力）</button>'
        + '<button class="btn ghost" data-sc="cover">把镜面扣过去</button>'
        + '</div>';
    }
    if (r.type === 'guest') {
      return '<div class="sc-row">'
        + '<button class="btn" data-sc="stay">借宿（+体力、+香火，-房钱）</button>'
        + '<button class="btn ghost" data-sc="decline">谢绝，走</button>'
        + '</div>';
    }
    return '<div class="sc-row">'
      + '<button class="btn" data-sc="pray">拜一拜（+精神、+香火，-饱食）</button>'
      + '<button class="btn" data-sc="smash">掀了它（+铜钱，-精神）</button>'
      + '</div>';
  }
  // ③ 商贩：买，或者告辞
  if (r.stock && r.stock.length) {
    const goods = r.stock.map((g) => (
      `<button class="btn good" data-sc="buy" data-good="${g.id}" title="${g.desc}">`
      + `${g.name}<small>${g.price} 文</small></button>`
    )).join('');
    return `<div class="sc-row goods">${goods}</div>`
      + '<div class="sc-row"><button class="btn ghost" data-sc="skip">不买了，告辞</button></div>';
  }
  // ④ 兜底（不该到这儿）：点一下合上
  return '<div class="sc-row"><button class="btn primary" data-sc="close">继续</button></div>';
}

/**
 * data-sc → 动作。三类以外都是「抉择」：
 *   显式选项表（郎中/说书人/传功人）把 id 放在 data-val，
 *   神龛/铜镜/借宿的固定抉择没有 data-val，按钮自己的 key 就是选项名。
 */
function bindSceneActs() {
  el.scActs.querySelectorAll('[data-sc]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.sc;
      if (k === 'close') return closeScene();
      if (k === 'skip') return doRoom({ skip: true });
      if (k === 'buy') return doRoom({ good: b.dataset.good });
      return doRoom({ choice: b.dataset.val || k });
    };
  });
}

/**
 * 「继续」：把这一格的话收掉。
 * v4.4 起舞台是常驻的，不再有"合上遮罩"这回事——
 * 收掉选项、对白退回当前处境，玩家就能接着走。
 */
export function closeScene() {
  S.sceneClosed = true;
  renderScene();
}

/* ══════════════════════════════════════════════════════════════
   动作
   —— 四个动作共用同一套外壳（忙锁 + 断连兜底，见 hud.js 的 guard()），
      本体只剩下"发哪个请求、拿到结果后怎么记一笔"。
   ══════════════════════════════════════════════════════════════ */

/** 最后一行旁白：房间结算的文字都以它收尾 */
const lastLine = (r) => (r && r.text && r.text[r.text.length - 1]) || '';

/** 走一格 */
export function travel(dir) {
  return guard(async () => {
    const j = await postTravel(dir);
    if (j.state) set({ state: j.state, room: j.result || null, sceneClosed: false }, 'travel');
    const line = lastLine(j.result);
    if (line) addLog({ idx: DIR_CN[dir] || dir, html: line, right: '', fresh: true });
    // 宅子在动：走过的房间换了内容，得让玩家知道地图不可信
    if (j.rerolled > 0) {
      addLog({ idx: '↻', html: `宅子在动 —— 走过的 <b>${j.rerolled}</b> 间屋子换了内容。`, right: '', fresh: true });
    }
    if (!j.ok && j.msg) addLog({ idx: '×', html: j.msg, right: '', fresh: true });
  });
}

/** 结算脚下的房间：举物 / 抉择 / 买货 / 告辞 */
export function doRoom(payload) {
  return guard(async () => {
    const j = await postRoom(payload);
    if (j.state) set({ state: j.state, room: j.result || null, sceneClosed: false }, 'room');
    const line = lastLine(j.result);
    if (line) addLog({ idx: '·', html: line, right: '', fresh: true });
  });
}

/** 下潜：往更深一层走 */
export function descend() {
  return guard(async () => {
    const j = await postDescend();
    if (j.state) set({ state: j.state, room: null, sceneClosed: false }, 'descend');
    if (j.ok) addLog({ idx: '↓', html: `下到迷宫第 <b>${j.depth}</b> 层。`, right: `-${j.sanity} 精神` });
  });
}

/** 收工回阁（只在歇脚处可用，后端还会再拦一道） */
export function returnHall() {
  return guard(async () => {
    const j = await postReturn();
    if (j.state) set({ state: j.state, room: null, sceneClosed: false }, 'return');
    if (!j.ok && j.msg) addLog({ idx: '×', html: j.msg, right: '', fresh: true });
  });
}

/**
 * 侧栏面板。
 *
 * 原则：只展示 playerView 过滤后的信息。
 * 迷雾下"敌方还剩几个单位""对方金币多少"这类全局统计一律不显示，
 * 否则迷雾就白做了。城市归属和耐久是公开信息（城墙就在那儿）。
 */

import { CATEGORY_NAME, CONFIG, eraDef, passable } from '../core/config.ts';
import { expansionById } from '../core/expansions.ts';
import type { PlayerView } from '../core/fog.ts';
import { describeTerrain, describeUnit, TERRAIN_INFO } from '../core/info.ts';
import {
  citiesOf,
  cityById,
  cityName,
  cityRegenOf,
  cityTiles,
  distToCity,
  recruitCost,
  unitsOf,
  upgradeCostOf,
  utype,
} from '../core/rules.ts';
import type { GameState, PlayerId, Unit, UnitTypeDef } from '../core/types.ts';

export interface PanelInput {
  view: PlayerView;
  me: PlayerId;
  selectedUnit: Unit | null;
  selectedCityId: string | null;
  /** 选中的军营（自己的军营点开就是产兵面板） */
  selectedCampId: string | null;
  /** 点空地时选中的地形，用来显示地形说明 */
  selectedTile: { x: number; y: number } | null;
}

export function renderPanel(el: HTMLElement, input: PanelInput): void {
  const { view, me } = input;
  const s = view.state;
  const other: PlayerId = me === 'A' ? 'B' : 'A';
  const myTurn = s.current === me && !s.winner;

  const myCities = s.cities.filter((c) => c.owner === me).length;
  const otherCities = s.cities.filter((c) => c.owner === other).length;

  const turnBadge = s.winner
    ? `<span class="turn-badge">对局结束</span>`
    : `<span class="turn-badge active-${s.current}">
         ${s.current === me ? '轮到你行动' : `等待 ${s.players[s.current].name}`}
       </span>`;

  const detail = renderDetail(input, myTurn);
  const logHtml = renderLog(input);

  const activeNames = s.config.expansionIds
    .map((id) => expansionById(id)?.name)
    .filter((n): n is string => !!n);
  const expansionText = activeNames.length > 0 ? activeNames.join(' · ') : '无';

  el.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        ${turnBadge}
        <span class="hint">第 ${s.turn} 次行动</span>
      </div>
      <div style="margin-top:12px">
        <div class="versus">
          <div class="vs-side">
            <div class="vs-name"><span class="vs-dot a"></span>${s.players.A.name}</div>
            <div class="vs-stats">金币 ${s.players.A.gold}<br />城市 ${me === 'A' ? myCities : otherCities}</div>
          </div>
          <div class="vs-mid">VS</div>
          <div class="vs-side right">
            <div class="vs-name">${s.players.B.name}<span class="vs-dot b"></span></div>
            <div class="vs-stats">金币 ${s.players.B.gold}<br />城市 ${me === 'B' ? myCities : otherCities}</div>
          </div>
        </div>
      </div>
      <div class="meta-line">${s.fog ? '迷雾开启' : '迷雾关闭'} · 棋盘 ${s.w}×${s.h}</div>
      <div class="meta-line">扩展：${escapeHtml(expansionText)}</div>
    </div>

    <div class="card">${detail}</div>

    <div class="card">
      <div class="card-title">战报</div>
      ${logHtml}
    </div>

    <div class="side-footer">
      <button class="btn btn-primary btn-block" data-act="end-turn" ${myTurn ? '' : 'disabled'}>
        ${myTurn ? '结束行动，交给对方' : '等待对方行动中'}
      </button>
      <div class="hint" style="text-align:center">
        每一步都会自动存档，随时可以关掉页面
      </div>
    </div>
  `;
}

function renderDetail(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedUnit, selectedCityId, selectedCampId, selectedTile } = input;
  const s = view.state;

  // 军营：自己点开就是产兵面板，跟城市那套是一回事
  if (selectedCampId) {
    return renderCamp(input, myTurn);
  }

  if (selectedCityId) {
    return renderCity(input, myTurn);
  }

  if (selectedTile) {
    const tile = s.tiles[selectedTile.y * s.w + selectedTile.x];
    if (tile) {
      const info = TERRAIN_INFO[tile.terrain];
      const lines = describeTerrain(tile.terrain);
      const coord = `${String.fromCharCode(65 + selectedTile.x)}${selectedTile.y + 1}`;
      return `
        <div class="unit-head">
          <div class="unit-chip" style="border-radius:8px;background:#8b8477">地</div>
          <div>
            <div class="unit-title">${info.name}</div>
            <div class="unit-sub">坐标 ${coord}</div>
          </div>
        </div>
        <div class="info-row"><span>进入消耗</span><b>${info.cost}</b></div>
        <div class="info-row"><span>防御加成</span><b>${info.defense}</b></div>
        <div class="unit-notes">${lines.map((l) => `<div>· ${l}</div>`).join('')}</div>
      `;
    }
  }

  if (selectedUnit) {
    const def = utype(s, selectedUnit.type);
    const ratio = selectedUnit.hp / def.maxHp;
    const mine = selectedUnit.owner === me;
    const status: string[] = [];
    if (mine) {
      if (!selectedUnit.moved) status.push('可移动');
      if (!selectedUnit.acted) status.push('可攻击');
      if (selectedUnit.moved && selectedUnit.acted) status.push('本回合已行动完毕');
    } else {
      // 敌方单位只给看：兵种一多，临场查对面射程/护甲是刚需，
      // 但这张卡上不该出现任何能按的东西
      status.push('敌方单位 · 仅查看');
    }

    // 建造单位：列出它能盖的东西，点了就进选址模式
    const buildables = (def.builds ?? [])
      .map((id) => s.unitTypes[id])
      .filter((x): x is UnitTypeDef => !!x);
    const notes = describeUnit(s, def);
    const noteBlock =
      notes.length === 0
        ? ''
        : `<div class="unit-notes">${notes.map((n) => `<div>· ${n}</div>`).join('')}</div>`;
    const canBuildNow = mine && !selectedUnit.acted;
    // 建造清单只在"自己的单位"上出现：对敌方展示一份点不动的建造菜单没有意义
    const buildBlock =
      buildables.length === 0 || !mine
        ? ''
        : `<div class="card-title" style="margin-top:14px">可建造</div>
           <div class="recruit-list">${buildables
             .map((b) => {
               const price = recruitCost(s, me, b);
               const dis = !canBuildNow || s.players[me].gold < price;
               const tag = b.bridges
                 ? '架在水上 · 双向通行'
                 : b.barracks
                   ? `能产兵 · ${(b.buildOn ?? []).map((t) => CONFIG.terrainName[t]).join('/')}${
                       b.requiresWater ? ' · 必须临水' : ''
                     }`
                   : b.autoAttack
                     ? `自动开火 ${b.range} 格`
                     : b.incomeByTerrain
                       ? '产出金币'
                       : '工事';
               return `<button class="recruit-btn" data-act="build" data-type="${b.id}" ${dis ? 'disabled' : ''}>
                 <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${b.short}</span>
                 <span class="meta"><b>${b.name}</b><span>攻 ${b.atk} · 甲 ${b.armor} · ${tag}</span></span>
                 <span class="price">${price}</span>
               </button>`;
             })
             .join('')}</div>
           <div class="hint" style="margin-top:8px">建造要占掉这个单位的整回合，选址范围 ${CONFIG.buildRange} 格。</div>`;

    // 运输船：装卸是它唯一会做的事，所以单独开一块，写清载了谁、还能装几个
    const cargo = selectedUnit.cargo ?? [];
    const cap = def.capacity ?? 0;
    const cargoBlock = !def.transport
      ? ''
      : `<div class="card-title" style="margin-top:14px">货舱 ${cargo.length} / ${cap}</div>
         <div class="hint">${
           cargo.length === 0
             ? '空船。贴着岸边走，把陆军接上来。'
             : cargo.map((u) => `${utype(s, u.type).name}（${u.hp}）`).join(' · ')
         }</div>
         <div class="recruit-list" style="margin-top:8px">
           <button class="recruit-btn" data-act="load" ${!mine || selectedUnit.acted || cargo.length >= cap ? 'disabled' : ''}>
             <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">装</span>
             <span class="meta"><b>装载</b><span>把贴身的陆军接上船（占掉它这一回合）</span></span>
             <span class="price">—</span>
           </button>
           ${
             cargo.length === 0
               ? ''
               : `<button class="recruit-btn" data-act="unload" ${!mine || selectedUnit.acted ? 'disabled' : ''}>
                    <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">卸</span>
                    <span class="meta"><b>卸载</b><span>放到船边一格空地，下船后本回合不能再动</span></span>
                    <span class="price">—</span>
                  </button>`
           }
         </div>`;

    return `
      <div class="unit-head">
        <div class="unit-chip ${selectedUnit.owner === 'A' ? 'a' : 'b'}">${def.short}</div>
        <div>
          <div class="unit-title">${def.name}</div>
          <div class="unit-sub">${s.players[selectedUnit.owner].name} · ${status.join(' / ')}</div>
        </div>
      </div>
      <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
      <div class="info-row"><span>生命</span><b>${selectedUnit.hp} / ${def.maxHp}</b></div>
      <div class="info-row"><span>攻击 / 护甲</span><b>${def.atk} / ${def.armor}</b></div>
      <div class="info-row"><span>移动力</span><b>${def.move}</b></div>
      <div class="info-row"><span>射程 / 视野</span><b>${def.range} / ${def.vision}</b></div>
      ${
        def.splash
          ? `<div class="info-row"><span>溅射</span><b>主目标 ${def.splash} 格内（不含斜角）· ${Math.round(CONFIG.splashRatio * 100)}%</b></div>`
          : ''
      }
      ${def.burst ? `<div class="info-row"><span>连击</span><b>${def.burst} 段 · 每段独立减甲</b></div>` : ''}
      ${cargoBlock}
      ${buildBlock}
      ${noteBlock}
    `;
  }

  return `
    <div class="card-title">操作</div>
    <div class="hint">
      点自己的单位 → 蓝色格子是可移动范围，红框是可攻击目标。<br /><br />
      点自己的城市 → 产兵、以及花钱升级时代。升级后能造更高级的兵种，城市也更硬。<br /><br />
      点敌方城市 → 查看它的时代、耐久和护甲。攻城伤害 = 攻击 − 城市护甲。<br /><br />
      点任何一块空地 → 看这块地形能干什么、适合谁站。
    </div>
  `;
}

function renderCity(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedCityId } = input;
  const s = view.state;
  const city = selectedCityId ? cityById(s, selectedCityId) : undefined;
  if (!city) return '';

  const mine = city.owner === me;
  const ratio = city.hp / city.maxHp;
  const era = eraDef(city.era);
  const garrison = unitsOf(s, city.owner).filter((u) =>
    cityTiles(city).some((t) => t.x === u.x && t.y === u.y),
  ).length;
  const freeSlots = city.size * city.size - garrison;
  const gold = s.players[me].gold;

  // 水军要下到城边那一格空水面上去；没有就造不了
  const hasPort = cityTiles(city).some((t) =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dy]) => {
      const nb = s.tiles[(t.y + dy) * s.w + (t.x + dx)];
      return nb?.terrain === 'water' && !s.units.some((u) => u.x === t.x + dx && u.y === t.y + dy);
    }),
  );

  // 回血：只有"有驻军 + 城外没有敌人"才成立，所以要把当前状态说清楚，
  // 否则玩家只会看到血条不动而不知道为什么
  const regen = cityRegenOf(s, city);
  const besieged = s.units.some(
    (u) => u.owner !== city.owner && distToCity(u, city) <= 1,
  );
  const regenText =
    regen > 0 ? `每回合 +${regen}` : besieged ? '被围城，无法休整' : '城内没有驻军，不回血';

  const upgradeCost = upgradeCostOf(s, city);
  const nextEra = upgradeCost === null ? null : eraDef(city.era + 1);

  // 城里只产"能被派出去的单位"，建筑要用建造单位去盖
  const buildable = Object.values(s.unitTypes).filter(
    (d) => d.category !== 'building' && d.era <= city.era && d.era >= city.era - 1,
  );
  const locked = Object.values(s.unitTypes).filter((d) => d.era > city.era);

  const unitButton = (def: UnitTypeDef) => {
    const price = recruitCost(s, me, def);
    const slotsOk = def.domain === 'water' ? hasPort : freeSlots > 0;
    const disabled = !myTurn || gold < price || !slotsOk;

    let extra = '';
    if (def.incomeByTerrain) {
      const best = Object.entries(def.incomeByTerrain).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      if (best) {
        extra = ` · ${CONFIG.terrainName[best[0] as keyof typeof CONFIG.terrainName]} +${best[1]}`;
      }
    } else if (def.income) {
      extra = ` · +${def.income} 金`;
    }
    if (def.domain === 'water') extra += hasPort ? ' · 水上' : ' · 需要临水';

    return recruitButton(s, me, def, disabled, extra);
  };

  const recruitGroups = (['combat', 'economy', 'builder'] as const)
    .map((cat) => {
      const items = buildable.filter((d) => d.category === cat);
      if (items.length === 0) return '';
      return `<div class="recruit-group">
        <div class="recruit-group-title">${CATEGORY_NAME[cat]}</div>
        <div class="recruit-list">${items.map(unitButton).join('')}</div>
      </div>`;
    })
    .join('');

  const upgradeBlock =
    mine && nextEra && upgradeCost !== null
      ? `<button class="upgrade-btn" data-act="upgrade" ${!myTurn || gold < upgradeCost ? 'disabled' : ''}>
           <span class="upgrade-main">
             <b>升级到「${nextEra.name}」时代</b>
             <span>耐久 ${city.maxHp} → ${nextEra.cityMaxHp} · 护甲 ${city.armor} → ${nextEra.cityArmor} · 收入 ${era.cityIncome} → ${nextEra.cityIncome}</span>
           </span>
           <span class="price">${upgradeCost}</span>
         </button>`
      : mine
        ? '<div class="hint">已经是最高时代。</div>'
        : '';

  return `
    <div class="unit-head">
      <div class="unit-chip ${city.owner === 'A' ? 'a' : 'b'}" style="border-radius:8px">城</div>
      <div>
        <div class="unit-title">城市 ${cityName(city)}</div>
        <div class="unit-sub">${s.players[city.owner].name} · ${era.name}时代 · 驻军 ${garrison}/${city.size * city.size}</div>
      </div>
    </div>
    <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
    <div class="info-row"><span>耐久</span><b>${city.hp} / ${city.maxHp}</b></div>
    <div class="info-row"><span>护甲</span><b>${city.armor}</b></div>
    <div class="info-row"><span>每回合收入</span><b>${era.cityIncome} 金</b></div>
    <div class="info-row"><span>驻军休整</span><b>${regenText}</b></div>
    ${upgradeBlock}
    ${
      mine
        ? `<div class="card-title" style="margin-top:14px">生产</div>
           ${recruitGroups}
           <div class="hint" style="margin-top:10px">
             ${
               freeSlots > 0
                 ? `城内还有 ${freeSlots} 个空位。新兵当回合不能行动，建筑建成即不可移动。`
                 : '城内已站满，先让部队挪一挪。'
             }
             ${
               locked.length > 0
                 ? `<br />升级后可解锁：${locked.map((d) => d.name).join('、')}`
                 : ''
             }
           </div>`
        : `<div class="hint" style="margin-top:12px">
             这是敌方城市（${era.name}时代），耐久打空才能易主。攻城伤害 = 你的攻击 − ${city.armor}。
             <br />攻陷后会连同它的时代一起接收。
           </div>`
    }
  `;
}

function barColor(ratio: number): string {
  if (ratio <= 0.3) return '#e07b6b';
  if (ratio <= 0.6) return '#e8c76b';
  return '#7ec47e';
}

/** 产兵按钮：城市和军营共用一套写法，省得两处的样式慢慢跑偏 */
function recruitButton(
  s: GameState,
  me: PlayerId,
  def: UnitTypeDef,
  disabled: boolean,
  extra: string,
): string {
  const price = recruitCost(s, me, def);
  const detail = `攻 ${def.atk} · 甲 ${def.armor} · 移 ${def.move} · 射 ${def.range}`;
  return `<button class="recruit-btn" data-act="recruit" data-type="${def.id}" ${disabled ? 'disabled' : ''}>
    <span class="unit-chip ${me === 'A' ? 'a' : 'b'}" style="width:26px;height:26px;font-size:12px">${def.short}</span>
    <span class="meta">
      <b>${def.name}</b>
      <span>${detail}${extra}</span>
    </span>
    <span class="price">${price}</span>
  </button>`;
}

const DIRS_4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 军营面板。
 *
 * 军营就是"能往前推的产兵点"：产兵规则和城市一模一样，唯一的区别是
 * 它自己没有时代——时代跟着最近的那座己方城市走，城丢了兵就补不上。
 * 所以这里要把"补给来自哪座城、是几级"写清楚，否则玩家不知道为什么
 * 忽然造不出高级兵了。
 */
function renderCamp(input: PanelInput, myTurn: boolean): string {
  const { view, me, selectedCampId } = input;
  const s = view.state;
  const camp = selectedCampId ? s.units.find((u) => u.id === selectedCampId) : undefined;
  if (!camp) return '';

  const def = utype(s, camp.type);
  const mine = camp.owner === me;
  const ratio = camp.hp / def.maxHp;
  const gold = s.players[me].gold;

  // 补给：离军营最近的己方城市给了它时代
  const own = citiesOf(s, camp.owner);
  const supply = own.reduce<typeof own[number] | null>(
    (a, b) => (!a || distToCity(camp, b) < distToCity(camp, a) ? b : a),
    null,
  );
  const era = supply ? supply.era : 0;

  // 兵从四邻出来，所以"能出兵"取决于四邻有多少空地 / 空水面
  const landSlots: Array<{ x: number; y: number }> = [];
  const waterSlots: Array<{ x: number; y: number }> = [];
  for (const [dx, dy] of DIRS_4) {
    const x = camp.x + dx;
    const y = camp.y + dy;
    const t = s.tiles[y * s.w + x];
    if (!t) continue;
    if (s.units.some((u) => u.x === x && u.y === y)) continue;
    if (t.terrain === 'water') waterSlots.push({ x, y });
    else if (passable(t.terrain)) landSlots.push({ x, y });
  }

  const buildable = Object.values(s.unitTypes).filter(
    (d) => d.category !== 'building' && d.era <= era && d.era >= era - 1,
  );

  const groups = (['combat', 'economy', 'builder'] as const)
    .map((cat) => {
      const items = buildable.filter((d) => d.category === cat);
      if (items.length === 0) return '';
      return `<div class="recruit-group">
        <div class="recruit-group-title">${CATEGORY_NAME[cat]}</div>
        <div class="recruit-list">${items
          .map((d) => {
            const slotsOk = d.domain === 'water' ? waterSlots.length > 0 : landSlots.length > 0;
            const extra = d.domain === 'water' ? ' · 下水' : '';
            return recruitButton(s, me, d, !myTurn || gold < recruitCost(s, me, d) || !slotsOk, extra);
          })
          .join('')}</div>
      </div>`;
    })
    .join('');

  const supplyLine = supply
    ? `补给来自「${cityName(supply)}」· ${eraDef(era).name}时代`
    : '没有己方城市，补给断了';

  return `
    <div class="unit-head">
      <div class="unit-chip ${camp.owner === 'A' ? 'a' : 'b'}" style="border-radius:8px">${def.short}</div>
      <div>
        <div class="unit-title">${def.name}</div>
        <div class="unit-sub">${s.players[camp.owner].name} · 前线产兵点</div>
      </div>
    </div>
    <div class="hpbar"><i style="width:${ratio * 100}%;background:${barColor(ratio)}"></i></div>
    <div class="info-row"><span>生命</span><b>${camp.hp} / ${def.maxHp}</b></div>
    <div class="info-row"><span>攻击 / 护甲</span><b>${def.atk} / ${def.armor}</b></div>
    <div class="info-row"><span>自动开火</span><b>${def.range} 格内每回合 ${def.atk} 点</b></div>
    <div class="info-row"><span>补给</span><b>${supplyLine}</b></div>
    ${
      mine && supply
        ? `<div class="card-title" style="margin-top:14px">生产</div>
           ${groups}
           <div class="hint" style="margin-top:10px">
             兵从营门四邻的空地出来（当前 ${landSlots.length} 个空位${
               waterSlots.length > 0 ? `、${waterSlots.length} 格空水面` : ''
             }）。
             <br />军营自己不会升级，时代跟着最近的城市走——那座城丢了，这里就只能出低一级的兵。
           </div>`
        : `<div class="hint" style="margin-top:12px">
             ${
               supply
                 ? '这是敌方军营。把它打掉，对方就少一个前线补给点。'
                 : '没有城市供养，这座军营已经产不出兵了。'
             }
           </div>`
    }
  `;
}

function renderLog(input: PanelInput): string {
  const { view, me } = input;
  const entries = view.state.log;
  if (entries.length === 0) {
    return '<div class="log-empty">还没有战报。走第一步吧。</div>';
  }
  const recent = entries.slice(-14).reverse();
  return `<div class="log">${recent
    .map((e) => {
      const side = e.player === 'A' ? 'a' : 'b';
      const label = e.player === me ? '你' : view.state.players[e.player].name;
      return `<div class="log-item ${side}"><span class="who">${label}</span>${escapeHtml(e.text)}</div>`;
    })
    .join('')}</div>`;
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 顶部栏。
 *
 * 这里刻意分成"骨架"和"刷新"两半：骨架只插进 DOM 一次，
 * 之后每一步只改文本、class 和 hidden，**绝不重建按钮节点**。
 *
 * 为什么这么较真：AI 托管时每一步都会 render，如果 topbar.innerHTML 每次重写，
 * 浏览器在 mousedown 和 mouseup 之间就把按钮换成了新节点，
 * 于是 click 事件根本不会派发——表现就是"AI 一跑，什么按钮都点不动"。
 */
export interface TopbarState {
  fog: boolean;
  turn: number;
  current: PlayerId;
  currentName: string;
  /** 当前行动方是不是 AI 在走 */
  aiCurrent: boolean;
  /** AI 的档位显示名：'初级 AI' / '高级 AI'。顶栏只有一小块地方，别写全句 */
  aiLevelName: string;
  /** 是否有任一方交给 AI（有才显示暂停/速度） */
  aiAny: boolean;
  paused: boolean;
  speedName: string;
  /** 联机房间码；null 表示本机对局 */
  roomCode: string | null;
  /** 联机里轮到对方了，正在等他提交 */
  waitingForPeer: boolean;
}

export function topbarShell(): string {
  return `
    <div class="brand">方格战棋 <small>回合制 · 1v1</small></div>
    <div class="turn-chip" title="当前行动方">
      <b data-ref="turn"></b>
      <span class="side-dot a" data-ref="dot"></span>
      <span data-ref="who"></span>
    </div>
    <button class="room-pill" data-act="online" data-ref="room" title="当前房间" hidden></button>
    <div class="topbar-spacer"></div>
    <div class="topbar-actions">
      <button class="btn btn-sm" data-act="ai-pause" data-ref="pause" hidden>暂停 AI</button>
      <button class="btn btn-sm" data-act="ai-speed" data-ref="speed" hidden>速度</button>
      <button class="btn btn-sm" data-act="toggle-ai" data-ref="toggle-ai">交给 AI</button>
      <button class="btn btn-sm" data-act="online">联机</button>
      <button class="btn btn-sm" data-act="toggle-fog" data-ref="fog">迷雾：开</button>
      <a class="btn btn-sm" href="./manual.html" target="_blank" rel="noopener">规则书</a>
      <button class="btn btn-sm" data-act="unit-editor">兵种编辑器</button>
      <button class="btn btn-sm" data-act="export">导出对局</button>
      <button class="btn btn-sm" data-act="import">导入对局</button>
      <button class="btn btn-sm" data-act="new-game">新对局</button>
    </div>
  `;
}

export function updateTopbar(root: HTMLElement, s: TopbarState): void {
  const ref = (name: string) => root.querySelector<HTMLElement>(`[data-ref="${name}"]`);

  const turn = ref('turn');
  if (turn) turn.textContent = `第 ${s.turn} 回合`;

  const dot = ref('dot');
  if (dot) dot.className = `side-dot ${s.current === 'A' ? 'a' : 'b'}`;

  const who = ref('who');
  if (who) {
    who.textContent = s.waitingForPeer
      ? '等待对方提交'
      : s.currentName + (s.aiCurrent ? ` · ${s.aiLevelName}` : '');
  }

  const room = ref('room');
  if (room) {
    room.hidden = !s.roomCode;
    if (s.roomCode) room.textContent = `房间 ${s.roomCode}`;
  }

  const pause = ref('pause');
  if (pause) {
    pause.hidden = !s.aiAny;
    pause.textContent = s.paused ? '继续' : '暂停 AI';
  }

  const speed = ref('speed');
  if (speed) {
    speed.hidden = !s.aiAny;
    speed.textContent = `速度 ${s.speedName}`;
  }

  const ai = ref('toggle-ai');
  if (ai) {
    ai.textContent = s.aiCurrent ? '收回操作权' : '交给 AI';
    ai.classList.toggle('btn-primary', s.aiCurrent);
  }

  const fog = ref('fog');
  if (fog) fog.textContent = `迷雾：${s.fog ? '开' : '关'}`;
}

export const TERRAIN_NAMES = CONFIG.terrainName;

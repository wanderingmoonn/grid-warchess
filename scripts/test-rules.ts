/**
 * 规则内核的单元测试。
 *
 * 这个文件存在的意义就是证明"纯函数核心"不是一句口号：
 * 不用浏览器、不用 DOM、不用任何 mock，直接 import 就能测。
 *
 * 地图是生成的，所以测试不硬编码坐标，而是先把装饰地形清掉，
 * 只留下平原、水和城市——只验证规则，不验证地图好不好看。
 *
 * 运行：npm run test:rules
 */

// @ts-nocheck

import assert from 'node:assert/strict';

import {
  BASE_MAX_ERA,
  CONFIG,
  ERAS,
  ORDER_IDLE,
  ORDER_UPGRADE,
  UNIT_TYPES,
  buildCostOf,
  buildPowerOf,
  eraDef,
  navigable,
  nextUpgradeCost,
  passable,
} from '../src/core/config.ts';
import {
  BLOOD_TURN,
  EXPANSIONS,
  LEGACY_UPGRADE_COST,
  availableExpansions,
  eraCeilingFor,
  expansionById,
  turnOrderBonusFor,
} from '../src/core/expansions.ts';
import { MAP_STYLES, generateLayout, mapStylesFor, terrainFromChar } from '../src/core/mapgen.ts';
import {
  clearUnits,
  paintTerrain,
  placeCity,
  placeUnit,
  removeAt,
  sandboxCityProblem,
} from '../src/core/sandbox.ts';
// 能力表现在是"核心 + 各扩展贡献"合并出来的，测试跟着合并后的表走：
// 扩展兵种引用自家能力时，不该因为"本体表里没有"就报不存在。
import { allAbilities } from '../src/core/ability-registry.ts';
import { CORE_ABILITIES } from '../src/core/abilities.ts';
import { climateAt, coastClassOf, seasonOf } from '../src/core/climate.ts';
import {
  airwingOps,
  deckLine,
  deckOf,
  deckSpecOf,
  deckUsed,
  popPlane,
  registerAirwingOps,
  stowPlane,
} from '../src/core/naval-carrier.ts';
import { NAVAL_FLEET, MODERN_NAVAL } from '../src/core/naval-packs.ts';
import {
  DRAFT_BAN_BASE,
  DRAFT_PICK_BASE,
  DRAFT_POOL_BASE,
  aiDraftBan,
  aiDraftPick,
  canUseType,
  draftBonus,
  draftBudget,
  draftCandidates,
  draftPickOrder,
  draftSecondsLeft,
  eraWindowOk,
  remainingUnits,
} from '../src/core/draft.ts';
import { AIR_CORPS, MODERN_AIR, launchFromCarrier, recoverToCarrier } from '../src/core/air-packs.ts';
import {
  newTimeline,
  noteAction,
  noteDeaths,
  sampleTurn,
  sealTimeline,
  timelineSummary,
} from '../src/core/timeline.ts';
import { normalizeCampaign } from '../src/net/campaign.ts';
import { adoptDecision } from '../src/net/room.ts';
import {
  CHAT_MAX_LEN,
  ChatFeed,
  chatBodyLength,
  chatBodyOverflows,
  chatLinesHtml,
  chatWhoLabel,
  trimChatBody,
} from '../src/net/chat.ts';
import type { ChatLine } from '../src/net/chat.ts';
import {
  AP_COST,
  AP_BY_TIER,
  apMaxOf,
  MOUNTED_IDS,
  VEHICLE_IDS,
  apActionCost,
  apClassesOf,
  apLedger,
} from '../src/core/action-points.ts';
import {
  legacyResistToMultiplier,
  normalizeUnitResist,
  normalizeUnitTypes,
} from '../src/core/customUnits.ts';
import {
  AI_MAX_STEPS,
  DEFAULT_BUDGET,
  aiActiveMood,
  aiLevelLabel,
  aiLevelOf,
  aiMood,
  aiNextAction,
  aiNoise,
  aiTraits,
  anyAiSide,
  cityDistanceField,
  isAiSide,
  mergeAdvanceField,
  rosterBonuses,
  rosterRoleOf,
} from '../src/core/ai.ts';
import {
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  clampBoardSize,
  createMatch,
  DEFAULT_CONFIG,
  normalizePlayerNames,
  startGoldFor,
} from '../src/core/setup.ts';
import {
  applyAction,
  mergeDraftStep,
  adjacentToWater,
  attacksLeftOf,
  attacksPerTurn,
  splashRadiusOf,
  splashRatioOf,
  buildingAt,
  citiesOf,
  cityById,
  cityRegenOf,
  cityTiles,
  armySize,
  canStandAt,
  canStrike,
  computeDamage,
  coversTile,
  damageToCity,
  distance,
  distToCity,
  effectiveRange,
  effectiveRangeAgainst,
  effectiveStats,
  eggSpots,
  fearPenalty,
  footprintOf,
  heightOfTerrain,
  isAirborne,
  isHiddenFrom,
  magicDamageOf,
  idx,
  incomeOf,
  incomeResOf,
  movePower,
  orderSitesOf,
  ordersOf,
  heroBlocked,
  heroSkillsOf,
  previewAttack,
  reachableTiles,
  tilesOfUnit,
  rebuildCost,
  recruitCost,
  recruitPriceOf,
  recruitResCost,
  recruitSpawnCells,
  orderedStatuses,
  refreshMemory,
  registerSkillEffect,
  registerStatus,
  SKILL_EFFECTS,
  STATUS_REGISTRY,
  stepCostBetween,
  stepCostInto,
  strikeDistance,
  threatTiles,
  unitAt,
  underConstruction,
  unitIncome,
  unitIncomeAt,
  unitsAt,
  unitsOf,
  upgradeCostOf,
  unitYield,
  maxHpOf,
  utype,
  visionOf,
  visibleTilesOf,
} from '../src/core/rules.ts';
import { playerView } from '../src/core/fog.ts';
import { GOLD } from '../src/core/resources.ts';
import { REPORT_VERSION, buildMatchReport, reportSignature, reportFileName, reportJson } from '../src/core/report.ts';
import { DEFAULT_SIZE_FOR_ERA as eraSize } from '../src/ui/setup-panel.ts';
import type {
  Action,
  City,
  GameState,
  MatchConfig,
  PlayerId,
  Terrain,
  Unit,
  UnitTypeDef,
} from '../src/core/types.ts';
import { 
  cultivationRank,
  getAgingYears
} from '../src/core/cultivation-packs.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL ${name}\n       ${msg}`);
  }
}

const BASE: MatchConfig = {
  size: 16,
  startEra: 1,
  aiOpponent: false,
  aiAlly: false,
  expansionIds: [],
  enabledUnits: Object.keys(UNIT_TYPES),
};

/** 把森林和丘陵抹平，让测试只关心规则不关心地图 */
function clearDecor(s: GameState): void {
  for (const t of s.tiles) {
    if (t.terrain === 'forest' || t.terrain === 'hill') t.terrain = 'plain';
  }
}

/**
 * 把城市钉回四角（A 在南、B 在北）。
 *
 * 城市位置现在是浮动的（见 mapgen.planCities），而规则测试里有一批写死的
 * 坐标——劳工站 (5,5)、河挖在 x=8、桥架在 (8,7)。新城飘到这些格子上，
 * 测试就会因为"那里是敌方城市"而不是"规则不允许"而失败。
 *
 * 规则测试不该受地图随机影响，所以这里统一把城挪回老的四角布局。
 * 地图本身的多样性由下面那些直接调 generateLayout 的用例负责。
 */
function pinCities(s: GameState): void {
  const spots: Record<PlayerId, Array<{ x: number; y: number }>> = {
    A: [
      { x: 1, y: s.h - 3 },
      { x: s.w - 3, y: s.h - 3 },
    ],
    B: [
      { x: 1, y: 1 },
      { x: s.w - 3, y: 1 },
    ],
  };
  const used: Record<PlayerId, number> = { A: 0, B: 0 };

  // 必须两遍：先全部清空，再全部放置。
  // 一遍到底的话，后一座城"清自己的旧位置"会抹掉前一座城刚放下的格子——
  // 城市位置改成随机撒点之后，旧位置和新位置撞上的概率不低（20×20 就能撞）。
  for (const c of s.cities) {
    for (const t of cityTiles(c)) {
      const tile = s.tiles[idx(s, t.x, t.y)];
      if (!tile) continue;
      tile.cityId = null;
      if (tile.terrain === 'city') tile.terrain = 'plain';
    }
  }
  for (const c of s.cities) {
    const p = spots[c.owner][used[c.owner]++] ?? { x: 1, y: 1 };
    c.x = p.x;
    c.y = p.y;
    for (const t of cityTiles(c)) {
      const tile = s.tiles[idx(s, t.x, t.y)];
      if (!tile) continue;
      tile.cityId = c.id;
      tile.terrain = 'city';
    }
  }

  // 挪城之后可能有人站在别人的城里，清掉
  s.units = s.units.filter((u) => {
    const t = s.tiles[idx(s, u.x, u.y)];
    return !(t?.cityId && s.cities.some((c) => c.id === t.cityId && c.owner !== u.owner));
  });
}

/**
 * 开局那次"第一回合收入"是多少。
 *
 * 收入本应在"回合开始"结算，而先手的第一回合没有这一步，所以开局时补了一次
 * （见 rules.grantOpeningIncome）。它落在战报第一行里，测试从这里读，
 * 免得把"起始金币"的断言写成一个随地形波动的魔数。
 */
function openingIncome(s: GameState): number {
  const line = s.log.find((l) => l.text.startsWith('开局结算：第一回合收入'));
  assert.ok(line, '开局应该有一条"开局结算"的战报');
  const m = line!.text.match(/(\d+) 金币/);
  assert.ok(m, '开局结算的战报里应该有金币数');
  return Number(m![1]);
}

function fresh(extra?: Partial<MatchConfig>, seed = 12345): GameState {
  const s = createMatch({ ...BASE, ...extra }, seed);
  clearDecor(s);
  pinCities(s);
  refreshMemory(s);
  return s;
}

function findUnit(s: GameState, owner: 'A' | 'B', type: string): Unit {
  const u = s.units.find((x) => x.owner === owner && x.type === type);
  assert.ok(u, `找不到 ${owner} 方的 ${type}`);
  return u;
}

/** 把两个步兵摆到相邻的草原上 */
function duel(s: GameState): { a: Unit; b: Unit } {
  const a = findUnit(s, 'A', 'militia');
  const b = findUnit(s, 'B', 'militia');
  a.x = 5;
  a.y = 5;
  b.x = 5;
  b.y = 4;
  return { a, b };
}

console.log('\n开局与地图');

test('默认 16×16，双方各 5 个单位、2 座城市', () => {
  const s = fresh();
  assert.equal(s.w, 16);
  assert.equal(s.h, 16);
  assert.equal(s.units.filter((u) => u.owner === 'A').length, 7, '5 个战斗单位 + 2 个经济单位');
  assert.equal(s.units.filter((u) => u.owner === 'B').length, 7);
  assert.equal(citiesOf(s, 'A').length, 2);
  assert.equal(citiesOf(s, 'B').length, 2);
});

test('标准对局：时代和棋盘尺寸是配套的', () => {
  // 古典 12×12、中世 16×16、火药/工业/二战 20×20
  assert.equal(eraSize(1), 12);
  assert.equal(eraSize(2), 16);
  assert.equal(eraSize(3), 20);
  assert.equal(eraSize(4), 20);
  assert.equal(eraSize(5), 20);

  // 默认配置就是"古典 + 12×12"
  assert.equal(DEFAULT_CONFIG.startEra, 1);
  assert.equal(DEFAULT_CONFIG.size, eraSize(1));
});

test('镜像模式下地图严格点对称', () => {
  for (const size of [12, 16, 20]) {
    const s = fresh({ size, mapSymmetry: 'mirror' }, 999);
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const here = s.tiles[idx(s, x, y)].terrain;
        const there = s.tiles[idx(s, s.w - 1 - x, s.h - 1 - y)].terrain;
        assert.equal(here, there, `${size}×${size} 上 (${x},${y}) 不对称`);
      }
    }
  }

  // 开「地形高差」也一样：扩展的收尾回调会改地形，而它跑在镜像之后，
  // 所以 mapgen 在收尾之后又补了一次镜像——不补的话补山脚会把对称改成"大体对称"。
  for (const size of [12, 16, 20]) {
    const s = fresh({ size, mapSymmetry: 'mirror', expansionIds: ['height-terrain'] }, 999);
    let plateau = 0;
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const here = s.tiles[idx(s, x, y)].terrain;
        const there = s.tiles[idx(s, s.w - 1 - x, s.h - 1 - y)].terrain;
        assert.equal(here, there, `${size}×${size} 开了高差之后 (${x},${y}) 不对称`);
        if (here === 'plateau') plateau++;
      }
    }
    assert.ok(plateau > 0, `${size}×${size} 一朵台地都没有——补山脚没跑到镜像局里`);
  }
});

test('城市最小间距 = 棋盘最短边的 1/4，公平图和镜像图都守', () => {
  // 这条是补一个真 bug：以前间距只在"随机撒点"那一步检查，撒不出来就退回前线，
  // 退的时候不查间距；镜像模式更糟——B 直接由 A 点镜像，完全没校验，
  // 实测 150 张镜像图里 36 张违规，最差的两座城重叠在一起（距离 0）。
  for (const size of [12, 16, 20, 32]) {
    const need = Math.max(3, Math.floor(size * 0.25));
    for (const symmetry of ['fair', 'mirror'] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        const layout = generateLayout(size, seed, undefined, { symmetry });
        const all = [...layout.citiesA, ...layout.citiesB];
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            const d = Math.abs(all[i]!.x - all[j]!.x) + Math.abs(all[i]!.y - all[j]!.y);
            assert.ok(
              d >= need,
              `${size}×${size} ${symmetry} seed=${seed}：两座城只隔 ${d} 格（应 ≥ ${need}）`,
            );
          }
        }
      }
    }
  }
});

test('棋盘边长 4~64 都能开局，越界会被夹住', () => {
  // 下限 4：4×4 正好 16 格，一边一座 2×2 的城，剩下的格子当兵。
  // 上限 64：4096 格，再大就不是"看不看得清"，是浏览器每帧重绘 4000 个格子扛不扛得住。
  assert.equal(clampBoardSize(2), MIN_BOARD_SIZE, '太小要夹到下限');
  assert.equal(clampBoardSize(999), MAX_BOARD_SIZE, '太大要夹到上限');
  assert.equal(clampBoardSize(30), 30, '范围内的原样返回');
  assert.equal(clampBoardSize('17.6'), 18, '小数四舍五入');
  assert.equal(clampBoardSize('abc'), DEFAULT_CONFIG.size, '乱输入回落到默认值');

  const tiny = createMatch({ ...BASE, size: 4 }, 1234);
  assert.equal(tiny.w, 4);
  assert.ok(tiny.units.length > 0, '微图也得有兵可下');
  assert.equal(tiny.cities.length, 2, '微图一边一座城');
  for (const city of tiny.cities) {
    assert.ok(city.x + 2 <= 4 && city.y + 2 <= 4, '城不能出界');
  }

  const huge = createMatch({ ...BASE, size: 64 }, 1234);
  assert.equal(huge.w, 64);
  assert.equal(huge.tiles.length, 64 * 64);
  assert.ok(huge.units.length > 0);

  // config 里存的尺寸也要是夹过的，否则存档和实际棋盘会对不上
  const clamped = createMatch({ ...BASE, size: 200 }, 5);
  assert.equal(clamped.w, MAX_BOARD_SIZE);
  assert.equal(clamped.config.size, MAX_BOARD_SIZE);
});

test('大地图地形要够丰富：多片水、成片林、有山', () => {
  // 用户反馈"大地图整体显得较空"。这条把"够不够丰富"变成可测的数字：
  // 32×32 上至少要有若干片水、成片的林子、以及山体；
  // 同时空地不能占太多（以前是 79%，一眼望去全是绿）。
  const CH: Record<string, string> = { '.': 'plain', f: 'forest', h: 'hill', '~': 'water', '^': 'mountain' };
  let plain = 0;
  let forest = 0;
  let water = 0;
  let mountain = 0;
  let bestForest = 0;
  let waterBodies = 0;
  const N = 4;

  for (let k = 1; k <= N; k++) {
    const layout = generateLayout(32, k * 631 + 17);
    const w = layout.w;
    const h = layout.h;
    const g = layout.rows.join('').split('').map((c) => CH[c] ?? 'plain');
    const count = (t: string) => g.filter((x) => x === t).length;
    plain += count('plain') / (w * h);
    forest += count('forest') / (w * h);
    water += count('water') / (w * h);
    mountain += count('mountain') / (w * h);

    // 最大森林连通块 + 水面片数
    const seen = new Uint8Array(w * h);
    const flood = (start: number, t: string): number => {
      let n = 0;
      const st = [start];
      seen[start] = 1;
      while (st.length > 0) {
        const i = st.pop()!;
        n += 1;
        const x = i % w;
        const y = (i - x) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (seen[j] || g[j] !== t) continue;
          seen[j] = 1;
          st.push(j);
        }
      }
      return n;
    };
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || g[i] !== 'forest') continue;
      bestForest = Math.max(bestForest, flood(i, 'forest'));
    }
    seen.fill(0);
    for (let i = 0; i < w * h; i++) {
      if (seen[i] || g[i] !== 'water') continue;
      flood(i, 'water');
      waterBodies += 1;
    }
  }

  const pct = (v: number) => `${((v / N) * 100).toFixed(0)}%`;
  assert.ok(plain / N < 0.68, `空地太多：${pct(plain)}（应小于 68%）`);
  assert.ok(forest / N > 0.08, `森林太少：${pct(forest)}（应大于 8%）`);
  assert.ok(water / N > 0.08, `水面太少：${pct(water)}（应大于 8%）`);
  assert.ok(mountain / N > 0.005, `没有山：${pct(mountain)}`);
  assert.ok(bestForest >= 15, `没有成片的森林：最大一块只有 ${bestForest} 格`);
  assert.ok(waterBodies / N >= 3, `水面太碎或太少：平均 ${(waterBodies / N).toFixed(1)} 片`);
});

test('任意边长生成的地图都合法：城在界内、互不重叠', () => {
  // 4 和 5 走的是 mapgen 里的 tinyLayout（一城一边、不画河）；
  // 6 以上走正常流程。这条测试把整条边界扫一遍，防止以后改布点又退回去。
  for (const size of [4, 5, 6, 7, 8, 10, 16, 20, 32, 48, 64]) {
    for (let seed = 1; seed <= 3; seed++) {
      const layout = generateLayout(size, seed);
      const all = [...layout.citiesA, ...layout.citiesB];
      assert.ok(all.length > 0, `${size}×${size} 一座城都没有`);
      for (const c of all) {
        assert.ok(
          c.x >= 0 && c.y >= 0 && c.x + 2 <= size && c.y + 2 <= size,
          `${size}×${size} seed=${seed}：城 (${c.x},${c.y}) 出界`,
        );
      }
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]!;
          const b = all[j]!;
          const overlap = Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
          assert.ok(!overlap, `${size}×${size} seed=${seed}：两座城叠在一起了`);
        }
      }
      // 出生点不能在城外、也不能踩在城市格上
      for (const sp of [...layout.spawnsA, ...layout.spawnsB]) {
        assert.ok(
          sp.x >= 0 && sp.y >= 0 && sp.x < size && sp.y < size,
          `${size}×${size}：出生点 (${sp.x},${sp.y}) 出界`,
        );
      }
      assert.ok(layout.spawnsA.length > 0 && layout.spawnsB.length > 0, `${size}×${size} 有一方没有出生点`);
    }
  }
});

test('默认模式下两侧地势不再一样', () => {
  // 这条是这次改动的目的：每张图都镜像，等于每局都是同一张图。
  let differing = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const layout = generateLayout(16, seed);
    let diff = 0;
    layout.rows.forEach((row, y) => {
      for (let x = 0; x < 16; x++) {
        const there = layout.rows[15 - y]?.[15 - x];
        if (row[x] !== there) diff += 1;
      }
    });
    if (diff > 0) differing += 1;
  }
  assert.ok(differing >= 10, `十二张图里只有 ${differing} 张两侧不同，随机性还是不够`);
});

/**
 * 这张图上有没有"架得起桥"的断面：一道 1~3 格宽的水，两岸都是陆地。
 * 无渡口的图全靠这条活着，判错了就是废图。
 */
function hasBridgeableGap(m: ReturnType<typeof generateLayout>): boolean {
  const at = (x: number, y: number) => m.rows[y]?.[x];
  const land = (x: number, y: number) => {
    const ch = at(x, y);
    return ch !== undefined && ch !== '~' && ch !== '^';
  };
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (at(x, y) !== '~') continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        // 岸边 → 对岸：中间 1~3 格水
        if (!land(x - dx, y - dy)) continue;
        let steps = 0;
        let cx = x;
        let cy = y;
        while (steps <= 3 && at(cx, cy) === '~') {
          steps += 1;
          cx += dx;
          cy += dy;
        }
        if (steps >= 1 && steps <= 3 && land(cx, cy)) return true;
      }
    }
  }
  return false;
}

test('任何种子下四座城都连得通', () => {
  // 河和山脊都是不可通行的，生成器必须在最省事的地方凿开渡口/隘口，
  // 否则会生成"打不起来"的废图。这条是硬保证，不能靠重试碰运气。
  for (const size of [12, 16, 20]) {
    for (let seed = 1; seed <= 25; seed++) {
      const layout = generateLayout(size, seed);
      const seen = new Set<number>();
      const start = layout.citiesA[0];
      assert.ok(start, '应该有 A 方城市');
      const queue = [start.y * size + start.x];
      seen.add(queue[0] as number);

      while (queue.length > 0) {
        const i = queue.pop() as number;
        const x = i % size;
        const y = Math.floor(i / size);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (seen.has(j)) continue;
          const ch = layout.rows[ny]?.[nx];
          if (ch === '~' || ch === '^') continue;
          seen.add(j);
          queue.push(j);
        }
      }

      const targets = [...layout.citiesA.slice(1), ...layout.citiesB];
      for (const c of targets) {
        const near = [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const;
        const ok = near.some(([dx, dy]) => {
          const nx = c.x + dx;
          const ny = c.y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) return false;
          return seen.has(ny * size + nx);
        });
        if (layout.fordless && !ok) {
          // 无渡口的图本来就"走不过去"——那是设计。但必须**架得起桥**：
          // 至少要有一道开口，宽度不超过 3 格，两岸都是陆地。
          assert.ok(
            hasBridgeableGap(layout),
            `${size}×${size} seed=${seed}：过不去又没有能架桥的断面，这张图是死的`,
          );
          continue;
        }
        assert.ok(ok, `${size}×${size} seed=${seed}：城市 (${c.x},${c.y}) 走不到`);
      }
    }
  }
});

test('城市间距是随机的，不是永远贴着四个角', () => {
  const gaps = new Set<number>();
  const xs = new Set<number>();
  for (let seed = 1; seed <= 40; seed++) {
    const m = generateLayout(16, seed, ['militia']);
    // 城市必须完整落在棋盘里
    for (const c of [...m.citiesA, ...m.citiesB]) {
      assert.ok(c.y >= 1 && c.y + 2 <= m.h - 1, `seed=${seed} 城市越界：y=${c.y}`);
      assert.ok(c.x >= 1 && c.x + 2 <= m.w - 1, `seed=${seed} 城市越界：x=${c.x}`);
    }
    if (m.layout !== 'split') continue;
    const ownTop = Math.min(...m.citiesA.map((c) => c.y));
    const foeBottom = Math.max(...m.citiesB.map((c) => c.y));
    gaps.add(Math.abs(ownTop - foeBottom));
    xs.add(Math.min(...m.citiesA.map((c) => c.x)));
  }
  assert.ok(gaps.size >= 3, `纵向间距只有这几种：${[...gaps].join('、')}`);
  assert.ok(xs.size >= 2, `横向位置也没变化：${[...xs].join('、')}`);
});

test('城市到各自底线的平均距离：上半区与下半区一样', () => {
  // 2026-10-29 修的真 bug：两边的纵深窗口不是镜像的——近侧只有 1~2 格（城只能贴着
  // 自己的边），远侧从"前线"一直到对面底线（把整张图的余量一个人吃了）。
  // 结果上半区的城离上边平均 1.5 格、下半区的城离下边平均 3.3 格，32×32 上差 3.3 格：
  // 同一张图上，一边被逼在墙角，另一边坐拥纵深。
  //
  // 现在两侧的"能退几格"由同一个 pad 反推（见 planCities），而且两侧**共用同一组纵深**
  // ——组里可能有一个"退一格"的名额，但两个半区拿到的是同一组数，只是顺序不同。
  // 所以不光均值逐图相等，连多重集都逐图相等，不是"统计上差不多"。
  for (const size of [12, 16, 20, 32]) {
    for (const symmetry of ['fair', 'mirror'] as const) {
      let sumLo = 0;
      let nLo = 0;
      let sumHi = 0;
      let nHi = 0;
      let staggered = 0;
      for (let i = 0; i < 40; i++) {
        const m = generateLayout(size, 770000 + i * 131 + size, ['militia'], { symmetry });
        // 城市纵深跟河走：横河量 y，纵河量 x（与 planCities 的 along 同一个约定）
        const axis = m.style === 'river-v' ? 'v' : 'h';
        const along = axis === 'h' ? m.h : m.w;
        const span = 2;
        let lo = 0;
        let nlo = 0;
        let hi = 0;
        let nhi = 0;
        const loDepth: number[] = [];
        const hiDepth: number[] = [];
        const depthOf = (a: number) => (a <= along - a - span ? a : along - a - span);
        for (const p of [...m.citiesA, ...m.citiesB]) {
          const a = axis === 'h' ? p.y : p.x;
          const toLo = a; // 到上/左底线之间的空格数
          const toHi = along - a - span; // 到下/右底线之间的空格数
          if (toLo <= toHi) {
            lo += toLo;
            nlo += 1;
            loDepth.push(toLo);
          } else {
            hi += toHi;
            nhi += 1;
            hiDepth.push(toHi);
          }
        }
        assert.ok(nlo > 0 && nhi > 0, `${size}×${size} 应该有城落在两半区`);
        assert.equal(
          lo / nlo,
          hi / nhi,
          `${size}×${size} ${symmetry} 第 ${i} 张：上边均值 ${lo / nlo}、下边均值 ${hi / nhi}`,
        );
        // 均值相等还不够：如果一边全在 2、另一边一个 1 一个 3，均值也相等，但那不是
        // "共用一组纵深"，是两拨不一样的数碰巧加起来一样。这里比的是排好序的多重集。
        assert.deepEqual(
          [...loDepth].sort((x, y) => x - y),
          [...hiDepth].sort((x, y) => x - y),
          `${size}×${size} ${symmetry} 第 ${i} 张：两侧的纵深多重集不一样，` +
            `上边 [${loDepth.join(',')}]、下边 [${hiDepth.join(',')}]`,
        );
        // "错开一行"是指**同一侧的两座城**不并排（多重集里那个"退一格"的名额生效了），
        // 不是拿上半区的顺序去比下半区：镜像图上两侧本来就照着同一顺序排，
        // 那样的比较永远相等，测不出任何东西。
        const depthSet = new Set(
          m.citiesA.map((p) => depthOf(axis === 'h' ? p.y : p.x)),
        );
        if (depthSet.size > 1) staggered += 1;
        sumLo += lo;
        nLo += nlo;
        sumHi += hi;
        nHi += nhi;
      }
      assert.ok(
        Math.abs(sumLo / nLo - sumHi / nHi) < 0.01,
        `${size}×${size} ${symmetry}：整体也歪了`,
      );
      // 若某天有人把纵深改回"两侧共用同一个值"，这条会在 40 张图上全部落空
      // （退一格是按对半概率抽的，40 张一张都不错开的概率是 2^-40）。
      assert.ok(
        staggered > 0,
        `${size}×${size} ${symmetry}：40 张图里没有一张把同一侧的两座城错开过，` +
          `多半是纵深又退回"整侧只有同一个值"了`,
      );
    }
  }
});

test('地图会出现不止一种地貌', () => {
  const styles = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) styles.add(generateLayout(16, seed).style);
  assert.ok(styles.size >= 3, `40 张图只有这些地貌：${[...styles].join('、')}`);
});

test('城市布局有对峙也有对角，跟河的走向互不相干', () => {
  // 以前是"横河 → 南北分家，纵河 → 东西分家"，纵河不过是把横河转 90 度。
  // 现在布局单独抽签，所以纵河也会出现"两边各占一对对角"。
  const combo = new Map<string, number>();
  for (let seed = 1; seed <= 60; seed++) {
    for (const style of ['river-h', 'river-v'] as const) {
      const m = generateLayout(16, seed * 31 + 7, ['militia'], { style });
      const k = `${style}/${m.layout}`;
      combo.set(k, (combo.get(k) ?? 0) + 1);
    }
  }
  for (const k of ['river-h/split', 'river-h/diagonal', 'river-v/split', 'river-v/diagonal']) {
    assert.ok((combo.get(k) ?? 0) >= 8, `${k} 只出现了 ${combo.get(k) ?? 0} 次，布局和河走向还是绑在一起的`);
  }

  // 对角布局下，同一方两座城分别落在一对对角上
  const m = generateLayout(16, 5, ['militia'], { style: 'river-h' });
  if (m.layout === 'diagonal') {
    const [a0, a1] = m.citiesA;
    assert.ok(a0 && a1);
    assert.notEqual(a0.y, a1.y, '对角布局里同一方两座城不该在同一行');
    assert.notEqual(a0.x, a1.x, '对角布局里同一方两座城不该在同一列');
  }
});

test('河道能长成成片的大水域，不是零散水坑', () => {
  // 关键指标不是"水格总数"，而是"最大连通水体"：
  // 零散沼泽式的水也能凑出不少格子，但连不成一条河。
  for (const style of ['river-h', 'river-v'] as const) {
    let total = 0;
    let largest = 0;
    let maxRatio = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const m = generateLayout(16, seed * 53 + 11, ['militia'], { style });
      const seen = new Set<number>();
      let best = 0;
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          const i0 = y * m.w + x;
          if (seen.has(i0) || m.rows[y]?.[x] !== '~') continue;
          const stack = [i0];
          seen.add(i0);
          let size = 0;
          while (stack.length > 0) {
            const i = stack.pop() as number;
            size += 1;
            const cx = i % m.w;
            const cy = (i - cx) / m.w;
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const) {
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
              const j = ny * m.w + nx;
              if (seen.has(j) || m.rows[ny]?.[nx] !== '~') continue;
              seen.add(j);
              stack.push(j);
            }
          }
          best = Math.max(best, size);
        }
      }
      total += best;
      largest = Math.max(largest, best);
      maxRatio = Math.max(maxRatio, best / (m.w * m.h));
    }
    const avg = total / 30;
    assert.ok(avg >= 25, `${style} 的最大水体平均只有 ${avg.toFixed(1)} 格，还是碎的`);
    assert.ok(largest >= 40, `${style} 里最大的水体只有 ${largest} 格，撑不起"大河"`);
    assert.ok(maxRatio >= 0.2, `${style} 最大水体只占 ${(maxRatio * 100).toFixed(0)}%`);
  }
});

test('每方都有足够的出生点', () => {
  for (const size of [12, 16, 20]) {
    for (let seed = 1; seed <= 20; seed++) {
      const layout = generateLayout(size, seed);
      assert.ok(layout.spawnsA.length >= 5, `${size} seed=${seed} A 方只有 ${layout.spawnsA.length} 个出生点`);
      assert.ok(layout.spawnsB.length >= 5, `${size} seed=${seed} B 方只有 ${layout.spawnsB.length} 个出生点`);
    }
  }
});

test('同一个种子永远生成同一张地图', () => {
  const a = generateLayout(16, 777);
  const b = generateLayout(16, 777);
  assert.deepEqual(a.rows, b.rows);
  assert.deepEqual(a.citiesA, b.citiesA);
});

test('不同种子生成不同的地图', () => {
  const a = generateLayout(16, 1);
  const b = generateLayout(16, 2);
  assert.notDeepEqual(a.rows, b.rows);
});

test('城市占 4 格并标记 cityId', () => {
  const s = fresh();
  assert.equal(s.tiles.filter((t) => t.terrain === 'city').length, 16);
  for (const city of s.cities) {
    for (const t of cityTiles(city)) {
      const tile = s.tiles[idx(s, t.x, t.y)];
      assert.equal(tile.terrain, 'city');
      assert.equal(tile.cityId, city.id);
    }
  }
});

test('只启用部分兵种时，开局部队也只含这些兵种', () => {
  const s = fresh({ enabledUnits: ['militia', 'archer'] });
  assert.deepEqual(Object.keys(s.unitTypes).sort(), ['archer', 'militia']);
  for (const u of s.units) {
    assert.ok(['militia', 'archer'].includes(u.type), `出现了没启用的兵种 ${u.type}`);
  }
});

console.log('\n移动');

test('可达格里不会出现水', () => {
  const s = fresh();
  for (const u of s.units) {
    const reach = reachableTiles(s, u);
    for (const i of reach.keys()) {
      assert.notEqual(s.tiles[i].terrain, 'water', `${u.id} 的可达集里有水格`);
    }
  }
});

test('移动力按地形消耗计算', () => {
  const s = fresh();
  const u = findUnit(s, 'A', 'militia');
  const budget = movePower(s, u);
  const reach = reachableTiles(s, u);
  for (const [i, cost] of reach) {
    assert.ok(cost <= budget, `格 ${i} 消耗 ${cost} 超过移动力 ${budget}`);
  }
});

test('敌方城市格不可通行', () => {
  const s = fresh();
  const u = findUnit(s, 'A', 'scout');
  const enemyCity = citiesOf(s, 'B')[0];
  assert.ok(enemyCity);
  u.x = enemyCity.x - 1;
  u.y = enemyCity.y;
  // 保证起点不在水里
  s.tiles[idx(s, u.x, u.y)].terrain = 'plain';
  assert.equal(distToCity(u, enemyCity), 1);
  const reach = reachableTiles(s, u);
  for (const t of cityTiles(enemyCity)) {
    assert.ok(!reach.has(idx(s, t.x, t.y)), '城池得先打下来才能进');
  }
});

test('己方城市格可以进驻', () => {
  const s = fresh();
  const u = findUnit(s, 'A', 'militia');
  const ownCity = citiesOf(s, 'A')[0];
  assert.ok(ownCity);
  u.x = ownCity.x;
  u.y = ownCity.y + ownCity.size;
  s.tiles[idx(s, u.x, u.y)].terrain = 'plain';
  const reach = reachableTiles(s, u);
  assert.ok(reach.has(idx(s, ownCity.x, ownCity.y)), '自己城里应该能站人');
});

test('移动后不可再动，且原状态不被修改', () => {
  const s = fresh();
  const u = findUnit(s, 'A', 'militia');
  const reach = reachableTiles(s, u);
  const target = Array.from(reach.keys())[0];
  assert.ok(target !== undefined, '找不到可走的格子');
  const { x, y } = { x: target % s.w, y: Math.floor(target / s.w) };

  const before = JSON.stringify(s);
  const r = applyAction(s, { type: 'MOVE', unitId: u.id, x, y });
  assert.ok(r.ok);
  assert.equal(JSON.stringify(s), before, '原状态必须保持不变');
  assert.equal(r.state.units.find((n) => n.id === u.id)?.moved, true);
  assert.equal(
    applyAction(r.state, { type: 'MOVE', unitId: u.id, x: u.x, y: u.y }).ok,
    false,
    '同一回合不能移动两次',
  );
});

console.log('\n战斗');

test('伤害等于攻击减去护甲', () => {
  const s = fresh();
  const { a, b } = duel(s);
  assert.equal(computeDamage(s, a, b), UNIT_TYPES.militia.atk - UNIT_TYPES.militia.armor);
});

test('地形加成算进守方护甲', () => {
  const s = fresh();
  const { a, b } = duel(s);
  const onPlain = computeDamage(s, a, b);
  s.tiles[idx(s, b.x, b.y)].terrain = 'hill';
  const onHill = computeDamage(s, a, b);
  assert.equal(onPlain - onHill, CONFIG.terrainDef.hill);
});

test('伤害永不低于 1', () => {
  const s = fresh();
  // 地形防御是要算进去的（丘陵 +3），这里验证的是"开局部队之间不会出现 0 伤害"，
  // 所以先把每个人脚下的地形抹平，免得测的是地形不是兵种
  for (const u of s.units) s.tiles[idx(s, u.x, u.y)].terrain = 'plain';
  for (const a of s.units) {
    for (const b of s.units) {
      if (a.owner === b.owner) continue;
      assert.ok(computeDamage(s, a, b) >= 1);
    }
  }
});

test('攻击造成伤害并触发反击', () => {
  const s = fresh();
  const { a, b } = duel(s);
  const maxHp = UNIT_TYPES.militia.maxHp;
  const dmg = UNIT_TYPES.militia.atk - UNIT_TYPES.militia.armor;
  const r = applyAction(s, { type: 'ATTACK', unitId: a.id, targetId: b.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.find((n) => n.id === b.id)?.hp, maxHp - dmg);
  assert.equal(
    r.state.units.find((n) => n.id === a.id)?.hp,
    maxHp - Math.round(dmg * CONFIG.counterAttackRatio),
  );
});

test('远程单位站在射程外输出不吃反击', () => {
  const s = fresh();
  const archer = findUnit(s, 'A', 'archer');
  const target = findUnit(s, 'B', 'militia');
  archer.x = 5;
  archer.y = 6;
  target.x = 5;
  target.y = 4;
  assert.equal(distance(archer, target), 2);
  const r = applyAction(s, { type: 'ATTACK', unitId: archer.id, targetId: target.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.find((n) => n.id === archer.id)?.hp, utype(s, archer.type).maxHp);
});

test('打死单位后从棋盘移除', () => {
  const s = fresh();
  const { a, b } = duel(s);
  b.hp = 3;
  const r = applyAction(s, { type: 'ATTACK', unitId: a.id, targetId: b.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.some((n) => n.id === b.id), false);
});

console.log('\n攻城');

test('攻城伤害等于攻击减城市护甲', () => {
  const s = fresh();
  const cav = findUnit(s, 'A', 'scout');
  const city = citiesOf(s, 'B')[0];
  assert.ok(city);
  // 这个兵没有魔法段、也没有状态加成才轮得到这个等式；有魔法段的见下一条
  assert.equal(damageToCity(cav, city, s), UNIT_TYPES.scout.atk - city.armor);
});

test('攻城和野战走同一套公式：魔法段、威吓都算到城墙头上', () => {
  const s = fresh({ expansionIds: ['fantasy-core', 'fantasy-heroes'] });
  const city = citiesOf(s, 'B')[0]!;
  for (const [x, y] of [[3, 5], [4, 5]]) s.tiles[idx(s, x, y)]!.terrain = 'plain';
  const mage = place2(s, 'A', 'archmage', 3, 5);
  const def = s.unitTypes.archmage!;

  // 前提：至尊法师攻 0，物理段被城墙吃干净——改之前攻城伤害就是 0
  assert.equal(Math.max(0, def.atk - city.armor), 0);
  assert.equal(
    damageToCity(mage, city, s),
    def.magicAtk,
    '魔法段要原样打到城墙上（城没有魔抗），不然法师攻城等于没带兵',
  );

  // 威吓：贴着会吓人的敌人，攻城那一下也要少打（削的是物理段，和野战一致）
  s.unitTypes['test-scarer'] = {
    id: 'test-scarer',
    name: '试吓兵',
    short: '吓',
    era: 1,
    category: 'combat',
    cost: 10,
    move: 2,
    atk: 0,
    armor: 0,
    maxHp: 50,
    range: 1,
    vision: 3,
    abilities: ['fear'], // 光环挂在能力上（见 ability-registry 的 aurasOf）
  };
  const cav = place2(s, 'A', 'scout', 4, 4);
  const clean = Math.max(0, s.unitTypes.scout!.atk - city.armor);
  assert.equal(damageToCity(cav, city, s), clean, '没有威吓时是"攻击 − 城墙护甲"');

  const scarer = place2(s, 'B', 'test-scarer', 4, 5); // 贴着斥候（曼哈顿 1 格）
  assert.equal(scarer.owner, 'B');
  assert.equal(fearPenalty(s, cav), 2, '一层威吓 2 点');
  assert.equal(
    damageToCity(cav, city, s),
    Math.max(0, clean - 2),
    '被威吓的部队攻城，威吓那 2 点要扣掉——这里以前是另一套账',
  );
});

test('大型目标挨溅射只结算一次，不按占的格子数翻倍', () => {
  const s = arena(fresh({ godMode: true }));
  for (let x = 3; x <= 8; x++) {
    for (let y = 4; y <= 7; y++) s.tiles[idx(s, x, y)]!.terrain = 'plain';
  }

  const boom: UnitTypeDef = {
    id: 'test-boom',
    name: '试炮',
    short: '炮',
    era: 1,
    category: 'combat',
    cost: 10,
    move: 0,
    atk: 40,
    armor: 0,
    maxHp: 100,
    range: 4,
    vision: 5,
    splash: 2,
    abilities: [],
  };
  const big: UnitTypeDef = {
    ...boom,
    id: 'test-big',
    name: '试大件',
    short: '大',
    atk: 0,
    splash: undefined,
    footprint: 2,
    maxHp: 300,
  };
  s.unitTypes[boom.id] = boom;
  s.unitTypes[big.id] = big;

  const gun = place2(s, 'A', 'test-boom', 3, 5);
  const small = place2(s, 'B', 'militia', 5, 5); // 主目标
  const large = place2(s, 'B', 'test-big', 6, 5); // 2×2，四格里有两格在爆心旁
  s.current = 'A';
  small.hp = 500;
  large.hp = 300;

  const per = Math.floor(computeDamage(s, gun, large) * CONFIG.splashRatio);
  assert.ok(per > 0, '这个用例的前提是溅射真的打得动它');

  const r = applyAction(s, { type: 'ATTACK', unitId: gun.id, targetId: small.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const after = r.state.units.find((u) => u.id === large.id)!;
  assert.equal(
    large.hp - after.hp,
    per,
    `大型目标占 4 格，但只该挨一份溅射：掉 ${large.hp - after.hp}，应为 ${per}`,
  );
});

test('耐久打空变废墟、守军被逐出城外，派兵入驻并付费才易主', () => {
  const s = fresh();
  const cav = findUnit(s, 'A', 'scout');
  const city = citiesOf(s, 'B')[0];
  assert.ok(city);
  city.hp = 5;
  cav.x = city.x + city.size;
  cav.y = city.y;
  s.tiles[idx(s, cav.x, cav.y)].terrain = 'plain';

  const garrison = findUnit(s, 'B', 'militia');
  garrison.x = city.x;
  garrison.y = city.y;
  s.tiles[idx(s, garrison.x, garrison.y)].terrain = 'city';

  const r = applyAction(s, { type: 'SIEGE', unitId: cav.id, cityId: city.id });
  assert.ok(r.ok);
  const after = cityById(r.state, city.id);
  // 破城不等于易主：城还是 B 的，只是成了废墟
  assert.equal(after?.owner, 'B', '破城之后城不该直接归攻方');
  assert.equal(after?.ruined, true, '应该变成废墟');
  assert.equal(after?.hp, 0, '废墟没有耐久');
  // 城破了，人还在：守军会被挤出城去，而不是跟着城墙一起没
  const survivor = r.state.units.find((n) => n.id === garrison.id);
  assert.ok(survivor, '守军不该随城陷落');
  const stillInside = cityTiles(after!).some((t) => t.x === survivor.x && t.y === survivor.y);
  assert.equal(stillInside, false, '守军应该被逐到城外，不能留在废墟里占着城格');

  // 派兵走进去接管：要付重建费
  const push = findUnit(r.state, 'A', 'scout');
  assert.ok(push);
  // 攻城把它的行动用掉了；这里直接复位，测的是"入驻"这段逻辑本身
  push.moved = false;
  push.acted = false;
  const goldBefore = r.state.players.A.gold;
  const cost = rebuildCost(after!);
  assert.ok(goldBefore >= cost, '这个用例需要 A 掏得起重建费');
  const move = applyAction(r.state, { type: 'MOVE', unitId: push.id, x: city.x, y: city.y });
  assert.ok(move.ok, move.ok ? '' : `入驻失败：${move.reason}`);
  const taken = cityById(move.state, city.id);
  assert.equal(taken?.owner, 'A', '入驻之后才易主');
  assert.equal(taken?.ruined, false, '接管后不再是废墟');
  assert.equal(move.state.players.A.gold, goldBefore - cost, '应该扣掉重建费');
});

test('丢光所有城市即判负（哪怕还有一支军队）', () => {
  const s = fresh();
  // A 还有兵，但一座城都没有了
  s.cities = s.cities.filter((c) => c.owner !== 'A');
  assert.ok(unitsOf(s, 'A').length > 0, '这个用例的前提是 A 还有兵');

  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok);
  assert.equal(r.state.winner, 'B', '城丢光了就该判负，不能靠军队苟着');
});

test('没兵又没粮：金币再多也翻不了盘（判负按真实造价算）', () => {
  // 不带 godMode：上帝模式走沙盒分支，不结算胜负
  const s = fresh({ expansionIds: ['city-works'] });
  s.units = s.units.filter((u) => u.owner !== 'A');
  // 金币管够，但粮和材是 0 —— 现在这两样才是主成本，一支兵都造不出来
  s.players.A.gold = 9999;
  s.players.A.res = { food: 0, material: 0 };
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.state.winner, 'B', '粮材为 0 就造不出任何兵，该判负，不能拿着金币干耗');
});

test('不能攻城自己的城市', () => {
  const s = fresh();
  const cav = findUnit(s, 'A', 'scout');
  const own = citiesOf(s, 'A')[0];
  assert.ok(own);
  cav.x = own.x;
  cav.y = own.y + own.size;
  assert.equal(applyAction(s, { type: 'SIEGE', unitId: cav.id, cityId: own.id }).ok, false);
});

test('城市位置是浮动的，不再是矩形四角', () => {
  let rect = 0;
  let n = 0;
  const sigs = new Set<string>();
  for (let seed = 1; seed <= 80; seed++) {
    const m = generateLayout(16, seed * 37 + 11);
    const all = [...m.citiesA, ...m.citiesB];
    const xs = new Set(all.map((c) => c.x));
    const ys = new Set(all.map((c) => c.y));
    // 矩形四角的特征：只有两个不同的 x 和两个不同的 y
    if (xs.size === 2 && ys.size === 2) rect += 1;
    sigs.add(all.map((c) => `${c.x},${c.y}`).sort().join('|'));
    n += 1;
  }
  assert.ok(rect / n < 0.2, `还有 ${rect}/${n} 张图是标准的矩形四角，浮动没生效`);
  assert.ok(sigs.size > n * 0.8, `布局太单一：${sigs.size}/${n} 种`);
});

test('浮动之后平均间距没变', () => {
  // 老公式在 12×12 上的期望：gap 均匀取 4/5/6，两军距离 = 2 + gap，
  // 也就是 6、6、7、7、8 五种取值的平均 = 7.0。位置浮动不该动这个数。
  //
  // 2026-10-26：间距规则改成"最短边 1/4"之后，12×12 的硬下限从 4 降到 3
  // （3 正好是 12/4），对角布局里两岸的敌我城可以合法地落在 5 格上，
  // 平均值因此从 7.0 挪到 6.56 —— 下限放宽了，平均值理应跟着动一点。
  // 这里把带宽放到 6.3~7.6，仍然盯着"别整体塌下来"。
  let sum = 0;
  const n = 120;
  for (let i = 0; i < n; i++) {
    const m = generateLayout(12, 20260000 + i * 7919 + 12 * 31 + 1);
    let best = Infinity;
    for (const a of m.citiesA) {
      for (const b of m.citiesB) {
        best = Math.min(best, Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
      }
    }
    sum += best;
  }
  const avg = sum / n;
  assert.ok(avg >= 6.3 && avg <= 7.6, `12×12 平均最近敌我距离 ${avg.toFixed(2)}，偏离 7.0 太多`);
});

test('反击次数：打满上限后不再反击，下一个大回合恢复', () => {
  const s = fresh({ godMode: true });
  
  // 清理地形，防止这几格刚好是高山、水或敌方城市导致攻击失败
  for (const [x, y] of [[4, 6], [5, 6], [6, 6], [7, 6]]) {
    s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
  }

  // 靶子：双刀流（burst: 2），0 护甲，1000 血
  s.unitTypes['double-hitter'] = { ...s.unitTypes.militia, id: 'double-hitter', armor: 0, maxHp: 1000, burst: 2, abilities: [] };
  // 攻击方：单次攻击
  s.unitTypes['single-hitter'] = { ...s.unitTypes.militia, id: 'single-hitter', armor: 0, maxHp: 1000, abilities: [] };
  
  const t1 = place2(s, 'B', 'double-hitter', 5, 6);
  const t2 = place2(s, 'A', 'single-hitter', 4, 6);
  const a1 = place2(s, 'A', 'single-hitter', 6, 6);
  
  let st = { ...s, current: 'A' as const, units: [a1, t2, t1] };
  
  // A 的 a1 打 B 的 t1。t1 会反击 1 次。
  let r = applyAction(st, { type: 'ATTACK', unitId: a1.id, targetId: t1.id });
  assert.ok(r.ok, r.ok ? '' : r.reason); // ⬅️ 失败时打印具体原因
  
  let defender = r.state.units.find(u => u.id === t1.id)!;
  assert.equal(defender.countersLeft, 1, '防守方反击了一次，次数应减 1');
  
  // A 的 t2 打 B 的 t1。t1 还能反击 1 次。
  r = applyAction(r.state, { type: 'ATTACK', unitId: t2.id, targetId: t1.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  
  defender = r.state.units.find(u => u.id === t1.id)!;
  assert.equal(defender.countersLeft, 0, '防守方次数耗尽');
  
  // 新增第三个攻击者，注意 place2 已经把它塞进 s.units 了，绝对不能再 push 一次
  const a3 = place2(r.state, 'A', 'single-hitter', 5, 5);
  r = applyAction(r.state, { type: 'ATTACK', unitId: a3.id, targetId: t1.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  
  assert.equal(r.state.units.find(u => u.id === a3.id)!.hp, 1000, '次数耗尽后不应反击');
  
  // 结束回合，到 B 的回合，再回到 A 的回合。次数重置。
  const end1 = applyAction(r.state, { type: 'END_TURN' });
  assert.ok(end1.ok);
  const end2 = applyAction(end1.state, { type: 'END_TURN' });
  assert.ok(end2.ok);
  
  defender = end2.state.units.find(u => u.id === t1.id)!;
  assert.equal(defender.countersLeft, undefined, '新回合应该重置');
});

console.log('\n经济与产兵');

test('产兵扣钱并在城市空格生成单位', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  const before = s.players.A.gold;
  const r = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' });
  assert.ok(r.ok);
  assert.equal(r.state.players.A.gold, before - UNIT_TYPES.militia.cost);
  const spawned = r.state.units.find(
    (u) => u.owner === 'A' && cityTiles(city).some((t) => t.x === u.x && t.y === u.y),
  );
  assert.ok(spawned);
  assert.equal(spawned.moved, true, '新兵当回合不能行动');
});

test('不能用没启用的兵种产兵', () => {
  const s = fresh({ enabledUnits: ['militia'] });
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  assert.equal(applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'knight' }).ok, false);
});

test('回合结束切换玩家并结算收入', () => {
  const s = fresh();
  const bIncome =
    CONFIG.baseIncome +
    2 * eraDef(1).cityIncome +
    s.units.filter((u) => u.owner === 'B').reduce((sum, u) => sum + unitIncome(s, u), 0);
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok);
  assert.equal(r.state.current, 'B');
  assert.equal(r.state.players.B.gold, startGoldFor(1) + bIncome);
});

test('一方全灭且无城则判负', () => {
  const s = fresh();
  s.units = s.units.filter((u) => u.owner !== 'B');
  s.players.B.gold = 0;
  for (const c of s.cities) if (c.owner === 'B') c.owner = 'A';
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok);
  assert.equal(r.state.winner, 'A');
});

console.log('\n时代');

test('城市初始都是时代 1，耐久护甲取自时代表', () => {
  const s = fresh();
  const e1 = eraDef(1);
  for (const c of s.cities) {
    assert.equal(c.era, 1);
    assert.equal(c.maxHp, e1.cityMaxHp);
    assert.equal(c.armor, e1.cityArmor);
  }
});

test('开局部队只含时代 1 的兵种', () => {
  const s = fresh();
  for (const u of s.units) {
    assert.equal(utype(s, u.type).era, 1, `${u.type} 不该出现在开局部队里`);
  }
});

test('第一回合收入对双方对称（先手也要拿到）', () => {
  // 收入是在"结束回合、把回合交给对方"时结算的，所以后手在自己还没动之前
  // 就已经拿到了第一回合的钱，先手要等自己结束回合才拿——同一个"第一回合"，
  // 先手少了一次收入。修法：开局直接给先手结算一次。
  const s = fresh();
  const gift = openingIncome(s);
  assert.ok(gift > 0, '开局应该有一次正收入');
  assert.equal(s.players.A.gold, startGoldFor(1) + gift, '先手开局金币 = 本金 + 第一回合收入');

  // A 结束回合 → B 拿到属于它的那份，两边各拿一次，谁也不多
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok);
  const bGift = r.state.players.B.gold - startGoldFor(1);
  assert.ok(bGift > 0);
  assert.ok(
    Math.abs(bGift - gift) <= 8,
    `两边第一回合收入应该差不多：先手 ${gift}，后手 ${bGift}（差额来自两家农民站的格子不同）`,
  );

  // 补上这一次收入之后，开局仍然买不起三级：第一回合最多只能做"升一档"这一个决定，
  // 不会出现"第一回合直接把科技点到三级"这种离谱开局。
  const cost3 = nextUpgradeCost(2);
  assert.ok(cost3 !== null);
  assert.ok(
    s.players.A.gold < cost3,
    `开局 ${s.players.A.gold} 金就够升到三级（需要 ${cost3}），科技会一步到位`,
  );
});

test('升级扣金币，耐久护甲时代一起涨', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.players.A.gold = 600;
  const goldBefore = s.players.A.gold;
  const r = applyAction(s, { type: 'UPGRADE', cityId: city.id });
  assert.ok(r.ok);
  const after = cityById(r.state, city.id);
  assert.equal(after?.era, 2);
  assert.equal(after?.armor, eraDef(2).cityArmor);
  assert.equal(after?.maxHp, eraDef(2).cityMaxHp);
  assert.equal(r.state.players.A.gold, goldBefore - eraDef(2).upgradeCost);
});

test('升级前造不了二级兵，升级后可以', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.players.A.gold = 400;
  assert.equal(
    applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'knight' }).ok,
    false,
    '时代 1 的城市不该能造重甲',
  );

  const up = applyAction(s, { type: 'UPGRADE', cityId: city.id });
  assert.ok(up.ok);
  const rec = applyAction(up.state, { type: 'RECRUIT', cityId: city.id, unitType: 'knight' });
  assert.ok(rec.ok, '升到时代 2 之后应该能造重甲');
});

test('升到顶级后再升会被拒绝', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  city.era = ERAS.length;
  s.players.A.gold = 99999;
  assert.equal(applyAction(s, { type: 'UPGRADE', cityId: city.id }).ok, false);
});

test('金币不够不能升级', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.players.A.gold = 10;
  assert.equal(applyAction(s, { type: 'UPGRADE', cityId: city.id }).ok, false);
});

test('只能升级自己的城市', () => {
  const s = fresh();
  const enemy = citiesOf(s, 'B')[0];
  assert.ok(enemy);
  assert.equal(applyAction(s, { type: 'UPGRADE', cityId: enemy.id }).ok, false);
});

test('城市收入随时代提高', () => {
  const base = fresh();
  const buffed = fresh();
  const city = buffed.cities.find((c) => c.owner === 'B');
  assert.ok(city);
  city.era = 2;

  const a = applyAction(base, { type: 'END_TURN' });
  const b = applyAction(buffed, { type: 'END_TURN' });
  assert.ok(a.ok && b.ok);
  assert.equal(
    b.state.players.B.gold - a.state.players.B.gold,
    eraDef(2).cityIncome - eraDef(1).cityIncome,
  );
});

test('接管废墟会连同它的时代一起接收', () => {
  const s = fresh();
  const cav = findUnit(s, 'A', 'scout');
  const city = citiesOf(s, 'B')[0];
  assert.ok(city);
  city.era = 3;
  city.hp = 5;
  cav.x = city.x + city.size;
  cav.y = city.y;
  s.tiles[idx(s, cav.x, cav.y)].terrain = 'plain';

  const r = applyAction(s, { type: 'SIEGE', unitId: cav.id, cityId: city.id });
  assert.ok(r.ok);

  const push = findUnit(r.state, 'A', 'scout');
  assert.ok(push);
  push.moved = false;
  push.acted = false;
  const move = applyAction(r.state, { type: 'MOVE', unitId: push.id, x: city.x, y: city.y });
  assert.ok(move.ok, move.ok ? '' : `入驻失败：${move.reason}`);
  const after = cityById(move.state, city.id);
  assert.equal(after?.owner, 'A');
  assert.equal(after?.era, 3, '时代跟着城市一起易主');
});

console.log('\n建筑与经济单位');

/** 造一个建造者摆到地图中央，周围清干净，避免受开局部署干扰 */
function addLaborer(s: GameState, owner: 'A' | 'B' = 'A'): Unit {
  const u: Unit = {
    id: `lab-${owner}`,
    type: 'laborer',
    owner,
    x: 5,
    y: 5,
    hp: 20,
    kills: 0,
    moved: false,
    acted: false,
  };
  // 城市和河的位置都是浮动的，中央这块地可能被水淹、被山压。
  // 建造测试只关心"能不能建"，所以先把建造范围（含超范围那一格）清成平地。
  for (let y = 4; y <= 6; y++) {
    for (let x = 3; x <= 11; x++) {
      const t = s.tiles[idx(s, x, y)];
      if (t && !t.cityId) t.terrain = 'plain';
    }
  }
  s.units.push(u);
  s.units = s.units.filter((x) => x.id === u.id || distance(x, u) > 3);
  s.players[owner].gold = 1000;
  for (const t of s.tiles) {
    if (t.terrain === 'forest' || t.terrain === 'hill') t.terrain = 'plain';
  }
  return u;
}

/** 清出一块干净地面：抹平地形（保留城市格）、把站在上面的单位挪走 */
function clearArea(s: GameState, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = s.tiles[idx(s, x, y)];
      if (t && !t.cityId) t.terrain = 'plain';
    }
  }
  s.units = s.units.filter((u) => !(u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1));
}

test('建筑必须由建造单位修建，普通兵不行', () => {
  const s = fresh();
  const builder = addLaborer(s);

  const militia = findUnit(s, 'A', 'militia');
  militia.x = 6;
  militia.y = 6;
  assert.equal(
    applyAction(s, { type: 'BUILD', unitId: militia.id, unitType: 'tower', x: 7, y: 6 }).ok,
    false,
    '民兵不会建造',
  );

  const r = applyAction(s, { type: 'BUILD', unitId: builder.id, unitType: 'tower', x: 6, y: 5 });
  assert.ok(r.ok, '劳工应该能建箭塔');
  const tower = r.state.units.find((u) => u.type === 'tower');
  assert.ok(tower, '塔应该出现在目标格');
  assert.equal(tower.x, 6);
  assert.equal(r.state.units.find((u) => u.id === builder.id)?.acted, true, '建造占掉整回合');
});

test('建造者不会建不属于它的建筑', () => {
  const s = fresh();
  const builder = addLaborer(s);
  // 劳工只会建箭塔和磨坊，不会建石堡
  assert.equal(
    applyAction(s, { type: 'BUILD', unitId: builder.id, unitType: 'keep', x: 6, y: 5 }).ok,
    false,
  );
});

test('建筑不可移动', () => {
  const s = fresh();
  const builder = addLaborer(s);
  const r = applyAction(s, { type: 'BUILD', unitId: builder.id, unitType: 'tower', x: 6, y: 5 });
  assert.ok(r.ok);
  const tower = r.state.units.find((u) => u.type === 'tower');
  assert.ok(tower);
  assert.equal(movePower(r.state, tower), 0);
  assert.equal(reachableTiles(r.state, tower).size, 0, '建筑的可达集必须为空');
});

test('建造者离得太远不能建', () => {
  const s = fresh();
  const builder = addLaborer(s);
  const r = applyAction(s, { type: 'BUILD', unitId: builder.id, unitType: 'tower', x: 9, y: 5 });
  assert.equal(r.ok, false, `超出 ${CONFIG.buildRange} 格不该能建`);
});

test('自家设施能站人：塔那一格不再是洞', () => {
  const s = fresh();
  const builder = addLaborer(s);
  const built = applyAction(s, { type: 'BUILD', unitId: builder.id, unitType: 'tower', x: 6, y: 5 });
  assert.ok(built.ok);
  const tower = built.state.units.find((u) => u.type === 'tower');
  assert.ok(tower);

  const m = findUnit(built.state, 'A', 'militia');
  m.x = 6;
  m.y = 6;
  m.moved = false;
  m.acted = false;

  assert.ok(reachableTiles(built.state, m).has(idx(built.state, 6, 5)), '塔那一格应该算可达');
  const r = applyAction(built.state, { type: 'MOVE', unitId: m.id, x: 6, y: 5 });
  assert.ok(r.ok, r.ok ? '' : `上塔失败：${r.reason}`);
  assert.equal(unitAt(r.state, 6, 5)?.id, m.id, 'unitAt 应该返回站上来的兵，而不是塔本身');
  assert.equal(buildingAt(r.state, 6, 5)?.id, tower.id, '塔还在那儿，只是上面多了个人');
});

test('障碍类建筑谁都上不去，连自己人也不行', () => {
  const s = fresh();
  // 本局没开扩展包，临时塞一个城墙定义：规则只认 obstacle 这个标记
  s.unitTypes.testwall = {
    id: 'testwall',
    name: '城墙',
    short: '墙',
    era: 1,
    category: 'building',
    cost: 90,
    move: 0,
    atk: 0,
    armor: 8,
    maxHp: 80,
    range: 1,
    vision: 1,
    obstacle: true,
  };
  s.units.push({ id: 'wall-1', type: 'testwall', owner: 'A', x: 6, y: 5, hp: 80, kills: 0, moved: false, acted: false });

  const m = findUnit(s, 'A', 'militia');
  m.x = 6;
  m.y = 6;
  m.moved = false;
  m.acted = false;

  assert.equal(reachableTiles(s, m).has(idx(s, 6, 5)), false, '墙不能当落点');
  assert.equal(applyAction(s, { type: 'MOVE', unitId: m.id, x: 6, y: 5 }).ok, false, '停在墙上应该被拒');
});

test('敌方设施不能站，得先打掉', () => {
  const s = fresh();
  const built = applyAction(s, { type: 'BUILD', unitId: addLaborer(s).id, unitType: 'tower', x: 6, y: 5 });
  assert.ok(built.ok);
  const tower = built.state.units.find((u) => u.type === 'tower');
  assert.ok(tower);
  tower.owner = 'B'; // 变成敌方塔

  const m = findUnit(built.state, 'A', 'militia');
  m.x = 6;
  m.y = 6;
  m.moved = false;
  m.acted = false;

  assert.equal(reachableTiles(built.state, m).has(idx(built.state, 6, 5)), false, '敌方塔不该是落点');
});

test('建筑在敌方回合开始时自动开火', () => {
  const s = fresh();
  // 直接摆一座塔：这条测开火节奏，施工进度由「箭塔」那条负责。
  // 建造点数上线之后，塔不再是一个 BUILD 就立起来的。
  const tower = place2(s, 'A', 'tower', 6, 5);
  const enemy = s.units.find((u) => u.owner === 'B');
  assert.ok(tower && enemy);

  enemy.x = tower.x + 1;
  enemy.y = tower.y;
  s.tiles[idx(s, enemy.x, enemy.y)].terrain = 'plain';
  const hpBefore = enemy.hp;

  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok);
  const after = r.state.units.find((u) => u.id === enemy.id);
  assert.ok(after, '一炮打不死，应该还活着');
  assert.ok((after?.hp ?? 0) < hpBefore, '应该被塔打掉血');
});

test('建筑手动开过火，同一回合不再自动补一炮', () => {
  const s = fresh();
  const tower = place2(s, 'A', 'tower', 6, 5);
  const enemy = s.units.find((u) => u.owner === 'B');
  assert.ok(tower && enemy);

  enemy.x = tower.x + 1;
  enemy.y = tower.y;
  s.tiles[idx(s, enemy.x, enemy.y)].terrain = 'plain';
  // 血给厚一点：一炮打不死，才数得清"一共打了几段"
  enemy.hp = 500;

  // 第 1 段：塔刚立起来那回合不能手动（acted），由自动开火代劳
  const endA = applyAction(s, { type: 'END_TURN' });
  if (!endA.ok) assert.fail(endA.reason);
  const afterAuto = endA.state.units.find((u) => u.id === enemy.id);
  assert.ok(afterAuto && afterAuto.hp < 500, '自动开火这一段应该成立');

  // 回到 A 的回合，塔重置完就能手动了
  const endB = applyAction(endA.state, { type: 'END_TURN' });
  if (!endB.ok) assert.fail(endB.reason);
  const tw = endB.state.units.find((u) => u.id === tower.id);
  const foe = endB.state.units.find((u) => u.id === enemy.id);
  assert.ok(tw && foe);
  const beforeShot = foe.hp;
  const shot = applyAction(endB.state, { type: 'ATTACK', unitId: tw.id, targetId: foe.id });
  if (!shot.ok) assert.fail(shot.reason);
  const afterShot = shot.state.units.find((u) => u.id === foe.id);
  assert.ok(afterShot && afterShot.hp < beforeShot, '手动开火这一段应该成立');

  // 第 2 段不该再来：B 接手回合时，塔已经打过一炮了
  const endC = applyAction(shot.state, { type: 'END_TURN' });
  if (!endC.ok) assert.fail(endC.reason);
  const final = endC.state.units.find((u) => u.id === foe.id);
  assert.ok(final, '目标还活着');
  assert.ok(final.hp >= afterShot.hp, `手动开火后又挨了一炮：${afterShot.hp} → ${final.hp}`);
});

test('开局送两个经济单位', () => {
  const s = fresh();
  const econ = s.units.filter((u) => u.owner === 'A' && utype(s, u.type).category === 'economy');
  assert.equal(econ.length, 2, `开局经济单位数量：${econ.length}`);
});

test('经济单位按所在地形产出，城里反而不赚', () => {
  const s = fresh();
  const farmer = s.units.find((u) => u.type === 'farmer');
  assert.ok(farmer, '开局应该送农民');

  farmer.x = 5;
  farmer.y = 5;
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  const onPlain = unitIncome(s, farmer);

  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  farmer.x = city.x;
  farmer.y = city.y;
  s.tiles[idx(s, city.x, city.y)].terrain = 'city';
  const inCity = unitIncome(s, farmer);

  assert.ok(onPlain > inCity, `平原 ${onPlain} 应该高于城里 ${inCity}`);
});

test('经济单位临水有额外收入', () => {
  const s = fresh();
  const farmer = s.units.find((u) => u.type === 'farmer');
  assert.ok(farmer);
  farmer.x = 5;
  farmer.y = 5;
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 4, 5)].terrain = 'plain';

  const before = unitIncome(s, farmer);
  s.tiles[idx(s, 4, 5)].terrain = 'water';
  const after = unitIncome(s, farmer);
  assert.equal(after - before, CONFIG.riverTradeBonus);
});

test('经济建筑自己也能产金', () => {
  const s = fresh();
  const builder = addLaborer(s);
  const r = applyAction(s, { type: 'BUILD', unitId: builder.id, unitType: 'mill', x: 6, y: 5 });
  assert.ok(r.ok);
  const mill = r.state.units.find((u) => u.type === 'mill');
  assert.ok(mill);
  assert.ok(unitIncome(r.state, mill) > 0, '磨坊建在平原上应该有产出');
});

test('时代窗口只剩上界：三代城能造古典兵，但造不了还没解锁的兵', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  city.era = 3;
  s.players.A.gold = 9999;

  assert.ok(
    applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'spearman' }).ok,
    '上一个时代的兵种当然能造',
  );
  // 这条以前是反的：城市升到第三代，民兵就再也造不出来了——升级让选项变少，
  // 而玩家想要的恰恰是"三级城里还能补两个便宜的长枪兵看家"。
  assert.ok(
    applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' }).ok,
    '两个时代前的兵种也该还能造',
  );
  assert.ok(
    applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'archer' }).ok,
    '同代的古典兵一样能造',
  );

  // 上界不动：还没解锁的时代仍然拒绝，而且要说清差在哪一级
  const future = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'rifleman' });
  assert.ok(!future.ok, '工业时代的兵不该在火药城里造出来');
  assert.match(future.reason, /工业/);
});

console.log('\n时代链');

test('时代表五级打底、第六级留给「现代战争」，升级费递增', () => {
  // 表长 6，但**基础规则**只认前 5 级（BASE_MAX_ERA）：第六时代「现代」
  // 是「现代战争」包用 unlockEra 打开的，不勾那个包就永远升不上去。
  // 所以这里查两件事：表本身够长，且"不勾包的上限"正好是第五级。
  assert.equal(ERAS.length, 6);
  assert.equal(BASE_MAX_ERA, 5);
  assert.equal(ERAS[0].name, '古典');
  assert.equal(ERAS[4].name, '二战');
  assert.equal(ERAS[5].name, '现代');
  for (let i = 2; i < ERAS.length; i++) {
    const prev = ERAS[i - 1];
    const cur = ERAS[i];
    assert.ok(prev && cur);
    assert.ok(cur.upgradeCost > prev.upgradeCost, `${cur.name} 的升级费应该比上一级贵`);
    assert.ok(cur.cityMaxHp > prev.cityMaxHp, '耐久上限应该递增');
  }
});

test('内置兵种全是真实历史线，奇想兵种只在扩展里', () => {
  const names = Object.values(UNIT_TYPES).map((u) => u.name);
  assert.ok(!names.includes('龙骑兵'), '龙骑兵应该在扩展包里');
  assert.ok(!names.includes('术士'), '术士应该在扩展包里');
  // 只查基础五级：第六时代的原版兵种表是**空的**（那是刻意的，
  // 整套第六代兵在「现代战争」包里，见本文件末尾那个包）。
  for (const era of ERAS.filter((e) => e.level <= BASE_MAX_ERA)) {
    const units = Object.values(UNIT_TYPES).filter((u) => u.era === era.level);
    assert.ok(units.length >= 4, `${era.name} 时代至少要有 4 个兵种`);
    assert.ok(
      units.some((u) => u.category === 'combat'),
      `${era.name} 时代必须有战斗单位`,
    );
    assert.ok(
      units.some((u) => u.category === 'economy' || u.category === 'builder'),
      `${era.name} 时代必须有人能赚钱或者能建造`,
    );
    assert.ok(
      units.some((u) => u.category === 'building'),
      `${era.name} 时代必须有建筑`,
    );
  }
});

console.log('\n奇想兵种包：前置、机制、数值');

const FANTASY = ['fantasy-core', 'fantasy-knights', 'fantasy-beasts', 'fantasy-arcane', 'fantasy-heroes'];

/** 摆一个本局存在的兵种（含扩展包），会清掉这一格上的所有单位 */
function place2(s: GameState, owner: 'A' | 'B', type: string, x: number, y: number): Unit {
  const def = s.unitTypes[type];
  assert.ok(def, `本局没有 ${type} 这个兵种`);
  s.units = s.units.filter((k) => !(k.x === x && k.y === y));
  const u: Unit = {
    id: `k${s.nextUnitSeq++}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  };
  s.units.push(u);
  return u;
}

/**
 * 手工把单位送回"这一个回合还没动过"的状态。
 *
 * 多段改多动之后，光清 moved/acted 不够了：attacksLeft 才是"这一回合还剩几次攻击"
 * 的真相，不清它，同一个单位的第二发会被判成"没有剩余攻击次数"。
 * 需要"同一单位连打两发"的用例一律用它，别手写两行——漏一行就红。
 */
function readyAgain(u: Unit): void {
  u.moved = false;
  u.acted = false;
  delete u.attacksLeft;
}

/** 摆一个单位但**不清理**那一格：测「空中层压着地面单位」时必须用它 */
function stackOn(s: GameState, owner: 'A' | 'B', type: string, x: number, y: number): Unit {
  const def = s.unitTypes[type];
  assert.ok(def, `本局没有 ${type} 这个兵种`);
  const u: Unit = {
    id: `s${s.nextUnitSeq++}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  };
  s.units.push(u);
  return u;
}

test('前置包没开时，依赖它的兵种包整包不进場', () => {
  // 只勾骑士团、不勾法则：兵一个都不该出现，配置里也不该留着这条谎话
  const alone = fresh({ expansionIds: ['fantasy-knights'] });
  assert.equal(alone.unitTypes.swordsman, undefined, '法则没开，骑士团不该进场');
  assert.equal(alone.config.expansionIds.includes('fantasy-knights'), false);

  const both = fresh({ expansionIds: ['fantasy-core', 'fantasy-knights'] });
  assert.ok(both.unitTypes.swordsman, '两个都开才进场');
  assert.ok(both.unitTypes.mage);
  assert.equal(both.unitTypes.boneDragon, undefined);
  assert.equal(both.unitTypes['bone-dragon'], undefined, '荒兽没勾，骷髅飞龙不该在');
});

test('五个奇想包齐了，兵种 id 不重复，能力 id 都真实存在', () => {
  const packs = EXPANSIONS.filter((e) => e.id.startsWith('fantasy-'));
  assert.equal(packs.length, 5, '法则 + 骑士团 + 荒兽 + 秘法 + 英雄');
  const core = packs.find((e) => e.id === 'fantasy-core')!;
  assert.equal(core.units, undefined, '法则包只带机制，不带兵');
  for (const p of packs) {
    if (p.id === 'fantasy-core') continue;
    assert.deepEqual(p.requires, ['fantasy-core'], `${p.name} 应该依赖法则包`);
  }

  const seen = new Set<string>();
  for (const p of packs) {
    for (const u of p.units ?? []) {
      assert.ok(!seen.has(u.id), `兵种 id 重复：${u.id}`);
      seen.add(u.id);
      for (const a of u.abilities ?? []) {
        assert.ok(allAbilities().some((d) => d.id === a), `${u.name} 引用了不存在的能力 ${a}`);
      }
      assert.ok(u.era >= 1 && u.era <= ERAS.length, `${u.name} 的时代越界`);
      assert.ok(u.cost > 0, `${u.name} 的造价必须为正`);
      if (u.category === 'building') assert.equal(u.move, 0, `${u.name} 是建筑，不能动`);
    }
  }
  assert.ok(seen.size >= 55, `奇想兵种应该有五十多个，现在 ${seen.size}`);
});

test('每个奇想兵种都带至少一条机制，不是纯数值兵', () => {
  const packs = EXPANSIONS.filter((e) => e.id.startsWith('fantasy-'));
  for (const p of packs) {
    for (const u of p.units ?? []) {
      // 召唤物不受这条管：骷髅、小史莱姆、小恶魔、幻影就是"一次性的数值块"，
      // 它们的机制在召唤者身上（周期、上限、随机表）。给杂兵再挂一条能力，
      // 只会让召唤者的定位变模糊。
      if (u.summonedOnly) continue;
      const mech =
        (u.abilities ?? []).length > 0 ||
        // 飞行/掠空从能力升格成了类型字段，但它仍然是机制（而且是最贵的那条）
        u.flight === true ||
        u.layer === 'air' ||
        (u.splash ?? 0) > 0 ||
        (u.burst ?? 1) > 1 ||
        (u.magicAtk ?? 0) > 0 ||
        (u.magicRes ?? 0) > 0 ||
        !!u.element ||
        !!u.summon ||
        !!u.ammo ||
        !!u.hero ||
        !!u.decays ||
        !!u.splitInto ||
        (u.weak && Object.keys(u.weak).length > 0);
      assert.ok(mech, `${u.name} 只是一组数值，没有带任何机制`);
    }
  }
});

test('英雄包装七个英雄，外加跟班的召唤物', () => {
  const pack = EXPANSIONS.find((e) => e.id === 'fantasy-heroes')!;
  const units = pack.units ?? [];
  const heroes = units.filter((u) => u.hero === true);
  assert.equal(heroes.length, 7);
  for (const u of heroes) {
    assert.ok((u.unlockCost ?? 0) > 0, `${u.name} 应该有解锁费`);
    assert.ok((u.skills ?? []).length > 0, `${u.name} 是英雄，得有一个主动技能`);
  }
  // 大史莱姆是牢大的碎片，跟召唤者住一个包，但绝不能进产线
  const minions = units.filter((u) => u.hero !== true);
  assert.equal(minions.length, 1, '英雄包里的非英雄单位只有大史莱姆');
  assert.equal(minions[0]!.id, 'slime-giant');
  assert.equal(minions[0]!.summonedOnly, true, '大史莱姆只能被裂殖出来');
});

test('英雄血量整体上调一档，造价只跟着挪一点点', () => {
  const heroes = (EXPANSIONS.find((e) => e.id === 'fantasy-heroes')!.units ?? []).filter(
    (u) => u.hero === true,
  );
  // 只卡下限和上限，不锁具体数字：以后微调面板不该让这条测试变红，
  // 但"血被打回原样"和"贵到变成第二道钱墙"这两种退化必须拦住。
  // 召唤物（大史莱姆）不在这条的口径里：它的血是牢大的四分之一。
  for (const u of heroes) {
    assert.ok(u.maxHp >= 72, `${u.name} 只有 ${u.maxHp} 血，没吃到 ×1.2 这一档`);
    // 上限 650：至尊法师这一档（攻 -10 → 魔法 +10、甲 +4、魔抗 +4、射程 +1、
    // 视野 +1）的价格按 +50 走，640 仍在"英雄"这一档里；再往上就该另算。
    assert.ok(u.cost >= 360 && u.cost <= 650, `${u.name} 造价 ${u.cost}，涨过头或没涨`);
    // 血涨了价就得涨，否则英雄在性价比上直接压死同费普通兵
    assert.ok(u.cost > 340, `${u.name} 血涨了价没动`);
  }
});

test('跳跃：蜘蛛骑士能一跃过整条河，也能停在水面上', () => {
  const s = fresh({ expansionIds: FANTASY });
  // 挖一整列水，两侧留一格：能过去就只能是飞过去
  const cols: number[] = [];
  for (let x = 1; x < s.w - 1; x++) {
    let clear = true;
    for (let y = 0; y < s.h; y++) if (s.tiles[idx(s, x, y)].cityId) clear = false;
    if (clear) cols.push(x);
  }
  const x0 = cols[Math.floor(cols.length / 2)]!;
  for (let y = 0; y < s.h; y++) s.tiles[idx(s, x0, y)].terrain = 'water';
  s.units = s.units.filter((u) => Math.abs(u.x - x0) > 1);

  const y0 = Math.floor(s.h / 2);
  for (const y of [y0 - 1, y0, y0 + 1]) {
    s.tiles[idx(s, x0 - 1, y)].terrain = 'plain';
    s.tiles[idx(s, x0 + 1, y)].terrain = 'plain';
  }
  const spider = place2(s, 'A', 'spider-rider', x0 - 1, y0);
  // 名字要对得上画面：蜘蛛是跳过去，不是飞过去。
  // 机制一条没改（掠水、林丘按 1 步），改的只是它挂的能力 id。
  assert.ok(
    s.unitTypes['spider-rider']?.abilities?.includes('leap'),
    '蜘蛛骑士应该挂「跳跃」',
  );
  assert.equal(
    s.unitTypes['spider-rider']?.abilities?.includes('fly'),
    false,
    '不该再挂「飞行」——那是鹰和石像鬼的活',
  );
  const reach = reachableTiles(s, spider);
  assert.ok(reach.has(idx(s, x0 + 1, y0)), '蜘蛛骑士应该能跳到对岸');
  // 水面也能落脚：飞行不是"过河时不许回头"，它可以停在河中间
  assert.ok(reach.has(idx(s, x0, y0)), '水面也是合法的落点');

  // 对照：走地的照旧进不去水
  const walker = place2(s, 'A', 'swordsman', x0 - 1, y0 + 1);
  assert.ok(!reachableTiles(s, walker).has(idx(s, x0, y0)), '走地单位进不了水');
});

test('「跳跃」是一条独立能力，名字就叫跳跃', () => {
  const leap = allAbilities().find((a) => a.id === 'leap');
  assert.ok(leap, '应该有 leap 这条能力');
  assert.equal(leap!.name, '跳跃');
  assert.equal(leap!.group, 'move', '走法类，不是战斗类');
});

test('双方按颜色称呼：A 红方，B 蓝方', () => {
  const s = fresh({});
  assert.equal(s.players.A.name, '红方');
  assert.equal(s.players.B.name, '蓝方');
});

test('老存档的"我方/敌方"会被换成红蓝，自定义名不动', () => {
  const s = fresh({});
  s.players.A.name = '我方';
  s.players.B.name = '敌方';
  assert.equal(normalizePlayerNames(s), true, '旧默认名应该被替换');
  assert.equal(s.players.A.name, '红方');
  assert.equal(s.players.B.name, '蓝方');

  // 玩家自己起的名字不能被顺手改掉
  s.players.A.name = '老王';
  assert.equal(normalizePlayerNames(s), false, '没有旧默认名就不该动');
  assert.equal(s.players.A.name, '老王');
});

test('掠空：能和地面单位站在同一格，也能从同一格互相打', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[4, 5], [5, 5], [5, 6], [4, 6], [6, 5]]) {
    s.tiles[idx(s, x, y)].terrain = 'plain';
  }
  const air = place2(s, 'A', 'griffin-rider', 4, 5);
  const ground = stackOn(s, 'B', 'swordsman', 5, 5);
  assert.equal(unitsAt(s, 5, 5).length, 1);

  // 飞行单位可以把"站着敌人的格子"当成落点
  assert.ok(reachableTiles(s, air).has(idx(s, 5, 5)), '掠空要能停在敌人头顶');
  // 地面单位不行（对照组：同一张图、同样的起点）
  s.units = s.units.filter((u) => u.id !== air.id);
  const cav = place2(s, 'A', 'royal-cavalry', 4, 5);
  assert.equal(reachableTiles(s, cav).has(idx(s, 5, 5)), false, '地面兵不能停在敌军格');

  // 叠在一格之后，双方都打得到对方
  const lifted = stackOn(s, 'A', 'griffin-rider', 4, 5);
  lifted.x = ground.x;
  lifted.y = ground.y;
  assert.equal(unitsAt(s, 5, 5).length, 2, '空中 + 地面应该各占一层');
  assert.ok(canStrike(s, lifted, ground), '飞在天上也能打脚下的人');
  assert.ok(canStrike(s, ground, lifted), '脚下的人也能还手');
});

test('魔法攻击不吃护甲，只被魔法抗性挡', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';
  const mage = place2(s, 'A', 'mage', 5, 5);

  // 超级重骑 8 甲：法师物理段 7−8=0，魔法段 18−0=18
  const heavy = place2(s, 'B', 'cataphract', 5, 4);
  assert.equal(computeDamage(s, mage, heavy), 18);

  // 圣骑士 7 甲 + 4 魔抗：物理 0，魔法 18−4=14
  const paladin = place2(s, 'B', 'paladin', 5, 4);
  assert.equal(computeDamage(s, mage, paladin), 14);

  // 对照：同样攻击力全走物理的弓手，被 8 甲吃掉一大半
  const elf = place2(s, 'A', 'elf-archer', 6, 5);
  assert.equal(computeDamage(s, elf, heavy), 22 - 8);
});

test('属性弱点：巨魔怕火，同一个火属性攻击打它翻倍', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';
  const fire = place2(s, 'A', 'fire-elemental', 5, 5);
  const troll = place2(s, 'B', 'troll', 5, 4);
  const doubled = computeDamage(s, fire, troll);
  delete s.unitTypes.troll!.weak;
  const plain = computeDamage(s, fire, troll);
  assert.equal(doubled, plain * 2, '怕火的兵挨火属性应该正好翻倍');
  assert.ok(plain > 0);
});

test('中毒：打中让其中毒三回合，每回合掉 6% 生命上限', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';
  const snake = place2(s, 'A', 'serpent-man', 5, 5);
  const target = place2(s, 'B', 'swordsman', 5, 4);
  const maxHp = s.unitTypes.swordsman!.maxHp;

  const r = applyAction(s, { type: 'ATTACK', unitId: snake.id, targetId: target.id });
  assert.ok(r.ok);
  const poisoned = r.state.units.find((u) => u.id === target.id)!;
  assert.equal(poisoned.status?.poison, 3, '应该贴上三回合中毒');
  const hpAfterHit = poisoned.hp;

  // A 结束回合 → B 的回合开始，中毒立刻结算一次
  const r2 = applyAction(r.state, { type: 'END_TURN' });
  assert.ok(r2.ok);
  const ticked = r2.state.units.find((u) => u.id === target.id)!;
  assert.equal(ticked.hp, hpAfterHit - Math.ceil(maxHp * 0.06));
  assert.equal(ticked.status?.poison, 2, '结算一次之后剩两回合');
});

test('净化只清一层，大净化清全部', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 6], [6, 5]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  place2(s, 'A', 'priest', 5, 5);
  const ward = place2(s, 'A', 'swordsman', 5, 6);
  ward.status = { poison: 2, slow: 3 };
  const r1 = applyAction(s, { type: 'END_TURN' });
  assert.ok(r1.ok);
  const r2 = applyAction(r1.state, { type: 'END_TURN' });
  assert.ok(r2.ok);
  const after = r2.state.units.find((u) => u.id === ward.id)!;
  assert.equal(after.status?.poison, undefined, '净化按中毒→点燃→减速→诅咒的顺序先清中毒');
  assert.equal(after.status?.slow, 2, '一次只清一层（先被中毒扣过一回合）');

  // 大净化：半径 2 一次清空。
  // 现在没有兵永久带这条能力（天使改成主动技能了），所以这里临时挂上去，
  // 测的是"半径 2"这件事本身——隔一格的人也该被清到。
  const s2 = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [6, 5], [7, 5], [5, 6]]) s2.tiles[idx(s2, x, y)].terrain = 'plain';
  place2(s2, 'A', 'angel', 5, 5);
  s2.unitTypes.angel!.abilities = [...(s2.unitTypes.angel!.abilities ?? []), 'purge-greater'];
  const near = place2(s2, 'A', 'swordsman', 5, 6);
  const far = place2(s2, 'A', 'swordsman', 7, 5);
  near.status = { poison: 2, burn: 2, slow: 2, curse: 2 };
  far.status = { poison: 2, burn: 2 };
  const t1 = applyAction(s2, { type: 'END_TURN' });
  assert.ok(t1.ok);
  const t2 = applyAction(t1.state, { type: 'END_TURN' });
  assert.ok(t2.ok);
  const cleanNear = t2.state.units.find((u) => u.id === near.id)!;
  const cleanFar = t2.state.units.find((u) => u.id === far.id)!;
  assert.deepEqual(cleanNear.status ?? {}, {}, '贴身的人清空');
  assert.deepEqual(cleanFar.status ?? {}, {}, '隔两格也在半径内，一起清');

  // 「降临」技能：半径 3，回血 + 清空，冷却两回合
  const s3 = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [8, 5]]) s3.tiles[idx(s3, x, y)].terrain = 'plain';
  const a3 = place2(s3, 'A', 'angel', 5, 5);
  const mate = place2(s3, 'A', 'swordsman', 8, 5);
  const mateMax = s3.unitTypes.swordsman!.maxHp;
  mate.hp = 10;
  mate.status = { poison: 2, curse: 2 };
  s3.current = 'A';
  const d1 = applyAction(s3, { type: 'HERO_SKILL', unitId: a3.id, skillId: 'descend' });
  assert.ok(d1.ok, d1.ok ? '' : d1.reason);
  const healed = d1.state.units.find((u) => u.id === mate.id)!;
  assert.ok(healed.hp > 10, '隔三格的队友也吃到治疗');
  assert.equal(healed.hp, Math.min(mateMax, 10 + Math.round(mateMax * 0.2)), '降临回 20%');
  assert.deepEqual(healed.status ?? {}, {}, '负面状态一起清掉');
  assert.equal(d1.state.units.find((u) => u.id === a3.id)!.skillCd?.descend, 2, '用完进冷却');

  // 冷却没到就不能再开
  const d2 = applyAction(d1.state, { type: 'HERO_SKILL', unitId: a3.id, skillId: 'descend' });
  assert.equal(d2.ok, false);
});

test('减速扣 1 点移动、诅咒扣 2 点护甲', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';
  const cav = place2(s, 'A', 'royal-cavalry', 5, 5);
  const base = movePower(s, cav);
  cav.status = { slow: 2 };
  assert.equal(movePower(s, cav), base - 1);
  cav.status = { slow: 9 };
  assert.equal(movePower(s, cav), base - 1, '多少层减速都只扣 1 点');

  const atk = place2(s, 'B', 'swordsman', 5, 4);
  const before = computeDamage(s, atk, cav);
  cav.status = { curse: 2 };
  assert.equal(computeDamage(s, atk, cav) - before, 2, '诅咒相当于少 2 点护甲');
});

test('冲锋 / 威吓 / 吸血 / 再生 在奇想包里仍然按原规则走', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';

  // 冲锋：动过才有 +5
  const royal = place2(s, 'A', 'royal-cavalry', 5, 5);
  const tgt = place2(s, 'B', 'swordsman', 5, 4);
  const still = computeDamage(s, royal, tgt);
  royal.moved = true;
  assert.equal(computeDamage(s, royal, tgt) - still, 5);

  // 威吓：贴一个诅咒师就 −2
  stackOn(s, 'B', 'curser', 4, 5);
  s.tiles[idx(s, 4, 5)].terrain = 'plain';
  const scared = computeDamage(s, royal, tgt);
  assert.equal(scared, still + 5 - 2, '冲锋 +5 和威吓 −2 应该同时生效');

  // 吸血：真打出来的伤害换四成血
  const vamp = place2(s, 'A', 'vampire', 6, 5);
  const victim = place2(s, 'B', 'halberdier', 6, 4);
  s.tiles[idx(s, 6, 5)].terrain = 'plain';
  s.tiles[idx(s, 6, 4)].terrain = 'plain';
  vamp.hp = 20;
  const dmg = computeDamage(s, vamp, victim);
  const counter = computeDamage(s, victim, vamp, true);
  assert.ok(dmg > 0 && counter > 0);
  const r = applyAction(s, { type: 'ATTACK', unitId: vamp.id, targetId: victim.id });
  assert.ok(r.ok);
  const healed = r.state.units.find((u) => u.id === vamp.id)!;
  const maxHp = s.unitTypes.vampire!.maxHp;
  assert.equal(healed.hp, 20 - counter + Math.min(maxHp - (20 - counter), Math.round(dmg * 0.4)));

  // 再生：树人每回合回 10%
  const s2 = fresh({ expansionIds: FANTASY });
  const treant = place2(s2, 'A', 'treant', 5, 5);
  treant.hp = 30;
  const e1 = applyAction(s2, { type: 'END_TURN' });
  assert.ok(e1.ok);
  const e2 = applyAction(e1.state, { type: 'END_TURN' });
  assert.ok(e2.ok);
  const after = e2.state.units.find((u) => u.id === treant.id)!;
  assert.equal(after.hp, 30 + Math.ceil(s2.unitTypes.treant!.maxHp * 0.1));
});

test('冲锋不再穿甲', () => {
  const s = fresh();
  
  // 1. 凭空捏一个“冲锋敢死队”：攻击 10，带冲锋
  s.unitTypes['dummy-charger'] = {
    ...s.unitTypes.militia, 
    id: 'dummy-charger', 
    name: '测试冲锋兵', 
    atk: 10, 
    abilities: ['charge'] 
  };
  
  // 2. 凭空捏一个“铁疙瘩”：护甲 50，其他随便
  s.unitTypes['dummy-tank'] = {
    ...s.unitTypes.militia, 
    id: 'dummy-tank', 
    name: '测试铁疙瘩', 
    armor: 50 
  };

  // 3. 摆上场
  const atk = place2(s, 'A', 'dummy-charger', 5, 5); 
  atk.moved = true; // 触发冲锋 +5（此时它的物理攻击力是 15）
  
  const def = place2(s, 'B', 'dummy-tank', 6, 5); 
  
  // 4. 断言：15 的攻击打 50 的甲，必须被完全挡住（0 伤害）
  const dmg = computeDamage(s, atk, def);
  assert.equal(dmg, 0, '冲锋的伤害应该被护甲挡住，而不是变成真实伤害');
});

test('魔法依然无视护甲', () => {
  const s = fresh();
  
  // 1. 凭空捏一个“法师”：魔法攻击 20
  s.unitTypes['dummy-mage'] = {
    ...s.unitTypes.militia, 
    id: 'dummy-mage', 
    name: '测试法师', 
    atk: 0, 
    magicAtk: 20 
  };

  // 2. 捏一个“铁疙瘩”：护甲 50
  s.unitTypes['dummy-tank'] = {
    ...s.unitTypes.militia, 
    id: 'dummy-tank', 
    name: '测试铁疙瘩', 
    armor: 50 
  };

  // 3. 摆上场
  const atk = place2(s, 'A', 'dummy-mage', 5, 5);
  const def = place2(s, 'B', 'dummy-tank', 6, 5);
  
  // 4. 断言：物理被挡住，魔法 20 点全额穿透
  const dmg = computeDamage(s, atk, def);
  assert.equal(dmg, 20, '魔法应无视护甲打出全额');
});

test('狂暴：掉到半血以下才加攻，50%', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';
  // 目标不能带盾墙：盾墙在狂暴**之后**扣 2 点，会让"乘 1.5"这个关系对不上
  // （那个顺序是对的——狂暴放大的是攻击力，不是减免），但会让这条断言变得难读
  s.unitTypes.swordsman!.abilities = [];
  const bers = place2(s, 'A', 'berserker', 5, 5);
  const tgt = place2(s, 'B', 'swordsman', 5, 4);
  const full = computeDamage(s, bers, tgt);
  // 半血**以下**才算狂暴：maxHp 是奇数时 ceil 会落在半血之上，这里取 floor
  const half = Math.floor(s.unitTypes.berserker!.maxHp / 2);

  // 只多一点点血就不狂暴——这条边界比 1.25 这个系数更容易写错
  bers.hp = half + 1;
  assert.equal(computeDamage(s, bers, tgt), full, '还剩一半多，没到狂暴的份上');

  // 1.5 倍要拿"同一个兵、同一个位置、只有半血"来比，不能拿满血那一下乘 1.5。
  bers.hp = half;
  const mad = computeDamage(s, bers, tgt);
  const abilities = s.unitTypes.berserker!.abilities;
  s.unitTypes.berserker!.abilities = [];
  const plain = computeDamage(s, bers, tgt);
  s.unitTypes.berserker!.abilities = abilities;
  // 提取狂战士的基础攻击力和目标护甲（因为 plain 是减过护甲的伤害）
  const baseAtk = s.unitTypes.berserker!.atk;
  const armor = baseAtk - plain; 
  // 新逻辑：先算攻击力乘 1.5，再减去护甲
  assert.equal(mad, Math.round(baseAtk * 1.5) - armor, `半血该多一半：${plain} → ${mad}`);
});

test('追猎：和目标每拉开一格 +2（最多 +6）', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 8], [5, 7]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const hound = place2(s, 'A', 'hellhound', 5, 5);
  const far = place2(s, 'B', 'swordsman', 5, 8);
  const withTracker = computeDamage(s, hound, far);
  delete s.unitTypes.hellhound!.abilities;
  const without = computeDamage(s, hound, far);
  assert.equal(withTracker - without, 4, '距离 3 应该 +4');
});

test('群势：牛头人身边每个友军 +2 攻击，最多 +6', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 4], [5, 6], [4, 5], [6, 5]]) {
    s.tiles[idx(s, x, y)].terrain = 'plain';
  }
  const mino = place2(s, 'A', 'minotaur', 5, 5);
  const tgt = place2(s, 'B', 'swordsman', 5, 4);
  const alone = computeDamage(s, mino, tgt);
  stackOn(s, 'A', 'swordsman', 5, 6);
  stackOn(s, 'A', 'swordsman', 4, 5);
  assert.equal(computeDamage(s, mino, tgt) - alone, 4, '两个友军 +4');
  stackOn(s, 'A', 'swordsman', 6, 5);
  assert.equal(computeDamage(s, mino, tgt) - alone, 6, '三个及以上封顶 +6');
});

test('游骑：身边干净时 +3，被贴住 −3，贴脸射不算远程', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 8], [4, 5], [5, 4]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const cent = place2(s, 'A', 'centaur', 5, 5);
  const far = place2(s, 'B', 'swordsman', 5, 8);
  const clean = computeDamage(s, cent, far);
  // 一个敌人在身边：这一箭就抖了
  const pin = place2(s, 'B', 'swordsman', 4, 5);
  assert.equal(computeDamage(s, cent, far), clean - 6, '被贴住该 −3，跟干净时比差 6');
  // 贴脸那一箭既不吃加成也不吃惩罚
  pin.x = 5;
  pin.y = 4;
  const near = place2(s, 'B', 'militia', 5, 6);
  const melee = computeDamage(s, cent, near);
  const abilities = s.unitTypes.centaur!.abilities;
  s.unitTypes.centaur!.abilities = [];
  assert.equal(computeDamage(s, cent, near), melee, '贴脸时游骑不生效');
  s.unitTypes.centaur!.abilities = abilities;
});

test('穿隙：精灵弓手无视地形掩护，但打不穿重甲', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 7]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  s.tiles[idx(s, 5, 7)].terrain = 'forest';
  const elf = place2(s, 'A', 'elf-archer', 5, 5);
  const tgt = place2(s, 'B', 'swordsman', 5, 7);

  // 直接比"同样的两个人，靶子站在林子里 vs 站在平地上"。
  // 不比"22 − 护甲"：护甲还会被光环、诅咒影响，那个数不值得在测试里重算一遍。
  const forest = computeDamage(s, elf, tgt);
  s.tiles[idx(s, 5, 7)].terrain = 'plain';
  assert.equal(computeDamage(s, elf, tgt), forest, '林子那 2 点对穿隙不顶用');

  // 对照：同一格上的普通弓手，还是得吃下地形加成
  s.units = s.units.filter((u) => u.id !== elf.id);
  const archer = place2(s, 'A', 'archer', 5, 5);
  const plain = computeDamage(s, archer, tgt);
  s.tiles[idx(s, 5, 7)].terrain = 'forest';
  assert.equal(computeDamage(s, archer, tgt), plain - 2, '普通弓手照旧吃森林那 2 点');
});

test('击退：把目标推开一格，推不动时就只是普通一击', () => {
  const s = fresh({ expansionIds: FANTASY });
  // 城市挪到中间之后，开局部队也落在中间几行；这条用例要的是"身后那一格空着"，
  // 所以先把这一小片清干净（人和地形都清），别让路过的侦察兵顶住退路。
  clearArea(s, 4, 2, 6, 6);
  const wind = place2(s, 'A', 'air-elemental', 5, 5);
  const tgt = place2(s, 'B', 'swordsman', 5, 4);
  const r = applyAction(s, { type: 'ATTACK', unitId: wind.id, targetId: tgt.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.find((u) => u.id === tgt.id)!.y, 3, '应该被推到 (5,3)');

  // 后面是水：推不动，伤害照常
  const s2 = fresh({ expansionIds: FANTASY });
  s2.tiles[idx(s2, 5, 5)].terrain = 'plain';
  s2.tiles[idx(s2, 5, 4)].terrain = 'plain';
  s2.tiles[idx(s2, 5, 3)].terrain = 'water';
  const wind2 = place2(s2, 'A', 'air-elemental', 5, 5);
  const tgt2 = place2(s2, 'B', 'swordsman', 5, 4);
  const r2 = applyAction(s2, { type: 'ATTACK', unitId: wind2.id, targetId: tgt2.id });
  assert.ok(r2.ok);
  assert.equal(r2.state.units.find((u) => u.id === tgt2.id)!.y, 4);
});

test('阵列：免疫溅射，但被当成主目标时照吃伤害', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 4], [4, 4], [6, 4]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const mage = place2(s, 'A', 'mage', 5, 5);
  const main = place2(s, 'B', 'swordsman', 5, 4);
  const guard = stackOn(s, 'B', 'royal-guard', 4, 4);
  const soft = stackOn(s, 'B', 'swordsman', 6, 4);
  const guardHp = guard.hp;

  const r = applyAction(s, { type: 'ATTACK', unitId: mage.id, targetId: main.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.find((u) => u.id === guard.id)!.hp, guardHp, '阵列不该吃溅射');
  assert.ok(
    r.state.units.find((u) => u.id === soft.id)!.hp < s.unitTypes.swordsman!.maxHp,
    '别的兵应该被溅射到',
  );

  // 当主目标时照吃
  const s2 = fresh({ expansionIds: FANTASY });
  s2.tiles[idx(s2, 5, 5)].terrain = 'plain';
  s2.tiles[idx(s2, 5, 4)].terrain = 'plain';
  const mage2 = place2(s2, 'A', 'mage', 5, 5);
  const target = place2(s2, 'B', 'royal-guard', 5, 4);
  assert.ok(computeDamage(s2, mage2, target) > 0, '阵列只免疫"被波及"');
});

test('窃掠：攻城顺手偷走"伤害 ×2"的金币', () => {
  const s = fresh({ expansionIds: FANTASY });
  const city = citiesOf(s, 'B')[0]!;
  const thief = place2(s, 'A', 'thief', city.x, city.y + 2);
  s.players.B.gold = 100;
  const mine = s.players.A.gold;
  const dmg = damageToCity(thief, city, s);
  assert.ok(dmg > 0, '盗贼应该打得动古典城墙');

  const r = applyAction(s, { type: 'SIEGE', unitId: thief.id, cityId: city.id });
  assert.ok(r.ok);
  assert.equal(r.state.players.A.gold, mine + dmg * 2);
  assert.equal(r.state.players.B.gold, 100 - dmg * 2);
});

test('召唤：死灵法师每两回合一个骷髅，到上限就停', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [4, 5], [6, 5], [5, 4], [5, 6]]) {
    s.tiles[idx(s, x, y)].terrain = 'plain';
  }
  place2(s, 'A', 'necromancer', 5, 5);
  let st = s;
  for (let i = 0; i < 20; i += 1) {
    const r = applyAction(st, { type: 'END_TURN' });
    assert.ok(r.ok);
    st = r.state;
  }
  const skels = st.units.filter((u) => u.owner === 'A' && u.type === 'skeleton');
  assert.equal(skels.length, 4, '上限就是 4 个');
  // 召唤物不占编制：编制里一个都数不到
  assert.equal(
    st.units.filter((u) => u.owner === 'A' && u.type === 'skeleton').length,
    skels.length,
    '召唤物应该真的在场上',
  );
});

test('自损：土墙撑不过四回合', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  const wall = stackOn(s, 'A', 'earth-wall', 5, 5);
  const maxHp = s.unitTypes['earth-wall']!.maxHp;
  assert.equal(wall.hp, maxHp);
  let st = s;
  for (let i = 0; i < 2; i += 1) {
    const r = applyAction(st, { type: 'END_TURN' });
    assert.ok(r.ok);
    st = r.state;
  }
  assert.equal(st.units.find((u) => u.id === wall.id)!.hp, maxHp - 5, '一个自己的回合掉 5 点');
  for (let i = 0; i < 8; i += 1) {
    const r = applyAction(st, { type: 'END_TURN' });
    assert.ok(r.ok);
    st = r.state;
  }
  assert.equal(
    st.units.some((u) => u.id === wall.id),
    false,
    '四回合之后土墙应该自己塌了',
  );
});

test('重生：不死鸟倒下后留下一枚蛋，由玩家选地方孵化', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 4], [6, 5], [4, 5], [5, 6]]) {
    s.tiles[idx(s, x, y)].terrain = 'plain';
  }
  const ph = place2(s, 'A', 'phoenix', 5, 5);
  const killer = place2(s, 'B', 'bone-dragon', 5, 4);
  const maxHp = s.unitTypes.phoenix!.maxHp;
  ph.hp = 3;
  s.current = 'B';

  const r = applyAction(s, { type: 'ATTACK', unitId: killer.id, targetId: ph.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.filter((u) => u.type === 'phoenix').length, 0, '先倒下，不立刻复活');
  const egg = r.state.pendingEgg;
  assert.ok(egg, '留下一枚蛋');
  assert.equal(egg!.owner, 'A');
  assert.equal(egg!.x, 5);
  assert.equal(egg!.y, 5);

  // 蛋只能落在原地 2 格内：不能"复活到对面家里"
  const far = applyAction({ ...r.state, current: 'A' }, { type: 'PLACE_EGG', x: 12, y: 12 });
  assert.equal(far.ok, false);

  // 换一格孵化，这是这次改动的重点：位置由玩家定，不是原地爬起来
  const spots = eggSpots(r.state);
  assert.ok(spots.length > 0, '至少有一格能放');
  const pick = spots.find((p) => p.x === 6 && p.y === 5) ?? spots[0]!;
  const e = applyAction({ ...r.state, current: 'A' }, {
    type: 'PLACE_EGG',
    x: pick.x,
    y: pick.y,
  });
  assert.ok(e.ok, e.ok ? '' : e.reason);
  const born = e.state.units.find((u) => u.type === 'phoenix')!;
  assert.equal(born.x, pick.x);
  assert.equal(born.y, pick.y);
  assert.equal(born.hp, Math.round(maxHp * 0.5), '孵化时带一半生命');
  assert.equal(born.reborn, true);
  assert.equal(e.state.pendingEgg, undefined, '蛋已经用掉了');

  // 第二次死就真死：不再留蛋。
  // 蛋可能孵在别处，所以先把杀手挪到新位置旁边——这里测的是"第二次不留蛋"，
  // 不是"杀手能不能追上"。
  const again = e.state.units.find((u) => u.type === 'phoenix')!;
  again.hp = 1;
  const killer2 = e.state.units.find((u) => u.id === killer.id)!;
  e.state.tiles[idx(e.state, again.x, again.y - 1)].terrain = 'plain';
  killer2.x = again.x;
  killer2.y = again.y - 1;
  readyAgain(killer2);
  const r2 = applyAction({ ...e.state, current: 'B' }, {
    type: 'ATTACK',
    unitId: killer.id,
    targetId: again.id,
  });
  assert.ok(r2.ok);
  assert.equal(r2.state.units.filter((u) => u.type === 'phoenix').length, 0);
  assert.equal(r2.state.pendingEgg, undefined, '每局只重来一次');
});

test('燃烧：叠层，每层 4 点，结算完掉一层', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 4]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const fire = place2(s, 'A', 'fire-elemental', 5, 5);
  // 靶子要够厚：火元素一击连魔攻四十多点，普通步兵挨不到第二下
  const tgt = place2(s, 'B', 'swordsman', 5, 4);

  // 挨两次火：燃烧是唯一会**叠加**的状态
  tgt.hp = 400;
  tgt.status = {};
  s.current = 'A';
  const hit1 = applyAction(s, { type: 'ATTACK', unitId: fire.id, targetId: tgt.id });
  assert.ok(hit1.ok);
  const t1 = hit1.state.units.find((u) => u.id === tgt.id)!;
  assert.equal(t1.status?.burn, 1, '第一下点着（一层）');

  // 再打一下（把行动重置，模拟下一回合又挨了一下）
  readyAgain(t1);
  const fire2 = hit1.state.units.find((u) => u.id === fire.id)!;
  readyAgain(fire2);
  const hit2 = applyAction({ ...hit1.state, current: 'A' }, {
    type: 'ATTACK',
    unitId: fire.id,
    targetId: tgt.id,
  });
  assert.ok(hit2.ok);
  const t2 = hit2.state.units.find((u) => u.id === tgt.id)!;
  assert.equal(t2.status?.burn, 2, '第二下叠成两层');

  // 结算：两层 8 点，结算后剩一层
  const before = t2.hp;
  const e1 = applyAction({ ...hit2.state, current: 'A' }, { type: 'END_TURN' });
  assert.ok(e1.ok);
  const t3 = e1.state.units.find((u) => u.id === tgt.id)!;
  assert.equal(before - t3.hp, 8, '两层一共 8 点');
  assert.equal(t3.status?.burn, 1, '烧完掉一层');
});

test('燃烧：怕火的单位每层烧得更狠', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 4]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  place2(s, 'B', 'swordsman', 5, 4);
  // 不用巨魔当靶子：它自带每回合回血，会把"这一把火烧掉多少"搅浑。
  // 这里临时给一个白板单位挂上怕火，只测倍率本身。
  s.unitTypes.swordsman!.weak = { fire: 2 };
  const ward = place2(s, 'A', 'swordsman', 5, 5);
  ward.hp = 200;
  ward.status = { burn: 3 };
  s.current = 'B';
  const before = ward.hp;
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok);
  // END_TURN 后轮到 A，tickStatuses 结算的是 A 的单位
  const after = r.state.units.find((u) => u.id === ward.id)!;
  assert.equal(before - after.hp, 3 * 4 * 2, '三层 × 4 点 × 怕火 2 倍 = 24');
});

test('投斧：默认只能近身，开了技能才够得着三格', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.unitTypes['dummy-foe'] = { ...s.unitTypes.militia, id: 'dummy-foe', atk: 10, armor: 0, abilities: [] };
  
  const king = place2(s, 'A', 'dwarf-king', 5, 5);
  const foe = place2(s, 'B', 'dummy-foe', 5, 8); // 距离 3，完全无甲
  s.current = 'A';

  assert.equal(effectiveRange(s, king), 1, '默认是近战英雄');
  assert.equal(canStrike(s, king, foe), false, '三格外够不着');

  // 1. 让国王开技能
  const r = applyAction(s, { type: 'HERO_SKILL', unitId: king.id, skillId: 'throw-axe' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const k2 = r.state.units.find((u) => u.id === king.id)!;
  
  assert.equal(effectiveRange(r.state, k2), 3, '投斧期间射程 3');
  assert.ok(canStrike(r.state, k2, foe), '够得着了');
  
  // 2. 算远程伤害
  const far = computeDamage(r.state, k2, foe);
  
  // 3. 抹掉技能状态，算近战伤害
  k2.heroBuff = {};
  const melee = computeDamage(r.state, k2, foe);
  
  assert.equal(far, Math.round(melee * 0.6), `远程 ${far} 应该等于近身 ${melee} 的六成`);
});

test('再生：立刻回四成，冷却两回合', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  const hydra = place2(s, 'A', 'hydra', 5, 5);
  const maxHp = s.unitTypes.hydra!.maxHp;
  hydra.hp = 20;
  s.current = 'A';
  const r = applyAction(s, { type: 'HERO_SKILL', unitId: hydra.id, skillId: 'regrow' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const h = r.state.units.find((u) => u.id === hydra.id)!;
  assert.equal(h.hp, 20 + Math.round(maxHp * 0.4), '回 40%');
  assert.equal(h.skillCd?.regrow, 2, '冷却两回合');
  const again = applyAction(r.state, { type: 'HERO_SKILL', unitId: hydra.id, skillId: 'regrow' });
  assert.equal(again.ok, false, '冷却中不能再开');
});

test('烈焰俯冲：移动 +2，攻击额外点燃两层', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 4], [5, 3]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const ph = place2(s, 'A', 'phoenix', 5, 5);
  const foe = place2(s, 'B', 'swordsman', 5, 4);
  foe.hp = 400; // 不死鸟一击就四十多，打死了就看不到状态了
  s.current = 'A';
  const base = movePower(s, ph);
  const r = applyAction(s, { type: 'HERO_SKILL', unitId: ph.id, skillId: 'dive' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const p2 = r.state.units.find((u) => u.id === ph.id)!;
  assert.equal(movePower(r.state, p2), base + 2, '本回合跑得更快');

  // 攻击带上点燃（不死鸟本来没有 run-hit）
  const atk = applyAction(r.state, { type: 'ATTACK', unitId: ph.id, targetId: foe.id });
  assert.ok(atk.ok);
  const hurt = atk.state.units.find((u) => u.id === foe.id)!;
  assert.equal(hurt.status?.burn, 2, '俯冲这一下带两层火');
});

test('投斧：这一下不占本回合的攻击，扔完还能再劈一刀', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 7], [6, 5]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const king = place2(s, 'A', 'dwarf-king', 5, 5);
  const farFoe = place2(s, 'B', 'swordsman', 5, 7);
  const nearFoe = place2(s, 'B', 'swordsman', 6, 5);
  farFoe.hp = 400;
  nearFoe.hp = 400;
  s.current = 'A';

  const r = applyAction(s, { type: 'HERO_SKILL', unitId: king.id, skillId: 'throw-axe' });
  assert.ok(r.ok, r.ok ? '' : r.reason);

  const shot = applyAction(r.state, { type: 'ATTACK', unitId: king.id, targetId: farFoe.id });
  assert.ok(shot.ok, shot.ok ? '' : shot.reason);
  const k = shot.state.units.find((u) => u.id === king.id)!;
  assert.equal(k.acted, false, '投斧不算本回合的攻击');
  assert.equal(k.moved, false, '也不占移动');
  assert.equal(k.heroBuff, undefined, '斧子扔出去了，加成收回');
  assert.equal(effectiveRange(shot.state, k), 1, '射程回到近战');

  // 同一回合还能再打一次贴身目标，这一下才算数
  const melee = applyAction(shot.state, { type: 'ATTACK', unitId: king.id, targetId: nearFoe.id });
  assert.ok(melee.ok, melee.ok ? '' : melee.reason);
  assert.equal(melee.state.units.find((u) => u.id === king.id)?.acted, true, '真正的攻击才结束行动');
});

test('属性精研：火点燃、水霜缚、自然回血、暗魔攻 ×1.5', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 7]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const mage = place2(s, 'A', 'archmage', 5, 5);
  const foe = place2(s, 'B', 'swordsman', 5, 7);
  s.current = 'A';

  assert.equal(s.unitTypes.archmage!.magicRes, 14, '至尊法师法抗 14');

  // 火（默认属性）：命中叠一层点燃——只叠一层，别和"转属性"那支重复
  foe.hp = 500;
  const fire = applyAction(s, { type: 'ATTACK', unitId: mage.id, targetId: foe.id });
  assert.ok(fire.ok, fire.ok ? '' : fire.reason);
  const burned = fire.state.units.find((u) => u.id === foe.id)!;
  assert.equal(burned.status?.burn, 1, '火属性命中点燃一层');

  // 水：霜缚（沿用减速的实现：移动 −1）
  const s2 = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 7]]) s2.tiles[idx(s2, x, y)].terrain = 'plain';
  const mage2 = place2(s2, 'A', 'archmage', 5, 5);
  const foe2 = place2(s2, 'B', 'swordsman', 5, 7);
  foe2.hp = 500;
  mage2.element = 'water';
  s2.current = 'A';
  const wet = applyAction(s2, { type: 'ATTACK', unitId: mage2.id, targetId: foe2.id });
  assert.ok(wet.ok, wet.ok ? '' : wet.reason);
  const chilled = wet.state.units.find((u) => u.id === foe2.id)!;
  assert.equal(chilled.status?.slow, 2, '水属性挂霜缚');

  // 自然：攻击顺手回自己 10%（不占治疗行动）
  const s3 = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 7]]) s3.tiles[idx(s3, x, y)].terrain = 'plain';
  const mage3 = place2(s3, 'A', 'archmage', 5, 5);
  const foe3 = place2(s3, 'B', 'swordsman', 5, 7);
  foe3.hp = 500;
  mage3.element = 'nature';
  mage3.hp = 30;
  s3.current = 'A';
  const green = applyAction(s3, { type: 'ATTACK', unitId: mage3.id, targetId: foe3.id });
  assert.ok(green.ok, green.ok ? '' : green.reason);
  const m3 = green.state.units.find((u) => u.id === mage3.id)!;
  assert.equal(m3.hp, 30 + Math.round(s3.unitTypes.archmage!.maxHp * 0.1), '自然属性攻击时回 10%');

  // 暗：魔法段 ×1.5（先减魔抗再放大）
  const dark = { ...mage, element: 'dark' as const };
  const plain = { ...mage, element: 'fire' as const };
  const base = magicDamageOf(s, plain, foe);
  assert.ok(base > 0, '火属性有魔法段');
  assert.equal(magicDamageOf(s, dark, foe), Math.round(base * 1.5), '暗属性魔法段 ×1.5');
});

test('转属性：自己切，切到的属性附带对应状态', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 4]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const mage = place2(s, 'A', 'archmage', 5, 5);
  const foe = place2(s, 'B', 'swordsman', 5, 4);
  s.current = 'A';
  // 单位身上没写 element 时，属性来自兵种表（elementOf 的回退规则）
  assert.equal(mage.element, undefined, '单位本身没写死属性');
  assert.equal(s.unitTypes.archmage!.element, 'fire', '兵种表里是火');

  const r = applyAction(s, { type: 'HERO_SKILL', unitId: mage.id, skillId: 'shift' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const m2 = r.state.units.find((u) => u.id === mage.id)!;
  assert.equal(m2.element, 'water', '火 → 水');
  assert.equal(m2.heroBuff?.elementHit, 'water');

  const atk = applyAction(r.state, { type: 'ATTACK', unitId: mage.id, targetId: foe.id });
  assert.ok(atk.ok);
  const hurt = atk.state.units.find((u) => u.id === foe.id)!;
  assert.equal(hurt.status?.slow, 2, '水属性这一下带减速');
});

test('分裂：史莱姆死了变成两只小史莱姆', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [5, 4], [4, 5], [6, 5]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const slime = place2(s, 'A', 'slime', 5, 5);
  const killer = place2(s, 'B', 'bone-dragon', 5, 4);
  slime.hp = 2;
  s.current = 'B';
  const r = applyAction(s, { type: 'ATTACK', unitId: killer.id, targetId: slime.id });
  assert.ok(r.ok);
  const kids = r.state.units.filter((u) => u.type === 'slimelet');
  assert.equal(kids.length, 2, '两只小史莱姆');
  for (const k of kids) assert.equal(k.owner, 'A');
});

test('修缮：符文守卫每回合给相邻的城补 6 点耐久', () => {
  const s = fresh({ expansionIds: FANTASY });
  const city = citiesOf(s, 'A')[0]!;
  city.hp = 10;
  place2(s, 'A', 'rune-guardian', city.x, city.y + 2);
  let st = s;
  for (let i = 0; i < 2; i += 1) {
    const r = applyAction(st, { type: 'END_TURN' });
    assert.ok(r.ok);
    st = r.state;
  }
  assert.equal(cityById(st, city.id)!.hp, 16);
});

test('筑墙：土元素会在自己旁边立一道墙', () => {
  const s = fresh({ expansionIds: FANTASY });
  for (const [x, y] of [[5, 5], [4, 5], [6, 5], [5, 4], [5, 6]]) {
    s.tiles[idx(s, x, y)].terrain = 'plain';
  }
  place2(s, 'A', 'earth-elemental', 5, 5);
  assert.equal(s.units.some((u) => u.type === 'earth-wall'), false);
  let st = s;
  for (let i = 0; i < 2; i += 1) {
    const r = applyAction(st, { type: 'END_TURN' });
    assert.ok(r.ok);
    st = r.state;
  }
  const wall = st.units.find((u) => u.type === 'earth-wall');
  assert.ok(wall, '应该立起一道土墙');
  assert.equal(s.unitTypes['earth-wall']!.obstacle, true);
});

test('弹药：炼金术士打光六发之后射程掉到 1、魔法段归零', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';
  const al = place2(s, 'A', 'alchemist', 5, 5);
  const tgt = place2(s, 'B', 'swordsman', 5, 4);
  al.ammoLeft = 1;
  assert.equal(effectiveRange(s, al), 3);
  const magicBefore = magicDamageOf(s, al, tgt);
  assert.ok(magicBefore > 0);

  const r = applyAction(s, { type: 'ATTACK', unitId: al.id, targetId: tgt.id });
  assert.ok(r.ok);
  const empty = r.state.units.find((u) => u.id === al.id)!;
  assert.equal(empty.ammoLeft, 0);
  assert.equal(effectiveRange(r.state, empty), 1, '打光了只能贴身');
  assert.equal(magicDamageOf(r.state, empty, tgt), 0, '没有弹药就没有魔法段');
});

test('英雄：同方场上只能一个，解锁费只收第一次', () => {
  const s = fresh({ expansionIds: FANTASY, startEra: 3 });
  s.players.A.gold = 2000;
  const city = citiesOf(s, 'A')[0]!;
  const price = s.unitTypes['dwarf-king']!.cost;
  const fee = s.unitTypes['dwarf-king']!.unlockCost!;

  const r1 = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'dwarf-king' });
  assert.ok(r1.ok);
  assert.equal(r1.state.players.A.gold, 2000 - price - fee, '第一次要付解锁费');

  const r2 = applyAction(r1.state, { type: 'RECRUIT', cityId: city.id, unitType: 'dwarf-king' });
  assert.equal(r2.ok, false, '第二个会被拒');

  // 人死了再招一次：这次不该再收解锁费
  const after = { ...r1.state };
  after.units = after.units.filter((u) => u.type !== 'dwarf-king');
  after.players.A.gold = 1000;
  const r3 = applyAction(after, { type: 'RECRUIT', cityId: city.id, unitType: 'dwarf-king' });
  assert.ok(r3.ok);
  assert.equal(r3.state.players.A.gold, 1000 - price);
});

test('召唤物不占编制，也不能从产线招募', () => {
  const s = fresh({ expansionIds: FANTASY });
  const before = armySize(s, 'A');
  for (let i = 0; i < 4; i += 1) stackOn(s, 'A', 'skeleton', 8 + i, 8);
  assert.equal(armySize(s, 'A'), before, '召唤物不该占编制');

  const city = citiesOf(s, 'A')[0]!;
  const r = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'skeleton' });
  assert.equal(r.ok, false, '骷髅只能被召唤');
});

test('穿行：幽灵能穿过敌军，但停不下来', () => {
  const s = fresh({ expansionIds: FANTASY });
  // 在山里凿一条单人通道：这一带除了 y=5 全是山，绕路根本不可能。
  // （只堵住一边是不够的——四连通总能绕着那颗树走，那就测不出"穿行"了。）
  for (let x = 3; x <= 9; x += 1) {
    for (let y = 3; y <= 7; y += 1) s.tiles[idx(s, x, y)].terrain = y === 5 ? 'plain' : 'mountain';
  }
  const ghost = place2(s, 'A', 'ghost', 5, 5);
  place2(s, 'B', 'swordsman', 6, 5);
  const reach = reachableTiles(s, ghost);
  assert.ok(reach.has(idx(s, 7, 5)), '能穿过去');
  assert.equal(reach.has(idx(s, 6, 5)), false, '穿过不等于能停在敌人身上');

  // 对照：普通兵过不去
  s.units = s.units.filter((u) => u.id !== ghost.id);
  const hound = place2(s, 'A', 'hellhound', 5, 5);
  assert.equal(reachableTiles(s, hound).has(idx(s, 7, 5)), false);
});

test('隐匿：刺客不动就看不见，一出手就现形', () => {
  const s = fresh({ expansionIds: FANTASY });
  s.fog = true;
  // 城市挪到中间之后开局部队也挤在中间几行，8,8 隔壁可能站着对面的农民；
  // 隐匿的判定里有"一格之内没有敌人"，所以先把这一片清空。
  clearArea(s, 6, 6, 10, 12);
  s.tiles[idx(s, 8, 8)].terrain = 'plain';
  s.tiles[idx(s, 8, 11)].terrain = 'plain';
  const assassin = place2(s, 'B', 'assassin', 8, 8);
  place2(s, 'A', 'swordsman', 8, 11);
  assert.equal(isHiddenFrom(s, assassin, 'A'), true, '在平地上也藏得住');
  assassin.moved = true;
  assert.equal(isHiddenFrom(s, assassin, 'A'), false, '动过就现形');
});

test('重甲难行：超级重骑进林子要多花一倍移动力', () => {
  const s = fresh({ expansionIds: FANTASY });
  // 同样的单人通道，只在 6,5 上种一片林子
  for (let x = 3; x <= 9; x += 1) {
    for (let y = 3; y <= 7; y += 1) s.tiles[idx(s, x, y)].terrain = y === 5 ? 'plain' : 'mountain';
  }
  s.tiles[idx(s, 6, 5)].terrain = 'forest';
  const cat = place2(s, 'A', 'cataphract', 5, 5);
  const reach = reachableTiles(s, cat);
  assert.ok(reach.has(idx(s, 6, 5)), '还是能进林子');
  assert.equal(reach.has(idx(s, 7, 5)), false, '但进完就没力气再走了');

  // 对照：同样 4 点移动、没有这条限制的骑兵能连着走两格
  s.units = s.units.filter((u) => u.id !== cat.id);
  const royal = place2(s, 'A', 'royal-cavalry', 5, 5);
  assert.ok(reachableTiles(s, royal).has(idx(s, 7, 5)));
});

test('攻击力低于护甲时造成 0 伤害', () => {
  const s = fresh();
  const militia = findUnit(s, 'A', 'militia');
  // 摆一个碉堡当靶子（护甲 12 > 民兵攻击 12 的净收益）
  s.units.push({
    id: 'test-bunker',
    type: 'bunker',
    owner: 'B',
    x: 5,
    y: 4,
    hp: 78,
    kills: 0,
    moved: true,
    acted: true,
  });
  const bunker = s.units.find((u) => u.id === 'test-bunker');
  assert.ok(bunker);
  militia.x = 5;
  militia.y = 5;
  s.tiles[idx(s, 5, 4)].terrain = 'plain';
  s.tiles[idx(s, 5, 5)].terrain = 'plain';

  assert.equal(computeDamage(s, militia, bunker), 0, '民兵打碉堡应该是 0 伤害');

  const r = applyAction(s, { type: 'ATTACK', unitId: militia.id, targetId: bunker.id });
  assert.ok(r.ok, '0 伤害的攻击本身仍然是合法操作');
  assert.equal(r.state.units.find((u) => u.id === bunker.id)?.hp, 78, '碉堡不该掉血');
});

test('起始时代可以配置，城市属性和金币跟着走', () => {
  const s = createMatch({ ...BASE, startEra: 3 }, 12345);
  const e3 = eraDef(3);
  for (const c of s.cities) {
    assert.equal(c.era, 3);
    assert.equal(c.maxHp, e3.cityMaxHp);
    assert.equal(c.armor, e3.cityArmor);
  }
  assert.equal(s.players.A.gold, startGoldFor(3) + openingIncome(s));
  assert.equal(s.config.startEra, 3);
});

console.log('\n兵种数值与射程阶梯');

test('时代越靠后射程越长，长弓手不再是天花板', () => {
  // 这里的"远程"指射程 ≥ 3 的真远程。戟兵那种射程 2 是长柄武器的"够得到"，
  // 拿它跟火炮比射程没有意义——它的用法是站在一格之外打人不挨反击。
  const ranged = Object.values(UNIT_TYPES).filter(
    (d) => d.category === 'combat' && d.domain !== 'water' && d.range >= 3,
  );
  // 时代 3 及以后的远程，射程至少要和长弓手（时代 2、射程 4）持平。
  // 只要求"站桩兵"（步兵与炮兵，move ≤ 2）：坦克和装甲车是突击载具，
  // 靠机动和装甲换射程，拿它们跟站后排的弓手比射程没有意义。
  for (const d of ranged) {
    if (d.era >= 3 && d.move <= 2) {
      assert.ok(d.range >= 4, `${d.name} 是时代 ${d.era} 的远程，射程 ${d.range} 还不如长弓手`);
    }
  }
  // 顶级火力要真的压过后排：火炮与铁甲舰 5 格，长弓手 4 格
  assert.equal(UNIT_TYPES.longbow.range, 4);
  assert.equal(UNIT_TYPES.artillery.range, 5);
  assert.equal(UNIT_TYPES.ironclad.range, 5);
  // 载具也上了一个台阶：射程 3 意味着能站在近战够不到的地方开火
  assert.equal(UNIT_TYPES.tank.range, 3);
  assert.equal(UNIT_TYPES.armoredcar.range, 3);
});

test('关键数值按方案落定', () => {
  const want: Array<[string, Partial<Record<'cost' | 'atk' | 'armor' | 'maxHp' | 'range', number>>]> = [
    ['archer', { cost: 35 }],
    ['longbow', { cost: 90 }],
    ['musketeer', { cost: 130 }],
    ['rifleman', { cost: 200 }],
    ['squad', { cost: 300 }],
    ['spearman', { cost: 65 }],
    ['halberdier', { cost: 100, range: 2 }],
    ['tank', { cost: 400, range: 3 }],
    ['armoredcar', { cost: 250, range: 3 }],
    ['militia', { atk: 13 }],
    ['hmg', { atk: 17 }],
    ['boat', { atk: 11, maxHp: 34 }],
    ['armoredcar', { maxHp: 54 }],
    // 第二轮改：长枪兵加血、箭塔射程 +1、水军与高时代单位集体上调
    ['spearman', { maxHp: 40 }],
    ['tower', { range: 3 }],
    ['gunboat', { atk: 25, maxHp: 46 }],
    ['ironclad', { atk: 47, armor: 11, maxHp: 90 }],
    ['tank', { atk: 56, maxHp: 88 }],
    ['artillery', { atk: 47, maxHp: 54 }],
    ['squad', { atk: 47, maxHp: 48 }],
    ['rifleman', { atk: 36 }],
    ['mg', { atk: 20 }],
    ['hmg', { atk: 17 }],
  ];
  // 二级城升级费回调到 220：开局收入修好之后玩家手上有两百出头，
  // 定在 200 会让"第一回合就升二级"变成毫无代价的默认动作。
  assert.equal(eraDef(2).upgradeCost, 220);
  for (const [id, fields] of want) {
    const def = UNIT_TYPES[id as keyof typeof UNIT_TYPES];
    assert.ok(def, `缺兵种 ${id}`);
    for (const [k, v] of Object.entries(fields)) {
      assert.equal((def as unknown as Record<string, number>)[k], v, `${def.name} 的 ${k}`);
    }
  }
});

test('桥分三档，越高级越抗拆', () => {
  const tiers = [UNIT_TYPES.bridge, UNIT_TYPES.bridge2, UNIT_TYPES.bridge3];
  assert.ok(tiers.every((b) => b && b.bridges), '三档桥都要有 bridges 标记');
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i]!.maxHp > tiers[i - 1]!.maxHp, '高一级的桥要更耐打');
    assert.ok(tiers[i]!.armor > tiers[i - 1]!.armor, '高一级的桥要更厚的甲');
    assert.ok(tiers[i]!.era > tiers[i - 1]!.era, '高一级的桥要更晚的时代才解锁');
  }

  // 谁能盖哪一档：工程师起能盖石桥，建筑队起能盖钢桥
  const buildsOf = (id: string) => UNIT_TYPES[id as keyof typeof UNIT_TYPES].builds ?? [];
  assert.ok(buildsOf('laborer').includes('bridge'));
  assert.ok(!buildsOf('laborer').includes('bridge2'), '劳工盖不了石桥');
  assert.ok(buildsOf('engineer').includes('bridge2'));
  assert.ok(!buildsOf('engineer').includes('bridge3'), '工程师还盖不了钢桥');
  assert.ok(buildsOf('crew').includes('bridge3'));

  // 钢桥要真的挡得住磨：民兵（13 攻）一回合只能啃掉 7 点，砸塌要 18 下
  const dmg = UNIT_TYPES.militia.atk - UNIT_TYPES.bridge3.armor;
  assert.ok(dmg > 0 && dmg <= 7, '钢桥对低时代兵应该有明显减伤');
  assert.ok(UNIT_TYPES.bridge3.maxHp / dmg >= 15, '钢桥不该两三下就塌');
});

console.log('\n扩展规则');

test('非对称开局：先手工兵 + 斥候，后手两农一牧一步兵一弓手', () => {
  const sym = fresh();
  assert.equal(
    sym.units.filter((u) => u.owner === 'A').length,
    sym.units.filter((u) => u.owner === 'B').length,
    '不开扩展时两边对称',
  );

  const s = fresh({ expansionIds: ['asym-opening'] });
  const of = (owner: 'A' | 'B') => s.units.filter((u) => u.owner === owner).map((u) => u.type);
  assert.deepEqual(of('A'), ['engineer', 'scout'], '先手只有工事与侦察');
  assert.deepEqual(of('B'), ['farmer', 'farmer', 'herder', 'militia', 'archer'], '后手是屯田与守备');
  // 全部开局兵加起来还是那 7 个，一个不多一个不少
  assert.equal(s.units.length, 7);
  assert.ok(s.log.some((l) => l.text.includes('非对称开局')), '开局要在战报里说清楚');
});

test('战争经济：击杀立刻得 15 金', () => {
  const s = fresh({ expansionIds: ['war-economy'] });
  const { a, b } = duel(s);
  b.hp = 3;
  const before = s.players.A.gold;
  const r = applyAction(s, { type: 'ATTACK', unitId: a.id, targetId: b.id });
  assert.ok(r.ok);
  assert.equal(r.state.players.A.gold, before + 15);
});

test('老兵：击杀累积攻击加成', () => {
  const s = fresh({ expansionIds: ['veterans'] });
  const { a, b } = duel(s);
  const base = computeDamage(s, a, b);
  a.kills = 2;
  assert.equal(computeDamage(s, a, b), base + 2, '每点击杀应该 +1 伤害');

  const weak = findUnit(s, 'B', 'archer');
  weak.x = 5;
  weak.y = 4;
  weak.hp = 1;
  const r = applyAction(s, { type: 'ATTACK', unitId: a.id, targetId: weak.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.find((n) => n.id === a.id)?.kills, 3);
});

test('堑壕战：森林和丘陵额外 +2 护甲', () => {
  const s = fresh({ expansionIds: ['trench'] });
  const { a, b } = duel(s);
  const onPlain = computeDamage(s, a, b);
  s.tiles[idx(s, b.x, b.y)].terrain = 'forest';
  const inForest = computeDamage(s, a, b);
  // 森林本身地形护甲 2，再叠加堑壕的 2
  assert.equal(onPlain - inForest, CONFIG.terrainDef.forest + 2);
});

test('堑壕战加的是护甲，不是"少挨 2 点"', () => {
  // 纯减法下这两种写法数值完全一样，只有破甲能分辨：破甲只削一半护甲。
  // 所以拿一个破甲兵打同一个目标，看堑壕的收益是不是也跟着缩水。
  const deltaOf = (attackerType: string | null) => {
    const s = fresh({ expansionIds: ['trench'] });
    const { a, b } = duel(s);
    if (attackerType) {
      if (!s.unitTypes[attackerType]) s.unitTypes[attackerType] = UNIT_TYPES[attackerType]!;
      a.type = attackerType;
    }
    s.tiles[idx(s, b.x, b.y)].terrain = 'plain';
    const plain = computeDamage(s, a, b);
    s.tiles[idx(s, b.x, b.y)].terrain = 'forest';
    return plain - computeDamage(s, a, b);
  };

  const normal = deltaOf(null);
  const pierced = deltaOf('rifleman');
  assert.ok(normal > 0, '普通兵应该吃到堑壕加成');
  assert.ok(pierced < normal, `破甲应该把额外护甲削掉一半：普通 ${normal} vs 破甲 ${pierced}`);
});

test('闪击战：移速 3 以上的单位移动力 +2、造价 +10%', () => {
  const base = fresh();
  const buffed = fresh({ expansionIds: ['blitz'] });
  const cavA = findUnit(base, 'A', 'scout');
  const cavB = findUnit(buffed, 'A', 'scout');
  assert.equal(movePower(buffed, cavB), movePower(base, cavA) + 2);
  assert.equal(
    recruitCost(buffed, 'A', UNIT_TYPES.scout),
    recruitCost(base, 'A', UNIT_TYPES.scout) + Math.round(UNIT_TYPES.scout.cost * 0.1),
  );

  // 慢单位（move ≤ 2）一分钱都不该涨
  const slow = UNIT_TYPES.militia;
  assert.ok(slow.move < 3);
  assert.equal(recruitCost(buffed, 'A', slow), recruitCost(base, 'A', slow));
});

test('征兵制：战斗单位一律 −20%，起始金币减半', () => {
  const base = fresh();
  const conscript = fresh({ expansionIds: ['conscription'] });
  for (const def of [UNIT_TYPES.militia, UNIT_TYPES.rifleman, UNIT_TYPES.tank]) {
    assert.equal(def.category, 'combat');
    assert.equal(
      recruitCost(conscript, 'A', def),
      Math.max(5, Math.round(recruitCost(base, 'A', def) * 0.8)),
      `${def.name} 应该便宜两成`,
    );
  }
  assert.equal(conscript.players.A.gold, Math.round(CONFIG.startGold * 0.5) + openingIncome(conscript));
  assert.equal(conscript.players.B.gold, Math.round(CONFIG.startGold * 0.5));
});

test('夜战：视野 −1', () => {
  const base = fresh();
  const dark = fresh({ expansionIds: ['night-raid'] });
  const u1 = findUnit(base, 'A', 'archer');
  const u2 = findUnit(dark, 'A', 'archer');
  assert.ok(visibleTilesOf(base, 'A').size > visibleTilesOf(dark, 'A').size);
  assert.equal(u1.x, u2.x, '两张图应该一样，只是视野不同');
});

test('要塞：城市护甲 +1、耐久上限 +20', () => {
  const s = fresh({ expansionIds: ['fortress'] });
  for (const c of s.cities) {
    assert.equal(c.armor, eraDef(1).cityArmor + 1);
    assert.equal(c.maxHp, eraDef(1).cityMaxHp + 20);
    assert.equal(c.hp, c.maxHp);
  }
});

test('焦土：阵亡时按最大生命 20% 波及四周', () => {
  const s = fresh({ expansionIds: ['scorched-earth'] });
  const { a, b } = duel(s);
  const neighbor = findUnit(s, 'B', 'scout');
  neighbor.x = b.x + 1;
  neighbor.y = b.y;
  s.tiles[idx(s, neighbor.x, neighbor.y)].terrain = 'plain';
  b.hp = 3;
  const beforeHp = neighbor.hp;
  const r = applyAction(s, { type: 'ATTACK', unitId: a.id, targetId: b.id });
  assert.ok(r.ok);
  const blast = Math.max(1, Math.round(UNIT_TYPES[b.type].maxHp * 0.2));
  assert.equal(r.state.units.find((n) => n.id === neighbor.id)?.hp, beforeHp - blast);
});

test('多个扩展可以同时生效', () => {
  const s = fresh({ expansionIds: ['blitz', 'veterans', 'fortress'] });
  const cav = findUnit(s, 'A', 'scout');
  assert.equal(movePower(s, cav), UNIT_TYPES.scout.move + 2);
  assert.equal(s.cities[0].armor, eraDef(1).cityArmor + 1);
  const { b } = duel(s);
  assert.equal(computeDamage(s, cav, b), UNIT_TYPES.scout.atk - UNIT_TYPES.militia.armor);
});

console.log('\n哀兵必胜');

test('哀兵必胜：还没丢城的时候，一点加成都没有', () => {
  const off = fresh();
  const on = fresh({ expansionIds: ['last-stand'] });
  assert.equal(off.firstCityLost, undefined, '开局不该有"谁先丢城"的记录');
  assert.equal(on.firstCityLost, undefined);

  const d0 = duel(off);
  const d1 = duel(on);
  assert.equal(
    computeDamage(on, d1.a, d1.b),
    computeDamage(off, d0.a, d0.b),
    '没丢城就不该有加成',
  );

  const cavOff = findUnit(off, 'A', 'scout');
  const cityOff = citiesOf(off, 'B')[0]!;
  const cavOn = findUnit(on, 'A', 'scout');
  const cityOn = citiesOf(on, 'B')[0]!;
  assert.ok(damageToCity(cavOff, cityOff, off) > 0, '这个用例的前提是打得动城');
  assert.equal(damageToCity(cavOn, cityOn, on), damageToCity(cavOff, cityOff, off));
});

test('哀兵必胜：丢城的一方全军 +10%，没丢的一方没有', () => {
  const off = fresh();
  const d0 = duel(off);
  const baseAB = computeDamage(off, d0.a, d0.b);
  const baseBA = computeDamage(off, d0.b, d0.a);

  const on = fresh({ expansionIds: ['last-stand'] });
  const d1 = duel(on);
  on.firstCityLost = 'A';

  assert.equal(computeDamage(on, d1.a, d1.b), Math.round(baseAB * 1.1), 'A 丢了城，攻击 +10%');
  assert.equal(computeDamage(on, d1.b, d1.a), baseBA, 'B 没丢城，一下都不多');
});

test('哀兵必胜：反击也算攻击，一起吃这 10%', () => {
  // 捏两个测试假人：攻击 10，护甲 0，其他不重要的拉满
  const s = fresh();
  s.unitTypes['dummy-atk'] = { ...s.unitTypes.militia, id: 'dummy-atk', atk: 10, armor: 0 };
  s.unitTypes['dummy-def'] = { ...s.unitTypes.militia, id: 'dummy-def', atk: 10, armor: 0 };

  const a = place2(s, 'A', 'dummy-atk', 5, 5);
  const b = place2(s, 'B', 'dummy-def', 5, 4);

  // 1. 没丢城时的反击
  const noBonus = computeDamage(s, a, b, true);
  // 物理 10 - 0 = 10，反击乘 0.5 = 5
  assert.equal(noBonus, 5, '基础反击应该是 5');

  // 2. 开了扩展，A 丢了城
  const s2 = fresh({ expansionIds: ['last-stand'] });
  s2.unitTypes['dummy-atk'] = { ...s2.unitTypes.militia, id: 'dummy-atk', atk: 10, armor: 0 };
  s2.unitTypes['dummy-def'] = { ...s2.unitTypes.militia, id: 'dummy-def', atk: 10, armor: 0 };
  const a2 = place2(s2, 'A', 'dummy-atk', 5, 5);
  const b2 = place2(s2, 'B', 'dummy-def', 5, 4);
  s2.firstCityLost = 'A';

  // 物理 10 * 1.1 = 11，反击乘 0.5 = 5.5 -> Math.round = 6
  assert.equal(computeDamage(s2, a2, b2, true), 6, '反击也应该享受 10% 加成');
});

test('哀兵必胜：攻城伤害也吃这 10%', () => {
  const off = fresh();
  const city0 = citiesOf(off, 'B')[0]!;
  const base = damageToCity(findUnit(off, 'A', 'scout'), city0, off);

  const on = fresh({ expansionIds: ['last-stand'] });
  const city1 = citiesOf(on, 'B')[0]!;
  on.firstCityLost = 'A';
  assert.ok(base > 0);
  assert.equal(damageToCity(findUnit(on, 'A', 'scout'), city1, on), Math.round(base * 1.1));
});

test('哀兵必胜：谁先丢城由攻城结算记下，接管也不改写', () => {
  const s = fresh({ expansionIds: ['last-stand'] });
  const city = citiesOf(s, 'B')[0]!;
  city.hp = 5;
  const at = { x: city.x + city.size, y: city.y };
  s.tiles[idx(s, at.x, at.y)] = { terrain: 'plain', cityId: null };
  const cav = place(s, 'A', 'militia', at.x, at.y);

  const r1 = applyAction(s, { type: 'SIEGE', unitId: cav.id, cityId: city.id });
  assert.ok(r1.ok);
  assert.equal(r1.state.firstCityLost, 'B', 'B 丢了城，记的就是 B');
  assert.equal(cityById(r1.state, city.id)?.owner, 'B', '破城还没易主');

  // 入驻接管之后，"谁先丢城"这条记录也不该被改写
  const push = r1.state.units.find((u) => u.id === cav.id);
  assert.ok(push, '攻城那只兵应该还在');
  push.moved = false;
  push.acted = false;
  const move = applyAction(r1.state, {
    type: 'MOVE',
    unitId: push.id,
    x: city.x,
    y: city.y,
  });
  assert.ok(move.ok, move.ok ? '' : `入驻失败：${move.reason}`);
  assert.equal(cityById(move.state, city.id)?.owner, 'A', '入驻之后才易主');
  assert.equal(move.state.firstCityLost, 'B', '接管不改写"谁先丢的"——加成跟着人走，不跟着城走');
});

console.log('\n血战扩展');

/** 造一个"城里有驻军、城外没有敌人"的局面，好让城市回血生效 */
function garrisoned(s: GameState): { city: City; guard: Unit } {
  s.units = s.units.filter((u) => u.owner === 'A');
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  city.hp = Math.max(1, city.maxHp - 10);
  const guard = place(s, 'A', 'militia', city.x, city.y);
  return { city, guard };
}

test('血战：第 50 回合前一切照旧', () => {
  const s = fresh({ expansionIds: ['bloodbath'] });
  s.turn = BLOOD_TURN - 1;
  const { city } = garrisoned(s);
  const mg = place(s, 'A', 'mg', 5, 8);

  assert.ok(cityRegenOf(s, city) > 0, '血战之前城市照常回血');
  assert.equal(upgradeCostOf(s, city), UNIT_TYPES.militia.era === 1 ? ERAS[1].upgradeCost : 0);
  assert.equal(movePower(s, findUnit(s, 'A', 'militia')), UNIT_TYPES.militia.move);
  assert.equal(visionOf(s, findUnit(s, 'A', 'militia')), UNIT_TYPES.militia.vision);
  assert.equal(movePower(s, mg), UNIT_TYPES.mg.move);
});

test('血战：第 50 回合起，回血、涨价、机动、视野削减全部撤销', () => {
  const s = fresh({ expansionIds: ['bloodbath'] });
  s.turn = BLOOD_TURN;
  const { city } = garrisoned(s);
  const mg = place(s, 'A', 'mg', 5, 8);

  assert.equal(cityRegenOf(s, city), 0, '血战开始后城市不再回血');
  assert.equal(
    upgradeCostOf(s, city),
    LEGACY_UPGRADE_COST[1],
    '升级费退回涨价前的价',
  );
  assert.equal(movePower(s, findUnit(s, 'A', 'militia')), UNIT_TYPES.militia.move + 1);
  assert.equal(visionOf(s, findUnit(s, 'A', 'militia')), UNIT_TYPES.militia.vision + 1);
  assert.equal(movePower(s, mg), UNIT_TYPES.mg.move, 'move 1 的机枪队本来就没被削过');
});

test('血战真的会改变 AI 的升级决策', () => {
  // 同一笔钱：血战之前不够升级，血战之后够了
  const before = fresh({ expansionIds: ['bloodbath'] });
  before.turn = BLOOD_TURN - 1;
  const after = fresh({ expansionIds: ['bloodbath'] });
  after.turn = BLOOD_TURN;

  const gold = LEGACY_UPGRADE_COST[1]; // 刚好够旧价，不够现价
  for (const s of [before, after]) {
    s.current = 'A';
    s.players.A.gold = gold;
    const city = citiesOf(s, 'A')[0];
    assert.ok(city);
    s.units = s.units.filter((u) => u.owner === 'A');
  }

  const cityB = citiesOf(before, 'A')[0]!;
  const cityA = citiesOf(after, 'A')[0]!;
  assert.equal(
    applyAction(before, { type: 'UPGRADE', cityId: cityB.id }).ok,
    false,
    '血战之前这个价升不动',
  );
  const r = applyAction(after, { type: 'UPGRADE', cityId: cityA.id });
  assert.ok(r.ok, '血战之后同一笔钱就够了');
});

test('每个内置扩展都被注册且带说明', () => {
  assert.ok(EXPANSIONS.length >= 6);
  for (const e of EXPANSIONS) {
    assert.ok(e.id && e.name && e.summary, `${e.id} 缺少必要字段`);
    const hasHooks = Object.keys(e.hooks).length > 0;
    const hasUnits = (e.units?.length ?? 0) > 0;
    // 时代开关也算"干了事"：它没有钩子、没有兵种，但改了能升到第几级
    // （「现代」就是这样——它只把时代上限抬到 6，兵全在「现代战争」里）
    const opensEra = typeof e.unlockEra === 'number';
    // 纯表现层扩展（比如"浓雾"把地形也遮掉）没有钩子是正常的，
    // 但它必须自己声明过 presentationOnly，否则就是"注册了个什么都不干的包"
    assert.ok(
      hasHooks || hasUnits || opensEra || e.presentationOnly === true,
      `${e.id} 既没有钩子也没有兵种，等于空包`,
    );
    if (e.presentationOnly) {
      assert.equal(hasHooks, false, `${e.id} 声明了纯表现层，就不该再带钩子`);
      assert.equal(hasUnits, false, `${e.id} 声明了纯表现层，就不该再带兵种`);
    }
  }
});

console.log('\n迷雾');

test('战报分公私：己方条目私有，战损条目双方都读得到', () => {
  const s = fresh();
  s.current = 'A';
  s.players.A.gold = 900;

  // 1) 产兵是私报：造了什么，对面没有任何理由知道（等于免费视野）
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  const r = applyAction(s, { type: 'RECRUIT', cityId: city!.id, unitType: 'militia' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const recruitLog = r.state.log.filter((e) => e.text.includes('产出'));
  assert.ok(recruitLog.length > 0, '产兵应该写一条战报');
  assert.equal(recruitLog.at(-1)!.open, undefined, '产兵不该是公开战报');

  // 2) 战损是公开的：一个兵倒下，棋盘上看得见，瞒着只会让人以为界面算错了
  const cur = r.state;
  cur.current = 'A';
  const archer = place2(cur, 'A', 'archer', 5, 5);
  const victim = place2(cur, 'B', 'militia', 6, 5);
  victim.hp = 1;
  archer.acted = false;
  archer.moved = false;
  const kill = applyAction(cur, { type: 'ATTACK', unitId: archer.id, targetId: victim.id });
  assert.ok(kill.ok, kill.ok ? '' : kill.reason);
  const open = kill.state.log.filter((e) => e.open === true);
  assert.ok(open.length > 0, '阵亡应该留下一条公开战报');
  assert.ok(
    open.some((e) => e.text.includes('被消灭') || e.text.includes('倒下')),
    `公开战报里要写着谁没了：${open.map((e) => e.text).join(' / ')}`,
  );
});

test('开局看不到对方后场', () => {  const s = fresh();
  const vis = visibleTilesOf(s, 'A');
  const enemy = s.units.find((u) => u.owner === 'B');
  assert.ok(enemy);
  assert.equal(vis.has(idx(s, enemy.x, enemy.y)), false);
});

test('playerView 裁掉视野外的敌方单位', () => {
  const s = fresh();
  // 城市位置是浮动的，开局部队的间距不再固定。这里把两边拉到对角，
  // 保证"互相看不见"这个前提成立——要测的是迷雾裁切，不是开局距离。
  let ai = 0;
  let bi = 0;
  for (const u of s.units) {
    if (u.owner === 'A') {
      u.x = 1 + (ai % 3);
      u.y = s.h - 3 + Math.floor(ai / 3);
      ai += 1;
    } else {
      u.x = s.w - 3 + (bi % 3);
      u.y = 1 + Math.floor(bi / 3);
      bi += 1;
    }
  }
  const view = playerView(s, 'A');
  assert.equal(view.state.units.filter((u) => u.owner === 'B').length, 0);
  assert.equal(view.state.units.filter((u) => u.owner === 'A').length, 7);
});

test('城市对双方都是公开信息', () => {
  const s = fresh();
  assert.equal(playerView(s, 'A').state.cities.length, 4);
});

test('见过的敌人离开视野后留下幽灵', () => {
  const s = fresh();
  const a = findUnit(s, 'A', 'scout');
  const b = findUnit(s, 'B', 'militia');

  a.x = 5;
  a.y = 3;
  b.x = 5;
  b.y = 2;
  refreshMemory(s);
  assert.ok(s.memory.A.known.some((k) => k.id === b.id));

  b.x = 14;
  b.y = 1;
  a.x = 5;
  a.y = 14;
  refreshMemory(s);

  const view = playerView(s, 'A');
  assert.equal(view.state.units.some((u) => u.id === b.id), false);
  const ghost = view.ghosts.find((g) => g.id === b.id);
  assert.ok(ghost);
  assert.equal(ghost?.y, 2);
});

test('浓雾：走过的地方会把地形和城记下来', () => {
  const s = fresh({ expansionIds: ['blackout'] });

  // 开局只能记住自己脚下这片：没走到的地方一格都不许有
  const mem = s.memory.A;
  assert.ok(mem.tiles && Object.keys(mem.tiles).length > 0, '开局就该记下自己看到的格子');
  // 反过来验：眼前看得见的格，一格都不许漏记。
  // （不反过来查"记忆里有没有此刻看不见的"——fresh() 里挪过城，
  //   早先那一眼留下的地形记录本来就该留着，那正是这份记忆的用处。）
  for (const i of visibleTilesOf(s, 'A')) {
    assert.ok(mem.tiles![i] !== undefined, `第 ${i} 格看得见却没记下来`);
  }
  // 眼前亮着的格绝不能被算成"旧记忆"，否则浓雾下会把自己脚下也压暗
  const here = Array.from(visibleTilesOf(s, 'A'))[0];
  assert.equal(playerView(s, 'A').rememberedTiles.has(here), false, '眼前看得见的格不算旧记忆');

  // 派个兵到敌城边上侦察一次，再撤回来——那片重新落回雾里
  const foeCity = citiesOf(s, 'B')[0];
  assert.ok(foeCity, 'B 应该有城');
  assert.equal(
    (mem.cities ?? []).some((c) => c.id === foeCity!.id),
    false,
    '开局没走到敌城，就不该认得它',
  );

  const scout = unitsOf(s, 'A')[0];
  const home = { x: scout.x, y: scout.y };
  scout.x = foeCity!.x;
  scout.y = Math.min(s.h - 1, foeCity!.y + foeCity!.size);
  refreshMemory(s);
  scout.x = home.x;
  scout.y = home.y;
  refreshMemory(s);

  const view = playerView(s, 'A');
  const snapped = view.rememberedCities.get(foeCity!.id);
  assert.ok(snapped, '去过的敌城应该留在地图记忆里');
  assert.equal(snapped!.owner, 'B', '记忆里的归属就是当时看到的那个');
  assert.ok(view.rememberedTiles.size > 0, '走过的地形不该随视野一起消失');

  const vis = new Set(view.visible);
  for (const i of view.rememberedTiles.keys()) {
    assert.equal(vis.has(i), false, '记忆表里不该混进眼前看得见的格');
  }

  // 记忆只能说当时：城在雾里悄悄升了级，我们不该隔着一层雾知道
  foeCity!.era = 3;
  const later = playerView(s, 'A').rememberedCities.get(foeCity!.id);
  assert.ok(later, '去过的城该一直在记忆里');
  assert.equal(later!.owner, 'B', '记忆里的归属就是当时看到的那个');
  assert.equal(later!.era, 1, '记忆里的时代不该跟着升级');
});

test('基础规则的雾不攒地形记忆', () => {
  const s = fresh();
  // 没开浓雾：地图本来就一直画在屏幕上，再存一份地形只是撑大存档
  assert.equal(s.memory.A.tiles, undefined, '不开浓雾就不该有地形记忆');
  assert.equal(s.memory.A.cities, undefined, '不开浓雾也不该有城市记忆');
  assert.equal(playerView(s, 'A').rememberedTiles.size, 0, '基础规则下没有"记忆里的地图"');
});

test('浓雾整局跑得下去：AI 照旧行动，记忆也不会越攒越大', () => {
  let state = createMatch(
    { ...BASE, size: 12, startEra: 3, aiOpponent: true, aiAlly: true, expansionIds: ['blackout'] },
    909090,
  );
  const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  let turns = 0;
  while (turns < 12 && !state.winner) {
    const act = aiNextAction(state, budget);
    if (!act) {
      const end = applyAction(state, { type: 'END_TURN' });
      assert.ok(end.ok, end.ok ? '' : end.reason);
      state = end.state;
      turns += 1;
      budget.recruited = 0;
      budget.upgraded = 0;
      continue;
    }
    const r = applyAction(state, act);
    assert.ok(r.ok, `第 ${turns} 回合 AI 提出了非法动作 ${JSON.stringify(act)}：${r.ok ? '' : r.reason}`);
    state = r.state;
    if (act.type === 'RECRUIT') budget.recruited += 1;
    if (act.type === 'UPGRADE') budget.upgraded += 1;
  }

  // 记忆是按格子覆盖写的，不是一回合追加一条——否则一局打下来会越攒越胖
  for (const p of ['A', 'B'] as PlayerId[]) {
    const n = Object.keys(state.memory[p].tiles ?? {}).length;
    assert.ok(n > 0, `${p} 方打了十几回合，总该记下点什么`);
    assert.ok(n <= state.w * state.h, `${p} 方的地形记忆最多也就是整张图：${n} > ${state.w * state.h}`);
  }
});

console.log('\n威胁范围');

test('未移动时威胁范围是"移动+射程"的并集', () => {
  const s = fresh();
  const u = findUnit(s, 'A', 'militia');
  const threat = threatTiles(s, u);
  assert.ok(threat.size > 0, '未移动时应该有威胁范围');
  // 可达格本身不算威胁范围（那是蓝的），所以这里只要求"可达格之外还有一圈"
  const reach = reachableTiles(s, u);
  for (const i of reach.keys()) {
    assert.equal(threat.has(i), false, '可达格不该同时被标成威胁');
  }
});

test('走过路之后威胁范围只剩身前一圈', () => {
  const s = fresh();
  const u = findUnit(s, 'A', 'militia');
  // 挪到棋盘内部的一块空地：地图现在宽窄不一，边角上邻居会少于四个
  const spot = emptyPlain(s);
  u.x = Math.min(Math.max(spot.x, 2), s.w - 3);
  u.y = Math.min(Math.max(spot.y, 2), s.h - 3);
  const before = threatTiles(s, u);
  u.moved = true;
  const after = threatTiles(s, u);
  // 周围要是被水围住，"移动前"本来也压不了几格，所以这里比的是"不大于"
  assert.ok(after.size <= before.size, '移动过后不该比移动前压得更广');
  assert.equal(after.size, 4, '民兵射程 1，原地只剩四个邻格');
});

test('建筑只显示身前一圈', () => {
  const s = fresh();
  const builder = addLaborer(s);
  const built = applyAction(s, { type: 'BUILD', unitId: builder.id, unitType: 'tower', x: 6, y: 5 });
  assert.ok(built.ok);
  const tower = built.state.units.find((u) => u.type === 'tower');
  assert.ok(tower);
  const threat = threatTiles(built.state, tower);
  // 箭塔射程 3：距离 1 的四格 + 距离 2 的八格 + 距离 3 的十二格
  assert.equal(threat.size, 24, '箭塔射程 3 的威胁圈应该是 24 格');
});

console.log('\n能力系统');

/** 给某个兵种临时挂上能力 */
function grantAbility(s: GameState, typeId: string, abil: string): void {
  const def = s.unitTypes[typeId];
  assert.ok(def, `没有兵种 ${typeId}`);
  def.abilities = Array.from(new Set([...(def.abilities ?? []), abil]));
}

test('先手：攻击后不吃反击', () => {
  const s = fresh();
  grantAbility(s, 'militia', 'first-strike');
  const { a, b } = duel(s);
  const hpBefore = a.hp;
  const r = applyAction(s, { type: 'ATTACK', unitId: a.id, targetId: b.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.find((u) => u.id === a.id)?.hp, hpBefore, '先手单位不该掉血');
});

test('破甲：无视目标一半护甲', () => {
  const s = fresh();
  const { a, b } = duel(s);
  const normal = computeDamage(s, a, b);
  grantAbility(s, 'militia', 'armor-pierce');
  const pierced = computeDamage(s, a, b);
  // 民兵攻 13、甲 2：普通 11；破甲把对方甲砍半算 1，伤害 12
  assert.equal(normal, 11);
  assert.equal(pierced, 12);
});

test('盾墙：本回合没移动时减伤 2', () => {
  const s = fresh();
  const { a, b } = duel(s);
  const normal = computeDamage(s, a, b);
  grantAbility(s, 'militia', 'shield-wall');
  b.moved = false;
  assert.equal(computeDamage(s, a, b), normal - 2);
  b.moved = true;
  assert.equal(computeDamage(s, a, b), normal, '移动过就不该有盾墙');
});

test('穿林：森林和丘陵的移动消耗按 1 算', () => {
  const s = fresh();
  const u = findUnit(s, 'A', 'militia');
  // 找一个森林格
  const forestIdx = s.tiles.findIndex((t) => t.terrain === 'forest');
  if (forestIdx < 0) return; // 这张图上没有森林就跳过
  const fx = forestIdx % s.w;
  const fy = Math.floor(forestIdx / s.w);
  u.x = fx;
  u.y = fy + 1 <= s.h - 1 ? fy + 1 : fy - 1;
  s.tiles[idx(s, u.x, u.y)].terrain = 'plain';

  const before = reachableTiles(s, u);
  grantAbility(s, 'militia', 'forest-walk');
  const after = reachableTiles(s, u);
  assert.ok(after.size >= before.size, '穿林之后可达格不该变少');
  assert.ok(after.has(idx(s, fx, fy)), '森林格应该能走进去');
});

/** 找一块空着的、不在城里的平地，取不到就抛 */
function emptyPlain(s: GameState, skip: number[] = []): { x: number; y: number; i: number } {
  for (let i = 0; i < s.tiles.length; i++) {
    if (skip.includes(i)) continue;
    const t = s.tiles[i];
    if (!t || t.terrain !== 'plain' || t.cityId) continue;
    if (s.units.some((u) => u.y * s.w + u.x === i)) continue;
    return { x: i % s.w, y: Math.floor(i / s.w), i };
  }
  throw new Error('这张图上找不到空地');
}

test('潜行：蹲在林子里，隔两格就看不见', () => {
  const s = fresh(); // fresh() 会把森林抹平，所以这里自己种一棵
  s.fog = true;
  const lurker = findUnit(s, 'B', 'scout'); // 斥候自带潜行
  const spotter = findUnit(s, 'A', 'militia');

  const spot = emptyPlain(s);
  s.tiles[spot.i] = { terrain: 'forest', cityId: null };
  lurker.x = spot.x;
  lurker.y = spot.y;

  // 观察者摆在左边两格外（靠边的那一侧可能在棋盘外，所以往左找）
  const sx = spot.x - 2 >= 0 ? spot.x - 2 : spot.x + 2;
  spotter.x = sx;
  spotter.y = spot.y;
  s.tiles[spotter.y * s.w + spotter.x] = { terrain: 'plain', cityId: null };

  const seen = () => playerView(s, 'A').state.units.some((u) => u.id === lurker.id);

  assert.equal(seen(), false, '潜行中的斥候不该出现在对方视图里');

  // 贴到相邻格就藏不住了
  spotter.x = spot.x - 1 >= 0 ? spot.x - 1 : spot.x + 1;
  assert.equal(seen(), true, '相邻时应该被发现');
});

test('潜行：站在开阔地上没有用', () => {
  const s = fresh();
  s.fog = true;
  const lurker = findUnit(s, 'B', 'scout');
  const spotter = findUnit(s, 'A', 'militia');

  const spot = emptyPlain(s); // 保持平地
  lurker.x = spot.x;
  lurker.y = spot.y;
  const sx = spot.x - 2 >= 0 ? spot.x - 2 : spot.x + 2;
  spotter.x = sx;
  spotter.y = spot.y;
  s.tiles[spotter.y * s.w + spotter.x] = { terrain: 'plain', cityId: null };

  assert.ok(
    playerView(s, 'A').state.units.some((u) => u.id === lurker.id),
    '开阔地上应该看得见',
  );
});

test('潜行：关掉迷雾就没这回事', () => {
  const s = fresh();
  s.fog = false;
  const lurker = findUnit(s, 'B', 'scout');
  const spotter = findUnit(s, 'A', 'militia');

  const spot = emptyPlain(s);
  s.tiles[spot.i] = { terrain: 'forest', cityId: null };
  lurker.x = spot.x;
  lurker.y = spot.y;
  const sx = spot.x - 2 >= 0 ? spot.x - 2 : spot.x + 2;
  spotter.x = sx;
  spotter.y = spot.y;
  s.tiles[spotter.y * s.w + spotter.x] = { terrain: 'plain', cityId: null };

  assert.ok(
    playerView(s, 'A').state.units.some((u) => u.id === lurker.id),
    '没有迷雾就不该有隐藏',
  );
});

test('休整：待着不动就回血', () => {
  const s = fresh();
  grantAbility(s, 'militia', 'heal');
  const u = findUnit(s, 'A', 'militia');
  u.hp = 10;
  const r1 = applyAction(s, { type: 'END_TURN' });
  assert.ok(r1.ok);
  const r2 = applyAction(r1.state, { type: 'END_TURN' });
  assert.ok(r2.ok);
  const healed = r2.state.units.find((x) => x.id === u.id);
  assert.ok((healed?.hp ?? 0) > 10, '闲着的一回合应该回血');
});

test('休整：动过手就不回血', () => {
  const s = fresh();
  grantAbility(s, 'militia', 'heal');
  const u = findUnit(s, 'A', 'militia');
  u.hp = 10;
  u.moved = true; // 上一个自己的回合动过，这一拍就不算休整
  const r1 = applyAction(s, { type: 'END_TURN' });
  assert.ok(r1.ok);
  const r2 = applyAction(r1.state, { type: 'END_TURN' });
  assert.ok(r2.ok);
  const after = r2.state.units.find((x) => x.id === u.id);
  assert.equal(after?.hp, 10, '动过的单位不该回血');
});

test('指挥光环：相邻友军攻击 +2', () => {
  const s = fresh();
  grantAbility(s, 'militia', 'aura-command');
  const leader = findUnit(s, 'A', 'militia');
  const follower = findUnit(s, 'A', 'archer');
  const target = findUnit(s, 'B', 'militia');

  leader.x = 5;
  leader.y = 5;
  follower.x = 5;
  follower.y = 6;
  target.x = 5;
  target.y = 7;
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 6)].terrain = 'plain';
  s.tiles[idx(s, 5, 7)].terrain = 'plain';

  const buffed = computeDamage(s, follower, target);
  // 把队长挪远，光环应该失效
  leader.x = 1;
  leader.y = 1;
  const plain = computeDamage(s, follower, target);
  assert.equal(buffed - plain, 2);
});

test('破城：攻城伤害 ×1.5', () => {
  const s = fresh();
  const cav = findUnit(s, 'A', 'scout');
  const city = citiesOf(s, 'B')[0];
  assert.ok(city);
  const normal = damageToCity(cav, city, s);
  grantAbility(s, 'scout', 'siege-master');
  const boosted = damageToCity(cav, city, s);
  // 破城现在作用于攻击力，而不是最终伤害
  const expected = Math.max(0, Math.round((normal + city.armor) * 1.5 - city.armor));
  assert.equal(boosted, expected);
});

test('自爆：阵亡时波及四周', () => {
  const s = fresh();
  grantAbility(s, 'militia', 'kamikaze');
  const { a, b } = duel(s);
  const bystander = findUnit(s, 'A', 'archer');
  bystander.x = b.x + 1;
  bystander.y = b.y;
  s.tiles[idx(s, bystander.x, bystander.y)].terrain = 'plain';
  b.hp = 1;

  const beforeHp = bystander.hp;
  const r = applyAction(s, { type: 'ATTACK', unitId: a.id, targetId: b.id });
  assert.ok(r.ok);
  assert.equal(r.state.units.some((u) => u.id === b.id), false, '目标应该被打死');
  const after = r.state.units.find((u) => u.id === bystander.id);
  assert.ok((after?.hp ?? 0) < beforeHp, '自爆应该波及旁边的人');
});

test('每个内置能力都有说明且能被查到', () => {
  assert.ok(allAbilities().length >= 8);
  for (const a of allAbilities()) {
    assert.ok(a.id && a.name && a.summary, `${a.id} 缺字段`);
  }
});

test('能力各归各家：公共词汇在本体，扩展的能力写在扩展文件里', () => {
  // 这条用例守的是**结构**，不是数值：能力的实现属于兵种设计，
  // 只被一个扩展用到的能力不该躺在本体的 abilities.ts 里。
  // 没有它，这次重构过半年就会退回原样——因为往回加一行永远比搬走更省事。
  const EDITOR_ONLY = new Set(['heal', 'fly', 'fly-over', 'versatile']);

  /** id → 用到它的来源（'core' 或某个扩展 id） */
  const owners = new Map<string, Set<string>>();
  const claim = (owner: string, ids: string[] | undefined) => {
    for (const id of ids ?? []) {
      const set = owners.get(id) ?? new Set<string>();
      set.add(owner);
      owners.set(id, set);
    }
  };
  for (const u of Object.values(UNIT_TYPES)) claim('core', u.abilities);
  for (const e of EXPANSIONS) for (const u of e.units ?? []) claim(e.id, u.abilities);

  // 1) 本体只留公共词汇
  for (const a of CORE_ABILITIES) {
    const who = owners.get(a.id);
    if (!who || EDITOR_ONLY.has(a.id)) continue;
    assert.ok(
      who.has('core') || who.size >= 2,
      `「${a.name}」（${a.id}）只被 ${[...who].join('、')} 用到，应该搬回那个扩展`,
    );
  }

  // 2) 同一条能力不许在两处各写一份：合并时"核心优先"，重复的那份会静默失效，
  //    以后改扩展里那份的人会以为改动生效了。
  const seen = new Set(CORE_ABILITIES.map((a) => a.id));
  for (const e of EXPANSIONS) {
    for (const a of e.abilities ?? []) {
      assert.ok(!seen.has(a.id), `能力 ${a.id} 在 ${e.id} 里重复声明了`);
      seen.add(a.id);
    }
  }

  // 反过来不查：扩展可以先声明一条暂时没有兵种在用的能力（「大净化」就是这样，
  // 它是商店里没上架的货）。这条只对**本体**有约束——本体多一条没人用的，
  // 通常意味着有段实现忘了跟着搬走。
});

console.log('\n水军与桥梁');

/** 找一块水，且它旁边有一块空着的陆地 */
function waterWithBank(
  s: GameState,
): { water: { x: number; y: number }; land: { x: number; y: number } } | null {
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (s.tiles[idx(s, x, y)].terrain !== 'water') continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
        const t = s.tiles[idx(s, nx, ny)];
        if (t.terrain === 'water' || t.terrain === 'mountain' || t.cityId) continue;
        if (s.units.some((u) => u.x === nx && u.y === ny)) continue;
        return { water: { x, y }, land: { x: nx, y: ny } };
      }
    }
  }
  return null;
}

/** 手动摆一个单位（开局编制里没有水军和工程队） */
function place(s: GameState, owner: 'A' | 'B', type: string, x: number, y: number): Unit {
  // 先查**本局**的兵种表，再退回原版表：扩展包的兵只存在于开了那个包的对局里，
  // 拿 UNIT_TYPES 去找一律找不到。上限（hp）也从同一处读，别混用两张表。
  const def = s.unitTypes[type] ?? UNIT_TYPES[type];
  assert.ok(def, `没有 ${type} 这个兵种`);
  const u: Unit = {
    id: `t${s.units.length + 1}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  };
  s.units = s.units.filter((k) => !(k.x === x && k.y === y));
  s.units.push(u);
  return u;
}

/** 最大的一片连通水体（四连通） */
function biggestWaterBody(s: GameState): Array<{ x: number; y: number }> {
  const seen = new Set<number>();
  let best: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i0 = idx(s, x, y);
      if (seen.has(i0) || s.tiles[i0]?.terrain !== 'water') continue;
      const body: Array<{ x: number; y: number }> = [];
      const stack = [{ x, y }];
      seen.add(i0);
      while (stack.length > 0) {
        const p = stack.pop() as { x: number; y: number };
        body.push(p);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = p.x + dx;
          const ny = p.y + dy;
          if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
          const ni = idx(s, nx, ny);
          if (seen.has(ni) || s.tiles[ni]?.terrain !== 'water') continue;
          seen.add(ni);
          stack.push({ x: nx, y: ny });
        }
      }
      if (body.length > best.length) best = body;
    }
  }
  return best;
}

/**
 * 在 x 列挖一条水道，两侧各留一格河岸。
 *
 * 测试不靠地图碰运气：桥梁相关的东西都需要"一条明确的两岸"，
 * 生成出来的河不一定正好在手边，自己挖一条最省事。
 */
function digRiver(s: GameState, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (const xx of [x - 1, x, x + 1]) {
      const t = s.tiles[idx(s, xx, y)];
      if (!t || t.cityId) continue;
      t.terrain = xx === x ? 'water' : 'plain';
    }
  }
  // 河道里的东西一律清掉，免得单位站在水里
  s.units = s.units.filter((u) => u.x !== x || u.y < y0 || u.y > y1);
}

/** 在 (x,y) 上架一座桥，返回架好之后的状态 */
function bridgeAt(s: GameState, x: number, y: number, fromX: number): GameState {
  s.current = 'A';
  s.players.A.gold = 900;
  const laborer = place(s, 'A', 'laborer', fromX, y);
  const r = applyAction(s, {
    type: 'BUILD',
    unitId: laborer.id,
    unitType: 'bridge',
    x,
    y,
  });
  assert.ok(r.ok, r.ok ? '' : `架桥失败：${r.reason}`);
  const out = r.state;
  out.units = out.units.filter((u) => u.id !== laborer.id);
  return out;
}

test('水军只能在水上走，而且真的走得动', () => {
  // 用河流图，保证水是连成片的——不然"船的落点都是水"这种全称命题
  // 在"船根本走不动"的情况下也成立，测试等于没测。
  const s = fresh({ mapStyle: 'river-h' }, 1000);
  const spot = waterWithBank(s);
  assert.ok(spot, '这张图上应该有水');

  assert.equal(
    s.units.some((u) => s.unitTypes[u.type]?.domain === 'water'),
    false,
    '开局部队不该有水军（会卡在岸上）',
  );

  // 找最大的一片水，把船放进去
  const body = biggestWaterBody(s);
  assert.ok(body.length >= 8, `河流图应该有成片的水，实际最大 ${body.length} 格`);
  const boat = place(s, 'A', 'boat', body[0]!.x, body[0]!.y);
  const reach = reachableTiles(s, boat);
  assert.ok(reach.size > 0, '船必须能动（水面代价别按陆军的 99 算）');
  for (const i of reach.keys()) {
    assert.equal(s.tiles[i]?.terrain, 'water', '船的落点只能是水');
  }
  assert.ok(!reach.has(idx(s, spot.land.x, spot.land.y)), '船不该能上岸');

  // 反过来：陆军的可达格不能有水面
  const land = s.units.find((u) => u.owner === 'A' && s.unitTypes[u.type]?.domain !== 'water');
  assert.ok(land);
  for (const i of reachableTiles(s, land).keys()) {
    assert.notEqual(s.tiles[i]?.terrain, 'water', '陆军不该能进水');
  }
});

test('船只能从临水城市下水', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.current = 'A';
  s.players.A.gold = 900;

  // 先把城边的水全填平，确保"没港口"
  for (const t of cityTiles(city)) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = t.x + dx;
      const y = t.y + dy;
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      if (s.tiles[idx(s, x, y)].terrain === 'water') {
        s.tiles[idx(s, x, y)] = { terrain: 'plain', cityId: null };
      }
    }
  }

  const noPort = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'boat' });
  assert.equal(noPort.ok, false, '不临水就不该能造船');

  // 挖一格水再试
  const t0 = cityTiles(city)[0];
  assert.ok(t0);
  const wx = t0.x - 1 >= 0 ? t0.x - 1 : t0.x + 2;
  s.tiles[idx(s, wx, t0.y)] = { terrain: 'water', cityId: null };
  s.units = s.units.filter((u) => !(u.x === wx && u.y === t0.y));

  const r = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'boat' });
  assert.ok(r.ok, r.ok ? '' : `临水了还是造不出：${r.reason}`);
  const boat = unitsOf(r.state, 'A').find((u) => u.type === 'boat');
  assert.ok(boat, '船没下水');
  assert.equal(
    r.state.tiles[idx(r.state, boat.x, boat.y)].terrain,
    'water',
    '船应该停在水上',
  );
});

test('架桥：水面变桥面，友军能过，也能停在桥上', () => {
  const s = fresh();
  const spot = waterWithBank(s);
  assert.ok(spot, '需要一块水');

  const laborer = place(s, 'A', 'laborer', spot.land.x, spot.land.y);
  s.current = 'A';
  s.players.A.gold = 900;

  const r = applyAction(s, {
    type: 'BUILD',
    unitId: laborer.id,
    unitType: 'bridge',
    x: spot.water.x,
    y: spot.water.y,
  });
  assert.ok(r.ok, r.ok ? '' : `架桥失败：${r.reason}`);

  const bridge = r.state.units.find((u) => u.type === 'bridge');
  assert.ok(bridge, '应该出现一座桥');
  assert.ok(bridge.hp > 0, '桥应该是有耐久的');
  assert.equal(
    r.state.tiles[idx(r.state, spot.water.x, spot.water.y)].terrain,
    'bridge',
    '水格应该变成桥面',
  );

  // 桥格既能过，也能停：桥是地面设施，人可以站在上面。
  // 以前这里断言"停不下来"，结果一条桥修好之后只能穿过去——
  // 守桥、堵桥、在桥上换气全都做不了，桥的价值被砍掉一半。
  const crosser = place(r.state, 'A', 'militia', spot.land.x, spot.land.y);
  const reach = reachableTiles(r.state, crosser);
  assert.ok(
    reach.has(idx(r.state, spot.water.x, spot.water.y)),
    '桥面应该可以停留',
  );

  // 站上去之后：这格在 unitAt 眼里是"人"，不是桥
  const moved = applyAction(r.state, {
    type: 'MOVE',
    unitId: crosser.id,
    x: spot.water.x,
    y: spot.water.y,
  });
  assert.ok(moved.ok, moved.ok ? '' : `上桥失败：${moved.reason}`);
  assert.equal(unitAt(moved.state, spot.water.x, spot.water.y)?.id, crosser.id, 'unitAt 应该返回站在桥上的人');
});

test('敌方造的桥，谁都能站上去', () => {
  // 桥在数据上属于造它的人，在规则上只是一格地形。
  // 这条用例守的是最容易被改坏的那一半：桥单位被当成"敌方占位"挡在
  // reachableTiles 外面，于是玩家只能隔河干看——桥修好了却上不去。
  const s = fresh();
  const spot = waterWithBank(s);
  assert.ok(spot, '需要一块水');

  const laborer = place(s, 'B', 'laborer', spot.land.x, spot.land.y);
  s.current = 'B';
  s.players.B.gold = 900;
  const r = applyAction(s, {
    type: 'BUILD',
    unitId: laborer.id,
    unitType: 'bridge',
    x: spot.water.x,
    y: spot.water.y,
  });
  assert.ok(r.ok, r.ok ? '' : `B 架桥失败：${r.reason}`);
  const bridge = r.state.units.find((u) => u.type === 'bridge');
  assert.equal(bridge?.owner, 'B', '桥应该记在造它的人名下');

  const st = r.state;
  // 桥边换 A 的兵站：place 会把同格上的 B 工程队挤走，岸上正好空出来
  const trooper = place(st, 'A', 'militia', spot.land.x, spot.land.y);
  st.current = 'A';
  assert.ok(
    reachableTiles(st, trooper).has(idx(st, spot.water.x, spot.water.y)),
    '敌方的桥面也该进可达范围',
  );
  const moved = applyAction(st, {
    type: 'MOVE',
    unitId: trooper.id,
    x: spot.water.x,
    y: spot.water.y,
  });
  assert.ok(moved.ok, moved.ok ? '' : `站上敌桥失败：${moved.reason}`);
  assert.equal(unitAt(moved.state, spot.water.x, spot.water.y)?.id, trooper.id, '人就该站在桥上');
  // 站上去之后地形仍是桥面：桥还在，别人照样能过
  assert.equal(moved.state.tiles[idx(moved.state, spot.water.x, spot.water.y)].terrain, 'bridge');
});

test('桥是双向的：东西两岸互相都过得去', () => {
  const build = () => {
    const s = fresh();
    clearArea(s, 6, 4, 10, 10);
    digRiver(s, 8, 3, 12);
    return bridgeAt(s, 8, 7, 7);
  };

  // 西岸 → 东岸
  const west = build();
  const fromWest = place(west, 'A', 'militia', 7, 7);
  assert.ok(fromWest);
  assert.ok(reachableTiles(west, fromWest).has(idx(west, 9, 7)), '西岸的单位应该能过桥到东岸');

  // 东岸 → 西岸（同一座桥，反方向；以前这里是过不去的）
  const east = build();
  const fromEast = place(east, 'B', 'militia', 9, 7);
  assert.ok(fromEast);
  assert.ok(reachableTiles(east, fromEast).has(idx(east, 7, 7)), '东岸的单位应该能过桥到西岸');
});

test('船能从桥底下过，桥不挡水路', () => {
  const s = fresh();
  clearArea(s, 6, 4, 10, 10);
  digRiver(s, 8, 3, 12);
  const cur = bridgeAt(s, 8, 7, 7);
  const boat = place(cur, 'A', 'boat', 8, 6);
  const reach = reachableTiles(cur, boat);
  assert.ok(reach.has(idx(cur, 8, 9)), '桥在 (8,7)，船应该能顺流穿过去');
  // 桥下也能停船：那一格地形还是水面，桥只是架在上面
  assert.ok(reach.has(idx(cur, 8, 7)), '船可以停在桥下');
});

test('桥会被打掉，打掉之后变回水面', () => {
  const s = fresh();
  const spot = waterWithBank(s);
  assert.ok(spot, '需要一块水');
  const laborer = place(s, 'A', 'laborer', spot.land.x, spot.land.y);
  s.current = 'A';
  s.players.A.gold = 900;

  const built = applyAction(s, {
    type: 'BUILD',
    unitId: laborer.id,
    unitType: 'bridge',
    x: spot.water.x,
    y: spot.water.y,
  });
  assert.ok(built.ok, built.ok ? '' : `架桥失败：${built.reason}`);

  let cur = built.state;
  const bridge = cur.units.find((u) => u.type === 'bridge');
  assert.ok(bridge);
  const hitter = place(cur, 'B', 'militia', spot.land.x, spot.land.y);

  let guard = 0;
  while (cur.units.some((u) => u.type === 'bridge') && guard < 8) {
    guard += 1;
    cur.current = 'B';
    const atk = cur.units.find((u) => u.id === hitter.id);
    if (!atk) break;
    readyAgain(atk);
    const hit = applyAction(cur, { type: 'ATTACK', unitId: atk.id, targetId: bridge.id });
    if (!hit.ok) break;
    cur = hit.state;
  }

  assert.ok(!cur.units.some((u) => u.type === 'bridge'), '桥应该被打掉了');
  assert.equal(
    cur.tiles[idx(cur, spot.water.x, spot.water.y)].terrain,
    'water',
    '桥没了，地形应该退回水面',
  );
});

console.log('\n军营');

test('军营只能扎在平地或丘陵上，而且必须临水', () => {
  const s = fresh();
  const laborer = place(s, 'A', 'laborer', 5, 5);
  s.current = 'A';
  s.players.A.gold = 900;

  // 先把周围一圈清成平原，免得地图自带的水干扰"临水"判断
  const set = (x: number, y: number, terrain: 'plain' | 'hill' | 'forest' | 'water') => {
    s.tiles[idx(s, x, y)] = { terrain, cityId: null };
  };
  for (let y = 3; y <= 7; y++) for (let x = 3; x <= 7; x++) set(x, y, 'plain');
  const build = (x: number, y: number) =>
    applyAction(s, { type: 'BUILD', unitId: laborer.id, unitType: 'camp', x, y });

  // 一格水同时挨着 (6,5) 和 (5,6)
  set(6, 6, 'water');
  set(6, 5, 'plain');
  assert.ok(build(6, 5).ok, '临水的平地应该能扎营');
  set(5, 6, 'hill');
  assert.ok(build(5, 6).ok, '临水的丘陵应该能扎营');
  set(4, 5, 'forest');
  assert.equal(build(4, 5).ok, false, '森林里扎不了营');
  set(5, 4, 'water');
  assert.equal(build(5, 4).ok, false, '水里扎不了营');

  // 把水填掉，同一块平地就不该再能扎营了
  set(6, 6, 'plain');
  const dry = build(6, 5);
  assert.equal(dry.ok, false, '不临水就不该能扎营');
});

test('军营能扎在桥头：桥面也算临水', () => {
  // 规则书里写的是"四邻还要有一格水面（桥面也算，桥下就是河）"。
  // 但判定曾经自己写了一遍 `terrain === 'water'`——桥一格是 `bridge`，
  // 于是桥头被判"不临水"；而界面上的建造高亮用的是 `adjacentToWater`（认桥面），
  // 一路高亮成"可建"，点下去才回一句"必须扎在水边"。
  const s = fresh();
  const laborer = place(s, 'A', 'laborer', 5, 5);
  s.current = 'A';
  s.players.A.gold = 900;

  const set = (x: number, y: number, terrain: Terrain) => {
    s.tiles[idx(s, x, y)] = { terrain, cityId: null };
  };
  for (let y = 3; y <= 7; y++) for (let x = 3; x <= 7; x++) set(x, y, 'plain');

  // (6,6) 是架了桥的那格水。先确认"只有桥、没有水"时也能扎营
  set(6, 6, 'bridge');
  const onBridge = applyAction(s, { type: 'BUILD', unitId: laborer.id, unitType: 'camp', x: 6, y: 5 });
  assert.ok(
    onBridge.ok,
    `桥头应该能扎营（桥下就是河）：${onBridge.ok ? '' : onBridge.reason}`,
  );

  // 界面上高亮的那一套判据也要同意，否则"高亮了却建不了"会回来
  assert.equal(adjacentToWater(s, 6, 5), true, '高亮用的判据也得认桥面');

  // 反过来：把桥拆成平地之后，同一格就不该再能扎营（免得放宽成"随便扎"）
  const dry = fresh();
  const laborer2 = place(dry, 'A', 'laborer', 5, 5);
  dry.current = 'A';
  dry.players.A.gold = 900;
  for (let y = 3; y <= 7; y++) for (let x = 3; x <= 7; x++) {
    dry.tiles[idx(dry, x, y)] = { terrain: 'plain', cityId: null };
  }
  const noWater = applyAction(dry, { type: 'BUILD', unitId: laborer2.id, unitType: 'camp', x: 6, y: 5 });
  assert.equal(noWater.ok, false, '一格水都没有的时候仍然不许扎营');
});

test('军营能像城市一样产兵', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.current = 'A';
  s.players.A.gold = 900;

  const camp = place(s, 'A', 'camp', 5, 5);
  const before = unitsOf(s, 'A').length;

  const r = applyAction(s, { type: 'RECRUIT', unitId: camp.id, unitType: 'militia' });
  assert.ok(r.ok, r.ok ? '' : `军营出兵失败：${r.reason}`);
  assert.equal(unitsOf(r.state, 'A').length, before + 1, '应该多出一个兵');

  const born = unitsOf(r.state, 'A').filter((u) => u.type === 'militia' && distance(u, camp) === 1);
  assert.equal(born.length, 1, '兵应该从军营四邻出来');
});

test('军营产兵的时代取最近的己方城市', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.current = 'A';
  s.players.A.gold = 900;

  // 一座二级城：能造一级和二级兵
  city.era = 2;
  const camp = place(s, 'A', 'camp', city.x + 2, city.y);

  const r = applyAction(s, { type: 'RECRUIT', unitId: camp.id, unitType: 'spearman' });
  assert.ok(r.ok, r.ok ? '' : `二级兵应该能从军营出：${r.reason}`);
});

test('军营的时代落成即钉死：后方升级不会让老营跟着换代', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.current = 'A';
  s.players.A.gold = 900;
  city.era = 1;

  // 清出一块空地，旁边留一格水，让军营"临水"这一条过得去
  const set = (x: number, y: number, terrain: 'plain' | 'water') => {
    s.tiles[idx(s, x, y)] = { terrain, cityId: null };
  };
  for (let y = 3; y <= 7; y++) for (let x = 3; x <= 7; x++) set(x, y, 'plain');
  set(6, 6, 'water');

  const laborer = place(s, 'A', 'laborer', 5, 5);
  const r = applyAction(s, { type: 'BUILD', unitId: laborer.id, unitType: 'camp', x: 6, y: 5 });
  assert.ok(r.ok, r.ok ? '' : `扎营失败：${r.reason}`);

  const cur = r.state;
  const camp = unitsOf(cur, 'A').find((u) => u.type === 'camp');
  assert.ok(camp, '营应该扎起来了');
  assert.equal(camp.era, 1, '动工那一刻的时代要钉在营上');

  // 后方升到火器时代：这座一级营不该隔空跟着换代
  const mine = cur.cities.find((c) => c.id === city.id);
  assert.ok(mine);
  mine.era = 3;
  cur.players.A.gold = 900;

  const stale = applyAction(cur, { type: 'RECRUIT', unitId: camp.id, unitType: 'musketeer' });
  assert.equal(stale.ok, false, '老营不该跟着后方换代');

  // 同一座三级城造同样的兵就没问题——差别只在"这座营是哪年扎的"
  const fromCity = applyAction(cur, { type: 'RECRUIT', cityId: city.id, unitType: 'musketeer' });
  assert.ok(fromCity.ok, fromCity.ok ? '' : `三级城应该能出火枪兵：${fromCity.reason}`);
});

test('敌方城市里不许建造', () => {
  const s = fresh();
  s.current = 'A';
  s.players.A.gold = 900;

  const foe = citiesOf(s, 'B')[0];
  assert.ok(foe, '对手应该有一座城');

  // 站到敌人城墙根底下，往城里盖塔
  const laborer = place(s, 'A', 'laborer', foe.x - 1, foe.y);
  const r = applyAction(s, {
    type: 'BUILD',
    unitId: laborer.id,
    unitType: 'tower',
    x: foe.x,
    y: foe.y,
  });
  assert.equal(r.ok, false, '敌城里不该能盖东西');
  assert.match(r.ok ? '' : r.reason, /敌方城市/, '理由要说清是"敌城"，不是"格子上有东西"');
});

test('没有城市，军营就补不上兵', () => {
  const s = fresh();
  s.current = 'A';
  s.players.A.gold = 900;

  s.cities = s.cities.filter((c) => c.owner !== 'A');
  const camp = place(s, 'A', 'camp', 5, 5);
  const r = applyAction(s, { type: 'RECRUIT', unitId: camp.id, unitType: 'militia' });
  assert.equal(r.ok, false, '断了补给的军营不该还能出兵');
});

test('军营不能给敌军产兵，也不是城市', () => {
  const s = fresh();
  s.current = 'B';
  s.players.B.gold = 900;
  const camp = place(s, 'A', 'camp', 5, 5);
  const r = applyAction(s, { type: 'RECRUIT', unitId: camp.id, unitType: 'militia' });
  assert.equal(r.ok, false, '敌方军营不该听你的');
});

console.log('\n平衡：机动与视野');

test('机动与视野整体削过一轮（回归锚点）', () => {
  const all = Object.values(UNIT_TYPES);
  assert.equal(Math.max(...all.map((u) => u.move)), 4, '最快的单位是 4 格（原来 5）');
  assert.equal(Math.max(...all.map((u) => u.vision)), 5, '视野最远 5 格（原来 6）');

  // move 2 是地板：森林和丘陵的进入消耗是 2，再削就永远进不了林子
  assert.ok(Math.min(...all.filter((u) => u.move > 0).map((u) => u.move)) >= 1, '没有单位被削成 0');
  for (const u of all) {
    if (u.category === 'building') continue;
    if (u.move === 1) continue; // 机枪、火炮本来就走不动
    assert.ok(u.move >= 2, `${u.name} 的移动力被削穿了：${u.move}`);
  }
  assert.equal(UNIT_TYPES.militia?.move, 2);
  assert.equal(UNIT_TYPES.militia?.vision, 2);
});

console.log('\n城市回血');

/** 让 A 方城市掉到半血，并在城里放一个驻军 */
function woundedCity(s: GameState, garrison = 1): City {
  const city = citiesOf(s, 'A')[0];
  assert.ok(city, '应该有 A 方城市');
  city.hp = 10;
  s.units = s.units.filter((u) => u.owner === 'A');
  // 城墙外清场，免得"被围城"这条干扰
  s.units = s.units.filter((u) => distToCity(u, city) > 1);
  const tiles = cityTiles(city);
  for (let i = 0; i < garrison; i++) {
    const t = tiles[i];
    assert.ok(t);
    place(s, 'A', 'militia', t.x, t.y);
  }
  s.current = 'A';
  return city;
}

/** 走完两个回合：A 结束 → B 结束 → 回到 A（这时 A 的城市结算回血） */
function fullCycle(s: GameState): GameState {
  const a = applyAction(s, { type: 'END_TURN' });
  assert.ok(a.ok, a.ok ? '' : `结束回合失败：${a.reason}`);
  const b = applyAction(a.state, { type: 'END_TURN' });
  assert.ok(b.ok, b.ok ? '' : `结束回合失败：${b.reason}`);
  return b.state;
}

test('有驻军的城市每回合回血', () => {
  const s = fresh();
  const city = woundedCity(s, 1);
  const after = cityById(fullCycle(s), city.id);
  assert.ok(after);
  assert.equal(after.hp, 10 + CONFIG.cityRegen, '应该按配置回血');
  assert.ok(CONFIG.cityRegen > 0);
});

test('城里没有驻军就不回血', () => {
  const s = fresh();
  const city = woundedCity(s, 0);
  const after = cityById(fullCycle(s), city.id);
  assert.ok(after);
  assert.equal(after.hp, 10, '空城不该自己回血');
});

test('被围城时不能休整', () => {
  const s = fresh();
  const city = woundedCity(s, 1);
  // 放一个敌人贴在城墙外一圈
  const ring = cityTiles(city)
    .flatMap((t) => [
      { x: t.x + 1, y: t.y },
      { x: t.x - 1, y: t.y },
      { x: t.x, y: t.y + 1 },
      { x: t.x, y: t.y - 1 },
    ])
    .find((p) => {
      const tile = s.tiles[idx(s, p.x, p.y)];
      return tile && tile.terrain !== 'water' && tile.terrain !== 'mountain' && !tile.cityId && !unitAt(s, p.x, p.y);
    });
  assert.ok(ring, '城墙外应该有能站人的格子');
  place(s, 'B', 'militia', ring.x, ring.y);

  const after = cityById(fullCycle(s), city.id);
  assert.ok(after);
  assert.equal(after.hp, 10, '被围着就不该回血');
});

test('驻军越多回得越快，但有上限', () => {
  const s = fresh();
  const city = woundedCity(s, 4);
  const heal = cityRegenOf(s, city);
  assert.equal(heal, CONFIG.cityRegenCap, `四个驻军应该顶到上限，实际 ${heal}`);
  assert.ok(heal > CONFIG.cityRegen);
});

test('回血不会超过耐久上限', () => {
  const s = fresh();
  const city = woundedCity(s, 1);
  city.hp = city.maxHp - 1;
  const after = cityById(fullCycle(s), city.id);
  assert.ok(after);
  assert.equal(after.hp, after.maxHp, '最多回到满耐久');
});

console.log('\n无渡口河');

test('无渡口的河贯通全图，陆军过不去，只能架桥', () => {
  let found = 0;
  for (const size of [12, 16, 20]) {
    for (let seed = 1; seed <= 40; seed++) {
      for (const style of ['river-h', 'river-v'] as const) {
        const m = generateLayout(size, seed * 37 + size, ['militia'], { style });
        if (!m.fordless) continue;
        found += 1;

        // 1) 只有"河把两军隔开"的对峙布局才允许无渡口
        assert.equal(m.layout, 'split', '无渡口只出现在对峙布局上');

        // 2) 贯通：沿河方向每一列都得有水，绕不过去
        const axis = style === 'river-h' ? 'h' : 'v';
        const len = axis === 'h' ? m.w : m.h;
        for (let t = 0; t < len; t++) {
          let water = 0;
          const span = axis === 'h' ? m.h : m.w;
          for (let k = 0; k < span; k++) {
            const ch = axis === 'h' ? m.rows[k]?.[t] : m.rows[t]?.[k];
            if (ch === '~') water += 1;
          }
          assert.ok(water > 0, `${size} seed=${seed}：第 ${t} 列没有水，河没贯通`);
        }

        // 3) 真的过不去
        const land = (ch: string | undefined) => ch !== '~' && ch !== '^';
        const start = m.citiesA[0];
        assert.ok(start);
        const seen = new Set<number>([start.y * size + start.x]);
        const queue = [start.y * size + start.x];
        while (queue.length > 0) {
          const i = queue.pop() as number;
          const x = i % size;
          const y = Math.floor(i / size);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const j = ny * size + nx;
            if (seen.has(j) || !land(m.rows[ny]?.[nx])) continue;
            seen.add(j);
            queue.push(j);
          }
        }
        for (const c of m.citiesB) {
          assert.ok(!seen.has(c.y * size + c.x), `${size} seed=${seed}：无渡口的图上居然能走过去`);
        }

        // 4) 但有地方能架桥
        assert.ok(hasBridgeableGap(m), `${size} seed=${seed}：没有能架桥的断面`);
      }
    }
  }
  assert.ok(found >= 8, `一百二十张河流图里只出现了 ${found} 张无渡口，概率太低`);
});

test('无渡口的局，开局战报会直接把这件事说出来', () => {
  // 找一个无渡口的种子
  let seed = 0;
  for (let i = 1; i <= 200; i++) {
    if (generateLayout(16, i, ['militia'], { style: 'river-h' }).fordless) {
      seed = i;
      break;
    }
  }
  assert.ok(seed > 0, '应该能找到无渡口的种子');
  const s = createMatch({ ...BASE, mapStyle: 'river-h' }, seed);
  const said = s.log.some((e) => e.text.includes('没有渡口'));
  assert.ok(said, `开局战报里应该提到无渡口：${s.log.map((e) => e.text).join(' / ')}`);
});

console.log('\n射程 / 溅射 / 多动');

test('远程单位的射程至少比移速多 1', () => {
  // 这一条是"能被追上"和"能先打一轮"的分界：
  // 射程 ≤ 移速时，任何近战都能一步贴上来，远程单位等于没有射程优势。
  for (const u of Object.values(UNIT_TYPES)) {
    if (u.category === 'building') continue;
    if (u.domain === 'water') continue; // 水军打不到它，不适用这条
    if (u.range < 2) continue;

    if (u.range === 2) {
      // 够得着一格的短兵器（戟兵）：它的价值是"站在一格之外打人、不挨反击"，
      // 不是风筝对手，所以不要求射程压过移速；但机动必须够，别贴都贴不上去。
      assert.ok(u.move >= 2, `${u.name}：射程 2 却没机动（move ${u.move}），够不到人`);
      continue;
    }

    if (u.move <= 2) {
      // 步兵类：射程必须比移速多一格，否则任何近战都能一步贴上来
      assert.ok(
        u.range >= u.move + 1,
        `${u.name}：射程 ${u.range} 没超过移速 ${u.move}，等于白给`,
      );
    } else {
      // 机械化部队（坦克、装甲车）：靠射程补机动，射程至少 3
      assert.ok(u.range >= 3, `${u.name}：车/舰的火炮射程不该只有 ${u.range}`);
    }
  }
});

test('溅射：主目标周围的人一起挨，自己人不吃', () => {
  const s = fresh();
  s.current = 'A';
  s.units = [];

  const mortar = place(s, 'A', 'mortar', 5, 5);
  const main = place(s, 'B', 'militia', 7, 5); // 距离 2，在射程 3 内
  const side = place(s, 'B', 'militia', 8, 5); // 紧贴主目标 → 被溅射
  const farAway = place(s, 'B', 'militia', 11, 5); // 离得太远
  const friend = place(s, 'A', 'militia', 7, 6); // 自己人贴着主目标

  const full = computeDamage(s, mortar, main);
  const splash = Math.floor(computeDamage(s, mortar, side) * CONFIG.splashRatio);
  assert.ok(splash > 0, '这个配置下溅射应该有伤害');

  const r = applyAction(s, { type: 'ATTACK', unitId: mortar.id, targetId: main.id });
  assert.ok(r.ok, r.ok ? '' : `开炮失败：${r.reason}`);
  if (!r.ok) return;

  const hp = (id: string) => r.state.units.find((u) => u.id === id)?.hp;
  assert.equal(hp(main.id), (UNIT_TYPES.militia?.maxHp ?? 0) - full, '主目标吃满伤害');
  assert.equal(hp(side.id), (UNIT_TYPES.militia?.maxHp ?? 0) - splash, '旁边的敌人吃打折伤害');
  assert.equal(hp(farAway.id), UNIT_TYPES.militia?.maxHp, '范围外不该受伤');
  assert.equal(hp(friend.id), UNIT_TYPES.militia?.maxHp, '自己人不该被炸');
  assert.ok(
    r.state.log.some((e) => e.text.includes('溅射')),
    `战报应该写明溅射：${r.state.log.slice(-2).map((e) => e.text).join(' / ')}`,
  );
});

test('溅射打死的人也走正常善后', () => {
  const s = fresh();
  s.current = 'A';
  s.units = [];

  const mortar = place(s, 'A', 'mortar', 5, 5);
  const main = place(s, 'B', 'militia', 7, 5);
  const weak = place(s, 'B', 'militia', 8, 5);
  weak.hp = 1; // 一炮就碎

  const r = applyAction(s, { type: 'ATTACK', unitId: mortar.id, targetId: main.id });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(!r.state.units.some((u) => u.id === weak.id), '残血单位应该被溅射击杀');
  assert.ok(
    r.state.log.some((e) => e.text.includes('被炮火波及消灭')),
    '战报应该记一笔',
  );
});

test('多动：burst 是一回合的攻击次数，每次独立结算', () => {
  // burst 的含义从"一次攻击打 N 段"改成了"一回合能攻击 N 次"：
  // 每次都是完整的一击（护甲照常各减一次），可以逐次换目标，
  // 次数没用完之前不算行动结束（acted 还是 false）。
  const burst = UNIT_TYPES.mg?.burst ?? 1;
  assert.ok(burst >= 2, '这条用例需要一个多动兵（mg）');

  const s = fresh();
  s.current = 'A';
  s.units = [];
  putTerrain(s, 5, 5, 'plain');
  putTerrain(s, 7, 5, 'plain');
  putTerrain(s, 5, 4, 'plain');
  const mg = place(s, 'A', 'mg', 5, 5);
  const tank = place(s, 'B', 'tank', 7, 5);
  tank.hp = 5000;
  const one = computeDamage(s, mg, tank);
  const mgHp0 = mg.hp;

  // 没开始打时"还剩几次"就是满的，而且和面板用的是同一个函数
  assert.equal(attacksPerTurn(s, mg), burst, '一回合的攻击次数应该等于兵种 burst');
  assert.equal(attacksLeftOf(s, mg), burst, '还没出手时剩余次数就是满的');

  // 第 1 发：打掉一整击的伤害，但不算行动结束
  let r = applyAction(s, { type: 'ATTACK', unitId: mg.id, targetId: tank.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  let me = r.state.units.find((u) => u.id === mg.id)!;
  assert.equal(me.acted, false, '还有攻击次数时不该算行动结束');
  assert.equal(me.attacksLeft, burst - 1, '剩几次攻击要记在单位身上');
  assert.equal(5000 - r.state.units.find((u) => u.id === tank.id)!.hp, one, '每次都是一整击');
  const mgHpAfterFirst = me.hp;
  assert.ok(mgHpAfterFirst < mgHp0, '第一发该吃到一次反击');

  // 打满次数
  let guard = 0;
  while (guard < 12) {
    guard += 1;
    const now = r.state.units.find((u) => u.id === mg.id)!;
    if (now.acted) break;
    r = applyAction(r.state, { type: 'ATTACK', unitId: mg.id, targetId: tank.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
  }
  me = r.state.units.find((u) => u.id === mg.id)!;
  assert.equal(me.acted, true, '次数用完才算行动结束');
  assert.equal(me.attacksLeft, 0);
  assert.equal(me.hp, mgHpAfterFirst, '坦克只有 1 次反击，后面几发不再还手');

  // 再来一发：没有剩余次数，直接拒
  const extra = applyAction(r.state, { type: 'ATTACK', unitId: mg.id, targetId: tank.id });
  assert.equal(extra.ok, false, '次数用完不能再打');
  // 两种拒法都算对：次数归零时 acted 已经置位，走的是"已经攻击过"那一条；
  // 单独一句"没有剩余攻击次数"是给"acted 被别的路径清掉、次数还没回满"兜底的。
  assert.ok(
    !extra.ok && /已经攻击过|没有剩余攻击次数/.test(extra.reason),
    extra.ok ? '' : `理由要说清是没次数了：${extra.reason}`,
  );

  // 换目标：多动的意义就在于"第二发可以打别人"
  const s2 = fresh();
  s2.current = 'A';
  s2.units = [];
  putTerrain(s2, 5, 5, 'plain');
  putTerrain(s2, 7, 5, 'plain');
  putTerrain(s2, 5, 4, 'plain');
  const mg2 = place(s2, 'A', 'mg', 5, 5);
  const t1 = place(s2, 'B', 'tank', 7, 5);
  t1.hp = 5000;
  const t2 = place(s2, 'B', 'militia', 5, 4);
  t2.hp = 5000;
  const h2a = applyAction(s2, { type: 'ATTACK', unitId: mg2.id, targetId: t1.id });
  assert.ok(h2a.ok, h2a.ok ? '' : h2a.reason);
  const h2b = applyAction(h2a.state, { type: 'ATTACK', unitId: mg2.id, targetId: t2.id });
  assert.ok(h2b.ok, `第二发应该能换目标：${h2b.ok ? '' : h2b.reason}`);
  assert.ok(
    (h2b.state.units.find((u) => u.id === t2.id)!.hp ?? 0) < 5000,
    '第二发的伤害要落在新目标身上',
  );
});

test('多动次数按兵种不同，不是固定三次', () => {
  const counts = [...new Set(Object.values(UNIT_TYPES).filter((u) => u.burst).map((u) => u.burst))];
  assert.ok(counts.length >= 3, `次数应该拉开档次，现在只有：${counts.join('、')}`);
  assert.ok((UNIT_TYPES.armoredcar?.burst ?? 0) >= 2);
  assert.ok((UNIT_TYPES.mg?.burst ?? 0) >= 3);
  assert.ok((UNIT_TYPES.hmg?.burst ?? 0) > (UNIT_TYPES.mg?.burst ?? 0), '重机枪的次数应该多于机枪队');

  // 次数是倍率，所以次数越多单发越弱：不然四动单位会直接把输出翻倍
  const mg = UNIT_TYPES.mg;
  const hmg = UNIT_TYPES.hmg;
  assert.ok(mg && hmg);
  assert.ok(hmg.atk < mg.atk, '四动的单发攻击力应该比三动低');
});

test('溅射半径按兵种不同：火炮能打到更远的一片', () => {
  // 火炮 splash 2：能波及离主目标 2 格的目标
  const s = fresh();
  s.current = 'A';
  s.units = [];
  const artillery = place(s, 'A', 'artillery', 4, 5);
  const main = place(s, 'B', 'militia', 7, 5); // 距离 3，在射程 4 内
  place(s, 'B', 'militia', 9, 5); // 离主目标 2 格
  const p = previewAttack(s, artillery, main);
  assert.ok(p.toSplash > 0, '火炮（2 格溅射）应该波及 2 格外的目标');

  // 臼炮 splash 1：同一个位置的目标够不着
  const s2 = fresh();
  s2.current = 'A';
  s2.units = [];
  const mortar = place(s2, 'A', 'mortar', 5, 5);
  const main2 = place(s2, 'B', 'militia', 7, 5); // 距离 2，在射程 3 内
  place(s2, 'B', 'militia', 9, 5); // 离主目标 2 格，超出 1 格溅射
  const p2 = previewAttack(s2, mortar, main2);
  assert.equal(p2.toSplash, 0, '臼炮只有 1 格溅射，够不着 2 格外的目标');
});

test('临水的城挨着好几片水时，水军可以自己选从哪片下水', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.current = 'A';
  s.players.A.gold = 900;

  const setT = (x: number, y: number, terrain: 'plain' | 'water') => {
    s.tiles[idx(s, x, y)] = { terrain, cityId: null };
  };
  // 先把城周围一圈抹平，免得地图自带的水混进"可下水点"
  for (let y = city!.y - 1; y <= city!.y + city!.size; y++) {
    for (let x = city!.x - 1; x <= city!.x + city!.size; x++) {
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      if (s.tiles[idx(s, x, y)]?.cityId) continue;
      setT(x, y, 'plain');
    }
  }

  // 城左右各一片水，互不相连
  const left = { x: city!.x - 1, y: city!.y };
  const right = { x: city!.x + city!.size, y: city!.y };
  assert.ok(left.x >= 0 && right.x < s.w, '地图两侧得放得下这两片水');
  setT(left.x, left.y, 'water');
  setT(right.x, right.y, 'water');

  const cells = recruitSpawnCells(s, city!.id, undefined, 'boat');
  assert.equal(cells.length, 2, `两片水面都该算可选，实际 ${cells.length}`);
  const pick = cells.find((c) => c.x === right.x);
  assert.ok(pick, '右侧那片水应该在候选里');

  // 1) 指定位置：船就从那儿下水
  const r = applyAction(s, {
    type: 'RECRUIT',
    cityId: city!.id,
    unitType: 'boat',
    x: pick!.x,
    y: pick!.y,
  });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const born = r.state.units.find((u) => u.type === 'boat');
  assert.ok(born);
  assert.equal(born!.x, pick!.x, '船要出现在玩家点的那片水上');
  assert.equal(born!.y, pick!.y);

  // 2) 不指定位置时还是老规矩：第一格（老行为不变）
  const dflt = applyAction(s, { type: 'RECRUIT', cityId: city!.id, unitType: 'boat' });
  assert.ok(dflt.ok, dflt.ok ? '' : dflt.reason);
  const auto = dflt.state.units.find((u) => u.type === 'boat');
  assert.ok(auto);
  assert.equal(auto!.x, cells[0]!.x, '不指定就落在第一格');
  assert.equal(auto!.y, cells[0]!.y);

  // 3) 指一格不是水的地方：拒绝，并且要说清原因
  const bad = applyAction(s, {
    type: 'RECRUIT',
    cityId: city!.id,
    unitType: 'boat',
    x: city!.x,
    y: city!.y,
  });
  assert.equal(bad.ok, false, '城墙里下不了水');
  assert.ok(bad.ok === false && bad.reason.includes('水面'), '理由要提到水面');
});

console.log('\n渡船');

/** 在 (x,y) 挖一条竖河，两侧留河岸 */
test('渡船能把陆军运过水面', () => {
  const s = fresh();
  digRiver(s, 8, 3, 12);
  s.current = 'A';
  s.players.A.gold = 900;

  const ferry = place(s, 'A', 'ferry', 8, 5);
  const crew = place(s, 'A', 'militia', 7, 5);

  const load = applyAction(s, { type: 'LOAD', unitId: ferry.id, cargoId: crew.id });
  assert.ok(load.ok, load.ok ? '' : `上船失败：${load.reason}`);
  if (!load.ok) return;
  const loaded = load.state.units.find((u) => u.id === ferry.id);
  assert.ok(loaded);
  assert.equal(loaded.cargo?.length, 1, '货舱里应该有一个单位');
  assert.ok(
    !loaded.cargo?.some((u) => u.x === 7 && u.y === 5),
    '上船之后不该还站在岸上',
  );
  assert.ok(!unitsOf(load.state, 'A').some((u) => u.id === crew.id), '上船的人不该留在棋盘上');

  // 开船过河（LOAD 只占 acted，不占 moved，所以装完还能开）
  const sail = applyAction(load.state, { type: 'MOVE', unitId: ferry.id, x: 8, y: 8 });
  assert.ok(sail.ok, sail.ok ? '' : `航行失败：${sail.reason}`);
  if (!sail.ok) return;

  // 下一回合靠岸下人
  const turn = applyAction(sail.state, { type: 'END_TURN' });
  assert.ok(turn.ok);
  if (!turn.ok) return;
  const back = applyAction(turn.state, { type: 'END_TURN' });
  assert.ok(back.ok);
  if (!back.ok) return;
  const ferry2 = back.state.units.find((u) => u.id === ferry.id);
  assert.ok(ferry2);
  assert.equal(ferry2.acted, false, '新回合船应该能再装卸');

  const unload = applyAction(back.state, {
    type: 'UNLOAD',
    unitId: ferry2.id,
    cargoId: crew.id,
    x: 9,
    y: 8,
  });
  assert.ok(unload.ok, unload.ok ? '' : `下船失败：${unload.reason}`);
  const landed = unload.state.units.find((u) => u.id === crew.id);
  assert.ok(landed, '人应该回到棋盘上');
  assert.equal(landed.x, 9);
  assert.equal(landed.y, 8);
  assert.ok(landed.moved && landed.acted, '刚下船不能立刻行动');
});

test('渡船有载员上限，而且只装陆军', () => {
  const s = fresh();
  // 挖一小片水塘，让船两侧都有岸（一格宽的河道只够站一个人，测不了容量）
  for (const [x, y] of [
    [7, 6],
    [8, 6],
    [9, 6],
    [7, 7],
    [8, 7],
    [9, 7],
  ] as const) {
    s.tiles[idx(s, x, y)] = { terrain: 'water', cityId: null };
  }
  s.units = s.units.filter((u) => u.y < 5 || u.y > 8);
  s.current = 'A';

  /** 走完一轮 A→B→A，让船重置 */
  const nextTurn = (from: GameState): GameState => {
    const a = applyAction(from, { type: 'END_TURN' });
    assert.ok(a.ok);
    if (!a.ok) throw new Error('unreachable');
    const b = applyAction(a.state, { type: 'END_TURN' });
    assert.ok(b.ok);
    if (!b.ok) throw new Error('unreachable');
    return b.state;
  };

  const ferry = place(s, 'A', 'ferry', 8, 6);
  const cap = UNIT_TYPES.ferry?.capacity ?? 0;
  assert.ok(cap >= 1);

  // 两个相邻的岸格：(7,6) 和 (9,6)
  const a1 = place(s, 'A', 'militia', 7, 6);
  const a2 = place(s, 'A', 'militia', 9, 6);

  const loadOne = (u: Unit, from: GameState): GameState => {
    const r = applyAction(from, { type: 'LOAD', unitId: ferry.id, cargoId: u.id });
    assert.ok(r.ok, r.ok ? '' : `上船失败：${r.reason}`);
    if (!r.ok) throw new Error('unreachable');
    return r.state;
  };

  let cur = loadOne(a1, s);
  // 一次装卸占掉船的 acted：第二个人得等下一个自己回合
  cur = loadOne(a2, nextTurn(cur));

  const full = cur.units.find((u) => u.id === ferry.id);
  assert.equal(full?.cargo?.length, cap, `货舱应该装满 ${cap}`);

  // 满了之后拒绝：把第三个人放到刚空出来的岸格
  const a3 = place(cur, 'A', 'militia', 7, 6);
  const ready = nextTurn(cur);
  const over = applyAction(ready, { type: 'LOAD', unitId: ferry.id, cargoId: a3.id });
  assert.equal(over.ok, false, '装满了就该拒绝');

  // 水军上不了船
  const boat = place(ready, 'A', 'boat', 8, 7);
  const wrong = applyAction(ready, { type: 'LOAD', unitId: ferry.id, cargoId: boat.id });
  assert.equal(wrong.ok, false, '船上装不了船');

  // 敌人也上不了你的船
  const foe = place(ready, 'B', 'militia', 9, 7);
  const enemy = applyAction(ready, { type: 'LOAD', unitId: ferry.id, cargoId: foe.id });
  assert.equal(enemy.ok, false, '不能载别人的部队');
});

test('船被打沉，舱里的人一起没', () => {
  const s = fresh();
  digRiver(s, 8, 3, 12);
  s.current = 'A';
  const ferry = place(s, 'A', 'ferry', 8, 6);
  const crew = place(s, 'A', 'militia', 7, 6);

  const load = applyAction(s, { type: 'LOAD', unitId: ferry.id, cargoId: crew.id });
  assert.ok(load.ok, load.ok ? '' : `上船失败：${load.reason}`);
  if (!load.ok) return;
  let cur: GameState = load.state;
  assert.equal(cur.units.find((u) => u.id === ferry.id)?.cargo?.length, 1);

  // 打手要从岸上打：放在东岸（9,6），贴着船
  const raider = place(cur, 'B', 'militia', 9, 6);
  raider.id = 'raider-1';
  let guard = 0;
  while (cur.units.some((u) => u.id === ferry.id) && guard < 8) {
    guard += 1;
    cur.current = 'B';
    const atk = cur.units.find((u) => u.id === 'raider-1');
    if (!atk) break;
    readyAgain(atk);
    const hit = applyAction(cur, { type: 'ATTACK', unitId: atk.id, targetId: ferry.id });
    if (!hit.ok) {
      assert.fail(`打不到船：${hit.reason}`);
    }
    cur = hit.state;
  }

  assert.ok(!cur.units.some((u) => u.id === ferry.id), '船应该被打沉了');
  assert.ok(!cur.units.some((u) => u.id === crew.id), '船上的人应该跟着没了');
  assert.ok(
    cur.log.some((e) => e.text.includes('随船沉没')),
    `战报里应该写清楚：${cur.log.slice(-3).map((e) => e.text).join(' / ')}`,
  );
});

console.log('\n军营档次');

test('高级军营按时代解锁，属性逐级变强', () => {
  const tiers = ['camp', 'camp2', 'camp3', 'camp4', 'camp5'];
  let prevHp = 0;
  let prevCost = 0;
  for (const id of tiers) {
    const def = UNIT_TYPES[id];
    assert.ok(def, `缺少 ${id}`);
    assert.equal(def.category, 'building');
    assert.equal(def.barracks, true, `${id} 应该是军营`);
    assert.equal(def.requiresWater, true, `${id} 应该要临水`);
    assert.ok(def.maxHp > prevHp, `${id} 的耐久应该比上一档高`);
    assert.ok(def.cost > prevCost, `${id} 的造价应该比上一档高`);
    prevHp = def.maxHp;
    prevCost = def.cost;
  }

  // 建造单位只能盖到自己这一代：一级工程队盖不了二级营
  assert.ok(UNIT_TYPES.laborer?.builds?.includes('camp'));
  assert.ok(!UNIT_TYPES.laborer?.builds?.includes('camp2'), '一级工程队不该会盖二级营');
  assert.ok(UNIT_TYPES.engineer?.builds?.includes('camp3'));
  assert.ok(!UNIT_TYPES.engineer?.builds?.includes('camp4'), '三级工程队不该会盖四级营');
  assert.ok(UNIT_TYPES.crew?.builds?.includes('camp5'));
});

test('高级军营也是产兵点', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.current = 'A';
  s.players.A.gold = 900;

  const camp = place(s, 'A', 'camp3', 5, 5);
  const before = unitsOf(s, 'A').length;
  const r = applyAction(s, { type: 'RECRUIT', unitId: camp.id, unitType: 'militia' });
  assert.ok(r.ok, r.ok ? '' : `高级营出兵失败：${r.reason}`);
  assert.equal(unitsOf(r.state, 'A').length, before + 1);
});

console.log('\nAI 寻路：绕开走不通的地形');

test('寻路图把山和水当墙，绕行距离真的变长', () => {
  const s = fresh();
  const city = citiesOf(s, 'B')[0];
  assert.ok(city);

  // 城右边两列外立一道山墙，只在最下面留一个缺口
  const wall = city.x + city.size + 1;
  assert.ok(wall < s.w - 2, '地图太小，这道墙摆不下');
  const top = Math.max(0, city.y - 3);
  const gap = Math.min(s.h - 1, city.y + 4);
  for (let y = top; y < gap; y++) s.tiles[idx(s, wall, y)] = { terrain: 'mountain', cityId: null };
  s.tiles[idx(s, wall, gap)] = { terrain: 'plain', cityId: null };

  const land = cityDistanceField(s, city, 'land');
  const adv = cityDistanceField(s, city, 'advance');

  // 1) 山是真墙：旱路和涉水图都不许穿过去
  assert.equal(land[idx(s, wall, top)], Infinity, '山墙在旱路图上应该是不可达');
  assert.equal(adv[idx(s, wall, top)], Infinity, '山在涉水图上也是墙');

  // 2) 墙外那一格只能从下面的缺口绕过去，所以代价必须明显大于直线距离
  const detour = land[idx(s, wall + 1, city.y)];
  assert.ok(Number.isFinite(detour), '绕过去的旱路必须存在');
  assert.ok(detour >= 8, `绕行距离该明显变长，现在只算到 ${detour}`);

  // 3) 水面在旱路图上是墙，在涉水图上只是"很贵"
  const pond = { x: city.x, y: city.y + city.size + 1 };
  assert.ok(pond.x < s.w - 1, '地图太窄，放不下这格水');
  s.tiles[idx(s, pond.x, pond.y)] = { terrain: 'water', cityId: null };
  const land2 = cityDistanceField(s, city, 'land');
  const adv2 = cityDistanceField(s, city, 'advance');
  assert.equal(land2[idx(s, pond.x, pond.y)], Infinity, '水面不是旱路');
  assert.ok(Number.isFinite(adv2[idx(s, pond.x, pond.y)]), '涉水图得给水面留一个"很贵"的价');
});

test('涉水兜底必须比任何旱路都贵，否则 AI 宁可站到河边也不绕路', () => {
  const s = fresh();
  const city = citiesOf(s, 'B')[0];
  assert.ok(city);

  // 造一格"只能涉水到达"的水面：四周全是水/山围起来，再由它连出去
  const pond = { x: Math.min(city.x + city.size + 1, s.w - 2), y: city.y };
  s.tiles[idx(s, pond.x, pond.y)] = { terrain: 'water', cityId: null };

  const land = cityDistanceField(s, city, 'land');
  const adv = cityDistanceField(s, city, 'advance');
  const merged = mergeAdvanceField(land, adv);

  let maxLand = 0;
  for (const v of land) if (Number.isFinite(v) && v > maxLand) maxLand = v;

  const at = merged[idx(s, pond.x, pond.y)];
  assert.ok(Number.isFinite(at), '涉水兜底要给出一个有限值，AI 才不至于彻底失去方向');
  assert.ok(at > maxLand, `兜底值 ${at} 必须大于旱路最远值 ${maxLand}`);

  // 能走旱路的地方，推进图必须原封不动地等于旱路距离
  for (let i = 0; i < land.length; i++) {
    const l = land[i] ?? Infinity;
    if (Number.isFinite(l)) assert.equal(merged[i], l, '旱路能到的地方不该被涉水值污染');
  }
});

console.log('\nAI');


const NO_RECRUIT = { maxRecruit: 0, maxUpgrade: 0, recruited: 0, upgraded: 0 };

/** 连续走若干步，收集 AI 的行动 */
function runAiSteps(s: GameState, limit = 8): Action[] {
  let cur = s;
  const acts: Action[] = [];
  for (let i = 0; i < limit; i++) {
    const a = aiNextAction(cur, NO_RECRUIT);
    if (!a) break;
    acts.push(a);
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
  return acts;
}

test('AI 会走进去接管废墟（并且有钱的时候才走）', () => {
  // 这条补的是新规则：城打空之后不再易主，只是变成废墟，
  // 必须派兵走进去、付重建费才算拿下。AI 以前完全不知道这回事——
  // 它把城砸成废墟之后就在城墙外面转，谁也不去收，
  // 一局打完两边都"攻不下城"（实测双 AI 40 回合 0 易主）。
  const s = fresh({ size: 16 }, 8899);
  const city = citiesOf(s, 'B')[0]!;
  city.ruined = true;
  city.hp = 0;

  // 清场，只留一个 A 民兵贴着这座城
  const m = findUnit(s, 'A', 'militia');
  s.units = [m];
  m.x = city.x - 1;
  m.y = city.y;
  m.moved = false;
  m.acted = false;
  if (s.tiles[idx(s, m.x, m.y)]) s.tiles[idx(s, m.x, m.y)].terrain = 'plain';
  s.current = 'A';
  s.players.A.gold = 5000;
  refreshMemory(s);

  const price = rebuildCost(city);
  assert.ok(price > 0, '重建费应该大于 0');

  const a = aiNextAction(s, NO_RECRUIT);
  assert.ok(a && a.type === 'MOVE', `应该选择走进去，实际 ${a?.type ?? '什么都不做'}`);
  const mv = a as Extract<Action, { type: 'MOVE' }>;
  assert.ok(
    cityTiles(city).some((t) => t.x === mv.x && t.y === mv.y),
    `应该走进城格，实际走到 (${mv.x},${mv.y})`,
  );

  const r = applyAction(s, a!);
  assert.ok(r.ok, r.ok ? '' : `这一步不合法：${r.reason}`);
  const taken = r.state.cities.find((c) => c.id === city.id)!;
  assert.equal(taken.owner, 'A', '废墟应该归 A 了');
  assert.ok(!taken.ruined, '接管之后不该还是废墟');
  assert.equal(r.state.players.A.gold, 5000 - price, '要付重建费');

  // 钱不够的时候不能选这个动作：doMove 会拒绝，AI 这一回合会卡死在这一步
  const poor = fresh({ size: 16 }, 8899);
  const c2 = citiesOf(poor, 'B')[0]!;
  c2.ruined = true;
  c2.hp = 0;
  const m2 = findUnit(poor, 'A', 'militia');
  poor.units = [m2];
  m2.x = c2.x - 1;
  m2.y = c2.y;
  m2.moved = false;
  m2.acted = false;
  if (poor.tiles[idx(poor, m2.x, m2.y)]) poor.tiles[idx(poor, m2.x, m2.y)].terrain = 'plain';
  poor.current = 'A';
  poor.players.A.gold = 0;
  refreshMemory(poor);
  const b = aiNextAction(poor, NO_RECRUIT);
  const intoCity =
    b?.type === 'MOVE' && cityTiles(c2).some((t) => t.x === b.x && t.y === b.y);
  assert.ok(!intoCity, `没钱就不该往废墟里走，实际 ${JSON.stringify(b)}`);
});

test('大地图上孤零零一支部队也会朝敌城推进', () => {
  // 大地图"AI 迷路"的最朴素形态：视野里一个敌人都没有的时候，
  // 它到底知不知道城在哪。以前的目标函数里敌军和敌城取 min，
  // 只要视野里有个兵，城市就被挤到第二位——32×32 上整局不打城就是这么来的。
  const s = fresh({ size: 32 }, 2468);
  for (const t of s.tiles) if (t.terrain !== 'city') t.terrain = 'plain';
  const m = findUnit(s, 'A', 'militia');
  s.units = [m];
  m.x = 16;
  m.y = 16;
  m.moved = false;
  m.acted = false;
  s.current = 'A';
  refreshMemory(s);

  // 只留一座敌城。两座城分处两角时，"往哪边走算前进"取决于看哪座城：
  // 往左走对左城是近、对右城是远，取 min 会漏，取和会互相抵消
  // （第一版两种指标都误报过）。留一座，指标才单调。
  const foes = citiesOf(s, 'B');
  assert.ok(foes.length > 1, '样本需要两座敌城');
  const keep = foes[0]!;
  for (const c of foes) {
    if (c.id === keep.id) continue;
    for (const t of cityTiles(c)) {
      const tile = s.tiles[idx(s, t.x, t.y)];
      if (tile) {
        tile.cityId = null;
        tile.terrain = 'plain';
      }
    }
    s.cities = s.cities.filter((x) => x.id !== c.id);
  }

  const before = distToCity({ x: m.x, y: m.y }, keep);
  assert.ok(before > 12, `样本要离城够远才有意义，实际 ${before}`);

  const a = aiNextAction(s, NO_RECRUIT);
  assert.ok(a && a.type === 'MOVE', `应该选择移动，实际选了 ${a?.type ?? '什么都不做'}`);
  const r = applyAction(s, a!);
  assert.ok(r.ok, r.ok ? '' : `这一步不合法：${r.reason}`);
  // 注意从 r.state 里读新位置：applyAction 是深拷贝，手里这个 m 不会动。
  // 第一版就是拿着旧对象量的距离，于是"走了两步"看起来完全没变化。
  const moved = r.state.units.find((u) => u.id === m.id);
  assert.ok(moved, '兵还在');
  const after = distToCity(moved!, keep);
  assert.ok(after < before, `应该更靠近敌城，实际 ${before} → ${after}`);
});

test('AI 不会在丘陵/森林围死的城里造走不动的兵（两档都测）', () => {
  // 重机枪组 move 1，而丘陵和森林进门要 2 点：城门四邻全是这种地形的话，
  // 造出来就永远出不了城，还占着产兵格 —— 城从此再也造不出兵。
  // 高时代最容易踩这个坑，所以这条用高时代开局来测。
  //
  // 两档都要跑：这是缺陷修复，不是难度。初级 AI 也不该把自己憋死。
  for (const level of ['basic', 'advanced'] as const) {
  const s = fresh({ startEra: 4, size: 16, aiLevel: level }, 4242);
  s.current = 'A';
  s.players.A.gold = 5000;
  s.units = s.units.filter((u) => u.owner !== 'A');

  // 把 A 两座城的外圈全换成丘陵（城内的格子不动）
  for (const city of citiesOf(s, 'A')) {
    for (const t of cityTiles(city)) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const x = t.x + dx;
        const y = t.y + dy;
        const tile = s.tiles[idx(s, x, y)];
        if (!tile || tile.cityId) continue;
        tile.terrain = 'hill';
      }
    }
  }
  refreshMemory(s);

  const picks: string[] = [];
  for (let i = 0; i < 4; i++) {
    const a = aiNextAction(s, { maxRecruit: 1, maxUpgrade: 0, recruited: 0, upgraded: 0 });
    if (!a) break;
    if (a.type !== 'RECRUIT') break;
    picks.push(a.unitType);
    const r = applyAction(s, a);
    if (!r.ok) break;
    s.units = r.state.units;
    s.players = r.state.players;
  }

  assert.ok(picks.length > 0, `${level} 档 AI 应该造了点什么`);
  for (const id of picks) {
    const def = UNIT_TYPES[id as keyof typeof UNIT_TYPES];
    assert.ok(
      def.move >= 2,
      `${level} 档 AI 造了 ${def.name}（move ${def.move}），它在丘陵里出不了城`,
    );
  }
  }
});

test('水域太少的地图，AI 不再造水军', () => {
  // 实测：开阔图水域只有 2%，双河图 25%。以前 AI 只要城边有一格水就会造船，
  // 造出来的船在一个池塘里转圈，等于白烧 45 金。
  const s = fresh({ mapStyle: 'open', size: 16 }, 3131);
  for (const t of s.tiles) if (t.terrain === 'water') t.terrain = 'plain';

  // 留一个小池塘（2 格 = 0.8% 水域），并且就挖在城边——这样产兵点是"能"造水军的，
  // 唯一拦住它的就是那条水域占比的闸。
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  let dug = 0;
  for (const t of cityTiles(city)) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (dug >= 2) break;
      const tile = s.tiles[idx(s, t.x + dx, t.y + dy)];
      if (!tile || tile.cityId) continue;
      tile.terrain = 'water';
      dug += 1;
    }
  }
  assert.equal(dug, 2, '应该挖出两格水');
  s.units = s.units.filter((u) => u.owner !== 'A');
  s.players.A.gold = 800;
  s.current = 'A';
  refreshMemory(s);

  const picks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = aiNextAction(s, { maxRecruit: 1, maxUpgrade: 0, recruited: 0, upgraded: 0 });
    if (!a || a.type !== 'RECRUIT') break;
    picks.push(a.unitType);
    const r = applyAction(s, a);
    if (!r.ok) break;
    s.units = r.state.units;
    s.players = r.state.players;
  }
  assert.ok(picks.length > 0, 'AI 应该造了点什么');
  for (const id of picks) {
    const def = s.unitTypes[id];
    assert.ok(def?.domain !== 'water', `干地上造了 ${def?.name}，它在池塘里开不出去`);
  }
});

test('高时代 AI 会把高时代兵用起来，不是一辈子造火枪兵', () => {
  // 改之前：60 局只造出 1 辆坦克、10 门火炮，中世以后清一色火枪兵。
  // 根因不是它们弱（交换比 3+），是"贵"在打分里被折了两次。
  for (const level of ['basic', 'advanced'] as const) {
    const s = fresh({ startEra: 4, size: 20, aiLevel: level }, 4242);
    s.units = s.units.filter((u) => u.owner !== 'A');
    s.players.A.gold = 2000;
    s.current = 'A';
    refreshMemory(s);

    const picks: string[] = [];
    for (let i = 0; i < 8; i++) {
      const a = aiNextAction(s, { maxRecruit: 1, maxUpgrade: 0, recruited: 0, upgraded: 0 });
      if (!a || a.type !== 'RECRUIT') break;
      picks.push(a.unitType);
      const r = applyAction(s, a);
      if (!r.ok) break;
      s.units = r.state.units;
      s.players = r.state.players;
    }
    const high = picks.filter((id) => (s.unitTypes[id]?.era ?? 0) >= 4);
    assert.ok(
      high.length * 2 >= picks.length,
      `${level} 档在高时代还是只造旧兵：${picks.map((id) => s.unitTypes[id]?.name).join(' ')}`,
    );
  }
});

test('AI 会攻击贴到脸上的敌人', () => {
  const s = fresh();
  s.current = 'B';
  const mine = findUnit(s, 'B', 'militia');
  const enemy = findUnit(s, 'A', 'militia');
  mine.x = 5;
  mine.y = 5;
  mine.moved = false;
  mine.acted = false;
  enemy.x = 5;
  enemy.y = 4;
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';

  const acts = runAiSteps(s);
  assert.ok(
    acts.some((a) => a.type === 'ATTACK' || a.type === 'SIEGE'),
    `AI 没动手：${JSON.stringify(acts)}`,
  );
});

test('看不见敌人时 AI 朝敌方城市推进，而不是原地发呆', () => {
  const s = fresh();
  // 抹平地形：地图上现在有湖和支流，"曼哈顿距离有没有变小"不再是可靠判据
  // ——绕湖走一步可能反而远了。这条测的是 AI 的意图，不是地图运气。
  for (const t of s.tiles) if (t.terrain !== 'city') t.terrain = 'plain';
  s.current = 'B';
  const first = aiNextAction(s, NO_RECRUIT);
  assert.ok(first, 'AI 应该有事可做');
  assert.equal(first.type, 'MOVE', `第一步是 ${first.type}`);
  if (first.type === 'MOVE') {
    // 认准"实际出动的那一个"：AI 现在会挑血最少的那座敌方城市作为主攻方向，
    // 所以判据也要跟着主攻方向走，不能写死第一座城。
    const mover = s.units.find((u) => u.id === first.unitId);
    assert.ok(mover, '应该能找到出动的单位');
    const enemyCities = citiesOf(s, 'A');
    const focus = enemyCities.reduce((a, b) => (a.hp <= b.hp ? a : b));
    const before = distToCity(mover, focus);
    const after = distToCity({ x: first.x, y: first.y }, focus);
    assert.ok(after <= before, '应该朝主攻方向靠近');
  }
});

test('远程单位射程里已经有人时，不再往前挪', () => {
  // 需求：手长单位在攻击范围内看到敌人，可以选择站定输出。
  // 以前"推进"的评分对远近一视同仁，弓手会先往前走一格再射，
  // 白白走进对方近战的怀里、还丢掉脚下的地形。
  const s = fresh({ mapStyle: 'open' });
  s.current = 'A';
  // 场上只留一个 A 方弓手和一个贴到射程内的敌人
  s.units = s.units.filter((u) => u.owner === 'B');
  for (const u of s.units) {
    u.x = 12;
    u.y = 12;
  }
  // 放在地图正中：靠近城市的话，"挪一步就能炮轰城池"是合理行为，
  // 会把这条断言搅成另一个问题
  const archer = place(s, 'A', 'archer', 8, 8);
  place(s, 'B', 'militia', 8, 6); // 距离 2 = 弓手的射程

  let cur: GameState = s;
  let attacked = 0;
  for (let i = 0; i < 8; i++) {
    const a = aiNextAction(cur, NO_RECRUIT);
    if (!a) break;
    if (a.type === 'MOVE' && a.unitId === archer.id) {
      assert.fail(`弓手射程里已经有人，不该再移动（走到了 ${a.x},${a.y}）`);
    }
    if (a.type === 'ATTACK' && a.unitId === archer.id) attacked += 1;
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }

  const after = cur.units.find((u) => u.id === archer.id);
  assert.ok(after, '弓手应该还活着');
  assert.equal(after.x, 8, '弓手应该留在原地');
  assert.equal(after.y, 8);
  assert.ok(attacked >= 1, '应该开过火');
});

test('AI 会攻城', () => {
  const s = fresh();
  s.current = 'B';
  // 清掉守军，让 AI 只能面对城墙
  s.units = s.units.filter((u) => u.owner !== 'A');
  const mine = findUnit(s, 'B', 'militia');
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  mine.x = city.x;
  mine.y = city.y + city.size;
  s.tiles[idx(s, mine.x, mine.y)].terrain = 'plain';
  mine.moved = false;
  mine.acted = false;

  const acts = runAiSteps(s);
  assert.ok(acts.some((a) => a.type === 'SIEGE'), `AI 没攻城：${JSON.stringify(acts)}`);
});

test('AI 决策是确定性的', () => {
  const s = fresh();
  const a1 = aiNextAction(s);
  const a2 = aiNextAction(s);
  assert.deepEqual(a1, a2, '同一局面应该给出同一个决策');
});

test('指挥官模式：排在队首的「空过」不会被 AI 当成"没计划"而自作主张造兵', () => {
  const s = fresh({ commanderMode: true });
  s.current = 'B';
  s.players.B.gold = 900;
  s.orders = { ...(s.orders ?? {}), B: [ORDER_IDLE] };
  s.orderSites = { ...(s.orderSites ?? {}), B: [''] };

  // 这一回合 AI 可以走位、可以升级兵营，但绝不能再掏钱造兵
  const acts: Action[] = [];
  let cur = s;
  for (let i = 0; i < 10; i++) {
    const a = aiNextAction(cur);
    if (!a) break;
    acts.push(a);
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
  assert.equal(
    acts.filter((a) => a.type === 'RECRUIT').length,
    0,
    `队首是@idle 时不该造兵，实际：${acts.map((a) => a.type).join(',')}`,
  );
  // 队列不能被"代排"覆盖掉：空过的意思就是这一格不花钱
  assert.deepEqual(cur.orders?.B, [ORDER_IDLE], '序列要原样留着，等这一回合过去');
  assert.equal(
    acts.filter((a) => a.type === 'SET_ORDERS').length,
    0,
    '不该把玩家排的序列换成 AI 自己那套',
  );

  // 反证：同一个局面里，队首点的是一个**真兵种**时 AI 会把它造出来。
  // 这一条必须留着——否则上面"一个兵都没造"也可能只是因为它这回合压根没得造。
  const real = fresh({ commanderMode: true });
  real.current = 'B';
  real.players.B.gold = 900;
  real.orders = { ...(real.orders ?? {}), B: ['militia'] };
  real.orderSites = { ...(real.orderSites ?? {}), B: [''] };
  let c2 = real;
  const acts2: Action[] = [];
  for (let i = 0; i < 12; i++) {
    const a = aiNextAction(c2);
    if (!a) break;
    acts2.push(a);
    const r = applyAction(c2, a);
    if (!r.ok) break;
    c2 = r.state;
  }
  assert.ok(
    acts2.some((a) => a.type === 'RECRUIT'),
    `队首点了民兵就该造民兵（实际：${acts2.map((a) => a.type).join(',')}）`,
  );
});

test('AI 会招募和升级', () => {
  const s = fresh();
  s.current = 'B';
  s.players.B.gold = 900;
  const acts: Action[] = [];
  let cur = s;
  const budget = { maxRecruit: 3, maxUpgrade: 2, recruited: 0, upgraded: 0 };
  for (let i = 0; i < 12; i++) {
    const a = aiNextAction(cur, budget);
    if (!a) break;
    acts.push(a);
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
  assert.ok(acts.some((a) => a.type === 'RECRUIT'), '有钱应该招兵');
  assert.ok(acts.some((a) => a.type === 'UPGRADE'), '有余钱应该升级城市');
});

test('AI 会主动离开基地推进战线（而不是龟缩）', () => {
  // 回归测试：以前的移动分数是"离敌人越远分越低"的绝对值，
  // 而候选动作要求分数 > 0，于是所有移动都被丢掉，AI 招完兵就站着不动——
  // 模拟一百个回合打不了一次。这里跑十个回合，看战线有没有真的往前挪。
  // 用开阔图测"敢不敢往前压"：河和山是地形问题，不该混进这条断言里
  let cur = fresh({ aiOpponent: true, aiAlly: true, mapStyle: 'open' });
  // 同样抹平地形：大地图加了湖、支流、短山脊之后，开阔图上也可能横着一片水，
  // 十个回合里"先头部队有没有更靠近"就不再只反映"敢不敢压"。
  for (const t of cur.tiles) if (t.terrain !== 'city') t.terrain = 'plain';
  const enemyCity = citiesOf(cur, 'A')[0];
  assert.ok(enemyCity, '应该有敌方城市');
  // 战线 = "B 的战斗单位离**最近那座**敌城还有多远"。
  //
  // 这里不能只看 citiesOf('A')[0]：AI 自己会挑目标，两个回合它可能先去啃左边那座、
  // 也可能先去啃右边那座。钉一座城当尺子的话，"AI 集中兵力打另一座城"会被读成
  // "十回合原地不动"——那是尺子错了，不是 AI 缩了。
  // 城位仍是随机的（planCities），所以取最近的一座才是不依赖这一次抽签的度量。
  const enemyCities = citiesOf(cur, 'A');
  const combatOf = (s: GameState, p: 'A' | 'B') =>
    unitsOf(s, p).filter((u) => utype(s, u.type).category === 'combat');
  const front = (s: GameState) =>
    Math.min(
      ...combatOf(s, 'B').flatMap((u) => enemyCities.map((c) => distToCity(u, c))),
    );
  const start = front(cur);
  // 注意：front 取的是"最靠前那个还活着的战斗单位"。
  // 先头部队阵亡会让这个数字变差——那是打输了，不是缩回去了。
  // 所以判据用"这十回合里曾经推进到多远"，而不是最后那一刻的位置。
  let deepest = start;

  const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  let attacks = 0;

  for (let turn = 0; turn < 10; turn++) {
    budget.recruited = 0;
    budget.upgraded = 0;
    for (let step = 0; step < 60; step++) {
      const a = aiNextAction(cur, budget);
      if (!a) break;
      if (a.type === 'ATTACK' || a.type === 'SIEGE') attacks += 1;
      const r = applyAction(cur, a);
      if (!r.ok) break;
      cur = r.state;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
    }
    if (cur.winner) break;
    deepest = Math.min(deepest, front(cur));
    const end = applyAction(cur, { type: 'END_TURN' });
    if (!end.ok) break;
    cur = end.state;
  }

  assert.ok(
    deepest <= start - 3,
    `战线应该往前推：开局 ${start} → 最深处 ${deepest}`,
  );
  assert.ok(attacks > 10, `十回合里应该有交火，实际 ${attacks} 次`);
});

test('AI 每一步都是合法行动', () => {
  const s = fresh();
  s.current = 'B';
  let cur = s;
  for (let i = 0; i < 10; i++) {
    const a = aiNextAction(cur, NO_RECRUIT);
    if (!a) break;
    const r = applyAction(cur, a);
    assert.ok(r.ok, `第 ${i} 步非法：${JSON.stringify(a)} → ${r.ok ? '' : r.reason}`);
    cur = r.state;
  }
});

test('AI 的随机值仍然可复现', () => {
  // 有随机性 ≠ 不可复现：值由 (种子, 回合, 已走步数) 派生，
  // 同一局面永远同一个决策，存档、回放、双 AI 观战才对得上。
  const s = fresh();
  assert.equal(aiNoise(s), aiNoise(s), '同一局面两次必须一样');
  const next = { ...s, turn: s.turn + 1 };
  assert.notEqual(aiNoise(s), aiNoise(next), '换一个回合应该换一个值');
});

test('AI 随真实局面变化使用多种行动，而不是靠回合号乱换选择', () => {
  const picks = new Set<string>();
  let s = fresh();
  s.current = 'A';
  s.players.A.gold = 900;
  s.fog = false;
  const budget = { ...DEFAULT_BUDGET };
  for (let step = 0; step < AI_MAX_STEPS && !s.winner; step++) {
    const action = aiNextAction(s, budget);
    if (!action) break;
    const result = applyAction(s, action);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    picks.add(action.type);
    if (action.type === 'RECRUIT') budget.recruited++;
    if (action.type === 'UPGRADE') budget.upgraded++;
    s = result.state;
  }
  assert.ok(picks.size >= 3, `实际行动只出现 ${[...picks].join('/')}`);
});

test('不同种子的 AI 性格不同', () => {
  const a = aiTraits(fresh(undefined, 11));
  const b = aiTraits(fresh(undefined, 22));
  assert.notEqual(a.appetite, b.appetite, '推进欲望应该随种子变化');
  assert.ok(a.appetite >= 0.85 && a.appetite <= 1.2, '推进欲望应该落在合理区间');
  assert.ok(a.favorites.length >= 1, '应该有兵种偏好');
});

/**
 * 按特征挑一个兵种，不写死名字。
 *
 * 战术测试关心的是"有骑兵/有远程/有农民"这件事，不是"骑兵叫 scout"。
 * 写死名字的话，哪天兵种改名，红的是这几条用例，而不是真的坏了。
 */
function pickUnit(s: GameState, pred: (d: UnitTypeDef) => boolean): string {
  const hit = Object.values(s.unitTypes).find(pred);
  assert.ok(hit, '本局应该存在满足条件的兵种');
  return hit!.id;
}

/** 把一方的兵全撤掉，只留下指定阵容 */
function armyOf(s: GameState, owner: 'A' | 'B', ids: string[], at: { x: number; y: number }): void {
  s.units = s.units.filter((u) => u.owner !== owner);
  let k = 0;
  for (const id of ids) {
    const def = s.unitTypes[id];
    if (!def) continue;
    // 沿城市外圈依次摆开，撞到不能站人的格子就往后挪
    for (let ring = 1; ring < 8; ring++) {
      const spot = { x: at.x + ring, y: at.y };
      const tile = s.tiles[idx(s, spot.x, spot.y)];
      if (!tile || !passable(tile.terrain) || unitAt(s, spot.x, spot.y)) continue;
      s.units.push({
        id: `tz${k++}_${ring}`,
        type: id,
        owner,
        x: spot.x,
        y: spot.y,
        hp: def.maxHp,
        kills: 0,
        moved: false,
        acted: false,
      });
      break;
    }
  }
}

console.log('\nAI 战术倾向');

test('战术：势均力敌时不偏科，也不轻易弃城', () => {
  const s = fresh();
  s.current = 'A';
  refreshMemory(s);
  const m = aiMood(s);
  const top = Math.max(m.weight.rush, m.weight.harass, m.weight.boom);
  // 底色只该是压舱石：一颗种子决定"略微偏好哪种"，不该一上来就一言堂。
  assert.ok(top < 0.65, `势均力敌时主导战术占了 ${(top * 100).toFixed(0)}%，过于一言堂`);
  assert.ok(top - Math.min(m.weight.rush, m.weight.harass, m.weight.boom) < 0.5,
    `三种战术的权重拉得太开：${(m.weight.rush * 100) | 0}/${(m.weight.harass * 100) | 0}/${(m.weight.boom * 100) | 0}`);
  assert.equal(m.abandonedCityId, null, '门口没有危城的时候不该弃城');
});

test('战术：身价压过对面、敌城就在门口，就该速攻', () => {
  const s = fresh({ startEra: 2 });
  const foeCity = citiesOf(s, 'B')[0];
  const melee = pickUnit(s, (d) => d.category === 'combat' && d.domain !== 'water' && d.move >= 3);
  const heavy = pickUnit(s, (d) => d.category === 'combat' && d.domain !== 'water' && d.move >= 3 && d.era >= 2);
  // A：六个体壮又跑得动的，压在 B 城边上
  armyOf(s, 'A', [heavy, heavy, heavy, melee, melee, melee], { x: foeCity.x + 2, y: foeCity.y });
  // B：只剩一个民兵看家，身价被彻底比下去
  armyOf(s, 'B', [melee], { x: foeCity.x, y: foeCity.y + 4 });
  s.current = 'A';
  refreshMemory(s);

  const m = aiMood(s);
  assert.ok(m.metrics.power > 1.15, `身价应该压过对面，实际 power=${m.metrics.power.toFixed(2)}`);
  assert.equal(m.lead, 'rush', `这种局面下应该选速攻，实际选了 ${m.lead}`);
  assert.ok(m.weight.rush > 0.5, `速攻权重应该过半，实际 ${(m.weight.rush * 100) | 0}%`);
});

test('战术：正面打不穿、对面一屋子农民，就该转骚扰', () => {
  const s = fresh({ startEra: 2 });
  const myCity = citiesOf(s, 'A')[0];
  const foeCity = citiesOf(s, 'B')[0];
  const raider = pickUnit(s, (d) => d.category === 'combat' && d.domain !== 'water' && d.move >= 4 && d.range <= 3);
  const shooter = pickUnit(s, (d) => d.category === 'combat' && d.domain !== 'water' && (d.range ?? 1) >= 3);
  const farmer = pickUnit(s, (d) => d.category === 'economy');
  heavy: {
    const brute = pickUnit(s, (d) => d.category === 'combat' && d.domain !== 'water' && (d.cost ?? 0) >= 150);
    // B：一支比我贵得多的正面军队，缩在城里守家
    armyOf(s, 'B', [brute, brute, brute, brute], { x: foeCity.x, y: foeCity.y });
    // 外加四个农民在后方种地——骚扰的目标就是这些不还手的东西
    let n = 0;
    for (let dy = 5; dy < 9 && n < 4; dy++) {
      for (let dx = 0; dx < 4 && n < 4; dx++) {
        const x = foeCity.x + dx;
        const y = foeCity.y + dy;
        const tile = s.tiles[idx(s, x, y)];
        if (!tile || !passable(tile.terrain) || unitAt(s, x, y)) continue;
        const def = s.unitTypes[farmer];
        s.units.push({ id: `tf${n}`, type: farmer, owner: 'B', x, y, hp: def.maxHp, kills: 0, moved: false, acted: false });
        n += 1;
      }
    }
    assert.ok(n >= 3, `应该摆得下几个农民，实际 ${n} 个`);
  }
  // A：骑兵 + 远程，正面肯定打不过那四个大块头，但跑得快、够得着软目标
  armyOf(s, 'A', [raider, raider, shooter, shooter], { x: myCity.x + 2, y: myCity.y });
  s.current = 'A';
  refreshMemory(s);

  const m = aiMood(s);
  assert.ok(m.metrics.power < 1, `身价应该落后，实际 power=${m.metrics.power.toFixed(2)}`);
  assert.ok(m.metrics.foeEco >= 3, `对面应该有可骚扰的经济目标，实际 ${m.metrics.foeEco} 个`);
  assert.equal(m.lead, 'harass', `这种局面下应该转骚扰，实际选了 ${m.lead}`);
});

test('战术：兵临城下又攒得起升级，就该弃城换发展', () => {
  const s = fresh({ startEra: 2 });
  const mine = citiesOf(s, 'A');
  assert.ok(mine.length >= 2, '这条用例需要两座城：一座可弃、一座留着');
  const doomed = mine[0];
  const brute = pickUnit(s, (d) => d.category === 'combat' && d.domain !== 'water' && (d.cost ?? 0) >= 120);
  // B 的主力贴着这座城：2 格，已经是"下回合就能摸到城墙"的距离
  armyOf(s, 'B', [brute, brute, brute], { x: doomed.x, y: doomed.y });
  // A 自己人少、钱多、有经济底子
  const farmer = pickUnit(s, (d) => d.category === 'economy');
  armyOf(s, 'A', [farmer, farmer], { x: mine[1].x, y: mine[1].y });
  s.players.A.gold = 4000;
  s.players.A.res = { food: 4000, material: 4000 };
  s.current = 'A';
  refreshMemory(s);

  const m = aiMood(s);
  assert.ok(m.metrics.doomed > 0, '门口应该有一座真守不住的城');
  assert.ok(m.weight.boom >= 0.42, `弃城权重应该够高，实际 ${(m.weight.boom * 100) | 0}%`);
  assert.equal(m.abandonedCityId, doomed.id, '准备放掉的应该是那座危城');
});

test('战术：唯一能产当代兵的那座城永远不弃', () => {
  const s = fresh({ startEra: 2 });
  const mine = citiesOf(s, 'A');
  assert.ok(mine.length >= 2);
  const core = mine[0];
  const other = mine[1];
  // 一高一低造出"只有这座城是核心"的局面：核心领先一个时代，另一座落后
  core.era = 3;
  other.era = 2;
  const brute = pickUnit(s, (d) => d.category === 'combat' && d.domain !== 'water' && (d.cost ?? 0) >= 120);
  armyOf(s, 'B', [brute, brute, brute], { x: core.x, y: core.y });
  const farmer = pickUnit(s, (d) => d.category === 'economy');
  armyOf(s, 'A', [farmer, farmer], { x: other.x, y: other.y });
  s.players.A.gold = 4000;
  s.current = 'A';
  refreshMemory(s);

  const m = aiMood(s);
  assert.ok(m.metrics.doomed > 0, '核心城应该在挨打');
  assert.equal(m.abandonedCityId, null, '唯一能产当代兵的城不能弃——那是把"以后"也一起弃了');
});

test('战术：切换是渐变的，不会一回合翻脸', () => {
  // 同一局里连续看若干回合的权重，检查相邻两回合的最大跳变。
  // 这条是"切换自然"的量化底线：权重是连续函数，加上 drive 只在明确主导时
  // 才出手，理论上不该出现"这回合猛攻、下回合缩家"的硬切。
  let s = fresh({ aiOpponent: true, aiAlly: true }, 7);
  s.aiControl = { A: true, B: true };
  let prev: { rush: number; harass: number; boom: number } | null = null;
  let worst = 0;
  let worstAt = '';
  for (let round = 0; round < 8; round++) {
    const m = aiMood(s);
    if (prev) {
      const jump = Math.max(
        Math.abs(m.weight.rush - prev.rush),
        Math.abs(m.weight.harass - prev.harass),
        Math.abs(m.weight.boom - prev.boom),
      );
      if (jump > worst) {
        worst = jump;
        worstAt = `第 ${round} 回合 ${(jump * 100).toFixed(0)} 个百分点`;
      }
    }
    prev = { ...m.weight };
    for (const p of ['A', 'B'] as const) {
      s.current = p;
      for (let i = 0; i < 60; i++) {
        const a = aiNextAction(s);
        if (!a) break;
        const r = applyAction(s, a);
        if (!r.ok) break;
        s = r.state;
      }
      const e = applyAction(s, { type: 'END_TURN' });
      if (!e.ok) break;
      s = e.state;
    }
    if (s.winner) break;
  }
  assert.ok(worst < 0.4, `相邻回合的战术权重跳变太大：${worstAt}`);
});

test('档位：只有中级档才打三套战术，高级档保持稳的那一版', () => {
  // 同一局面下比两档的"生效倾向"：中级档原样输出 aiMood，
  // 高级档权重均分、drive 清零、不弃城——但主攻方向要留着（那是走位，不是战术）。
  const s = fresh({ startEra: 2, aiOpponent: true });
  const mine = citiesOf(s, 'A');
  assert.ok(mine.length >= 2, '这条用例需要两座城：一座可弃、一座留着');
  const doomed = mine[0];
  const brute = pickUnit(s, (d) => d.category === 'combat' && d.domain !== 'water' && (d.cost ?? 0) >= 120);
  armyOf(s, 'B', [brute, brute, brute], { x: doomed.x, y: doomed.y });
  const farmer = pickUnit(s, (d) => d.category === 'economy');
  armyOf(s, 'A', [farmer, farmer], { x: mine[1].x, y: mine[1].y });
  s.players.A.gold = 4000;
  s.current = 'A';
  refreshMemory(s);

  s.config.aiLevel = 'tactic';
  const tac = aiActiveMood(s);
  assert.equal(aiLevelOf(s), 'tactic', '中级档要能识别出来');
  assert.equal(aiLevelLabel(aiLevelOf(s)), '中级', '界面上叫"中级"');
  assert.equal(tac.abandonedCityId, doomed.id, '中级档在这种情况下该弃城');

  s.config.aiLevel = 'advanced';
  const adv = aiActiveMood(s);
  assert.equal(aiLevelOf(s), 'advanced');
  assert.equal(adv.abandonedCityId, null, '高级档不弃城');
  assert.equal(adv.drive.rush + adv.drive.harass + adv.drive.boom, 0, '高级档不该有战术出力');
  assert.equal(adv.weight.rush, 1 / 3, '高级档的权重应该是均分');
  assert.equal(adv.focusCityId, tac.focusCityId, '主攻方向两档一致——那是走位');

  // 中级档不做任何改写：它就是 aiMood 本身
  s.config.aiLevel = 'tactic';
  assert.deepEqual(aiActiveMood(s), aiMood(s));
});

console.log('\nAI 托管');

test('默认只接管 B 方', () => {
  const s = fresh({ aiOpponent: true });
  assert.equal(isAiSide(s, 'B'), true);
  assert.equal(isAiSide(s, 'A'), false);
  assert.equal(anyAiSide(s), true);
});

test('双 AI 观战两边都被接管', () => {
  const s = fresh({ aiOpponent: true, aiAlly: true });
  assert.equal(isAiSide(s, 'A'), true);
  assert.equal(isAiSide(s, 'B'), true);
});

test('热座模式两边都是人', () => {
  const s = fresh();
  assert.equal(anyAiSide(s), false);
});

test('运行时托管开关优先于开局配置', () => {
  const s = fresh(); // 配置里两边都是人
  s.aiControl = { B: true };
  assert.equal(isAiSide(s, 'B'), true, '中途把 B 交出去应该生效');
  assert.equal(isAiSide(s, 'A'), false, '不该顺手把 A 也交出去');
  s.aiControl = { A: false, B: false };
  assert.equal(anyAiSide(s), false, '全收回之后应该没人托管');
});

test('AI 拿 A 方也能自己走，不是只认 B', () => {
  const s = fresh({ aiAlly: true });
  s.config.aiOpponent = false; // 只有 A 是 AI
  assert.equal(s.current, 'A', '开局轮到 A');
  const a = aiNextAction(s, NO_RECRUIT);
  assert.ok(a, 'A 方 AI 应该能想出一步');
  const r = applyAction(s, a);
  assert.ok(r.ok, `A 方 AI 走了非法行动：${JSON.stringify(a)}`);
});

test('双 AI 从开局跑十几步不会卡死', () => {
  let cur = fresh({ aiOpponent: true, aiAlly: true });
  const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  let steps = 0;
  for (let i = 0; i < 30; i++) {
    const a = aiNextAction(cur, budget);
    if (!a) {
      // 没招了就是回合结束，换边继续——这正是 runAiLoop 做的事
      const r = applyAction(cur, { type: 'END_TURN' });
      assert.ok(r.ok, '结束回合应该是合法的');
      cur = r.state;
      budget.recruited = 0;
      budget.upgraded = 0;
      continue;
    }
    const r = applyAction(cur, a);
    assert.ok(r.ok, `第 ${i} 步非法：${JSON.stringify(a)}`);
    cur = r.state;
    steps += 1;
  }
  assert.ok(steps > 0, '双 AI 应该真的动起来');
  assert.equal(cur.winner, null, '三十步之内不该突然分出胜负（那说明规则有爆炸）');
});

console.log('\nAI 难度');

/**
 * 用指定档位的 AI 连跑若干步，返回每步的行动指纹。
 *
 * 用双 AI 对战来测，是因为这样两边的决策都在同一个状态序列上产生，
 * 初级/高级的差异会直接体现成"走出来的棋不一样"。
 */
function runLevel(level: 'basic' | 'advanced', seed: number, steps = 60): string[] {
  let cur = fresh(
    { startEra: 3, size: 16, aiOpponent: true, aiAlly: true, aiLevel: level },
    seed,
  );
  const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  const sig: string[] = [];
  for (let i = 0; i < steps; i++) {
    const a = aiNextAction(cur, budget);
    if (!a) {
      const r = applyAction(cur, { type: 'END_TURN' });
      assert.ok(r.ok, '结束回合应该是合法的');
      cur = r.state;
      budget.recruited = 0;
      budget.upgraded = 0;
      continue;
    }
    const r = applyAction(cur, a);
    assert.ok(r.ok, `${level} 档第 ${i} 步是非法行动：${JSON.stringify(a)}`);
    cur = r.state;
    sig.push(JSON.stringify(a));
  }
  return sig;
}

test('新对局默认开着血战，也可以手动关掉', () => {
  // 血战从"实验性扩展"升级成默认规则：不特别标注就按开着算。
  // 这条断言同时是给平衡模拟的锚——那边默认 --expansions bloodbath，跟这里必须一致，
  // 否则"测出来的平衡"和"玩家实际开的默认规则"就是两回事。
  assert.deepEqual(
    DEFAULT_CONFIG.expansionIds,
    ['bloodbath', 'turn-order-comp'],
    '血战和先后手补偿应该是默认扩展',
  );

  const on = createMatch({ ...DEFAULT_CONFIG }, 31);
  assert.deepEqual(on.config.expansionIds, ['bloodbath', 'turn-order-comp'], '开局状态要带上这两个规则');

  const off = createMatch({ ...DEFAULT_CONFIG, expansionIds: [] }, 31);
  assert.equal(off.config.expansionIds.length, 0, '取消勾选之后一个扩展都不该开');
  // 前 50 回合血战没有任何效果，所以两个开局的血量应该一模一样
  assert.equal(on.turn, off.turn);
  assert.equal(on.cities.length, off.cities.length);
});

test('后手开局补偿：按比例给 B 加金，默认一分不加', () => {
  // 先手多一个回合的收入和一次抢点机会，小图上最明显。
  // 这个旋钮默认是 0——补多少必须跑数据说话，不能直接写死进规则。
  const off = createMatch({ ...DEFAULT_CONFIG, expansionIds: [], secondGoldBonus: 0 }, 99);
  const on = createMatch({ ...DEFAULT_CONFIG, expansionIds: [], secondGoldBonus: 0.05 }, 99);

  // 先手那边一分不能动
  assert.equal(on.players.A.gold, off.players.A.gold, '补偿只给后手，先手不该变');

  // 补偿按"开局本金"算，不含第一回合收入——
  // 收入是按城市和地形算出来的，把它算进补偿基数会让这个旋钮跟着地图飘。
  const principal = startGoldFor(1);
  assert.equal(
    on.players.B.gold - off.players.B.gold,
    Math.round(principal * 0.05),
    `B 应该多拿 ${Math.round(principal * 0.05)} 金`,
  );
  assert.ok(
    on.log.some((l) => l.text.includes('后手补偿')),
    '战报里要写清楚这笔钱是怎么来的',
  );

  // 不给比例就是老样子
  const none = createMatch({ ...DEFAULT_CONFIG, expansionIds: [] }, 99);
  assert.equal(none.players.B.gold, off.players.B.gold, '不填这个字段等于不补偿');
});

test('先后手补偿：12×12 补 20%、16×16 补 5%，跟着棋盘尺寸走', () => {
  const p = startGoldFor(1);

  const small = createMatch({ ...DEFAULT_CONFIG, size: 12 }, 41);
  const smallOff = createMatch({ ...DEFAULT_CONFIG, size: 12, expansionIds: ['bloodbath'] }, 41);
  assert.equal(
    small.players.B.gold - smallOff.players.B.gold,
    Math.round(p * 0.2),
    '12×12 上后手该多拿 20% 起始金',
  );

  const big = createMatch({ ...DEFAULT_CONFIG, size: 16 }, 41);
  const bigOff = createMatch({ ...DEFAULT_CONFIG, size: 16, expansionIds: ['bloodbath'] }, 41);
  assert.equal(
    big.players.B.gold - bigOff.players.B.gold,
    Math.round(p * 0.05),
    '16×16 上后手该多拿 5% 起始金',
  );

  // 补的是后手，先手的钱一分不能动
  assert.equal(small.players.A.gold, smallOff.players.A.gold, '先手不该变');
  assert.equal(big.players.A.gold, bigOff.players.A.gold, '先手不该变');

  // 中间尺寸线性插值：小图上钱这个杠杆钝，大图上才补得少
  assert.equal(turnOrderBonusFor(12), 0.2);
  assert.equal(turnOrderBonusFor(16), 0.05);
  assert.equal(turnOrderBonusFor(14), 0.125, '14×14 应该落在 20% 和 5% 中间');
  assert.equal(turnOrderBonusFor(9), 0.2, '比 12 更小的图按 20% 封顶');
  assert.equal(turnOrderBonusFor(24), 0.05, '比 16 更大的图按 5% 封顶');

  // 战报要写清楚这笔钱是哪条规则给的
  assert.ok(
    small.log.some((l) => l.text.includes('先后手补偿')),
    '战报里要出现「先后手补偿」',
  );
});

test('先后手补偿可以关掉，跑批旋钮也能压过它给的比例', () => {
  const p = startGoldFor(1);
  const off = createMatch({ ...DEFAULT_CONFIG, size: 16, expansionIds: ['bloodbath'] }, 43);
  const auto = createMatch({ ...DEFAULT_CONFIG, size: 16 }, 43);
  const over = createMatch({ ...DEFAULT_CONFIG, size: 16, secondGoldBonus: 0.1 }, 43);

  assert.equal(auto.players.B.gold - off.players.B.gold, Math.round(p * 0.05), '默认按 5% 补');
  assert.equal(
    over.players.B.gold - off.players.B.gold,
    Math.round(p * 0.1),
    '给了旋钮就以旋钮为准，不该和扩展叠成 15%',
  );
});

test('先手第一回合可以不结算收入，后手照常', () => {
  // 这是"结构性配平"的开关：先手白拿一回合收入（古典约 91 金）是先后手差距里
  // 最硬的一块，关掉之后先手只剩"先动一步"。
  const off = createMatch({ ...DEFAULT_CONFIG, expansionIds: [] }, 99);
  const on = createMatch({ ...DEFAULT_CONFIG, expansionIds: [], noFirstIncome: true }, 99);

  assert.equal(on.players.A.gold, startGoldFor(1), 'A 应该只剩起始本金');
  assert.equal(on.players.B.gold, off.players.B.gold, '补偿只动先手，后手开局不变');
  assert.ok(
    !on.log.some((l) => l.text.includes('开局结算')),
    '不结算就不该有那条"开局结算"战报',
  );

  // 后手到自己回合照样拿钱——关的是"先手赛前那一笔"，不是所有人的第一笔
  const next = applyAction(on, { type: 'END_TURN' });
  assert.ok(next.ok);
  assert.ok(
    next.state.players.B.gold > on.players.B.gold,
    '后手第一回合开始应该正常结算收入',
  );
});

test('难度会被带进对局；老存档没有这个字段就按高级跑', () => {
  assert.equal(DEFAULT_CONFIG.aiLevel, 'advanced', '新对局默认应该是高级 AI');

  const basic = createMatch({ ...DEFAULT_CONFIG, aiLevel: 'basic' }, 7);
  assert.equal(aiLevelOf(basic), 'basic');

  // 老存档 / 老回放里没有 aiLevel 字段，不能因此退回初级：
  // 那样读一次旧档，AI 的水平就无缘无故掉一档。
  const legacy: Record<string, unknown> = { ...DEFAULT_CONFIG };
  delete legacy.aiLevel;
  const s = createMatch(legacy as unknown as MatchConfig, 7);
  assert.equal(aiLevelOf(s), 'advanced');
});

test('两档 AI 都能合法跑完一串决策，而且走出来的棋不一样', () => {
  const basic = runLevel('basic', 9091);
  const adv = runLevel('advanced', 9091);

  assert.ok(basic.length > 5, `初级档几乎没动：只走了 ${basic.length} 步`);
  assert.ok(adv.length > 5, `高级档几乎没动：只走了 ${adv.length} 步`);

  // 这一步真正的意义是确认难度开关真的接在打分上了，
  // 而不是加了个字段、界面上有两个按钮、底层还是同一套代码。
  const same = basic.length === adv.length && basic.every((v, i) => v === adv[i]);
  assert.ok(!same, '初级和高级走出了完全相同的棋，难度开关没接上');
});

test('两档 AI 的决策都还是确定性的', () => {
  // 加了新分支之后仍然不能碰 Math.random：回放和双 AI 观战都靠这一条。
  for (const level of ['basic', 'advanced'] as const) {
    assert.deepEqual(runLevel(level, 5150, 25), runLevel(level, 5150, 25), `${level} 档不可复现`);
  }
});

console.log('\n接续架桥 / 城陷冷却 / 采购权重');

test('刚接管（包括入驻废墟）的城市当回合不能产兵，下一回合恢复', () => {
  const s = fresh({ startEra: 2, size: 16 }, 7788);
  assert.ok(citiesOf(s, 'B').length >= 2, '这局得让 B 有两座城，不然打下一座就直接结束');
  s.units = s.units.filter((u) => u.owner !== 'B');
  const city = citiesOf(s, 'B')[0];
  assert.ok(city);
  city.hp = 1;
  const spot = { x: city.x - 2, y: city.y };
  s.tiles[idx(s, spot.x, spot.y)].terrain = 'plain';
  const bow = place(s, 'A', 'longbow', spot.x, spot.y);
  // 再放一只贴城的步兵，负责破城之后走进去接管
  const foot = place(s, 'A', 'militia', city.x + city.size, city.y);
  s.tiles[idx(s, city.x + city.size, city.y)].terrain = 'plain';
  s.current = 'A';
  s.players.A.gold = 900;
  refreshMemory(s);

  const at = s.turn;
  const hit = applyAction(s, { type: 'SIEGE', unitId: bow.id, cityId: city.id });
  assert.ok(hit.ok, `攻城应该成立：${!hit.ok ? hit.reason : ''}`);
  let st = hit.state;
  assert.equal(st.cities.find((c) => c.id === city.id)?.ruined, true, '破城之后是废墟');

  const move = applyAction(st, { type: 'MOVE', unitId: foot.id, x: city.x, y: city.y });
  assert.ok(move.ok, move.ok ? '' : `入驻失败：${move.reason}`);
  st = move.state;
  const taken = st.cities.find((c) => c.id === city.id);
  assert.ok(taken);
  assert.equal(taken.owner, 'A', '入驻之后才易主');
  assert.equal(taken.capturedTurn, at, '要记下是被哪一回合接管的');

  const blocked = applyAction(st, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' });
  assert.equal(blocked.ok, false, '当回合不能出兵');

  // 过一回合就恢复生产
  const next = applyAction(st, { type: 'END_TURN' });
  assert.ok(next.ok);
  const again = applyAction({ ...next.state, current: 'A' }, {
    type: 'RECRUIT',
    cityId: city.id,
    unitType: 'militia',
  });
  assert.ok(again.ok, again.ok ? '' : `下一回合应该能产兵：${again.reason}`);
});


test('桥能沿着已经铺好的桥面往河心接，但不能斜着接', () => {
  const s = fresh({ startEra: 1, size: 16 }, 5544);
  s.units = [];
  // 先把地形抹平：地图自带的河可能正好流经 x=5~8，把"岸边"也变成水面，
  // 于是下面第一格被判定成"四面都是水"——这条用例就变成在测地图运气了。
  for (const t of s.tiles) {
    if (t.terrain !== 'city') t.terrain = 'plain';
  }
  // 一条 3 格宽的南北向水道
  for (let y = 0; y < s.h; y++) {
    for (const x of [6, 7, 8]) s.tiles[idx(s, x, y)].terrain = 'water';
  }
  place(s, 'A', 'laborer', 5, 5);
  s.current = 'A';
  s.players.A.gold = 1000;
  refreshMemory(s);

  const build = (x: number, y: number) => {
    // 每次动作都要把新状态接回来：applyAction 是深拷贝，不接的话下一格看到的还是旧地图。
    const u = s.units.find((k) => k.type === 'laborer');
    assert.ok(u);
    u.acted = false; // 每个动作之间手工清标记，这段测的是距离判定不是行动经济
    const r = applyAction(s, { type: 'BUILD', unitId: u.id, unitType: 'bridge', x, y });
    if (r.ok) {
      const n = r.state;
      s.units = n.units;
      s.tiles = n.tiles;
      s.players = n.players;
      s.nextUnitSeq = n.nextUnitSeq;
      s.log = n.log;
    }
    return r;
  };

  const far = build(8, 5);
  assert.ok(!far.ok, '中间没有桥的时候，第三格不该够得着');
  assert.ok(far.reason.includes('离得太远'), `理由要写清楚：${far.reason}`);

  const first = build(6, 5);
  assert.ok(first.ok, `第一格应该在建造距离内：${!first.ok ? first.reason : ''}`);
  const second = build(7, 5);
  assert.ok(second.ok, `第二格也在建造距离内：${!second.ok ? second.reason : ''}`);
  const chained = build(8, 5);
  assert.ok(chained.ok, `前两格铺好之后，第三格应该能接着铺：${!chained.ok ? chained.reason : ''}`);
  assert.equal(s.tiles[idx(s, 8, 5)].terrain, 'bridge', '铺通之后那一格要变成桥面');

  // 斜着不认：桥面是一条直线
  s.tiles[idx(s, 8, 6)].terrain = 'water';
  const diag = build(8, 7);
  assert.ok(!diag.ok, '斜着往外接不该成立');
});

test('隔河拆桥：远程能放箭，但一发只算一半', () => {
  // 以前是"必须贴到桥头"，一刀切的后果是远程连顺手拆座空桥都做不到。
  // 现在改成"准许打、但打折"：射程够就能朝桥开火，隔一格以上一发放一半，
  // 贴着桥头才是满伤。想真的断掉这条路，还是得把部队压到桥边。
  const s = fresh({ startEra: 1, size: 12 }, 7171);
  s.units = [];
  for (const t of s.tiles) {
    if (t.terrain !== 'city') t.terrain = 'plain';
  }
  for (const y of [4, 5]) for (let x = 0; x < s.w; x++) s.tiles[idx(s, x, y)].terrain = 'water';
  s.tiles[idx(s, 5, 4)].terrain = 'bridge';
  const bridge = place(s, 'B', 'bridge', 5, 4);
  const bow = place(s, 'A', 'longbow', 5, 2);
  // Unit 上只有 hp，没有 maxHp——上限得从兵种表读
  const bridgeMax = utype(s, bridge.type).maxHp;

  s.current = 'A';
  refreshMemory(s);

  // 隔两格：能打，但只算半伤
  const far = applyAction(s, { type: 'ATTACK', unitId: bow.id, targetId: bridge.id });
  assert.ok(far.ok, `隔河也该能放箭了：${!far.ok ? far.reason : ''}`);
  // applyAction 返回的是一份新状态，血量要从 far.state 里读——读 s 上的旧对象永远是满血
  const hitFar = far.state.units.find((u) => u.id === bridge.id)!;
  const farDmg = bridgeMax - hitFar.hp;

  // 贴到桥头（岸边那一格）：满伤，而且明显更快
  const s2 = far.state;
  const bridge2 = s2.units.find((u) => u.id === bridge.id)!;
  bridge2.hp = bridgeMax;
  const bow2 = s2.units.find((u) => u.id === bow.id)!;
  readyAgain(bow2);
  bow2.x = 5;
  bow2.y = 3;
  const near = applyAction(s2, { type: 'ATTACK', unitId: bow2.id, targetId: bridge2.id });
  assert.ok(near.ok, `贴着桥头应该能拆：${!near.ok ? near.reason : ''}`);
  const nearDmg = bridgeMax - near.state.units.find((u) => u.id === bridge.id)!.hp;

  assert.ok(farDmg > 0, '远程拆桥不是零伤害——放开射程判定就该真的掉血');
  assert.equal(
    farDmg,
    Math.round(nearDmg * CONFIG.bridgeRangedDamageRatio),
    `隔河一发只算 ${CONFIG.bridgeRangedDamageRatio}：近身 ${nearDmg}、隔河 ${farDmg}`,
  );
  // 40 血的木桥：贴桥头 3 下、隔河 6 下。这个倍差就是"快"与"慢"的区别
  assert.ok(nearDmg * 3 >= bridgeMax, `贴桥头要能在 3 下内拆掉：${nearDmg}×3`);
  assert.ok(farDmg * 3 < bridgeMax, `隔河 3 下不该拆得掉：${farDmg}×3`);
});

test('AI 拆桥看态势：桥顶到城门口才拆，两军中间的桥不碰', () => {
  // 桥的"击杀账"和普通单位不一样：木桥只有几十点耐久，一发两发就塌，
  // 按"打死一支兵 = 120 分"来算，AI 会为了拆一座桥把整轮齐射都扔进去——
  // 拆完自己过河还得重新架。所以桥单独算：只有"顶着自家城门"（死守）
  // 和"桥在对面那一侧、自己还在往前推"这两种情况才给分。
  //
  // 这里把两种局面摆出来对撞同一个问题：这一手该不该花在桥上。
  const s = fresh({ startEra: 1, size: 12 }, 7171);
  s.units = [];
  for (const t of s.tiles) {
    if (t.terrain !== 'city') t.terrain = 'plain';
  }
  // 没有金币＝没有产兵/建造候选，这一回合只剩"这个兵做什么"要判断
  s.players.A.gold = 0;
  s.players.B.gold = 0;

  const home = s.cities.find((c) => c.owner === 'A')!;
  const gateY = home.y - 2;
  s.tiles[idx(s, home.x, gateY)].terrain = 'bridge';
  const bridge = place(s, 'B', 'bridge', home.x, gateY);
  // 用民兵而不是长弓：射程 1 的兵不会被"顺手围一下墙那边的城"抢走候选，
  // 这一回合它要么拆桥、要么什么都不做
  const bow = place(s, 'A', 'militia', home.x, gateY - 1);
  // moved 先置真：这样就没有"往前挪一格"的候选来抢，考的就是拆桥本身
  bow.moved = true;
  s.current = 'A';
  refreshMemory(s);

  const atGate = aiNextAction(s);
  assert.ok(
    atGate?.type === 'ATTACK' && atGate.targetId === bridge.id,
    `桥顶到城门口就该拆——这是死守：${JSON.stringify(atGate)}`,
  );

  // 同一座桥搬到地图正中：离两边都远，谁都不从这里过河
  const mx = Math.floor(s.w / 2);
  const my = Math.floor(s.h / 2);
  bridge.x = mx;
  bridge.y = my;
  s.tiles[idx(s, mx, my)].terrain = 'bridge';
  bow.x = mx;
  bow.y = my - 1;
  refreshMemory(s);

  const mine = Math.min(
    ...s.cities.filter((c) => c.owner === 'A').map((c) => distToCity({ x: mx, y: my }, c)),
  );
  const foe = Math.min(
    ...s.cities.filter((c) => c.owner === 'B').map((c) => distToCity({ x: mx, y: my }, c)),
  );
  assert.ok(mine > 3, `这张图上"正中"得离我家城门够远，不然考不出区别：${mine}`);
  assert.ok(foe >= mine, `正中那格对两边得一样远，才谈得上"谁都不从这里过"：我 ${mine} / 敌 ${foe}`);

  const inMiddle = aiNextAction(s);
  assert.ok(
    !(inMiddle?.type === 'ATTACK' && inMiddle.targetId === bridge.id),
    `不值得为一座谁都不过的桥花掉一次攻击：${JSON.stringify(inMiddle)}`,
  );
});

test('AI 会一直铺到对岸，而不是每回合换个地方重来', () => {
  // 一道三格宽、贯穿全图的横向水道，把 A 的城（南）和 B 的城（北）彻底隔开。
  // 这正是无渡口河图的样子：以前 AI 会在河岸上来回走、铺一格就换地方，
  // 打到第 200 回合还是过不去。
  const s = fresh({ startEra: 1, size: 12 }, 6060);
  s.units = [];
  // 先把地面抹平，只留这条河：这张图是为"架桥"这一件事造的，
  // 带上几片天然池塘反而会干扰"它是不是在同一条线上接着铺"的判定。
  for (const t of s.tiles) {
    if (t.terrain !== 'city') t.terrain = 'plain';
  }
  for (let x = 0; x < s.w; x++) {
    for (const y of [4, 5, 6]) s.tiles[idx(s, x, y)].terrain = 'water';
  }
  place(s, 'A', 'laborer', 5, 7);
  place(s, 'A', 'laborer', 7, 7);
  s.players.A.gold = 1500;
  s.current = 'A';
  refreshMemory(s);

  const crossed = (st: GameState) => {
    for (let x = 0; x < st.w; x++) {
      const row = [4, 5, 6].map((y) => st.tiles[idx(st, x, y)].terrain);
      if (row.every((t) => t === 'bridge')) return true;
    }
    return false;
  };

  let st = s;
  let ok = false;
  const crumbs: string[] = [];
  for (let round = 0; round < 30 && !ok; round++) {
    for (let step = 0; step < 40; step++) {
      const a = aiNextAction(st);
      if (!a) break;
      const r = applyAction(st, a);
      if (!r.ok) break;
      st = r.state; // 动作返回的是新状态，不接回来等于原地打转
      crumbs.push(
        a.type === 'BUILD'
          ? `T${st.turn} 建${a.unitType}@(${a.x},${a.y})`
          : `T${st.turn} ${a.type}`,
      );
    }
    ok = crossed(st);
    // 换到 B 再立刻换回 A：不给 B 拆桥的机会，只测 A 自己的架桥连贯性
    const e1 = applyAction(st, { type: 'END_TURN' });
    if (!e1.ok) break;
    st = e1.state;
    const e2 = applyAction(st, { type: 'END_TURN' });
    if (!e2.ok) break;
    st = e2.state;
  }
  const built = st.units
    .filter((u) => st.unitTypes[u.type]?.bridges)
    .map((u) => `(${u.x},${u.y})`);
  assert.ok(
    ok,
    `30 个回合内应该把两格水道铺通；桥 ${built.length} 座 ${built.join(' ')}；` +
      `最近动作 ${crumbs.slice(-10).join(' → ')}`,
  );
});

test('按兵种搭配买兵：真远程的预算不会被长兵器挤掉', () => {
  // 戟兵射程改 2 之后，上一版把它当成"远程"来奖励：既拿远程的 +9，
  // 又把远程占比撑虚，结果火药局戟兵采用率 23.7%、火枪兵只剩 6.8%。
  const s = fresh({ startEra: 3, size: 16, aiLevel: 'advanced' }, 9090);
  s.units = s.units.filter((u) => u.owner !== 'A');
  s.players.A.gold = 2400;
  s.current = 'A';
  refreshMemory(s);

  const picks: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = aiNextAction(s, { maxRecruit: 1, maxUpgrade: 0, recruited: 0, upgraded: 0 });
    if (!a || a.type !== 'RECRUIT') break;
    picks.push(a.unitType);
    const r = applyAction(s, a);
    if (!r.ok) break;
    s.units = r.state.units;
    s.players = r.state.players;
  }
  const ranged = picks.filter((id) => (s.unitTypes[id]?.range ?? 0) >= 3).length;
  const reach = picks.filter((id) => s.unitTypes[id]?.range === 2).length;
  assert.ok(picks.length >= 6, `这一轮应该买得起好几支兵：${picks.length}`);
  assert.ok(
    ranged >= reach,
    `射程 3 以上的买到 ${ranged} 个、长兵器 ${reach} 个：${picks.map((id) => s.unitTypes[id]?.name).join(' ')}`,
  );
});

test('编队模板：兵种按职能归类，缺哪一档补哪一档', () => {
  // 模板要解决的问题是"采购是纯 argmax"：分最高的兵种吃满预算，
  // 一局下来清一色三四种兵。它按职能算配比，不按兵种 id 算。
  const s = createMatch({ ...BASE, expansionIds: EXPANSIONS.map((e) => e.id) }, 12345);
  const role = (name: string) => {
    const def = Object.values(s.unitTypes).find((d) => d.name === name);
    assert.ok(def, `兵种表里没有 ${name}`);
    return rosterRoleOf(def);
  };
  assert.equal(role('民兵'), 'melee', '没甲没血的近战就是近战输出');
  assert.equal(role('弓手'), 'ranged');
  assert.equal(role('长枪兵'), 'tank', '血厚甲高的近战是在顶前排');
  assert.equal(role('臼炮'), 'siege');
  assert.equal(role('牧师'), 'support', '自己打不动的治疗算支援');
  assert.equal(role('天使'), 'tank', '天使能打能顶，治疗光环只是顺带');

  // 六个近战的部队：近战满编制，前排 / 远程 / 支援三档全缺
  const bonus = rosterBonuses({
    total: 6,
    counts: { tank: 0, melee: 6, ranged: 0, support: 0, siege: 0 },
    siegeAtWall: false,
  });
  assert.equal(bonus.melee, 0, '近战已经够了，不再加分');
  assert.ok(bonus.tank > 8, `缺前排要加分：${JSON.stringify(bonus)}`);
  assert.ok(bonus.ranged > 8, `缺远程要加分：${JSON.stringify(bonus)}`);
  assert.ok(bonus.support > 8, `缺支援要加分：${JSON.stringify(bonus)}`);
  assert.equal(bonus.siege, 0, '攻城器不参与常备配比');

  // 一支部队都没有时不加分：开局该由"先凑出能打的一小撮"决定
  assert.deepEqual(
    rosterBonuses({
      total: 0,
      counts: { tank: 0, melee: 0, ranged: 0, support: 0, siege: 0 },
      siegeAtWall: false,
    }),
    { tank: 0, melee: 0, ranged: 0, support: 0, siege: 0 },
  );
});

test('编队模板：一屋子近战之后，AI 会去补远程和支援', () => {
  // 上一版没有模板时，这里会连买六七个近战：近战的分本来就高，
  // 同兵种递减又只按"同一个兵种"算，换个近战兵种照样吃得下预算。
  const s = fresh(
    { startEra: 4, size: 20, aiLevel: 'advanced', expansionIds: EXPANSIONS.map((e) => e.id) },
    4242,
  );
  s.units = s.units.filter((u) => u.owner !== 'A');
  const home = citiesOf(s, 'A')[0];

  // 五个民兵摆在城外：既让出出兵的格子，又让"近战已经够了"成为事实。
  //
  // 为什么是 5 而不是 6：攒钱逻辑的门槛是"军队至少 6 个"。本用例要测的是
  // **职能配比**（缺远程/支援就补），不是"有钱时先买英雄还是先买兵"——
  // 那是另一条用例的事。军队压在门槛之下，攒钱不启动，测得就干净。
  let placed = 0;
  for (let ring = 2; ring <= 4 && placed < 5; ring++) {
    for (let dy = -ring; dy <= ring && placed < 5; dy++) {
      for (let dx = -ring; dx <= ring && placed < 5; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = home.x + dx;
        const y = home.y + dy;
        if (x < 1 || y < 1 || x >= s.w - 1 || y >= s.h - 1) continue;
        if (unitAt(s, x, y) || buildingAt(s, x, y)) continue;
        const ter = s.tiles[idx(s, x, y)].terrain;
        if (ter === 'water' || ter === 'mountain') continue;
        place(s, 'A', 'militia', x, y);
        placed += 1;
      }
    }
  }
  assert.equal(placed, 5, `城边应该摆得下五个民兵，只摆下 ${placed} 个`);

  // 城郭与物料下粮/材才是主成本，只给金币等于没给钱
  s.players.A.gold = 3000;
  s.players.A.res = { food: 3000, material: 3000 };
  s.current = 'A';
  refreshMemory(s);

  const picks: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = aiNextAction(s, { maxRecruit: 1, maxUpgrade: 0, recruited: 0, upgraded: 0 });
    if (!a || a.type !== 'RECRUIT') break;
    picks.push(a.unitType);
    const r = applyAction(s, a);
    if (!r.ok) break;
    s.units = r.state.units;
    s.players = r.state.players;
  }
  const roles = picks.map((id) => rosterRoleOf(s.unitTypes[id]));
  const name = picks.map((id) => s.unitTypes[id]?.name).join(' ');
  // 门槛从 4 降到 2：新版 AI 在钱多时会先买英雄/攒升级，一回合里
  // 未必连着买四支兵。这条用例只验"买回来的要分职能"，不验"买几个"。
  assert.ok(picks.length >= 2, `这一轮应该买得起几支兵：${picks.length} 个（${name}）`);
  assert.ok(
    new Set(roles).size >= 2,
    `买回来的全是同一档职能：${roles.join(' ')}（${name}）`,
  );
  assert.ok(
    roles.some((r) => r === 'ranged' || r === 'support'),
    `一屋子近战之后该补远程或支援，实际只买了：${roles.join(' ')}（${name}）`,
  );
});

test('AI 会往前线扎军营，不是把钱全堆在城里', () => {
  // 磨局统计里最刺眼的一条：一方顶满 24 个单位、金库还压着几千金。
  // 钱花不出去等于没有压力，而军营是唯一能把钱直接变成"前线产兵点"的东西。
  const s = fresh({ startEra: 2, size: 16, aiLevel: 'advanced' }, 4848);
  // 夹具按完整敌军位置选“前线”，让 AI 也能看到这些敌军；迷雾另有专项用例。
  s.fog = false;
  const own = citiesOf(s, 'A')[0];
  const foes = unitsOf(s, 'B');
  const N4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  // 找一块军营站得住的平地：临水、离敌人 5~9 格、离自己城 12 格内。
  // 这三条正是 rawBuildScore 里"不近不远"的判据，直接用它当夹具。
  let spot: { x: number; y: number } | null = null;
  for (let y = 1; y < s.h - 1 && !spot; y++) {
    for (let x = 1; x < s.w - 1 && !spot; x++) {
      if (s.tiles[idx(s, x, y)].terrain !== 'plain') continue;
      if (unitAt(s, x, y)) continue;
      const water = N4.some(([dx, dy]) => s.tiles[idx(s, x + dx, y + dy)]?.terrain === 'water');
      if (!water) continue;
      if (distance({ x, y }, own) > 12) continue;
      const nearFoe = Math.min(...foes.map((f) => distance({ x, y }, f)));
      if (nearFoe < 5 || nearFoe > 9) continue;
      spot = { x, y };
    }
  }
  assert.ok(spot, '这张图上应该找得到一处合法的营地');

  place(s, 'A', 'miller', spot.x, spot.y);
  s.players.A.gold = 3000;
  s.current = 'A';
  refreshMemory(s);

  const built: string[] = [];
  let st = s;
  for (let round = 0; round < 8 && built.length === 0; round++) {
    const budget = { ...DEFAULT_BUDGET };
    const rejected = new Set<string>();
    for (let i = 0; i < AI_MAX_STEPS; i++) {
      const a = aiNextAction(st,budget,rejected);
      if (!a) break;
      if (a.type === 'BUILD' && st.unitTypes[a.unitType]?.barracks) built.push(a.unitType);
      const r = applyAction(st, a);
      if (!r.ok) { rejected.add(JSON.stringify(a)); continue; }
      rejected.clear();
      if (a.type==='RECRUIT') budget.recruited++;
      if (a.type==='UPGRADE') budget.upgraded++;
      st = r.state;
      st.players.A.gold = 3000; // 只测"想不想建"，不测攒不攒得出钱
    }
    const e1 = applyAction(st, { type: 'END_TURN' });
    if (!e1.ok) break;
    st = e1.state;
    const e2 = applyAction(st, { type: 'END_TURN' });
    if (!e2.ok) break;
    st = e2.state;
  }
  assert.ok(built.length > 0, '有钱、有前线的时候，AI 应该至少扎一座军营');
});

console.log('\n确定性');
test('同样的配置和操作序列得到同样的结果', () => {
  const run = () => {
    let s = fresh(undefined, 424242);
    const u = findUnit(s, 'A', 'militia');
    const reach = reachableTiles(s, u);
    const target = Array.from(reach.keys())[0];
    assert.ok(target !== undefined);
    const x = target % s.w;
    const y = Math.floor(target / s.w);

    let r = applyAction(s, { type: 'MOVE', unitId: u.id, x, y });
    assert.ok(r.ok);
    s = r.state;
    r = applyAction(s, { type: 'END_TURN' });
    assert.ok(r.ok);
    s = r.state;
    r = applyAction(s, { type: 'END_TURN' });
    assert.ok(r.ok);
    return r.state;
  };
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});


test('incomeOf 和真实结算同源', () => {
  // 界面靠它算"接下来几回合还有多少钱"，算错就会误导玩家排计划
  const s = fresh();
  const before = s.players.B.gold;
  const income = incomeOf(s, 'B');
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok);
  assert.equal(r.state.players.B.gold, before + income, '估算应该和结束回合实际到账一致');
});

console.log('\n指挥官模式');

/** 指挥官模式的一局，A 方行动，钱给足 */
function commandPost(extra?: Partial<MatchConfig>): GameState {
  // aiAlly 一并置真：这几条测的是"AI 在指挥官模式下怎么打"，
  // 而"替谁排序列"取决于这一方是不是真的托管了
  const s = fresh({ commanderMode: true, aiAlly: true, ...extra });
  s.current = 'A';
  s.players.A.gold = 1000;
  return s;
}

test('普通对局不接受生产序列', () => {
  const s = fresh();
  assert.equal(applyAction(s, { type: 'SET_ORDERS', queue: ['archer'] }).ok, false);
  assert.deepEqual(ordersOf(s, 'A'), [], '没开指挥官模式就不该有序列');
});

test('指挥官模式能排 5 格：末尾空位裁掉，中间空位保留', () => {
  const s = commandPost();
  const r = applyAction(s, { type: 'SET_ORDERS', queue: ['archer', '', 'militia', '', ''] });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  // 中间那个空位是"这回合故意不造"，必须留着，否则后面整条序列会往前挪
  assert.deepEqual(ordersOf(r.state, 'A'), ['archer', '', 'militia']);
});

test('生产序列最多 5 格，超出的截掉', () => {
  const s = commandPost();
  const r = applyAction(s, {
    type: 'SET_ORDERS',
    queue: new Array(CONFIG.commanderSlots + 3).fill('archer'),
  });
  assert.ok(r.ok);
  assert.equal(ordersOf(r.state, 'A').length, CONFIG.commanderSlots);
});

test('不能把建筑排进生产序列', () => {
  const s = commandPost();
  const r = applyAction(s, { type: 'SET_ORDERS', queue: ['tower'] });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes('建筑'), `理由该说清是建筑：${!r.ok ? r.reason : ''}`);
});

test('不存在的兵种会被拒绝', () => {
  const s = commandPost();
  assert.equal(applyAction(s, { type: 'SET_ORDERS', queue: ['no-such-unit'] }).ok, false);
});

test('结束回合时序列前移一格，造没造出来都算消耗', () => {
  const s = commandPost();
  const r = applyAction(s, { type: 'SET_ORDERS', queue: ['archer', 'militia'] });
  assert.ok(r.ok);
  const end = applyAction(r.state, { type: 'END_TURN' });
  assert.ok(end.ok);
  assert.deepEqual(ordersOf(end.state, 'A'), ['militia'], '队首应该出队');
});

test('「升级时代」能排进序列，同样占一格', () => {
  const s = commandPost();
  const r = applyAction(s, { type: 'SET_ORDERS', queue: [ORDER_UPGRADE, 'archer'] });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.deepEqual(ordersOf(r.state, 'A'), [ORDER_UPGRADE, 'archer']);

  const end = applyAction(r.state, { type: 'END_TURN' });
  assert.ok(end.ok);
  assert.deepEqual(ordersOf(end.state, 'A'), ['archer'], '升级那一格也该被消耗掉');
});

test('排了「升级时代」，AI 这一回合真的会去升级', () => {
  const s = commandPost(); // 1000 金，够升到中世
  s.orders = { A: [ORDER_UPGRADE] }; // Explicit order: this test is not about auto-planning.
  const budget = { ...DEFAULT_BUDGET, maxRecruit: 0, maxUpgrade: 1, order: null };
  let cur = s;
  let got = false;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur, budget);
    if (!a) break;
    if (a.type === 'UPGRADE') {
      got = true;
      break;
    }
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
  assert.ok(got, '钱够就该升级');
});

test('队首不是「升级时代」时，AI 不升时代', () => {
  // 指挥官模式里升级也要占一格序列，队首是兵种就没有升级的余地
  const s = commandPost();
  const set = applyAction(s, { type: 'SET_ORDERS', queue: ['archer'] });
  assert.ok(set.ok);
  let cur = set.state;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur, DEFAULT_BUDGET);
    if (!a) break;
    assert.notEqual(a.type, 'UPGRADE', '队首是兵种时不该出现升级动作');
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
});

test('队首点名了哪个兵，AI 就只造哪个兵', () => {
  const s = commandPost();
  const set = applyAction(s, { type: 'SET_ORDERS', queue: ['archer'] });
  assert.ok(set.ok);
  let cur = set.state;
  let got: string | null = null;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur, DEFAULT_BUDGET);
    if (!a) break;
    if (a.type === 'RECRUIT') {
      got = a.unitType;
      break;
    }
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
  assert.equal(got, 'archer', '队首点名弓手就该造弓手');
});

test('队首的兵造不起时，不会拿别的兵凑数', () => {
  const s = commandPost();
  // 26 金：够民兵（25），不够弓手（30）
  s.players.A.gold = 26;
  const set = applyAction(s, { type: 'SET_ORDERS', queue: ['archer'] });
  assert.ok(set.ok);
  let cur = set.state;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur, DEFAULT_BUDGET);
    if (!a) break;
    assert.notEqual(a.type, 'RECRUIT', '造不起就空过这一回合，不能自己换个便宜的顶上');
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
});

test('指挥官模式下 AI 会自己排一条序列，而不是自由产兵', () => {
  const s = commandPost(); // A 方、1000 金、序列空
  const a = aiNextAction(s, DEFAULT_BUDGET);
  assert.ok(a, '空序列时 AI 至少该排一条计划');
  assert.equal(a.type, 'SET_ORDERS', '第一个动作应该是排序列，不是直接造兵');

  const queue = (a as { type: 'SET_ORDERS'; queue: string[] }).queue;
  assert.ok(queue.length > 0 && queue.length <= CONFIG.commanderSlots, `序列长度该在 1~5：${queue.length}`);
  // 排出来的东西必须真的能排进去（rules 会拦建筑和不存在的兵种）
  const r = applyAction(s, a);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.deepEqual(ordersOf(r.state, 'A'), queue);
  assert.ok(
    queue.filter((id) => id === ORDER_UPGRADE).length <= 1,
    '一格升级就要五个回合里少一个兵，序列里不该排两次',
  );
});

test('指挥官模式一回合只产一个兵，队首不会在一回合里被连着用', () => {
  // 这一条守的是"产能"：AI 一回合会反复问下一步，队首没变就可能连着造好几个。
  // 只按"队首是不是兵种"开关产兵是不够的，还得看这一回合造过没有。
  const s = commandPost();
  s.players.A.gold = 2000;
  const set = applyAction(s, { type: 'SET_ORDERS', queue: ['archer', 'militia', 'archer'] });
  assert.ok(set.ok);

  const budget = { ...DEFAULT_BUDGET }; // 和界面/跑批一样：一回合共享一份预算
  let cur = set.state;
  let recruited = 0;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur, budget);
    if (!a) break;
    if (a.type === 'RECRUIT') {
      recruited += 1;
      budget.recruited += 1;
    }
    if (a.type === 'UPGRADE') budget.upgraded += 1;
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
  assert.equal(recruited, 1, `一回合只该产 1 个兵，实际 ${recruited} 个`);
});

test('AI 排的序列会承接前面的产出，不是五格同一种兵', () => {
  // 投影里每排一格就把这个兵算进场，否则它会一直看到"我还没有远程"，五格全排某种兵
  const s = commandPost();
  const a = aiNextAction(s, DEFAULT_BUDGET);
  assert.ok(a && a.type === 'SET_ORDERS');
  const queue = (a as { type: 'SET_ORDERS'; queue: string[] }).queue;
  const kinds = new Set(queue.filter((id) => id !== ORDER_UPGRADE));
  assert.ok(kinds.size >= 2, `五格应该排出至少两种兵，实际：${queue.join(',')}`);
});

test('每一格都能指定由哪座城产兵，序列与产兵点逐格对齐', () => {
  const s = commandPost();
  const cities = citiesOf(s, 'A');
  assert.ok(cities.length >= 1, 'A 方至少该有一座城');
  const second = cities[1] ?? cities[0]!;
  const r = applyAction(s, {
    type: 'SET_ORDERS',
    queue: ['archer', 'militia', ''],
    sites: [second.id, '', ''],
  });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.deepEqual(ordersOf(r.state, 'A'), ['archer', 'militia']);
  assert.deepEqual(orderSitesOf(r.state, 'A'), [second.id, ''], '第二格不指定，就是空串');
});

test('指定的产兵点不存在、不是自己的、或者不是军营，都排不进去', () => {
  const s = commandPost();
  const enemyCity = citiesOf(s, 'B')[0]!;
  const bad = [
    { sites: ['no-such-city'], why: '不存在' },
    { sites: [enemyCity.id], why: '不是自己的城' },
    { sites: [s.units.find((u) => u.owner === 'A')!.id], why: '不是军营' },
  ];
  for (const b of bad) {
    const r = applyAction(s, { type: 'SET_ORDERS', queue: ['archer'], sites: b.sites });
    assert.equal(r.ok, false, `指定了${b.why}的产兵点，应当被拒`);
  }
});

test('空位上的产兵点会被抹成空串：那一格本来就不造东西', () => {
  const s = commandPost();
  const city = citiesOf(s, 'A')[0]!;
  const r = applyAction(s, {
    type: 'SET_ORDERS',
    queue: ['archer', '', 'militia'],
    sites: [city.id, city.id, ''],
  });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.deepEqual(orderSitesOf(r.state, 'A'), [city.id, '', ''], '中间那个洞不该留着产兵点');
});

test('回合末序列前移时，产兵点跟着一起前移（不能错位到前一格）', () => {
  const s = commandPost();
  const cities = citiesOf(s, 'A');
  const first = cities[0]!;
  const second = cities[1] ?? cities[0]!;
  const r = applyAction(s, {
    type: 'SET_ORDERS',
    queue: ['archer', 'militia'],
    sites: [first.id, second.id],
  });
  assert.ok(r.ok);
  const end = applyAction(r.state, { type: 'END_TURN' });
  assert.ok(end.ok);
  assert.deepEqual(ordersOf(end.state, 'A'), ['militia']);
  assert.deepEqual(orderSitesOf(end.state, 'A'), [second.id], '产兵点必须跟着它那一格走');
});

test('指定了产兵点，AI 就只从那一座出兵', () => {
  // 这里点名的是**最后一座城**：不指定产兵点时，几个候选的打分往往咬得很紧，
  // 平手时会落在列表最前面那一座。所以"最后一个"正好是"不指定时选不到的那一座"——
  // 只要它真出了兵，就只可能是那条指定在起作用。
  for (const seed of [12345, 777, 20261029, 4242]) {
    const s = commandPost(undefined, seed);
    const cities = citiesOf(s, 'A');
    assert.ok(cities.length >= 2, '这一条要两座城才成立');
    const want = cities[cities.length - 1]!;
    const set = applyAction(s, { type: 'SET_ORDERS', queue: ['archer'], sites: [want.id] });
    assert.ok(set.ok, set.ok ? '' : set.reason);
    let cur = set.state;
    let got: { cityId?: string; unitType?: string } | null = null;
    for (let i = 0; i < AI_MAX_STEPS; i++) {
      const a = aiNextAction(cur, DEFAULT_BUDGET);
      if (!a) break;
      if (a.type === 'RECRUIT') {
        got = a;
        break;
      }
      const r = applyAction(cur, a);
      if (!r.ok) break;
      cur = r.state;
    }
    assert.ok(got, `种子 ${seed}：钱够就该造出来`);
    assert.equal(got.cityId, want.id, `种子 ${seed}：指定了哪座城，兵就该从哪座城出来`);
    assert.equal(got.unitType, 'archer', '队首点名了弓手，就该造弓手');
  }
});

test('指定的那座城放不下新兵时，也不会从别的城偷偷出兵', () => {
  // 把点名的那座城的出兵格全站满。另一座城空着、什么都造得出来——
  // 但玩家要的是"兵从这座城出来"，出不来就是出不来。
  const s = commandPost();
  const cities = citiesOf(s, 'A');
  assert.ok(cities.length >= 2, '这一条要两座城才成立');
  const want = cities[0]!;
  for (const t of cityTiles(want)) {
    s.units.push({
      id: `fill-${t.x}-${t.y}`,
      type: 'militia',
      owner: 'A',
      x: t.x,
      y: t.y,
      hp: 100,
      kills: 0,
      moved: true,
      acted: true,
    });
  }
  const set = applyAction(s, { type: 'SET_ORDERS', queue: ['archer'], sites: [want.id] });
  assert.ok(set.ok, set.ok ? '' : set.reason);
  let cur = set.state;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur, DEFAULT_BUDGET);
    if (!a) break;
    assert.notEqual(a.type, 'RECRUIT', '点名的那座城站满了，就该空转，不能换一座城出');
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
});

test('指定了一座时代不够的城：这一格空转，不换座城凑数', () => {
  // 两座城一低一高，长矛兵只有高的那座造得出来。玩家点名了低的那座，
  // 正确的行为是**这一格空转**——而不是"反正另一座造得出来，就替你换了"。
  const s = commandPost();
  const cities = citiesOf(s, 'A');
  assert.ok(cities.length >= 2, '这一条要两座城才成立');
  const low = cities[0]!;
  const high = cities[1]!;
  low.era = 1;
  high.era = 3;

  /** 跑一整个回合，返回它造出来的那个兵（没造就是 null） */
  const runTurn = (siteId: string): string | null => {
    const set = applyAction(s, { type: 'SET_ORDERS', queue: ['spearman'], sites: [siteId] });
    assert.ok(set.ok, set.ok ? '' : set.reason);
    let cur = set.state;
    for (let i = 0; i < AI_MAX_STEPS; i++) {
      const a = aiNextAction(cur, DEFAULT_BUDGET);
      if (!a) break;
      if (a.type === 'RECRUIT') return a.unitType;
      const r = applyAction(cur, a);
      if (!r.ok) break;
      cur = r.state;
    }
    return null;
  };

  assert.equal(runTurn(low.id), null, '点名的那座城时代不够，就该空转，不能偷偷换一座城');
  assert.equal(runTurn(high.id), 'spearman', '换成够高级的那座城，同一个兵就该造得出来');
});

test('「升级时代」那一格也能指定升哪座城', () => {
  const s = commandPost();
  const cities = citiesOf(s, 'A');
  assert.ok(cities.length >= 2);
  const want = cities[1]!;
  const set = applyAction(s, { type: 'SET_ORDERS', queue: [ORDER_UPGRADE], sites: [want.id] });
  assert.ok(set.ok, set.ok ? '' : set.reason);
  let cur = set.state;
  let upgraded: string | null = null;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur, DEFAULT_BUDGET);
    if (!a) break;
    if (a.type === 'UPGRADE') {
      upgraded = a.cityId;
      break;
    }
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }
  assert.equal(upgraded, want.id, '指定了哪座城，就该升哪座城');
});

/* ------------------------------------------------------------------ */
/* 英雄：价格口径与"只能有一个"                                        */
/* ------------------------------------------------------------------ */

/** 带奇想·英雄包的一局，A 方行动，城市到第四代（英雄在第三代与第四代） */
function heroPost(extra?: Partial<MatchConfig>): GameState {
  const s = fresh({ startEra: 4, expansionIds: ['fantasy-core', 'fantasy-heroes'], ...extra });
  s.current = 'A';
  s.players.A.gold = 2000;
  return s;
}

test('英雄的价格口径：第一次含解锁费，解锁之后不再收', () => {
  const s = heroPost();
  const def = s.unitTypes['dwarf-king']!;
  const base = recruitCost(s, 'A', def);
  const fee = def.unlockCost ?? 0;
  assert.ok(fee > 0, '这一条要求英雄真有解锁费');

  const q = recruitPriceOf(s, 'A', def);
  assert.equal(q.price[GOLD], base, '兵价还是兵价');
  assert.equal(q.unlockFee, fee, '第一次要把解锁费算进来');
  assert.equal(q.gold, base + fee, '真正要付的是两者之和');

  // 金正好够：招完该是 0。以前界面按 base 估价，这一下会被规则层拒掉
  s.players.A.gold = base + fee;
  const city = citiesOf(s, 'A')[0]!;
  const r = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'dwarf-king' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.state.players.A.gold, 0, '金刚好够，招完就该一文不剩');

  const again = recruitPriceOf(r.state, 'A', def);
  assert.equal(again.unlockFee, 0, '解锁过了就不再收');
  assert.equal(again.gold, base, '之后只收兵价');
});

test('AI 在指挥官模式下也按含解锁费的价格判断买不买得起', () => {
  const s = heroPost({ commanderMode: true, aiAlly: true });
  const def = s.unitTypes['dwarf-king']!;
  const base = recruitCost(s, 'A', def);
  const fee = def.unlockCost ?? 0;

  // 只够兵价：AI 不该把这一格排成"造英雄"（它会白跑一趟）
  s.players.A.gold = base;
  s.orders = { A: ['dwarf-king'] };
  let cur = s;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur, DEFAULT_BUDGET);
    if (!a) break;
    assert.equal(a.type === 'RECRUIT', false, '钱不够解锁费，就不该提这个动作');
    const r = applyAction(cur, a);
    if (!r.ok) break;
    cur = r.state;
  }

  // 加上解锁费就够了
  const s2 = heroPost({ commanderMode: true, aiAlly: true });
  s2.players.A.gold = base + fee;
  s2.orders = { A: ['dwarf-king'] };
  let cur2 = s2;
  let got = false;
  for (let i = 0; i < AI_MAX_STEPS; i++) {
    const a = aiNextAction(cur2, DEFAULT_BUDGET);
    if (!a) break;
    if (a.type === 'RECRUIT' && a.unitType === 'dwarf-king') {
      got = true;
      break;
    }
    const r = applyAction(cur2, a);
    if (!r.ok) break;
    cur2 = r.state;
  }
  assert.ok(got, '钱够兵价 + 解锁费，英雄就该造得出来');
});

test('英雄的唯一性：蛋还没孵出来，也不能再造一只', () => {
  const s = heroPost();
  const def = s.unitTypes['phoenix']!;
  assert.ok(def.hero && def.era <= 4, '这一条要一个能造的不死鸟');
  const city = citiesOf(s, 'A')[0]!;
  // 先造一只，再让它"倒下"留下一枚蛋——规则层的唯一性检查必须把蛋也算进去
  const first = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'phoenix' });
  assert.ok(first.ok, first.ok ? '' : first.reason);
  const st = first.state;
  const phoenix = st.units.find((u) => u.owner === 'A' && u.type === 'phoenix')!;
  st.units = st.units.filter((u) => u.id !== phoenix.id);
  st.pendingEgg = {
    owner: 'A',
    type: 'phoenix',
    x: phoenix.x,
    y: phoenix.y,
    radius: 1,
    hpRatio: 0.5,
  };

  const again = applyAction(st, { type: 'RECRUIT', cityId: city.id, unitType: 'phoenix' });
  assert.equal(again.ok, false, '蛋还等着孵，不该能再造一只');
  assert.ok(
    !again.ok && again.reason.includes('蛋'),
    `理由该点明是那枚蛋：${!again.ok ? again.reason : ''}`,
  );
  // AI 那边也要先拦掉，否则它会每回合撞一次墙
  assert.ok(heroBlocked(st, 'A', def), 'AI 的候选人列表也该把它排除');
});

/* ------------------------------------------------------------------ */
/* 时代兵种包（大型模组）                                              */
/* ------------------------------------------------------------------ */

/**
 * 这几条守的是"设计约束"，不是"规则正确"：
 * 单位数据一旦被人手改坏（改错时代、抄重复 id、把古典贵兵塞进开局池），
 * 平衡报告会立刻失真，但游戏本身照样能跑——所以必须靠测试拦住。
 */
const packs = EXPANSIONS.filter((e) => e.id.startsWith('pack-'));

test('七个包都在，且各自的兵种数多于原版同期', () => {
  // 五个时代 + 第六代拆出来的两个：`pack-contemporary`（底座，开了才有第六时代）
  // 与 `pack-contemporary-war`（在底座上加料）。第六代在 config.ts 里是空的，
  // 所以那一代要两个包才凑成"原版一代 + 一代的兵种包"这个形状。
  assert.equal(packs.length, 7, '应有七个时代包（五个时代 + 第六代的底座与加料）');
  for (const e of packs) {
    const units = e.units ?? [];
    const eras = Array.from(new Set(units.map((u) => u.era)));
    assert.equal(eras.length, 1, `${e.id} 的兵种应属于同一个时代`);
    const era = eras[0] as number;
    const vanilla = Object.values(UNIT_TYPES).filter((d) => d.era === era).length;
    assert.ok(
      units.length > vanilla,
      `${e.id} 有 ${units.length} 个单位，应多于原版同期的 ${vanilla} 个`,
    );
  }
});

test('所有兵种 id 全局唯一（原版 + 全部扩展）', () => {
  const seen = new Map<string, string>();
  for (const id of Object.keys(UNIT_TYPES)) seen.set(id, '原版');
  for (const e of EXPANSIONS) {
    for (const u of e.units ?? []) {
      assert.ok(!seen.has(u.id), `兵种 id 重复：${u.id}（${seen.get(u.id)} 与 ${e.id}）`);
      seen.set(u.id, e.id);
    }
  }
});

test('时代包的兵种字段合法（能力存在、数值为正、建筑不能动）', () => {
  const abilityIds = new Set(allAbilities().map((a) => a.id));
  for (const e of packs) {
    for (const u of e.units ?? []) {
      assert.ok(u.name.length > 0 && u.short.length > 0, `${u.id} 缺名字或图标`);
      assert.ok(u.cost > 0, `${u.id} 造价必须为正`);
      assert.ok(u.maxHp > 0, `${u.id} 血量必须为正`);
      assert.ok(u.era >= 1 && u.era <= ERAS.length, `${u.id} 时代越界`);
      for (const a of u.abilities ?? []) {
        assert.ok(abilityIds.has(a), `${u.id} 用了不存在的能力：${a}`);
      }
      if (u.category === 'building') assert.equal(u.move, 0, `${u.id} 是建筑，move 应为 0`);
      if (u.category === 'combat') assert.ok(u.atk > 0, `${u.id} 是战斗单位，攻击应为正`);
    }
  }
});

test('古典包的 era 1 陆军战斗单位造价不超过 60（开局会被白送）', () => {
  const pack = EXPANSIONS.find((e) => e.id === 'pack-antiquity');
  assert.ok(pack, '古典包必须存在');
  for (const u of pack.units ?? []) {
    // 水军不进开局池（setup.ts 的 spawnPool 会把 domain=water 剔掉），所以不受这条约束
    if (u.era === 1 && u.category === 'combat' && u.domain !== 'water') {
      assert.ok(
        u.cost <= 60,
        `${u.name} 是 era 1 陆军战斗单位，造价 ${u.cost} 超过 60：开局部队按池子轮流白送且不看价钱，会直接抬高整局基准`,
      );
    }
  }
});

console.log('\n第六时代 · 现代');

/**
 * 「现代」做了一件别的包没做的事：它把**时代上限**往后推了一格。
 *
 * 所以这一组测的不是"数值好不好"，而是"那道闸是不是真的装了"：
 * 时代 6 在 ERAS 里，但没开「现代」时城市升不上去、按钮不出现、上帝模式也造不出；
 * 开了之后能升、能造兵，而且升到表底就停。
 *
 * 第六时代拆成两个包，和"原版给底座、扩展往上加料"的分法对齐：
 *   「现代」`pack-contemporary`     开时代 + 9 个最基本的兵
 *   「现代战争」`pack-contemporary-war` 在底座上加 15 个专精兵（requires 前者）
 * 所以这里也要分别验：上限只在底座那一处，光有加料包既抬不动时代、也造不出兵。
 */
test('只有「现代」能把时代上限抬到第六级，「现代战争」自己抬不动', () => {
  assert.equal(BASE_MAX_ERA, 5, '不勾任何扩展时，基础规则停在第五时代');
  assert.equal(eraCeilingFor([]), 5);
  assert.equal(eraCeilingFor(['pack-modern']), 5, '普通时代兵种包不该顺手抬高上限');
  assert.equal(eraCeilingFor(['pack-contemporary']), 6);
  // 加料包单独勾选不生效：前置没满足，整包被剔掉（see enabledExpansionIds）
  assert.equal(eraCeilingFor(['pack-contemporary-war']), 5, '只勾加料包，时代还是封在第五级');
  assert.equal(eraCeilingFor(['pack-contemporary', 'pack-contemporary-war']), 6);
  assert.equal(eraCeilingFor(['pack-modern', 'pack-contemporary']), 6);

  const base = expansionById('pack-contemporary');
  assert.ok(base, '「现代」必须注册在 EXPANSIONS 里');
  assert.equal(base.unlockEra, 6, '开关就是这一条字段');
  assert.equal(base.scale, 'large', '带一整套底座兵的包归大型，单独成册');
  assert.equal((base.units ?? []).length, 9, '底座就是这一代最基本的九个兵');

  const war = expansionById('pack-contemporary-war');
  assert.ok(war, '「现代战争」必须注册在 EXPANSIONS 里');
  assert.equal(war.scale, 'large', '带一整套兵的包归大型，单独成册');
  assert.ok(war.requires?.includes('pack-contemporary'), '加料包要挂在底座上');
  assert.equal(war.unlockEra, undefined, '时代开关只有一处，别写两份');
  assert.equal((war.units ?? []).length, 15, '加料包该有十五个专精兵');
  assert.ok((war.units ?? []).every((u) => u.era === 6), '这个包的兵全是第六代');
  assert.ok((base.units ?? []).every((u) => u.era === 6), '底座的兵也全是第六代');
  // 写超了也不许越过表长，否则 eraDef 会 clamp，升级成了"花一千金买同一座城"
  assert.equal(eraCeilingFor(['pack-contemporary']), ERAS.length, '上限永远夹在 ERAS.length 之内');
});

test('只开「现代」也能打完一整局：九个基本的兵一个不缺', () => {
  // 这条守的是"底座必须自洽"。用户要的就是"现代扩展也和前几个时代一样有
  // 几个最基本的兵"——那么只勾它、不勾「现代战争」，这一代也得是一个完整的代际：
  // 打得动（战斗兵）、养得起（经济）、盖得出（工程兵 + 建筑）、造得出兵（军营）。
  const base = expansionById('pack-contemporary');
  assert.ok(base);
  const units = base.units ?? [];
  const byCategory = (c: string) => units.filter((u) => u.category === c);
  const ids = new Set(units.map((u) => u.id));

  assert.equal(byCategory('combat').length, 4, '战斗兵：步兵班、坦克、榴弹炮、装甲侦察车');
  assert.equal(byCategory('economy').length, 1, '经济：物流中心');
  assert.equal(byCategory('builder').length, 1, '工程：工程兵');
  assert.equal(byCategory('building').length, 3, '建筑：混凝土碉堡、产业园、联合作战中心');

  // 军营要在：没有它，第六时代的兵只能靠开局白送（而 era 6 不会被白送）
  const camp = units.find((u) => u.barracks === true);
  assert.ok(camp, '底座得带一座军营，否则第六代兵根本造不出来');
  assert.equal(camp.id, 'camp6', '军营链条的第六档');

  // 工程兵要盖得出这一代的全部建筑，外加桥——少一样这一代就是残的
  const sapper = units.find((u) => u.category === 'builder');
  assert.ok(sapper?.builds);
  for (const id of ['ct_pillbox', 'ct_industrial', 'camp6']) {
    assert.ok(sapper.builds.includes(id), `工程兵该盖得出 ${id}`);
  }
  assert.ok(sapper.builds.includes('bridge3'), '第六代该盖得出最高一级的桥');

  // 加料包的兵不能混进底座：两个包各管各的，否则"只开底座"就不成立了
  for (const u of expansionById('pack-contemporary-war')?.units ?? []) {
    assert.ok(!ids.has(u.id), `${u.id} 不该同时出现在底座里`);
  }
});

test('不开「现代」：城市升到二战就封顶，拒绝理由要点出那个包', () => {
  const s = fresh({ startEra: 5, size: 12 }, 9901);
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.current = 'A';
  s.players.A.gold = 5000;
  assert.equal(city.era, 5);
  assert.equal(upgradeCostOf(s, city), null, '第五时代就是这一局的天花板');

  const r = applyAction(s, { type: 'UPGRADE', cityId: city.id });
  assert.equal(r.ok, false);
  // 只说"已经是最高时代"会让玩家以为游戏到此为止；要说清是哪一层没打开
  assert.ok(!r.ok && r.reason.includes('「现代」'), `理由要指出能打开它的是哪个包：${!r.ok ? r.reason : ''}`);
  assert.ok(!r.ok && r.reason.includes('二战'), '顺带把封顶在哪一代讲出来');
});

test('开了「现代」和「现代战争」：能升到第六时代，并且造得出第六代兵', () => {
  const ids = ['pack-contemporary', 'pack-contemporary-war', 'pack-modern'];
  // 先看第五时代的城能不能造六代兵：不能（招募门槛按城市时代判）
  const before = fresh({ startEra: 5, size: 12, expansionIds: ids }, 9902);
  const oldCity = citiesOf(before, 'A')[0];
  assert.ok(oldCity);
  before.current = 'A';
  before.players.A.gold = 5000;
  assert.equal(
    applyAction(before, { type: 'RECRUIT', cityId: oldCity.id, unitType: 'cnt_mbt' }).ok,
    false,
    '第五时代的城不该造得出第六代的主战坦克',
  );

  const s = fresh({ startEra: 5, size: 12, expansionIds: ids }, 9902);
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  s.current = 'A';
  s.players.A.gold = 5000;
  const cost = upgradeCostOf(s, city);
  assert.equal(cost, ERAS[5]?.upgradeCost, '第六时代的价取自表里那一行');
  const maxHpBefore = city.maxHp;
  const armorBefore = city.armor;

  const r = applyAction(s, { type: 'UPGRADE', cityId: city.id });
  assert.ok(r.ok, `应该能升到第六时代：${!r.ok ? r.reason : ''}`);
  const after = cityById(r.state, city.id);
  assert.ok(after);
  assert.equal(after.era, 6);
  // 增量而不是覆盖：扩展给城市加的耐久不能被升级抹掉（「要塞」就是这么加的）
  assert.equal(after.maxHp, maxHpBefore + (eraDef(6).cityMaxHp - eraDef(5).cityMaxHp));
  assert.equal(after.armor, armorBefore + (eraDef(6).cityArmor - eraDef(5).cityArmor));
  assert.equal(upgradeCostOf(r.state, after), null, '第六时代就是表底');

  const buy = applyAction(r.state, { type: 'RECRUIT', cityId: city.id, unitType: 'cnt_mbt' });
  assert.ok(buy.ok, `第六时代该造得出主战坦克：${!buy.ok ? buy.reason : ''}`);
});

test('上帝模式也造不出这一局升不到的城', () => {
  const s = fresh({ size: 12 }, 9903);
  // 找一块 2×2 的空平原（城要占满这四格的左上角）
  let spot: { x: number; y: number } | null = null;
  for (let y = 0; y + 1 < s.h && !spot; y++) {
    for (let x = 0; x + 1 < s.w && !spot; x++) {
      let free = true;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const t = s.tiles[idx(s, x + dx, y + dy)];
        if (!t || t.terrain !== 'plain' || t.cityId || s.units.some((u) => u.x === x + dx && u.y === y + dy)) {
          free = false;
          break;
        }
      }
      if (free) spot = { x, y };
    }
  }
  assert.ok(spot, '盘面上找不到 2×2 的空平原');
  const r = placeCity(s, 'A', spot.x, spot.y, 6);
  assert.ok(r.ok, `该能落城：${!r.ok ? r.reason : ''}`);
  const city = r.state.cities[r.state.cities.length - 1];
  assert.equal(city?.era, 5, '这一局的上限是五级，写 6 也只给到 5');
});

test('对空：防空导弹打飞机 ×1.6，打地面照旧', () => {
  // 飞行单位绕开一切地形，而地面近战**够不着头顶**（strikeDistance 给地面打空中 +1）。
  // 这是空中单位的卖点，但必须有个解法，否则就是"谁有飞机谁赢"。
  // 解法就是防空导弹：它只对飞行目标加成，对地面照旧。
  const ids = ['pack-contemporary', 'pack-contemporary-war', 'pack-modern'];
  const s = fresh({ startEra: 6, size: 12, expansionIds: ids }, 9904);
  s.units = [];
  for (const t of s.tiles) if (t.terrain !== 'city') t.terrain = 'plain';

  const sam = place(s, 'A', 'cnt_sam', 4, 4);
  // 血量抬到远超这一发的量级：这两条要量的是"打掉多少"，不是"能不能打死"，
  // 而反击会先把它打死（直升机 58 攻、坦克 78 攻，甲 4 的防空营吃不下一轮）
  sam.hp = 500;
  const heli = place(s, 'B', 'cnt_heli', 6, 4);
  // 直升机也得抬血：一发对空 68 点，正好超过它 66 的上限，
  // 打死了就量不到"打掉多少"——而这条要量的就是这个数
  heli.hp = 500;
  const heliHpBefore = heli.hp;
  const tank = place(s, 'B', 'cnt_mbt', 6, 5);
  s.current = 'A';
  refreshMemory(s);

  const samDef = s.unitTypes['cnt_sam'];
  const heliDef = s.unitTypes['cnt_heli'];
  const tankDef = s.unitTypes['cnt_mbt'];
  assert.ok(samDef && heliDef && tankDef);

  // 打飞机：46 × 1.6 ＝ 73.6 → 74，再减 6 点甲 ＝ 68。
  // 乘的是**攻击力**而不是"最终伤害"（能力挂在 damage 的 postRange 段，
  // 那一段在减护甲之前），所以重甲目标仍然能靠护甲吃掉一部分——
  // 这也是刻意的：对空是"打得更准"，不是"无视装甲"。
  const air = applyAction(s, { type: 'ATTACK', unitId: sam.id, targetId: heli.id });
  assert.ok(air.ok, `防空营该打得到直升机：${!air.ok ? air.reason : ''}`);
  const airDmg = heliHpBefore - (air.state.units.find((u) => u.id === heli.id)?.hp ?? 0);
  assert.equal(
    airDmg,
    Math.round(samDef.atk * 1.6) - heliDef.armor,
    `对空应有 1.6 倍（乘在攻击上）：实打 ${airDmg}`,
  );

  // 打地面：同样的 46 攻，一点加成都不给。
  // 先把这个兵的"已行动"擦掉——一个单位一回合只能开一次火。
  const sam2 = air.state.units.find((u) => u.id === sam.id);
  assert.ok(sam2);
  readyAgain(sam2);
  const ground = applyAction(air.state, { type: 'ATTACK', unitId: sam.id, targetId: tank.id });
  assert.ok(ground.ok, `防空营打地面也该打得动：${!ground.ok ? ground.reason : ''}`);
  const groundDmg = tankDef.maxHp - ground.state.units.find((u) => u.id === tank.id)!.hp;
  assert.equal(groundDmg, samDef.atk - tankDef.armor, `对地面没有加成：实打 ${groundDmg}`);
  assert.ok(airDmg > groundDmg, '对空必须比打同血同甲的地面目标更疼，否则这条能力等于没有');
});

test('地面近战够不着头顶的直升机', () => {
  // 防空能力之所以必须存在：巡 1 的步兵打不到贴着它飞的直升机（strikeDistance +1）。
  const ids = ['pack-contemporary', 'pack-contemporary-war'];
  const s = fresh({ startEra: 6, size: 12, expansionIds: ids }, 9905);
  s.units = [];
  for (const t of s.tiles) if (t.terrain !== 'city') t.terrain = 'plain';
  const heli = place(s, 'B', 'cnt_heli', 6, 4);
  const foot = place(s, 'A', 'militia', 6, 5);
  s.current = 'A';
  refreshMemory(s);
  const r = applyAction(s, { type: 'ATTACK', unitId: foot.id, targetId: heli.id });
  assert.equal(r.ok, false, '射程 1 的地面单位打不到空中目标');
});

console.log('\n编制 · 遣散');

/**
 * 编制上限已经撤出规则层。
 *
 * 以前招募时超过 CONFIG.maxUnits 会被直接拒掉。这条上限现在只留给 AI
 * （它没有"钱要花在别处"的自觉），玩家这边不该再被一条全局数字管着。
 */
test('规则层不再卡产兵数量，编制上限只留给 AI', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);

  // 先在场外堆出 maxUnits 个战斗单位，把"编制"占满
  const filler = s.units.find((u) => u.owner === 'A' && UNIT_TYPES[u.type]?.category !== 'building');
  assert.ok(filler);
  let seq = 0;
  let x = 0;
  while (armySize(s, 'A') < CONFIG.maxUnits) {
    // 找一块没人的空地摆一个填充兵
    let placed = false;
    for (; x < s.w * s.h; x++) {
      const px = x % s.w;
      const py = Math.floor(x / s.w);
      if (s.units.some((u) => u.x === px && u.y === py)) continue;
      const t = s.tiles[idx(s, px, py)];
      if (t.terrain !== 'plain' || t.cityId) continue;
      s.units.push({ ...structuredClone(filler), id: `fill${seq++}`, x: px, y: py });
      x += 1;
      placed = true;
      break;
    }
    assert.ok(placed, '盘面上找不到摆填充兵的空地');
  }

  const r = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' });
  assert.ok(r.ok, r.ok ? '' : `编制满了仍然应该能产兵：${r.reason}`);
  assert.equal(armySize(r.state, 'A'), CONFIG.maxUnits + 1, '应该真的多出来一个');
});

test('满血遣散返还四成，残血一个铜板都不返', () => {
  const s = fresh();
  const u = findUnit(s, 'A', 'militia');
  const def = UNIT_TYPES[u.type];
  const full = Math.round(recruitCost(s, u.owner, def) * CONFIG.disbandRefund);

  // 满血：按四成回收
  u.hp = def.maxHp;
  const goldBefore = s.players.A.gold;
  const r1 = applyAction(s, { type: 'DISBAND', unitId: u.id });
  assert.ok(r1.ok);
  assert.equal(r1.state.players.A.gold, goldBefore + full, '满血应该回收四成');
  assert.equal(r1.state.units.some((n) => n.id === u.id), false, '单位应该被移除');

  // 残血：一分不返。否则"打残了退回去还能换钱"，撤退就成了理财
  const s2 = fresh();
  const hurt = findUnit(s2, 'A', 'militia');
  hurt.hp = 1;
  const gold2 = s2.players.A.gold;
  const r2 = applyAction(s2, { type: 'DISBAND', unitId: hurt.id });
  assert.ok(r2.ok);
  assert.equal(r2.state.players.A.gold, gold2, '残血遣散不该返还金币');
  assert.equal(r2.state.units.some((n) => n.id === hurt.id), false, '照样要移除');
});

console.log('\nAI 用不用英雄技能');

/**
 * 搭一个"干净的试验台"：没有任何友军、敌军、城市，只留摆上去的那几个。
 *
 * 为什么要清空：AI 的候选分是相对排序的，场上多一个能打的敌人，
 * 攻击分就会盖过技能分，测试就变成在测"它先打谁"。这里要验的是
 * **技能本身会不会开**，所以把别的选项都拿掉。
 */
const NO_ECONOMY = { ...DEFAULT_BUDGET, maxRecruit: 0, maxUpgrade: 0 };

function arena(s: GameState): GameState {
  s.units = [];
  s.cities = [];
  for (const t of s.tiles) t.cityId = null;
  // 城里那四格原来是城，地形本身是平的；这里不用改地形，place2 不查地形
  return s;
}

test('贴脸的矮人王照样扔斧头：这一下是白送的，不是拿满伤去换', () => {
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  const king = place2(s, 'A', 'dwarf-king', 5, 5);
  const foe = place2(s, 'B', 'hydra', 6, 5); // 145 血，一刀砍不死，才看得见后续
  assert.equal(Math.abs(king.x - foe.x) + Math.abs(king.y - foe.y), 1, '这个用例要的是贴脸');
  s.current = 'A';

  const a = aiNextAction(s, NO_ECONOMY);
  assert.equal(a?.type, 'HERO_SKILL', '贴脸也该先扔一斧');
  assert.equal(a?.type === 'HERO_SKILL' ? a.skillId : '', 'throw-axe');

  const shot = applyAction(s, a!);
  assert.ok(shot.ok, shot.ok ? '' : shot.reason);
  const after = shot.state.units.find((u) => u.id === king.id)!;
  assert.equal(after.acted, false, '投斧不占本回合的攻击，扔完还能劈');
  assert.ok(foe.hp === 0 || shot.state.units.some((u) => u.id === foe.id), '目标还在');

  // 扔完那一下之后，AI 还会补一记正常的近战
  const next = aiNextAction(shot.state, NO_ECONOMY);
  assert.equal(next?.type, 'ATTACK', '斧头扔完要接着砍');
});

test('旁边只剩一个重伤的人，天使也会开「降临」', () => {
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  place2(s, 'A', 'angel', 5, 5);
  const mate = place2(s, 'A', 'militia', 5, 6);
  mate.hp = Math.round(s.unitTypes.militia!.maxHp * 0.25);
  s.current = 'A';

  const a = aiNextAction(s, NO_ECONOMY);
  assert.equal(a?.type, 'HERO_SKILL', '一个重伤的也该救');
  assert.equal(a?.type === 'HERO_SKILL' ? a.skillId : '', 'descend');
});

test('不死鸟倒下后，AI 会自己去孵蛋，孵出来的不会再复活', () => {
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  const ph = place2(s, 'A', 'phoenix', 5, 5);
  ph.hp = 3;
  const killer = place2(s, 'B', 'bone-dragon', 5, 4);
  s.current = 'B';

  const kill = applyAction(s, { type: 'ATTACK', unitId: killer.id, targetId: ph.id });
  assert.ok(kill.ok, kill.ok ? '' : kill.reason);
  assert.ok(kill.state.pendingEgg, '倒下时留下一枚蛋');
  assert.equal(
    kill.state.units.filter((u) => u.owner === 'A' && u.type === 'phoenix').length,
    0,
    '这一刻盘上确实没有不死鸟了——所以界面不能拿"盘上没兵"当打光',
  );

  const aTurn = { ...kill.state, current: 'A' as const };
  const a = aiNextAction(aTurn, NO_ECONOMY);
  assert.equal(a?.type, 'PLACE_EGG', '轮到主人时，第一件事就是孵蛋');

  const hatched = applyAction(aTurn, a!);
  assert.ok(hatched.ok, hatched.ok ? '' : hatched.reason);
  const born = hatched.state.units.find((u) => u.type === 'phoenix')!;
  assert.equal(born.reborn, true, '孵出来的标记为已复活，不能再复活一次');
  assert.equal(born.hp, Math.round(s.unitTypes.phoenix!.maxHp * 0.5), '孵化带一半生命');
});

console.log('\n上帝模式（沙盒）');

test('摆兵不要金币、不推进回合，摆上去就是满血能行动', () => {
  const s = fresh({ godMode: true });
  const gold = s.players.A.gold;
  const turn = s.turn;
  const before = s.units.length;
  const spot = emptyPlain(s);

  const r = placeUnit(s, 'A', 'militia', spot.x, spot.y);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const u = r.state.units.find((k) => k.x === spot.x && k.y === spot.y);
  assert.ok(u, '兵没摆上去');
  assert.equal(u.owner, 'A');
  assert.equal(u.hp, s.unitTypes.militia!.maxHp, '摆上去就该是满血');
  assert.equal(u.moved, false, '当回合就能动');
  assert.equal(u.acted, false, '当回合就能打');
  assert.equal(r.state.players.A.gold, gold, '一分钱都不该扣');
  assert.equal(r.state.turn, turn, '不该推进回合');
  assert.equal(r.state.units.length, before + 1);
  assert.equal(s.units.length, before, '原局面不能被就地改掉');
});

test('摆兵也认地形：步兵不能站水里，船不能停在旱地上', () => {
  const s = fresh({ godMode: true });
  const spot = emptyPlain(s);
  s.tiles[idx(s, spot.x, spot.y)].terrain = 'water';

  const army = placeUnit(s, 'A', 'militia', spot.x, spot.y);
  assert.equal(army.ok, false, '步兵不该能站在水面上');

  const boatId = Object.values(s.unitTypes).find((d) => d.domain === 'water')?.id;
  assert.ok(boatId, '基线配置里应该有水军');
  const boat = placeUnit(s, 'A', boatId!, spot.x, spot.y);
  assert.ok(boat.ok, boat.ok ? '' : boat.reason);

  const land = emptyPlain(s);
  const ashore = placeUnit(s, 'A', boatId!, land.x, land.y);
  assert.equal(ashore.ok, false, '船不该能停在旱地上');
});

test('不能把兵摆进对面的城', () => {
  const s = fresh({ godMode: true });
  const foeCity = s.cities.find((c) => c.owner === 'B');
  assert.ok(foeCity);
  // 城格上本来就不该有敌方单位（pinCities 清过了）
  const r = placeUnit(s, 'A', 'militia', foeCity!.x, foeCity!.y);
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.reason.includes('城'), '提示要说清是因为"这是对方的城"');
});

test('刷地形：能改能连着刷，城格和站着人的格改不了', () => {
  const s = fresh({ godMode: true });
  const spot = emptyPlain(s);

  const water = paintTerrain(s, spot.x, spot.y, 'water');
  assert.ok(water.ok, water.ok ? '' : water.reason);
  assert.equal(water.state.tiles[idx(water.state, spot.x, spot.y)]!.terrain, 'water');
  assert.equal(s.tiles[idx(s, spot.x, spot.y)]!.terrain, 'plain', '原局面不能被就地改掉');

  // 刷出来的水是真水：船能停，步兵不能
  const boatId = Object.values(s.unitTypes).find((d) => d.domain === 'water')?.id;
  assert.ok(boatId);
  assert.ok(placeUnit(water.state, 'A', boatId!, spot.x, spot.y).ok, '刷出来的水面该能停船');
  assert.equal(placeUnit(water.state, 'A', 'militia', spot.x, spot.y).ok, false, '水面上站不了步兵');

  // 山：真的挡路
  const rock = paintTerrain(s, spot.x, spot.y, 'mountain');
  assert.ok(rock.ok, rock.ok ? '' : rock.reason);
  assert.ok(!passable('mountain'), '高山不可通行');

  // 城格归城市管
  const city = s.cities[0]!;
  const onCity = paintTerrain(s, city.x, city.y, 'water');
  assert.equal(onCity.ok, false, '城格不许直接刷地形');
  assert.ok(onCity.ok === false && onCity.reason.includes('城'), '理由要说清是城格');

  // 站着东西的格：先擦再刷
  const occupied = placeUnit(s, 'A', 'militia', spot.x, spot.y);
  assert.ok(occupied.ok, occupied.ok ? '' : occupied.reason);
  const under = paintTerrain(occupied.state, spot.x, spot.y, 'water');
  assert.equal(under.ok, false, '脚下有人时不许把地挖成水');
  assert.ok(under.ok === false && under.reason.includes('擦掉'), '要告诉玩家先擦掉');

  // 已经是这个地形：不报"成功"，省得玩家以为改了点什么
  assert.equal(paintTerrain(s, spot.x, spot.y, 'plain').ok, false);
});

test('盖城占 2×2，耐久按时代给，擦掉之后那四格退回平原', () => {
  const s = fresh({ godMode: true });
  // 找一块干净的 2×2
  let spot: { x: number; y: number } | null = null;
  for (let y = 1; y < s.h - 3 && !spot; y++) {
    for (let x = 1; x < s.w - 3 && !spot; x++) {
      if (sandboxCityProblem(s, x, y) === null) spot = { x, y };
    }
  }
  assert.ok(spot, '地图上找不到能盖城的 2×2');

  const r = placeCity(s, 'A', spot!.x, spot!.y, 3);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const built = r.state;
  const city = built.cities[built.cities.length - 1]!;
  assert.equal(city.owner, 'A');
  assert.equal(city.era, 3, '时代按界面选的来');
  assert.equal(city.maxHp, eraDef(3).cityMaxHp, '耐久按时代给');
  const origin = spot!;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const under = built.tiles[idx(built, origin.x + dx, origin.y + dy)]!;
      assert.equal(under.terrain, 'city', '这四格要变成城');
      assert.equal(under.cityId, city.id);
    }
  }

  // 擦城：四格退回平原，别留一片不能站人的瓦砾
  const gone = removeAt(built, origin.x, origin.y);
  assert.ok(gone.ok, gone.ok ? '' : gone.reason);
  assert.equal(gone.state.cities.some((c) => c.id === city.id), false, '城应该没了');
  assert.equal(gone.state.tiles[idx(gone.state, spot!.x, spot!.y)]!.terrain, 'plain');
  assert.equal(gone.state.tiles[idx(gone.state, spot!.x, spot!.y)]!.cityId, null);
});

test('城底下站着单位时不给盖，擦掉单位就先擦单位', () => {
  const s = fresh({ godMode: true });
  // 先找一块本来能盖城的 2×2，再往它的左上角摆一个兵——
  // 这样"盖不了"只可能是因为那个兵
  let spot: { x: number; y: number } | null = null;
  for (let y = 1; y < s.h - 3 && !spot; y++) {
    for (let x = 1; x < s.w - 3 && !spot; x++) {
      if (sandboxCityProblem(s, x, y) === null) spot = { x, y };
    }
  }
  assert.ok(spot, '地图上找不到能盖城的 2×2');

  const placed = placeUnit(s, 'A', 'militia', spot!.x, spot!.y);
  assert.ok(placed.ok, placed.ok ? '' : placed.reason);
  const blocked = placeCity(placed.state, 'A', spot!.x, spot!.y, 1);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.ok === false && blocked.reason.includes('单位'), '要说清是被谁挡住的');

  // 橡皮：同一格先擦兵，兵没了再擦城
  const erased = removeAt(placed.state, spot!.x, spot!.y);
  assert.ok(erased.ok);
  assert.equal(
    erased.state.units.some((u) => u.x === spot!.x && u.y === spot!.y),
    false,
    '应该先把那个兵擦掉',
  );
});

test('撤走部队只撤兵，城留着当靶子', () => {
  const s = fresh({ godMode: true });
  const citiesBefore = s.cities.length;
  const r = clearUnits(s, 'A');
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(unitsOf(r.state, 'A').length, 0, '红方的兵要全没了');
  assert.ok(unitsOf(r.state, 'B').length > 0, '蓝方的不该受影响');
  assert.equal(r.state.cities.length, citiesBefore, '城不该跟着一起没');

  const again = clearUnits(r.state, 'A');
  assert.equal(again.ok, false, '本来就没兵了，要如实说');
});

test('上帝模式不按"没城"判负，正常对局照旧判', () => {
  const s = fresh({ godMode: true });
  const aCities = s.cities.filter((c) => c.owner === 'A');
  // 县官不如现管：先把站在自家城上的兵挪开，否则 removeAt 会先擦兵
  s.units = s.units.filter(
    (u) => !aCities.some((c) => u.x >= c.x && u.x < c.x + c.size && u.y >= c.y && u.y < c.y + c.size),
  );
  let cur = s;
  for (const c of aCities) {
    const r = removeAt(cur, c.x, c.y);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    cur = r.state;
  }
  assert.equal(citiesOf(cur, 'A').length, 0, '红方的城应该被擦光了');

  cur.current = 'A';
  const sandbox = applyAction(cur, { type: 'END_TURN' });
  assert.ok(sandbox.ok, sandbox.ok ? '' : sandbox.reason);
  assert.equal(sandbox.state.winner, null, '沙盒里没城不算输——不然第一回合就"赢了"');

  // 对照组：同一局面关掉上帝模式，老规则要照旧判 B 胜
  const plain = structuredClone(cur);
  delete plain.config.godMode;
  const normal = applyAction(plain, { type: 'END_TURN' });
  assert.ok(normal.ok, normal.ok ? '' : normal.reason);
  assert.equal(normal.state.winner, 'B', '正常对局里没城就是输，这条不能一起被改掉');
});

test('建筑按"建造"那套地形规则落地：桥能架在水上，军营不能', () => {
  const s = fresh({ godMode: true });
  const spot = emptyPlain(s);
  s.tiles[idx(s, spot.x, spot.y)].terrain = 'water';

  // 桥的 buildOn 是 ['water']。要是这里拿走位那套 canStandAt 去判，
  // 陆军不能站水里，结果就是沙盒里一座桥都架不起来。
  const bridge = placeUnit(s, 'A', 'bridge', spot.x, spot.y);
  assert.ok(bridge.ok, bridge.ok ? '' : bridge.reason);

  const camp = placeUnit(s, 'A', 'camp', spot.x, spot.y);
  assert.equal(camp.ok, false, '军营只能建在平地/丘陵上');
  assert.ok(camp.ok === false && camp.reason.includes('只能建在'), '提示要写清地形要求');
});

test('沙盒里两支军队会真的打起来，而且能打到一方全灭', () => {
  // 这条守的是这个模式的地基。沙盒里经常一座城都不摆，这时候 AI 找方向
  // 只剩一条路：视野里的敌军（见 ai.ts 的 advanceDistance）。雾一开，
  // 两支军队在空地上互相看不见，aiNextAction 直接返回 null——
  // 12 个兵两排站到天荒地老，玩家看到的是"点了没反应"。
  const s = createMatch({ ...BASE, size: 12, godMode: true }, 987654);
  assert.equal(s.fog, false, '上帝模式开局就该是关雾的');
  s.cities = [];
  s.units = [];
  s.players.A.gold = 0;
  s.players.B.gold = 0;

  // 一块干净的试验田：别让河把两军隔开（架桥要钱，沙盒里没有）
  for (let y = 2; y <= 9; y++) {
    for (let x = 1; x <= 10; x++) {
      const t = s.tiles[idx(s, x, y)];
      if (!t) continue;
      t.terrain = 'plain';
      t.cityId = null;
    }
  }

  const militia = s.unitTypes.militia!;
  const put = (owner: PlayerId, x: number, y: number) => {
    s.units.push({
      id: `g${s.nextUnitSeq++}`,
      type: 'militia',
      owner,
      x,
      y,
      hp: militia.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    });
  };
  for (let i = 0; i < 6; i++) {
    put('A', 2, 3 + i);
    put('B', 9, 3 + i);
  }

  const budget = { maxRecruit: 0, maxUpgrade: 0, recruited: 0, upgraded: 0 };
  let state = s;
  const combat = (p: PlayerId) =>
    unitsOf(state, p).filter((u) => utype(state, u.type).category === 'combat');

  let turns = 0;
  while (turns < 40 && combat('A').length > 0 && combat('B').length > 0) {
    for (let step = 0; step < AI_MAX_STEPS; step++) {
      const act = aiNextAction(state, budget);
      if (!act) break;
      const r = applyAction(state, act);
      if (!r.ok) break;
      state = r.state;
      if (combat('A').length === 0 || combat('B').length === 0) break;
    }
    const end = applyAction(state, { type: 'END_TURN' });
    assert.ok(end.ok, end.ok ? '' : end.reason);
    state = end.state;
    turns += 1;
  }

  assert.ok(
    combat('A').length === 0 || combat('B').length === 0,
    `40 回合还没分出胜负（A ${combat('A').length} 兵 / B ${combat('B').length} 兵），沙盒打不起来`,
  );
});

// ── 面板上的真实数值 / 移动产出预览 ──────────────────────────────────
//
// 这两组函数是"界面给人看的数字"的真相源：详情面板的攻击/护甲/移动、
// 经济单位移动预览里的每格产出，都必须和结算同源。所以它们在这里被
// 当成规则来测——面板错一个数，玩家对不上账，比没数字更糟。
console.log('\n面板上的真实数值');

/** 干燥的指定地形（四邻没有水，免得河运加成把期望值搅乱） */
function dryTiles(s: GameState, terrain: 'plain' | 'forest' | 'hill'): Array<{ x: number; y: number }> {
  const found: Array<{ x: number; y: number }> = [];
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let y = 1; y < s.h - 1; y++) {
    for (let x = 1; x < s.w - 1; x++) {
      const t = s.tiles[y * s.w + x]!;
      if (t.terrain !== terrain || t.cityId) continue;
      const wet = dirs.some(([dx, dy]) => {
        const n = s.tiles[(y + dy) * s.w + (x + dx)]!;
        return n.terrain === 'water' || n.terrain === 'bridge';
      });
      if (!wet) found.push({ x, y });
    }
  }
  return found;
}

test('unitIncomeAt：农民站平原收 7、站森林收 3，算完不挪动真身', () => {
  const s = fresh();
  clearDecor(s);
  const spots = dryTiles(s, 'plain');
  const plain = spots[0]!;
  const forest = spots[1]!;
  s.tiles[forest.y * s.w + forest.x]!.terrain = 'forest';
  const farmer = place2(s, 'A', 'farmer', plain.x, plain.y);

  assert.equal(unitIncomeAt(s, farmer, plain.x, plain.y), 7, '平原该收 7');
  assert.equal(unitIncomeAt(s, farmer, forest.x, forest.y), 3, '森林该收 3');
  assert.equal(farmer.x, plain.x, '预览不该把单位真的挪走');
  assert.equal(farmer.y, plain.y, '预览不该把单位真的挪走');
});

test('effectiveStats：老兵不死的击杀成长进了真实攻击力', () => {
  const s = arena(fresh({ expansionIds: ['veterans'] }));
  const u = place2(s, 'A', 'militia', 6, 6);
  const base = utype(s, 'militia').atk;
  u.kills = 3;
  const eff = effectiveStats(s, u);
  assert.equal(eff.atkBase, base);
  assert.equal(eff.atk, base + 3, '3 次击杀该是 +3 攻击');
  assert.ok(
    eff.atkItems.some((it) => it.label.includes('老兵不死') && it.delta === 3),
    '修正明细里要有老兵不死这一条',
  );
});

test('effectiveStats：指挥光环来自相邻友军，面板上单独列一条', () => {
  const s = arena(fresh({ expansionIds: ['pack-antiquity'] }));
  const mate = place2(s, 'A', 'militia', 6, 6);
  place2(s, 'A', 'anc_legionary', 7, 6);
  const eff = effectiveStats(s, mate);
  assert.equal(eff.atk, utype(s, 'militia').atk + 2);
  assert.ok(eff.atkItems.some((it) => it.label === '指挥光环' && it.delta === 2));
});

test('effectiveStats：哀兵必胜让先丢城的一方全军 +10%', () => {
  const s = arena(fresh({ expansionIds: ['last-stand'] }));
  const u = place2(s, 'A', 'militia', 6, 6);
  const base = utype(s, 'militia').atk;
  s.firstCityLost = 'A';
  const eff = effectiveStats(s, u);
  assert.equal(eff.atk, Math.round(base * 1.1));
  assert.ok(eff.atkItems.some((it) => it.label.includes('哀兵必胜')));
});

test('effectiveStats：堑壕战让林地多 2 甲，并用扩展名标注来源', () => {
  const s = arena(fresh({ expansionIds: ['trench'] }));
  const spot = { x: 6, y: 6 };
  s.tiles[spot.y * s.w + spot.x]!.terrain = 'forest';
  const u = place2(s, 'A', 'militia', spot.x, spot.y);
  const def = utype(s, 'militia');
  const eff = effectiveStats(s, u);
  assert.equal(eff.armor, def.armor + CONFIG.terrainDef.forest + 2);
  assert.ok(eff.armorItems.some((it) => it.label === '堑壕战' && it.delta === 2));
});

test('effectiveStats：狂暴是乘法，半血 ×1.5', () => {
  const s = arena(fresh());
  grantAbility(s, 'militia', 'berserk');
  const u = place2(s, 'A', 'militia', 6, 6);
  const def = utype(s, 'militia');
  u.hp = Math.floor(def.maxHp / 2);
  const eff = effectiveStats(s, u);
  assert.equal(eff.atk, Math.round(def.atk * 1.5));
  assert.ok(eff.atkItems.some((it) => it.label.includes('狂暴')));
});

// ── 新英雄：刺客大师 / 史莱姆牢大，以及至尊法师的加强 ──────────────────
console.log('\n新英雄与法师加强');

test('收割：刺客斩杀后拿回移动力，但不拿回攻击', () => {
  const s = arena(fresh({ expansionIds: FANTASY }));
  for (const [x, y] of [
    [5, 5],
    [5, 6],
  ]) {
    s.tiles[idx(s, x!, y!)]!.terrain = 'plain';
  }
  const ass = place2(s, 'A', 'assassin-master', 5, 5);
  const foe = place2(s, 'B', 'militia', 5, 6);
  foe.hp = 1;
  s.current = 'A';

  const r = applyAction(s, { type: 'ATTACK', unitId: ass.id, targetId: foe.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const after = r.state.units.find((u) => u.id === ass.id)!;
  assert.equal(after.moved, false, '斩杀之后本回合还能再走');
  assert.equal(after.acted, true, '攻击次数不还——不能一回合砍两个');
  assert.ok(reachableTiles(r.state, after).size > 0, '移动力是真的可用，不只是个标记');
});

test('隐匿：藏好之后看不见，贴身能发现，出手即现形', () => {
  // godMode 关掉胜负判定：arena 把城清空了，正常局会立刻判"一方没城"结束
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  s.fog = true;
  const ass = place2(s, 'A', 'assassin-master', 5, 5);
  const foe = place2(s, 'B', 'militia', 9, 5);
  s.current = 'A';
  assert.equal(isHiddenFrom(s, ass, 'B'), false, '没开技能前，开阔地上看得见');

  const r = applyAction(s, { type: 'HERO_SKILL', unitId: ass.id, skillId: 'vanish' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const hidden = r.state.units.find((u) => u.id === ass.id)!;
  assert.equal(isHiddenFrom(r.state, hidden, 'B'), true, '藏好之后看不见');

  // 贴身就能发现：隐匿不是无敌
  const enemy = r.state.units.find((u) => u.id === foe.id)!;
  enemy.x = 6;
  enemy.y = 5;
  assert.equal(isHiddenFrom(r.state, hidden, 'B'), false, '贴到相邻格就藏不住');

  const atk = applyAction(r.state, { type: 'ATTACK', unitId: hidden.id, targetId: enemy.id });
  assert.ok(atk.ok, atk.ok ? '' : atk.reason);
  const shown = atk.state.units.find((u) => u.id === ass.id)!;
  assert.notEqual(shown.heroBuff?.hidden, true, '动手之后隐匿失效');
});

test('裂殖：牢大裂成四只大史莱姆，生命按当前值分摊', () => {
  const s = arena(fresh({ expansionIds: FANTASY }));
  for (let y = 5; y <= 7; y++) {
    for (let x = 5; x <= 7; x++) s.tiles[idx(s, x, y)]!.terrain = 'plain';
  }
  const boss = place2(s, 'A', 'slime-boss', 6, 6);
  boss.hp = 160;
  s.current = 'A';

  const r = applyAction(s, { type: 'HERO_SKILL', unitId: boss.id, skillId: 'mitosis' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  assert.equal(r.state.units.some((u) => u.type === 'slime-boss'), false, '牢大消失了');
  const kids = r.state.units.filter((u) => u.type === 'slime-giant');
  assert.equal(kids.length, 4, '裂成四只');
  assert.equal(kids.reduce((n, k) => n + k.hp, 0), 160, '四只合计等于裂开前那一口血');
  for (const k of kids) assert.equal(k.acted, true, '裂出来的当回合不能行动');

  // 四邻没有四格空地时不给裂：宁可不开，也别裂出半套
  const s2 = arena(fresh({ expansionIds: FANTASY }));
  const boss2 = place2(s2, 'A', 'slime-boss', 6, 6);
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    place2(s2, 'A', 'militia', 6 + dx!, 6 + dy!);
  }
  s2.current = 'A';
  const bad = applyAction(s2, { type: 'HERO_SKILL', unitId: boss2.id, skillId: 'mitosis' });
  assert.equal(bad.ok, false, '周围占满时不该裂得出来');
});

test('聚合：两只大史莱姆合回牢大，生命相加且当回合不能动', () => {
  // 只有一只时合不起来：否则"裂开"就变成回血技能了
  const s0 = arena(fresh({ expansionIds: FANTASY }));
  const solo = place2(s0, 'A', 'slime-giant', 5, 5);
  s0.current = 'A';
  assert.equal(
    applyAction(s0, { type: 'HERO_SKILL', unitId: solo.id, skillId: 'fuse' }).ok,
    false,
    '一只大史莱姆合不成牢大',
  );

  const s = arena(fresh({ expansionIds: FANTASY }));
  const a = place2(s, 'A', 'slime-giant', 5, 5);
  const b = place2(s, 'A', 'slime-giant', 7, 5);
  a.hp = 30;
  b.hp = 40;
  s.current = 'A';

  const r = applyAction(s, { type: 'HERO_SKILL', unitId: a.id, skillId: 'fuse' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const boss = r.state.units.find((u) => u.type === 'slime-boss');
  assert.ok(boss, '合体应该产出一只牢大');
  assert.equal(boss!.hp, 70, '生命相加');
  assert.equal(boss!.moved, true, '合体后当回合不能行动');
  assert.equal(r.state.units.filter((u) => u.type === 'slime-giant').length, 0, '碎片全被合并');
});

test('周围没有敌军时，牢大不会自己裂了又合（沙盒空转）', () => {
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  for (let y = 5; y <= 7; y++) {
    for (let x = 5; x <= 7; x++) s.tiles[idx(s, x, y)]!.terrain = 'plain';
  }
  const boss = place2(s, 'A', 'slime-boss', 6, 6);
  boss.hp = 100; // 残血：按老逻辑这正是"该裂"的时候
  s.current = 'A';

  const quiet = aiNextAction(s, NO_RECRUIT);
  assert.ok(
    !(quiet?.type === 'HERO_SKILL' && quiet.skillId === 'mitosis'),
    '场上一个敌人都没有，不该裂殖（裂完还会被聚合合回去，纯空转）',
  );

  // 敌军走近（射程外，所以只能靠技能/走位）：残血牢大该裂开来分摊伤害
  place2(s, 'B', 'militia', 9, 6);
  s.current = 'A';
  const loud = aiNextAction(s, NO_RECRUIT);
  assert.equal(loud?.type, 'HERO_SKILL', '有敌人时该动技能');
  assert.equal(loud?.type === 'HERO_SKILL' ? loud.skillId : '', 'mitosis');
});

test('至尊法师加强：攻 0 / 护甲 10 / 射程 6 / 视野 9 / 魔攻 36，同属性伤害减半', () => {
  const holder = fresh({ expansionIds: FANTASY });
  const def = holder.unitTypes.archmage!;
  // 一处口径：物理归零、伤害全在魔法段（36 点只被魔抗挡），
  // 甲/魔抗/射程/视野各 +4/+4/+1/+1，价 +50、解锁 +50。
  assert.equal(def.atk, 0, '攻击 10 → 0（伤害全走魔法段）');
  assert.equal(def.magicAtk, 36, '魔攻 26 → 36');
  assert.equal(def.armor, 10, '护甲 6 → 10');
  assert.equal(def.magicRes, 14, '魔抗 10 → 14');
  assert.equal(def.range, 6, '射程 5 → 6');
  assert.equal(def.vision, 9, '视野 8 → 9');
  assert.equal(def.cost, 640, '价格 590 → 640');
  assert.equal(def.unlockCost, 350, '解锁 300 → 350');

  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  const mage = place2(s, 'A', 'archmage', 6, 6);
  const fireAtk = place2(s, 'B', 'archmage', 6, 5);
  fireAtk.element = 'fire';

  mage.element = 'fire';
  const same = computeDamage(s, fireAtk, mage);
  mage.element = 'water';
  const other = computeDamage(s, fireAtk, mage);
  assert.ok(other > same, `换个属性打就该更疼：同属性 ${same}，异属性 ${other}`);
  assert.equal(same, Math.round(other * 0.5), '同属性只吃一半');
});

test('新英雄数值微调：刺客视野 7、牢大 3/4/2、大史莱姆甲 2', () => {
  const defs = fresh({ expansionIds: FANTASY }).unitTypes;
  assert.equal(defs['assassin-master']!.vision, 7, '刺客大师视野 5 → 7');
  assert.equal(defs['slime-boss']!.armor, 3, '牢大甲 2 → 3');
  assert.equal(defs['slime-boss']!.vision, 4, '牢大视野 3 → 4');
  assert.equal(defs['slime-boss']!.range, 2, '牢大射程 1 → 2');
  assert.equal(defs['slime-giant']!.armor, 2, '大史莱姆甲 1 → 2');
});

test('地面打空中按距离 +1，空中打地面照常', () => {
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  const bird = place2(s, 'A', 'phoenix', 6, 6); // 掠空单位
  const foot = place2(s, 'B', 'militia', 6, 7); // 射程 1

  assert.equal(strikeDistance(s, foot, bird), 2, '地面打空中：1 → 2');
  assert.equal(strikeDistance(s, bird, foot), 1, '空中打地面不额外加距离');
  assert.equal(canStrike(s, foot, bird), false, '射程 1 的步兵够不着隔壁那格的飞行单位');
  assert.equal(canStrike(s, bird, foot), true, '飞行单位打地面照常');

  // 射程 2 的戟兵：隔壁算 2，刚好够得着；隔一格算 3，够不着
  const hal = place2(s, 'B', 'halberdier', 5, 6);
  assert.equal(canStrike(s, hal, bird), true, '射程 2 够得着隔壁的飞行单位（1+1=2）');
  const halFar = place2(s, 'B', 'halberdier', 6, 8);
  assert.equal(canStrike(s, halFar, bird), false, '隔一格就打不到了（2+1=3 > 2）');

  // 牢大射程 2，这次加强正好让它能还手飞行单位
  const boss = place2(s, 'B', 'slime-boss', 5, 6);
  assert.equal(canStrike(s, boss, bird), true, '射程 2 的牢大能打飞行单位');
});

test('地面单位打不到空中，也就换不了手', () => {
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  const bird = place2(s, 'A', 'phoenix', 6, 6);
  // 树人够硬，挨一下不死，才看得清"没有反击"这件事
  const tank = place2(s, 'B', 'treant', 6, 7);
  s.current = 'A';

  const r = applyAction(s, { type: 'ATTACK', unitId: bird.id, targetId: tank.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const after = r.state.units.find((u) => u.id === bird.id)!;
  assert.equal(after.hp, s.unitTypes.phoenix!.maxHp, '脚下的树人够不着空中的凤凰，不该有反击');
  const hurt = r.state.units.find((u) => u.id === tank.id);
  assert.ok(hurt, '树人应该还活着');
  assert.ok(hurt!.hp < s.unitTypes.treant!.maxHp, '但凤凰这一下照样打实了');
});

test('压着打仍然互相能还手：同格距离按 0+1=1 算', () => {
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  const bird = place2(s, 'A', 'phoenix', 6, 6);
  // 地面单位站在同一格（掠空层和地面层可以叠）
  const foot = stackOn(s, 'B', 'swordsman', 6, 6);
  assert.equal(strikeDistance(s, foot, bird), 1, '同格是 0+1');
  assert.equal(canStrike(s, foot, bird), true, '射程 1 也能打头顶那个');
});


// ─────────────────────────────────────────────────────────────────────────────
// 原版预留的两条接口：飞行层、多资源
//
// 这两条不是某个兵种包的私货，而是**规则骨架**：占不占格、吃不吃粮，
// 会渗进寻路、产兵位、造价判断。所以它们必须能在不勾任何扩展的前提下被测试。
// ─────────────────────────────────────────────────────────────────────────────

/** 临时往本局兵种表里塞一个测试兵：接口测试不该依赖任何一个兵种包 */
function testType(s: GameState, id: string, extra: Partial<UnitTypeDef>): UnitTypeDef {
  const def = {
    id,
    name: id,
    short: '测',
    era: 1,
    category: 'combat',
    cost: 40,
    move: 2,
    atk: 10,
    armor: 2,
    maxHp: 30,
    range: 1,
    vision: 3,
    ...extra,
  } as UnitTypeDef;
  s.unitTypes[id] = def;
  return def;
}

test('飞行层是类型字段：air 能和地面同格，flight 能停在水上', () => {
  const s = arena(fresh({ godMode: true }));
  testType(s, 'test-hawk', { layer: 'air', flight: true });
  testType(s, 'test-gull', { flight: true });

  // 找一格水：飞行单位应当能"栖息"在水面上，而不是只能绕过去
  const wi = s.tiles.findIndex((t) => t.terrain === 'water');
  assert.ok(wi >= 0, '这张测试图上应该有水');
  const wx = wi % s.w;
  const wy = Math.floor(wi / s.w);
  assert.equal(canStandAt(s, wx, wy, 'test-gull'), true, '飞行单位能停在水上');
  assert.equal(canStandAt(s, wx, wy, 'militia'), false, '陆军还是进不了水');

  const hawk = place2(s, 'A', 'test-hawk', 6, 6);
  stackOn(s, 'B', 'militia', 6, 6);
  assert.equal(isAirborne(s, hawk), true, 'layer: air 就是空中层');
  assert.ok(
    s.units.some((u) => u.type === 'militia' && u.x === 6 && u.y === 6),
    '地面单位可以和空中单位叠在同一格',
  );
  assert.equal(canStandAt(s, 6, 6, 'militia'), false, '但地面层自己不能再叠一个');
});

test('多资源：活人吃粮、建筑耗材，缺粮就造不出来', () => {
  const s = fresh({ expansionIds: ['city-works'] });
  const militia = s.unitTypes.militia!;
  const cost = recruitResCost(s, 'A', militia);
  assert.ok((cost.gold ?? 0) > 0, '金币还是要的');
  assert.ok((cost.gold ?? 0) < militia.cost, `金币只占一部分：${JSON.stringify(cost)}`);
  assert.ok((cost.food ?? 0) > 0, '活人要吃粮');

  const towerCost = recruitResCost(s, 'A', s.unitTypes.tower!);
  assert.ok((towerCost.material ?? 0) > 0, '建筑要建材');
  assert.equal(towerCost.food ?? 0, 0, '建筑不吃粮');

  // 粮/材必须是主成本，金币只是零头。
  // 上一版是金币六成、粮材四成，实战里金币直接见底——因为经济单位的
  // 金币产出有六成被转成了粮/材，收入结构和支出结构反着来。
  for (const [name, c] of [['民兵', cost], ['箭塔', towerCost]] as const) {
    const res = (c.food ?? 0) + (c.material ?? 0);
    const gold = c.gold ?? 0;
    assert.ok(res > gold, `${name}：粮/材应该比金币贵，实际 金 ${gold} / 粮材 ${res}`);
    const ratio = res / (res + gold);
    assert.ok(ratio > 0.6, `${name}：粮/材占比应该超过六成，实际 ${(ratio * 100).toFixed(0)}%`);
  }

  // 钱够、粮不够：造不出来，而且理由要点名缺的是粮不是钱
  s.players.A.gold = 5000;
  s.players.A.res = { food: 0, material: 0 };
  const city = citiesOf(s, 'A')[0]!;
  const r = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' });
  assert.equal(r.ok, false, '没粮就该失败');
  assert.match((r as { reason: string }).reason, /粮食/, '失败原因要说清缺什么');
});

test('经济单位按脚下地形出货：平地打粮、林地出材', () => {
  const s = fresh({ expansionIds: ['city-works'] });
  const farmer = place2(s, 'A', 'farmer', 5, 5);
  const plain = unitYield(s, farmer);
  assert.ok((plain.food ?? 0) > 0, '平原上种出来的是粮');
  assert.equal(plain.material ?? 0, 0, '平原不出建材');
  assert.ok((plain.gold ?? 0) < (s.unitTypes.farmer!.incomeByTerrain?.plain ?? 0), '金币被拆走一部分');

  // 同一支农民挪到林子里：产出换成了建材
  s.tiles[farmer.y * s.w + farmer.x]!.terrain = 'forest';
  const wood = unitYield(s, farmer);
  assert.ok((wood.material ?? 0) > 0, '林子里的产出是建材');
  assert.equal(wood.food ?? 0, 0, '林子不产粮');
});

test('城郭与物料：主城 3×3，经济建筑更值钱但不再当墙', () => {
  const s = fresh({ expansionIds: ['city-works'] });
  const city = citiesOf(s, 'A')[0]!;
  assert.equal(city.size, 3, '主城边长 3');
  assert.equal(cityTiles(city).length, 9, '3×3 就是九格');
  assert.equal(city.maxHp, Math.round(eraDef(1).cityMaxHp * 1.5), '主城血量提高一半');

  const mill = s.unitTypes.mill!;
  assert.equal(mill.atk, 0, '经济建筑不还手');
  assert.equal(
    mill.incomeByTerrain?.plain,
    Math.round((UNIT_TYPES.mill!.incomeByTerrain?.plain ?? 0) * 1.2),
    '经济建筑收益 +20%',
  );
  assert.equal(mill.armor, UNIT_TYPES.mill!.armor - 1, '经济建筑护甲 −1');
  assert.equal(
    mill.maxHp,
    Math.round(UNIT_TYPES.mill!.maxHp * 1.1),
    '经济建筑耐久只加一成（普通建筑是 1.35）——它不该顺手变成一堵墙',
  );

  // 普通建筑照旧 +35%：这条规则不能把所有建筑一起拖下水
  assert.equal(
    s.unitTypes.bridge!.maxHp,
    Math.round(UNIT_TYPES.bridge!.maxHp * 1.35),
    '非经济建筑还是原来的耐久',
  );

  // 隘口的真实尺度：粮仓挡得住追兵，挡不住一支有备而来的部队。
  // 二代骑士（攻 17）拆它必须落在四下以内——以前是五下。
  const granary = s.unitTypes.granary!;
  const hits = Math.ceil(granary.maxHp / Math.max(1, s.unitTypes.knight!.atk - granary.armor));
  assert.ok(hits <= 4, `骑士拆粮仓要 ${hits} 下，应该不超过 4 下`);
});

test('经济建筑：造价降下来，回本压到四五个回合', () => {
  const s = fresh({ expansionIds: ['city-works'] });

  // 粮仓：55 的六成 = 33 粮，一分金币都不要（"起步靠粮"那一段）
  const granary = s.unitTypes.granary!;
  const gc = recruitResCost(s, 'A', granary);
  assert.equal(gc.gold ?? 0, 0, '前期经济建筑不收金币');
  assert.equal(gc.food, 33, '粮仓只花 33 粮');
  const gPayback = gc.food / (granary.yield?.food ?? 1);
  assert.ok(gPayback <= 4, `粮仓回本要 ${gPayback.toFixed(1)} 回合，应该 ≤ 4`);

  // 采石场：产什么就吃什么——它吃建材，不吃粮
  const qc = recruitResCost(s, 'A', s.unitTypes.quarry!);
  assert.equal(qc.gold ?? 0, 0, '前期经济建筑不收金币');
  assert.equal(qc.food ?? 0, 0, '采石场是建材建筑，不该吃粮');
  assert.equal(qc.material, 54, '采石场 90 的六成 = 54 材');
  assert.ok(54 / (s.unitTypes.quarry!.yield?.material ?? 1) <= 4.5, '采石场回本 ≤ 4.5 回合');

  // 后期经济建筑仍要金币，但只有两成（普通兵是三成）
  const brick = s.unitTypes.brickworks!;
  const bc = recruitResCost(s, 'A', brick);
  assert.equal(bc.gold, Math.round(brick.cost * 0.2), '后期经济建筑金币占两成');
  assert.equal(bc.material, Math.round(brick.cost * 0.55), '建材占五成半');
  assert.ok(bc.material / (brick.yield?.material ?? 1) <= 5, '砖窑回本 ≤ 5 回合');

  // 降价只给经济建筑：普通兵的金币/资源结构一个字没动
  const militia = recruitResCost(s, 'A', s.unitTypes.militia!);
  assert.equal(militia.gold, Math.round(s.unitTypes.militia!.cost * 0.3), '普通兵还是三成金币');
});

test('建材产线：伐木工之后每一代都有人接，产出逐代往上走', () => {
  const s = fresh({ expansionIds: ['city-works'] });
  const chain = [
    ['lumberjack', 2, 'forest'],
    ['quarrier', 3, 'hill'],
    ['minecrew', 4, 'hill'],
    ['materials', 5, 'hill'],
  ] as const;

  let prev = 0;
  for (const [id, era, terrain] of chain) {
    const def = s.unitTypes[id];
    assert.ok(def, `城郭包应该带来 ${id}`);
    assert.equal(def.era, era, `${id} 属于时代 ${era}`);
    assert.equal(def.category, 'economy', `${id} 是经济单位`);

    const u = place2(s, 'A', id, 5, 5);
    s.tiles[u.y * s.w + u.x]!.terrain = terrain;
    const material = unitYield(s, u).material ?? 0;
    assert.ok(material > prev, `${id} 的建材产出 ${material} 应该高于上一代 ${prev}`);
    prev = material;
  }
  // 时代 5 单支建材兵得顶得上半座建材基地，否则"换人"这件事没有意义
  assert.ok(prev >= 24, `时代 5 的建材兵该有 24 材以上，实际 ${prev}`);
});

test('建材建筑按代分工兵：工程师只有砖窑，建筑队三样全会', () => {
  const s = fresh({ expansionIds: ['city-works'] });
  const builds = (id: string) => s.unitTypes[id]?.builds ?? [];

  assert.ok(builds('engineer').includes('brickworks'), '工程师起手就是砖窑');
  assert.equal(builds('engineer').includes('cementworks'), false, '水泥厂是工业时代的东西');
  assert.ok(builds('foreman').includes('cementworks'), '厂长会盖水泥厂');
  assert.equal(builds('foreman').includes('materialbase'), false, '建材基地要现代建筑队');
  for (const id of ['brickworks', 'cementworks', 'materialbase']) {
    assert.ok(builds('crew').includes(id), `建筑队应该会盖 ${id}`);
  }

  // 产出阶梯：采石场 13 → 砖窑 24 → 水泥厂 40 → 建材基地 58
  const step = ['quarry', 'brickworks', 'cementworks', 'materialbase'].map(
    (id) => s.unitTypes[id]!.yield?.material ?? 0,
  );
  for (let i = 1; i < step.length; i++) {
    assert.ok(step[i]! > step[i - 1]!, `建材产出应该逐级上升：${step.join(' → ')}`);
  }
  assert.ok(step[3]! >= 58, `建材基地该有 58 材/回合，实际 ${step[3]}`);

  // 高级建材建筑的卖点不是"每材更划算"，是"同样几格地里挤得更多"：
  // 回本控制在 5 个回合出头，比采石场慢一点，但上限高一个量级。
  // 另外它们都只吃建材——不要跟粮食抢同一笔钱。
  for (const id of ['brickworks', 'cementworks', 'materialbase']) {
    const c = recruitResCost(s, 'A', s.unitTypes[id]!);
    assert.equal(c.food ?? 0, 0, `${id} 不吃粮`);
    assert.ok((c.material ?? 0) > 0, `${id} 要建材`);
    const total = (c.gold ?? 0) + (c.material ?? 0);
    const payback = total / (s.unitTypes[id]!.yield?.material ?? 1);
    assert.ok(payback <= 5.2, `${id} 回本 ${payback.toFixed(1)} 回合，应该 ≤ 5.2`);
  }
});

test('箭塔：两回合施工，工地开不了火', () => {
  const s = fresh({ expansionIds: ['city-works'], godMode: true });
  const tower = s.unitTypes.tower!;
  const laborerPower = buildPowerOf(s.unitTypes.laborer!);
  assert.ok(
    buildCostOf(tower) > laborerPower,
    `塔一回合修不完：${buildCostOf(tower)} 点 vs 劳工 ${laborerPower} 点`,
  );
  assert.equal(tower.garrison, true, '塔可以驻军');

  const laborer = place2(s, 'A', 'laborer', 7, 7);
  // 清出一块确定的平地：测试不该赌生成器给出的地形
  s.tiles[7 * s.w + 8]!.terrain = 'plain';
  s.players.A.gold = 5000;
  s.players.A.res = { food: 999, material: 999 };
  const built = applyAction(s, {
    type: 'BUILD',
    unitId: laborer.id,
    unitType: 'tower',
    x: 8,
    y: 7,
  });
  assert.ok(built.ok, built.ok ? '' : built.reason);
  let st = built.state;
  const site = st.units.find((u) => u.type === 'tower')!;
  assert.equal(underConstruction(site), true, '刚盖好的是工地');

  // 工地不能主动开火：这一下该被拒绝
  const foe = place2(st, 'B', 'militia', 9, 7);
  const shot = applyAction(st, { type: 'ATTACK', unitId: site.id, targetId: foe.id });
  assert.equal(shot.ok, false, '工地还没装好武器');

  // 两个自己的回合之后成型（每次 END_TURN 推进的是"接手那一方"的工地）
  st = built.state;
  for (let i = 0; i < 4; i++) {
    const r = applyAction(st, { type: 'END_TURN' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    st = r.state;
  }
  const done = st.units.find((u) => u.type === 'tower');
  assert.ok(done, '塔还在');
  assert.equal(underConstruction(done!), false, '两回合之后建成了');
});

test('驻军：站在自家可驻军建筑上多挡几点伤害', () => {
  const s = arena(fresh({ expansionIds: ['city-works'], godMode: true }));
  place2(s, 'A', 'tower', 6, 6);
  const guard = stackOn(s, 'A', 'militia', 6, 6);
  const bare = place2(s, 'A', 'militia', 7, 6);
  const foe = place2(s, 'B', 'militia', 5, 6);
  const withGarrison = computeDamage(s, foe, guard);
  const without = computeDamage(s, foe, bare);
  assert.equal(without - withGarrison, CONFIG.garrisonArmor, '驻军多挡一份护甲');
});

test('后期经济与工程兵种拿到了攻击和血量', () => {
  const s = fresh({ expansionIds: ['city-works'] });
  assert.equal(s.unitTypes.planter!.atk, UNIT_TYPES.planter!.atk + 3);
  assert.equal(s.unitTypes.planter!.maxHp, UNIT_TYPES.planter!.maxHp + 6);
  assert.equal(s.unitTypes.crew!.armor, UNIT_TYPES.crew!.armor + 1, '现代工程兵再硬一点');
  assert.equal(s.unitTypes.farmer!.atk, UNIT_TYPES.farmer!.atk, '前期兵不动：改的是"后期自保"');
});

test('多资源收入：incomeResOf 和真实结算同源', () => {
  const s = fresh({ expansionIds: ['city-works'] });
  place2(s, 'A', 'farmer', 5, 5);
  const expect = incomeResOf(s, 'A');
  assert.ok((expect.gold ?? 0) > 0, '金币还有收入');
  assert.ok((expect.food ?? 0) > 0, '粮食也有收入');

  const before = { ...(s.players.A.res ?? {}) };
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  // 结算给的是"接手那一方"，所以这里要把 A 的收入单独再算一遍对比
  const gainFood = (s.players.A.res?.food ?? 0) - (before.food ?? 0);
  assert.ok(gainFood >= 0, '结束回合不会让资源倒退');
  assert.ok((expect.food ?? 0) > 0, '估算与结算读的是同一套产出');
});

test('AI 不会对着施工现场开炮，开了城郭的整局也走得下去', () => {
  // 这条守的是一个真实事故：塔要施工两回合，规则层拒绝工地开火，
  // 但 AI 的候选列表照样生成 ATTACK。执行方遇到非法动作会中断整回合，
  // 于是双 AI 对局在第 20 回合死在一个永远失败的"箭塔开炮"上。
  // 所以要测的不是"某个动作对不对"，而是"连续几百步里没有一步被拒"。
  let sawSite = false;
  const runs: Array<{ ids: string[]; seed: number }> = [
    { ids: ['city-works'], seed: 424242 },
    { ids: ['city-works'], seed: 777 },
    { ids: ['city-works'], seed: 20260726 },
    // 扩展全开是另一条路：迷雾里看不见的敌人会挡路、空废墟要重建费，
    // 这两个坑都只在"扩展拉满、单位很密"的局面里才浮出来。
    { ids: EXPANSIONS.map((e) => e.id), seed: 20260726 },
  ];
  for (const { ids, seed } of runs) {
    let state = createMatch(
      {
        ...BASE,
        size: 12,
        startEra: 3,
        aiOpponent: true,
        aiAlly: true,
        expansionIds: ids,
      },
      seed,
    );
    const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
    let turns = 0;
    while (turns < 18 && !state.winner) {
      const act = aiNextAction(state, budget);
      if (!act) {
        const end = applyAction(state, { type: 'END_TURN' });
        assert.ok(end.ok, end.ok ? '' : end.reason);
        state = end.state;
        turns += 1;
        budget.recruited = 0;
        budget.upgraded = 0;
        continue;
      }
      const r = applyAction(state, act);
      assert.ok(r.ok, `种子 ${seed} 第 ${turns} 回合 AI 提出了非法动作 ${JSON.stringify(act)}：${r.ok ? '' : r.reason}`);
      state = r.state;
      if (act.type === 'BUILD' || state.units.some(underConstruction)) sawSite = true;
      if (act.type === 'RECRUIT') budget.recruited += 1;
      if (act.type === 'UPGRADE') budget.upgraded += 1;
    }
  }
  assert.ok(sawSite, '三局里总该有人盖过一次要施工的东西，否则这条测试没考到点子上');
});



console.log('\n建造点数 · 多格占地');

test('建造点数：建筑难度从造价派生，工兵能力逐代递增', () => {
  const s = fresh({ godMode: true });
  const buildings = Object.values(s.unitTypes).filter((d) => d.category === 'building');
  assert.ok(buildings.length >= 4, '至少四种建筑');
  for (const b of buildings) {
    assert.ok(buildCostOf(b) >= 6, `${b.name} 的建造点数应该 ≥ 6，实际 ${buildCostOf(b)}`);
  }
  // 工兵：越晚的时代投得越快，而且每一代都要有提升——
  // 没提升的话"换工兵"就只是换个外观，建造点数这套东西也就白搭了
  const chain = ['laborer', 'miller', 'engineer', 'foreman', 'crew'];
  const powers = chain.map((id) => buildPowerOf(s.unitTypes[id]!));
  for (let i = 1; i < powers.length; i++) {
    assert.ok(powers[i]! > powers[i - 1]!, `${chain[i]} 该比 ${chain[i - 1]} 投得快：${powers.join('/')}`);
  }
});

test('建造点数：同一座粮仓，弱工兵先落工地、强工兵当回合立起来', () => {
  const mk = () => {
    const st = arena(fresh({ expansionIds: ['city-works'], godMode: true }));
    st.players.A.gold = 9999;
    st.players.A.res = { food: 9999, material: 9999 };
    // 试验台上的地形不一定平，抹出一块确定的空地，别赌生成器
    for (const [x, y] of [[5, 5], [6, 5]]) st.tiles[y * st.w + x]!.terrain = 'plain';
    return st;
  };

  const s = mk();
  const need = buildCostOf(s.unitTypes.granary!);
  const weak = buildPowerOf(s.unitTypes.laborer!);
  const strong = buildPowerOf(s.unitTypes.crew!);
  assert.ok(need > weak && need <= strong, `这个用例需要 ${weak} < 粮仓(${need}) ≤ ${strong}`);

  // 弱工兵：这一下只够落一块工地
  const a = place2(s, 'A', 'laborer', 5, 5);
  const r1 = applyAction(s, { type: 'BUILD', unitId: a.id, unitType: 'granary', x: 6, y: 5 });
  assert.ok(r1.ok, r1.ok ? '' : r1.reason);
  const weakSite = r1.state.units.find((u) => u.type === 'granary')!;
  assert.equal(underConstruction(weakSite), true, '劳工一回合修不完，先落工地');
  assert.equal(weakSite.buildNeed, need, '工地记着总点数');
  assert.equal(weakSite.buildDone, weak, '这一下投进去的正好是这个工兵的能力');

  // 强工兵：同样的建筑，当回合成型
  const s2 = mk();
  const b = place2(s2, 'A', 'crew', 5, 5);
  const r2 = applyAction(s2, { type: 'BUILD', unitId: b.id, unitType: 'granary', x: 6, y: 5 });
  assert.ok(r2.ok, r2.ok ? '' : r2.reason);
  const strongSite = r2.state.units.find((u) => u.type === 'granary')!;
  assert.equal(underConstruction(strongSite), false, `建筑队 ${strong} 点修 ${need} 点的粮仓，应该当回合完工`);
});

test('建造点数：两个工兵同回合能叠加，工期减半', () => {
  const s = arena(fresh({ expansionIds: ['city-works'], godMode: true }));
  s.players.A.gold = 9999;
  s.players.A.res = { food: 9999, material: 9999 };
  for (const [x, y] of [[4, 5], [5, 5], [6, 5], [7, 5]]) s.tiles[y * s.w + x]!.terrain = 'plain';

  const first = place2(s, 'A', 'laborer', 5, 5);
  const second = place2(s, 'A', 'laborer', 7, 5);
  const power = buildPowerOf(s.unitTypes.laborer!);

  const r1 = applyAction(s, { type: 'BUILD', unitId: first.id, unitType: 'tower', x: 6, y: 5 });
  assert.ok(r1.ok, r1.ok ? '' : r1.reason);
  const rateAfterOne = r1.state.units.find((u) => u.type === 'tower')!.buildRate;

  // 第二个工兵接着投同一块工地
  const r2 = applyAction(r1.state, { type: 'BUILD', unitId: second.id, unitType: 'tower', x: 6, y: 5 });
  assert.ok(r2.ok, r2.ok ? '' : r2.reason);
  const site = r2.state.units.find((u) => u.type === 'tower')!;
  assert.equal(site.buildRate, rateAfterOne! + power, '两个人的能力要相加，之后每回合一起到账');
  assert.equal(site.buildDone, power * 2, '同一回合投进去的点数也要累加');
});

test('2×2 兵营：四格全占、贴边打得到、覆盖格放不下别人', () => {
  const s = arena(fresh({ expansionIds: ['city-works'], godMode: true }));
  const camp = place2(s, 'A', 'camp', 5, 5);
  assert.equal(footprintOf(s, camp), 2, '城郭包里兵营是 2×2');

  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    assert.equal(unitAt(s, 5 + dx, 5 + dy)?.id, camp.id, `(${5 + dx},${5 + dy}) 应该算兵营占着`);
    assert.equal(coversTile(s, camp, 5 + dx, 5 + dy), true);
  }

  // 攻击距离按体积算：贴着右下角就是 1 格，而不是到左上角锚点的 2 格
  const foe = place2(s, 'B', 'militia', 7, 6);
  assert.equal(strikeDistance(s, foe, camp), 1, '按最近边算距离');
  assert.ok(canStrike(s, foe, camp), '贴着 2×2 的一边就该打得到');

  // 碰撞：兵营覆盖的格子不能再站人
  assert.equal(canStandAt(s, 6, 6, 'militia'), false, '兵营身上的格子放不下别人');
  assert.equal(canStandAt(s, 7, 7, 'militia'), true, '出了体积就该能站');
});

console.log('\n季节与气候');

/** 把一片区域抹平：天气测试要的是"确定的格子"，不该赌地图生成 */
function flatten(s: GameState, terrain: 'plain' | 'water' = 'plain'): void {
  for (const t of s.tiles) t.terrain = terrain;
}
function setTile(s: GameState, x: number, y: number, terrain: string): void {
  s.tiles[y * s.w + x]!.terrain = terrain as never;
}

test('季节：每 10 回合轮换，春→夏→秋→冬→春', () => {
  assert.equal(seasonOf(1), 'spring');
  assert.equal(seasonOf(10), 'spring');
  assert.equal(seasonOf(11), 'summer');
  assert.equal(seasonOf(20), 'summer');
  assert.equal(seasonOf(21), 'autumn');
  assert.equal(seasonOf(31), 'winter');
  assert.equal(seasonOf(41), 'spring', '第 41 回合回到春天');
  // 越界的回合数不该崩：开局前/负数都按第一年来算
  assert.equal(seasonOf(0), 'spring');
});

test('海陆距离：方圆 2 格有水算沿海，方圆 7 格没水算内陆', () => {
  const s = fresh({ expansionIds: ['seasons'], godMode: true });
  flatten(s, 'plain');
  // 在 (10,10) 放一格水
  setTile(s, 10, 10, 'water');

  assert.equal(coastClassOf(s, 11, 10), 'coastal', '贴着水就是沿海');
  assert.equal(coastClassOf(s, 12, 10), 'coastal', '隔一格还是沿海（2 格内）');
  assert.equal(coastClassOf(s, 13, 10), 'nearshore', '隔三格不算沿海，也不算内陆');
  // 离水 7 格以上：地图角落
  assert.equal(coastClassOf(s, 0, 0), 'inland', '方圆 7 格没水就是内陆');

  // 水面反过来判
  assert.equal(coastClassOf(s, 10, 10), 'shore', '水格贴着陆地是沿岸');
});

test('气候矩阵：地形 × 海陆 × 季节照表走', () => {
  const mk = (turn: number) => {
    const s = fresh({ expansionIds: ['seasons'], godMode: true });
    flatten(s, 'plain');
    s.turn = turn;
    return s;
  };

  // 平原内陸的夏天是酷暑，冬天是寒冷
  const summer = mk(15);
  setTile(summer, 5, 5, 'plain');
  assert.equal(coastClassOf(summer, 5, 5), 'inland');
  assert.equal(climateAt(summer, 5, 5), 'blazing', '平原·内陆·夏 = 酷暑');

  const winter = mk(35);
  assert.equal(climateAt(winter, 5, 5), 'cold', '平原·内陆·冬 = 寒冷');

  // 山地近岸的冬天是严冬
  const mtn = mk(35);
  setTile(mtn, 10, 10, 'water');
  setTile(mtn, 12, 10, 'mountain');
  assert.equal(coastClassOf(mtn, 12, 10), 'coastal');
  assert.equal(climateAt(mtn, 12, 10), 'cold', '山地·沿海·冬 = 寒冷');

  // 城市/桥这类"其他"一律温和，不参与冲突判定
  const city = mk(35);
  setTile(city, 5, 5, 'city');
  assert.equal(climateAt(city, 5, 5), 'mild', '城市不吃气候');
});

test('气候效果：酷暑腰斩移动力，浓雾压视野和射程', () => {
  const s = fresh({ expansionIds: ['seasons'], godMode: true });
  flatten(s, 'plain');
  s.turn = 15; // 夏
  // 整张图抹成平原、没有水 → 每一格都是内陆
  const u = place2(s, 'A', 'archer', 5, 5);
  const base = s.unitTypes.archer!.move;
  assert.equal(climateAt(s, 5, 5), 'blazing', '平原·内陆·夏 = 酷暑');
  assert.equal(movePower(s, u), Math.floor(base * 0.5), '酷暑是 -50%');

  // 浓雾（丘陵·内陆·秋）：视野压到 2
  const f = fresh({ expansionIds: ['seasons'], godMode: true });
  flatten(f, 'plain');
  f.turn = 25; // 秋
  setTile(f, 7, 7, 'hill');
  const archer = place2(f, 'A', 'archer', 7, 7);
  assert.equal(climateAt(f, 7, 7), 'fog', '丘陵·内陆·秋 = 浓雾');
  assert.ok(visionOf(f, archer) <= 2, `浓雾视野应该 ≤2，实际 ${visionOf(f, archer)}`);
  assert.ok(
    visionOf(f, archer) < s.unitTypes.archer!.vision,
    '浓雾必须真的压低了视野，不能本来就这么点',
  );

  // 阴雨（平原·沿海·秋）：射程 -1
  const o = fresh({ expansionIds: ['seasons'], godMode: true });
  flatten(o, 'plain');
  o.turn = 25;
  setTile(o, 9, 8, 'water'); // 贴着 (8,8)，让它成为沿海
  const bow = place2(o, 'A', 'archer', 8, 8);
  assert.equal(climateAt(o, 8, 8), 'overcast', '平原·沿海·秋 = 阴雨');
  assert.equal(
    effectiveRange(o, bow),
    Math.max(1, s.unitTypes.archer!.range - 1),
    '阴雨把射程砍一格',
  );
});

test('天气伤害：雷暴的回合末伤害真的会掉血', () => {
  const s = fresh({ expansionIds: ['seasons'], godMode: true });
  flatten(s, 'plain');
  // 山地·近岸·夏 = 雷暴：水放在切比雪夫距离 3 的位置（2 格内会变成沿海）
  s.turn = 15; // 夏
  setTile(s, 3, 3, 'mountain');
  setTile(s, 6, 3, 'water');
  const unit = place2(s, 'A', 'militia', 3, 3);
  const hpBefore = unit.hp;
  assert.equal(climateAt(s, 3, 3), 'thunder', '山地·近岸·夏 应该是雷暴');

  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const after = r.state.units.find((x) => x.id === unit.id);
  assert.ok(!after || after.hp < hpBefore, '雷暴应该让这个单位掉血');
});

console.log('\n地形高差（扩展）');

/** 直接写地块（测试专用：不经过沙盒的合法性检查） */
function putTerrain(s: GameState, x: number, y: number, t: Terrain): void {
  const tile = s.tiles[idx(s, x, y)];
  assert.ok(tile, `(${x},${y}) 不在棋盘上`);
  tile!.terrain = t;
}

/** 清空双方部队后，在一格上摆一个指定兵种，返回新状态 */
function unitOn(s: GameState, owner: PlayerId, type: string, x: number, y: number): GameState {
  const noUnits: GameState = { ...s, units: [] };
  const r = placeUnit(noUnits, owner, type, x, y);
  assert.ok(r.ok, `在 (${x},${y}) 摆 ${type} 失败：${r.ok ? '' : r.reason}`);
  return r.ok ? r.state : s;
}

const NEW_TERRAINS: readonly Terrain[] = ['plateau', 'valley', 'marsh', 'dune', 'shallow', 'lava', 'volcano'];

test('关掉扩展时没有高度：步耗与射程跟本体一模一样', () => {
  const off = fresh();
  const on = fresh({ expansionIds: ['height-terrain'] });

  // 高度：关掉就谁都一样高
  for (const t of NEW_TERRAINS) {
    assert.equal(heightOfTerrain(off, t), 0, `关掉扩展时 ${t} 还有高度`);
  }
  assert.equal(heightOfTerrain(on, 'plain'), 0, '平原是基准面');
  assert.equal(heightOfTerrain(on, 'plateau'), 2);
  assert.equal(heightOfTerrain(on, 'valley'), -1);

  // 步耗：关掉只有地形价，没有爬坡
  assert.equal(stepCostBetween(off, 'valley', 'plateau'), CONFIG.terrainCost.plateau);
  assert.equal(stepCostBetween(off, 'plateau', 'hill'), CONFIG.terrainCost.hill);

  // 射程：同一支弓兵、同一个目标，关掉扩展时一点都不变
  const s0 = unitOn(off, 'A', 'archer', 5, 5);
  putTerrain(s0, 8, 5, 'valley');
  const u0 = s0.units.find((u) => u.type === 'archer');
  assert.ok(u0);
  assert.equal(
    effectiveRangeAgainst(s0, u0!, s0.tiles[idx(s0, 8, 5)] ?? null),
    effectiveRange(s0, u0!),
    '关掉扩展时射程不该被地形改',
  );
});

test('高度阶梯：只有差 2 层以上才改射程，差 1 层不动', () => {
  const s = fresh({ expansionIds: ['height-terrain'] });
  putTerrain(s, 5, 5, 'plateau'); // 4 层
  putTerrain(s, 8, 5, 'valley'); // 1 层
  putTerrain(s, 2, 5, 'plain'); // 2 层
  const st = unitOn(s, 'A', 'archer', 5, 5);
  const u = st.units.find((x) => x.type === 'archer');
  assert.ok(u);
  const base = effectiveRange(st, u!);

  // 台地打谷地：高度差 3 层 → +1。
  // 地形本身的"制高点 +1"已经由高度表达过了，不再单独加一份（否则同一件事算两次）。
  assert.equal(
    effectiveRangeAgainst(st, u!, st.tiles[idx(st, 8, 5)] ?? null) - base,
    1,
    '台地打谷地该 +1',
  );

  // 反过来：谷地打台地只有 -1，不是 -2——
  // "被坡挡住"和"地形本身压住视线"是同一件事，减成分不叠加
  // （叠加会让弓兵在谷地里只剩射程 1，那不是削弱，是废掉这个兵种）。
  u!.x = 8;
  u!.y = 5;
  assert.equal(
    effectiveRangeAgainst(st, u!, st.tiles[idx(st, 5, 5)] ?? null) - base,
    -1,
    '谷地打台地该 -1（惩罚不叠加）',
  );

  // 平地打谷地：只差 1 层，高度不参与；平地本身也没有静态修正
  u!.x = 2;
  u!.y = 5;
  assert.equal(
    effectiveRangeAgainst(st, u!, st.tiles[idx(st, 8, 5)] ?? null) - base,
    0,
    '差 1 层不该改射程',
  );

  // 丘陵打高山：制高点 +1、仰攻 -1，正好抵掉，不该变成 +2 或 -2
  putTerrain(st, 3, 5, 'hill');
  putTerrain(st, 6, 5, 'mountain'); // 5 层，比丘陵高 2 层
  u!.x = 3;
  u!.y = 5;
  assert.equal(
    effectiveRangeAgainst(st, u!, st.tiles[idx(st, 6, 5)] ?? null) - base,
    0,
    '丘陵仰攻高山该互相抵掉',
  );
});

test('近战兵不会被高地变成远程', () => {
  // 射程 1 的兵站上台地，如果也跟着 +2 就能隔三格砍人——
  // 那不是"看得远"，是把所有近战变成弓兵。
  const s = fresh({ expansionIds: ['height-terrain'] });
  putTerrain(s, 5, 5, 'plateau');
  putTerrain(s, 8, 5, 'valley');
  const st = unitOn(s, 'A', 'militia', 5, 5);
  const u = st.units.find((x) => x.type === 'militia');
  assert.ok(u);
  assert.equal(effectiveRangeAgainst(st, u!, st.tiles[idx(st, 8, 5)] ?? null), 1);
});

test('高机动性：移动/射程/视野 ×1.5，近战射程不动，桥不再给视野', () => {
  const off = fresh();
  const on = fresh({ expansionIds: ['high-mobility'] });
  const u = (st: GameState, type: string): Unit => {
    const unit = placeUnit(st, 'A', type, 5, 5);
    assert.ok(unit.ok, unit.ok ? '' : unit.reason);
    return unit.state.units.find((x) => x.type === type)!;
  };

  // 移动：2 → 3（向上取整，缩放不该让谁变慢）
  assert.equal(movePower(off, u(off, 'militia')), 2);
  assert.equal(movePower(on, u(on, 'militia')), 3);
  // 视野：2 → 3
  assert.equal(visionOf(off, u(off, 'militia')), 2);
  assert.equal(visionOf(on, u(on, 'militia')), 3);
  // 远程射程：3 → 4（向下取整）
  assert.equal(effectiveRange(off, u(off, 'archer')), 3);
  assert.equal(effectiveRange(on, u(on, 'archer')), 4);
  // 近战射程保持 1：×1.5 之后变 2 会把所有近战变远程，那是抹掉兵种分类
  assert.equal(effectiveRange(on, u(on, 'militia')), 1);
  // 建筑不动：墙还是 0
  assert.equal(movePower(on, u(on, 'tower')), 0);

  // 桥不再自带视野：本体三座桥的数据表都是 0，而且**真的**一格不看——
  // visionOf 那个 Math.max(1, …) 下限不能把它抬回 1（扩展的 modifyVision 也带同样的下限）
  for (const id of ['bridge', 'bridge2', 'bridge3']) {
    assert.equal(UNIT_TYPES[id]!.vision, 0, `${id} 的数据表不该再有视野`);
  }
  for (const ids of [[], ['height-terrain'], ['high-mobility'], ['seasons']]) {
    const st = fresh({ expansionIds: ids });
    // 桥只能架在水上：先铺一格水，再放桥
    putTerrain(st, 5, 5, 'water');
    const r = placeUnit(st, 'A', 'bridge', 5, 5);
    assert.ok(r.ok, r.ok ? '' : r.reason);
    const br = r.state.units.find((x) => x.type === 'bridge')!;
    assert.equal(visionOf(r.state, br), 0, `开了 ${ids.join('+') || '本体'} 时桥也不该有视野`);
  }
});

test('爬坡：往高处走每层 +1、封顶 2 层，下坡不加价，且一格最多吃掉全部移动力', () => {
  const on = fresh({ expansionIds: ['height-terrain'] });
  putTerrain(on, 4, 4, 'plain');
  const s = unitOn(on, 'A', 'militia', 4, 4);
  const u = s.units.find((x) => x.type === 'militia');
  assert.ok(u);
  // 高度是"相对平原"的带符号层数
  assert.equal(heightOfTerrain(s, 'valley'), -1);
  assert.equal(heightOfTerrain(s, 'plain'), 0);
  assert.equal(heightOfTerrain(s, 'hill'), 1);
  assert.equal(heightOfTerrain(s, 'plateau'), 2);

  // 谷地(−1) → 台地(+2)：差 3 层，封顶按 2 层算 → 台地价 2 + 2 = 4，
  // 但民兵只有 2 点移动力，钳到 2（这一回合就到头了，但爬得上去）
  putTerrain(s, 5, 5, 'valley');
  putTerrain(s, 5, 4, 'plateau');
  const up = stepCostInto(s, u!, idx(s, 5, 5), idx(s, 5, 4));
  assert.equal(up, 2, '爬坡再贵也不会超过这个兵的移动力，否则就是"点了没反应"');

  // 差 2 层和差 3 层是一个价（封顶 2 层）
  putTerrain(s, 5, 4, 'hill');
  assert.equal(stepCostInto(s, u!, idx(s, 5, 5), idx(s, 5, 4)), 2);

  // 下坡不加价，也不减价
  putTerrain(s, 5, 5, 'plateau');
  putTerrain(s, 5, 4, 'valley');
  assert.equal(stepCostInto(s, u!, idx(s, 5, 5), idx(s, 5, 4)), CONFIG.terrainCost.valley);

  // 同层不加价
  putTerrain(s, 5, 5, 'plain');
  putTerrain(s, 5, 4, 'forest');
  assert.equal(stepCostInto(s, u!, idx(s, 5, 5), idx(s, 5, 4)), CONFIG.terrainCost.forest);

  // 飞行/水军不看地面起伏
  putTerrain(s, 5, 5, 'valley');
  putTerrain(s, 5, 4, 'plateau');
  assert.equal(stepCostInto(s, u!, idx(s, 5, 5), idx(s, 5, 4), { flyer: true }), 1);
  assert.equal(stepCostInto(s, u!, idx(s, 5, 5), idx(s, 5, 4), { waterUnit: true }), 1);
});

test('浅流：陆军涉得过去，水军也能贴着它滑', () => {
  // 三种水面各归各：
  //   water   —— 深水，只有船能走
  //   shallow —— 浅滩，陆军涉水、水军也过（水军的抄近路）
  //   bridge  —— 桥面，两边都能过
  assert.equal(passable('water'), false, '深水陆军不该走得过去');
  assert.equal(passable('shallow'), true, '浅流陆军该能涉过去');
  assert.equal(navigable('water'), true);
  assert.equal(navigable('bridge'), true);
  assert.equal(navigable('shallow'), true, '水军也要能过浅滩，这就是给它留的近路');
  assert.equal(navigable('plain'), false, '船不该能开上平原');
  assert.equal(CONFIG.terrainCost.shallow, 2, '踩水走一格该顶两格');
  assert.equal(CONFIG.terrainDef.shallow, -1, '站在水里没处躲，防御该是负的');

  const s = fresh({ expansionIds: ['height-terrain'] });
  putTerrain(s, 6, 6, 'shallow');
  putTerrain(s, 6, 7, 'plain');
  const st = { ...s, units: [] };
  assert.ok(canStandAt(st, 6, 6, 'militia'), '陆军该能站上浅流');
  assert.ok(canStandAt(st, 6, 6, 'boat'), '水军该能停在浅流上');
  assert.equal(canStandAt(st, 6, 7, 'boat'), false, '船不该能开到平原上');

  // 平原(2 层)踩进浅流(1 层)：下坡不爬坡，只算水的价
  const st2 = unitOn(st, 'A', 'militia', 6, 7);
  const u = st2.units.find((x) => x.type === 'militia');
  assert.ok(u);
  assert.equal(stepCostInto(st2, u!, idx(st2, 6, 7), idx(st2, 6, 6)), 2);
  // 从浅流走回平原：两者同层（都是基准面），没有爬坡，只算平地的价
  assert.equal(stepCostInto(st2, u!, idx(st2, 6, 6), idx(st2, 6, 7)), CONFIG.terrainCost.plain);
});

test('等高线：哪张地貌上，高山底下都得有台地托着', () => {
  // 这条守的是"山脚"，判据比"有没有一个高邻居"严一档：
  //   · 一格高山只要四邻还有**平原/林地/丘陵**，那就是一步从 2 层跨到 5 层的悬崖，
  //     玩家看到的是柱子不是等高线；
  //   · 城郊那一圈例外——补山脚会把出生点抬成台地，所以 mapgen 把城和城郊
  //     写进 keep 名单，那一圈本来就该保持平整。
  // 旧版用的判据是"四邻里没有台地/高山就降成台地"，它只会削孤峰：
  // 一条 20 格的山脊每格都有山邻居，整条边照样贴着平原。
  const styles = ['open', 'ridge', 'river-h', 'river-v', 'highland', 'canyon', 'volcanic'] as const;
  for (const style of styles) {
    for (const seed of [31, 77, 1234, 5]) {
      const s = createMatch({ ...BASE, size: 24, expansionIds: ['height-terrain'], mapStyle: style }, seed);
      const H = (x: number, y: number) => heightOfTerrain(s, s.tiles[y * s.w + x]!.terrain);
      const nearCity = (x: number, y: number) =>
        s.cities.some((c) => Math.max(Math.abs(x - c.x), Math.abs(y - c.y)) <= 3);
      let cliff = 0;
      let bare = 0;
      let plateau = 0;
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          if (s.tiles[y * s.w + x]!.terrain === 'plateau') plateau++;
          if (H(x, y) < 5) continue;
          if (nearCity(x, y)) continue;
          let skirt = false;
          let land = 0; // 四邻里"陆地"有几格
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
            const t = s.tiles[ny * s.w + nx]!.terrain;
            // 高度是相对平原的带符号层数：台地是 +2（旧的绝对刻度里是 4）
            if (H(nx, ny) >= 2) skirt = true;
            if (t === 'plain' || t === 'forest' || t === 'hill') cliff++;
            if (t !== 'water' && t !== 'shallow') land += 1;
          }
          // 水中的孤峰不算违规：补山脚那一趟**故意**不动水（"隔着一条河的对岸
          // 不该被算成这座山的山脚"，见 height-terrain 的注释），
          // 湖心一块石头本来就是孤零零的，那不是缺山脚，是它确实站在水里。
          if (!skirt && land > 0) bare++;
        }
      }
      assert.equal(cliff, 0, `${style}#${seed} 有 ${cliff} 处高山直接贴着平原/丘陵（缺山脚）`);
      assert.equal(bare, 0, `${style}#${seed} 有 ${bare} 格高山没有任何高邻居`);
      assert.ok(plateau > 0, `${style}#${seed} 一格台地都没有——山脚根本没补上`);
    }
  }

  // 关掉扩展就一格台地也不许有：原版地图必须一模一样
  for (const style of ['open', 'ridge'] as const) {
    const s = createMatch({ ...BASE, size: 24, expansionIds: [], mapStyle: style }, 31);
    assert.equal(s.tiles.filter((t) => t.terrain === 'plateau').length, 0);
  }
});

test('开了「地形高差」，本体那四种地貌也得跟着变样', () => {
  // 用户反馈："开了扩展，有些图跟没开时几乎一样"。
  // 根因是随机袋里本体四种地貌占 6/14，抽到它们时那条分支一格都不读扩展——
  // 旧版只把"孤零零一格的山"降成台地，统计上根本看不出差别（同种子同地貌时
  // 甚至逐格相同）。补山脚之后，山体从 3~5 格涨到 5~9 格，高地面积必须明显变大。
  const H = (t: string): number =>
    t === 'hill'
      ? 3
      : t === 'plateau'
        ? 4
        : t === 'mountain' || t === 'volcano'
          ? 5
          : t === 'dune'
            ? 3
            : 0;
  const share = (s: { tiles: Array<{ terrain: string }> }): number =>
    s.tiles.filter((t) => H(t.terrain) >= 3).length / s.tiles.length;

  let sum = 0;
  let cases = 0;
  let up = 0;
  for (const style of ['open', 'ridge', 'river-h', 'river-v'] as const) {
    for (const seed of [31, 77, 1234, 5]) {
      const off = createMatch({ ...BASE, size: 24, mapStyle: style }, seed);
      const on = createMatch({ ...BASE, size: 24, mapStyle: style, expansionIds: ['height-terrain'] }, seed);
      const gain = share(on) - share(off);
      // 十二张里允许一张"高地反而少了"：扩展里有一条"任何一张图都得走得通"的兜底，
      // 它会把挡路的山削成丘陵（见 height-mapgen 的 shoalBridge）。河与山脊撞在一起时，
      // 削掉的十格山能盖过补上的山脚台地，净增量就是负的——那是机制本身要的，
      // 不是"扩展没生效"。真正的回归长什么样：十二张全都 ≈0，平均也上不去。
      if (gain > 0.01) up += 1;
      sum += gain;
      cases += 1;
    }
  }
  assert.ok(up >= cases - 1, `${cases} 张图里只有 ${up} 张的高地变多了——扩展基本没生效`);
  const avg = sum / cases;
  assert.ok(avg > 0.04, `平均只多出 ${(avg * 100).toFixed(1)} 个点的高地（应 > 4）`);
});

test('随机地貌：开了扩展，抽到的多半是扩展自带的那几种', () => {
  // 扩展自带的地貌进两次、本体各一次：勾了扩展就是想看那套地势，
  // 不能一半对局都落回"和没开扩展时一模一样"的本体地图。
  const baseIds = new Set(MAP_STYLES.map((o) => o.id));
  const extIds = new Set(
    mapStylesFor(['height-terrain'])
      .map((o) => o.id)
      .filter((id) => !baseIds.has(id)),
  );
  assert.equal(extIds.size, 5, '「地形高差」现在带五种地貌');

  let ext = 0;
  let n = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const L = generateLayout(20, seed, ['militia'], { style: 'random', expansions: ['height-terrain'] });
    n += 1;
    if (extIds.has(L.style)) ext += 1;
  }
  assert.ok(ext / n >= 0.6, `四十张随机图里只有 ${ext} 张抽到扩展地貌`);

  // 反过来：没开扩展时，一张都不该抽到
  for (let seed = 1; seed <= 20; seed += 1) {
    const L = generateLayout(20, seed, ['militia'], { style: 'random' });
    assert.ok(!extIds.has(L.style), `没开扩展却抽到了 ${L.style}`);
  }
});

test('过河的口子是浅滩，不是一段平原', () => {
  // 老版本的连通性修补是"把水填成平原"，于是横河里会出现一段毫无道理的陆桥：
  // 河看着像被人填了一截，船也被那段陆地挡在河外。开了扩展之后要改成浅滩。
  for (const style of ['river-h', 'river-v'] as const) {
    let forded = 0;
    for (const seed of [31, 77, 1234, 5, 909, 1237]) {
      const L = generateLayout(24, seed, ['militia'], {
        style,
        symmetry: 'fair',
        expansions: ['height-terrain'],
      });
      const deep = L.rows.join('').split('').filter((ch) => ch === '~').length;
      const shoal = L.rows.join('').split('').filter((ch) => ch === 's').length;
      assert.ok(deep > 0, `${style}#${seed} 没有河`);
      if (L.fordless) {
        // 无渡口图是"天堑"：过河只能造桥，一格浅滩都不该有
        assert.equal(shoal, 0, `${style}#${seed} 是无渡口河，却留了可徒涉的浅滩`);
      } else {
        forded++;
        assert.ok(shoal > 0, `${style}#${seed} 有渡口的河，渡口该是浅滩`);
      }
    }
    assert.ok(forded > 0, `${style} 六张图里一张带渡口的都没有，用例没测到东西`);
  }
});

test('横贯全图的水域：海和浅滩都真的出现，陆军能走到对岸', () => {
  for (const style of ['isles', 'river'] as const) {
    let water = 0;
    let shallow = 0;
    const seeds = [31, 77, 1234, 5];
    for (const seed of seeds) {
      const s = createMatch({ ...BASE, size: 24, expansionIds: ['height-terrain'], mapStyle: style }, seed);
      const at = (x: number, y: number) => s.tiles[y * s.w + x]!.terrain;
      water += s.tiles.filter((t) => t.terrain === 'water').length;
      shallow += s.tiles.filter((t) => t.terrain === 'shallow').length;

      // 只用陆军走得通的地形，从 A 城走到 B 城：
      // 说明那片水域上真的有能徒涉的口子，而不是把地图劈成两半
      const a = s.cities.find((c) => c.owner === 'A');
      const b = s.cities.find((c) => c.owner === 'B');
      assert.ok(a && b, `${style}#${seed} 没有双方的城`);
      const seen = new Set<number>([a!.y * s.w + a!.x]);
      const q = [a!.y * s.w + a!.x];
      while (q.length > 0) {
        const i = q.pop()!;
        const x = i % s.w;
        const y = Math.floor(i / s.w);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h) continue;
          const j = ny * s.w + nx;
          if (seen.has(j) || !passable(at(nx, ny))) continue;
          seen.add(j);
          q.push(j);
        }
      }
      assert.ok(seen.has(b!.y * s.w + b!.x), `${style}#${seed} 陆军走不到对岸`);
    }
    assert.ok(water > 200, `${style} 四张图加起来才 ${water} 格水，说不上"横贯全图"`);
    assert.ok(shallow > 40, `${style} 的浅滩太少（${shallow} 格），陆军根本过不去`);
  }
});

test('地貌选项跟着扩展开关增减', () => {
  const base = mapStylesFor([]).map((o) => o.id);
  assert.equal(base.includes('highland'), false, '没开扩展不该有高原');
  const withExt = mapStylesFor(['height-terrain']).map((o) => o.id);
  assert.equal(withExt.length, base.length + 5);
  for (const id of ['highland', 'canyon', 'marsh', 'isles', 'river']) {
    assert.ok(withExt.includes(id as never), `开了扩展也没有 ${id}`);
  }
  // 随机袋也只在开了扩展时才抽得到 —— 关扩展 40 张图不可能抽出高原
  const seen = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    seen.add(generateLayout(16, seed * 13 + 5).style);
  }
  assert.equal(seen.has('highland'), false, '关扩展的随机地貌里抽到了高原');
});

test('地形高差可选，但默认不开：不勾就一格新地形都不会落到图上', () => {
  // 这个包已经对玩家开放（开局界面里能勾），但**默认不勾**：
  // 不勾就等于不存在——地图是按这一局的扩展现生成的，规则钩子也不挂。
  assert.ok(expansionById('height-terrain'), '扩展要在注册表里');
  assert.ok(
    availableExpansions().some((e) => e.id === 'height-terrain'),
    '开放的扩展要出现在开局面板/规则书的可选列表里',
  );

  const s = createMatch({ ...DEFAULT_CONFIG }, 4242);
  // 地形表是 `readonly Terrain[]`（字符串），别再按对象取 .id
  const heightTerrains = new Set(expansionById('height-terrain')?.terrains ?? []);
  assert.ok(heightTerrains.size > 0, '这条用例依赖扩展自己声明的地形表');
  const leaked = s.tiles.filter((t) => heightTerrains.has(t.terrain));
  assert.equal(leaked.length, 0, `没开扩展却生成了 ${leaked.length} 格高差地形`);
});

test('上帝模式的画笔跟着扩展开关走', () => {
  const off = { ...fresh(), units: [] };
  const denied = paintTerrain(off, 5, 5, 'plateau');
  assert.equal(denied.ok, false, '没开扩展也能刷台地？');

  const on = { ...fresh({ expansionIds: ['height-terrain'] }), units: [] };
  // 开了「地形高差」之后图上本来就有台地，5,5 可能正好是一块——
  // 那就成了"这一格已经是台地了"，测不到画笔。先找一格平原。
  const at = on.tiles.findIndex((t) => t.terrain === 'plain' && !t.cityId);
  assert.ok(at >= 0, '总得有一格平原');
  const px = at % on.w;
  const py = Math.floor(at / on.w);
  const ok = paintTerrain(on, px, py, 'plateau');
  assert.ok(ok.ok, ok.ok ? '' : ok.reason);
  if (ok.ok) {
    assert.equal(ok.state.tiles[idx(ok.state, px, py)].terrain, 'plateau');
  }
});

console.log('\n对局报告');

test('对局报告：只留棋局，不留人', () => {
  const s = fresh({ expansionIds: ['city-works'] });
  s.players.A.name = '张三';
  s.players.B.name = '李四';
  const at = new Date('2026-01-02T03:04:05.000Z');
  const rep = buildMatchReport(s, at);
  const json = reportJson(rep);

  for (const secret of ['张三', '李四']) {
    assert.equal(json.includes(secret), false, `报告里不该出现玩家名「${secret}」`);
  }

  assert.equal(rep.v, REPORT_VERSION);
  assert.equal(rep.seed, s.seed);
  assert.equal(rep.board.w, s.w);
  assert.equal(rep.turns, s.turn);
  assert.equal(rep.sides.length, 2, '两边各一份，缺一边就没法比');

  // 地形分布加起来必须等于格子总数：这张表是"地图生成有没有偏科"的唯一依据
  const total = Object.values(rep.board.terrain).reduce((a, b) => a + b, 0);
  assert.equal(total, s.w * s.h, '地形分布加起来应该等于格子总数');

  // 阵容加起来等于实际兵力，建筑不算在内（建筑不进 roster，单独数）
  for (const side of rep.sides) {
    const alive = s.units.filter(
      (u) => u.owner === side.side && s.unitTypes[u.type]?.category !== 'building',
    );
    const counted = Object.values(side.roster).reduce((a, b) => a + b, 0);
    assert.equal(counted, alive.length, `${side.side} 方的阵容数对不上`);
    assert.equal(side.units, alive.length, `${side.side} 方的兵力数对不上`);
  }

  // 同一局、同一时刻生成两次必须一模一样：不然"这局是不是传过了"都没法判断
  assert.equal(reportJson(buildMatchReport(s, at)), json);
});

test('对局报告：胜负写实，文件名给谁都打得开', () => {
  const s = fresh();
  const at = new Date('2026-01-02T03:04:05.000Z');
  assert.equal(buildMatchReport(s, at).winner, null, '还没打完就没有胜者');

  s.winner = 'B';
  const rep = buildMatchReport(s, at);
  assert.equal(rep.winner, 'B');

  const name = reportFileName(rep);
  assert.ok(/^[\w.-]+\.json$/.test(name), `文件名只能是安全字符：${name}`);
  assert.ok(name.endsWith('-b.json'), `文件名里要看得出是谁赢的：${name}`);
  assert.equal(name.includes(':'), false, '文件名里不能有冒号（Windows 不允许）');

  // 未分胜负也要有个名字，而不是空一段
  assert.ok(reportFileName(buildMatchReport(s, at)).length > 0);
});

test('逐回合摘要：按回合采帧、按方计数、封顶之后抽稀', () => {
  const s = fresh();
  const tl = newTimeline(1);
  assert.equal(tl.samples.length, 0);

  for (let t = 1; t <= 6; t++) {
    s.turn = t;
    sampleTurn(s, tl);
  }
  assert.equal(tl.samples.length, 6, '每回合采一帧');
  assert.equal(tl.samples[0]?.t, 1, '第一帧是开局');
  const last = tl.samples[tl.samples.length - 1];
  assert.ok(last, '最后一帧应该在');
  assert.equal(last.A.length, 5, '每方五个数：兵/建筑/城/金/血');
  assert.ok(last.va >= 0 && last.vb >= 0, '身价不可能是负数');

  noteAction(tl, 'A', { type: 'RECRUIT', cityId: 'c1', unitType: 'militia' });
  noteAction(tl, 'A', { type: 'RECRUIT', cityId: 'c1', unitType: 'militia' });
  noteAction(tl, 'B', { type: 'MOVE', unitId: 'u1', x: 3, y: 4 });
  assert.equal(tl.acts.A.RECRUIT, 2);
  assert.equal(tl.made.A.militia, 2, '同一个兵种要累加');
  assert.equal(tl.acts.B.MOVE, 1);
  assert.equal(Object.keys(tl.made.B).length, 0, '没造兵就是空的');

  // 长局：必须封顶，否则一局两百回合的报告能有几兆
  const long = newTimeline(1);
  const s2 = fresh();
  for (let t = 1; t <= 700; t++) {
    s2.turn = t;
    sampleTurn(s2, long);
  }
  assert.ok(long.samples.length <= 240, `样本数应当封顶，实际 ${long.samples.length}`);
  assert.ok(long.thinned, '超上限之后要标记抽稀过');
  assert.ok(long.every > 1, '抽稀之后间隔应当变大');
  assert.equal(long.samples[0]?.t, 1, '抽稀不能把开局帧丢掉');
  const ts = long.samples.map((x) => x.t);
  for (let i = 1; i < ts.length; i++) {
    assert.ok((ts[i] ?? 0) > (ts[i - 1] ?? 0), '时间必须单调递增');
  }
});

test('逐回合摘要：进得了报告，仍然不带玩家名', () => {
  const s = fresh();
  s.players.A.name = '王五';
  s.turn = 4;
  const tl = newTimeline(1);
  sampleTurn(s, tl);
  const rep = buildMatchReport(s, new Date('2026-01-02T03:04:05.000Z'), tl);
  assert.ok(rep.timeline, '给了摘要就该进报告');
  assert.equal(rep.timeline?.samples.length, 1);
  assert.equal(reportJson(rep).includes('王五'), false, '摘要里也不许出现玩家名');

  const lean = buildMatchReport(s, new Date('2026-01-02T03:04:05.000Z'));
  assert.equal(lean.timeline, undefined, '没勾详细记录的时候不该有 timeline');

  // 指纹要把两种版本区分开，否则先传精简版再传详细版会被当成重复
  assert.notEqual(reportSignature(lean), reportSignature(rep));

  assert.ok(timelineSummary(tl).includes('帧'), '摘要文案要能读懂');
  assert.equal(timelineSummary(null), '', '没摘要就别编一句出来');
});

test('批次码：清洗成数据库约束认的形状，不合法就当没有', () => {
  assert.equal(normalizeCampaign('net-friends-a'), 'net-friends-a');
  assert.equal(normalizeCampaign('  Net Friends A  '), 'net-friends-a', '大小写和空格要收拾干净');
  assert.equal(normalizeCampaign('群1: 网友'), '1', '中文和冒号会被剥掉，剩下的部分仍然合法');
  assert.equal(normalizeCampaign('---abc---'), 'abc', '开头的横线要去掉（约束要求首字符是字母或数字）');
  assert.equal(normalizeCampaign('下拉'), null, '全是非法字符就返回 null，而不是空串');
  assert.equal(normalizeCampaign(''), null);
  assert.equal(normalizeCampaign(null), null);

  const long = normalizeCampaign('a'.repeat(60));
  assert.ok(long && long.length <= 24, '超长要截断');
  assert.ok(/^[a-z0-9][a-z0-9-]{0,23}$/.test(long ?? ''), '清洗结果必须能被数据库的 CHECK 接受');
});

test('属性抗性按倍率作用，且数据必须落在 0~1', () => {
  // 2026-10-28 改结算顺序时，代码换成了倍乘、数据还是旧的 `water: 4`，
  // 于是"抗水 4 点"变成"受水伤 ×4"：水元素互殴从 15 点涨到 60 点。
  // 两条防线：用例锁住"倍率"的算法，下面那段扫全表锁住数据形状。
  const s = fresh({ expansionIds: EXPANSIONS.map((e) => e.id) });
  s.units = [];

  const def = s.unitTypes['water-elemental'];
  assert.ok(def);
  const mul = def.resist?.water;
  assert.equal(typeof mul, 'number', '水元素应当抗水');
  assert.ok(mul! > 0 && mul! < 1, `抗性必须是 0~1 的倍率，实际是 ${mul}`);

  // 复制一个"除了没有水抗之外完全一样"的守方，用来比差值
  s.unitTypes['water-elemental-plain'] = { ...def, id: 'water-elemental-plain', resist: undefined };
  const mk = (id: string, owner: 'A' | 'B', x: number, y: number) => {
    const t = s.unitTypes[id];
    assert.ok(t);
    const u = {
      id: `${id}-${owner}`,
      type: id,
      owner,
      x,
      y,
      hp: t.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    };
    s.units.push(u);
    return u;
  };

  const attacker = mk('water-elemental', 'A', 3, 3);
  // 站位必须是平原：扩展开满之后地图上本来就有台地（这就是「地形高差」干的事），
  // 台地自带护甲，站上去会把"抗性打折"和"地形护甲"混成一个数，比出来是 11 不是 13。
  for (const [x, y] of [[3, 3], [4, 3], [4, 4]]) s.tiles[idx(s, x, y)].terrain = 'plain';
  const withResist = mk('water-elemental', 'B', 4, 3);
  const withoutResist = mk('water-elemental-plain', 'B', 4, 4);

  const a = computeDamage(s, attacker, withResist, false);
  const b = computeDamage(s, attacker, withoutResist, false);
  assert.ok(b > 0, '对照组要打得动，否则比不出东西');
  assert.ok(a < b, '抗性只能让伤害变小');
  // 四舍五入允许 1 点误差
  assert.ok(
    Math.abs(a - Math.round(b * mul!)) <= 1,
    `抗性应当按倍率打折：无抗 ${b}、×${mul} 后应约 ${Math.round(b * mul!)}，实际 ${a}`,
  );

  // 全表体检：任何一条 resist 只要 ≥1，就等于"越抗越疼"
  for (const t of Object.values(s.unitTypes)) {
    for (const [el, v] of Object.entries(t.resist ?? {})) {
      assert.ok(
        typeof v === 'number' && v > 0 && v < 1,
        `${t.id} 的 resist.${el} = ${String(v)}，必须是 0~1 的倍率（写成 4 会变成四倍伤害）`,
      );
    }
  }
});

test('旧的自定义兵种：整数抗性要折成倍率', () => {
  // resist 从"平减点数"改成"倍率"之后，玩家 localStorage 里存的旧兵种还是整数。
  // 不折算的话，写了 4 的兵会变成"受四倍伤害"。
  const four = legacyResistToMultiplier(4);
  assert.ok(four > 0 && four < 1, `4 应当折成 0~1 的倍率，实际 ${four}`);
  assert.ok(Math.abs(four - 0.714) < 0.01, '按 1/(1+v*0.1) 折算，4 应约等于 0.714');
  assert.ok(Math.abs(four - 0.7) < 0.05, '折算结果应当接近内置表用的 0.7');

  assert.equal(legacyResistToMultiplier(0.7), 0.7, '已经是倍率的不要动');
  assert.equal(legacyResistToMultiplier(0), 1, '0 等于没抗性');
  assert.equal(legacyResistToMultiplier(-3), 1, '负数不能变成"加伤"');
  assert.ok(legacyResistToMultiplier(10) < legacyResistToMultiplier(2), '点数越大，打折越多');

  const legacy = {
    id: 'c_1',
    name: '旧兵',
    resist: { water: 4, fire: 0.8 },
  } as unknown as Parameters<typeof normalizeUnitResist>[0];
  const fixed = normalizeUnitResist(legacy);
  assert.ok(fixed, '有整数抗性就该被修正');
  assert.ok((fixed!.resist?.water ?? 1) < 1, '水抗要折成倍率');
  assert.equal(fixed!.resist?.fire, 0.8, '已经合法的不要动');

  assert.equal(normalizeUnitResist(fixed!), null, '修过的定义不该再次被改');
  assert.equal(normalizeUnitTypes({ c_1: fixed! }), false, '第二遍应该报"没改过"');

  const table: Record<string, typeof legacy> = { c_1: legacy, c_2: { ...legacy, id: 'c_2' } };
  assert.equal(normalizeUnitTypes(table), true, '第一次应当真的改了');
  for (const def of Object.values(table)) {
    for (const v of Object.values(def.resist ?? {})) {
      assert.ok(v > 0 && v < 1, `折完之后必须是倍率，实际 ${v}`);
    }
  }
});

test('开局的配置要活进对局：createMatch 不能把开关吃掉', () => {
  // 2026-10-28 的事故：state.config 是逐个字段白名单抄的，`recordDetail` 漏了，
  // 于是玩家勾了"数据收集"、开局瞬间被吃掉，上传上来一帧摘要都没有，
  // 而他本人非常确定自己勾了——因为界面上确实勾了，是内核丢了。
  const withRecord = createMatch({ ...DEFAULT_CONFIG, recordDetail: true }, 4242);
  assert.equal(withRecord.config.recordDetail, true, '勾了就要带进对局');
  assert.equal(withRecord.config.recordDetail !== true ? 'lost' : 'kept', 'kept');

  const without = createMatch({ ...DEFAULT_CONFIG }, 4242);
  assert.equal(without.config.recordDetail, false, '没勾就是明确的 false，不是 undefined');

  // 顺手把一个"必须活下来"的清单钉住：以后再加开关，漏抄一个就会红
  const cfg = createMatch(
    { ...DEFAULT_CONFIG, recordDetail: true, commanderMode: false, godMode: false },
    4242,
  ).config;
  for (const key of ['size', 'startEra', 'expansionIds', 'enabledUnits', 'aiLevel'] as const) {
    assert.ok(cfg[key] !== undefined, `配置字段 ${key} 不该在开局时丢掉`);
  }
  assert.equal(cfg.commanderMode, false);
  assert.equal(cfg.godMode, false);
});

test('报告要记下"这局要求过摘要吗"，好让"勾了却没记上"变得可查', () => {
  const asked = createMatch({ ...DEFAULT_CONFIG, recordDetail: true }, 99);
  const id = asked.units[0]?.id;
  assert.ok(id);
  const tl = newTimeline(1);
  sampleTurn(asked, tl);

  const withTl = buildMatchReport(asked, new Date('2026-10-28T09:00:00Z'), tl);
  assert.equal(withTl.recordRequested, true);
  assert.ok(withTl.timeline, '要求了也记了，两份都该在');

  // 要求了、但没记到（刷新页面 / 沙盒）：靠 recordRequested 与 timeline 的
  // 不一致就能在数据里直接查出来，不用再靠玩家回忆。
  const askedNoData = buildMatchReport(asked, new Date('2026-10-28T09:00:00Z'));
  assert.equal(askedNoData.recordRequested, true);
  assert.equal(askedNoData.timeline, undefined);

  const notAsked = buildMatchReport(createMatch({ ...DEFAULT_CONFIG }, 99));
  assert.equal(notAsked.recordRequested, false);
});

test('摘要也要能记下开局与终局：force 采样绕开间隔，0 帧的摘要不进报告', () => {
  // 2026-10-28 实测踩到的洞：一局第 1 回合认输，采样只挂在"结束回合"上，
  // 于是上传的 timeline 里 samples 是空的——有字段、没内容，比没有更误导。
  const s = createMatch({ ...DEFAULT_CONFIG, recordDetail: true }, 31);
  const tl = newTimeline(1);
  tl.every = 2; // 模拟长局抽稀之后的间隔

  s.turn = 3;
  sampleTurn(s, tl);
  assert.equal(tl.samples.length, 0, '3 不能被 2 整除，普通采样应当跳过');
  sampleTurn(s, tl, true);
  assert.equal(tl.samples.length, 1, 'force 要无视间隔：开局基线和终局帧靠它落地');
  assert.equal(tl.samples[0]?.t, 3);

  // 0 帧的摘要不该进报告
  const blank = buildMatchReport(s, new Date('2026-10-28T10:00:00Z'), newTimeline(1));
  assert.equal(blank.recordRequested, true);
  assert.equal(blank.timeline, undefined, '一帧都没有就别带 timeline 字段');

  // 有帧才带
  const withFrame = buildMatchReport(s, new Date('2026-10-28T10:00:00Z'), tl);
  assert.ok(withFrame.timeline, '采到帧就该带上');
  assert.equal(withFrame.timeline?.samples.length, 1);
});

test('战损：靠单位集合差分，拆除不算', () => {
  // 为什么不数 u.kills：那个字段只在开「老兵不死」时才增长，别的组合下永远是 0。
  const s = createMatch({ ...DEFAULT_CONFIG }, 77);
  const tl = newTimeline(1);
  noteDeaths(tl, s); // 建基线：先把开局在场的单位记下来
  sampleTurn(s, tl, true);

  const victim = s.units.find(
    (u) => u.owner === 'B' && s.unitTypes[u.type]?.category === 'combat',
  );
  assert.ok(victim, '开局应当有战斗单位');
  const cost = s.unitTypes[victim.type]?.cost ?? 0;
  assert.ok(cost > 0);

  // 打死一个
  s.units = s.units.filter((u) => u.id !== victim.id);
  noteDeaths(tl, s);
  assert.equal(tl.lost?.B.value, cost, '损失身价要等于它的造价');
  assert.equal(tl.lost?.B.count, 1);
  assert.equal(tl.lost?.A.count, 0, '没死的阵营不该有战损');

  s.turn = 2;
  sampleTurn(s, tl);
  const last = tl.samples[tl.samples.length - 1];
  assert.ok(last);
  assert.equal(last.lostB, cost, '样本里要带上这个累计损失');
  assert.equal(last.deadB, 1);

  // 拆除是主动回收，不算战损
  const own = s.units.find(
    (u) => u.owner === 'A' && s.unitTypes[u.type]?.category !== 'building',
  );
  assert.ok(own);
  s.units = s.units.filter((u) => u.id !== own.id);
  noteDeaths(tl, s, { type: 'DISBAND', unitId: own.id });
  assert.equal(tl.lost?.A.count, 0, '拆自己的兵不是被打死');

  // 出报告前要把内部单位表摘掉，别让它跟着上云
  const sealed = sealTimeline(tl);
  assert.equal(sealed.seen, undefined, 'seal 之后不该还有单位表');
  assert.equal(sealed.samples.length, tl.samples.length, 'seal 不能丢样本');
  assert.ok(sealed.lost, '累计损失要留着');
  assert.ok(timelineSummary(sealed).includes('战损'), '一句话摘要要能看见战损');
});

test('状态与技能注册表：本体表里的每一条都得有人接', () => {
  // 这次重构把状态和技能从 if/switch 改成了查表：表里少一条，游戏里就是
  // "中毒不扣血"或者"点了技能没反应"，而且 tsc 抓不到（effect 现在是 string）。
  // 所以这条用例守的不是数值，是"注册表与数据表对得上"这件事本身。
  // 技能挂在英雄身上，而英雄都在扩展包里：本体 + 各扩展的兵种表合起来扫
  const allDefs = [
    ...Object.values(UNIT_TYPES),
    ...EXPANSIONS.flatMap((e) => e.units ?? []),
  ];
  const skills = allDefs.flatMap((d) => d.skills ?? []);
  assert.ok(skills.length > 0, '整张兵种表里应当有带主动技能的英雄');
  for (const sk of skills) {
    assert.ok(
      SKILL_EFFECTS[sk.effect],
      `${sk.name} 的效果「${sk.effect}」在 SKILL_EFFECTS 里没有处理器`,
    );
  }
  // 四条内置状态是老规矩里的硬数值，注册表里必须都在，且都在一张表上查
  for (const id of ['poison', 'burn', 'slow', 'curse']) {
    const def = STATUS_REGISTRY[id];
    assert.ok(def, `状态 ${id} 没注册进 STATUS_REGISTRY`);
    assert.equal(def.id, id, `${id} 的 def.id 要和键一致，否则战报会说错名字`);
    assert.ok(def.name && def.summary, `${id} 要有名字和一句话说明，界面/战报要用`);
  }
  // 中毒、灼烧负责扣血；减速、诅咒负责改属性。挂反了就是"沉默的状态"
  assert.ok(STATUS_REGISTRY.poison?.onTurnStart, '中毒要在回合开始扣血');
  assert.ok(STATUS_REGISTRY.burn?.onTurnStart, '灼烧要在回合开始扣血');
  assert.ok(STATUS_REGISTRY.slow?.modifyMove, '减速要改移动力');
  assert.ok(STATUS_REGISTRY.curse?.modifyArmor, '诅咒要改护甲');
});

test('状态能改攻击力，面板与结算算的是同一个数', () => {
  // modifyAtk 原本是空挂的：注册了也没人调。现在接在 computeDamage 与
  // effectiveStats 的同一位置（光环之后、乘算之前），两处必须给出同一个数，
  // 否则"面板写 18、打出来 15"会成为常驻的困惑。
  registerStatus({
    id: 'test-rage',
    name: '暴怒',
    summary: '攻击 +5（用例专用）',
    modifyAtk: (_s, _u, val, atk) => (val > 0 ? atk + 5 : atk),
  });
  try {
    // 先抹平这一小片：(4,3) 在 seed 12345 的图上正好压在河身上。
    // 城市改成"纵深多重集"之后河道跟着城位重新走了一遍，这一格从平地变成水，
    // 本用例要测的是"状态如何改数值"，不是"水里能不能站人"，所以先铲平。
    const flat = fresh();
    clearArea(flat, 3, 2, 4, 4);
    const s = unitOn(flat, 'A', 'militia', 3, 3);
    const me = s.units.find((u) => u.owner === 'A' && u.type === 'militia')!;
    const target = unitOn(s, 'B', 'militia', 4, 3).units.find(
      (u) => u.owner === 'B' && u.type === 'militia',
    )!;

    const plainDmg = computeDamage(s, me, target);
    const plainAtk = effectiveStats(s, me).atk;

    me.status = { ...(me.status ?? {}), 'test-rage': 2 };
    const ragedDmg = computeDamage(s, me, target);
    const ragedAtk = effectiveStats(s, me).atk;

    assert.equal(ragedAtk - plainAtk, 5, '面板上的攻击力要 +5');
    assert.equal(ragedDmg - plainDmg, 5, '实际伤害也要 +5（对面护甲为 0 时才严格相等）');

    // 结算顺序固定：四条老状态永远排在扩展注册之前，与字段写入顺序无关
    me.status = { 'test-rage': 2, curse: 1, slow: 1, burn: 1, poison: 1 };
    assert.deepEqual(
      orderedStatuses(me.status).map(([k]) => k),
      ['poison', 'burn', 'slow', 'curse', 'test-rage'],
      '中毒要先于灼烧，老的四条先于扩展状态',
    );
  } finally {
    delete STATUS_REGISTRY['test-rage'];
  }

  // 同 id 再注册必须当场失败：悄悄覆盖等于按 import 顺序决定规则
  assert.throws(
    () => registerStatus({ id: 'poison', name: '假中毒', summary: '占位' }),
    /已经注册过/,
    '重复注册状态要报错',
  );
  assert.throws(
    () => registerSkillEffect('dive', () => {}),
    /已经注册过/,
    '重复注册技能效果要报错',
  );
});

console.log('\n修仙扩展：炼气士');

test('修士：衰老先减益，超龄 3 年进入回光返照', () => {
  const s = fresh({ expansionIds: ['cultivation'], godMode: true });
  const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
  
  qi.custom = { exp: 600 }; 
  assert.equal(cultivationRank(qi), 6, 'exp=600应该是 6 级');
  
  // 35 岁：无衰老
  qi.age = 35;
  const baseAtk = effectiveStats(s, qi).atk;
  const baseArmor = effectiveStats(s, qi).armor;
  
  // 66岁：超 1 岁，攻击 -2，护甲 -1
  qi.age = 66;
  assert.equal(effectiveStats(s, qi).atk, baseAtk - 2, '超 1 岁攻击减 2');
  assert.equal(effectiveStats(s, qi).armor, baseArmor - 1, '超 1 岁护甲减 1');
  
  // 68 岁：超 3 岁，生命归 0 等待清场
  qi.age = 68;
  assert.equal(getAgingYears(qi), 3, '这里超龄 3 岁');
  
  // 模拟回合开始
  const r = applyAction({ ...s, current: 'A', units: [qi] }, { type: 'END_TURN' });
  assert.ok(r.ok);
  const r2 = applyAction(r.state, { type: 'END_TURN' });
  assert.ok(r2.ok);
  
  const doomed = r2.state.units.find(u => u.id === qi.id);
  assert.ok(doomed, '回光返照期间，单位还在场上');
  assert.equal(doomed.hp, 0, '生命值应归 0');
  assert.ok(r2.state.log.some(l => l.text.includes('油尽灯枯')), '战报应提示油尽灯枯');
  
  // 进行任意一次操作（比如结束回合），触发清场
  const r3 = applyAction(r2.state, { type: 'END_TURN' });
  assert.ok(r3.ok);
  assert.ok(!r3.state.units.some(u => u.id === qi.id), '一旦触发清场，应该被移除');
});

test('修士：满级（9 级）永远不会老死', () => {
  const s = fresh({ expansionIds: ['cultivation'], godMode: true });
  const qi = place2(s, 'A', 'qi-cultivator', 5, 5);
  qi.custom = { exp: 20000 }; // 9 级
  qi.age = 9999; // 活了快一万岁

  const r = applyAction({ ...s, current: 'A', units: [qi] }, { type: 'END_TURN' });
  assert.ok(r.ok);
  const r2 = applyAction(r.state, { type: 'END_TURN' });
  assert.ok(r2.ok);

  // 依然活着
  assert.ok(r2.state.units.some(u => u.id === qi.id), '满级修士不应该老死');
  // 也不应该有油尽灯枯的减益
  assert.equal(getAgingYears(r2.state.units.find(u => u.id === qi.id)!), 0, '满级修士不减益');
});

test('修士：溅射半径随境界成长（x/4）', () => {
  // 用一个工厂函数清理地图并摆好阵列，避免重复代码
  const setup = () => {
    const s = fresh({ expansionIds: ['cultivation'], godMode: true });
    // 清空一块平地
    for (let y = 3; y <= 7; y++) {
      for (let x = 4; x <= 10; x++) {
        s.tiles[y * s.w + x] = { terrain: 'plain', cityId: null };
      }
    }
    s.unitTypes['target'] = { ...s.unitTypes.militia, id: 'target', armor: 0, maxHp: 1000, abilities: [] };
    
    // 靶子阵列：主目标 (5,5)，副目标1 (6,5) 距离 1，副目标2 (7,5) 距离 2
    const main = place2(s, 'B', 'target', 5, 5); main.hp = 1000;
    const near = place2(s, 'B', 'target', 6, 5); near.hp = 1000;
    const far  = place2(s, 'B', 'target', 7, 5); far.hp = 1000;
    
    // 修士在 (5,4)，距离主目标 1 格
    const qi = place2(s, 'A', 'qi-cultivator', 5, 4);
    qi.custom = { lifespan: 100 };
    
    return { s, qi, main, near, far };
  };

  {
    const { s, qi, main, near, far } = setup();
    qi.custom.exp = 8;
    const r = applyAction({ ...s, current: 'A', units: [qi, main, near, far] }, { type: 'ATTACK', unitId: qi.id, targetId: main.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.equal(r.state.units.find(u => u.id === near.id)!.hp, 1000, 'x=3 没有溅射');
  }

  {
    const { s, qi, main, near, far } = setup();
    qi.custom.exp = 250;
    const r = applyAction({ ...s, current: 'A', units: [qi, main, near, far] }, { type: 'ATTACK', unitId: qi.id, targetId: main.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.ok(r.state.units.find(u => u.id === near.id)!.hp < 1000, 'x=4 应该波及距离 1 的敌人');
    assert.equal(r.state.units.find(u => u.id === far.id)!.hp, 1000, 'x=4 够不到距离 2 的敌人');
  }

  // 3. x=8，半径 2：near 和 far 全波及
  {
    const { s, qi, main, near, far } = setup();
    qi.custom.exp = 2000;
    const r = applyAction({ ...s, current: 'A', units: [qi, main, near, far] }, { type: 'ATTACK', unitId: qi.id, targetId: main.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.ok(r.state.units.find(u => u.id === near.id)!.hp < 1000, 'x=8 波及距离 1');
    assert.ok(r.state.units.find(u => u.id === far.id)!.hp < 1000, 'x=8 波及距离 2');
  }
});

test('溅射：单位自带比例时按自己的算，缺省仍是 50%', () => {
  // 2026-10-29 起溅射比例不再写死在 CONFIG 里：单位 `custom.splashRatio`
  // 存在就用它自己的。半径同理，交给扩展的 modifySplash（修士按境界）。
  const build = (ratio?: number) => {
    const s = fresh();
    s.current = 'A';
    s.units = [];
    const mortar = place(s, 'A', 'mortar', 5, 5);
    if (ratio !== undefined) mortar.custom = { ...(mortar.custom ?? {}), splashRatio: ratio };
    const main = place(s, 'B', 'militia', 7, 5);
    const side = place(s, 'B', 'militia', 8, 5);
    const wide = place(s, 'B', 'militia', 10, 5);
    return { s, mortar, main, side, wide };
  };

  // 1. 没设比例：用全局默认；半径取兵种表
  const base = build();
  assert.equal(splashRatioOf(base.mortar), CONFIG.splashRatio, '没设比例时应该走全局默认');
  assert.equal(splashRadiusOf(base.s, base.mortar), UNIT_TYPES.mortar!.splash, '半径取兵种表里的基数');
  // 写 0 不算"按 0 结算"，而是"没设"——否则一个手滑就让这门炮变成没有溅射伤害
  const zero = build(0);
  assert.equal(splashRatioOf(zero.mortar), CONFIG.splashRatio, '比例写 0 应该退回默认值');

  // 2. 设了比例：按它自己的算，且真的落到伤害上
  const quarter = build(0.25);
  assert.equal(splashRatioOf(quarter.mortar), 0.25);
  const full = computeDamage(quarter.s, quarter.mortar, quarter.main);
  const expected = Math.floor(computeDamage(quarter.s, quarter.mortar, quarter.side) * 0.25);
  assert.ok(expected > 0, '这个配置下 25% 也该有伤害');
  const r = applyAction(quarter.s, { type: 'ATTACK', unitId: quarter.mortar.id, targetId: quarter.main.id });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  if (!r.ok) return;
  const hp = (id: string) => r.state.units.find((u) => u.id === id)?.hp;
  const maxHp = UNIT_TYPES.militia?.maxHp ?? 0;
  assert.equal(hp(quarter.main.id), maxHp - full, '主目标照旧吃满');
  assert.equal(hp(quarter.side.id), maxHp - expected, '旁边那格按 25% 结算，而不是默认的 50%');
});

test('多动：自动开火的建筑也把这一回合的次数打满', () => {
  // 手动点能点 N 下，交给它自己打只打一下——同一座塔两套火力，
  // 玩家就只能被迫每回合手点。这条用例盯的就是这个缝。
  const s = fresh({ godMode: true });
  s.units = [];
  for (const [x, y] of [[5, 5], [6, 5], [6, 4], [4, 5]]) {
    s.tiles[idx(s, x, y)].terrain = 'plain';
  }
  // 一座三连发的哨塔（拿民兵当底子改，避免依赖某个扩展包的具体兵种）
  s.unitTypes['test-tower'] = {
    ...s.unitTypes.militia,
    id: 'test-tower',
    category: 'building',
    autoAttack: true,
    move: 0,
    burst: 3,
    atk: 20,
    armor: 0,
    maxHp: 200,
    range: 3,
    abilities: [],
  };
  const tower = place2(s, 'A', 'test-tower', 5, 5);
  const e1 = place2(s, 'B', 'militia', 6, 5);
  const e2 = place2(s, 'B', 'militia', 6, 4);
  e1.hp = 500;
  e2.hp = 500;
  s.current = 'A';
  refreshMemory(s);

  const single = computeDamage(s, tower, e1);
  const total0 = e1.hp + e2.hp;
  // A 结束回合 → B 的回合开始 → A 的塔自动开火
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const after = r.state.units.filter((u) => u.owner === 'B');
  const total1 = after.reduce((a, u) => a + u.hp, 0);
  assert.equal(total0 - total1, single * 3, '自动开火要打满 3 次，不是只打 1 次');
});

test('隐匿改充能：一池 3 发、每回合最多一次、每 2 个自己的回合回一发', () => {
  const s = arena(fresh({ expansionIds: FANTASY, godMode: true }));
  const killer = place2(s, 'A', 'assassin-master', 5, 5);
  // B 也得有兵：没有城、又没有任何单位的一方会被判负，回合就推不下去了
  place2(s, 'B', 'militia', 8, 8);
  s.current = 'A';

  // applyAction 是"克隆改完再还给你"的语义，所以这里一路往下接 r.state，
  // 别对着最初那个 s 继续断言——读到的会是放技能之前的快照。
  let cur = s;
  const me = (): Unit => cur.units.find((u) => u.id === killer.id)!;
  const view = (): { charge: number; ready: boolean; toNext: number } => {
    const k = heroSkillsOf(cur, me()).find((x) => x.def.id === 'vanish')!;
    return { charge: k.charge, ready: k.ready, toNext: k.toNext };
  };
  const doAction = (a: Parameters<typeof applyAction>[1]): ReturnType<typeof applyAction> => {
    const r = applyAction(cur, a);
    if (r.ok) cur = r.state;
    return r;
  };

  assert.equal(view().charge, 3, '没放过＝满发（老存档缺这个字段也走这条路）');
  assert.equal(view().ready, true, '满发时就应该能放');

  /** 走完一整个来回：A 结束 → B 结束 → 又轮到 A（A 的回合开始会回充） */
  const round = (): void => {
    for (let i = 0; i < 2; i++) {
      const r = doAction({ type: 'END_TURN' });
      assert.ok(r.ok, r.ok ? '' : r.reason);
      cur.winner = null; // 用例只关心技能，别被胜负判定打断
    }
  };

  const use = (): void => {
    const r = doAction({ type: 'HERO_SKILL', unitId: killer.id, skillId: 'vanish' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    // 同一回合再放一次必须被拒：充能没有冷却，"一回合只能一次"要单独守住，
    // 否则攒下的三发能在同一回合连开——那不是攒着用，是一回合无敌三回合
    const twice = doAction({ type: 'HERO_SKILL', unitId: killer.id, skillId: 'vanish' });
    assert.equal(twice.ok, false, '一回合只能放一次技能');
  };

  use();
  assert.equal(view().charge, 2, '放一发少一发');
  round();
  assert.equal(view().charge, 2, '才过了一个自己的回合，还没到回充的点');
  assert.equal(view().toNext, 1, '还差 1 个回合回一发');
  round();
  assert.equal(view().charge, 3, '满发之后不再往上加');

  // 打空的样子：直接把发数写成 0（连开三次不现实——一回合只能一次，
  // 而排到第三次时前面早就回了一发）。这里要验的是"没发数时怎么说"，
  // 以及"回充是不是真的按每 2 个自己的回合走"。
  me().skillCharge = { vanish: { n: 0, t: 0 } };
  assert.equal(view().charge, 0, '三发打完');
  assert.equal(view().ready, false, '没发了就不能放');
  assert.equal(view().toNext, 2, '空的时候要等满 2 个回合');
  const denied = doAction({ type: 'HERO_SKILL', unitId: killer.id, skillId: 'vanish' });
  assert.equal(denied.ok, false, '没发数时点下去要被拒');
  assert.ok(
    !denied.ok && denied.reason.includes('回合后回一发'),
    `拒的时候要说清还要等多久，实际：${!denied.ok ? denied.reason : ''}`,
  );

  round();
  assert.equal(view().charge, 0, '第一个回合还不够');
  round();
  assert.equal(view().charge, 1, '两个自己的回合回一发');
  assert.equal(view().ready, true, '回上一发就该能放');
});

test('投降同步：云端说终局了，本机就算没轮到自己、还有草稿也要装进来', () => {
  const head = (turn: number, current: 'A' | 'B', winner: 'A' | 'B' | null) => ({
    turn,
    current,
    winner,
  });

  // 认输不换人、不推进回合：这一条就是那个事故的正面用例
  const surrendered = adoptDecision(head(7, 'A', 'B'), head(7, 'A', null), { seat: 'B' });
  assert.equal(surrendered.take, true, '对面投降了，我这边必须收到');
  assert.equal(surrendered.take && surrendered.why, 'finished');

  // 草稿也挡不住终局：这局已经结了，未提交的走法没有意义
  const withDraft = adoptDecision(head(7, 'A', 'B'), head(7, 'A', null), {
    seat: 'B',
    draft: true,
  });
  assert.equal(withDraft.take, true, '终局压倒未提交的草稿');

  // 平时怎么挡还是怎么挡
  assert.equal(
    adoptDecision(head(8, 'A', null), head(7, 'A', null), { seat: 'B' }).take,
    false,
    '没轮到我就不拉',
  );
  assert.equal(
    adoptDecision(head(8, 'B', null), head(7, 'A', null), { seat: 'B', draft: true }).take,
    false,
    '有草稿就不覆盖',
  );
  assert.equal(
    adoptDecision(head(8, 'B', null), head(7, 'A', null), { seat: 'B' }).take,
    true,
    '轮到我、没草稿、回合变了：就该拉',
  );

  // 观战位没有"轮到我"这回事，只看有没有新东西
  assert.equal(
    adoptDecision(head(7, 'A', null), head(7, 'A', null), { seat: 'A', spectator: true }).take,
    false,
    '什么都没变就别重绘',
  );
  assert.equal(
    adoptDecision(head(7, 'A', 'B'), head(7, 'A', null), { seat: 'A', spectator: true }).why,
    'finished',
    '观战位也要看见终局',
  );
});

test('聊天文本清洗：去控制字符、压空白、截断，空串不放行', () => {
  assert.equal(trimChatBody('  gg  '), 'gg', '首尾空白去掉');
  assert.equal(trimChatBody('上\t\t路\n\n快点'), '上 路 快点', '换行/制表压成一个空格：聊天框不是记事本');
  assert.equal(trimChatBody('好的\u0000\u0007'), '好的', '控制字符不能带进去');
  assert.equal(trimChatBody('   '), '', '全是空格＝这条不该发');
  assert.equal(trimChatBody(''), '', '空串同样不放行');
  const long = trimChatBody('字'.repeat(500));
  assert.equal(long.length, CHAT_MAX_LEN, `超长要截到 ${CHAT_MAX_LEN} 字`);

  // 归属标签站在"我"的角度写：屏幕两边都写着同样的名字，用 A/B 会看不懂
  assert.equal(chatWhoLabel('A', 'A'), '我方');
  assert.equal(chatWhoLabel('B', 'A'), '对方');
  assert.equal(chatWhoLabel('watch', 'A'), '观众');
  assert.equal(chatWhoLabel('watch', 'watch'), '观众');
});

test('聊天记录：转义、三种归属、空态', () => {
  const lines: ChatLine[] = [
    { id: 1, seat: 'A', name: '红方', body: '打个赌？', at: '2026-10-29T20:31:00Z' },
    { id: 2, seat: 'B', name: '蓝方', body: '<b>不赌</b>', at: '2026-10-29T20:32:00Z' },
    { id: 3, seat: 'watch', name: '观众', body: '好看', at: '2026-10-29T20:33:00Z' },
  ];
  const mine = chatLinesHtml(lines, 'A');
  assert.ok(mine.includes('我方'), '自己的消息标"我方"');
  assert.ok(mine.includes('对方'), '对面的消息标"对方"');
  assert.ok(mine.includes('观众'), '观战者的消息要照常显示');
  assert.ok(!mine.includes('<b>不赌</b>'), '消息里的标签必须转义，否则一条消息就能改界面');
  assert.ok(mine.includes('&lt;b&gt;不赌&lt;/b&gt;'), '转义之后原样显示');
  assert.ok(mine.includes('20:31'), '带时分，不然分不清谁先说的');

  const empty = chatLinesHtml([], 'A');
  assert.ok(empty.includes('chat-empty'), '空的时候要有一句话，不要留一块空白');
});

test('超长消息不发出去，而不是截一半发出去', () => {
  // `maxlength` 是输入框自己在拦，输入法和粘贴并不总是听话。
  // 真超了就"不发、字留在框里"——对面收到半句还以为那就是全文，比拒发糟得多。
  assert.equal(chatBodyOverflows('字'.repeat(CHAT_MAX_LEN)), false, '刚好到上限不算超');
  assert.equal(chatBodyOverflows('字'.repeat(CHAT_MAX_LEN + 1)), true, '多一个字就要拦');
  assert.equal(chatBodyOverflows(`  ${'字'.repeat(CHAT_MAX_LEN)}  `), false, '首尾空白不占额度');
  assert.equal(chatBodyOverflows(`${'字'.repeat(CHAT_MAX_LEN)}\n\n\n`), false, '换行先压平成空格再算');
  // 提示里那个"现在 N 字"要算上会被截掉的部分，否则永远显示 120，等于没说话
  assert.equal(chatBodyLength('字'.repeat(CHAT_MAX_LEN + 5)), CHAT_MAX_LEN + 5);
  assert.equal(chatBodyLength('  好 的  '), 3, '数的是清洗之后的字数');
});

test('聊天水位只由服务器推：两个人同时说话不能丢', () => {
  // 这条盯的是一个真实事故：以前"收进一行就把水位推到它的 id"，
  // 包括自己刚发出去的那一条。于是：
  //   上次拉到 99 → 对方发了 100（还没拉）→ 我发了 101，水位立刻变 101
  //   → 下一轮问 `id > 101`，100 永远拉不回来。
  // 表现是"对面说的我这边缺一句"，刷新一次又都在——最容易被当成网络问题那种。
  const feed = new ChatFeed();
  const line = (id: number, body: string): ChatLine => ({
    id,
    seat: id % 2 ? 'A' : 'B',
    name: 'x',
    body,
    at: '2026-10-29T20:31:00Z',
  });

  feed.accept([line(99, '开局')]);
  assert.equal(feed.lastId, 99, '拉到 99 之后水位就是 99');

  // 对方发了 100，我发了 101：我这条先显示，但水位不能跟着跳
  feed.adopt(line(101, '我这句'));
  assert.equal(feed.lastId, 99, '自己发的那条不能推水位，否则夹在中间的 100 会被跳过');
  assert.equal(feed.lines.length, 2, '自己发的要立刻显示');

  // 下一轮照常从 99 往后拉，100 和 101 都回来了
  const got = feed.accept([line(100, '对方那句'), line(101, '我这句')]);
  assert.equal(got.length, 1, '101 要按 id 去重，不能显示两遍');
  assert.equal(
    feed.lines.map((l) => l.id).join(','),
    '99,100,101',
    '三条都在，而且按 id 排好——自己那条是提前显示的，不能排在别人更早那句前面',
  );
  assert.equal(feed.lastId, 101, '这一页跑完了，水位才推到 101');

  // 一页里有多条时只推一次，且推的是这一页的最大 id（不是"新的那几条"的最大 id）
  const more = feed.accept([line(102, 'a'), line(103, 'b'), line(104, 'c')]);
  assert.equal(more.length, 3);
  assert.equal(feed.lastId, 104);

  // 退出房间要清干净，否则换一局会看到上一局的话
  feed.reset();
  assert.equal(feed.lastId, 0);
  assert.equal(feed.lines.length, 0);
});

console.log('\n行动点扩展');

/** 找一格空着的平地：摆兵用例不该赌某张图上有水 */
function freePlain(s: GameState): { x: number; y: number } {
  for (let k = 0; k < s.w * s.h; k++) {
    const x = k % s.w;
    const y = Math.floor(k / s.w);
    const t = s.tiles[k];
    if (!t || t.terrain !== 'plain' || t.cityId) continue;
    if (s.units.some((u) => u.x === x && u.y === y)) continue;
    return { x, y };
  }
  throw new Error('整张图没有一格空着的平地');
}

test('行动点：单价表——骑兵与车机动 −5、近战出手 −10，两类能叠加', () => {
  // 名单里的 id 必须真的存在。改兵种 id、写错字，都会在这里当场变红——
  // 一份"看起来配了、实际一个都没命中"的表，比不配更糟。
  const known = new Set<string>([
    ...Object.keys(UNIT_TYPES),
    ...EXPANSIONS.flatMap((e) => (e.units ?? []).map((u) => u.id)),
  ]);
  for (const id of [...MOUNTED_IDS, ...VEHICLE_IDS]) {
    assert.ok(known.has(id), `名单里的 ${id} 不在任何兵种表里`);
  }

  // 斥候两头都占：骑兵（机动便宜）+ 近战（出手便宜）——这正是规则要的效果
  assert.deepEqual(apClassesOf(UNIT_TYPES.scout, 'scout').sort(), ['melee', 'mounted']);
  assert.equal(apActionCost(UNIT_TYPES.scout, 'scout', 'move'), AP_COST.move - 5);
  assert.equal(apActionCost(UNIT_TYPES.scout, 'scout', 'attack'), AP_COST.attack - 10);

  // 坦克只是车，射程够远所以不算近战
  assert.deepEqual(apClassesOf(UNIT_TYPES.tank, 'tank'), ['vehicle']);
  assert.equal(apActionCost(UNIT_TYPES.tank, 'tank', 'move'), AP_COST.move - 5);
  assert.equal(apActionCost(UNIT_TYPES.tank, 'tank', 'attack'), AP_COST.attack);

  // 弓手两样都不吃
  assert.deepEqual(apClassesOf(UNIT_TYPES.archer, 'archer'), []);
  assert.equal(apActionCost(UNIT_TYPES.archer, 'archer', 'move'), AP_COST.move);
  assert.equal(apActionCost(UNIT_TYPES.archer, 'archer', 'attack'), AP_COST.attack);

  // 池子按兵种分档：斥候是骑兵 → 120，弓手是远程 → 110，民兵是步兵 → 100
  assert.equal(apMaxOf(UNIT_TYPES.scout, 'scout'), AP_BY_TIER.mounted);
  assert.equal(apMaxOf(UNIT_TYPES.archer, 'archer'), AP_BY_TIER.ranged);
  assert.equal(apMaxOf(UNIT_TYPES.militia, 'militia'), AP_BY_TIER.base);
});

test('行动点：先手第一回合就开账，驻扎 / 移动 / 出手各记各的', () => {
  const s = fresh({ expansionIds: ['action-points'] }, 2024);
  const { a } = duel(s);
  // duel 把单位挪过去之后，开账时的站位就对不上了——重新钉一次，
  // 这样"这一回合还没动过"才是真的
  a.custom = { ap: { turn: s.turn, x: a.x, y: a.y, debt: 0, over: 0 } };
  // onMatchStart 已经把先手方的账开了——第一回合不走 onTurnStart
  const open = apLedger(s, a);
  assert.equal(open.settled, true, '先手第一回合也要开账');
  assert.deepEqual(open.items.map((i) => i.action), [], '什么都没干＝不扣（驻扎已取消）');
  assert.equal(open.left, open.start, '池子原样留着');

  // 走一步：记成移动，不是驻扎
  const dest = [...reachableTiles(s, a).keys()].find((k) => k !== idx(s, a.x, a.y));
  assert.ok(dest !== undefined, '应该至少有一格可走');
  const r = applyAction(s, { type: 'MOVE', unitId: a.id, x: dest! % s.w, y: Math.floor(dest! / s.w) });
  assert.ok(r.ok, r.ok ? '' : `走不动：${r.reason}`);
  const moved = r.state.units.find((u) => u.id === a.id)!;
  const L = apLedger(r.state, moved);
  assert.deepEqual(L.items.map((i) => i.action), ['move'], '走过就只记移动');
  assert.equal(
    L.left,
    apMaxOf(s.unitTypes.militia, 'militia') - apActionCost(s.unitTypes.militia, 'militia', 'move'),
  );
});

test('行动点：攻击按次扣，次数被 E 压回，打满就扣不动了', () => {
  const s = fresh({ expansionIds: ['action-points'] }, 2024);

  // 机枪队 burst 3：每段 40/3 ≈ 13.33，池子买得起 3 段 → 这一回合打满 3 次
  const spot = freePlain(s);
  const placed = placeUnit(s, 'A', 'mg', spot.x, spot.y);
  assert.ok(placed.ok, placed.ok ? '' : placed.reason);
  const mg = placed.state.units.find((u) => u.type === 'mg')!;
  mg.custom = { ap: { turn: placed.state.turn, x: mg.x, y: mg.y, debt: 0, over: 0 } };
  assert.equal(attacksPerTurn(placed.state, mg), 3, 'burst 3 每段只收 1/3 的价，池子够打满');
  assert.equal(apLedger(placed.state, mg).attacksAllowed, 3);

  // 民兵（近战，每次 30E）打一下，账上写 30
  const st = fresh({ expansionIds: ['action-points'] }, 2024);
  const { a: atk, b: foe } = duel(st);
  atk.custom = { ap: { turn: st.turn, x: atk.x, y: atk.y, debt: 0, over: 0 } };
  const hit = applyAction(st, { type: 'ATTACK', unitId: atk.id, targetId: foe.id });
  assert.ok(hit.ok, hit.ok ? '' : `打不着：${hit.reason}`);
  const after = hit.state.units.find((u) => u.id === atk.id)!;
  const L = apLedger(hit.state, after);
  assert.deepEqual(L.items.map((i) => i.action), ['attack']);
  assert.equal(L.spent, apActionCost(st.unitTypes.militia, 'militia', 'attack'), '近战一下 30E');
});

test('行动点：E 不够时走不动（modifyMove 归零），技能与保底首击记成透支', () => {
  const s = fresh({ expansionIds: ['action-points'] }, 2024);
  const { a, b } = duel(s);

  // 欠 85E：起点 15，连驻扎那 20 都付不起 —— 池子见底
  a.custom = { ap: { turn: s.turn, x: a.x, y: a.y, debt: 85, over: 0 } };
  assert.equal(apLedger(s, a).start, 15);
  assert.equal(movePower(s, a), 0, 'E 见底就是动不了（返回 0 是引擎认的口径）');
  const mv = applyAction(s, { type: 'MOVE', unitId: a.id, x: b.x, y: b.y + 2 });
  assert.equal(mv.ok, false, '走不动要真的走不动');

  // 欠 75E：起点 25，买不起一次 30E 的出手，但引擎的首次攻击拦不住 ——
  // 账要记：这一下算 30，透支 5，下回合起点变 95
  const s2 = fresh({ expansionIds: ['action-points'] }, 2024);
  const { a: a2, b: b2 } = duel(s2);
  a2.custom = { ap: { turn: s2.turn, x: a2.x, y: a2.y, debt: 75, over: 0 } };
  assert.equal(apLedger(s2, a2).attacksAllowed, 0, '25E 买不起 30E 的一击');
  const atk = applyAction(s2, { type: 'ATTACK', unitId: a2.id, targetId: b2.id });
  assert.ok(atk.ok, '引擎会在第一次攻击时把次数兜底成 1，扩展拦不住——这条边界写在文档里');
  const spent = apLedger(atk.state, atk.state.units.find((u) => u.id === a2.id)!);
  assert.equal(spent.over, 5, '超支的 5 点要记成透支');

  const end = applyAction(atk.state, { type: 'END_TURN' });
  const marked = end.state.units.find((u) => u.id === a2.id)!;
  assert.equal((marked.custom as { ap: { over: number } }).ap.over, 5, '回合结束时把透支钉在单位上');
  assert.ok(
    end.state.log.some((l) => l.text.includes('透支行动 5 E')),
    '战报要说清透支了多少',
  );

  const back = applyAction(end.state, { type: 'END_TURN' });
  const next = apLedger(back.state, back.state.units.find((u) => u.id === a2.id)!);
  assert.equal(next.start, next.max - 5, '下回合起点先扣掉透支');
  assert.equal(next.debt, 5);
});

test('行动点：建筑不参与，刚上场的单位按满池且不被拦', () => {
  const s = fresh({ expansionIds: ['action-points'] }, 2024);
  const wall = freePlain(s);
  const built = placeUnit(s, 'A', 'tower', wall.x, wall.y);
  assert.ok(built.ok, built.ok ? '' : built.reason);
  const tower = built.state.units.find((u) => u.type === 'tower')!;
  const L = apLedger(built.state, tower);
  assert.equal(L.active, false, '城墙不会"走"也不会"驻扎"');
  const lines = expansionById('action-points')!.hooks.getUnitPanelLines!({
    state: built.state,
    unit: tower,
  });
  assert.deepEqual(lines, [], '建筑的面板上不出现行动点');

  // 刚招出来的单位还没开账：按满池显示，而且不拦它（它本来就 acted）
  const open = freePlain(built.state);
  const recruit = placeUnit(built.state, 'A', 'militia', open.x, open.y);
  assert.ok(recruit.ok, recruit.ok ? '' : recruit.reason);
  const rookie = recruit.state.units.find(
    (u) => u.type === 'militia' && u.x === open.x && u.y === open.y,
  )!;
  const rl = apLedger(recruit.state, rookie);
  assert.equal(rl.settled, false);
  assert.equal(rl.left, rl.start);
});

console.log('\n海军扩展');

test('海军：两个包都注册上，兵种全是水面单位', () => {
  const fleet = expansionById('naval-fleet');
  const modern = expansionById('naval-modern');
  assert.ok(fleet && modern, '海军两包应该都在注册表里');

  const ids = new Set(allAbilities().map((a) => a.id));
  for (const u of [...(fleet!.units ?? []), ...(modern!.units ?? [])]) {
    assert.equal(u.domain, 'water', `${u.name} 应该只能待在水里`);
    assert.ok(u.era >= 2 && u.era <= 6, `${u.name} 的时代 ${u.era} 越界`);
    assert.ok(u.cost > 0 && u.maxHp > 0 && u.move >= 0, `${u.name} 的数值不合法`);
    assert.equal(u.short.length, 1, `${u.name} 的图标应该是一个字`);
    for (const a of u.abilities ?? []) {
      assert.ok(ids.has(a), `${u.name} 引用了不存在的能力 ${a}`);
    }
  }

  // 第六时代要补够：这一代水面力量原本只有一条导弹驱逐舰
  const era6 = (modern!.units ?? []).filter((u) => u.era === 6);
  assert.ok(era6.length >= 5, `现代海军应该补出至少 5 条六代船，现在 ${era6.length} 条`);
  assert.ok(era6.some((u) => u.id === 'nv_carrier'), '六代船里必须有航母');
});

test('海军：现代海军依赖「现代」，单勾它一条船都造不出来', () => {
  const modern = expansionById('naval-modern')!;
  assert.deepEqual(modern.requires, ['pack-contemporary']);

  const alone = createMatch(
    { ...DEFAULT_CONFIG, size: 12, startEra: 6, expansionIds: ['naval-modern'] },
    5150,
  );
  assert.ok(!alone.unitTypes['nv_carrier'], '前置没开时航母不该出现在兵种表里');

  const withBase = createMatch(
    { ...DEFAULT_CONFIG, size: 12, startEra: 6, expansionIds: ['pack-contemporary', 'naval-modern'] },
    5151,
  );
  assert.ok(withBase.unitTypes['nv_carrier'], '开了「现代」之后航母才该在');
});

test('海战：封锁让被堵的城少收 8 金，三座封顶', () => {
  const s = fresh({ expansionIds: ['naval-fleet'] });
  const mine = s.cities.filter((c) => c.owner === 'B');
  assert.ok(mine.length >= 1, '这条用例需要 B 方至少有城');

  const base = incomeOf(s, 'B');
  // 找一格贴着 B 城的空地改成水面，停一条船上去
  const city = mine[0]!;
  const spot = { x: city.x - 1, y: city.y };
  if (spot.x < 0) return; // 城贴着左边界就跳过（地图是随机的）
  putTerrain(s, spot.x, spot.y, 'water');
  place(s, 'A', 'gunboat', spot.x, spot.y);
  assert.equal(incomeOf(s, 'B'), base - 8, '被封锁的一座城应该少交 8 金');

  // 第二座、第三座：继续掉，到 24 封顶
  const second = mine[1];
  if (second) {
    putTerrain(s, second.x - 1, second.y, 'water');
    place(s, 'A', 'gunboat', second.x - 1, second.y);
    assert.equal(incomeOf(s, 'B'), base - 16, '两座城被堵就是 −16');
  }
  for (const c of mine.slice(2)) {
    putTerrain(s, c.x - 1, c.y, 'water');
    place(s, 'A', 'gunboat', c.x - 1, c.y);
  }
  const capped = incomeOf(s, 'B');
  assert.ok(capped >= base - 24, `封锁最多 −24，实际 ${base - capped}`);
});

test('海战：船贴着自家城每回合回 4 点，两个包同开也只回 4', () => {
  const run = (ids: string[]) => {
    const s = fresh({ expansionIds: ids });
    const home = s.cities.find((c) => c.owner === 'A')!;
    const spot = { x: home.x - 1, y: home.y };
    putTerrain(s, spot.x, spot.y, 'water');
    const boat = place(s, 'A', 'gunboat', spot.x, spot.y);
    boat.hp = 20;
    s.current = 'B'; // 结束 B 的回合 → 轮到 A，触发 A 的回合开始
    const r = applyAction(s, { type: 'END_TURN' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    return r.state.units.find((u) => u.id === boat.id)!.hp - 20;
  };

  assert.equal(run(['naval-fleet']), 4, '停在自家港口应该回 4');
  // 两包的钩子都会跑一遍，哨兵要保证不会回 8
  assert.equal(run(['naval-fleet', 'pack-contemporary', 'naval-modern']), 4, '两个包同时开也只回 4');
});

test('潜航：迷雾局里贴脸才现形，不开迷雾一律可见', () => {
  const s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: ['pack-contemporary', 'naval-modern'] },
    6060,
  );
  s.units = [];
  for (let y = 6; y <= 10; y++) for (let x = 5; x <= 11; x++) putTerrain(s, x, y, 'water');
  s.fog = true;
  const sub = place(s, 'A', 'nv_attack_sub', 6, 6);
  const foe = place(s, 'B', 'militia', 10, 6);
  assert.ok(isHiddenFrom(s, sub, 'B'), '隔着四格，潜艇应该藏得住');
  foe.x = 7; // 贴到相邻
  foe.y = 6;
  assert.ok(!isHiddenFrom(s, sub, 'B'), '贴脸就该现形');
  s.fog = false;
  assert.ok(!isHiddenFrom(s, sub, 'B'), '没有迷雾就没有"看不见"这回事');
});

test('岸轰：同一条船带不带这条能力，攻城差 25%', () => {
  const s = fresh({ expansionIds: ['naval-fleet'] });
  const city = s.cities.find((c) => c.owner === 'B')!;
  putTerrain(s, city.x - 1, city.y, 'water');
  const monitor = place(s, 'A', 'nv_monitor', city.x - 1, city.y);

  const withBombard = damageToCity(monitor, city, s);
  const def = s.unitTypes['nv_monitor']!;
  s.unitTypes['nv_monitor'] = { ...def, abilities: [] };
  const plain = damageToCity(monitor, city, s);

  assert.ok(withBombard > plain, `带岸轰(${withBombard}) 应该高于不带(${plain})`);
  const expected = Math.round(plain * 1.25);
  // 因为 plain 是取整后的，游戏内是浮点数，允许 1 点精度误差
  assert.ok(
    Math.abs(withBombard - expected) <= 1, 
    `带岸轰(${withBombard}) 应该比不带(${plain}) 高约 25%，预期约 ${expected}`
  );
});

test('大型单位：航母占 2×2，能移动，但进不了一格宽的水道', () => {
  const s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: ['pack-contemporary', 'naval-modern'] },
    4242,
  );
  s.fog = false;
  s.units = [];
  // 一大片开阔水域
  for (let y = 6; y <= 12; y++) for (let x = 4; x <= 12; x++) putTerrain(s, x, y, 'water');
  // 一条一格宽的水道，从 (2,9) 往上通到 (2,6)
  for (let y = 4; y <= 10; y++) putTerrain(s, 2, y, 'water');

  const def = s.unitTypes['nv_carrier']!;
  assert.equal(def.footprint, 2, '航母必须是 2×2');
  const carrier = place(s, 'A', 'nv_carrier', 6, 8);
  s.current = 'A';

  // 四格都占着，四格都别想站人
  assert.equal(tilesOfUnit(s, carrier).length, 4, '2×2 应该占四格');
  for (const t of tilesOfUnit(s, carrier)) {
    assert.ok(unitAt(s, t.x, t.y), `(${t.x},${t.y}) 应该被航母占着`);
  }

  const reach = reachableTiles(s, carrier);
  assert.ok(reach.size > 0, '2×2 的单位必须能移动，不能退回"不会动"');

  // 每一个可达锚点，四格都得是水面——水道一格宽，塞不进 2×2
  for (const i of reach.keys()) {
    const x = i % s.w;
    const y = Math.floor(i / s.w);
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        assert.equal(
          s.tiles[(y + dy) * s.w + (x + dx)]!.terrain,
          'water',
          `锚点 (${x},${y}) 的四格里有不是水的，说明判定漏了一格`,
        );
      }
    }
  }

  const moved = applyAction(s, { type: 'MOVE', unitId: carrier.id, x: 7, y: 8 });
  assert.ok(moved.ok, moved.ok ? '' : `航母挪一格失败：${moved.reason}`);
  if (!moved.ok) return;
  const after = moved.state.units.find((u) => u.id === carrier.id)!;
  assert.equal(after.x, 7);
  assert.equal(unitAt(moved.state, 6, 8), undefined, '挪走之后原锚点该空出来');
  assert.ok(unitAt(moved.state, 8, 9), '新位置的四格都要占住');
});

test('航母甲板：没接入空军时明说，接入之后收放计数正确', () => {
  const carrier = {
    id: 'c1',
    type: 'nv_carrier',
    owner: 'A' as const,
    x: 0,
    y: 0,
    hp: 260,
    kills: 0,
    moved: false,
    acted: false,
  };

  assert.equal(deckSpecOf('nv_carrier')!.capacity, 4, '航母应该有四个机位');
  assert.equal(deckSpecOf('gunboat'), null, '没登记的船没有甲板');

  // 这条用例守的是**契约**，不是空军包本身：先把真实的实现摘掉，
  // 单独验"没人接入时面板怎么说"。不摘的话跑完空军那几条用例再跑这条，
  // 甲板上会挂着「舰载航空兵」，断言就变成在测另一件事了。
  const real = airwingOps();
  registerAirwingOps(null);
  assert.equal(deckLine(carrier), '甲板 0 / 4 · 空军扩展未接入（航母暂时只当指挥舰）');

  // 收两架进去
  const plane = (id: string) => ({ ...carrier, id, type: 'fake-plane', hp: 40, kills: 0 });
  assert.ok(stowPlane(carrier, plane('p1')));
  assert.ok(stowPlane(carrier, plane('p2')));
  assert.equal(deckUsed(carrier), 2);
  assert.equal(deckOf(carrier)[1]!.type, 'fake-plane');

  // 接入一个假的空军实现：面板立刻改名
  registerAirwingOps({
    id: 'test-air',
    name: '测试舰载航空兵',
    canBoard: () => true,
    launch: () => ({ ok: true }),
    recover: () => ({ ok: true }),
  });
  assert.equal(deckLine(carrier), '甲板 2 / 4 · 测试舰载航空兵');

  // 注销之后要退回"未接入"，不能残留；再还原成真实实现，别把后面几条用例弄脏
  registerAirwingOps(null);
  assert.ok(deckLine(carrier)!.includes('未接入'), '注销之后要退回"未接入"，不能残留');
  registerAirwingOps(real);

  // 取下一架：按索引，取完就少一个
  const taken = popPlane(carrier, 0);
  assert.ok(taken, '应该取得出一架');
  assert.equal(deckUsed(carrier), 1);
  assert.equal(popPlane(carrier, 5), null, '越界取不到东西');
});

test('航母甲板：回合开始会把"整备"这个时机转告空军扩展', () => {
  const real = airwingOps();
  let calls = 0;
  registerAirwingOps({
    id: 'test-air-2',
    name: '测试航空兵',
    canBoard: () => true,
    launch: () => ({ ok: true }),
    recover: () => ({ ok: true }),
    onDeckTurnStart: () => {
      calls += 1;
    },
  });
  try {
    const s = createMatch(
      { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: ['pack-contemporary', 'naval-modern'] },
      7070,
    );
    s.units = [];
    for (let y = 6; y <= 10; y++) for (let x = 5; x <= 11; x++) putTerrain(s, x, y, 'water');
    place(s, 'A', 'nv_carrier', 6, 6);
    s.current = 'B';
    const r = applyAction(s, { type: 'END_TURN' });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    assert.ok(calls >= 1, '轮到航母这一方时，甲板整备必须被叫一次');
  } finally {
    registerAirwingOps(real);
  }
});

console.log('\n海军：地形与舰种');

test('深水：离岸两格才变外海，浅流原地不动', () => {
  const side = 7;
  const g: Terrain[] = new Array(side * side).fill('plain') as Terrain[];
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) g[y * side + x] = 'water';
  g[2 * side + 2] = 'shallow'; // 一角改成浅流：它不该被深水化

  const hook = expansionById('naval-fleet')!.afterTerrain!;
  hook(g, side, side);

  assert.equal(g[3 * side + 3], 'deep', '水塘正中间离岸两格，应该是深水');
  assert.equal(g[2 * side + 3], 'water', '贴着岸那一圈还是水域');
  assert.equal(g[2 * side + 2], 'shallow', '浅流不该被改成深水（会凭空掐掉陆军的过河口）');

  // 通行判定：船进得去，陆军进不去
  assert.equal(navigable('deep'), true, '船应该能进深水');
  assert.equal(passable('deep'), false, '陆军不该能进深水');
  assert.equal(navigable('shallow'), true, '浅流仍然双方都能过');
  assert.equal(passable('shallow'), true);
});

test('吃水：浅流能让小船过，2×2 的大舰进不去', () => {
  const s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: ['pack-contemporary', 'naval-modern'] },
    8181,
  );
  s.fog = false;
  s.units = [];
  // 上半深水、下半浅流的一道横向水道
  for (let y = 6; y <= 9; y++) for (let x = 3; x <= 12; x++) putTerrain(s, x, y, 'water');
  for (let x = 3; x <= 12; x++) putTerrain(s, x, 10, 'water');
  putTerrain(s, 7, 10, 'shallow');
  putTerrain(s, 8, 10, 'shallow');
  // 另一处浅流就贴在小船旁边，免得"走不过去"和"吃水不放行"混在一起
  putTerrain(s, 4, 7, 'shallow');
  putTerrain(s, 4, 8, 'shallow');

  const carrier = place(s, 'A', 'nv_carrier', 6, 7);
  s.current = 'A';
  const reach = reachableTiles(s, carrier);
  for (const i of reach.keys()) {
    const x = i % s.w;
    const y = Math.floor(i / s.w);
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        assert.notEqual(
          s.tiles[(y + dy) * s.w + (x + dx)]!.terrain,
          'shallow',
          `2×2 的航母不该能压在浅流上（锚点 ${x},${y}）`,
        );
      }
    }
  }

  // 小船不受这条限制
  const boat = place(s, 'A', 'gunboat', 5, 7);
  boat.moved = false;
  const smallReach = reachableTiles(s, boat);
  const onShallow = [...smallReach.keys()].some((i) => {
    const x = i % s.w;
    const y = Math.floor(i / s.w);
    return s.tiles[y * s.w + x]!.terrain === 'shallow';
  });
  assert.ok(onShallow, '一格宽的小船应该能开进浅流');
});

test('钻井平台：深水最肥，敌舰贴着就停产', () => {
  const s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: ['pack-contemporary', 'naval-modern'] },
    8282,
  );
  s.fog = false;
  s.units = [];
  for (let y = 6; y <= 9; y++) for (let x = 4; x <= 12; x++) putTerrain(s, x, y, 'water');
  const deep = { x: 8, y: 7 };
  const mid = { x: 5, y: 7 };
  const shallow = { x: 5, y: 9 };
  putTerrain(s, deep.x, deep.y, 'deep');
  putTerrain(s, shallow.x, shallow.y, 'shallow');

  const a = place(s, 'A', 'nv_oil_platform', deep.x, deep.y);
  const b = place(s, 'A', 'nv_oil_platform', mid.x, mid.y);
  const c = place(s, 'A', 'nv_oil_platform', shallow.x, shallow.y);
  const yDeep = unitIncome(s, a);
  const yWater = unitIncome(s, b);
  const yShallow = unitIncome(s, c);
  assert.ok(yDeep > yWater && yWater > yShallow, `深水(${yDeep}) > 水域(${yWater}) > 浅流(${yShallow})`);

  // 敌舰贴上来 → 这座平台停产，旁边那座照收
  place(s, 'B', 'gunboat', deep.x + 1, deep.y);
  assert.equal(unitIncome(s, a), 0, '被敌舰贴着的平台应该停产');
  assert.ok(unitIncome(s, b) > 0, '别的平台不受影响');
});

test('战列舰停在第五时代，第六时代由超巡接位', () => {
  const ships = [...(NAVAL_FLEET.units ?? []), ...(MODERN_NAVAL.units ?? [])];
  const bb = ships.find((u) => u.id === 'nv_battleship')!;
  assert.equal(bb.era, 5, '战列舰的历史定位应该落在第五时代（二战）');
  assert.ok(
    !ships.some((u) => u.era === 6 && u.name.includes('战列舰')),
    '第六时代不该再有战列舰（1945 年后没有任何国家开工建过）',
  );
  const large = ships.find((u) => u.id === 'nv_large_cruiser')!;
  assert.equal(large.era, 6, '接替大舰位置的是超巡');

  // 战巡 / 战列舰的分工：同炮径，一个快一个硬
  const bc = ships.find((u) => u.id === 'nv_battlecruiser')!;
  assert.ok(bc.move > bb.move, '战巡应该比战列舰快');
  assert.ok(bc.armor < bb.armor, '战巡的甲应该比战列舰薄');
  assert.ok(bc.cost < bb.cost, '战巡应该更便宜');
});

test('新舰种各司其职：甲板、潜母、补给舰互不重复', () => {
  const ships = [...(NAVAL_FLEET.units ?? []), ...(MODERN_NAVAL.units ?? [])];
  const byId = (id: string) => ships.find((u) => u.id === id)!;

  // 甲板：舰队航母 4 > 轻母 2 > 航战 1
  assert.equal(deckSpecOf('nv_carrier')!.capacity, 4);
  assert.equal(deckSpecOf('nv_light_carrier')!.capacity, 2);
  assert.equal(deckSpecOf('nv_aviation_battleship')!.capacity, 1);
  assert.equal(byId('nv_light_carrier').cost < byId('nv_carrier').cost, true, '轻母应该更便宜');

  // 潜母只修潜艇，维修舰只修水面舰：两条船能力不同
  assert.deepEqual(byId('nv_sub_tender').abilities, ['nv-sub-tender']);
  assert.deepEqual(byId('nv_repair_ship').abilities, ['nv-fleet-repair']);
  // 补给舰给的是机动，不是修理
  assert.deepEqual(byId('nv_oiler').abilities, ['nv-fleet-oiler']);

  // 潜母：只奶潜艇
  const s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 16,
      startEra: 6,
      expansionIds: ['pack-contemporary', 'naval-fleet', 'naval-modern'],
    },
    8383,
  );
  s.units = [];
  for (let y = 6; y <= 8; y++) for (let x = 4; x <= 12; x++) putTerrain(s, x, y, 'water');
  const tender = place(s, 'A', 'nv_sub_tender', 6, 7);
  const sub = place(s, 'A', 'nv_submarine', 7, 7);
  const frigate = place(s, 'A', 'nv_frigate', 5, 7);
  sub.hp = 10;
  frigate.hp = 10;
  s.current = 'B';
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const after = (id: string) => r.state.units.find((u) => u.id === id)!.hp;
  assert.ok(after(sub.id) > 10, '潜艇应该被潜母修好');
  assert.equal(after(frigate.id), 10, '水面舰不该被潜母修理');
  assert.ok(tender.hp > 0);

  // 补给舰：相邻友舰 +1 移动
  const s2 = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 16,
      startEra: 6,
      expansionIds: ['pack-contemporary', 'naval-fleet', 'naval-modern'],
    },
    8484,
  );
  s2.units = [];
  for (let y = 6; y <= 8; y++) for (let x = 4; x <= 12; x++) putTerrain(s2, x, y, 'water');
  const mate = place(s2, 'A', 'nv_frigate', 7, 7);
  const baseMove = s2.unitTypes['nv_frigate']!.move;
  assert.equal(movePower(s2, mate), baseMove, '身边没有补给舰时按兵种表');
  const oiler = place(s2, 'A', 'nv_oiler', 6, 7);
  assert.ok(movePower(s2, mate) >= baseMove + 1, '贴着补给舰应该 +1 移动');
  assert.ok(oiler.hp > 0);
});

console.log('\n空军扩展');

/** 空军两包 + 各自需要的前置，测试里反复要写 */
const AIR_ALL = ['pack-contemporary', 'naval-fleet', 'naval-modern', 'air-corps', 'air-modern'];

test('空军：两包都注册上，18 个兵种全在空气层', () => {
  const ids = new Set(allAbilities().map((a) => a.id));
  const planes = [...(AIR_CORPS.units ?? []), ...(MODERN_AIR.units ?? [])];
  assert.equal(planes.length, 18, `空军应该有 18 个兵种，现在 ${planes.length} 个`);

  for (const u of planes) {
    assert.equal(u.layer, 'air', `${u.name} 应该待在空中层`);
    assert.equal(u.flight, true, `${u.name} 应该能掠水，否则它飞不过一条河`);
    assert.ok(u.era >= 4 && u.era <= 6, `${u.name} 的时代 ${u.era} 越界`);
    assert.equal(u.short.length, 1, `${u.name} 的图标应该是一个字`);
    assert.ok(u.cost > 0 && u.maxHp > 0, `${u.name} 的数值不合法`);
    for (const a of u.abilities ?? []) {
      assert.ok(ids.has(a), `${u.name} 引用了不存在的能力 ${a}`);
    }
  }
  assert.ok(!planes.some((u) => u.domain === 'water'), '飞机不该被登记成水面单位');
});

test('空军：现代空军依赖「现代」与基础空军，单勾它什么都没有', () => {
  assert.deepEqual(MODERN_AIR.requires, ['pack-contemporary', 'air-corps']);

  const alone = createMatch(
    { ...DEFAULT_CONFIG, size: 12, startEra: 6, expansionIds: ['air-modern'] },
    9101,
  );
  assert.ok(!alone.unitTypes['af_jet'], '前置没开时喷气机不该出现在兵种表里');

  const withBase = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: 12,
      startEra: 6,
      expansionIds: ['pack-contemporary', 'air-corps', 'air-modern'],
    },
    9102,
  );
  assert.ok(withBase.unitTypes['af_jet'], '三个包都开了才有喷气机');

  const era6 = (MODERN_AIR.units ?? []).filter((u) => u.era === 6);
  assert.ok(era6.length >= 8, `第六时代至少要补 8 种飞机，现在 ${era6.length} 种`);
});

test('制空：战斗机打空中目标，比打同血同甲的地面目标更疼', () => {
  const s = fresh({ expansionIds: ['air-corps'] });
  s.units = [];
  for (const [x, y] of [
    [5, 5],
    [5, 6],
    [6, 5],
  ]) {
    putTerrain(s, x!, y!, 'plain');
  }
  const fighter = place(s, 'A', 'af_fighter', 5, 5);
  // 同血同甲的"地面版轰炸机"：只差一个层字段，别的都一样
  s.unitTypes['probe_ground'] = { ...s.unitTypes['af_heavy_bomber']!, layer: undefined, flight: false };
  const bomberAir = place(s, 'B', 'af_heavy_bomber', 5, 6);
  const bomberGround = place(s, 'B', 'probe_ground', 6, 5);

  const vsAir = computeDamage(s, fighter, bomberAir);
  const vsGround = computeDamage(s, fighter, bomberGround);
  assert.ok(vsAir > vsGround, `对空 ${vsAir} 应该高于对地 ${vsGround}——否则制空这条能力等于没有`);
});

test('对地/反舰：两条加成各管一层，不会串味', () => {
  const s = fresh({ expansionIds: ['air-corps'] });
  s.units = [];
  for (const [x, y] of [
    [5, 5],
    [5, 6],
    [6, 5],
  ]) {
    putTerrain(s, x!, y!, 'plain');
  }
  const base = s.unitTypes['af_heavy_bomber']!;
  s.unitTypes['probe_air'] = { ...base, layer: 'air', flight: true };
  s.unitTypes['probe_land'] = { ...base, layer: undefined, flight: false };
  s.unitTypes['probe_ship'] = { ...base, layer: undefined, flight: false, domain: 'water' };

  // 强击机只有「对地攻击」：打地面层更疼，打空中层没有加成
  const striker = place(s, 'A', 'af_sturmovik', 5, 5);
  const groundTarget = place(s, 'B', 'probe_land', 5, 6);
  const airTarget = place(s, 'B', 'probe_air', 6, 5);
  assert.ok(
    computeDamage(s, striker, groundTarget) > computeDamage(s, striker, airTarget),
    '强击机打地面应该比打飞机更疼',
  );

  // 俯冲轰炸机只有「反舰」：打船更疼，打陆地没有加成
  const diver = place(s, 'A', 'af_dive_bomber', 5, 5);
  const shipTarget = place(s, 'B', 'probe_ship', 5, 6);
  const landTarget = place(s, 'B', 'probe_land', 6, 5);
  assert.ok(
    computeDamage(s, diver, shipTarget) > computeDamage(s, diver, landTarget),
    '俯冲轰炸机打船应该比打陆地更疼',
  );
});

test('隐身：迷雾里贴脸才现形，打完人不挨反击', () => {
  const s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: AIR_ALL },
    9104,
  );
  s.units = [];
  s.fog = true;
  const ghost = place(s, 'A', 'af_stealth', 5, 5);
  const foe = place(s, 'B', 'militia', 9, 5);
  assert.ok(isHiddenFrom(s, ghost, 'B'), '隔着四格，隐身机应该藏得住');
  foe.x = 6;
  foe.y = 5;
  assert.ok(!isHiddenFrom(s, ghost, 'B'), '贴脸就该现形');

  // 换上同一条思路的另一面：打了人不挨反击
  const hpAfterHit = (type: string): number => {
    const st = createMatch(
      { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: AIR_ALL },
      9105,
    );
    st.units = [];
    st.fog = false;
    st.current = 'A';
    putTerrain(st, 5, 5, 'plain');
    putTerrain(st, 5, 6, 'plain');
    const atk = place(st, 'A', type, 5, 5);
    // 一架 200 血、射程 3 的战略轰炸机当靶子：它一定活得下来，也一定够得着还手
    const tank = place(st, 'B', 'af_strategic', 5, 6);
    const r = applyAction(st, { type: 'ATTACK', unitId: atk.id, targetId: tank.id });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    return r.state.units.find((u) => u.id === atk.id)!.hp;
  };

  assert.equal(hpAfterHit('af_stealth'), 85, '隐身机打完不该掉血——它先手，对面还不了手');
  assert.ok(hpAfterHit('af_jet') < 90, '普通喷气机对同样的目标会挨一下反击');
});

test('舰载机白名单：只有四种飞机上得了甲板', () => {
  const ops = airwingOps();
  assert.ok(ops, '空军包应该在模块加载时就把甲板实现注册好');
  const can = (id: string): boolean =>
    ops!.canBoard({ state: null as never, carrier: null as never, planeTypeId: id });

  assert.equal(can('af_naval_plane'), true, '舰载机当然能上舰');
  assert.equal(can('af_jet'), true, '喷气机上舰是常识');
  assert.equal(can('af_awacs'), true, '预警机本来就是舰载的');
  assert.equal(can('af_heavy_bomber'), false, '重型轰炸机上不了舰');
  assert.equal(can('af_strategic'), false, '战略轰炸机上不了舰');
  assert.equal(can('af_transport'), false, '运输机不是舰载机');
});

test('甲板起降：起飞后棋盘多一架、甲板少一架，返航反过来', () => {
  const s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: AIR_ALL },
    9106,
  );
  s.units = [];
  for (let y = 6; y <= 10; y++) for (let x = 4; x <= 12; x++) putTerrain(s, x, y, 'water');
  const carrier = place(s, 'A', 'nv_carrier', 7, 8);

  // 手工把一架"带伤返航"的舰载机塞进甲板（正式流程见下一条）
  const plane = place(s, 'A', 'af_naval_plane', 10, 10);
  plane.hp = 40;
  assert.ok(stowPlane(carrier, plane), '四个机位应该收得下第一架');
  s.units = s.units.filter((u) => u.id !== plane.id);
  assert.equal(deckUsed(carrier), 1);

  const out = launchFromCarrier(s, carrier);
  assert.ok(out.ok, out.ok ? '' : `起飞失败：${out.reason}`);
  assert.equal(deckUsed(carrier), 0, '放飞之后甲板少一架');
  const flying = s.units.find((u) => u.type === 'af_naval_plane');
  assert.ok(flying, '棋盘上应该多出一架飞机');
  assert.equal(flying!.hp, 40, '带伤起飞要带着伤，不能借起飞回血');
  assert.equal(flying!.moved, true, '起飞占掉这一回合的移动');
  assert.ok(
    Math.abs(flying!.x - carrier.x) + Math.abs(flying!.y - carrier.y) <= deckSpecOf('nv_carrier')!.launchRange,
    '落点要在起飞半径之内',
  );

  const back = recoverToCarrier(s, carrier, flying!);
  assert.ok(back.ok, back.ok ? '' : `返航失败：${back.reason}`);
  assert.equal(deckUsed(carrier), 1, '返航之后甲板又多一架');
  assert.ok(!s.units.some((u) => u.id === flying!.id), '进了甲板就不该再占棋盘格');
});

test('整备：轮到航母时先收、再修 8 点、后放一架', () => {
  const s = createMatch(
    { ...DEFAULT_CONFIG, size: 16, startEra: 6, expansionIds: AIR_ALL },
    9107,
  );
  s.units = [];
  for (let y = 6; y <= 10; y++) for (let x = 4; x <= 12; x++) putTerrain(s, x, y, 'water');
  const carrier = place(s, 'A', 'nv_carrier', 7, 8);

  const plane = place(s, 'A', 'af_naval_plane', 10, 10);
  plane.hp = 40;
  stowPlane(carrier, plane);
  s.units = s.units.filter((u) => u.id !== plane.id);

  s.current = 'B'; // 结束 B 的回合 → 轮到 A，触发整备
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(r.ok, r.ok ? '' : r.reason);
  const flying = r.state.units.find((u) => u.type === 'af_naval_plane');
  assert.ok(flying, '整备完应该放出去一架');
  assert.equal(flying!.hp, 48, '先修 8 点再放飞：40 → 48');
  assert.equal(deckOf(r.state.units.find((u) => u.id === carrier.id)!).length, 0, '放出去之后甲板空了');
});

test('掠水：飞机能停在深水上，陆军进不去', () => {
  const s = fresh({ expansionIds: ['air-corps'] });
  s.units = [];
  putTerrain(s, 3, 3, 'deep');
  assert.equal(canStandAt(s, 3, 3, 'af_scout'), true, '飞机应该能停在深水上（航母头顶也是空域）');
  assert.equal(canStandAt(s, 3, 3, 'militia'), false, '陆军进不了深水');
});


console.log('\n选卡模式');

/** 从"等待开局"进入禁用（选卡不再是开局即禁用，先得有人点开始） */
function startStep(state: GameState): GameState {
  const r = applyAction(state, { type: 'DRAFT_START', at: 1_000_000 }, 'A');
  assert.ok(r.ok, r.ok ? '' : `开始选卡失败：${r.reason}`);
  return r.ok ? r.state : state;
}

/** 禁用一步 */
function banStep(state: GameState, side: PlayerId, unitId: string): GameState {
  const r = applyAction(state, { type: 'DRAFT_BAN', unitId, at: state.draft!.deadline }, side);
  assert.ok(r.ok, r.ok ? '' : `禁用失败：${r.reason}`);
  return r.ok ? r.state : state;
}

/** 选人一步（自动取当前轮次的那一方） */
function pickStep(state: GameState, unitId: string): GameState {
  const side = state.draft!.order[state.draft!.step]!;
  const r = applyAction(state, { type: 'DRAFT_PICK', unitId, at: state.draft!.deadline }, side);
  assert.ok(r.ok, r.ok ? '' : `选人失败：${r.reason}`);
  return r.ok ? r.state : state;
}

/** 把整轮 BP 打完（默认按池子顺序拿，保证是合法动作） */
function finishDraft(state: GameState): GameState {
  let st = state.draft!.phase === 'lobby' ? startStep(state) : state;
  const pool = st.draft!.pool;
  st = banStep(st, 'A', pool[0]!);
  st = banStep(st, 'B', pool[1]!);
  while (st.draft!.phase === 'pick') {
    const left = remainingUnits(st);
    if (left.length === 0) break;
    st = pickStep(st, left[0]!);
  }
  return st;
}

test('选卡：原版池子 20 个、各禁 1、各选 6，且只收战斗单位与非生产性建筑', () => {
  const s = fresh({ draftMode: true }, 7101);
  const draft = s.draft!;
  assert.equal(draft.pool.length, DRAFT_POOL_BASE, `原版应抽 ${DRAFT_POOL_BASE} 个，实际 ${draft.pool.length}`);
  assert.equal(draft.banSlots, DRAFT_BAN_BASE);
  assert.equal(draft.pickSlots, DRAFT_PICK_BASE);
  assert.equal(draft.phase, 'lobby', '开局先停在"等待开局"，不是直接禁用');

  // 池子里的东西：战斗单位，或者"不产兵、不是桥"的建筑
  for (const id of draft.pool) {
    const def = s.unitTypes[id]!;
    assert.ok(
      def.category === 'combat' || (def.category === 'building' && !def.barracks && !def.bridges),
      `${def.name} 不该进池子（${def.category}${def.barracks ? '/军营' : ''}${def.bridges ? '/桥' : ''}）`,
    );
  }
  // 骨架一律不进池：经济、建造、军营、桥
  for (const id of ['farmer', 'laborer', 'camp', 'bridge']) {
    assert.ok(!draft.pool.includes(id), `${id} 是骨架，不该进池`);
  }
});

test('选卡：池子里不会混进攻城结算用的伪单位', () => {
  // 攻城走"把城市包成伪 Unit 喂进 computeDamage"，那条路要一个 UnitTypeDef
  // 形状的壳（见 config.ts 的 PSEUDO_UNIT_IDS）。壳在兵种表里躺着一份，
  // 一旦被当成真兵种，选卡池就会少一格、多一张点不动的空卡。
  const s = fresh({ draftMode: true }, 7111);
  assert.ok(!draftCandidates(s).includes('__city__'), '伪单位不该是选卡候选');
  assert.ok(!s.draft!.pool.includes('__city__'), '伪单位不该占池子里的名额');
  assert.ok(!('__city__' in s.unitTypes), '它连"这一局有哪些兵"都不该进');
  // 抽满 20 个真兵种，一个不差
  assert.equal(s.draft!.pool.length, DRAFT_POOL_BASE);
  assert.equal(new Set(s.draft!.pool).size, DRAFT_POOL_BASE, '池子里不该有重复');
});

test('选卡：没有计时起点、或 deadline 是 0/NaN 时，超时一律不成立', () => {
  // 这一条守的是"联机里一进选卡就显示双方禁用已超时"：
  // 超时的判据是 `at < deadline`，deadline 为 0 或 NaN 时这句永远不成立，
  // 于是任何一次超时请求都被放行，两边各白丢一次禁用。
  const s = fresh({ draftMode: true }, 7301);
  const ban = startStep(s);
  assert.equal(ban.draft!.phase, 'ban');

  for (const broken of [0, Number.NaN]) {
    const st = structuredClone(ban);
    st.draft!.deadline = broken;
    const r = applyAction(st, { type: 'DRAFT_TIMEOUT', at: Date.now() }, 'A');
    assert.equal(r.ok, false, `deadline=${broken} 时不该判超时`);
    assert.deepEqual(ban.draft!.bans.A, [], '更不该替双方补"放弃"');
  }

  // 开始选卡必须带计时起点，否则会写出 NaN 的 deadline（就是上面那个坑的源头）
  const lobby = fresh({ draftMode: true }, 7302);
  const bad = applyAction(lobby, { type: 'DRAFT_START' } as never, 'A');
  assert.equal(bad.ok, false, '缺 at 的 DRAFT_START 要被挡住');
  assert.equal(lobby.draft!.phase, 'lobby', '挡下来之后还停在等待开局');
});

test('选卡：按时代分层抽样，每个有货的时代都抽得到', () => {
  const s = fresh({ draftMode: true }, 7102);
  const draft = s.draft!;
  const eras = new Set(draft.pool.map((id) => s.unitTypes[id]!.era));
  for (const era of [1, 2, 3, 4, 5]) {
    const has = draftCandidates(s).some((id) => s.unitTypes[id]!.era === era);
    if (!has) continue;
    assert.ok(eras.has(era), `第 ${era} 时代有候选，池子里却没有 —— 分层抽样漏了`);
  }
  // 同一颗种子出同一个池子
  const again = fresh({ draftMode: true }, 7102);
  assert.deepEqual(again.draft!.pool, draft.pool, '同一个 seed 必须抽出同一个池子');
});

test('选卡：名额按"兵种体系"加——单海军/单空军 +1 选，海空同开 +1 禁 +2 选', () => {
  const mk = (ids: string[], seed: number) =>
    createMatch(
      { ...DEFAULT_CONFIG, size: 14, startEra: 5, expansionIds: ids, draftMode: true },
      seed,
    );

  // 原版：不加成
  const none = fresh({ draftMode: true }, 7103);
  const baseBudget = draftBudget(none);
  assert.equal(baseBudget.extra, 0, '原版对局不该有扩展兵');
  assert.equal(baseBudget.bans, 1);
  assert.equal(baseBudget.picks, 6);

  // 单海军 → 选卡 +1
  const naval = draftBudget(mk(['naval-fleet'], 7104));
  assert.equal(naval.bans, 1, '只有海军不加禁位');
  assert.equal(naval.picks, 7, '单海军：选卡 +1');

  // 单空军 → 选卡 +1
  const air = draftBudget(mk(['air-corps'], 7105));
  assert.equal(air.bans, 1, '只有空军不加禁位');
  assert.equal(air.picks, 7, '单空军：选卡 +1');

  // 海 + 空 → 禁位 +1、选卡 +2
  const both = draftBudget(mk(['naval-fleet', 'air-corps'], 7106));
  assert.equal(both.bans, 2, '海军与空军同时在场：禁用 +1');
  assert.equal(both.picks, 8, '海军与空军同时在场：选卡 +2');

  // 池子仍然按兵的数量长（和名额是两套规则）
  assert.ok(both.pool > baseBudget.pool, `池子应该变大：${baseBudget.pool} → ${both.pool}`);
  assert.equal(mk(['naval-fleet', 'air-corps'], 7107).draft!.pool.length, both.pool);
});

test('选卡：时代军备 +1 禁 +2 选，且能和海空叠加', () => {
  const mk = (ids: string[]) =>
    createMatch(
      { ...DEFAULT_CONFIG, size: 14, startEra: 5, expansionIds: ids, draftMode: true },
      7201,
    );

  const era = draftBudget(mk(['pack-antiquity']));
  assert.equal(era.bans, 2, '时代军备：禁用 +1');
  assert.equal(era.picks, 8, '时代军备：选卡 +2');

  // 三样同时在场：禁 1+1+1=3、选 6+2+2=10
  const all = draftBudget(
    mk(['pack-antiquity', 'naval-fleet', 'air-corps', 'pack-contemporary']),
  );
  assert.equal(all.bans, 3);
  assert.equal(all.picks, 10);
  assert.ok(all.pool <= 60, '池子有上限');

  // 「现代海军」这条线要带「现代」，而「现代」本身就是时代军备的一包——
  // 于是它同时点亮两个体系：禁 1+1=2、选 6+1（单海军）+2（时代军备）=9。
  // 规则按**实际在场的体系**算，不按玩家"本来想开哪一类"算，
  // 这样联机两边看到的数字永远一致。
  const navalModern = draftBudget(mk(['pack-contemporary', 'naval-modern']));
  assert.equal(navalModern.bans, 2);
  assert.equal(navalModern.picks, 9);
  // 单独勾「现代海军」不满足前置，整包不生效，也就不该有任何加成
  const orphan = draftBudget(mk(['naval-modern']));
  assert.equal(orphan.bans, 1);
  assert.equal(orphan.picks, 6);
});

test('选卡：进度号每走一步 +1（联机靠它做乐观锁）', () => {
  let s = fresh({ draftMode: true }, 7202);
  const start = s.draft!.seq;
  assert.equal(start, 1, '开局进度号是 1，和房间那一行的 turn 对得上');

  s = startStep(s);
  assert.equal(s.draft!.seq, start + 1, '"开始选卡"也算一步：联机时它也要能被对面看见');
  s = banStep(s, 'A', s.draft!.pool[0]!);
  assert.equal(s.draft!.seq, start + 2, '一次禁用一个号');
  s = banStep(s, 'B', s.draft!.pool[1]!);
  assert.equal(s.draft!.seq, start + 3, '两边都禁完只加两个号（进入选人不额外加）');
  s = pickStep(s, s.draft!.pool[2]!);
  assert.equal(s.draft!.seq, start + 4, '一次选人一个号');
});

test('选卡：开局停在"等待开局"，不计时、不能禁用，点开始才进禁用', () => {
  let s = fresh({ draftMode: true }, 7301);
  assert.equal(s.draft!.phase, 'lobby');
  assert.equal(s.draft!.deadline, 0, 'lobby 不该有倒计时（要等人入座）');
  assert.equal(draftSecondsLeft(s, Date.now()), 0);

  // 还没开始就想禁用/选人/超时：一律拒
  const ban = applyAction(s, { type: 'DRAFT_BAN', unitId: s.draft!.pool[0]!, at: 1 }, 'A');
  assert.ok(!ban.ok, 'lobby 里不该能直接禁用');
  const timeout = applyAction(s, { type: 'DRAFT_TIMEOUT', at: Date.now() + 60_000 }, 'A');
  assert.ok(!timeout.ok, 'lobby 里没有"超时"这回事');

  // 走棋同样被拦着
  assert.match(applyAction(s, { type: 'END_TURN' }).reason ?? '', /选卡/);

  s = startStep(s);
  assert.equal(s.draft!.phase, 'ban');
  assert.ok(s.draft!.deadline > 1_000_000, '开始之后才有截止时间');
});

test('选卡：可以整轮跳过——这一局按原版用全部兵种', () => {
  // 在 lobby 就跳过
  let s = fresh({ draftMode: true }, 7302);
  const skipped = applyAction(s, { type: 'DRAFT_SKIP', at: Date.now() }, 'A');
  assert.ok(skipped.ok, skipped.ok ? '' : skipped.reason);
  s = skipped.state;
  assert.equal(s.draft!.phase, 'done');
  assert.equal(s.draft!.skipped, true);
  assert.equal(canUseType(s, 'A', 'tank'), true, '跳过之后名单限制整个不生效');
  assert.equal(eraWindowOk(s, s.unitTypes['militia']!, 5), true, '跳过选卡也是同一个时代口径：旧兵照样能造');

  // 跳过之后就能正常走棋了
  const end = applyAction(s, { type: 'END_TURN' });
  assert.ok(end.ok, end.ok ? '' : `跳过选卡后应该能结束回合：${end.reason}`);

  // 选到一半也能跳（对面掉线时用得上）
  let t = startStep(fresh({ draftMode: true }, 7303));
  t = banStep(t, 'A', t.draft!.pool[0]!);
  const mid = applyAction(t, { type: 'DRAFT_SKIP', at: Date.now() }, 'B');
  assert.ok(mid.ok, mid.ok ? '' : mid.reason);
  assert.equal(mid.state.draft!.phase, 'done');
  assert.equal(mid.state.draft!.skipped, true);
});

test('选卡：盲禁——两边都交完才揭晓，禁掉的兵谁都拿不到', () => {
  let s = startStep(fresh({ draftMode: true }, 7105));
  const pool = s.draft!.pool;
  const banned = pool[0]!;

  s = banStep(s, 'A', banned);
  assert.equal(s.draft!.phase, 'ban', '只有一方交了禁用，还不该进入选人');
  assert.deepEqual(s.draft!.bans.A, [banned]);

  s = banStep(s, 'B', pool[1]!);
  assert.equal(s.draft!.phase, 'pick', '两边都交完才进入选人');
  assert.ok(!remainingUnits(s).includes(banned), '被禁的兵必须从池子里消失');

  // 拿被禁的那个去选：得被拒
  const side = s.draft!.order[0]!;
  const r = applyAction(s, { type: 'DRAFT_PICK', unitId: banned, at: s.draft!.deadline }, side);
  assert.ok(!r.ok, '被禁用的兵不该能选');
});

test('选卡：蛇形顺序，选完 12 步交接给对局', () => {
  assert.deepEqual(draftPickOrder(3), ['A', 'B', 'B', 'A', 'A', 'B'], '每轮交换首选权');
  const order6 = draftPickOrder(6);
  assert.equal(order6.length, 12);
  assert.equal(order6.filter((x) => x === 'A').length, 6);
  assert.equal(order6.filter((x) => x === 'B').length, 6);

  let s = fresh({ draftMode: true }, 7106);
  s = finishDraft(s);
  assert.equal(s.draft!.phase, 'done');
  assert.equal(s.draft!.picks.A.length, 6);
  assert.equal(s.draft!.picks.B.length, 6);
  assert.equal(s.current, 'A', '选完从甲方开局');
  // 两边不许撞同一个兵
  const both = new Set([...s.draft!.picks.A, ...s.draft!.picks.B]);
  assert.equal(both.size, 12, '被选走的兵不能再被对面选');
});

test('选卡：没打完之前，走棋与产兵一律被拒', () => {
  const s = fresh({ draftMode: true }, 7107);
  const r = applyAction(s, { type: 'END_TURN' });
  assert.ok(!r.ok);
  assert.match(r.reason, /选卡/);
});

test('选卡：名单外的兵造不出来，名单内的能造；骨架不受限', () => {
  let s = fresh({ draftMode: true }, 7108);
  s = finishDraft(s);
  // 直接改写名单，才能稳定断言"名单内 / 名单外"这两种情况
  s.draft!.picks.A = ['militia'];
  const city = s.cities.find((c) => c.owner === 'A')!;
  s.players.A.gold = 9000;

  const ok = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' });
  assert.ok(ok.ok, ok.ok ? '' : `名单内的民兵应该能造：${ok.reason}`);

  const denied = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'archer' });
  assert.ok(!denied.ok, '名单外的弓手不该能造');
  assert.match(denied.reason, /名单/);

  // 经济单位不在池子里，但永远能造（不然没有收入）
  const econ = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'farmer' });
  assert.ok(econ.ok, econ.ok ? '' : `经济单位不该被名单挡住：${econ.reason}`);
});

test('时代下限取消之后，所有模式同一口径（选卡不再是特例）', () => {
  // 这四个时代前的兵，以前只有"开了选卡"才造得出来——同一个局面在两种模式下
  // 给两个答案，玩家得先想"我这一局开没开选卡"。现在下限没了，口径只剩一个。
  const plain = fresh({}, 7109);
  const pCity = plain.cities.find((c) => c.owner === 'A')!;
  pCity.era = 4;
  plain.players.A.gold = 9000;
  const allowed = applyAction(plain, { type: 'RECRUIT', cityId: pCity.id, unitType: 'militia' });
  assert.ok(allowed.ok, allowed.ok ? '' : `原版模式下民兵也该能造：${allowed.reason}`);
  assert.equal(eraWindowOk(plain, plain.unitTypes['militia']!, 4), true);

  // 选卡模式：同一个局面、同一个结论
  let s = fresh({ draftMode: true }, 7110);
  s = finishDraft(s);
  s.draft!.picks.A = ['militia'];
  const city = s.cities.find((c) => c.owner === 'A')!;
  city.era = 4;
  s.players.A.gold = 9000;
  const picked = applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' });
  assert.ok(picked.ok, picked.ok ? '' : `选卡模式下民兵应该能造：${picked.reason}`);
  assert.equal(eraWindowOk(s, s.unitTypes['militia']!, 4), true);

  // 上界两边都不动
  assert.equal(eraWindowOk(plain, plain.unitTypes['tank']!, 3), false, '三代城造不了五代的坦克');
});

test('选卡：建筑也要在名单里，工兵不能盖没选到的塔', () => {
  let s = fresh({ draftMode: true }, 7111);
  s = finishDraft(s);
  s.draft!.picks.A = [];
  // 开局配给里没有劳工（只有战斗单位 + 两个经济单位），自己摆一个
  const laborer = place(s, 'A', 'laborer', 5, 5);
  const spot = { x: 6, y: 5 };
  putTerrain(s, 6, 5, 'plain');
  const r = applyAction(s, { type: 'BUILD', unitId: laborer.id, unitType: 'tower', x: spot.x, y: spot.y });
  assert.ok(!r.ok, '没选到的塔不该能盖');
  assert.match(r.reason, /名单/);

  s.draft!.picks.A = ['tower'];
  const ok = applyAction(s, { type: 'BUILD', unitId: laborer.id, unitType: 'tower', x: spot.x, y: spot.y });
  assert.ok(ok.ok, ok.ok ? '' : `选到的塔应该能盖：${ok.reason}`);
});

test('选卡：超时——禁用视为放弃，选人由系统补一个', () => {
  let s = startStep(fresh({ draftMode: true }, 7112));
  // 只让 A 交禁用，B 超时
  s = banStep(s, 'A', s.draft!.pool[0]!);
  const late = s.draft!.deadline + 1;
  const r = applyAction(s, { type: 'DRAFT_TIMEOUT', at: late }, 'B');
  assert.ok(r.ok, r.ok ? '' : r.reason);
  s = r.state;
  assert.equal(s.draft!.phase, 'pick', '超时之后照样进入选人');
  assert.deepEqual(s.draft!.bans.B.filter(Boolean), [], 'B 放弃了禁用，不该替它随机禁一个');
  assert.ok(s.draft!.history.some((h) => h.side === 'B' && h.auto && h.unitId === null), '要留下"放弃"的记录');

  // 选人超时：必须补一个，否则这一方凑不满名单
  const before = s.draft!.picks[s.draft!.order[s.draft!.step]!].length;
  const r2 = applyAction(s, { type: 'DRAFT_TIMEOUT', at: s.draft!.deadline + 1 }, 'A');
  assert.ok(r2.ok, r2.ok ? '' : r2.reason);
  s = r2.state;
  const after = s.draft!.picks[s.draft!.order[s.draft!.step - 1]!].length;
  assert.equal(after, before + 1, '超时方要被系统补选一个');
  assert.ok(s.draft!.history.some((h) => h.auto && h.kind === 'pick' && h.unitId), '补选要留下记录');

  // 没到时限的"超时"一律拒掉：只有时间能决定谁超时
  const early = applyAction(s, { type: 'DRAFT_TIMEOUT', at: s.draft!.deadline - 1000 }, 'A');
  assert.ok(!early.ok, '没到点不该能提前触发超时');
});

/* ── 联机选卡的合并协议 ────────────────────────────────────────────────
 *
 * 这一段只在"两个浏览器 + 一个房间"时出错，却恰好是"禁不动、选不动"的来源，
 * 所以用两个假客户端 + 一个假房间把它钉住。房间的规则和真实那张表一样：
 * 只有 `turn` 还等于"我以为的进度号"才写得进去（乐观锁）。
 */
function fakeRoom(seed: number) {
  const state0 = startStep(fresh({ draftMode: true }, seed));
  return {
    state: state0,
    /** 房间那一列 turn：BP 期间存的是进度号 */
    lock: state0.draft!.seq,
    submit(client: GameState, expectedSeq: number): boolean {
      if (this.lock !== expectedSeq) return false;
      this.state = client;
      this.lock = client.draft!.seq;
      return true;
    },
  };
}

/**
 * 一个客户端提交一步：本地先落（手感即时），被挡就合并重交。
 * 这就是 main.ts 里 pushDraft 的算法，抽出来是为了能用例盯着。
 */
function clientSubmit(
  room: ReturnType<typeof fakeRoom>,
  local: GameState,
  action: Parameters<typeof applyAction>[1],
  actor: 'A' | 'B',
): { state: GameState; ok: boolean } {
  const applied = applyAction(local, action, actor);
  if (!applied.ok) return { state: local, ok: false };
  let next = applied.state;
  for (let i = 0; i < 4; i++) {
    // 第一轮用"我落这一步之前看到的进度号"，之后用房间刚写到的那个
    const expected = i === 0 ? local.draft!.seq : room.lock;
    if (room.submit(next, expected)) return { state: next, ok: true };
    // 被对面先写了：把自己的这一步补到房间那份上，再来一次
    const merged = mergeDraftStep(room.state, action, actor);
    if (!merged.ok) return { state: room.state, ok: false };
    next = merged.state;
  }
  return { state: room.state, ok: false };
}

test('联机选卡：两边同时禁用，后交的一方合并重交，两份名单都留在房间里', () => {
  const room = fakeRoom(7201);
  const a = structuredClone(room.state);
  const b = structuredClone(room.state);
  const banA = remainingUnits(a)[0]!;
  const banB = remainingUnits(b).find((id) => id !== banA)!;

  const ra = clientSubmit(room, a, { type: 'DRAFT_BAN', unitId: banA, at: Date.now() }, 'A');
  assert.ok(ra.ok, 'A 应该交得上去（房间还停在开局那一步）');
  const rb = clientSubmit(room, b, { type: 'DRAFT_BAN', unitId: banB, at: Date.now() }, 'B');
  assert.ok(rb.ok, 'B 被挡回来之后要能合并重交，而不是失败');

  assert.deepEqual(room.state.draft!.bans.A, [banA], '房间里必须留着 A 的禁用');
  assert.deepEqual(room.state.draft!.bans.B, [banB], '房间里必须留着 B 的禁用');
  assert.equal(room.state.draft!.phase, 'pick', '两边都禁完才进入选人');
  // 两边都能靠"进度号变大"拉到这一份：谁也不会停在只有自己那一手的名单上
  assert.ok(room.state.draft!.seq > a.draft!.seq, '房间的进度号要比 A 本地大，A 才拉得到');
  assert.ok(room.state.draft!.seq > b.draft!.seq, '也要比 B 本地大');
});

test('联机选卡：超时是一步动作，提交进房间之后两边一起往前，不用再选一次', () => {
  const room = fakeRoom(7202);
  const a = structuredClone(room.state);
  const r = clientSubmit(
    room,
    a,
    { type: 'DRAFT_TIMEOUT', at: a.draft!.deadline } as Parameters<typeof applyAction>[1],
    'A',
  );
  assert.ok(r.ok, '超时这一步也要提交进房间（以前只改本地）');
  assert.equal(room.state.draft!.phase, 'pick', '房间跟着进入选人，不是只有本地前进');
  assert.ok(room.state.draft!.seq > a.draft!.seq, 'B 靠进度号就能拉到这一步');
});

test('联机选卡：同一手补不进新局面上，就判失败让调用方退回房间那份', () => {
  const room = fakeRoom(7203);
  const a = structuredClone(room.state);
  const banA = remainingUnits(a)[0]!;
  assert.ok(clientSubmit(room, a, { type: 'DRAFT_BAN', unitId: banA, at: Date.now() }, 'A').ok);

  // 对面那一手仍然补得进去（盲禁是双方各一次，池子里的东西谁都还没被禁掉）
  const other = mergeDraftStep(room.state, { type: 'DRAFT_BAN', unitId: banA, at: Date.now() }, 'B');
  assert.equal(other.ok, true, 'B 在合并后的局面上还能禁同一个兵（两个人可以禁同一个）');

  // 但"同一个席位禁第二次"必须失败：否则重放会把一步变成两步
  const again = mergeDraftStep(room.state, { type: 'DRAFT_BAN', unitId: 'archer', at: Date.now() }, 'A');
  assert.equal(again.ok, false, 'A 已经禁过，再补一次必须被挡住');
});

test('选卡：AI 会禁用与选人，且只在池子里挑', () => {
  const s = fresh({ draftMode: true, aiOpponent: true }, 7113);
  const banId = aiDraftBan(s, 'B');
  assert.ok(banId, 'AI 应该能给出一个禁用');
  assert.ok(s.draft!.pool.includes(banId!), 'AI 的禁用必须在池子里');

  const pickId = aiDraftPick(s, 'B');
  assert.ok(pickId, 'AI 应该能给出一个选人');
  assert.ok(s.draft!.pool.includes(pickId!), 'AI 的选人必须在池子里');
  assert.ok(canUseType(s, 'B', pickId!) === false, '还没选进名单之前不算"能用"');
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
if (failed > 0) process.exit(1);
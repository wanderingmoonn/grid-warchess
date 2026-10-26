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

import assert from 'node:assert/strict';

import { CONFIG, ERAS, ORDER_UPGRADE, UNIT_TYPES, eraDef, nextUpgradeCost } from '../src/core/config.ts';
import { BLOOD_TURN, EXPANSIONS, LEGACY_UPGRADE_COST, turnOrderBonusFor } from '../src/core/expansions.ts';
import { generateLayout } from '../src/core/mapgen.ts';
import { ABILITIES } from '../src/core/abilities.ts';
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiLevelOf, aiNextAction, aiNoise, aiTraits, anyAiSide, isAiSide } from '../src/core/ai.ts';
import {
  MAX_BOARD_SIZE,
  MIN_BOARD_SIZE,
  clampBoardSize,
  createMatch,
  DEFAULT_CONFIG,
  startGoldFor,
} from '../src/core/setup.ts';
import {
  applyAction,
  buildingAt,
  citiesOf,
  cityById,
  cityRegenOf,
  cityTiles,
  computeDamage,
  damageToCity,
  distance,
  distToCity,
  idx,
  incomeOf,
  movePower,
  ordersOf,
  previewAttack,
  reachableTiles,
  rebuildCost,
  recruitCost,
  refreshMemory,
  threatTiles,
  unitAt,
  unitIncome,
  unitsOf,
  upgradeCostOf,
  utype,
  visionOf,
  visibleTilesOf,
} from '../src/core/rules.ts';
import { playerView } from '../src/core/fog.ts';
import { DEFAULT_SIZE_FOR_ERA as eraSize } from '../src/ui/setup-panel.ts';
import type {
  Action,
  City,
  GameState,
  MatchConfig,
  PlayerId,
  Unit,
} from '../src/core/types.ts';

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
  // 古典 12×12、中世 16×16、火药/工业/现代 20×20
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
  assert.equal(damageToCity(cav, city, s), UNIT_TYPES.scout.atk - city.armor);
});

test('耐久打空变废墟、守军随城陷落，派兵入驻并付费才易主', () => {
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
  assert.equal(r.state.units.some((n) => n.id === garrison.id), false, '守军随城陷落');

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
  const builder = addLaborer(s);
  const built = applyAction(s, { type: 'BUILD', unitId: builder.id, unitType: 'tower', x: 6, y: 5 });
  assert.ok(built.ok);
  const tower = built.state.units.find((u) => u.type === 'tower');
  const enemy = built.state.units.find((u) => u.owner === 'B');
  assert.ok(tower && enemy);

  enemy.x = tower.x + 1;
  enemy.y = tower.y;
  built.state.tiles[idx(built.state, enemy.x, enemy.y)].terrain = 'plain';
  const hpBefore = enemy.hp;

  const r = applyAction(built.state, { type: 'END_TURN' });
  assert.ok(r.ok);
  const after = r.state.units.find((u) => u.id === enemy.id);
  assert.ok(after, '一炮打不死，应该还活着');
  assert.ok((after?.hp ?? 0) < hpBefore, '应该被塔打掉血');
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

test('城市只能造当前时代和上一个时代的兵种', () => {
  const s = fresh();
  const city = citiesOf(s, 'A')[0];
  assert.ok(city);
  city.era = 3;
  s.players.A.gold = 9999;

  assert.ok(
    applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'spearman' }).ok,
    '上一个时代的兵种应该还能造',
  );
  assert.equal(
    applyAction(s, { type: 'RECRUIT', cityId: city.id, unitType: 'militia' }).ok,
    false,
    '两个时代前的兵种已经被淘汰',
  );
});

console.log('\n时代链');

test('时代从古典到现代共 5 级，升级费递增', () => {
  assert.equal(ERAS.length, 5);
  assert.equal(ERAS[0].name, '古典');
  assert.equal(ERAS[4].name, '现代');
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
  for (const era of ERAS) {
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

test('勾选奇想兵种包会把额外兵种注入本局', () => {
  const plain = fresh();
  const fantasy = fresh({ expansionIds: ['fantasy-units'] });
  assert.equal(plain.unitTypes.dragoon, undefined);
  for (const id of ['dragoon', 'warlock', 'behemoth', 'griffin', 'banshee', 'treant', 'vampire', 'dragon']) {
    assert.ok(fantasy.unitTypes[id], `勾选后应该出现 ${id}`);
  }
});

test('奇想兵种包每个兵种都带一条机制', () => {
  const s = fresh({ expansionIds: ['fantasy-units'] });
  const pack = EXPANSIONS.find((e) => e.id === 'fantasy-units');
  assert.ok(pack?.units && pack.units.length >= 6, '兵种包应该有一整套兵');
  for (const u of pack.units!) {
    const hasMech = (u.abilities ?? []).length > 0 || (u.splash ?? 0) > 0 || (u.burst ?? 1) > 1;
    assert.ok(hasMech, `${u.name} 只是一组数值，没有带任何机制`);
    // 能力 id 必须真实存在，否则 rules.ts 里那一段永远不会被走到
    for (const a of u.abilities ?? []) {
      assert.ok(ABILITIES.some((d) => d.id === a), `${u.name} 引用了不存在的能力 ${a}`);
    }
    assert.ok(u.era >= 1 && u.era <= ERAS.length, `${u.name} 的时代越界`);
  }
  assert.ok(s.unitTypes.dragon, '五级应该有一张自己的牌');
});

test('飞行：能越过整条河，但停不到水面上', () => {
  const s = fresh({ expansionIds: ['fantasy-units'] });
  // 把一整列改成水：这样"从右边绕过去"是不可能的，能过去就只能是飞过去
  const cols: number[] = [];
  for (let x = 1; x < s.w - 1; x++) {
    let clear = true;
    for (let y = 0; y < s.h; y++) if (s.tiles[idx(s, x, y)].cityId) clear = false;
    if (clear) cols.push(x);
  }
  const x0 = cols[Math.floor(cols.length / 2)]!;
  for (let y = 0; y < s.h; y++) s.tiles[idx(s, x0, y)].terrain = 'water';
  for (let y = 0; y < s.h; y++) {
    for (const x of [x0 - 1, x0 + 1]) {
      const t = s.tiles[idx(s, x, y)];
      if (t.terrain === 'water' || t.terrain === 'mountain') t.terrain = 'plain';
    }
  }
  s.units = s.units.filter((u) => u.x !== x0 && u.x !== x0 - 1 && u.x !== x0 + 1);

  const y0 = Math.floor(s.h / 2);
  const griffin = placeDef(s, 'A', 'griffin', x0 - 1, y0);
  const reach = reachableTiles(s, griffin);
  assert.ok(reach.has(idx(s, x0 + 1, y0)), '狮鹫应该能飞到对岸');
  for (const i of reach.keys()) {
    const { x, y } = { x: i % s.w, y: Math.floor(i / s.w) };
    assert.notEqual(s.tiles[idx(s, x, y)].terrain, 'water', '落点不能在水上');
  }

  // 对照：同样起点的骑兵（move 3）连河对岸都摸不到
  s.units = s.units.filter((u) => u.id !== griffin.id);
  const knight = place(s, 'A', 'knight', x0 - 1, y0);
  const landReach = reachableTiles(s, knight);
  assert.equal(landReach.has(idx(s, x0 + 1, y0)), false, '骑兵过不了河');
});

test('冲锋：动过才有 +5，反击不吃这个加成', () => {
  const s = fresh();
  grantAbility(s, 'militia', 'charge');
  const { a, b } = duel(s);
  const still = computeDamage(s, a, b);
  a.moved = true;
  assert.equal(computeDamage(s, a, b) - still, 5, '移动过之后应该多 5 点');

  // 反击是原地还手：同样一个"动过"的单位，反击伤害不该多出来
  b.moved = false;
  const counterStill = computeDamage(s, b, a, true);
  b.moved = true;
  assert.equal(computeDamage(s, b, a, true), counterStill);
});

test('威吓：相邻敌军攻击 −2，最多叠两层', () => {
  const s = fresh({ expansionIds: ['fantasy-units'] });
  const { a, b } = duel(s);
  const base = computeDamage(s, a, b);
  const one = placeDef(s, 'B', 'banshee', a.x - 1, a.y);
  s.tiles[idx(s, one.x, one.y)].terrain = 'plain';
  assert.equal(computeDamage(s, a, b), base - 2, '一个女妖贴身应该 −2');

  const two = placeDef(s, 'B', 'banshee', a.x, a.y + 1);
  s.tiles[idx(s, two.x, two.y)].terrain = 'plain';
  assert.equal(computeDamage(s, a, b), base - 4, '两个女妖应该 −4');

  const three = placeDef(s, 'B', 'banshee', a.x + 1, a.y);
  s.tiles[idx(s, three.x, three.y)].terrain = 'plain';
  assert.equal(computeDamage(s, a, b), base - 4, '三层封顶，不再继续扣');
});

test('吸血：把真打出来的伤害换四成血，上限不超过生命上限', () => {
  const s = fresh({ expansionIds: ['fantasy-units'] });
  const vamp = placeDef(s, 'A', 'vampire', 5, 5);
  // 靶子用戟兵：民兵会被一击打死，那就没有反击、也测不出"结算顺序"
  const target = place(s, 'B', 'halberdier', 5, 4);
  s.tiles[idx(s, 5, 5)].terrain = 'plain';
  s.tiles[idx(s, 5, 4)].terrain = 'plain';
  const maxHp = s.unitTypes.vampire!.maxHp;
  vamp.hp = 20;
  const dmg = computeDamage(s, vamp, target);
  const counter = computeDamage(s, target, vamp, true);
  assert.ok(dmg > 0 && counter > 0, '这组数据应该打得出伤害、也挨得到反击');
  const r = applyAction(s, { type: 'ATTACK', unitId: vamp.id, targetId: target.id });
  assert.ok(r.ok);
  assert.ok(r.state.units.some((u) => u.id === target.id), '靶子应该活着，这样才有反击');
  const after = r.state.units.find((u) => u.id === vamp.id)!;
  const heal = Math.min(maxHp - (20 - counter), Math.round(dmg * 0.4));
  assert.equal(after.hp, 20 - counter + heal);
  assert.ok(heal > 0, '这一下应该真的吸到血');

  // 满血时不会溢出上限
  vamp.hp = maxHp;
  const r2 = applyAction(s, { type: 'ATTACK', unitId: vamp.id, targetId: target.id });
  assert.ok(r2.ok);
  assert.equal(r2.state.units.find((u) => u.id === vamp.id)!.hp, maxHp);
});

test('再生：每回合开始回 10% 上限，动过也算', () => {
  const s = fresh({ expansionIds: ['fantasy-units'] });
  const treant = placeDef(s, 'A', 'treant', 5, 5);
  treant.hp = 30;
  treant.moved = true;
  treant.acted = true;
  // 换手两次才轮到 A 自己开局
  const r1 = applyAction(s, { type: 'END_TURN' });
  assert.ok(r1.ok);
  assert.equal(r1.state.units.find((u) => u.id === treant.id)!.hp, 30, '对手回合不该回血');
  const r2 = applyAction(r1.state, { type: 'END_TURN' });
  assert.ok(r2.ok);
  const after = r2.state.units.find((u) => u.id === treant.id)!;
  // 按兵种表算，不写死：这一条测的是"回多少"，不是"这兵现在多少血"
  assert.equal(after.hp, 30 + Math.ceil(s.unitTypes.treant!.maxHp * 0.1));
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
  const off = fresh();
  const d0 = duel(off);
  const baseCounter = computeDamage(off, d0.a, d0.b, true);

  const on = fresh({ expansionIds: ['last-stand'] });
  const d1 = duel(on);
  on.firstCityLost = 'A';
  assert.equal(computeDamage(on, d1.a, d1.b, true), Math.round(baseCounter * 1.1));
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
    // 纯表现层扩展（比如"浓雾"把地形也遮掉）没有钩子是正常的，
    // 但它必须自己声明过 presentationOnly，否则就是"注册了个什么都不干的包"
    assert.ok(
      hasHooks || hasUnits || e.presentationOnly === true,
      `${e.id} 既没有钩子也没有兵种，等于空包`,
    );
    if (e.presentationOnly) {
      assert.equal(hasHooks, false, `${e.id} 声明了纯表现层，就不该再带钩子`);
      assert.equal(hasUnits, false, `${e.id} 声明了纯表现层，就不该再带兵种`);
    }
  }
});

console.log('\n迷雾');

test('开局看不到对方后场', () => {
  const s = fresh();
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
  assert.equal(boosted, Math.round(normal * 1.5));
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
  assert.ok(ABILITIES.length >= 8);
  for (const a of ABILITIES) {
    assert.ok(a.id && a.name && a.summary, `${a.id} 缺字段`);
  }
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
  const def = UNIT_TYPES[type];
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

/**
 * 摆一个"这一局才有"的兵种（扩展包里的兵不在 UNIT_TYPES 里）。
 * 和 place 一样会先把落点上的单位清掉，避免两支部队叠在一格。
 */
function placeDef(s: GameState, owner: 'A' | 'B', type: string, x: number, y: number): Unit {
  const def = s.unitTypes[type];
  assert.ok(def, `本局没有 ${type} 这个兵种`);
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
    atk.moved = false;
    atk.acted = false;
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

console.log('\n射程 / 溅射 / 连击');

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

test('连击：每段单独减护甲，打重甲反而更弱', () => {
  const s = fresh();
  s.current = 'A';
  s.units = [];

  const mg = place(s, 'A', 'mg', 5, 5);
  const burst = UNIT_TYPES.mg?.burst ?? 1;
  assert.ok(burst >= 2);

  // 要验证"打满段数"，目标得扛得住——打死了就提前停手（那是设计）
  const tough = place(s, 'B', 'tank', 7, 5);
  const p = previewAttack(s, mg, tough);
  const one = computeDamage(s, mg, tough);
  assert.equal(p.hits, burst, '应该打满段数');
  assert.equal(p.toDefender, one * burst, '总伤害 = 每段 × 段数');

  // 软目标：血薄，可能两段就打死，此时段数按"打了几下"算
  const soft = place(s, 'B', 'militia', 6, 5);
  const ps = previewAttack(s, mg, soft);
  assert.ok(ps.hits <= burst);

  // 同样的总攻击力，如果是一次打完，护甲只减一次；分成三段就减三次。
  // 把目标放到城市格上（+3 地形护甲）就能看出这个差距。
  const city = citiesOf(s, 'B')[0];
  assert.ok(city);
  const t0 = cityTiles(city)[0];
  assert.ok(t0);
  const hard = place(s, 'B', 'militia', t0.x, t0.y);

  const perHit = computeDamage(s, mg, hard);
  const burstTotal = perHit * burst;

  // 单发等效：同样的攻击力一次性打出去，护甲只减一次
  const armor = (UNIT_TYPES.militia?.armor ?? 0) + CONFIG.terrainDef.city;
  const singleBlow = Math.max(0, (UNIT_TYPES.mg?.atk ?? 0) * burst - armor);
  assert.ok(
    burstTotal < singleBlow,
    `打重甲时连击应该吃亏：连击 ${burstTotal} vs 等效单发 ${singleBlow}`,
  );

  const p2 = previewAttack(s, mg, hard);
  // 血不够就提前停手：段数会小于 burst，总伤害按实际打出的段数算。
  // 这里不能死写 burstTotal —— 兵种数值一动，民兵可能在第二段就被打死。
  assert.ok(p2.hits <= burst);
  assert.equal(p2.toDefender, perHit * p2.hits, `实际打了 ${p2.hits} 段`);
});

test('连击段数按兵种不同，不是固定三段', () => {
  const counts = [...new Set(Object.values(UNIT_TYPES).filter((u) => u.burst).map((u) => u.burst))];
  assert.ok(counts.length >= 3, `段数应该拉开档次，现在只有：${counts.join('、')}`);
  assert.ok((UNIT_TYPES.armoredcar?.burst ?? 0) >= 2);
  assert.ok((UNIT_TYPES.mg?.burst ?? 0) >= 3);
  assert.ok((UNIT_TYPES.hmg?.burst ?? 0) > (UNIT_TYPES.mg?.burst ?? 0), '重机枪的段数应该多于机枪队');

  // 段数越多，单段越弱：不然四段单位会直接翻倍
  const mg = UNIT_TYPES.mg;
  const hmg = UNIT_TYPES.hmg;
  assert.ok(mg && hmg);
  assert.ok(hmg.atk < mg.atk, '四段的单段攻击力应该比三段低');
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
    atk.moved = false;
    atk.acted = false;
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
  const enemyCity = citiesOf(cur, 'A')[0];
  assert.ok(enemyCity, '应该有敌方城市');

  const combatOf = (s: GameState, p: 'A' | 'B') =>
    unitsOf(s, p).filter((u) => utype(s, u.type).category === 'combat');
  const front = (s: GameState) => Math.min(...combatOf(s, 'B').map((u) => distToCity(u, enemyCity)));
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

test('AI 不会每回合都做同一件事', () => {
  const picks = new Set<string>();
  for (let t = 1; t <= 12; t++) {
    const s = fresh();
    s.current = 'A';
    s.players.A.gold = 900;
    s.turn = t;
    picks.add(JSON.stringify(aiNextAction(s)));
  }
  assert.ok(picks.size >= 3, `十二个回合里只出现 ${picks.size} 种选择，太单调`);
});

test('不同种子的 AI 性格不同', () => {
  const a = aiTraits(fresh(undefined, 11));
  const b = aiTraits(fresh(undefined, 22));
  assert.notEqual(a.appetite, b.appetite, '推进欲望应该随种子变化');
  assert.ok(a.appetite >= 0.85 && a.appetite <= 1.2, '推进欲望应该落在合理区间');
  assert.ok(a.favorites.length >= 1, '应该有兵种偏好');
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

test('拆桥要贴到桥头，隔着河放箭打不塌', () => {
  // 允许远程拆桥的后果是"谁先架桥谁吃亏"：模拟里两边各架七八座、桥头来回换，
  // 打满 200 回合谁也过不去——六成的"地形隔断"磨局都是这么来的。
  const s = fresh({ startEra: 1, size: 12 }, 7171);
  s.units = [];
  for (const t of s.tiles) {
    if (t.terrain !== 'city') t.terrain = 'plain';
  }
  for (const y of [4, 5]) for (let x = 0; x < s.w; x++) s.tiles[idx(s, x, y)].terrain = 'water';
  s.tiles[idx(s, 5, 4)].terrain = 'bridge';
  const bridge = place(s, 'B', 'bridge', 5, 4);
  const bow = place(s, 'A', 'longbow', 5, 2);

  s.current = 'A';
  refreshMemory(s);
  const far = applyAction(s, { type: 'ATTACK', unitId: bow.id, targetId: bridge.id });
  assert.equal(far.ok, false, '隔两格不该能打桥');
  assert.ok(far.reason.includes('桥头'), `理由要写清楚：${far.reason}`);

  // 走到桥头（岸边那一格）就能拆
  bow.moved = false;
  bow.acted = false;
  bow.x = 5;
  bow.y = 3;
  const near = applyAction(s, { type: 'ATTACK', unitId: bow.id, targetId: bridge.id });
  assert.ok(near.ok, `贴着桥头应该能拆：${!near.ok ? near.reason : ''}`);
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

test('AI 会往前线扎军营，不是把钱全堆在城里', () => {
  // 磨局统计里最刺眼的一条：一方顶满 24 个单位、金库还压着几千金。
  // 钱花不出去等于没有压力，而军营是唯一能把钱直接变成"前线产兵点"的东西。
  const s = fresh({ startEra: 2, size: 16, aiLevel: 'advanced' }, 4848);
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
    for (let i = 0; i < 80; i++) {
      const a = aiNextAction(st);
      if (!a) break;
      if (a.type === 'BUILD' && st.unitTypes[a.unitType]?.barracks) built.push(a.unitType);
      const r = applyAction(st, a);
      if (!r.ok) break;
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

/* ------------------------------------------------------------------ */
/* 时代兵种包（大型模组）                                              */
/* ------------------------------------------------------------------ */

/**
 * 这几条守的是"设计约束"，不是"规则正确"：
 * 单位数据一旦被人手改坏（改错时代、抄重复 id、把古典贵兵塞进开局池），
 * 平衡报告会立刻失真，但游戏本身照样能跑——所以必须靠测试拦住。
 */
const packs = EXPANSIONS.filter((e) => e.id.startsWith('pack-'));

test('五个时代包都在，且各自的兵种数多于原版同期', () => {
  assert.equal(packs.length, 5, '应有五个时代包');
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
  const abilityIds = new Set(ABILITIES.map((a) => a.id));
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

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
if (failed > 0) process.exit(1);

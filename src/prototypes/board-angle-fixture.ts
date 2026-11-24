import type { FixedMap } from '../core/fixed-maps.ts';
import { createMatch, DEFAULT_CONFIG } from '../core/setup.ts';
import type { GameState, Unit } from '../core/types.ts';

export type BoardAngleScene = 'elevation' | 'damage2' | 'damage' | 'future' | 'cities' | 'all' | 'river' | 'lake' | 'sea';

const near = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;

const ellipDist = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): number =>
  Math.hypot((x - cx) / rx, (y - cy) / ry);

function riverTerrain16(x: number, y: number): string {
  const center = 7.4 + Math.sin(y * 0.39) * 1.3;
  const fromRiver = Math.abs(x - center);
  if (fromRiver < 1.65) {
    if (y === 8) return '=';
    if (fromRiver < 0.45 && (y <= 5 || y >= 11)) return 'D';
    return fromRiver < 0.95 ? '~' : 's';
  }
  if ((x === 4 && y >= 2 && y <= 3) || (x === 3 && y === 2) ||
      (x === 13 && y >= 10 && y <= 12) || (x === 12 && y === 11)) return '^';
  if (near(x, y, 4.1, 3.8, 2.2, 2.6) || near(x, y, 12.4, 11.2, 2.3, 3.5)) return 'h';
  if ((x <= 2 && y <= 5 && (x + y) % 5 !== 4) ||
      (x >= 12 && y <= 2 && x + y !== 14) ||
      (x <= 4 && y >= 13 && (x * 3 + y) % 7 > 0) ||
      (x >= 14 && y >= 6 && y <= 10)) return 'f';
  return '.';
}

function riverTerrain32(x: number, y: number): string {
  const center = 15.2 + Math.sin(y * 0.155) * 2.7 + Math.sin(y * 0.41) * 1.1;
  const distance = Math.abs(x - center);
  if (distance < 2.35) {
    if (y === 9 || y === 22) return '=';
    if (distance < 0.65 && (y < 7 || (y > 12 && y < 19) || y > 25)) return 'D';
    return distance < 1.35 ? '~' : 's';
  }
  if (near(x, y, 7.5, 5, 2.3, 2.6) || near(x, y, 25.1, 23.6, 2.1, 3.4)) return '^';
  if (near(x, y, 8, 7, 5.7, 5.2) || near(x, y, 24.5, 24, 5.2, 6.3) ||
      near(x, y, 23.7, 4.1, 4.3, 3) || near(x, y, 8.8, 27, 4.2, 2.4)) return 'h';
  if (near(x, y, 2.4, 5.1, 3.7, 5.8) || near(x, y, 27.2, 4.8, 4.1, 5.3) ||
      near(x, y, 3.4, 25.3, 4.4, 6.4) || near(x, y, 30.4, 15.3, 3.6, 6.2) ||
      near(x, y, 20.5, 29, 4.2, 3.5)) return 'f';
  return '.';
}

function allTerrain16(x: number, y: number): string {
  // 1. 左侧蜿蜒河流（北→南，河心水域 + 两岸浅流 + 木桥）
  const riverX = 4.2 + Math.sin(y * 0.42) * 0.75;
  const dRiver = Math.abs(x - riverX);
  if (dRiver < 1.35) {
    if (y === 7) return '=';
    return dRiver < 0.62 ? '~' : 's';
  }
  // 2. 右上封闭内陆湖（不触边：浅流环岸 → 湖面水域 → 深水湖心）
  const dLake = ellipDist(x, y, 11.4, 3.8, 2.7, 2.4);
  if (dLake < 1 && x <= 14 && y >= 1) {
    if (dLake < 0.38) return 'D';
    if (dLake < 0.72) return '~';
    return 's';
  }
  // 3. 右下开阔海湾与深海（触东、南边界：浅滩拍岸 → 近海 → 深海涌浪）
  const dSea = ellipDist(x, y, 15.6, 15.6, 6.9, 6.4);
  if (dSea < 1) {
    if (dSea < 0.50) return 'D';
    if (dSea < 0.78) return '~';
    return 's';
  }
  // 4. 陆地地形：高山、丘陵、森林、平原
  if ((x === 7 && y === 2) || (x === 8 && y === 2) || (x === 7 && y === 3)) return '^';
  if (near(x, y, 7.6, 3.5, 1.8, 2.2) || near(x, y, 1.4, 4.5, 1.8, 2.5)) return 'h';
  if ((x <= 2 && y <= 2) || (x >= 13 && y >= 7 && y <= 9) || (x <= 2 && y >= 13) || (x === 6 && y >= 12 && y <= 14)) return 'f';
  return '.';
}

function allTerrain32(x: number, y: number): string {
  // 1. 左侧大河（北→南，浅流漫滩 + 航道水域 + 河湾深槽 + 双桥）
  const riverX = 8.4 + Math.sin(y * 0.21) * 1.65;
  const dRiver = Math.abs(x - riverX);
  if (dRiver < 2.15) {
    if (y === 10 || y === 22) return '=';
    if (dRiver < 0.55 && (y < 7 || (y > 14 && y < 19))) return 'D';
    return dRiver < 1.2 ? '~' : 's';
  }
  // 2. 右上青山明湖（四面环陆、绝不触边：浅滩 → 水域 → 深潭）
  const dLake = ellipDist(x, y, 23.2, 8.6, 5.4, 4.5);
  if (dLake < 1) {
    if (dLake < 0.40) return 'D';
    if (dLake < 0.74) return '~';
    return 's';
  }
  // 3. 东南开阔深海与海岸（紧贴东/南边：深海涌浪 → 近海 → 浅流沙滩）
  const dSea = ellipDist(x, y, 31.6, 31.6, 14.2, 12.8);
  if (dSea < 1) {
    // 海中留一座小礁岛点缀海浪拍岸
    if (near(x, y, 25.2, 24.4, 1.7, 1.5)) return 'h';
    if (dSea < 0.52) return 'D';
    if (dSea < 0.79) return '~';
    return 's';
  }
  // 4. 高山、丘陵、森林、平原协调排布
  if (near(x, y, 16.2, 4.4, 2.2, 2.2) || near(x, y, 3.2, 5.2, 2.0, 2.4)) return '^';
  if (near(x, y, 16.0, 5.8, 4.1, 3.8) || near(x, y, 3.6, 6.6, 3.6, 4.2) ||
      near(x, y, 14.8, 25.8, 3.4, 3.2)) return 'h';
  if (near(x, y, 2.2, 16.5, 2.8, 4.8) || near(x, y, 29.2, 14.6, 3.0, 3.4) ||
      near(x, y, 18.6, 16.2, 2.8, 2.6) || near(x, y, 26.8, 2.2, 3.6, 2.2) ||
      near(x, y, 3.2, 29.0, 3.4, 2.8)) return 'f';
  return '.';
}

function lakeTerrain(size: 16 | 32, x: number, y: number): string {
  const c = (size - 1) / 2;
  const rx = size === 16 ? 4.8 : 9.4;
  const ry = size === 16 ? 4.4 : 8.6;
  const warp = Math.sin((x - c) * 0.45) * 0.08 + Math.cos((y - c) * 0.5) * 0.07;
  const d = ellipDist(x, y, c, c, rx, ry) + warp;
  if (d < 1 && x >= 2 && x <= size - 3 && y >= 2 && y <= size - 3) {
    if (d < 0.42) return 'D';
    if (d < 0.74) return '~';
    return 's';
  }
  const s = size / 16;
  if (near(x, y, 3.0 * s, 2.8 * s, 1.4 * s, 1.5 * s) || near(x, y, 13.0 * s, 13.0 * s, 1.5 * s, 1.5 * s)) return '^';
  if (near(x, y, 3.4 * s, 3.5 * s, 2.8 * s, 2.8 * s) || near(x, y, 12.6 * s, 12.4 * s, 2.8 * s, 2.8 * s)) return 'h';
  if (near(x, y, 12.8 * s, 3.0 * s, 2.6 * s, 2.4 * s) || near(x, y, 3.0 * s, 12.8 * s, 2.6 * s, 2.5 * s)) return 'f';
  return '.';
}

function seaTerrain(size: 16 | 32, x: number, y: number): string {
  const s = size / 16;
  // 西北大陆半岛 + 东北小岛，其余为广阔海洋（浅滩 → 近海 → 深海）
  const dMain = ellipDist(x, y, 2.4 * s, 4.2 * s, 5.4 * s, 6.2 * s);
  const dIsle = ellipDist(x, y, 12.6 * s, 4.0 * s, 3.2 * s, 3.4 * s);
  const dLand = Math.min(dMain, dIsle);
  if (dLand < 1) {
    if (near(x, y, 2.2 * s, 2.6 * s, 1.3 * s, 1.3 * s)) return '^';
    if (near(x, y, 2.8 * s, 3.4 * s, 2.4 * s, 2.4 * s) || near(x, y, 12.8 * s, 3.6 * s, 1.5 * s, 1.5 * s)) return 'h';
    if (near(x, y, 1.5 * s, 7.6 * s, 2.0 * s, 2.2 * s) || near(x, y, 11.4 * s, 5.2 * s, 1.5 * s, 1.4 * s)) return 'f';
    return '.';
  }
  if (dLand < 1.24) return 's';
  if (dLand < 1.62) return '~';
  return 'D';
}

function citiesTerrain(size: 16 | 32, x: number, y: number): string {
  const s = size / 16;
  // 右下角浅海与近海点缀
  const dSea = ellipDist(x, y, 15.8 * s, 15.8 * s, 3.8 * s, 3.6 * s);
  if (dSea < 1) {
    if (dSea < 0.45) return 'D';
    if (dSea < 0.74) return '~';
    return 's';
  }
  // 西南侧小河蜿蜒而过
  const riverY = 12.8 * s + Math.sin(x * 0.42 / s) * 0.8 * s;
  if (x < 9.5 * s && Math.abs(y - riverY) < 1.15 * s) {
    if (Math.round(x) === Math.round(5.5 * s)) return '=';
    return Math.abs(y - riverY) < 0.55 * s ? '~' : 's';
  }
  // 四周点缀高山、丘陵、森林，中央开阔平原展示五个时代的城市
  if (near(x, y, 13.4 * s, 2.4 * s, 1.3 * s, 1.3 * s)) return '^';
  if (near(x, y, 13.0 * s, 3.0 * s, 2.3 * s, 2.3 * s) || near(x, y, 1.4 * s, 1.2 * s, 1.4 * s, 1.4 * s)) return 'h';
  if (near(x, y, 14.0 * s, 7.6 * s, 1.8 * s, 2.2 * s) || near(x, y, 1.2 * s, 9.8 * s, 1.5 * s, 1.8 * s) ||
      near(x, y, 5.2 * s, 0.8 * s, 1.6 * s, 1.1 * s)) return 'f';
  return '.';
}

function damageTerrain(w: number, h: number, x: number, y: number): string {
  // 开阔平原整齐排布 时代1~5 × 4档受损（20城），仅在最外边缘点缀极少地貌
  if (x === w - 1 && y >= h - 3) return 's';
  if (x === 0 && y >= h - 2) return 'f';
  if (x === w - 1 && y <= 1) return 'h';
  return '.';
}

function elevationTerrain(w: number, _h: number, x: number, y: number): string {
  const s = w / 24;
  // 1. 东北方层层抬升的高原阶梯：高山(^) -> 台地(P) -> 丘陵(h) -> 平原(.)
  const dPeak = ellipDist(x, y, 18.6 * s, 4.6 * s, 2.0 * s, 2.0 * s);
  const dPlat = ellipDist(x, y, 16.4 * s, 6.2 * s, 5.4 * s, 4.4 * s);
  const dHill = ellipDist(x, y, 15.6 * s, 6.8 * s, 7.6 * s, 6.2 * s);
  // 东南偏东再设一座独立小台地，直观展示台地直落平原与丘陵的峭壁剖面
  const dMiniPlat = ellipDist(x, y, 19.6 * s, 16.8 * s, 2.8 * s, 2.4 * s);
  const dMiniHill = ellipDist(x, y, 19.2 * s, 17.0 * s, 4.3 * s, 3.6 * s);

  if (dPeak < 1) return '^';
  if (dPlat < 1 || dMiniPlat < 1) return 'P';
  if (dHill < 1 || dMiniHill < 1) return 'h';

  // 2. 贯穿中央的蜿蜒下陷河谷：谷地(v) 夹护溪流(s/~) 与木桥(=)
  const gorgeY = 12.2 * s + Math.sin(x * 0.28 / s) * 1.8 * s + (x - 12 * s) * 0.22;
  const dg = Math.abs(y - gorgeY);
  if (dg < 0.72 * s && x >= 1 && x <= w - 2) {
    if (Math.round(x) === Math.round(9 * s) || Math.round(x) === Math.round(15 * s)) return '=';
    return dg < 0.36 * s ? '~' : 's';
  }
  if (dg < 2.55 * s && x >= 1 && x <= w - 2) return 'v';

  // 3. 西南与西北的大片泥泞沼泽盆地(w) + 木桥与林缘
  const dSwamp1 = ellipDist(x, y, 6.2 * s, 18.2 * s, 4.8 * s, 4.0 * s);
  const dSwamp2 = ellipDist(x, y, 4.8 * s, 6.2 * s, 3.5 * s, 3.0 * s);
  if (dSwamp1 < 1) {
    if (Math.round(x) === Math.round(6 * s) && Math.round(y) === Math.round(18 * s)) return '=';
    return 'w';
  }
  if (dSwamp2 < 1) return 'w';

  // 4. 少量林地点缀，便于对比平原、森林、谷地、沼泽与台地色相
  if (near(x, y, 1.8 * s, 14.5 * s, 1.8 * s, 2.2 * s) || near(x, y, 12.5 * s, 21.0 * s, 2.2 * s, 1.8 * s) ||
      near(x, y, 9.2 * s, 2.2 * s, 1.8 * s, 1.5 * s)) return 'f';

  return '.';
}

export function boardAngleFixture(size: 16 | 32, scene: BoardAngleScene = 'all'): GameState {
  const mapW = scene === 'damage' || scene === 'damage2' ? 20 : scene === 'elevation' ? 24 : size;
  const mapH = scene === 'damage' ? 20 : scene === 'damage2' ? 16 : scene === 'elevation' ? 24 : size;
  const cellOf = (x: number, y: number): string => {
    if (scene === 'elevation') return elevationTerrain(mapW, mapH, x, y);
    if (scene === 'damage' || scene === 'damage2') return damageTerrain(mapW, mapH, x, y);
    if (scene === 'cities' || scene === 'future') return citiesTerrain(size, x, y);
    if (scene === 'river') return size === 16 ? riverTerrain16(x, y) : riverTerrain32(x, y);
    if (scene === 'lake') return lakeTerrain(size, x, y);
    if (scene === 'sea') return seaTerrain(size, x, y);
    return size === 16 ? allTerrain16(x, y) : allTerrain32(x, y);
  };

  const sceneNames: Record<BoardAngleScene, string> = {
    elevation: '地形高差（台地 / 谷地 / 沼泽）',
    damage2: '时代六至八 · 四档受损（常态/受损/重创/废墟）',
    damage: '时代一至五 · 四档受损（常态/受损/重创/废墟）',
    future: '时代五至八（现代→未来）',
    cities: '全八时代城市演进',
    all: '河湖海全览',
    river: '河口高地',
    lake: '青山明湖',
    sea: '群岛深海',
  };

  const citiesByScene: Record<BoardAngleScene, {
    a16: Array<{ x: number; y: number }>;
    b16: Array<{ x: number; y: number }>;
    a32: Array<{ x: number; y: number }>;
    b32: Array<{ x: number; y: number }>;
    eras16: number[];
    eras32: number[];
  }> = {
    elevation: {
      a16: [{ x: 1, y: 1 }],
      b16: [{ x: 20, y: 20 }],
      a32: [{ x: 1, y: 1 }],
      b32: [{ x: 20, y: 20 }],
      eras16: [2, 4],
      eras32: [2, 4],
    },
    damage2: {
      a16: [{ x: 1, y: 2 }],
      b16: [{ x: 16, y: 12 }],
      a32: [{ x: 1, y: 2 }],
      b32: [{ x: 16, y: 12 }],
      eras16: [6, 8],
      eras32: [6, 8],
    },
    damage: {
      // 占位用 1+1 城通过固定图校验，下面直接注入完整 5 时代 × 4 档（20 城）
      a16: [{ x: 1, y: 1 }],
      b16: [{ x: 16, y: 17 }],
      a32: [{ x: 1, y: 1 }],
      b32: [{ x: 16, y: 17 }],
      eras16: [1, 5],
      eras32: [1, 5],
    },
    future: {
      a16: [{ x: 2, y: 3 }, { x: 8, y: 2 }],
      b16: [{ x: 3, y: 8 }, { x: 9, y: 8 }],
      a32: [{ x: 6, y: 6 }, { x: 16, y: 5 }],
      b32: [{ x: 8, y: 17 }, { x: 19, y: 16 }],
      eras16: [5, 6, 7, 8],
      eras32: [5, 6, 7, 8],
    },
    cities: {
      a16: [{ x: 1, y: 2 }, { x: 5, y: 1 }, { x: 9, y: 1 }, { x: 2, y: 6 }],
      b16: [{ x: 6, y: 5 }, { x: 10, y: 5 }, { x: 5, y: 9 }, { x: 9, y: 9 }],
      a32: [{ x: 3, y: 5 }, { x: 10, y: 3 }, { x: 17, y: 3 }, { x: 5, y: 13 }],
      b32: [{ x: 12, y: 11 }, { x: 19, y: 11 }, { x: 11, y: 19 }, { x: 19, y: 19 }],
      eras16: [1, 2, 3, 4, 5, 6, 7, 8],
      eras32: [1, 2, 3, 4, 5, 6, 7, 8],
    },
    all: {
      a16: [{ x: 0, y: 9 }],
      b16: [{ x: 7, y: 8 }],
      a32: [{ x: 2, y: 12 }, { x: 2, y: 23 }],
      b32: [{ x: 14, y: 15 }, { x: 14, y: 10 }],
      eras16: [2, 6],
      eras32: [1, 4, 6, 8],
    },
    river: {
      a16: [{ x: 3, y: 10 }],
      b16: [{ x: 11, y: 3 }],
      a32: [{ x: 4, y: 12 }, { x: 8, y: 23 }],
      b32: [{ x: 24, y: 7 }, { x: 23, y: 17 }],
      eras16: [2, 3],
      eras32: [1, 2, 3, 4],
    },
    lake: {
      a16: [{ x: 1, y: 7 }],
      b16: [{ x: 13, y: 7 }],
      a32: [{ x: 2, y: 15 }],
      b32: [{ x: 28, y: 15 }],
      eras16: [2, 6],
      eras32: [2, 6],
    },
    sea: {
      a16: [{ x: 3, y: 5 }],
      b16: [{ x: 12, y: 3 }],
      a32: [{ x: 6, y: 10 }],
      b32: [{ x: 24, y: 7 }],
      eras16: [7, 8],
      eras32: [7, 8],
    },
  };

  const cCfg = citiesByScene[scene];
  const map: FixedMap = {
    id: `prototype-${scene}-${mapW}`,
    name: sceneNames[scene],
    w: mapW,
    h: mapH,
    rows: Array.from({ length: mapH }, (_, y) =>
      Array.from({ length: mapW }, (_, x) => cellOf(x, y)).join('')),
    citiesA: size === 16 ? cCfg.a16 : cCfg.a32,
    citiesB: size === 16 ? cCfg.b16 : cCfg.b32,
  };

  const match = createMatch({
    ...DEFAULT_CONFIG,
    fixedMap: map,
    size: mapW,
    startEra: 2,
    expansionIds: scene === 'elevation' ? ['height-terrain'] : [],
  }, 20261123, {});
  match.fog = false;
  if (scene === 'elevation') {
    const chToTerrain: Record<string, typeof match.tiles[number]['terrain']> = {
      '.': 'plain', f: 'forest', h: 'hill', '^': 'mountain',
      '~': 'water', s: 'shallow', D: 'deep', '=': 'bridge',
      P: 'plateau', v: 'valley', w: 'marsh',
    };
    for (let y = 0; y < match.h; y++) {
      for (let x = 0; x < match.w; x++) {
        const tile = match.tiles[y * match.w + x];
        if (!tile) continue;
        tile.terrain = chToTerrain[cellOf(x, y)] ?? 'plain';
      }
    }
    const eraPlan = size === 16 ? cCfg.eras16 : cCfg.eras32;
    match.cities.forEach((city, idx) => {
      city.era = eraPlan[idx] ?? city.era;
    });
  } else if (scene === 'damage' || scene === 'damage2') {
    // 确保展示区为干净平整的开阔平原，不被随机山脉/河流遮挡任何一座城
    for (let y = 0; y < match.h; y++) {
      for (let x = 0; x < match.w; x++) {
        const tile = match.tiles[y * match.w + x];
        if (!tile) continue;
        if (x === match.w - 1 && y >= match.h - 3) tile.terrain = 'shallow';
        else if (x === 0 && y >= match.h - 2) tile.terrain = 'forest';
        else if (x === match.w - 1 && y <= 1) tile.terrain = 'hill';
        else tile.terrain = 'plain';
      }
    }
    const template = match.cities[0]!;
    const xs = [1, 6, 11, 16] as const;
    const eras = scene === 'damage' ? ([1, 2, 3, 4, 5] as const) : ([6, 7, 8] as const);
    const ys = scene === 'damage' ? ([1, 5, 9, 13, 17] as const) : ([2, 7, 12] as const);
    const built = [];
    for (let row = 0; row < eras.length; row++) {
      const era = eras[row]!;
      const owner: 'A' | 'B' = row % 2 === 0 ? 'A' : 'B';
      for (let tier = 0; tier < 4; tier++) {
        const maxHp = template.maxHp;
        const hp = tier === 0 ? maxHp : tier === 1 ? Math.round(maxHp * 0.72) : tier === 2 ? Math.round(maxHp * 0.28) : 0;
        built.push({
          ...template,
          id: `damage-e${era}-t${tier}`,
          owner,
          era,
          x: xs[tier]!,
          y: ys[row]!,
          hp,
          ruined: tier === 3,
        });
      }
    }
    match.cities = built;
  } else {
    const eraPlan = size === 16 ? cCfg.eras16 : cCfg.eras32;
    match.cities.forEach((city, idx) => {
      city.era = eraPlan[idx] ?? city.era;
    });
  }

  const formations: Record<BoardAngleScene, Array<[Unit['owner'], string, number, number]>> = {
    elevation: [
      ['A', 'archer', 14, 6], ['A', 'spearman', 19, 17],
      ['A', 'militia', 7, 17], ['B', 'knight', 11, 13],
      ['B', 'archer', 5, 6], ['B', 'spearman', 16, 15],
    ],
    damage2: [],
    damage: [],
    future: size === 16 ? [
      ['A', 'spearman', 6, 4], ['B', 'knight', 7, 9],
    ] : [
      ['A', 'spearman', 12, 8], ['B', 'knight', 15, 18],
    ],
    cities: size === 16 ? [
      ['A', 'militia', 4, 4], ['B', 'knight', 12, 9],
    ] : [
      ['A', 'militia', 8, 8], ['B', 'knight', 24, 18],
    ],
    all: size === 16 ? [
      ['A', 'archer', 1, 7], ['A', 'spearman', 2, 7], ['A', 'militia', 1, 11],
      ['B', 'spearman', 6, 7], ['B', 'knight', 9, 7], ['B', 'archer', 10, 8],
    ] : [
      ['A', 'archer', 4, 10], ['A', 'spearman', 6, 10], ['A', 'militia', 4, 15], ['A', 'farmer', 5, 22],
      ['B', 'spearman', 12, 10], ['B', 'knight', 15, 12], ['B', 'archer', 16, 18], ['B', 'militia', 18, 14],
    ],
    river: size === 16 ? [
      ['A', 'archer', 2, 9], ['A', 'militia', 5, 11], ['A', 'spearman', 6, 8],
      ['A', 'farmer', 4, 12], ['B', 'archer', 13, 4], ['B', 'knight', 11, 6],
      ['B', 'spearman', 9, 8], ['B', 'militia', 11, 9],
    ] : [
      ['A', 'archer', 3, 10], ['A', 'militia', 6, 13], ['A', 'farmer', 4, 15],
      ['A', 'knight', 11, 11], ['A', 'spearman', 16, 9],
      ['A', 'archer', 7, 20], ['A', 'militia', 10, 24], ['A', 'spearman', 12, 22],
      ['B', 'archer', 26, 6], ['B', 'militia', 25, 10], ['B', 'spearman', 20, 9],
      ['B', 'knight', 21, 12], ['B', 'farmer', 25, 17], ['B', 'archer', 26, 18],
      ['B', 'militia', 20, 20], ['B', 'spearman', 18, 22],
    ],
    lake: size === 16 ? [
      ['A', 'archer', 2, 9], ['A', 'spearman', 2, 5],
      ['B', 'knight', 13, 5], ['B', 'militia', 13, 10],
    ] : [
      ['A', 'archer', 4, 13], ['A', 'spearman', 5, 17], ['A', 'knight', 9, 5],
      ['B', 'knight', 26, 13], ['B', 'archer', 26, 18], ['B', 'militia', 22, 26],
    ],
    sea: size === 16 ? [
      ['A', 'archer', 4, 7], ['A', 'spearman', 5, 4],
      ['B', 'knight', 11, 4], ['B', 'militia', 13, 5],
    ] : [
      ['A', 'archer', 8, 12], ['A', 'spearman', 10, 8], ['A', 'militia', 5, 14],
      ['B', 'knight', 22, 9], ['B', 'archer', 26, 10],
    ],
  };

  match.units = formations[scene]
    .filter(([, , x, y]) => {
      const ch = map.rows[y]?.[x];
      return Boolean(ch) && ch !== '~' && ch !== 'D' && ch !== '^';
    })
    .map(([owner, type, x, y], index) => ({
      id: `preview-unit-${index}`, owner, type, x, y,
      hp: match.unitTypes[type]!.maxHp, kills: 0, moved: false, acted: false,
    }));
  return match;
}

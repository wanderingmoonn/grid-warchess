const SAMPLES_PER_TILE = 16;
const RIDGE_SPACING = 54;

const crest = [224, 205, 157] as const;
const upper = [213, 193, 143] as const;
const middle = [207, 185, 133] as const;
const lower = [200, 177, 125] as const;
const shoulder = [196, 167, 116] as const;
const eastSlope = [185, 151, 100] as const;
const southSlope = [174, 138, 89] as const;
const foot = [159, 124, 78] as const;
const ridgeLight = [220, 200, 149] as const;
const ridgeShade = [186, 157, 108] as const;

/** 按世界坐标放置短山脊，脊线上下是两块朝向不同的斜面。 */
function ridgeFace(x: number, y: number): readonly [number, number, number] | undefined {
  const col = Math.floor(x / RIDGE_SPACING);
  const row = Math.floor(y / RIDGE_SPACING);
  const seed = Math.imul(col + 1, 0x9e3779b1) ^ Math.imul(row + 1, 0x85ebca6b);
  const dx = x - col * RIDGE_SPACING - 16 - (seed >>> 7) % 22;
  const dy = y - row * RIDGE_SPACING - 14 - (seed >>> 20) % 25;
  const length = 11 + (seed >>> 2) % 5;
  const width = 1 - Math.abs(dx) / length;
  const across = (dy + dx * 0.32 + (dx * dx) / 87) / 7;
  if (Math.abs(across) >= width) return undefined;
  return across < 0 ? ridgeLight : ridgeShade;
}

/**
 * 按地图画丘陵的顶面和坡面。南坡的高度约为 1/4 格，东坡更浅。
 * mask 为视图地形，1 是丘陵，2 是更高的地形，0 是其余地面。
 */
export function hillRelief(doc: Document, cols: number, rows: number, mask: string): string {
  if (!mask.includes('1') || typeof doc.defaultView?.CanvasRenderingContext2D !== 'function') return '';
  const canvas = doc.createElement('canvas');
  canvas.width = cols * SAMPLES_PER_TILE;
  canvas.height = rows * SAMPLES_PER_TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const { width, height } = canvas;
  const raised = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height &&
    mask[Math.floor(y / SAMPLES_PER_TILE) * cols + Math.floor(x / SAMPLES_PER_TILE)] !== '0';

  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const tileRow = Math.floor(y / SAMPLES_PER_TILE) * cols;
    const eastDepth = Math.sin(y / 17) > 0.45 ? 3 : 2;
    for (let x = 0; x < width; x++) {
      if (mask[tileRow + Math.floor(x / SAMPLES_PER_TILE)] !== '1') continue;
      // 坡折的位置沿地图坐标微调，跨格时不会在同一位置齐刷刷重起。
      const southDepth = Math.sin(x / 13 + y / 31) > 0.3 ? 5 : 4;
      const south = !raised(x, y + southDepth);
      const east = !raised(x + eastDepth, y);
      const ridge = Math.sin((x + y * 0.82) / 39) * Math.cos((y - x * 0.51) / 53);
      let color: readonly [number, number, number];
      if (!raised(x, y + 1) || (south && east)) color = foot;
      else if (south) color = southSlope;
      else if (east) color = eastSlope;
      else if (!raised(x, y + southDepth + 1) || !raised(x + eastDepth + 1, y)) color = shoulder;
      else if (!raised(x, y - 2) || !raised(x - 1, y)) color = crest;
      else color = ridgeFace(x, y) ?? (ridge > 0.3 ? upper : ridge < -0.22 ? lower : middle);

      const pixel = (y * width + x) * 4;
      image.data[pixel] = color[0];
      image.data[pixel + 1] = color[1];
      image.data[pixel + 2] = color[2];
      image.data[pixel + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return `url("${canvas.toDataURL()}")`;
}

const SAMPLES_PER_TILE = 6;
const BLUR_RADIUS = 4;
const LIGHT_STEP = 2;
const MARGIN = BLUR_RADIUS * 2 + LIGHT_STEP;

function soften(
  source: Float32Array,
  target: Float32Array,
  lineLength: number,
  lines: number,
  step: number,
  lineStep: number,
): void {
  const count = BLUR_RADIUS * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const start = line * lineStep;
    let sum = 0;
    for (let sample = 0; sample < BLUR_RADIUS; sample++) sum += source[start + sample * step]!;
    for (let sample = 0; sample < lineLength; sample++) {
      const enter = sample + BLUR_RADIUS;
      const leave = sample - BLUR_RADIUS - 1;
      if (enter < lineLength) sum += source[start + enter * step]!;
      if (leave >= 0) sum -= source[start + leave * step]!;
      target[start + sample * step] = sum / count;
    }
  }
}

/** 从棋盘可见地形生成一整张坡面明暗图，格子各取自己在图上的一块。 */
export function hillRelief(doc: Document, cols: number, rows: number, mask: string): string {
  if (!mask.includes('1') || typeof doc.defaultView?.CanvasRenderingContext2D !== 'function') return '';
  const canvas = doc.createElement('canvas');
  canvas.width = cols * SAMPLES_PER_TILE;
  canvas.height = rows * SAMPLES_PER_TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const width = canvas.width + 2 * MARGIN;
  const height = canvas.height + 2 * MARGIN;
  const field = new Float32Array(width * height);
  const buffer = new Float32Array(field.length);
  for (let y = 0; y < canvas.height; y++) {
    const tileRow = Math.floor(y / SAMPLES_PER_TILE) * cols;
    for (let x = 0; x < canvas.width; x++) {
      if (mask[tileRow + Math.floor(x / SAMPLES_PER_TILE)] !== '1') continue;
      const rise = Math.sin(x * 0.073 + y * 0.037) * Math.sin(y * 0.088 - x * 0.029);
      field[(y + MARGIN) * width + x + MARGIN] = 0.87 + 0.13 * rise;
    }
  }
  // 先平滑整个高程场，再沿左上到右下取坡度，避免在格边重起一段明暗。
  for (let pass = 0; pass < 2; pass++) {
    soften(field, buffer, width, height, 1, width);
    soften(buffer, field, height, width, width, 1);
  }

  const image = ctx.createImageData(canvas.width, canvas.height);
  const diagonal = LIGHT_STEP * (width + 1);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const origin = (y + MARGIN) * width + x + MARGIN;
      const slope = field[origin + diagonal]! - field[origin - diagonal]!;
      const pixel = (y * canvas.width + x) * 4;
      image.data[pixel] = slope >= 0 ? 255 : 100;
      image.data[pixel + 1] = slope >= 0 ? 245 : 75;
      image.data[pixel + 2] = slope >= 0 ? 215 : 48;
      image.data[pixel + 3] = Math.min(96, Math.abs(slope) * 240);
    }
  }
  ctx.putImageData(image, 0, 0);
  return `url("${canvas.toDataURL()}")`;
}

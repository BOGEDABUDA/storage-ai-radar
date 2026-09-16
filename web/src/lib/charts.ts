/**
 * 自绘 SVG 图表（零第三方依赖）。
 *
 * 设计要点：
 * - 颜色一律用 CSS 变量写在 style 上，切换主题时无需重新渲染
 * - 折线用 vector-effect: non-scaling-stroke，缩放时描边粗细恒定
 * - 主轴折线图按容器实际像素宽度渲染，保证文字清晰
 */

import { s } from './dom';
import { n } from './format';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 每次渲染生成唯一渐变 id，避免多个 sparkline 互相覆盖 */
let gradientSeq = 0;

function strokeStyle(color: string): Record<string, string> {
  return { stroke: color };
}

/** 迷你趋势线：无坐标轴、无文字，用于卡片。 */
export function sparkline(
  values: number[],
  opts: { width?: number; height?: number; color?: string; area?: boolean } = {},
): SVGElement {
  const width = opts.width ?? 300;
  const height = opts.height ?? 34;
  const color = opts.color ?? 'var(--accent)';
  const pad = 4;

  const svg = s('svg', {
    class: 'sparkline',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-hidden': 'true',
  });

  if (values.length === 0) return svg;

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const y = (value: number): number => height - pad - ((value - min) / span) * (height - pad * 2);

  const points = values.map((value, index) => [pad + index * stepX, y(value)] as const);

  if (opts.area !== false) {
    // 竖向渐变填充：顶部淡色渐隐到底部透明，避免小图糊成一整块色块
    const gid = `spark-grad-${(gradientSeq += 1)}`;
    svg.appendChild(
      s(
        'defs',
        {},
        s(
          'linearGradient',
          { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' },
          s('stop', { offset: '0%', style: { stopColor: color, stopOpacity: '0.3' } }),
          s('stop', { offset: '100%', style: { stopColor: color, stopOpacity: '0' } }),
        ),
      ),
    );
    const areaPath =
      `M ${points[0]![0]} ${height - pad} ` +
      points.map(([px, py]) => `L ${px} ${py}`).join(' ') +
      ` L ${points[points.length - 1]![0]} ${height - pad} Z`;
    svg.appendChild(s('path', { d: areaPath, style: { fill: `url(#${gid})`, stroke: 'none' } }));
  }

  svg.appendChild(
    s('polyline', {
      points: points.map(([px, py]) => `${px},${py}`).join(' '),
      style: { ...strokeStyle(color), fill: 'none' },
      'stroke-width': '1.5',
      'vector-effect': 'non-scaling-stroke',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
  );

  return svg;
}

export interface LineChartOptions {
  width: number;
  height?: number;
  color?: string;
  /** 标注峰值 */
  annotateMax?: boolean;
}

/** 单序列面积折线图（按真实像素宽高绘制）。 */
export function lineChart(labels: string[], values: number[], options: LineChartOptions): SVGElement {
  const width = Math.max(options.width, 240);
  const height = options.height ?? 240;
  const color = options.color ?? 'var(--accent)';
  const padLeft = 42;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 30;

  const svg = s('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    width: String(width),
    height: String(height),
    role: 'img',
  });

  const max = Math.max(...values, 1);
  const niceMax = niceCeil(max);
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const stepX = values.length > 1 ? plotW / (values.length - 1) : 0;
  const x = (index: number): number => padLeft + index * stepX;
  const y = (value: number): number => padTop + plotH - (value / niceMax) * plotH;

  // 横向网格 + y 轴刻度
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const value = (niceMax / ticks) * i;
    const gy = y(value);
    svg.appendChild(
      s('line', {
        x1: String(padLeft),
        y1: String(gy),
        x2: String(width - padRight),
        y2: String(gy),
        class: i === 0 ? 'axis-line' : 'grid-line',
      }),
    );
    svg.appendChild(
      s(
        'text',
        { x: String(padLeft - 8), y: String(gy + 3), 'text-anchor': 'end' },
        n(Math.round(value)),
      ),
    );
  }

  // 折线 + 面积
  const points = values.map((value, index) => [x(index), y(value)] as const);
  if (points.length > 0) {
    const areaPath =
      `M ${points[0]![0]} ${y(0)} ` +
      points.map(([px, py]) => `L ${px} ${py}`).join(' ') +
      ` L ${points[points.length - 1]![0]} ${y(0)} Z`;
    svg.appendChild(s('path', { d: areaPath, style: { fill: color, opacity: '0.12' } }));
    svg.appendChild(
      s('polyline', {
        points: points.map(([px, py]) => `${px},${py}`).join(' '),
        style: { ...strokeStyle(color), fill: 'none' },
        'stroke-width': '1.8',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
  }

  // x 轴日期标签（最多 6 个，避免拥挤）
  const labelEvery = Math.max(1, Math.ceil(labels.length / 6));
  labels.forEach((label, index) => {
    if (index % labelEvery !== 0 && index !== labels.length - 1) return;
    svg.appendChild(
      s(
        'text',
        {
          x: String(x(index)),
          y: String(height - padBottom + 16),
          'text-anchor': index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle',
        },
        label,
      ),
    );
  });

  // 峰值标注
  if (options.annotateMax && values.length > 0) {
    const maxIndex = values.indexOf(Math.max(...values));
    const [px, py] = points[maxIndex]!;
    svg.appendChild(s('circle', { cx: String(px), cy: String(py), r: '3', style: { fill: color } }));
    svg.appendChild(
      s(
        'text',
        { x: String(px), y: String(py - 8), 'text-anchor': 'middle', style: { fill: 'var(--ink-soft)' } },
        `${n(values[maxIndex]!)}（${labels[maxIndex]}）`,
      ),
    );
  }

  return svg;
}

export interface BarChartOptions {
  width: number;
  height?: number;
  colorFor?: (index: number) => string;
}

/** 纵向柱状图，用于逐期数量分布。 */
export function barChart(labels: string[], values: number[], options: BarChartOptions): SVGElement {
  const width = Math.max(options.width, 240);
  const height = options.height ?? 200;
  const padLeft = 38;
  const padRight = 10;
  const padTop = 12;
  const padBottom = 30;

  const svg = s('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    width: String(width),
    height: String(height),
    role: 'img',
  });

  const max = niceCeil(Math.max(...values, 1));
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const slot = values.length > 0 ? plotW / values.length : plotW;
  const barW = Math.max(2, Math.min(slot * 0.68, 18));
  const y = (value: number): number => padTop + plotH - (value / max) * plotH;

  for (let i = 0; i <= 4; i += 1) {
    const value = (max / 4) * i;
    const gy = y(value);
    svg.appendChild(
      s('line', {
        x1: String(padLeft),
        y1: String(gy),
        x2: String(width - padRight),
        y2: String(gy),
        class: i === 0 ? 'axis-line' : 'grid-line',
      }),
    );
    svg.appendChild(
      s('text', { x: String(padLeft - 8), y: String(gy + 3), 'text-anchor': 'end' }, n(Math.round(value))),
    );
  }

  values.forEach((value, index) => {
    const cx = padLeft + slot * index + slot / 2;
    const barH = Math.max(value > 0 ? 1.5 : 0, padTop + plotH - y(value));
    if (barH <= 0) return;
    const rect = s('rect', {
      x: String(cx - barW / 2),
      y: String(y(value)),
      width: String(barW),
      height: String(barH),
      rx: '1.5',
    });
    rect.style.fill = options.colorFor?.(index) ?? 'var(--accent)';
    rect.style.opacity = '0.85';
    svg.appendChild(rect);
  });

  const labelEvery = Math.max(1, Math.ceil(labels.length / 6));
  labels.forEach((label, index) => {
    if (index % labelEvery !== 0 && index !== labels.length - 1) return;
    const cx = padLeft + slot * index + slot / 2;
    svg.appendChild(
      s(
        'text',
        { x: String(cx), y: String(height - padBottom + 16), 'text-anchor': 'middle' },
        label,
      ),
    );
  });

  return svg;
}

function niceCeil(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** 在容器内按实际像素宽度渲染图表，并在尺寸变化时重绘。 */
export function mountResponsive(
  container: HTMLElement,
  render: (width: number) => SVGElement,
  height: number,
): () => void {
  let frame = 0;
  const draw = (): void => {
    const width = Math.floor(container.clientWidth || 640);
    if (width <= 0) return;
    container.replaceChildren(render(width));
  };
  const schedule = (): void => {
    // 路由切换后容器会被移出文档，此时自毁观察者避免泄漏
    if (!container.isConnected) {
      observer.disconnect();
      return;
    }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  container.style.minHeight = `${height}px`;
  draw();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

export { SVG_NS };

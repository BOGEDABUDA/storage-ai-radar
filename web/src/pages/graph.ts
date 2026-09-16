/** 知识图谱页：力导向交互图 + 节点详情。 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

import { h, s } from '../lib/dom';
import { categoryColor, loadDigests, loadGraph } from '../lib/data';
import { n } from '../lib/format';
import { sparkline } from '../lib/charts';
import type { Digest, GraphEdge, GraphNode, Manifest } from '../lib/types';

const ENTITY_TYPE_LABEL: Record<string, string> = {
  company: '公司/厂商',
  institution: '机构/高校',
  tech: '技术/架构',
  product: '产品/型号',
  paper: '论文/基准',
  person: '人物',
  metric: '指标',
  category: '研究领域',
};

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: 'entity' | 'category';
  etype: string;
  category: string;
  mentions: number;
  radius: number;
  degree: number;
  source: GraphNode;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
  weight: number;
  kind: string;
}

export async function renderGraph(manifest: Manifest): Promise<HTMLElement> {
  const [graph, digests] = await Promise.all([loadGraph(), loadDigests()]);
  const digestById = new Map<string, Digest>(digests.map((d) => [d.id, d]));

  const state = {
    query: '',
    minMentions: 3,
    types: new Set<string>(),
    categories: new Set<string>(),
    selected: null as SimNode | null,
  };

  // ---------------------------------------------------------------- 画布
  const canvas = h('div', { class: 'graph-canvas' });
  const svg = s('svg', { class: 'graph-svg', role: 'img' }) as unknown as SVGSVGElement;
  const viewport = s('g', {});
  const linkLayer = s('g', { class: 'graph-links' });
  const nodeLayer = s('g', { class: 'graph-nodes' });
  const labelLayer = s('g', { class: 'graph-labels' });
  viewport.appendChild(linkLayer);
  viewport.appendChild(nodeLayer);
  viewport.appendChild(labelLayer);
  svg.appendChild(viewport);
  canvas.appendChild(svg);

  let transform = { x: 0, y: 0, k: 1 };
  /** 用户手动缩放/平移后，不再自动重置视图 */
  let userAdjusted = false;
  let width = 800;
  let height = 620;

  function applyTransform(): void {
    viewport.setAttribute('transform', `translate(${transform.x},${transform.y}) scale(${transform.k})`);
  }

  function resize(): void {
    const box = canvas.getBoundingClientRect();
    width = Math.max(420, Math.floor(box.width));
    height = Math.max(420, Math.floor(box.height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
  }

  // ---------------------------------------------------------------- 过滤
  function visibleNodes(): SimNode[] {
    const query = state.query.trim().toLowerCase();
    return graph.nodes
      .filter((node) => {
        if (node.kind === 'category') return true;
        if (node.mentions < state.minMentions) return false;
        if (state.types.size > 0 && !state.types.has(node.etype)) return false;
        if (state.categories.size > 0 && !state.categories.has(node.category)) return false;
        if (query && !node.label.toLowerCase().includes(query)) return false;
        return true;
      })
      .map((node) => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        etype: node.etype,
        category: node.category,
        mentions: node.mentions,
        radius: node.kind === 'category' ? 13 : 3.5 + Math.sqrt(node.mentions) * 1.5,
        degree: 0,
        source: node,
      }));
  }

  // ---------------------------------------------------------------- 渲染
  const detail = h('div', { class: 'graph-detail' });
  const statLine = h('span', { class: 'muted' });
  let simulation: Simulation<SimNode, SimLink> | null = null;
  /** 由 renderGraphView 注入：按当前标签集合刷新显示（模拟停止后选择节点也能立即生效） */
  let refreshLabelVisibility: (() => void) | null = null;

  function renderGraphView(): void {
    resize();
    userAdjusted = false;
    simulation?.stop();
    linkLayer.replaceChildren();
    nodeLayer.replaceChildren();
    labelLayer.replaceChildren();

    const nodes = visibleNodes();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links: SimLink[] = graph.edges
      .filter((edge: GraphEdge) => byId.has(edge.source) && byId.has(edge.target))
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        weight: edge.weight,
        kind: edge.kind,
      }));

    for (const link of links) {
      const a = byId.get(link.source as string);
      const b = byId.get(link.target as string);
      if (a) a.degree += 1;
      if (b) b.degree += 1;
    }

    statLine.textContent = `显示 ${nodes.filter((node) => node.kind === 'entity').length} / ${graph.stats.entities_in_graph} 个实体 · ${links.length} 条关系`;

    if (nodes.length === 0) {
      nodeLayer.appendChild(
        s('text', { x: String(width / 2), y: String(height / 2), 'text-anchor': 'middle' }, '没有符合条件的实体'),
      );
      return;
    }

    const linkEls = links.map((link) => {
      const line = s('line', { class: 'graph-link' });
      line.style.stroke = link.kind === 'belongs_to' ? 'var(--rule-strong)' : 'var(--rule)';
      line.setAttribute('stroke-width', String(Math.min(0.6 + link.weight * 0.28, 3)));
      line.setAttribute('stroke-opacity', link.kind === 'belongs_to' ? '0.5' : '0.75');
      linkLayer.appendChild(line);
      return line;
    });

    const nodeEls = nodes.map((node) => {
      const group = s('g', { class: 'graph-node' });
      const circle = s('circle', { r: String(node.radius) });
      if (node.kind === 'category') {
        circle.style.fill = categoryColor(node.category);
        circle.style.stroke = 'var(--bg)';
        circle.setAttribute('stroke-width', '2');
      } else {
        circle.style.fill = categoryColor(node.category);
        circle.style.stroke = 'var(--bg-elev)';
        circle.setAttribute('stroke-width', '1');
      }
      group.appendChild(circle);
      nodeLayer.appendChild(group);

      const label = s('text', { class: 'graph-label', 'text-anchor': 'middle' }, node.label);
      labelLayer.appendChild(label);
      return { group, circle, label };
    });

    // 标签避让：模拟收敛后按提及量从高到低贪心放置，重叠的标签直接不显示，
    // 避免中心区域文字糊成一团（悬停或选中时始终显示）。
    let labelVisible = new Set<string>();

    function estimateWidth(text: string): number {
      let w = 0;
      for (const char of text) w += /[\u4e00-\u9fff\uff00-\uffef]/.test(char) ? 10 : 5.8;
      return w;
    }

    function computeLabels(): void {
      const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
      const next = new Set<string>();
      const candidates = nodes
        .filter((node) => node.kind === 'category' || node.mentions >= 4)
        .sort((a, b) => b.mentions - a.mentions);

      for (const node of candidates) {
        if (node.x === undefined || node.y === undefined) continue;
        const halfWidth = estimateWidth(node.label) / 2 + 2;
        const top = node.y + node.radius + 2;
        const box = { x1: node.x - halfWidth, y1: top, x2: node.x + halfWidth, y2: top + 11 };
        const overlaps = placed.some(
          (other) => box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1,
        );
        if (!overlaps) {
          placed.push(box);
          next.add(node.id);
        }
      }
      labelVisible = next;
    }

    function fitToView(): void {
      const positioned = nodes.filter((node) => node.x !== undefined && node.y !== undefined);
      if (positioned.length === 0) return;
      // 用 2%~98% 分位而不是极值：少数离群点不应决定整体缩放
      const xs = positioned.map((node) => node.x!).sort((a, b) => a - b);
      const ys = positioned.map((node) => node.y!).sort((a, b) => a - b);
      const pick = (arr: number[], ratio: number): number =>
        arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * ratio)))]!;
      const minX = pick(xs, 0.02);
      const maxX = pick(xs, 0.98);
      const minY = pick(ys, 0.02);
      const maxY = pick(ys, 0.98);
      const pad = 70;
      const spanX = Math.max(maxX - minX, 1) + pad * 2;
      const spanY = Math.max(maxY - minY, 1) + pad * 2;
      const k = Math.min(Math.max(Math.min(width / spanX, height / spanY), 0.2), 1.5);
      transform.k = k;
      transform.x = width / 2 - ((minX + maxX) / 2) * k;
      transform.y = height / 2 - ((minY + maxY) / 2) * k;
      applyTransform();
    }

    const sim = forceSimulation<SimNode>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((node) => node.id)
          .distance((link) => (link.kind === 'belongs_to' ? 90 : 52))
          .strength((link) => (link.kind === 'belongs_to' ? 0.3 : Math.min(0.05 + link.weight * 0.015, 0.4))),
      )
      .force('charge', forceManyBody<SimNode>().strength((node) => (node.kind === 'category' ? -600 : -120)))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<SimNode>().radius((node) => node.radius + 6))
      // 弱向心力：避免少数孤立节点飘到很远，把整体包围盒撑大导致缩放失真
      .force('x', forceX<SimNode>(width / 2).strength(0.045))
      .force('y', forceY<SimNode>(height / 2).strength(0.045));
    simulation = sim;

    function applyPositions(): void {
      links.forEach((link, index) => {
        const a = link.source as SimNode;
        const b = link.target as SimNode;
        const line = linkEls[index]!;
        line.setAttribute('x1', String(a.x ?? 0));
        line.setAttribute('y1', String(a.y ?? 0));
        line.setAttribute('x2', String(b.x ?? 0));
        line.setAttribute('y2', String(b.y ?? 0));
      });
      nodes.forEach((node, index) => {
        const { group, label } = nodeEls[index]!;
        group.setAttribute('transform', `translate(${node.x ?? 0},${node.y ?? 0})`);
        label.setAttribute('x', String(node.x ?? 0));
        label.setAttribute('y', String((node.y ?? 0) + node.radius + 11));
      });
    }

    refreshLabelVisibility = () => {
      nodes.forEach((node, index) => {
        const { label } = nodeEls[index]!;
        const visible =
          labelVisible.has(node.id) || node.kind === 'category' || state.selected?.id === node.id;
        label.style.display = visible ? '' : 'none';
      });
    };

    // 先把模拟同步跑到收敛再绘制：布局确定、无需等待动画，截图与首屏都稳定。
    sim.stop();
    for (let i = 0; i < 320; i += 1) sim.tick();
    computeLabels();
    applyPositions();
    refreshLabelVisibility?.();
    fitToView();

    // 拖拽时重新开启动画，松手后再次收敛
    sim.on('tick', () => {
      applyPositions();
      refreshLabelVisibility?.();
    });
    sim.on('end', () => {
      computeLabels();
      applyPositions();
      refreshLabelVisibility?.();
      if (!userAdjusted) fitToView();
    });

    // 拖拽
    for (const [index, node] of nodes.entries()) {
      const { group } = nodeEls[index]!;
      group.addEventListener('pointerdown', (event: PointerEvent) => {
        event.stopPropagation();
        const point = toGraphSpace(event);
        node.fx = point.x;
        node.fy = point.y;
        simulation?.alphaTarget(0.25).restart();
        const move = (moveEvent: PointerEvent): void => {
          const next = toGraphSpace(moveEvent);
          node.fx = next.x;
          node.fy = next.y;
        };
        const up = (): void => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          node.fx = null;
          node.fy = null;
          simulation?.alphaTarget(0);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      group.addEventListener('click', (event: MouseEvent) => {
        event.stopPropagation();
        selectNode(node);
      });
      group.addEventListener('pointerenter', () => {
        group.classList.add('is-hover');
      });
      group.addEventListener('pointerleave', () => {
        group.classList.remove('is-hover');
      });
    }

    function toGraphSpace(event: PointerEvent | MouseEvent): { x: number; y: number } {
      const box = svg.getBoundingClientRect();
      return {
        x: (event.clientX - box.left - transform.x) / transform.k,
        y: (event.clientY - box.top - transform.y) / transform.k,
      };
    }

    // 背景拖拽平移
    svg.addEventListener('pointerdown', (event: PointerEvent) => {
      userAdjusted = true;
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = { ...transform };
      const move = (moveEvent: PointerEvent): void => {
        transform.x = origin.x + (moveEvent.clientX - startX);
        transform.y = origin.y + (moveEvent.clientY - startY);
        applyTransform();
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // 滚轮缩放
    svg.addEventListener(
      'wheel',
      (event: WheelEvent) => {
        event.preventDefault();
        userAdjusted = true;
        const box = svg.getBoundingClientRect();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const nextK = Math.min(Math.max(transform.k * factor, 0.25), 4);
        const px = event.clientX - box.left;
        const py = event.clientY - box.top;
        transform.x = px - ((px - transform.x) / transform.k) * nextK;
        transform.y = py - ((py - transform.y) / transform.k) * nextK;
        transform.k = nextK;
        applyTransform();
      },
      { passive: false },
    );

    applyTransform();
  }

  // ---------------------------------------------------------------- 详情面板
  function selectNode(node: SimNode | null): void {
    state.selected = node;
    detail.replaceChildren();
    if (!node) {
      detail.appendChild(
        h('p', { class: 'muted', style: { margin: 0 } }, '点击图中任意节点查看详情；滚轮缩放，拖拽平移或移动节点。'),
      );
      return;
    }
    const source = node.source;
    const color = categoryColor(source.category);
    const categoryName = manifest.categories.find((c) => c.key === source.category)?.name ?? source.category;

    detail.appendChild(h('h3', { class: 'graph-detail__title', style: { color } }, source.label));
    detail.appendChild(
      h(
        'div',
        { class: 'filters', style: { marginBottom: 'var(--space-3)' } },
        h('span', { class: 'chip' }, ENTITY_TYPE_LABEL[source.etype] ?? source.etype),
        h('a', { class: 'chip', href: `#/domain/${encodeURIComponent(source.category)}`, style: { color } }, categoryName),
      ),
    );

    const rows: [string, string][] = [
      ['提及次数', n(source.mentions)],
      ['关联关系', n(node.degree)],
    ];
    if (source.first_seen) rows.push(['首次出现', source.first_seen]);
    if (source.last_seen) rows.push(['最近出现', source.last_seen]);
    if (source.business !== undefined) {
      rows.push(['视角分布', `商业 ${source.business} · 学术/技术 ${source.technical ?? 0}`]);
    }
    detail.appendChild(
      h(
        'table',
        { class: 'data-table' },
        h('tbody', {}, ...rows.map(([key, value]) => h('tr', {}, h('td', { class: 'muted' }, key), h('td', {}, value)))),
      ),
    );

    if (source.series && source.series.length > 0) {
      detail.appendChild(h('h4', { class: 'graph-detail__sub' }, '逐期提及'));
      const spark = h('div', { style: { height: '34px' } });
      spark.appendChild(sparkline(source.series, { color, height: 34 }));
      detail.appendChild(spark);
      detail.appendChild(h('div', { class: 'muted', style: { fontSize: 'var(--fs-xs)' } }, `${graph.dates[0]} → ${graph.dates[graph.dates.length - 1]}`));
    }

    const refs = (source.digests ?? [])
      .map((id) => digestById.get(id))
      .filter((d): d is Digest => Boolean(d))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 8);

    if (refs.length > 0) {
      detail.appendChild(h('h4', { class: 'graph-detail__sub' }, '相关洞察'));
      const list = h('div', { class: 'graph-detail__refs' });
      for (const digest of refs) {
        list.appendChild(
          h(
            'a',
            { class: 'graph-ref', href: `#/report/${digest.date}` },
            h('span', { class: 'graph-ref__date' }, digest.date),
            h('span', { class: 'graph-ref__topic' }, digest.topic),
          ),
        );
      }
      detail.appendChild(list);
    }

    // 邻接实体
    const neighbours = graph.edges
      .filter((edge) => edge.kind === 'co_occurs' && (edge.source === source.id || edge.target === source.id))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10)
      .map((edge) => {
        const otherId = edge.source === source.id ? edge.target : edge.source;
        const other = graph.nodes.find((item) => item.id === otherId);
        return other ? { other, weight: edge.weight } : null;
      })
      .filter((item): item is { other: GraphNode; weight: number } => Boolean(item));

    if (neighbours.length > 0) {
      detail.appendChild(h('h4', { class: 'graph-detail__sub' }, '常共同出现'));
      const list = h('div', { class: 'graph-detail__refs' });
      for (const { other, weight } of neighbours) {
        list.appendChild(
          h(
            'button',
            {
              class: 'graph-ref graph-ref--button',
              type: 'button',
              onclick: () => {
                selectNode({
                  id: other.id,
                  label: other.label,
                  kind: other.kind,
                  etype: other.etype,
                  category: other.category,
                  mentions: other.mentions,
                  radius: 5,
                  degree: 0,
                  source: other,
                });
              },
            },
            h('span', { class: 'graph-ref__date' }, `${weight} 次`),
            h('span', { class: 'graph-ref__topic', style: { color: categoryColor(other.category) } }, other.label),
          ),
        );
      }
      detail.appendChild(list);
    }

    // 选中后标签立即显示，无需等待下一次 tick
    refreshLabelVisibility?.();
  }

  // ---------------------------------------------------------------- 控制条
  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '筛选实体名…',
    'aria-label': '筛选实体',
  }) as HTMLInputElement;
  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    renderGraphView();
  });

  const minMentions = h(
    'select',
    { 'aria-label': '最少提及次数' },
    ...[1, 2, 3, 5, 8, 12, 20].map((value) =>
      h('option', { value: String(value), selected: value === state.minMentions ? '' : null }, `提及 ≥ ${value}`),
    ),
  ) as HTMLSelectElement;
  minMentions.addEventListener('change', () => {
    state.minMentions = Number(minMentions.value);
    renderGraphView();
  });

  const typePills = h('div', { class: 'filters', style: { marginBottom: 0 } });
  for (const type of ['company', 'tech', 'product', 'institution', 'paper']) {
    const pill = h(
      'button',
      {
        class: 'filter-pill',
        type: 'button',
        'aria-pressed': 'false',
        onclick: () => {
          if (state.types.has(type)) state.types.delete(type);
          else state.types.add(type);
          pill.setAttribute('aria-pressed', String(state.types.has(type)));
          renderGraphView();
        },
      },
      ENTITY_TYPE_LABEL[type] ?? type,
    );
    typePills.appendChild(pill);
  }

  const categoryPills = h('div', { class: 'filters', style: { marginBottom: 0 } });
  for (const meta of manifest.categories) {
    const pill = h(
      'button',
      {
        class: 'filter-pill',
        type: 'button',
        'aria-pressed': 'false',
        style: { color: categoryColor(meta.key) },
        onclick: () => {
          if (state.categories.has(meta.key)) state.categories.delete(meta.key);
          else state.categories.add(meta.key);
          pill.setAttribute('aria-pressed', String(state.categories.has(meta.key)));
          renderGraphView();
        },
      },
      meta.name,
    );
    categoryPills.appendChild(pill);
  }

  const reset = h(
    'button',
    {
      class: 'filter-pill',
      type: 'button',
      onclick: () => {
        state.query = '';
        state.types.clear();
        state.categories.clear();
        state.minMentions = 3;
        searchInput.value = '';
        minMentions.value = '3';
        for (const pill of [...typePills.children, ...categoryPills.children]) {
          pill.setAttribute('aria-pressed', 'false');
        }
        selectNode(null);
        renderGraphView();
      },
    },
    '重置',
  );

  const page = h(
    'div',
    { class: 'container' },
    h(
      'div',
      { class: 'page-head' },
      h('span', { class: 'eyebrow' }, '知识图谱'),
      h('h1', { class: 'page-title' }, '实体关系图谱'),
      h(
        'p',
        { class: 'page-lede' },
        `由 DeepSeek 从 ${n(graph.stats.digests)} 条精选洞察中抽取 ${n(graph.stats.entities_total)} 个实体，`,
        `保留提及 ≥ ${graph.stats.min_mentions} 次的 ${graph.stats.entities_in_graph} 个入图，`,
        `共 ${n(graph.stats.edges)} 条关系（含实体—领域归属与实体间共现）。`,
      ),
    ),
    h('div', { class: 'search-bar' }, searchInput, minMentions, reset),
    h('div', { class: 'graph-controls' }, typePills, categoryPills),
    h('div', { class: 'graph-meta' }, statLine),
    h(
      'div',
      { class: 'split graph-split' },
      canvas,
      h('aside', { class: 'side-panel graph-side' }, detail),
    ),
  );

  selectNode(null);
  // 等布局完成后再测量画布尺寸
  requestAnimationFrame(() => renderGraphView());

  return page;
}

// Charts of the overview, in plain SVG and HTML. Marks are thin, lines 2px,
// grids recessive; one accent marks what matters and the rest is context
// gray. Every chart has a hover layer and a table twin in its card.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

/** Width of an element, kept up to date. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Path through the points, broken where a value is missing. */
function linePath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (!isNum(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/**
 * A small trend line, zero-based so a flat line looks flat. Context gray,
 * last value marked in the accent. Decorative: the number beside it says
 * the value.
 */
export function Sparkline({ values, max, height = 30 }: { values: (number | null)[]; max?: number; height?: number }) {
  const top = max ?? Math.max(0, ...values.filter(isNum));
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const y = (v: number) => 100 - (top > 0 ? (v / top) * 88 : 0) - 6;
  const last = [...values.keys()].reverse().find((i) => isNum(values[i]));
  return (
    <span className="spark" style={{ height }} aria-hidden="true">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={linePath(values, x, y)} />
      </svg>
      {last !== undefined && <i style={{ left: `${x(last)}%`, top: `${y(values[last]!)}%` }} />}
    </span>
  );
}

/** A tooltip box placed inside a positioned parent. */
export function Tip({ at, children }: { at: { x: number; y: number; flip?: boolean } | null; children: ReactNode }) {
  if (!at) return null;
  return (
    <div className="tip" role="status" style={{ left: at.x, top: at.y, transform: at.flip ? 'translateX(-100%)' : undefined }}>
      {children}
    </div>
  );
}

export interface LineSeries {
  key: string;
  name: string;
  values: (number | null)[];
  /** The one series drawn in the accent and labeled at its end. */
  focus?: boolean;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((k) => k * p >= v)!;
  return m * p;
}

/**
 * Lines over time on one axis, with a crosshair and a tooltip (pointer and
 * arrow keys). The focus series is the accent; the others are context.
 */
export function LineChart(props: {
  slots: string[];
  series: LineSeries[];
  xLabel: (i: number) => string;
  tipTitle: (i: number) => string;
  format: (v: number) => string;
  ariaLabel: string;
  height?: number;
}) {
  const { slots, series, xLabel, tipTitle, format } = props;
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = props.height ?? 240;
  const focus = series.find((s) => s.focus);
  const endLabel = focus ? 120 : 16;
  const L = 44;
  const R = endLabel;
  const T = 12;
  const B = 26;
  const W = Math.max(width, 280);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter(isNum))) * 1.05);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const n = slots.length;
  const x = (i: number) => L + (n > 1 ? (i * (W - L - R)) / (n - 1) : (W - L - R) / 2);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const every = n <= 8 ? 1 : n <= 24 ? 4 : 5;
  const ordered = [...series.filter((s) => !s.focus), ...(focus ? [focus] : [])];
  const lastFocus = focus ? [...focus.values.keys()].reverse().find((i) => isNum(focus.values[i])) : undefined;

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    if (e.key === 'Escape') setHover(null);
  };
  const rows = hover === null ? [] : [...series].filter((s) => isNum(s.values[hover])).sort((a, b) => b.values[hover]! - a.values[hover]!);

  return (
    <div className="line-chart" ref={box}>
      {width > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
              <text x={L - 8} y={y(t) + 4} textAnchor="end" className="tick">
                {format(t)}
              </text>
            </g>
          ))}
          {slots.map((_, i) =>
            i % every === 0 ? (
              <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="tick">
                {xLabel(i)}
              </text>
            ) : null,
          )}
          {ordered.map((s) => (
            <path key={s.key} d={linePath(s.values, x, y)} className={s.focus ? 'series focus' : 'series'} />
          ))}
          {focus && lastFocus !== undefined && (
            <>
              <circle cx={x(lastFocus)} cy={y(focus.values[lastFocus]!)} r={4.5} className="end-dot" />
              <text x={x(lastFocus) + 10} y={y(focus.values[lastFocus]!) + 4} className="end-label">
                {focus.name} · {format(focus.values[lastFocus]!)}
              </text>
            </>
          )}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="crosshair" />
              {ordered.map((s) =>
                isNum(s.values[hover]) ? (
                  <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={s.focus ? 4.5 : 3.5} className={s.focus ? 'hover-dot focus' : 'hover-dot'} />
                ) : null,
              )}
            </g>
          )}
          <rect
            x={L}
            y={T}
            width={W - L - R}
            height={H - T - B}
            className="hit"
            tabIndex={0}
            aria-label="Use as setas para ver cada ponto"
            onPointerMove={pick}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover((h) => h ?? n - 1)}
            onBlur={() => setHover(null)}
            onKeyDown={key}
          />
        </svg>
      )}
      <Tip at={hover === null ? null : { x: x(hover) + (x(hover) > W * 0.6 ? -12 : 12), y: 8, flip: x(hover) > W * 0.6 }}>
        <div className="tip-title">{hover !== null && tipTitle(hover)}</div>
        {rows.map((s) => (
          <div key={s.key} className="tip-row">
            <span className={s.focus ? 'key focus' : 'key'} />
            <b>{format(s.values[hover!]!)}</b>
            <span>{s.name}</span>
          </div>
        ))}
        {rows.length === 0 && <div className="tip-row muted">Sem volume nesse intervalo</div>}
      </Tip>
    </div>
  );
}

/** Re-renders every [ms], for "há 40 s" labels. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

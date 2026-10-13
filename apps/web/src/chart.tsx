import { useEffect, useRef, useState } from "react";

// Moves per day: loaded and empty legs finished, as two lines over 7 or 30
// days. A crosshair snaps to the nearest day and the tooltip lists both
// series; the same numbers are in the table under it.

export type Point = { date: string; loaded: number; empty: number };
const SERIES = [
  { key: "loaded", label: "Loaded moves", color: "var(--series-1)" },
  { key: "empty", label: "Empty moves", color: "var(--series-2)" },
] as const;

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Monotone cubic (Fritsch–Carlson): smooth, but never dips below zero or overshoots a peak. */
function monotonePath(pts: [number, number][]): string {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  const n = pts.length;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const m = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / dx[i]);
  const t = pts.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + h * t[i]} ${pts[i + 1][0] - h},${pts[i + 1][1] - h * t[i + 1]} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / step / 2) * step * 2;
};

export function MovesChart({ data }: { data: Point[] }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const pad = { top: 12, right: 12, bottom: 26, left: 34 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...data.flatMap((p) => [p.loaded, p.empty])));
  const x = (i: number) => pad.left + (data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v: number) => pad.top + h - (v / max) * h;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(w / 70))));

  const pick = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !data.length) return;
    const i = Math.round(((clientX - box.left - pad.left) / w) * (data.length - 1));
    setHover(Math.min(data.length - 1, Math.max(0, i)));
  };
  const p = hover != null ? data[hover] : null;

  return (
    <div className="chart" ref={ref}>
      <div className="legend" aria-hidden="true">
        {SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
      </div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Moves per day, ${data.length} days: ${data.reduce((s, d) => s + d.loaded, 0)} loaded and ${data.reduce((s, d) => s + d.empty, 0)} empty`}
        tabIndex={0}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setHover((v) => Math.min(data.length - 1, (v ?? -1) + 1));
          if (e.key === "ArrowLeft") setHover((v) => Math.max(0, (v ?? data.length) - 1));
        }}
        onBlur={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
            <text x={pad.left - 8} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{t}</text>
          </g>
        ))}
        {data.map((d, i) => (i % labelEvery === 0 || i === data.length - 1) && (data.length - 1 - i >= labelEvery / 2 || i === data.length - 1) ? (
          <text key={d.date} x={x(i)} y={height - 6} className="tick" textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}>{fmtDay(d.date)}</text>
        ) : null)}
        {SERIES.map((s) => (
          <path key={s.key} d={monotonePath(data.map((d, i) => [x(i), y(d[s.key])]))} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {p && hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + h} className="crosshair" />
            {SERIES.map((s) => <circle key={s.key} cx={x(hover)} cy={y(p[s.key])} r={4.5} fill={s.color} className="ring" />)}
          </g>
        )}
      </svg>
      {p && hover != null && (
        <div className="tooltip" style={{ left: Math.min(width - 150, Math.max(0, x(hover) + 12)), top: 34 }}>
          <div className="muted small">{fmtDay(p.date)}</div>
          {SERIES.map((s) => (
            <div key={s.key} className="tip-row"><i style={{ background: s.color }} /><strong>{p[s.key]}</strong><span className="muted">{s.label.toLowerCase()}</span></div>
          ))}
        </div>
      )}
      <details className="table-view">
        <summary>View as table</summary>
        <table>
          <thead><tr><th>Day</th><th>Loaded</th><th>Empty</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.date}><td>{fmtDay(d.date)}</td><td>{d.loaded}</td><td>{d.empty}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

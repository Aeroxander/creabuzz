/**
 * A candlestick chart in SVG: price candles with a volume strip, a last-price
 * line and a crosshair readout. Sized to its container, themed from the page's
 * tokens, and usable from the keyboard (arrow keys move the readout).
 *
 * It draws what it is given. Where the numbers came from is the caller's job to
 * say; this component never labels data as trades.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { Candle } from "../lib/candles";

const HEIGHT = 300;
const PAD = { top: 12, right: 64, bottom: 24, left: 8 };
const VOLUME_SHARE = 0.2;
const DOWN = "#f0617d";

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  if (value >= 0.01) return value.toFixed(4);
  return value.toPrecision(3);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatTime(seconds: number, bucketSeconds: number): string {
  const date = new Date(seconds * 1000);
  return bucketSeconds >= 86_400
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function CandlestickChart({
  candles,
  currency,
  bucketSeconds,
  label,
}: {
  candles: readonly Candle[];
  currency: string;
  bucketSeconds: number;
  /** Accessible summary of what is drawn. */
  label: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.floor(entry.contentRect.width)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const volumeH = plotH * VOLUME_SHARE;
    const priceH = plotH - volumeH - 8;
    let low = Math.min(...candles.map((c) => c.low));
    let high = Math.max(...candles.map((c) => c.high));
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      low = 0;
      high = 1;
    }
    if (high === low) {
      const pad = Math.max(high * 0.05, 1e-9);
      low -= pad;
      high += pad;
    } else {
      const pad = (high - low) * 0.08;
      low -= pad;
      high += pad;
    }
    const maxVolume = Math.max(1e-9, ...candles.map((c) => c.volume));
    const slot = plotW / Math.max(candles.length, 1);
    const bodyW = Math.max(3, Math.min(16, slot * 0.6));
    const y = (price: number) =>
      PAD.top + ((high - price) / (high - low)) * priceH;
    const x = (index: number) => PAD.left + slot * index + slot / 2;
    return {
      plotW,
      plotH,
      volumeH,
      priceH,
      low,
      high,
      maxVolume,
      slot,
      bodyW,
      y,
      x,
    };
  }, [candles, width]);

  if (candles.length === 0) return null;

  const { y, x, bodyW, priceH, volumeH, low, high, maxVolume } = geometry;
  const last = candles[candles.length - 1];
  const ticks = Array.from(
    { length: 5 },
    (_, i) => low + ((high - low) * i) / 4,
  );
  const labelEvery = Math.max(
    1,
    Math.ceil(candles.length / Math.floor(geometry.plotW / 90)),
  );
  const current = active !== null ? candles[active] : null;

  function indexAt(clientX: number): number | null {
    const node = box.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const index = Math.floor((clientX - rect.left - PAD.left) / geometry.slot);
    return index >= 0 && index < candles.length ? index : null;
  }

  return (
    <div
      aria-label={label}
      className="relative outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onBlur={() => setActive(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const step = event.key === "ArrowLeft" ? -1 : 1;
          setActive((value) =>
            Math.min(
              candles.length - 1,
              Math.max(0, (value ?? candles.length - 1) + step),
            ),
          );
        } else if (event.key === "Escape") {
          setActive(null);
        }
      }}
      ref={box}
      role="slider"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-valuemax={candles.length - 1}
      aria-valuemin={0}
      aria-valuenow={active ?? candles.length - 1}
      aria-valuetext={`${formatTime(candles[active ?? candles.length - 1].time, bucketSeconds)}: open ${formatPrice(candles[active ?? candles.length - 1].open)}, close ${formatPrice(candles[active ?? candles.length - 1].close)} ${currency}`}
    >
      <svg
        className="block w-full touch-pan-y select-none"
        height={HEIGHT}
        onMouseLeave={() => setActive(null)}
        onMouseMove={(event) => setActive(indexAt(event.clientX))}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width={width}
      >
        <title>{label}</title>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="stroke-foreground/10"
              strokeDasharray="2 4"
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text
              className="fill-muted-foreground text-2xs tabular-nums"
              dominantBaseline="middle"
              x={width - PAD.right + 8}
              y={y(tick)}
            >
              {formatPrice(tick)}
            </text>
          </g>
        ))}

        {candles.map((candle, index) => {
          const up = candle.close >= candle.open;
          const color = up ? "hsl(var(--primary))" : DOWN;
          const top = y(Math.max(candle.open, candle.close));
          const bottom = y(Math.min(candle.open, candle.close));
          const volumeHeight = (candle.volume / maxVolume) * volumeH;
          return (
            <g
              key={candle.time}
              opacity={active === null || active === index ? 1 : 0.55}
            >
              <line
                stroke={color}
                strokeLinecap="round"
                strokeWidth={1.5}
                x1={x(index)}
                x2={x(index)}
                y1={y(candle.high)}
                y2={y(candle.low)}
              />
              <rect
                fill={color}
                height={Math.max(1.5, bottom - top)}
                rx={1.5}
                width={bodyW}
                x={x(index) - bodyW / 2}
                y={top}
              />
              <rect
                fill={color}
                height={Math.max(volumeHeight, candle.volume > 0 ? 1.5 : 0)}
                opacity={0.35}
                rx={1}
                width={bodyW}
                x={x(index) - bodyW / 2}
                y={PAD.top + priceH + 8 + volumeH - volumeHeight}
              />
              {index % labelEvery === 0 ? (
                <text
                  className="fill-muted-foreground text-2xs"
                  textAnchor="middle"
                  x={x(index)}
                  y={HEIGHT - 6}
                >
                  {formatTime(candle.time, bucketSeconds)}
                </text>
              ) : null}
            </g>
          );
        })}

        <line
          stroke={last.close >= last.open ? "hsl(var(--primary))" : DOWN}
          strokeDasharray="4 4"
          strokeOpacity={0.7}
          x1={PAD.left}
          x2={width - PAD.right}
          y1={y(last.close)}
          y2={y(last.close)}
        />
        <g
          transform={`translate(${width - PAD.right + 2},${y(last.close) - 9})`}
        >
          <rect
            fill={last.close >= last.open ? "hsl(var(--primary))" : DOWN}
            height={18}
            rx={4}
            width={PAD.right - 4}
          />
          <text
            className="fill-primary-foreground text-2xs font-bold tabular-nums"
            dominantBaseline="middle"
            textAnchor="middle"
            x={(PAD.right - 4) / 2}
            y={9.5}
          >
            {formatPrice(last.close)}
          </text>
        </g>

        {active !== null ? (
          <line
            className="stroke-foreground/40"
            strokeDasharray="3 3"
            x1={x(active)}
            x2={x(active)}
            y1={PAD.top}
            y2={HEIGHT - PAD.bottom}
          />
        ) : null}
      </svg>

      {current && active !== null ? (
        <div
          aria-live="polite"
          className="glass-strong pointer-events-none absolute top-2 z-10 rounded-lg border px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(x(active) - 80, 4), width - 176),
          }}
        >
          <p className="font-bold">{formatTime(current.time, bucketSeconds)}</p>
          <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
            <dt className="text-muted-foreground">Open</dt>
            <dd>{formatPrice(current.open)}</dd>
            <dt className="text-muted-foreground">High</dt>
            <dd>{formatPrice(current.high)}</dd>
            <dt className="text-muted-foreground">Low</dt>
            <dd>{formatPrice(current.low)}</dd>
            <dt className="text-muted-foreground">Close</dt>
            <dd>{formatPrice(current.close)}</dd>
            <dt className="text-muted-foreground">Bids</dt>
            <dd>
              {formatCompact(current.volume)} {currency}
            </dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

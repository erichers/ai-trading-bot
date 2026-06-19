import { useEffect, useMemo, useRef } from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
} from 'lightweight-charts';
import type { Bar } from '@/api/types';

export interface Overlay {
  sma?: boolean;
  ema?: boolean;
  bbands?: boolean;
  volume?: boolean;
}

function sma(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : undefined);
  }
  return out;
}

function ema(values: number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  const k = 2 / (period + 1);
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      prev = values[i];
      out.push(undefined);
    } else {
      prev = values[i] * k + (prev as number) * (1 - k);
      out.push(i >= period - 1 ? prev : undefined);
    }
  }
  return out;
}

function bollinger(values: number[], period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper: (number | undefined)[] = [];
  const lower: (number | undefined)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i >= period - 1 && mid[i] !== undefined) {
      const slice = values.slice(i - period + 1, i + 1);
      const m = mid[i] as number;
      const variance = slice.reduce((a, v) => a + (v - m) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      upper.push(m + mult * sd);
      lower.push(m - mult * sd);
    } else {
      upper.push(undefined);
      lower.push(undefined);
    }
  }
  return { mid, upper, lower };
}

const toTime = (iso: string): UTCTimestamp =>
  Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

export function CandleChart({
  bars,
  overlays = { volume: true },
  height,
}: {
  bars: Bar[];
  overlays?: Overlay;
  /**
   * Optional fixed pixel height. When omitted, the chart fills 100% of its
   * parent's height (the container is h-full) and tracks live resizes via a
   * ResizeObserver — used by the resizable dashboard tiles.
   */
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lineRefs = useRef<ISeriesApi<'Line'>[]>([]);

  // Init chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const initW = el.clientWidth || 600;
    const initH = (height ?? el.clientHeight) || 300;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#000000' },
        textColor: '#A8A8A8',
        fontFamily: 'monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.06)' },
        horzLines: { color: 'rgba(255,255,255,0.06)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      width: initW,
      height: initH,
      autoSize: false,
    });
    chartRef.current = chart;
    candleRef.current = chart.addCandlestickSeries({
      upColor: '#00C805',
      downColor: '#FF5000',
      borderUpColor: '#00C805',
      borderDownColor: '#FF5000',
      wickUpColor: '#00C805',
      wickDownColor: '#FF5000',
    });
    volRef.current = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    // Fill the container in both dimensions and resize live. When a fixed
    // `height` is supplied we honor it; otherwise we use the container height.
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = height ?? containerRef.current.clientHeight;
      if (w > 0 && h > 0) {
        chart.applyOptions({ width: w, height: h });
        chart.timeScale().fitContent();
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [height]);

  const closes = useMemo(() => bars.map((b) => b.c), [bars]);

  useEffect(() => {
    if (!chartRef.current || !candleRef.current) return;
    const candleData: CandlestickData[] = bars.map((b) => ({
      time: toTime(b.t),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
    }));
    candleRef.current.setData(candleData);

    // Volume
    if (volRef.current) {
      if (overlays.volume) {
        const vData: HistogramData[] = bars.map((b) => ({
          time: toTime(b.t),
          value: b.v,
          color: b.c >= b.o ? 'rgba(0,200,5,0.4)' : 'rgba(255,80,0,0.4)',
        }));
        volRef.current.setData(vData);
      } else {
        volRef.current.setData([]);
      }
    }

    // Clear previous overlay lines.
    lineRefs.current.forEach((s) => chartRef.current?.removeSeries(s));
    lineRefs.current = [];

    const addLine = (
      values: (number | undefined)[],
      color: string,
      lineWidth: 1 | 2 = 1,
    ) => {
      if (!chartRef.current) return;
      const s = chartRef.current.addLineSeries({
        color,
        lineWidth,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const data: LineData[] = [];
      values.forEach((v, i) => {
        if (v !== undefined) data.push({ time: toTime(bars[i].t), value: v });
      });
      s.setData(data);
      lineRefs.current.push(s);
    };

    if (overlays.sma) {
      addLine(sma(closes, 20), '#CCFF00');
      addLine(sma(closes, 50), '#56a8ff');
    }
    if (overlays.ema) {
      addLine(ema(closes, 9), '#c678dd');
      addLine(ema(closes, 21), '#e5c07b');
    }
    if (overlays.bbands) {
      const bb = bollinger(closes);
      addLine(bb.upper, 'rgba(139,148,163,0.6)');
      addLine(bb.lower, 'rgba(139,148,163,0.6)');
    }

    chartRef.current.timeScale().fitContent();
  }, [bars, closes, overlays.sma, overlays.ema, overlays.bbands, overlays.volume]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={height !== undefined ? { height } : undefined}
    />
  );
}

// Reusable equity / P&L charts over real Alpaca portfolio history.
import { useEffect, useRef } from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
} from 'lightweight-charts';
import type { PortfolioPoint } from '@/api/types';

// Area chart of account equity over time.
export function EquityAreaChart({ points }: { points: PortfolioPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#A8A8A8',
        fontFamily: 'Inter, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      width: el.clientWidth || 600,
      height: el.clientHeight || 320,
      autoSize: false,
    });
    chartRef.current = chart;
    seriesRef.current = chart.addAreaSeries({
      lineColor: '#CCFF00',
      topColor: 'rgba(204,255,0,0.25)',
      bottomColor: 'rgba(204,255,0,0.02)',
      lineWidth: 2,
      priceLineVisible: false,
    });
    const ro = new ResizeObserver(() => {
      if (!ref.current) return;
      const w = ref.current.clientWidth;
      const h = ref.current.clientHeight;
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
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    const seen = new Map<number, number>();
    for (const p of points) if (Number.isFinite(p.t)) seen.set(p.t, p.equity);
    const data = [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, value]) => ({ time: t as UTCTimestamp, value }));
    seriesRef.current.setData(data);
    chartRef.current.timeScale().fitContent();
  }, [points]);

  return <div ref={ref} className="h-full w-full" />;
}

// Histogram of per-point P&L (green up / red down).
export function PnlHistogram({ points }: { points: PortfolioPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#A8A8A8',
        fontFamily: 'Inter, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      width: el.clientWidth || 600,
      height: el.clientHeight || 240,
      autoSize: false,
    });
    chartRef.current = chart;
    seriesRef.current = chart.addHistogramSeries({ priceLineVisible: false });
    const ro = new ResizeObserver(() => {
      if (!ref.current) return;
      const w = ref.current.clientWidth;
      const h = ref.current.clientHeight;
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
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    const seen = new Map<number, number>();
    for (const p of points) if (Number.isFinite(p.t)) seen.set(p.t, p.pnl);
    const data = [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, value]) => ({
        time: t as UTCTimestamp,
        value,
        color: value >= 0 ? 'rgba(0,200,5,0.7)' : 'rgba(255,80,0,0.7)',
      }));
    seriesRef.current.setData(data);
    chartRef.current.timeScale().fitContent();
  }, [points]);

  return <div ref={ref} className="h-full w-full" />;
}

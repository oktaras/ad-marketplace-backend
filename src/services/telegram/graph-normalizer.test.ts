import { describe, expect, it } from 'vitest';
import {
  densifyGraphSeries,
  getGraphDisplayMeta,
  parseTelegramStatsGraph,
} from './graph-normalizer.js';

describe('parseTelegramStatsGraph', () => {
  it('keeps timestamp/value alignment and preserves nulls', () => {
    const graph = {
      json: {
        data: JSON.stringify({
          columns: [
            ['x', 1739203200, 1739289600, 1739376000],
            ['y0', 10, null, 30],
          ],
          names: { y0: 'Followers' },
          types: { x: 'x', y0: 'line' },
          title: 'Growth',
        }),
      },
    };

    const parsed = parseTelegramStatsGraph(graph);
    expect(parsed).not.toBeNull();
    expect(parsed?.timestamps.length).toBe(3);
    expect(parsed?.series[0]?.values).toEqual([10, null, 30]);
  });
});

describe('densifyGraphSeries', () => {
  it('returns full 30-day window with carry-forward for cumulative graphs', () => {
    const output = densifyGraphSeries({
      graphType: 'GROWTH',
      timestamps: [1739203200, 1739376000],
      series: [{ key: 'total', label: 'Total followers', values: [10, 30] }],
      periodEnd: new Date('2025-02-13T12:00:00.000Z'),
      days: 30,
    });

    expect(output.timestamps.length).toBe(30);
    expect(output.series[0]?.values.length).toBe(30);
    expect(output.series[0]?.values[0]).toBeGreaterThanOrEqual(0);
    expect(output.series[0]?.values[29]).toBe(30);
  });

  it('returns full 30-day window with zero-fill for flow graphs', () => {
    const output = densifyGraphSeries({
      graphType: 'INTERACTIONS',
      timestamps: [1739203200, 1739376000],
      series: [{ key: 'views', label: 'Views', values: [5, 2] }],
      periodEnd: new Date('2025-02-13T12:00:00.000Z'),
      days: 30,
    });

    expect(output.timestamps.length).toBe(30);
    expect(output.series[0]?.values.length).toBe(30);
    expect(output.series[0]?.values.some((value) => value === 0)).toBe(true);
  });
});

describe('getGraphDisplayMeta', () => {
  it('returns known metadata for views-by-source graph', () => {
    const meta = getGraphDisplayMeta('VIEWS_BY_SOURCE');
    expect(meta.title).toBe('Views by source');
    expect(meta.chartKind).toBe('stacked_bar');
    expect(meta.xAxisFormat).toBe('day');
  });
});

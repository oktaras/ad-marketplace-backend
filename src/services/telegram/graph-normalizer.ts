const DAY_MS = 24 * 60 * 60 * 1000;

export type GraphChartKind = 'line' | 'bar' | 'stacked_bar' | 'area';
export type GraphValueUnit = 'count' | 'percent';

export interface ParsedGraphSeries {
  key: string;
  label: string;
  values: Array<number | null>;
}

export interface ParsedTelegramGraph {
  timestamps: Array<number | null>;
  series: ParsedGraphSeries[];
  title: string | null;
}

export interface DensifyGraphInput {
  graphType: string;
  timestamps: Array<number | null>;
  series: ParsedGraphSeries[];
  periodEnd?: Date | null;
  days?: number;
}

export interface DensifyGraphOutput {
  timestamps: number[];
  series: Array<{
    key: string;
    label: string;
    values: number[];
  }>;
  periodStart: Date;
  periodEnd: Date;
}

export interface GraphDisplayMeta {
  title: string;
  xAxisLabel: string;
  yAxisLabel: string;
  yUnit: GraphValueUnit;
  chartKind: GraphChartKind;
  xAxisFormat: 'day';
  yAxisFormat: 'number' | 'percent';
}

const CUMULATIVE_GRAPH_TYPES = new Set<string>(['GROWTH', 'MUTE_GRAPH', 'LANGUAGES']);

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function normalizeTimestampMs(value: number): number {
  if (value > 0 && value < 1_000_000_000_000) {
    return value * 1000;
  }

  return value;
}

function toUtcDayStartMs(input: number | Date): number {
  const value = input instanceof Date ? input.getTime() : input;
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function resolveWindowEndMs(timestamps: Array<number | null>, periodEnd?: Date | null): number {
  if (periodEnd && Number.isFinite(periodEnd.getTime())) {
    return toUtcDayStartMs(periodEnd);
  }

  let maxTimestamp = Number.NaN;
  for (const raw of timestamps) {
    if (raw === null) {
      continue;
    }

    const normalized = normalizeTimestampMs(raw);
    if (!Number.isFinite(normalized)) {
      continue;
    }

    if (!Number.isFinite(maxTimestamp) || normalized > maxTimestamp) {
      maxTimestamp = normalized;
    }
  }

  if (Number.isFinite(maxTimestamp)) {
    return toUtcDayStartMs(maxTimestamp);
  }

  return toUtcDayStartMs(new Date());
}

export function parseTelegramStatsGraph(graphValue: unknown): ParsedTelegramGraph | null {
  const graph = toObjectRecord(graphValue);
  if (!graph) {
    return null;
  }

  const jsonContainer = toObjectRecord(graph.json);
  if (!jsonContainer || typeof jsonContainer.data !== 'string') {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = toObjectRecord(JSON.parse(jsonContainer.data)) || {};
  } catch {
    return null;
  }

  const columns = Array.isArray(data.columns) ? data.columns : [];
  if (columns.length === 0) {
    return null;
  }

  const names = toObjectRecord(data.names) || {};
  const types = toObjectRecord(data.types) || {};
  const title = typeof data.title === 'string' ? data.title : null;

  let timestamps: Array<number | null> = [];
  const series: ParsedGraphSeries[] = [];

  for (const column of columns) {
    if (!Array.isArray(column) || column.length < 2 || typeof column[0] !== 'string') {
      continue;
    }

    const key = column[0];
    const values = column.slice(1).map((entry) => toFiniteNumber(entry));

    if ((types[key] === 'x' || key === 'x')) {
      timestamps = values;
      continue;
    }

    series.push({
      key,
      label: typeof names[key] === 'string' ? names[key] : key,
      values,
    });
  }

  if (series.length === 0) {
    return null;
  }

  if (timestamps.length === 0) {
    const maxSeriesLength = Math.max(...series.map((entry) => entry.values.length));
    timestamps = Array.from({ length: maxSeriesLength }, (_, index) => index + 1);
  }

  return {
    timestamps,
    series,
    title,
  };
}

export function densifyGraphSeries(input: DensifyGraphInput): DensifyGraphOutput {
  const days = Math.max(1, Math.floor(input.days ?? 30));
  const windowEndMs = resolveWindowEndMs(input.timestamps, input.periodEnd);
  const windowStartMs = windowEndMs - ((days - 1) * DAY_MS);
  const isCumulative = CUMULATIVE_GRAPH_TYPES.has(input.graphType);

  const denseTimestamps = Array.from({ length: days }, (_, index) => windowStartMs + (index * DAY_MS));

  const denseSeries = input.series.map((entry) => {
    const dayValues = new Map<number, number>();
    let beforeWindowValue: number | null = null;

    const maxLength = Math.max(input.timestamps.length, entry.values.length);
    for (let index = 0; index < maxLength; index += 1) {
      const tsRaw = input.timestamps[index];
      const valueRaw = entry.values[index];

      if (tsRaw === null || valueRaw === null || !Number.isFinite(valueRaw)) {
        continue;
      }

      const normalizedTs = normalizeTimestampMs(tsRaw);
      if (!Number.isFinite(normalizedTs)) {
        continue;
      }

      const day = toUtcDayStartMs(normalizedTs);
      if (day < windowStartMs) {
        if (isCumulative) {
          beforeWindowValue = valueRaw;
        }
        continue;
      }

      if (day > windowEndMs) {
        continue;
      }

      if (isCumulative) {
        dayValues.set(day, valueRaw);
      } else {
        dayValues.set(day, (dayValues.get(day) ?? 0) + valueRaw);
      }
    }

    const values: number[] = [];
    let carryValue = beforeWindowValue ?? 0;

    for (const day of denseTimestamps) {
      if (dayValues.has(day)) {
        const value = dayValues.get(day) ?? 0;
        if (isCumulative) {
          carryValue = value;
          values.push(carryValue);
        } else {
          values.push(value);
        }
      } else if (isCumulative) {
        values.push(carryValue);
      } else {
        values.push(0);
      }
    }

    return {
      key: entry.key,
      label: entry.label,
      values,
    };
  });

  return {
    timestamps: denseTimestamps,
    series: denseSeries,
    periodStart: new Date(windowStartMs),
    periodEnd: new Date(windowEndMs),
  };
}

export function getGraphDisplayMeta(graphType: string): GraphDisplayMeta {
  switch (graphType) {
    case 'GROWTH':
      return {
        title: 'Growth',
        xAxisLabel: 'Date',
        yAxisLabel: 'Followers',
        yUnit: 'count',
        chartKind: 'line',
        xAxisFormat: 'day',
        yAxisFormat: 'number',
      };
    case 'FOLLOWERS':
      return {
        title: 'Followers',
        xAxisLabel: 'Date',
        yAxisLabel: 'Joined / Left',
        yUnit: 'count',
        chartKind: 'line',
        xAxisFormat: 'day',
        yAxisFormat: 'number',
      };
    case 'INTERACTIONS':
    case 'IV_INTERACTIONS':
    case 'STORY_INTERACTIONS':
      return {
        title: 'Interactions',
        xAxisLabel: 'Date',
        yAxisLabel: 'Interactions',
        yUnit: 'count',
        chartKind: 'line',
        xAxisFormat: 'day',
        yAxisFormat: 'number',
      };
    case 'VIEWS_BY_SOURCE':
      return {
        title: 'Views by source',
        xAxisLabel: 'Date',
        yAxisLabel: 'Views',
        yUnit: 'count',
        chartKind: 'stacked_bar',
        xAxisFormat: 'day',
        yAxisFormat: 'number',
      };
    case 'FOLLOWERS_BY_SOURCE':
      return {
        title: 'New followers by source',
        xAxisLabel: 'Date',
        yAxisLabel: 'Followers',
        yUnit: 'count',
        chartKind: 'stacked_bar',
        xAxisFormat: 'day',
        yAxisFormat: 'number',
      };
    case 'LANGUAGES':
      return {
        title: 'Languages',
        xAxisLabel: 'Date',
        yAxisLabel: 'Share',
        yUnit: 'percent',
        chartKind: 'stacked_bar',
        xAxisFormat: 'day',
        yAxisFormat: 'percent',
      };
    default:
      return {
        title: 'Analytics',
        xAxisLabel: 'Date',
        yAxisLabel: 'Value',
        yUnit: 'count',
        chartKind: 'line',
        xAxisFormat: 'day',
        yAxisFormat: 'number',
      };
  }
}

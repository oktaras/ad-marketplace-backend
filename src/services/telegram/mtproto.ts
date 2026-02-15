import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import {
  getAuthorizedUserMtprotoSession,
  getUserTelegramAuthStatus,
  hasAuthorizedUserMtprotoSession,
  persistAuthorizedUserMtprotoSession,
  setUserTelegramSessionError,
} from './userAuth.js';
import {
  densifyGraphSeries,
  getGraphDisplayMeta,
  parseTelegramStatsGraph,
} from './graph-normalizer.js';

const dynamicImport = new Function(
  'modulePath',
  'return import(modulePath)',
) as (modulePath: string) => Promise<unknown>;

const MTPROTO_STATUS = {
  AUTHORIZED: 'AUTHORIZED',
  FAILED: 'FAILED',
  DISCONNECTED: 'DISCONNECTED',
} as const;

export type MtprotoSessionState =
  | 'NOT_CONNECTED'
  | typeof MTPROTO_STATUS.AUTHORIZED
  | typeof MTPROTO_STATUS.FAILED
  | typeof MTPROTO_STATUS.DISCONNECTED;

export interface MtprotoStatusPayload {
  enabled: boolean;
  botTokenConfigured: boolean;
  status: MtprotoSessionState;
  isAuthorized: boolean;
  authMode: 'USER' | null;
  detailedStatsStatus: 'AVAILABLE' | 'NOT_AVAILABLE' | 'UNKNOWN';
  detailedStatsReason: string | null;
  detailedStatsCheckedAt: Date | null;
  lastAuthorizedAt: Date | null;
  lastError: string | null;
  updatedAt: Date | null;
}

interface GramJsRuntime {
  TelegramClient: new (...args: any[]) => any;
  StringSession: new (session: string) => any;
  Api: Record<string, any>;
}

export interface ChannelStatsGraphData {
  graphType: string; // GROWTH, FOLLOWERS, INTERACTIONS, etc.
  periodStart: Date;
  periodEnd: Date;
  isAsync: boolean;
  asyncToken?: string;
  timestamps: number[]; // BigInt as number for JSON serialization
  series: {
    key: string;
    label: string;
    values: number[];
  }[];
  title?: string;
  xAxisFormat?: string;
  yAxisFormat?: string;
  rawGraph?: Record<string, unknown>;
}

export interface MtprotoChannelStatsSnapshot {
  // Subscriber metrics
  subscriberCount: number;
  subscriberCountPrevious?: number;

  // Post metrics - current period
  averageViewCount?: number;
  averageShareCount?: number;
  averageReactionCount?: number;

  // Post metrics - previous period
  averageViewCountPrev?: number;
  averageShareCountPrev?: number;
  averageReactionCountPrev?: number;

  // Story metrics - current period
  viewsPerStory?: number;
  sharesPerStory?: number;
  reactionsPerStory?: number;

  // Story metrics - previous period
  viewsPerStoryPrev?: number;
  sharesPerStoryPrev?: number;
  reactionsPerStoryPrev?: number;

  // Engagement rates
  engagementRate?: number;
  storyEngagementRate?: number;

  // Notification metrics
  notificationEnabledPart?: number;
  notificationEnabledTotal?: number;
  notificationEnabledRate?: number;

  // Period
  periodStart?: Date;
  periodEnd?: Date;

  // Audience insights
  languageDistribution?: Record<string, number>;
  premiumSubscriberPercent?: number;

  // Growth
  subscriberGrowth7d?: number;
  subscriberGrowth30d?: number;

  // Metadata
  description?: string;
  inviteLink?: string;

  // Graph data
  graphs?: ChannelStatsGraphData[];
  rawData?: unknown;
}

interface DetailedStatsAvailability {
  status: 'AVAILABLE' | 'NOT_AVAILABLE' | 'UNKNOWN';
  reason: string | null;
}

function ensureMtprotoEnabled(): void {
  if (!config.mtprotoEnabled) {
    throw new Error('MTProto is not configured on backend.');
  }
}

export function isMtprotoBotConfigured(): boolean {
  return config.mtprotoEnabled;
}

export async function hasAuthorizedMtprotoSession(ownerId: string): Promise<boolean> {
  if (!config.mtprotoEnabled) {
    return false;
  }
  return hasAuthorizedUserMtprotoSession(ownerId);
}

function parseTelegramError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unknown MTProto error';
}

function isBotMethodInvalidError(error: unknown): boolean {
  return parseTelegramError(error).toUpperCase().includes('BOT_METHOD_INVALID');
}

async function loadGramJs(): Promise<GramJsRuntime> {
  let telegramModule: any;
  try {
    telegramModule = await dynamicImport('telegram');
  } catch {
    throw new Error(
      'MTProto library "telegram" is not installed. Run `npm install telegram --workspace=backend`.',
    );
  }

  let sessionsModule: any;
  try {
    sessionsModule = await dynamicImport('telegram/sessions/index.js');
  } catch {
    sessionsModule = await dynamicImport('telegram/sessions');
  }

  const TelegramClient = telegramModule.TelegramClient || telegramModule.default?.TelegramClient;
  const Api = telegramModule.Api || telegramModule.default?.Api;
  const StringSession = sessionsModule.StringSession || sessionsModule.default?.StringSession;

  if (!TelegramClient || !Api || !StringSession) {
    throw new Error('Failed to initialize MTProto runtime.');
  }

  return { TelegramClient, StringSession, Api };
}

async function createMtprotoClient(serializedSession: string) {
  const runtime = await loadGramJs();
  const session = new runtime.StringSession(serializedSession);
  const client = new runtime.TelegramClient(
    session,
    config.telegramApiId,
    config.telegramApiHash,
    { connectionRetries: 3 },
  );

  if (typeof client.setLogLevel === 'function') {
    client.setLogLevel('none');
  }

  await client.connect();
  return { client, runtime };
}

async function disconnectClient(client: any): Promise<void> {
  try {
    if (typeof client.disconnect === 'function') {
      await client.disconnect();
    }
  } catch {
    // Best-effort cleanup.
  }
}

function serializeSession(client: any): string {
  const value = client?.session?.save?.();
  return typeof value === 'string' ? value : '';
}

function toPlainJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toPlainJson(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = toPlainJson(item);
    }
    return output;
  }

  return value;
}

function extractInviteLink(fullChat: Record<string, unknown> | null): string | undefined {
  if (!fullChat) {
    return undefined;
  }

  const exportedInvite = fullChat.exportedInvite as Record<string, unknown> | undefined;
  if (exportedInvite && typeof exportedInvite.link === 'string') {
    return exportedInvite.link;
  }

  const invite = fullChat.inviteLink;
  return typeof invite === 'string' ? invite : undefined;
}

function extractStatsDc(fullChannelResult: unknown): number | null {
  const fullChat = (fullChannelResult as { fullChat?: Record<string, unknown> } | null)?.fullChat;
  if (!fullChat) {
    return null;
  }

  const statsDc = fullChat.statsDc;
  if (typeof statsDc === 'number' && Number.isFinite(statsDc)) {
    return statsDc;
  }

  const statsDcSnake = fullChat.stats_dc;
  if (typeof statsDcSnake === 'number' && Number.isFinite(statsDcSnake)) {
    return statsDcSnake;
  }

  return null;
}

function extractStatsDcFromRawSnapshot(rawData: unknown): number | null {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    return null;
  }

  const value = rawData as Record<string, unknown>;
  const topLevelStatsDc = toFiniteNumber(value.statsDc);
  if (topLevelStatsDc !== null) {
    return topLevelStatsDc;
  }

  const topLevelStatsDcSnake = toFiniteNumber(value.stats_dc);
  if (topLevelStatsDcSnake !== null) {
    return topLevelStatsDcSnake;
  }

  const fromFullChannel = extractStatsDc(value.fullChannel);
  if (fromFullChannel !== null) {
    return fromFullChannel;
  }

  const fromInitialFullChannel = extractStatsDc(value.initialFullChannel);
  if (fromInitialFullChannel !== null) {
    return fromInitialFullChannel;
  }

  return null;
}

function extractCanViewStats(fullChannelResult: unknown): boolean {
  const fullChat = (fullChannelResult as { fullChat?: Record<string, unknown> } | null)?.fullChat;
  if (!fullChat) {
    return false;
  }

  if (typeof fullChat.canViewStats === 'boolean') {
    return fullChat.canViewStats;
  }

  if (typeof fullChat.can_view_stats === 'boolean') {
    return fullChat.can_view_stats;
  }

  return false;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractMetricCurrent(
  source: unknown,
  camelCaseField: string,
  snakeCaseField: string,
): number | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }

  const record = source as Record<string, unknown>;
  const value = record[camelCaseField] ?? record[snakeCaseField];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const metric = value as Record<string, unknown>;
  const current = toFiniteNumber(metric.current);
  if (current !== null) {
    return current;
  }

  const currentSnake = toFiniteNumber(metric.current_value);
  if (currentSnake !== null) {
    return currentSnake;
  }

  return undefined;
}

function extractMetricPrevious(
  source: unknown,
  camelCaseField: string,
  snakeCaseField: string,
): number | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }

  const record = source as Record<string, unknown>;
  const value = record[camelCaseField] ?? record[snakeCaseField];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const metric = value as Record<string, unknown>;
  const previous = toFiniteNumber(metric.previous);
  if (previous !== null) {
    return previous;
  }

  const previousSnake = toFiniteNumber(metric.previous_value);
  if (previousSnake !== null) {
    return previousSnake;
  }

  return undefined;
}

function extractMetricPercent(
  source: unknown,
  camelCaseField: string,
  snakeCaseField: string,
): number | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }

  const record = source as Record<string, unknown>;
  const value = record[camelCaseField] ?? record[snakeCaseField];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const metric = value as Record<string, unknown>;
  const percent = toFiniteNumber(metric.percent);
  if (percent !== null) {
    const normalized = percent > 1 ? percent / 100 : percent;
    return Number(normalized.toFixed(4));
  }

  const part = toFiniteNumber(metric.part);
  const total = toFiniteNumber(metric.total);
  if (part !== null && total !== null && total > 0) {
    return Number((part / total).toFixed(4));
  }

  if (part !== null) {
    const normalized = part > 1 ? part / 100 : part;
    return Number(normalized.toFixed(4));
  }

  return undefined;
}

interface ParsedStatsGraphSeries {
  key: string;
  label: string;
  values: number[];
}

interface ParsedStatsGraph {
  timestamps: number[];
  series: ParsedStatsGraphSeries[];
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseStatsGraphData(graphValue: unknown): ParsedStatsGraph | null {
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
    const parsed = JSON.parse(jsonContainer.data);
    data = toObjectRecord(parsed) || {};
  } catch {
    return null;
  }

  const columns = Array.isArray(data.columns) ? data.columns : [];
  const names = toObjectRecord(data.names) || {};
  const types = toObjectRecord(data.types) || {};
  if (columns.length === 0) {
    return null;
  }

  let timestamps: number[] = [];
  const series: ParsedStatsGraphSeries[] = [];

  for (const column of columns) {
    if (!Array.isArray(column) || column.length < 2 || typeof column[0] !== 'string') {
      continue;
    }

    const key = column[0];
    const metricType = types[key];
    if (metricType === 'x' || key === 'x') {
      timestamps = column
        .slice(1)
        .map((value) => toFiniteNumber(value))
        .filter((value): value is number => value !== null);
      continue;
    }

    const values = column
      .slice(1)
      .map((value) => toFiniteNumber(value))
      .filter((value): value is number => value !== null);
    if (values.length === 0) {
      continue;
    }

    series.push({
      key,
      label: typeof names[key] === 'string' ? (names[key] as string) : key,
      values,
    });
  }

  if (series.length === 0) {
    return null;
  }

  if (timestamps.length === 0) {
    timestamps = Array.from({ length: series[0].values.length }, (_, index) => index);
  }

  return { timestamps, series };
}

function findGraphValue(
  key: string,
  broadcastStats: unknown,
  loadedAsyncGraphs: Record<string, unknown>,
): unknown {
  if (key in loadedAsyncGraphs) {
    return loadedAsyncGraphs[key];
  }

  if (broadcastStats && typeof broadcastStats === 'object' && !Array.isArray(broadcastStats)) {
    const stats = broadcastStats as Record<string, unknown>;
    return stats[key];
  }

  return undefined;
}

function extractLanguageDistribution(
  broadcastStats: unknown,
  loadedAsyncGraphs: Record<string, unknown>,
): Record<string, number> | undefined {
  const languagesGraph = findGraphValue('languagesGraph', broadcastStats, loadedAsyncGraphs);
  const parsed = parseStatsGraphData(languagesGraph);
  if (!parsed) {
    return undefined;
  }

  const totals = parsed.series
    .map((series) => ({
      label: series.label,
      value: series.values.reduce((sum, item) => sum + Math.max(0, item), 0),
    }))
    .filter((item) => item.value > 0);
  if (totals.length === 0) {
    return undefined;
  }

  const totalValue = totals.reduce((sum, item) => sum + item.value, 0);
  if (totalValue <= 0) {
    return undefined;
  }

  const distribution: Record<string, number> = {};
  for (const item of totals) {
    distribution[item.label] = Number(((item.value / totalValue) * 100).toFixed(1));
  }

  return distribution;
}

function pickPrimaryGrowthSeries(parsed: ParsedStatsGraph): ParsedStatsGraphSeries | null {
  if (parsed.series.length === 0) {
    return null;
  }

  return (
    parsed.series.find((series) => /total followers|followers|subscribers/i.test(series.label)) ||
    parsed.series[0]
  );
}

function calculateGraphGrowth(parsed: ParsedStatsGraph | null, days: number): number | undefined {
  if (!parsed || parsed.timestamps.length < 2) {
    return undefined;
  }

  const series = pickPrimaryGrowthSeries(parsed);
  if (!series || series.values.length < 2) {
    return undefined;
  }

  const minLength = Math.min(parsed.timestamps.length, series.values.length);
  if (minLength < 2) {
    return undefined;
  }

  const timestamps = parsed.timestamps.slice(0, minLength);
  const values = series.values.slice(0, minLength);

  const endIndex = minLength - 1;
  const endTs = timestamps[endIndex];
  const endValue = values[endIndex];
  if (!Number.isFinite(endTs) || !Number.isFinite(endValue)) {
    return undefined;
  }

  const windowMs = days * 24 * 60 * 60 * 1000;
  const startTs = endTs - windowMs;
  let startIndex = 0;
  for (let index = 0; index < endIndex; index += 1) {
    if (timestamps[index] <= startTs) {
      startIndex = index;
      continue;
    }
    break;
  }

  const startValue = values[startIndex];
  if (!Number.isFinite(startValue)) {
    return undefined;
  }

  return Math.round(endValue - startValue);
}

function extractPeriodLengthDays(broadcastStats: unknown): number | undefined {
  if (!broadcastStats || typeof broadcastStats !== 'object' || Array.isArray(broadcastStats)) {
    return undefined;
  }

  const stats = broadcastStats as Record<string, unknown>;
  const period = toObjectRecord(stats.period);
  if (!period) {
    return undefined;
  }

  const minDate = toFiniteNumber(period.minDate ?? period.min_date);
  const maxDate = toFiniteNumber(period.maxDate ?? period.max_date);
  if (minDate === null || maxDate === null || maxDate <= minDate) {
    return undefined;
  }

  return Math.max(1, Math.round((maxDate - minDate) / 86400));
}

function collectAsyncGraphTokens(stats: unknown): Array<{ key: string; token: string }> {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    return [];
  }

  const record = stats as Record<string, unknown>;
  const tokens: Array<{ key: string; token: string }> = [];
  for (const [key, value] of Object.entries(record)) {
    if (!key.toLowerCase().includes('graph')) {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }

    const graph = value as Record<string, unknown>;
    const token = graph.token;
    if (typeof token === 'string' && token.length > 0) {
      tokens.push({ key, token });
    }
  }

  return tokens;
}

async function loadAsyncGraphs(
  client: any,
  runtime: GramJsRuntime,
  statsDc: number | null,
  stats: unknown,
): Promise<Record<string, unknown>> {
  if (!runtime.Api?.stats?.LoadAsyncGraph) {
    return {};
  }

  const tokens = collectAsyncGraphTokens(stats);
  if (tokens.length === 0) {
    return {};
  }

  const loadedGraphs: Record<string, unknown> = {};
  for (const item of tokens) {
    try {
      const graph = await client.invoke(
        new runtime.Api.stats.LoadAsyncGraph({
          token: item.token,
        }),
        statsDc || undefined,
      );
      loadedGraphs[item.key] = graph;
    } catch (error) {
      loadedGraphs[item.key] = {
        error: parseTelegramError(error),
      };
    }
  }

  return loadedGraphs;
}

function getDetailedStatsAvailability(rawData: unknown): DetailedStatsAvailability {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    return {
      status: 'UNKNOWN',
      reason: null,
    };
  }

  const value = rawData as Record<string, unknown>;
  const statusRaw = value.detailedStatsStatus;
  if (statusRaw === 'AVAILABLE' || statusRaw === 'NOT_AVAILABLE' || statusRaw === 'UNKNOWN') {
    return {
      status: statusRaw,
      reason: typeof value.detailedStatsReason === 'string' ? value.detailedStatsReason : null,
    };
  }

  const canViewStatsRaw =
    typeof value.canViewStats === 'boolean'
      ? value.canViewStats
      : typeof value.can_view_stats === 'boolean'
        ? value.can_view_stats
        : null;

  if (canViewStatsRaw === false) {
    return {
      status: 'NOT_AVAILABLE',
      reason:
        'Detailed channel analytics are unavailable for this channel yet (Telegram enables them only for eligible channels with enough audience).',
    };
  }

  return {
    status: 'UNKNOWN',
    reason: null,
  };
}

function extractSubscriberCount(fullChannelResult: unknown): number | null {
  const fullChat = (fullChannelResult as { fullChat?: Record<string, unknown> } | null)?.fullChat;
  if (!fullChat) {
    return null;
  }

  const fromParticipants = fullChat.participantsCount;
  if (typeof fromParticipants === 'number' && Number.isFinite(fromParticipants)) {
    return fromParticipants;
  }

  const fromParticipantsSnake = fullChat.participants_count;
  if (typeof fromParticipantsSnake === 'number' && Number.isFinite(fromParticipantsSnake)) {
    return fromParticipantsSnake;
  }

  return null;
}

function mapUserTelegramStatusToMtprotoStatus(status: string): MtprotoSessionState {
  if (status === MTPROTO_STATUS.AUTHORIZED) {
    return MTPROTO_STATUS.AUTHORIZED;
  }
  if (status === MTPROTO_STATUS.FAILED) {
    return MTPROTO_STATUS.FAILED;
  }
  if (status === MTPROTO_STATUS.DISCONNECTED) {
    return MTPROTO_STATUS.DISCONNECTED;
  }
  return 'NOT_CONNECTED';
}

export async function getMtprotoSessionStatus(
  channelId: string,
  ownerId: string,
): Promise<MtprotoStatusPayload> {
  if (!config.mtprotoEnabled) {
    return {
      enabled: false,
      botTokenConfigured: false,
      status: 'NOT_CONNECTED',
      isAuthorized: false,
      authMode: null,
      detailedStatsStatus: 'UNKNOWN',
      detailedStatsReason: null,
      detailedStatsCheckedAt: null,
      lastAuthorizedAt: null,
      lastError: null,
      updatedAt: null,
    };
  }

  const userSessionStatus = await getUserTelegramAuthStatus(ownerId);
  const mappedStatus = mapUserTelegramStatusToMtprotoStatus(userSessionStatus.status);

  const latestMtprotoStats = await prisma.channelStats.findFirst({
    where: {
      channelId,
      source: 'MTPROTO',
    },
    orderBy: { fetchedAt: 'desc' },
    select: {
      rawData: true,
      fetchedAt: true,
    },
  });
  const detailedStats = getDetailedStatsAvailability(latestMtprotoStats?.rawData);

  const isAuthorized = mappedStatus === MTPROTO_STATUS.AUTHORIZED;

  return {
    enabled: userSessionStatus.enabled,
    botTokenConfigured: userSessionStatus.enabled,
    status: mappedStatus,
    isAuthorized,
    authMode: isAuthorized ? 'USER' : null,
    detailedStatsStatus: detailedStats.status,
    detailedStatsReason: detailedStats.reason,
    detailedStatsCheckedAt: latestMtprotoStats?.fetchedAt || null,
    lastAuthorizedAt: userSessionStatus.lastAuthorizedAt,
    lastError: userSessionStatus.lastError,
    updatedAt: userSessionStatus.updatedAt,
  };
}

/**
 * Extracts all available graphs from BroadcastStats and loaded async graphs
 */
function extractAllGraphs(
  broadcastStats: unknown,
  loadedAsyncGraphs: Record<string, unknown>,
  periodStart: Date | undefined,
  periodEnd: Date | undefined,
): ChannelStatsGraphData[] {
  const graphs: ChannelStatsGraphData[] = [];
  const statsObj = toObjectRecord(broadcastStats);
  if (!statsObj || !periodStart || !periodEnd) {
    return graphs;
  }

  // Graph type mapping
  const graphTypes: Array<{
    key: string;
    type: string;
    isAsync: boolean;
  }> = [
    // Synchronous graphs
    { key: 'growthGraph', type: 'GROWTH', isAsync: false },
    { key: 'followersGraph', type: 'FOLLOWERS', isAsync: false },
    { key: 'muteGraph', type: 'MUTE_GRAPH', isAsync: false },
    { key: 'topHoursGraph', type: 'TOP_HOURS', isAsync: false },

    // Asynchronous graphs
    { key: 'interactionsGraph', type: 'INTERACTIONS', isAsync: true },
    { key: 'ivInteractionsGraph', type: 'IV_INTERACTIONS', isAsync: true },
    { key: 'viewsBySourceGraph', type: 'VIEWS_BY_SOURCE', isAsync: true },
    { key: 'newFollowersBySourceGraph', type: 'FOLLOWERS_BY_SOURCE', isAsync: true },
    { key: 'languagesGraph', type: 'LANGUAGES', isAsync: true },
    { key: 'reactionsByEmotionGraph', type: 'REACTIONS_BY_EMOTION', isAsync: true },
    { key: 'storyInteractionsGraph', type: 'STORY_INTERACTIONS', isAsync: true },
    { key: 'storyReactionsByEmotionGraph', type: 'STORY_REACTIONS', isAsync: true },
  ];

  for (const { key, type, isAsync } of graphTypes) {
    // Check if graph exists (either in broadcastStats for sync or loadedAsyncGraphs for async)
    const graphValue = isAsync ? loadedAsyncGraphs[key] : statsObj[key];
    if (!graphValue) {
      continue;
    }

    const graphObj = toObjectRecord(graphValue);
    if (!graphObj) {
      continue;
    }

    // Check if it's an error graph (StatsGraphError)
    if (graphObj.className === 'StatsGraphError') {
      continue;
    }

    // Check if it's an async token graph (StatsGraphAsync) - store the token
    if (graphObj.className === 'StatsGraphAsync' && typeof graphObj.token === 'string') {
      graphs.push({
        graphType: type,
        periodStart,
        periodEnd,
        isAsync: true,
        asyncToken: graphObj.token,
        timestamps: [],
        series: [],
        rawGraph: graphObj as Record<string, unknown>,
      });
      continue;
    }

    // Parse actual graph data (StatsGraph with json.data)
    const parsed = parseTelegramStatsGraph(graphValue);
    if (!parsed || parsed.timestamps.length === 0) {
      continue;
    }

    const dense = densifyGraphSeries({
      graphType: type,
      timestamps: parsed.timestamps,
      series: parsed.series,
      periodEnd,
      days: 30,
    });
    const displayMeta = getGraphDisplayMeta(type);

    graphs.push({
      graphType: type,
      periodStart: dense.periodStart,
      periodEnd: dense.periodEnd,
      isAsync,
      timestamps: dense.timestamps,
      series: dense.series,
      title: parsed.title || displayMeta.title,
      xAxisFormat: displayMeta.xAxisFormat,
      yAxisFormat: displayMeta.yAxisFormat,
      rawGraph: graphObj as Record<string, unknown>,
    });
  }

  return graphs;
}

export async function fetchChannelStatsFromMtproto(params: {
  channelId: string;
  ownerId: string;
  channelUsername: string;
}): Promise<MtprotoChannelStatsSnapshot> {
  ensureMtprotoEnabled();
  const hasSession = await hasAuthorizedUserMtprotoSession(params.ownerId);
  if (!hasSession) {
    throw new Error('MTProto user session is not connected for this channel owner.');
  }

  const ownerSession = await getAuthorizedUserMtprotoSession(params.ownerId);
  if (!ownerSession) {
    throw new Error('MTProto user session is unavailable for this channel owner.');
  }

  const { client, runtime } = await createMtprotoClient(ownerSession);
  try {
    const channelRef = params.channelUsername.startsWith('@')
      ? params.channelUsername
      : `@${params.channelUsername}`;

    const latestSnapshot = await prisma.channelStats.findFirst({
      where: {
        channelId: params.channelId,
        source: 'MTPROTO',
      },
      orderBy: { fetchedAt: 'desc' },
      select: { rawData: true },
    });
    const cachedStatsDc = extractStatsDcFromRawSnapshot(latestSnapshot?.rawData);
    const initialRequestDc = cachedStatsDc || undefined;

    const inputChannel = await client.getInputEntity(channelRef);
    const initialFullChannel = await client.invoke(
      new runtime.Api.channels.GetFullChannel({
        channel: inputChannel,
      }),
      initialRequestDc,
    );

    const discoveredStatsDc = extractStatsDc(initialFullChannel) || cachedStatsDc;
    let fullChannel = initialFullChannel;
    let statsDc = discoveredStatsDc;

    if (discoveredStatsDc && discoveredStatsDc !== initialRequestDc) {
      try {
        const dcAlignedFullChannel = await client.invoke(
          new runtime.Api.channels.GetFullChannel({
            channel: inputChannel,
          }),
          discoveredStatsDc,
        );
        fullChannel = dcAlignedFullChannel;
        statsDc = extractStatsDc(dcAlignedFullChannel) || discoveredStatsDc;
      } catch {
        statsDc = discoveredStatsDc;
      }
    }

    const canViewStats = extractCanViewStats(fullChannel);
    let detailedStatsStatus: 'AVAILABLE' | 'NOT_AVAILABLE' | 'UNKNOWN' = 'UNKNOWN';
    let detailedStatsReason: string | null = null;

    let broadcastStats: unknown = null;
    let loadedAsyncGraphs: Record<string, unknown> = {};
    if (!canViewStats) {
      detailedStatsStatus = 'NOT_AVAILABLE';
      detailedStatsReason =
        'Detailed channel analytics are unavailable for this channel yet (Telegram enables them only for eligible channels with enough audience).';
    } else if (runtime.Api?.stats?.GetBroadcastStats) {
      try {
        broadcastStats = await client.invoke(
          new runtime.Api.stats.GetBroadcastStats({
            channel: inputChannel,
            dark: true,
          }),
          statsDc || undefined,
        );
        loadedAsyncGraphs = await loadAsyncGraphs(client, runtime, statsDc, broadcastStats);

        detailedStatsStatus = 'AVAILABLE';
        detailedStatsReason = null;
      } catch (error) {
        detailedStatsStatus = 'NOT_AVAILABLE';
        detailedStatsReason = isBotMethodInvalidError(error)
          ? 'Detailed channel statistics are not allowed for the current Telegram session on this channel.'
          : 'Telegram denied access to detailed channel statistics for this channel.';
      }
    } else {
      detailedStatsStatus = 'UNKNOWN';
      detailedStatsReason = 'Detailed channel statistics method is unavailable in current runtime.';
    }

    const subscriberCount = extractSubscriberCount(fullChannel);
    if (!subscriberCount || subscriberCount <= 0) {
      throw new Error('Failed to read subscribers from MTProto.');
    }

    // Subscriber metrics (current and previous)
    const subscribersFromBroadcastStats = extractMetricCurrent(
      broadcastStats,
      'followers',
      'followers',
    );
    const subscriberCountPrevious = extractMetricPrevious(
      broadcastStats,
      'followers',
      'followers',
    );

    // Post metrics - current period
    const averageViewCount = extractMetricCurrent(
      broadcastStats,
      'viewsPerPost',
      'views_per_post',
    );
    const averageShareCount = extractMetricCurrent(
      broadcastStats,
      'sharesPerPost',
      'shares_per_post',
    );
    const reactionsPerPost = extractMetricCurrent(
      broadcastStats,
      'reactionsPerPost',
      'reactions_per_post',
    );

    // Post metrics - previous period (for trending)
    const averageViewCountPrev = extractMetricPrevious(
      broadcastStats,
      'viewsPerPost',
      'views_per_post',
    );
    const averageShareCountPrev = extractMetricPrevious(
      broadcastStats,
      'sharesPerPost',
      'shares_per_post',
    );
    const reactionsPerPostPrev = extractMetricPrevious(
      broadcastStats,
      'reactionsPerPost',
      'reactions_per_post',
    );

    // Story metrics - current period
    const viewsPerStory = extractMetricCurrent(
      broadcastStats,
      'viewsPerStory',
      'views_per_story',
    );
    const sharesPerStory = extractMetricCurrent(
      broadcastStats,
      'sharesPerStory',
      'shares_per_story',
    );
    const reactionsPerStory = extractMetricCurrent(
      broadcastStats,
      'reactionsPerStory',
      'reactions_per_story',
    );

    // Story metrics - previous period (for trending)
    const viewsPerStoryPrev = extractMetricPrevious(
      broadcastStats,
      'viewsPerStory',
      'views_per_story',
    );
    const sharesPerStoryPrev = extractMetricPrevious(
      broadcastStats,
      'sharesPerStory',
      'shares_per_story',
    );
    const reactionsPerStoryPrev = extractMetricPrevious(
      broadcastStats,
      'reactionsPerStory',
      'reactions_per_story',
    );

    // Engagement rates
    const engagementRateFromStats = extractMetricPercent(
      broadcastStats,
      'interactionsPerPost',
      'interactions_per_post',
    );
    const derivedEngagementRate =
      averageViewCount && averageViewCount > 0
        ? Number((((reactionsPerPost || 0) + (averageShareCount || 0)) / averageViewCount).toFixed(4))
        : undefined;

    const storyEngagementRate =
      viewsPerStory && viewsPerStory > 0
        ? Number((((reactionsPerStory || 0) + (sharesPerStory || 0)) / viewsPerStory).toFixed(4))
        : undefined;

    // Notification metrics
    const enabledNotificationsRate = extractMetricPercent(
      broadcastStats,
      'enabledNotifications',
      'enabled_notifications',
    );
    const enabledNotificationsPart = (broadcastStats as any)?.enabledNotifications?.part ??
                                      (broadcastStats as any)?.enabledNotifications?.partValue ??
                                      (broadcastStats as any)?.enabled_notifications?.part ??
                                      (broadcastStats as any)?.enabled_notifications?.part_value;
    const enabledNotificationsTotal = (broadcastStats as any)?.enabledNotifications?.total ??
                                       (broadcastStats as any)?.enabledNotifications?.totalValue ??
                                       (broadcastStats as any)?.enabled_notifications?.total ??
                                       (broadcastStats as any)?.enabled_notifications?.total_value;

    // Period dates
    const periodStart = (broadcastStats as any)?.period?.minDate
      ? new Date((broadcastStats as any).period.minDate * 1000)
      : undefined;
    const periodEnd = (broadcastStats as any)?.period?.maxDate
      ? new Date((broadcastStats as any).period.maxDate * 1000)
      : undefined;

    const languageDistribution = extractLanguageDistribution(broadcastStats, loadedAsyncGraphs);

    const growthGraph = parseStatsGraphData(
      findGraphValue('growthGraph', broadcastStats, loadedAsyncGraphs),
    );
    const growth7dFromGraph = calculateGraphGrowth(growthGraph, 7);
    const growth30dFromGraph = calculateGraphGrowth(growthGraph, 30);
    const followersCurrent = extractMetricCurrent(broadcastStats, 'followers', 'followers');
    const followersPrevious = extractMetricPrevious(broadcastStats, 'followers', 'followers');
    const periodLengthDays = extractPeriodLengthDays(broadcastStats);
    const periodGrowth =
      followersCurrent !== undefined && followersPrevious !== undefined
        ? Math.round(followersCurrent - followersPrevious)
        : undefined;
    const subscriberGrowth7d =
      growth7dFromGraph !== undefined
        ? growth7dFromGraph
        : periodGrowth !== undefined &&
            periodLengthDays !== undefined &&
            periodLengthDays >= 5 &&
            periodLengthDays <= 10
          ? periodGrowth
          : undefined;
    const subscriberGrowth30d =
      growth30dFromGraph !== undefined
        ? growth30dFromGraph
        : periodGrowth !== undefined &&
            periodLengthDays !== undefined &&
            periodLengthDays >= 25
          ? periodGrowth
          : undefined;

    const description =
      typeof (fullChannel as { fullChat?: Record<string, unknown> }).fullChat?.about === 'string'
        ? ((fullChannel as { fullChat?: Record<string, unknown> }).fullChat?.about as string)
        : undefined;
    const inviteLink = extractInviteLink(
      (fullChannel as { fullChat?: Record<string, unknown> }).fullChat || null,
    );

    // Extract all available graphs
    const graphs = extractAllGraphs(broadcastStats, loadedAsyncGraphs, periodStart, periodEnd);

    await setUserTelegramSessionError(params.ownerId, null);

    const nextSerializedSession = serializeSession(client);
    await persistAuthorizedUserMtprotoSession(params.ownerId, nextSerializedSession);

    return {
      subscriberCount: subscribersFromBroadcastStats || subscriberCount,
      subscriberCountPrevious,

      averageViewCount: averageViewCount,
      averageShareCount: averageShareCount,
      averageReactionCount: reactionsPerPost,

      averageViewCountPrev: averageViewCountPrev,
      averageShareCountPrev: averageShareCountPrev,
      averageReactionCountPrev: reactionsPerPostPrev,

      viewsPerStory,
      sharesPerStory,
      reactionsPerStory,

      viewsPerStoryPrev,
      sharesPerStoryPrev,
      reactionsPerStoryPrev,

      engagementRate: engagementRateFromStats ?? derivedEngagementRate,
      storyEngagementRate,

      notificationEnabledPart: enabledNotificationsPart !== undefined
        ? Math.round(enabledNotificationsPart)
        : undefined,
      notificationEnabledTotal: enabledNotificationsTotal !== undefined
        ? Math.round(enabledNotificationsTotal)
        : undefined,
      notificationEnabledRate: enabledNotificationsRate,

      periodStart,
      periodEnd,

      languageDistribution,
      subscriberGrowth7d,
      subscriberGrowth30d,
      description,
      inviteLink,
      graphs,

      rawData: toPlainJson({
        initialFullChannel,
        fullChannel,
        broadcastStats,
        loadedAsyncGraphs,
        statsDc,
        canViewStats,
        detailedStatsStatus,
        detailedStatsReason,
        resolvedMetrics: {
          followerCountCurrent: followersCurrent,
          followerCountPrevious: followersPrevious,
          periodLengthDays,
          avgViewsPerPost: averageViewCount,
          avgSharesPerPost: averageShareCount,
          avgReactionsPerPost: reactionsPerPost,
          avgViewsPerStory: viewsPerStory,
          avgSharesPerStory: sharesPerStory,
          avgReactionsPerStory: reactionsPerStory,
          engagementRate: engagementRateFromStats ?? derivedEngagementRate,
          storyEngagementRate,
          enabledNotificationsRate,
          enabledNotificationsPart,
          enabledNotificationsTotal,
          subscriberGrowth7d,
          subscriberGrowth30d,
          languageDistribution,
          periodStart,
          periodEnd,
        },
        authMode: 'USER',
      }),
    };
  } catch (error) {
    await setUserTelegramSessionError(params.ownerId, parseTelegramError(error));
    throw error;
  } finally {
    await disconnectClient(client);
  }
}

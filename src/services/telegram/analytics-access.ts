import { StatsSource } from '@prisma/client';

export const GENERIC_DETAILED_ANALYTICS_REASON =
  'Detailed analytics are not available for this channel yet.';
export const OWNER_CONNECT_TELEGRAM_REASON =
  'Connect your Telegram account to unlock detailed analytics.';
export const OWNER_DETAILED_ANALYTICS_PENDING_REASON =
  'Detailed analytics are not available yet. Queue a refresh to fetch new Telegram stats.';

export interface ResolveDetailedAnalyticsAccessInput {
  ownerId: string;
  viewerUserId?: string | null;
  ownerHasMtprotoSession: boolean;
  source: StatsSource | null | undefined;
  mtprotoEligibilityReason?: string | null;
}

export interface DetailedAnalyticsAccessPolicy {
  detailedAvailable: boolean;
  isOwnerViewer: boolean;
  viewerReason: string | null;
  ownerReason: string | null;
}

export function resolveDetailedAnalyticsAccess(
  input: ResolveDetailedAnalyticsAccessInput,
): DetailedAnalyticsAccessPolicy {
  const isOwnerViewer = Boolean(input.viewerUserId && input.viewerUserId === input.ownerId);

  let detailedAvailable = false;
  let ownerReason: string | null = null;

  if (!input.ownerHasMtprotoSession) {
    ownerReason = OWNER_CONNECT_TELEGRAM_REASON;
  } else if (input.source !== StatsSource.MTPROTO) {
    ownerReason = OWNER_DETAILED_ANALYTICS_PENDING_REASON;
  } else if (input.mtprotoEligibilityReason) {
    ownerReason = input.mtprotoEligibilityReason;
  } else {
    detailedAvailable = true;
  }

  const viewerReason = detailedAvailable
    ? null
    : (isOwnerViewer ? ownerReason : GENERIC_DETAILED_ANALYTICS_REASON);

  return {
    detailedAvailable,
    isOwnerViewer,
    viewerReason,
    ownerReason,
  };
}

export function getDetailedMetricReason(
  access: DetailedAnalyticsAccessPolicy,
  ownerFallbackReason: string | null,
): string {
  if (!access.detailedAvailable) {
    return access.viewerReason || GENERIC_DETAILED_ANALYTICS_REASON;
  }

  if (access.isOwnerViewer) {
    return ownerFallbackReason || GENERIC_DETAILED_ANALYTICS_REASON;
  }

  return GENERIC_DETAILED_ANALYTICS_REASON;
}

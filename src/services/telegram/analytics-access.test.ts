import { describe, expect, it } from 'vitest';
import { StatsSource } from '@prisma/client';
import {
  GENERIC_DETAILED_ANALYTICS_REASON,
  OWNER_CONNECT_TELEGRAM_REASON,
  resolveDetailedAnalyticsAccess,
  getDetailedMetricReason,
} from './analytics-access.js';

describe('resolveDetailedAnalyticsAccess', () => {
  it('locks detailed analytics when owner is disconnected', () => {
    const result = resolveDetailedAnalyticsAccess({
      ownerId: 'owner-1',
      viewerUserId: 'owner-1',
      ownerHasMtprotoSession: false,
      source: StatsSource.MTPROTO,
      mtprotoEligibilityReason: null,
    });

    expect(result.detailedAvailable).toBe(false);
    expect(result.viewerReason).toBe(OWNER_CONNECT_TELEGRAM_REASON);
    expect(result.isOwnerViewer).toBe(true);
  });

  it('redacts reason for non-owner viewers', () => {
    const result = resolveDetailedAnalyticsAccess({
      ownerId: 'owner-1',
      viewerUserId: 'viewer-1',
      ownerHasMtprotoSession: false,
      source: StatsSource.MTPROTO,
      mtprotoEligibilityReason: null,
    });

    expect(result.detailedAvailable).toBe(false);
    expect(result.viewerReason).toBe(GENERIC_DETAILED_ANALYTICS_REASON);
    expect(result.isOwnerViewer).toBe(false);
  });

  it('allows detailed analytics when owner is connected and stats are MTProto-eligible', () => {
    const result = resolveDetailedAnalyticsAccess({
      ownerId: 'owner-1',
      viewerUserId: 'viewer-1',
      ownerHasMtprotoSession: true,
      source: StatsSource.MTPROTO,
      mtprotoEligibilityReason: null,
    });

    expect(result.detailedAvailable).toBe(true);
    expect(result.viewerReason).toBeNull();
  });
});

describe('getDetailedMetricReason', () => {
  it('keeps owner fallback reason when detailed analytics are available for owner', () => {
    const access = resolveDetailedAnalyticsAccess({
      ownerId: 'owner-1',
      viewerUserId: 'owner-1',
      ownerHasMtprotoSession: true,
      source: StatsSource.MTPROTO,
      mtprotoEligibilityReason: null,
    });

    const reason = getDetailedMetricReason(access, 'Owner detail');
    expect(reason).toBe('Owner detail');
  });

  it('always keeps non-owner reason generic', () => {
    const access = resolveDetailedAnalyticsAccess({
      ownerId: 'owner-1',
      viewerUserId: 'viewer-1',
      ownerHasMtprotoSession: true,
      source: StatsSource.MTPROTO,
      mtprotoEligibilityReason: null,
    });

    const reason = getDetailedMetricReason(access, 'Owner detail');
    expect(reason).toBe(GENERIC_DETAILED_ANALYTICS_REASON);
  });
});

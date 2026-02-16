import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRecoveryEnsureParticipantTopicParams,
  isMissingTopicError,
  recoverRelayAndRetryOnce,
} from './bot.js';

describe('isMissingTopicError', () => {
  it('table-drives supported missing-topic payload shapes', () => {
    const cases: Array<{ name: string; payload: unknown; expected: boolean }> = [
      {
        name: 'known token: topic_deleted',
        payload: new Error('Bad Request: topic_deleted'),
        expected: true,
      },
      {
        name: 'known token: message thread not found',
        payload: { message: 'Bad Request: message thread not found' },
        expected: true,
      },
      {
        name: 'known token: invalid message_thread_id',
        payload: { description: 'Bad Request: invalid message_thread_id' },
        expected: true,
      },
      {
        name: 'known token: topic_id_invalid',
        payload: { error: { description: 'Bad Request: topic_id_invalid' } },
        expected: true,
      },
      {
        name: 'known token: direct_messages_topic_id_invalid',
        payload: { description: 'Bad Request: direct_messages_topic_id_invalid' },
        expected: true,
      },
      {
        name: 'nested response with 400',
        payload: { response: { description: 'Bad Request: invalid message thread id', error_code: 400 } },
        expected: true,
      },
      {
        name: '400 fallback with topic semantics',
        payload: { code: 400, description: 'Bad Request: direct_messages_topic reference is invalid' },
        expected: true,
      },
      {
        name: 'non-400 should not fallback',
        payload: { code: 403, description: 'Bad Request: message thread' },
        expected: false,
      },
      {
        name: 'permission error should not match',
        payload: new Error('Forbidden: bot was blocked by the user'),
        expected: false,
      },
      {
        name: 'generic internal error should not match',
        payload: { code: 500, description: 'Internal error' },
        expected: false,
      },
    ];

    for (const entry of cases) {
      expect(isMissingTopicError(entry.payload), entry.name).toBe(entry.expected);
    }
  });
});

describe('recoverRelayAndRetryOnce', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers and auto-retries successfully without resend notice', async () => {
    const ensureDestinationTopic = async () => ({
      chatId: 101n,
      threadId: 202n,
      recreated: true,
    });
    let retried = 0;
    let resendNotified = 0;

    const result = await recoverRelayAndRetryOnce({
      dealId: 'deal-1',
      fromThreadId: 303n,
      toSide: 'PUBLISHER',
      ensureDestinationTopic,
      retryRelayToDestination: async () => {
        retried += 1;
      },
      notifySenderResend: async () => {
        resendNotified += 1;
      },
    });

    expect(result).toBe('retry_succeeded');
    expect(retried).toBe(1);
    expect(resendNotified).toBe(0);
  });

  it('sends resend notice when auto-retry fails', async () => {
    let resendNotified = 0;
    const result = await recoverRelayAndRetryOnce({
      dealId: 'deal-2',
      fromThreadId: 404n,
      toSide: 'ADVERTISER',
      ensureDestinationTopic: async () => ({
        chatId: 505n,
        threadId: 606n,
        recreated: true,
      }),
      retryRelayToDestination: async () => {
        throw new Error('retry failed');
      },
      notifySenderResend: async () => {
        resendNotified += 1;
      },
    });

    expect(result).toBe('resend_notified');
    expect(resendNotified).toBe(1);
  });

  it('returns recovery_failed when recovery itself fails', async () => {
    let resendNotified = 0;
    const result = await recoverRelayAndRetryOnce({
      dealId: 'deal-3',
      fromThreadId: 707n,
      toSide: 'PUBLISHER',
      ensureDestinationTopic: async () => {
        throw new Error('cannot recover');
      },
      retryRelayToDestination: async () => {
        throw new Error('should not run');
      },
      notifySenderResend: async () => {
        resendNotified += 1;
      },
    });

    expect(result).toBe('recovery_failed');
    expect(resendNotified).toBe(0);
  });
});

describe('buildRecoveryEnsureParticipantTopicParams', () => {
  it('forces recreate and bypasses grace window for confirmed missing-topic recovery', () => {
    expect(buildRecoveryEnsureParticipantTopicParams('deal-123', 'PUBLISHER')).toEqual({
      dealId: 'deal-123',
      side: 'PUBLISHER',
      recreateOnUnreachable: true,
      bypassRecentGraceWindow: true,
    });
  });
});

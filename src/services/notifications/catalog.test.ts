import { describe, expect, it } from 'vitest';
import {
  buildChatTemplate,
  buildExpectedNotificationIds,
  CHAT_ACTION_LABELS,
  IN_CHAT_NOTIFICATION_IDS,
  type ChatTemplateId,
} from './catalog.js';

describe('notification chat catalog contract', () => {
  const expectedIds = buildExpectedNotificationIds('B', 33);

  it('covers B01..B33', () => {
    expect(IN_CHAT_NOTIFICATION_IDS).toEqual(expectedIds);
  });

  it('builds non-empty title and message for every template', () => {
    for (const id of IN_CHAT_NOTIFICATION_IDS) {
      const template = buildChatTemplate(id as ChatTemplateId, {
        briefTitle: 'Sample brief',
        dealNumber: 42,
        channelTitle: 'Sample channel',
        statusLabel: 'Awaiting Payment',
        reason: 'Test reason',
        feedback: 'Test feedback',
        amount: '10',
        violationLabel: 'Deleted',
        hoursRemaining: 12,
        dealSummary: 'Sample deal summary',
        verifyExample: '/verify <channel_id>',
      });

      expect(template.title.trim().length, `${id} title`).toBeGreaterThan(0);
      expect(template.message.trim().length, `${id} message`).toBeGreaterThan(0);
      expect(template.title.length, `${id} title length`).toBeLessThanOrEqual(80);
      expect(template.message.length, `${id} message length`).toBeLessThanOrEqual(320);
    }
  });

  it('uses valid action labels when actions are present', () => {
    for (const id of IN_CHAT_NOTIFICATION_IDS) {
      const template = buildChatTemplate(id as ChatTemplateId);
      const actionKeys = [template.primaryActionKey, template.secondaryActionKey].filter(Boolean) as string[];

      expect(actionKeys.length, `${id} action count`).toBeLessThanOrEqual(2);
      for (const actionKey of actionKeys) {
        expect(actionKey in CHAT_ACTION_LABELS, `${id} unknown action key`).toBe(true);
      }
    }
  });
});

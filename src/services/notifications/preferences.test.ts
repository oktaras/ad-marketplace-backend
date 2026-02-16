import { describe, expect, it } from 'vitest';
import {
  AUTO_ALERT_TEMPLATE_TO_GROUP,
  NOTIFICATION_SETTINGS_GROUPS,
  buildNotificationSettingsCatalog,
  getNotificationGroupForTemplate,
  isTemplateDeliveryEnabled,
  projectUserNotificationSettings,
} from './preferences.js';

describe('notification preferences service', () => {
  it('maps each auto-alert template B01..B22 exactly once', () => {
    const mapKeys = Object.keys(AUTO_ALERT_TEMPLATE_TO_GROUP).sort();
    const expected = Array.from({ length: 22 }, (_, index) => `B${String(index + 1).padStart(2, '0')}`);
    expect(mapKeys).toEqual(expected);
  });

  it('provides UI group metadata with template coverage', () => {
    expect(NOTIFICATION_SETTINGS_GROUPS).toHaveLength(4);
    const catalog = buildNotificationSettingsCatalog();
    expect(catalog).toHaveLength(4);

    const allTemplateIds = catalog.flatMap((group) => group.templateIds).sort();
    const expected = Array.from({ length: 22 }, (_, index) => `B${String(index + 1).padStart(2, '0')}`);
    expect(allTemplateIds).toEqual(expected);
  });

  it('projects user preference flags to API DTO with safe defaults', () => {
    expect(projectUserNotificationSettings(null)).toEqual({
      advertiserMessages: true,
      publisherMessages: true,
      paymentMessages: true,
      systemMessages: true,
    });

    expect(projectUserNotificationSettings({
      notifyAdvertiserMessages: false,
      notifyPublisherMessages: true,
      notifyPaymentMessages: false,
      notifySystemMessages: true,
    })).toEqual({
      advertiserMessages: false,
      publisherMessages: true,
      paymentMessages: false,
      systemMessages: true,
    });
  });

  it('returns template group and evaluates delivery by group setting', () => {
    expect(getNotificationGroupForTemplate('B14')).toBe('paymentMessages');
    expect(getNotificationGroupForTemplate('B04')).toBe('publisherMessages');

    const settings = {
      advertiserMessages: true,
      publisherMessages: false,
      paymentMessages: false,
      systemMessages: true,
    };

    expect(isTemplateDeliveryEnabled(settings, 'B04')).toBe(false);
    expect(isTemplateDeliveryEnabled(settings, 'B14')).toBe(false);
    expect(isTemplateDeliveryEnabled(settings, 'B19')).toBe(true);
  });

  it('keeps delivery enabled for unknown/missing template ids', () => {
    const settings = {
      advertiserMessages: false,
      publisherMessages: false,
      paymentMessages: false,
      systemMessages: false,
    };

    expect(isTemplateDeliveryEnabled(settings, undefined)).toBe(true);
    expect(isTemplateDeliveryEnabled(settings, null)).toBe(true);
    expect(isTemplateDeliveryEnabled(settings, 'B33')).toBe(true);
    expect(isTemplateDeliveryEnabled(settings, 'UNKNOWN_TEMPLATE')).toBe(true);
  });
});


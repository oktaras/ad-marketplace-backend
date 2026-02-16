import type { ChatTemplateId } from './catalog.js';

export type NotificationPreferenceGroupKey =
  | 'advertiserMessages'
  | 'publisherMessages'
  | 'paymentMessages'
  | 'systemMessages';

export type AutoAlertTemplateId =
  | 'B01'
  | 'B02'
  | 'B03'
  | 'B04'
  | 'B05'
  | 'B06'
  | 'B07'
  | 'B08'
  | 'B09'
  | 'B10'
  | 'B11'
  | 'B12'
  | 'B13'
  | 'B14'
  | 'B15'
  | 'B16'
  | 'B17'
  | 'B18'
  | 'B19'
  | 'B20'
  | 'B21'
  | 'B22';

export type NotificationSettingsDto = {
  advertiserMessages: boolean;
  publisherMessages: boolean;
  paymentMessages: boolean;
  systemMessages: boolean;
};

export type UserNotificationPreferenceFields = {
  notifyAdvertiserMessages?: boolean | null;
  notifyPublisherMessages?: boolean | null;
  notifyPaymentMessages?: boolean | null;
  notifySystemMessages?: boolean | null;
};

export type NotificationSettingsGroupMetadata = {
  key: NotificationPreferenceGroupKey;
  title: string;
  description: string;
  templateIds: ReadonlyArray<AutoAlertTemplateId>;
};

const EXPECTED_AUTO_ALERT_TEMPLATE_IDS: ReadonlyArray<AutoAlertTemplateId> = [
  'B01',
  'B02',
  'B03',
  'B04',
  'B05',
  'B06',
  'B07',
  'B08',
  'B09',
  'B10',
  'B11',
  'B12',
  'B13',
  'B14',
  'B15',
  'B16',
  'B17',
  'B18',
  'B19',
  'B20',
  'B21',
  'B22',
];

const EXPECTED_AUTO_ALERT_TEMPLATE_SET = new Set(EXPECTED_AUTO_ALERT_TEMPLATE_IDS);

export const NOTIFICATION_SETTINGS_GROUPS: ReadonlyArray<NotificationSettingsGroupMetadata> = [
  {
    key: 'advertiserMessages',
    title: 'Advertiser messages',
    description: 'Brief responses, deal acceptance, and advertiser-side creative updates.',
    templateIds: ['B01', 'B05', 'B07', 'B10', 'B11', 'B17'],
  },
  {
    key: 'publisherMessages',
    title: 'Publisher messages',
    description: 'Application outcomes, new deal requests, and publisher-side creative actions.',
    templateIds: ['B02', 'B03', 'B04', 'B12', 'B13'],
  },
  {
    key: 'paymentMessages',
    title: 'Payment messages',
    description: 'Escrow funding, payouts, refunds, and completed deal payment outcomes.',
    templateIds: ['B09', 'B14', 'B15', 'B16'],
  },
  {
    key: 'systemMessages',
    title: 'System messages',
    description: 'Status changes, cancellations, violations, and timeout-related alerts.',
    templateIds: ['B06', 'B08', 'B18', 'B19', 'B20', 'B21', 'B22'],
  },
];

function buildTemplateToGroupMap(): Record<AutoAlertTemplateId, NotificationPreferenceGroupKey> {
  const map: Partial<Record<AutoAlertTemplateId, NotificationPreferenceGroupKey>> = {};
  const seen = new Set<AutoAlertTemplateId>();

  for (const group of NOTIFICATION_SETTINGS_GROUPS) {
    for (const templateId of group.templateIds) {
      if (!EXPECTED_AUTO_ALERT_TEMPLATE_SET.has(templateId)) {
        throw new Error(`Unsupported auto-alert template id in notification groups: ${templateId}`);
      }

      if (seen.has(templateId)) {
        throw new Error(`Duplicate auto-alert template id in notification groups: ${templateId}`);
      }

      seen.add(templateId);
      map[templateId] = group.key;
    }
  }

  for (const templateId of EXPECTED_AUTO_ALERT_TEMPLATE_IDS) {
    if (!seen.has(templateId)) {
      throw new Error(`Missing auto-alert template id in notification groups: ${templateId}`);
    }
  }

  return map as Record<AutoAlertTemplateId, NotificationPreferenceGroupKey>;
}

export const AUTO_ALERT_TEMPLATE_TO_GROUP = buildTemplateToGroupMap();

export function projectUserNotificationSettings(
  user: UserNotificationPreferenceFields | null | undefined,
): NotificationSettingsDto {
  return {
    advertiserMessages: user?.notifyAdvertiserMessages ?? true,
    publisherMessages: user?.notifyPublisherMessages ?? true,
    paymentMessages: user?.notifyPaymentMessages ?? true,
    systemMessages: user?.notifySystemMessages ?? true,
  };
}

export function normalizeNotificationSettings(
  settings: Partial<NotificationSettingsDto> | null | undefined,
): NotificationSettingsDto {
  return {
    advertiserMessages: settings?.advertiserMessages ?? true,
    publisherMessages: settings?.publisherMessages ?? true,
    paymentMessages: settings?.paymentMessages ?? true,
    systemMessages: settings?.systemMessages ?? true,
  };
}

export function getNotificationGroupForTemplate(
  templateId: string | ChatTemplateId | null | undefined,
): NotificationPreferenceGroupKey | null {
  if (!templateId) {
    return null;
  }

  return AUTO_ALERT_TEMPLATE_TO_GROUP[templateId as AutoAlertTemplateId] ?? null;
}

export function isTemplateDeliveryEnabled(
  settings: Partial<NotificationSettingsDto> | null | undefined,
  templateId: string | ChatTemplateId | null | undefined,
): boolean {
  const group = getNotificationGroupForTemplate(templateId);
  if (!group) {
    // Unknown or missing template ids should never block delivery.
    return true;
  }

  const normalized = normalizeNotificationSettings(settings);
  return normalized[group];
}

export function buildNotificationSettingsCatalog(): Array<NotificationSettingsGroupMetadata> {
  return NOTIFICATION_SETTINGS_GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    description: group.description,
    templateIds: [...group.templateIds],
  }));
}


import { config } from '../../config/index.js';
import { buildChatTemplate, getChatActionLabel, type BuiltChatTemplate, type ChatActionKey, type ChatTemplateId, type ChatTemplateParams } from './catalog.js';

export interface NotificationActionContext {
  dealId?: string;
  briefId?: string;
  channelId?: string;
  fallbackPath?: string;
}

export interface TelegramNotificationPayload {
  template: BuiltChatTemplate;
  text: string;
  parseMode: 'HTML';
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '/';
  }

  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/+/g, '/');
}

function baseMiniAppUrl(): string {
  const raw = config.miniAppBaseUrl.trim();
  const fallback = 'http://localhost:5173';
  const normalized = raw || fallback;
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function buildMiniAppUrl(path: string): string {
  return `${baseMiniAppUrl()}${normalizePath(path)}`;
}

function toStartParam(path: string): string {
  const normalized = normalizePath(path);

  if (normalized === '/') return 'home';
  if (normalized === '/channels') return 'channels';
  if (normalized === '/briefs') return 'briefs';
  if (normalized === '/deals') return 'deals';
  if (normalized === '/profile') return 'profile';
  if (normalized === '/create-listing') return 'create-listing';
  if (normalized === '/create-brief') return 'create-brief';
  if (normalized === '/my-channels') return 'my-channels';
  if (normalized === '/my-briefs') return 'my-briefs';

  const channelSettingsMatch = normalized.match(/^\/channels\/([^/]+)\/settings$/);
  if (channelSettingsMatch) {
    return `channels-${channelSettingsMatch[1]}` + '-settings';
  }

  const briefApplicationsMatch = normalized.match(/^\/briefs\/([^/]+)\/applications$/);
  if (briefApplicationsMatch) {
    return `briefs-${briefApplicationsMatch[1]}` + '-applications';
  }

  const channelDetailMatch = normalized.match(/^\/channels\/([^/]+)$/);
  if (channelDetailMatch) {
    return `channels-${channelDetailMatch[1]}`;
  }

  const briefDetailMatch = normalized.match(/^\/briefs\/([^/]+)$/);
  if (briefDetailMatch) {
    return `briefs-${briefDetailMatch[1]}`;
  }

  const dealDetailMatch = normalized.match(/^\/deals\/([^/]+)$/);
  if (dealDetailMatch) {
    return `deals-${dealDetailMatch[1]}`;
  }

  return encodeURIComponent(normalized);
}

function buildTelegramStartAppUrl(path: string): string {
  const username = config.telegramBotUsername.replace(/^@/, '').trim();
  if (!username) {
    return buildMiniAppUrl(path);
  }

  return `https://t.me/${username}?startapp=${encodeURIComponent(toStartParam(path))}`;
}

function resolveActionPath(actionKey: ChatActionKey, context: NotificationActionContext): string | null {
  switch (actionKey) {
    case 'notifications.actions.open_deal':
    case 'notifications.actions.view_deal':
    case 'notifications.actions.fund_escrow':
    case 'notifications.actions.view_details':
    case 'notifications.actions.view_payout':
    case 'notifications.actions.view_report':
    case 'notifications.actions.review_creative':
    case 'notifications.actions.submit_revision':
    case 'notifications.actions.view_escrow':
    case 'notifications.actions.view_posting_plan':
    case 'notifications.actions.track_verification':
    case 'notifications.actions.view_violation':
    case 'notifications.actions.take_required_action':
    case 'notifications.actions.open_approval':
    case 'notifications.actions.open_feedback':
    case 'notifications.actions.respond_plan':
      return context.dealId ? `/deals/${context.dealId}` : '/deals';
    case 'notifications.actions.view_applications':
      return context.briefId ? `/briefs/${context.briefId}/applications` : '/briefs';
    case 'notifications.actions.open_briefs':
    case 'notifications.actions.browse_briefs':
    case 'notifications.actions.view_brief':
      return '/briefs';
    case 'notifications.actions.open_marketplace':
      return '/';
    case 'notifications.actions.open_channel_setup':
    case 'notifications.actions.open_channel_settings':
    case 'notifications.actions.add_channel':
    case 'notifications.actions.open_settings':
      return context.channelId ? `/channels/${context.channelId}/settings` : '/my-channels';
    case 'notifications.actions.open_deals':
      return '/deals';
    case 'notifications.actions.view_help':
    case 'notifications.actions.contact_support':
    case 'notifications.actions.open_wallet':
    case 'notifications.actions.view_transaction':
    case 'notifications.actions.connect_telegram':
      return '/profile';
    case 'notifications.actions.view_refund':
      return context.dealId ? `/deals/${context.dealId}` : '/deals';
    case 'notifications.actions.retry':
    case 'notifications.actions.clear_filter':
    case 'notifications.actions.clear_filters':
      return context.fallbackPath || '/';
    case 'notifications.actions.create_brief':
      return '/create-brief';
    case 'notifications.actions.create_listing':
      return '/create-listing';
    case 'notifications.actions.view_deadline':
    case 'notifications.actions.resolve_stage':
      return context.dealId ? `/deals/${context.dealId}` : '/deals';
    case 'notifications.actions.confirm':
    case 'notifications.actions.cancel':
    case 'notifications.actions.view_application':
      return context.fallbackPath || '/';
    default:
      return context.fallbackPath || null;
  }
}

function buildActionButton(actionKey: ChatActionKey, context: NotificationActionContext): { text: string; url: string } | null {
  const path = resolveActionPath(actionKey, context);
  if (!path) {
    return null;
  }

  return {
    text: getChatActionLabel(actionKey),
    url: buildTelegramStartAppUrl(path),
  };
}

function buildReplyMarkup(template: BuiltChatTemplate, context: NotificationActionContext): TelegramNotificationPayload['replyMarkup'] {
  const buttons = [
    template.primaryActionKey ? buildActionButton(template.primaryActionKey, context) : null,
    template.secondaryActionKey ? buildActionButton(template.secondaryActionKey, context) : null,
  ].filter((button): button is { text: string; url: string } => Boolean(button));

  if (buttons.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: [buttons],
  };
}

export function buildTemplatedTelegramNotification(
  templateId: ChatTemplateId,
  params: ChatTemplateParams = {},
  context: NotificationActionContext = {},
): TelegramNotificationPayload {
  const template = buildChatTemplate(templateId, params);
  const escapedTitle = escapeHtml(template.title);
  const escapedMessage = escapeHtml(template.message);

  return {
    template,
    text: `<b>${escapedTitle}</b>\n\n${escapedMessage}`,
    parseMode: 'HTML',
    replyMarkup: buildReplyMarkup(template, context),
  };
}

export function buildMiniAppRoute(routePath: string): string {
  return buildMiniAppUrl(routePath);
}

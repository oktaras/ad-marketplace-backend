export type ChatTemplateId = `B${string}`;

export type ChatActionKey =
  | 'notifications.actions.open_deal'
  | 'notifications.actions.retry'
  | 'notifications.actions.view_deal'
  | 'notifications.actions.view_brief'
  | 'notifications.actions.open_wallet'
  | 'notifications.actions.view_posting_plan'
  | 'notifications.actions.view_application'
  | 'notifications.actions.open_settings'
  | 'notifications.actions.clear_filters'
  | 'notifications.actions.clear_filter'
  | 'notifications.actions.create_brief'
  | 'notifications.actions.add_channel'
  | 'notifications.actions.create_listing'
  | 'notifications.actions.view_deadline'
  | 'notifications.actions.resolve_stage'
  | 'notifications.actions.confirm'
  | 'notifications.actions.cancel'
  | 'notifications.actions.connect_telegram'
  | 'notifications.actions.view_escrow'
  | 'notifications.actions.respond_plan'
  | 'notifications.actions.view_applications'
  | 'notifications.actions.open_briefs'
  | 'notifications.actions.browse_briefs'
  | 'notifications.actions.view_feedback'
  | 'notifications.actions.fund_escrow'
  | 'notifications.actions.view_details'
  | 'notifications.actions.contact_support'
  | 'notifications.actions.view_payout'
  | 'notifications.actions.view_report'
  | 'notifications.actions.review_creative'
  | 'notifications.actions.submit_revision'
  | 'notifications.actions.view_transaction'
  | 'notifications.actions.view_refund'
  | 'notifications.actions.track_verification'
  | 'notifications.actions.view_violation'
  | 'notifications.actions.take_required_action'
  | 'notifications.actions.open_marketplace'
  | 'notifications.actions.open_channel_setup'
  | 'notifications.actions.open_deals'
  | 'notifications.actions.view_help'
  | 'notifications.actions.open_channel_settings'
  | 'notifications.actions.open_approval'
  | 'notifications.actions.open_feedback';

export interface ChatTemplateParams {
  briefTitle?: string;
  dealNumber?: number;
  channelTitle?: string;
  statusLabel?: string;
  reason?: string;
  dealChatDeleted?: boolean;
  feedback?: string;
  amount?: string;
  violationLabel?: string;
  hoursRemaining?: number;
  scheduledAt?: Date | string;
  dealSummary?: string;
  verifyExample?: string;
}

export interface BuiltChatTemplate {
  templateId: ChatTemplateId;
  title: string;
  message: string;
  primaryActionKey?: ChatActionKey;
  secondaryActionKey?: ChatActionKey;
}

type ChatTemplateDefinition = {
  title: string;
  message: (params: ChatTemplateParams) => string;
  primaryActionKey?: ChatActionKey;
  secondaryActionKey?: ChatActionKey;
};

export const CHAT_ACTION_LABELS: Record<ChatActionKey, string> = {
  'notifications.actions.open_deal': 'Open Deal',
  'notifications.actions.retry': 'Retry',
  'notifications.actions.view_deal': 'View Deal',
  'notifications.actions.view_brief': 'View Brief',
  'notifications.actions.open_wallet': 'Open Wallet',
  'notifications.actions.view_posting_plan': 'View Posting Plan',
  'notifications.actions.view_application': 'View Application',
  'notifications.actions.open_settings': 'Open Settings',
  'notifications.actions.clear_filters': 'Clear Filters',
  'notifications.actions.clear_filter': 'Clear Filter',
  'notifications.actions.create_brief': 'Create Brief',
  'notifications.actions.add_channel': 'Add Channel',
  'notifications.actions.create_listing': 'Create Listing',
  'notifications.actions.view_deadline': 'View Deadline',
  'notifications.actions.resolve_stage': 'Resolve Stage',
  'notifications.actions.confirm': 'Confirm',
  'notifications.actions.cancel': 'Cancel',
  'notifications.actions.connect_telegram': 'Connect Telegram',
  'notifications.actions.view_escrow': 'View Escrow',
  'notifications.actions.respond_plan': 'Respond Plan',
  'notifications.actions.view_applications': 'View Applications',
  'notifications.actions.open_briefs': 'Open Briefs',
  'notifications.actions.browse_briefs': 'Browse Briefs',
  'notifications.actions.view_feedback': 'View Feedback',
  'notifications.actions.fund_escrow': 'Fund Escrow',
  'notifications.actions.view_details': 'View Details',
  'notifications.actions.contact_support': 'Contact Support',
  'notifications.actions.view_payout': 'View Payout',
  'notifications.actions.view_report': 'View Report',
  'notifications.actions.review_creative': 'Review Creative',
  'notifications.actions.submit_revision': 'Submit Revision',
  'notifications.actions.view_transaction': 'View Transaction',
  'notifications.actions.view_refund': 'View Refund',
  'notifications.actions.track_verification': 'Track Verification',
  'notifications.actions.view_violation': 'View Violation',
  'notifications.actions.take_required_action': 'Take Required Action',
  'notifications.actions.open_marketplace': 'Open Marketplace',
  'notifications.actions.open_channel_setup': 'Open Channel Setup',
  'notifications.actions.open_deals': 'Open Deals',
  'notifications.actions.view_help': 'View Help',
  'notifications.actions.open_channel_settings': 'Open Channel Settings',
  'notifications.actions.open_approval': 'Open Approval',
  'notifications.actions.open_feedback': 'Open Feedback',
};

function formatScheduledAt(value?: Date | string): string {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString();
}

const CHAT_TEMPLATE_DEFINITIONS: Record<ChatTemplateId, ChatTemplateDefinition> = {
  B01: {
    title: 'New brief application',
    message: ({ briefTitle }) => briefTitle
      ? `Someone applied to your brief "${briefTitle}". Review and respond in the app.`
      : 'Someone applied to your brief. Review and respond in the app.',
    primaryActionKey: 'notifications.actions.view_applications',
    secondaryActionKey: 'notifications.actions.open_briefs',
  },
  B02: {
    title: 'Application accepted',
    message: ({ briefTitle, dealNumber }) => {
      const details = typeof dealNumber === 'number' ? ` Deal #${dealNumber} was created.` : '';
      return briefTitle
        ? `Your application for "${briefTitle}" was accepted.${details}`
        : `Your application was accepted and a deal was created.${details}`;
    },
    primaryActionKey: 'notifications.actions.view_deal',
  },
  B03: {
    title: 'Application not selected',
    message: ({ reason }) => reason
      ? `This brief selected another channel. Reason: ${reason}. Review feedback and apply elsewhere.`
      : 'This brief selected another channel. Review feedback and apply elsewhere.',
    primaryActionKey: 'notifications.actions.browse_briefs',
    secondaryActionKey: 'notifications.actions.view_feedback',
  },
  B04: {
    title: 'New deal request',
    message: ({ channelTitle }) => channelTitle
      ? `A new deal request for ${channelTitle} is waiting for your review.`
      : 'A new deal request is waiting for your review.',
    primaryActionKey: 'notifications.actions.open_deal',
  },
  B05: {
    title: 'Deal created',
    message: ({ channelTitle }) => channelTitle
      ? `Your deal request for ${channelTitle} was created successfully.`
      : 'Your deal request was created successfully.',
    primaryActionKey: 'notifications.actions.open_deal',
  },
  B06: {
    title: 'Deal status updated',
    message: ({ statusLabel, dealChatDeleted }) => {
      const base = statusLabel
        ? `Deal status changed to ${statusLabel}. Open deal details for the next step.`
        : 'Deal status changed. Open deal details for the next step.';

      if (!dealChatDeleted) {
        return base;
      }

      return `${base} Deal-related chat topics were deleted, and message history is no longer available.`;
    },
    primaryActionKey: 'notifications.actions.open_deal',
  },
  B07: {
    title: 'Deal accepted',
    message: () => 'Terms accepted. Fund escrow to continue workflow.',
    primaryActionKey: 'notifications.actions.fund_escrow',
  },
  B08: {
    title: 'Deal cancelled',
    message: ({ reason, dealChatDeleted }) => {
      const base = reason
        ? `The deal was cancelled. Reason: ${reason}. Open details to review impact.`
        : 'The deal was cancelled. Open details to review reason and impact.';

      if (!dealChatDeleted) {
        return base;
      }

      return `${base} Deal-related chat topics were deleted, and message history is no longer available.`;
    },
    primaryActionKey: 'notifications.actions.view_details',
    secondaryActionKey: 'notifications.actions.contact_support',
  },
  B09: {
    title: 'Deal completed',
    message: () => 'Deal is complete and payout is released.',
    primaryActionKey: 'notifications.actions.view_payout',
  },
  B10: {
    title: 'Deal completed',
    message: () => 'Deal is complete. View final execution details.',
    primaryActionKey: 'notifications.actions.view_report',
  },
  B11: {
    title: 'Creative ready for review',
    message: () => 'Creative was submitted and is waiting for your decision.',
    primaryActionKey: 'notifications.actions.review_creative',
  },
  B12: {
    title: 'Creative approved',
    message: ({ scheduledAt }) => {
      const formatted = formatScheduledAt(scheduledAt);
      return formatted
        ? `Creative was approved. Posting plan is scheduled for ${formatted}.`
        : 'Creative was approved. Check the posting plan schedule.';
    },
    primaryActionKey: 'notifications.actions.view_posting_plan',
  },
  B13: {
    title: 'Revision requested',
    message: ({ feedback }) => feedback
      ? `Creative needs changes. Feedback: ${feedback}`
      : 'Creative needs changes. Open feedback and submit a revision.',
    primaryActionKey: 'notifications.actions.submit_revision',
    secondaryActionKey: 'notifications.actions.view_feedback',
  },
  B14: {
    title: 'Escrow funded',
    message: ({ amount }) => amount
      ? `Escrow payment of ${amount} TON was received successfully.`
      : 'Escrow payment was received successfully.',
    primaryActionKey: 'notifications.actions.view_escrow',
  },
  B15: {
    title: 'Payout released',
    message: ({ amount }) => amount
      ? `Funds were released to your wallet. Amount: ${amount} TON.`
      : 'Funds were released to your wallet.',
    primaryActionKey: 'notifications.actions.open_wallet',
    secondaryActionKey: 'notifications.actions.view_transaction',
  },
  B16: {
    title: 'Refund issued',
    message: ({ amount, reason }) => {
      const amountLine = amount ? ` Amount: ${amount} TON.` : '';
      const reasonLine = reason ? ` Reason: ${reason}.` : '';
      return `A refund was processed.${amountLine}${reasonLine}`.trim();
    },
    primaryActionKey: 'notifications.actions.view_refund',
  },
  B17: {
    title: 'Post published',
    message: () => 'Your post is live and verification is running.',
    primaryActionKey: 'notifications.actions.track_verification',
  },
  B18: {
    title: 'Post violation detected',
    message: ({ violationLabel }) => violationLabel
      ? `A posting violation was detected (${violationLabel}). Open details to review resolution.`
      : 'A posting violation was detected. Open details to review resolution.',
    primaryActionKey: 'notifications.actions.view_violation',
  },
  B19: {
    title: 'Post violation detected',
    message: ({ violationLabel }) => violationLabel
      ? `A posting violation (${violationLabel}) affected your campaign. Check refund status.`
      : 'A posting violation affected your campaign. Check refund status.',
    primaryActionKey: 'notifications.actions.view_refund',
    secondaryActionKey: 'notifications.actions.view_violation',
  },
  B20: {
    title: 'Deal expiring soon',
    message: ({ hoursRemaining }) => typeof hoursRemaining === 'number'
      ? `Deal will expire in ${hoursRemaining} hours due to inactivity. Complete required action now.`
      : 'Deal will expire due to inactivity. Complete required action now.',
    primaryActionKey: 'notifications.actions.take_required_action',
  },
  B21: {
    title: 'Deal expired',
    message: () => 'The deal expired due to inactivity. Review next steps.',
    primaryActionKey: 'notifications.actions.view_details',
  },
  B22: {
    title: 'Deal expired',
    message: () => 'The deal expired and refund processing may apply.',
    primaryActionKey: 'notifications.actions.view_refund',
    secondaryActionKey: 'notifications.actions.view_details',
  },
  B23: {
    title: 'Welcome',
    message: () => 'Open marketplace to start using Ads Marketplace.',
    primaryActionKey: 'notifications.actions.open_marketplace',
  },
  B24: {
    title: 'Deal management',
    message: () => 'Use the app to track deal status and actions.',
    primaryActionKey: 'notifications.actions.open_deal',
  },
  B25: {
    title: 'Channel registration',
    message: () => 'Finish channel setup and verify permissions in app.',
    primaryActionKey: 'notifications.actions.open_channel_setup',
  },
  B26: {
    title: 'No active deal selected',
    message: () => 'Select a deal to view status updates.',
    primaryActionKey: 'notifications.actions.open_deals',
  },
  B27: {
    title: 'Deal not found',
    message: () => 'This deal is unavailable or inaccessible.',
    primaryActionKey: 'notifications.actions.open_deals',
  },
  B28: {
    title: 'Deal status',
    message: ({ dealSummary }) => dealSummary
      ? dealSummary
      : 'Current deal summary with amount, status, and next step.',
    primaryActionKey: 'notifications.actions.view_deal',
  },
  B29: {
    title: 'Verify command format',
    message: ({ verifyExample }) => verifyExample
      ? `Use ${verifyExample} to continue verification.`
      : 'Use /verify <channel_id> to continue verification.',
    primaryActionKey: 'notifications.actions.view_help',
  },
  B30: {
    title: 'Checking permissions',
    message: () => 'Validating bot permissions in your channel.',
  },
  B31: {
    title: 'Channel verified',
    message: () => 'Channel verification succeeded. Continue in settings.',
    primaryActionKey: 'notifications.actions.open_channel_settings',
  },
  B32: {
    title: 'Opening approval flow',
    message: () => 'Opening creative approval flow.',
    primaryActionKey: 'notifications.actions.open_approval',
  },
  B33: {
    title: 'Opening feedback flow',
    message: () => 'Opening creative feedback submission flow.',
    primaryActionKey: 'notifications.actions.open_feedback',
  },
};

export function buildExpectedNotificationIds(prefix: 'A' | 'B', count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
}

export const IN_CHAT_NOTIFICATION_IDS = buildExpectedNotificationIds('B', 33);

export function buildChatTemplate(templateId: ChatTemplateId, params: ChatTemplateParams = {}): BuiltChatTemplate {
  const template = CHAT_TEMPLATE_DEFINITIONS[templateId];
  if (!template) {
    throw new Error(`Unknown chat notification template: ${templateId}`);
  }

  return {
    templateId,
    title: template.title,
    message: template.message(params),
    primaryActionKey: template.primaryActionKey,
    secondaryActionKey: template.secondaryActionKey,
  };
}

export function getChatActionLabel(actionKey: ChatActionKey): string {
  return CHAT_ACTION_LABELS[actionKey];
}

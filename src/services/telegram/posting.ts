import { bot } from './bot.js';
import { prisma } from '../../lib/prisma.js';
import { InputFile } from 'grammy';
import { appEvents, AppEvent } from '../events.js';
import { verifyAdminBeforeOperation } from './verification.js';
import { dealService } from '../deal/index.js';

export interface PostContent {
  text?: string;
  caption?: string;
  mediaUrl?: string;
  mediaType?: 'photo' | 'video' | 'document' | 'animation' | 'audio';
  buttons?: Array<{ text: string; url: string }>;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}

type TelegramMediaInput = InputFile | string;

function inferMediaTypeFromUrl(url?: string): PostContent['mediaType'] | undefined {
  if (!url) return undefined;
  const clean = url.split('?')[0]?.toLowerCase() || '';
  if (/\.(png|jpe?g|webp|bmp|svg)$/i.test(clean)) return 'photo';
  if (/\.(gif)$/i.test(clean)) return 'animation';
  if (/\.(mp4|mov|webm|mkv)$/i.test(clean)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|aac)$/i.test(clean)) return 'audio';
  if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|txt)$/i.test(clean)) return 'document';
  return undefined;
}

function normalizeMediaType(
  rawType?: string | null,
  mediaUrl?: string,
): PostContent['mediaType'] | undefined {
  if (rawType) {
    const type = rawType.toLowerCase();
    if (type === 'photo' || type === 'image') return 'photo';
    if (type === 'video') return 'video';
    if (type === 'document' || type === 'file') return 'document';
    if (type === 'gif' || type === 'animation') return 'animation';
    if (type === 'audio' || type === 'voice') return 'audio';
  }

  // Fallback for cases where media type is missing/inconsistent.
  return inferMediaTypeFromUrl(mediaUrl) || 'document';
}

function buildInlineKeyboard(buttons?: PostContent['buttons']) {
  if (!buttons || buttons.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: [buttons.map((button) => ({ text: button.text, url: button.url }))],
  };
}

function resolveMediaInput(mediaUrl?: string): TelegramMediaInput | undefined {
  const normalized = mediaUrl?.trim();
  if (!normalized) {
    return undefined;
  }

  try {
    const url = new URL(normalized);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return new InputFile(url);
    }
    return undefined;
  } catch {
    // Allow Telegram file_id references (no protocol, opaque token).
    if (/^[A-Za-z0-9_-]{20,}$/.test(normalized)) {
      return normalized;
    }
    return undefined;
  }
}

async function sendContentToChat(
  chatId: string,
  content: PostContent,
): Promise<number> {
  const parseMode = content.parseMode || 'HTML';
  const replyMarkup = buildInlineKeyboard(content.buttons);
  const mediaInput = resolveMediaInput(content.mediaUrl);

  if (content.mediaUrl && content.mediaType && mediaInput) {
    if (content.mediaType === 'photo') {
      const message = await bot.api.sendPhoto(chatId, mediaInput, {
        caption: content.caption,
        parse_mode: parseMode,
        reply_markup: replyMarkup,
      });
      return message.message_id;
    }

    if (content.mediaType === 'video') {
      const message = await bot.api.sendVideo(chatId, mediaInput, {
        caption: content.caption,
        parse_mode: parseMode,
        reply_markup: replyMarkup,
      });
      return message.message_id;
    }

    if (content.mediaType === 'animation') {
      const message = await bot.api.sendAnimation(chatId, mediaInput, {
        caption: content.caption,
        parse_mode: parseMode,
        reply_markup: replyMarkup,
      });
      return message.message_id;
    }

    if (content.mediaType === 'audio') {
      const message = await bot.api.sendAudio(chatId, mediaInput, {
        caption: content.caption,
        parse_mode: parseMode,
        reply_markup: replyMarkup,
      });
      return message.message_id;
    }

    if (content.mediaType === 'document') {
      const message = await bot.api.sendDocument(chatId, mediaInput, {
        caption: content.caption,
        parse_mode: parseMode,
        reply_markup: replyMarkup,
      });
      return message.message_id;
    }

    throw new Error(`Unsupported media type: ${content.mediaType}`);
  }

  if (content.mediaUrl && content.mediaType && !mediaInput) {
    console.warn(
      `Unsupported media URL for Telegram upload. Falling back to text-only post. url="${content.mediaUrl}"`,
    );
  }

  const textContent = content.text || content.caption;
  if (!textContent || textContent.trim().length === 0) {
    throw new Error('No text content available for posting');
  }

  const message = await bot.api.sendMessage(chatId, textContent, {
    parse_mode: parseMode,
    reply_markup: replyMarkup,
  });

  return message.message_id;
}

/**
 * Verify bot has permission to post in channel before posting
 */
async function verifyBotCanPost(channelId: string): Promise<void> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
  });

  if (!channel) {
    throw new Error('Channel not found');
  }

  try {
    const botInfo = await bot.api.getMe();
    const botMember = await bot.api.getChatMember(
      channel.telegramChatId.toString(),
      botInfo.id
    );
    
    const canPost = botMember.status === 'administrator' && 
                    ('can_post_messages' in botMember && botMember.can_post_messages === true);
    
    if (!canPost) {
      // Update channel status
      await prisma.channel.update({
        where: { id: channelId },
        data: { status: 'SUSPENDED' },
      });
      
      throw new Error('Bot no longer has permission to post in this channel');
    }
  } catch (error: any) {
    await prisma.channel.update({
      where: { id: channelId },
      data: { status: 'SUSPENDED' },
    });
    
    throw new Error(`Cannot access channel. Bot may have been removed: ${error.message}`);
  }
}

/**
 * Post content to a Telegram channel with permission verification
 */
export async function postToChannelWithVerification(
  channelId: string,
  content: PostContent,
): Promise<{ messageId: bigint; postedAt: Date }> {
  // Verify permissions before posting
  await verifyBotCanPost(channelId);

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
  });

  if (!channel) {
    throw new Error('Channel not found');
  }

  try {
    const chatId = channel.telegramChatId.toString();
    const messageId = await sendContentToChat(chatId, content);

    return {
      messageId: BigInt(messageId),
      postedAt: new Date(),
    };
  } catch (error: any) {
    throw new Error(`Failed to post: ${error.message}`);
  }
}

/**
 * Post content to a Telegram channel (legacy - no verification)
 */
export async function postToChannel(
  channelUsername: string,
  content: PostContent,
): Promise<{ messageId: number; channelId: string }> {
  try {
    const chatId = channelUsername.startsWith('@')
      ? channelUsername
      : `@${channelUsername}`;

    const messageId = await sendContentToChat(chatId, content);

    // Get chat info to extract channel ID
    const chat = await bot.api.getChat(chatId);

    return {
      messageId,
      channelId: chat.id.toString(),
    };
  } catch (error: any) {
    console.error('Error posting to channel:', error);

    if (error.error_code === 400) {
      throw new Error('Invalid channel or bot lacks permissions');
    }

    if (error.error_code === 403) {
      throw new Error('Bot is not an administrator or lacks post permission');
    }

    throw error;
  }
}

/**
 * Publish a deal's creative to the channel
 */
export async function publishDealCreative(dealId: string, creativeId: string): Promise<void> {
  // Get deal and creative details
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      channel: true,
      creative: {
        where: { id: creativeId },
      },
    },
  });

  if (!deal) {
    throw new Error('Deal not found');
  }

  // Idempotency check: if already posted, skip
  if (deal.postedMessageId) {
    console.log(`⏭️ Deal ${dealId} already posted (messageId: ${deal.postedMessageId}), skipping`);
    return;
  }

  if (!deal.creative) {
    throw new Error('Creative not found');
  }

  const creative = deal.creative;

  if (creative.status !== 'APPROVED') {
    throw new Error('Creative is not approved');
  }

  // Verify bot has admin permissions before posting
  await verifyAdminBeforeOperation(deal.channelId);

  try {
    // Prepare post content
    const postContent: PostContent = {
      text: creative.text || undefined,
      caption: creative.text || undefined,
      mediaUrl: creative.mediaUrls[0] || undefined,
      mediaType: normalizeMediaType(creative.mediaTypes[0], creative.mediaUrls[0]),
      buttons: creative.buttons ? (creative.buttons as Array<{ text: string; url: string }>) : undefined,
      parseMode: 'HTML',
    };

    const channelUsername = deal.channel.username;
    if (!channelUsername) {
      throw new Error('Channel username is missing');
    }
    // Post to channel
    const result = await postToChannel(channelUsername, postContent);

    // Persist post metadata first.
    await prisma.deal.update({
      where: { id: dealId },
      data: {
        postedMessageId: result.messageId,
        postedAt: new Date(),
      },
    });

    await dealService.updateStatus(dealId, 'POSTED', 'SYSTEM', {
      messageId: result.messageId,
      channelId: deal.channelId,
    });

    // Emit post published event
    appEvents.emit(AppEvent.POST_PUBLISHED, {
      dealId,
      messageId: result.messageId,
      channelId: deal.channelId, // Use database channel ID, not Telegram chat ID
    });

    console.log(`✅ Posted creative for deal ${dealId}, message ID: ${result.messageId}`);
  } catch (error) {
    console.error(`Failed to post creative for deal ${dealId}:`, error);
    // Propagate the failure to the job processor; it decides whether this
    // is a retryable failure or a final failure requiring cancellation.
    throw error;
  }
}

/**
 * Edit a posted message
 */
export async function editChannelPost(
  channelUsername: string,
  messageId: number,
  content: PostContent,
): Promise<void> {
  try {
    const chatId = channelUsername.startsWith('@')
      ? channelUsername
      : `@${channelUsername}`;

    const parseMode = content.parseMode || 'HTML';

    if (content.text) {
      const keyboard = content.buttons
        ? {
            inline_keyboard: [
              content.buttons.map((btn) => ({
                text: btn.text,
                url: btn.url,
              })),
            ],
          }
        : undefined;

      await bot.api.editMessageText(chatId, messageId, content.text, {
        parse_mode: parseMode,
        reply_markup: keyboard,
      });
    } else if (content.caption) {
      await bot.api.editMessageCaption(chatId, messageId, {
        caption: content.caption,
        parse_mode: parseMode,
      });
    }
  } catch (error: any) {
    console.error('Error editing channel post:', error);
    throw error;
  }
}

/**
 * Delete a posted message
 */
export async function deleteChannelPost(
  channelUsername: string,
  messageId: number,
): Promise<void> {
  try {
    const chatId = channelUsername.startsWith('@')
      ? channelUsername
      : `@${channelUsername}`;

    await bot.api.deleteMessage(chatId, messageId);
  } catch (error: any) {
    console.error('Error deleting channel post:', error);

    if (error.error_code === 400 && error.description?.includes('message to delete not found')) {
      // Message already deleted, not an error
      return;
    }

    throw error;
  }
}

/**
 * Check if a post still exists and hasn't been edited
 */
export async function checkPostExists(
  channelUsername: string,
  messageId: number,
): Promise<{ exists: boolean; editDate?: Date }> {
  try {
    const chatId = channelUsername.startsWith('@')
      ? channelUsername
      : `@${channelUsername}`;

    // Try to get message (this is tricky with Bot API, may need workarounds)
    // Bot API doesn't have a direct "getMessage" method
    // One workaround: try to forward the message to a test channel
    // For now, we'll return a basic check

    // TODO: Implement proper message existence check
    // This may require using MTProto or forwarding to a test chat
    
    return { exists: true };
  } catch (error: any) {
    console.error('Error checking post existence:', error);
    
    if (error.error_code === 400) {
      return { exists: false };
    }

    throw error;
  }
}

/**
 * Schedule a post for later
 * Note: Telegram Bot API doesn't support scheduled posts directly
 * We'll use the job queue to handle scheduling
 */
export function schedulePost(dealId: string, scheduledTime: Date): void {
  // This will be handled by the job queue
  // See jobs/processors.ts for implementation
  console.log(`Post scheduled for deal ${dealId} at ${scheduledTime}`);
}

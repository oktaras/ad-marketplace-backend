import 'dotenv/config';
import { config } from '../config/index.js';
import { telegramBot } from '../services/telegram/bot.js';

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, stopping Telegram bot worker...`);
  try {
    telegramBot.bot.stop();
  } catch (error) {
    console.error('Failed to stop Telegram bot gracefully:', error);
  }
  process.exit(0);
}

function main(): void {
  if (!config.telegramBotToken) {
    console.error('TELEGRAM_BOT_TOKEN is not set. Bot worker is disabled.');
    process.exit(1);
    return;
  }

  // IMPORTANT: run exactly one bot worker instance to avoid duplicate
  // update consumption in long polling mode.
  console.log('Starting Telegram bot long-polling worker...');
  telegramBot.startBot();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main();

import 'dotenv/config';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { setupEventListeners } from '../services/listeners.js';
import { jobQueue, setupRecurringJobs, logQueueStatus } from '../services/jobs/index.js';
import { registerJobProcessors } from '../services/jobs/processors.js';
import { telegramBot } from '../services/telegram/bot.js';

let workerRuntimeInitialized = false;
let queueStatusInterval: NodeJS.Timeout | null = null;

export async function initializeWorkerRuntime(): Promise<void> {
  if (workerRuntimeInitialized) {
    return;
  }

  console.log('🔧 Initializing worker runtime...');

  setupEventListeners();
  registerJobProcessors();
  await setupRecurringJobs();

  queueStatusInterval = setInterval(() => {
    void logQueueStatus();
  }, 5 * 60 * 1000);

  telegramBot.startBot();
  workerRuntimeInitialized = true;

  console.log('✅ Worker runtime initialized');
}

export async function shutdownWorkerRuntime(): Promise<void> {
  if (queueStatusInterval) {
    clearInterval(queueStatusInterval);
    queueStatusInterval = null;
  }

  await jobQueue.shutdown();
  await prisma.$disconnect();

  try {
    await redis.quit();
  } catch (error) {
    console.warn('⚠️ Failed to close Redis cleanly:', error);
  }

  workerRuntimeInitialized = false;
}

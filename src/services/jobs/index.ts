import { Queue, Worker, QueueEvents, Job, type JobsOptions } from 'bullmq';
import { redis } from '../../lib/redis.js';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';

export enum JobType {
  // Stats refresh
  REFRESH_CHANNEL_STATS = 'refresh_channel_stats',
  REFRESH_ALL_STATS = 'refresh_all_stats',
  
  // Auto-posting
  SCHEDULE_POST = 'schedule_post',
  PUBLISH_POST = 'publish_post',
  
  // Post verification
  VERIFY_POST = 'verify_post',
  MONITOR_POST = 'monitor_post',
  
  // Deal management
  CHECK_DEAL_TIMEOUTS = 'check_deal_timeouts',
  SEND_TIMEOUT_WARNING = 'send_timeout_warning',
  EXPIRE_DEAL = 'expire_deal',
  
  // Channel verification
  VERIFY_CHANNEL_ADMIN = 'verify_channel_admin',
  RECHECK_ALL_ADMIN_STATUS = 'recheck_all_admin_status',
}

export interface JobData {
  [JobType.REFRESH_CHANNEL_STATS]: { channelId: string };
  [JobType.REFRESH_ALL_STATS]: {};
  [JobType.SCHEDULE_POST]: { dealId: string; scheduledTime: Date };
  [JobType.PUBLISH_POST]: { dealId: string; creativeId: string };
  [JobType.VERIFY_POST]: { dealId: string; messageId: number; channelId: string };
  [JobType.MONITOR_POST]: { dealId: string; messageId: number; channelId: string; verificationEndTime: Date };
  [JobType.CHECK_DEAL_TIMEOUTS]: {};
  [JobType.SEND_TIMEOUT_WARNING]: { dealId: string };
  [JobType.EXPIRE_DEAL]: { dealId: string };
  [JobType.VERIFY_CHANNEL_ADMIN]: { channelId: string };
  [JobType.RECHECK_ALL_ADMIN_STATUS]: {};
}

class JobQueue {
  private queues: Map<JobType, Queue> = new Map();
  private workers: Map<JobType, Worker> = new Map();
  private queueEvents: Map<JobType, QueueEvents> = new Map();

  constructor() {
    // Initialize queues for each job type
    Object.values(JobType).forEach((jobType) => {
      const queue = new Queue(jobType, {
        connection: redis as any,
        defaultJobOptions: {
          removeOnComplete: { count: 100, age: 24 * 3600 }, // Keep last 100 jobs for 24h
          removeOnFail: { count: 1000, age: 7 * 24 * 3600 }, // Keep failed jobs for 7 days
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000, // 5s, 10s, 20s
          },
        },
      });

      this.queues.set(jobType, queue);

      // Setup queue events for logging
      const events = new QueueEvents(jobType, { connection: redis as any });
      this.queueEvents.set(jobType, events);

      events.on('completed', ({ jobId }) => {
        console.log(`✅ Job ${jobType}:${jobId} completed`);
      });

      events.on('failed', ({ jobId, failedReason }) => {
        console.error(`❌ Job ${jobType}:${jobId} failed:`, failedReason);
      });
    });
  }

  /**
   * Add a job to the queue
   */
  async addJob<T extends JobType>(
    jobType: T,
    data: JobData[T],
    options?: Pick<JobsOptions, 'delay' | 'priority' | 'jobId' | 'repeat' | 'attempts' | 'backoff'>,
  ): Promise<Job<JobData[T]>> {
    const queue = this.queues.get(jobType);
    if (!queue) {
      throw new Error(`Queue not found for job type: ${jobType}`);
    }

    return await queue.add(jobType, data, options);
  }

  /**
   * Register a worker to process jobs
   */
  registerWorker<T extends JobType>(
    jobType: T,
    processor: (job: Job<JobData[T]>) => Promise<void>,
  ): Worker<JobData[T]> {
    // Close existing worker if any
    const existingWorker = this.workers.get(jobType);
    if (existingWorker) {
      existingWorker.close();
    }

    const worker = new Worker<JobData[T]>(
      jobType,
      async (job) => {
        console.log(`⚙️  Processing job ${jobType}:${job.id}`);
        try {
          await processor(job);
        } catch (error) {
          console.error(`Error processing job ${jobType}:${job.id}:`, error);
          throw error;
        }
      },
      {
        connection: redis as any,
        concurrency: jobType.includes('post') ? 2 : 5, // Limit posting jobs
      },
    );

    worker.on('error', (error) => {
      console.error(`Worker error for ${jobType}:`, error);
    });

    this.workers.set(jobType, worker);
    return worker;
  }

  /**
   * Get queue for manual operations
   */
  getQueue<T extends JobType>(jobType: T): Queue<JobData[T]> | undefined {
    return this.queues.get(jobType) as Queue<JobData[T]> | undefined;
  }

  /**
   * Remove repeatable job
   */
  async removeRepeatableJob(jobType: JobType, repeatJobKey: string): Promise<void> {
    const queue = this.queues.get(jobType);
    if (queue) {
      await queue.removeRepeatableByKey(repeatJobKey);
    }
  }

  /**
   * Get job counts
   */
  async getJobCounts(jobType: JobType) {
    const queue = this.queues.get(jobType);
    if (!queue) return null;

    return await queue.getJobCounts();
  }

  /**
   * Pause queue
   */
  async pauseQueue(jobType: JobType): Promise<void> {
    const queue = this.queues.get(jobType);
    if (queue) {
      await queue.pause();
    }
  }

  /**
   * Resume queue
   */
  async resumeQueue(jobType: JobType): Promise<void> {
    const queue = this.queues.get(jobType);
    if (queue) {
      await queue.resume();
    }
  }

  /**
   * Clean old jobs
   */
  async cleanQueue(
    jobType: JobType,
    grace: number = 24 * 3600 * 1000, // 24 hours
    limit: number = 1000,
    status: 'completed' | 'failed' = 'completed',
  ): Promise<string[]> {
    const queue = this.queues.get(jobType);
    if (!queue) return [];

    return await queue.clean(grace, limit, status);
  }

  /**
   * Obliterate queue (delete all jobs)
   */
  async obliterateQueue(jobType: JobType): Promise<void> {
    const queue = this.queues.get(jobType);
    if (queue) {
      await queue.obliterate({ force: true });
    }
  }

  /**
   * Close all queues and workers
   */
  async shutdown(): Promise<void> {
    console.log('Shutting down job queues...');

    // Close all workers first
    const workerPromises = Array.from(this.workers.values()).map((worker) =>
      worker.close(),
    );
    await Promise.all(workerPromises);

    // Close all queue events
    const eventPromises = Array.from(this.queueEvents.values()).map((events) =>
      events.close(),
    );
    await Promise.all(eventPromises);

    // Close all queues
    const queuePromises = Array.from(this.queues.values()).map((queue) =>
      queue.close(),
    );
    await Promise.all(queuePromises);

    console.log('All job queues shut down');
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    queues: Record<string, { waiting: number; active: number; completed: number; failed: number }>;
  }> {
    const queues: Record<string, any> = {};

    for (const [jobType, queue] of this.queues.entries()) {
      try {
        const counts = await queue.getJobCounts();
        queues[jobType] = counts;
      } catch (error) {
        queues[jobType] = { error: 'Failed to get counts' };
      }
    }

    const healthy = Object.values(queues).every((q) => !q.error);

    return { healthy, queues };
  }
}

// Singleton instance
export const jobQueue = new JobQueue();

/**
 * Helper function to schedule recurring jobs
 */
export async function setupRecurringJobs() {
  console.log('Setting up recurring jobs...');

  const isCronPatternValid = (value: string): boolean => value.trim().split(/\s+/).length === 5;
  const refreshCron = isCronPatternValid(config.analyticsRefresh.cron)
    ? config.analyticsRefresh.cron
    : '0 3 * * *';
  const refreshTimezone = config.analyticsRefresh.timezone || 'UTC';

  if (!isCronPatternValid(config.analyticsRefresh.cron)) {
    console.warn(
      `Invalid ANALYTICS_REFRESH_CRON="${config.analyticsRefresh.cron}". Falling back to "${refreshCron}".`,
    );
  }

  if (config.analyticsRefresh.enabled) {
    await jobQueue.addJob(
      JobType.REFRESH_ALL_STATS,
      {},
      {
        repeat: {
          pattern: refreshCron,
          tz: refreshTimezone,
        },
        jobId: 'recurring-refresh-all-stats',
      },
    );
    console.log(
      `Recurring analytics refresh scheduled: "${refreshCron}" (${refreshTimezone})`,
    );
  } else {
    console.log('Recurring analytics refresh is disabled by ANALYTICS_REFRESH_ENABLED');
  }

  // Check deal timeouts every hour
  await jobQueue.addJob(
    JobType.CHECK_DEAL_TIMEOUTS,
    {},
    {
      repeat: {
        pattern: '0 * * * *', // Every hour
      },
      jobId: 'recurring-check-timeouts',
    },
  );

  // Recheck all channel admin status daily at 4 AM
  await jobQueue.addJob(
    JobType.RECHECK_ALL_ADMIN_STATUS,
    {},
    {
      repeat: {
        pattern: '0 4 * * *', // Daily at 4 AM
      },
      jobId: 'recurring-check-admin-status',
    },
  );

  console.log('Recurring jobs scheduled');
}

/**
 * Log job queue status periodically
 */
export async function logQueueStatus() {
  const health = await jobQueue.healthCheck();
  console.log('📊 Job Queue Status:', JSON.stringify(health, null, 2));
}

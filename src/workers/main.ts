import 'dotenv/config';
import { config } from '../config/index.js';
import { initializeWorkerRuntime, shutdownWorkerRuntime } from '../bootstrap/worker-runtime.js';

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, stopping worker runtime...`);

  try {
    await shutdownWorkerRuntime();
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to shutdown worker runtime cleanly:', error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('🚀 Starting unified worker process...');
  console.log(`📊 Environment: ${config.nodeEnv}`);
  console.log(`🌐 TON Network: ${config.tonNetwork}`);

  await initializeWorkerRuntime();
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

main().catch((error) => {
  console.error('❌ Worker runtime failed to start:', error);
  process.exit(1);
});

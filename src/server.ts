import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';

import app from './app.js';
import { config } from './config/index.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { jobQueue } from './services/jobs/index.js';
import { initializeApiRuntime } from './bootstrap/api-runtime.js';

type NetServer = HttpServer | HttpsServer;

let server: NetServer | null = null;
let shuttingDown = false;

function printStartupLogs(protocol: 'http' | 'https', port: number): void {
  console.log(
    protocol === 'https'
      ? `🔒 HTTPS Server running on https://localhost:${port}`
      : `🚀 Server running on http://localhost:${port}`,
  );
  console.log(`📊 Environment: ${config.nodeEnv}`);
  console.log(`🌐 TON Network: ${config.tonNetwork}`);
  console.log(`📚 API Docs: ${protocol}://localhost:${port}/api-docs`);
}

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down API runtime...`);

  try {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }

      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await jobQueue.shutdown();
    await prisma.$disconnect();

    try {
      await redis.quit();
    } catch (error) {
      console.warn('⚠️ Failed to close Redis cleanly:', error);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to shutdown API runtime cleanly:', error);
    process.exit(1);
  }
}

function startServer(): void {
  initializeApiRuntime();

  const port = config.port;
  const isDev = config.nodeEnv === 'development';

  // Get directory path (ESM compatible)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const certPath = path.join(__dirname, '../certs/localhost+2.pem');
  const keyPath = path.join(__dirname, '../certs/localhost+2-key.pem');

  if (isDev && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const httpsOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };

    const httpsServer = https.createServer(httpsOptions, app);
    server = httpsServer;
    httpsServer.listen(port, () => {
      printStartupLogs('https', port);
    });
    return;
  }

  server = app.listen(port, () => {
    printStartupLogs('http', port);
  });
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

startServer();

import express from 'express';
import { createServer } from 'node:http';
import next from 'next';
import Redis from 'ioredis';
import { RedisGameStore } from './src/server/game-store.js';
import { attachGameSocketServer } from './src/server/socket-server.js';

const dev = process.env.NODE_ENV !== 'production';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOSTNAME || '0.0.0.0';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const nextApp = next({ dev, hostname, port });
const handle = nextApp.getRequestHandler();
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });

redis.on('error', (error) => {
  console.error('Redis connection error:', error.message);
});

await nextApp.prepare();

const expressApp = express();
const httpServer = createServer(expressApp);
const store = new RedisGameStore(redis);
const io = attachGameSocketServer(httpServer, { store });

expressApp.all('/{*splat}', (request, response) => handle(request, response));

httpServer.listen(port, hostname, () => {
  console.log(`> Ready on http://${hostname}:${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  await io.close();
  await new Promise((resolve) => httpServer.close(resolve));
  await redis.quit();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

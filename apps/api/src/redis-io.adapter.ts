import { IoAdapter } from '@nestjs/platform-socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server } from 'socket.io';
import { config } from './config.js';

/**
 * Socket.IO adapter (blueprint §3/§9): Redis pub/sub so multiple API instances
 * broadcast to each other's sockets. Graceful degradation is REQUIRED — in
 * dev/test (and during a Redis outage) the process must keep serving with the
 * default single-node in-memory adapter instead of crashing at boot.
 */
export class RedisIoAdapter extends IoAdapter {
  private pubClient: ReturnType<typeof createClient> | null = null;
  private adapterCreator: ReturnType<typeof createAdapter> | null = null;

  /** Try Redis; returns true when the shared adapter is active. */
  async connectToRedis(): Promise<boolean> {
    if (!config.redisUrl) return false;
    try {
      const client = createClient({
        url: config.redisUrl,
        socket: {
          connectTimeout: 2_000,
          reconnectStrategy: false, // fail fast -> in-memory fallback
        },
      });
      // Swallow async pub/sub errors: a mid-flight Redis outage degrades
      // cross-node broadcasts, it must not crash the process (HTTP stays fine).
      client.on('error', (err: Error) => {
        // eslint-disable-next-line no-console
        console.warn(`[ws] redis error (continuing): ${err.message}`);
      });
      await client.connect();
      await client.ping();
      this.pubClient = client;
      this.adapterCreator = createAdapter(client, client.duplicate());
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ws] redis unavailable (${err instanceof Error ? err.message : 'unknown'}); ` +
          'falling back to the in-memory socket adapter (single node)',
      );
      return false;
    }
  }

  override createIOServer(port: number, options?: unknown): Server {
    const io = super.createIOServer(port, {
      ...(options as object),
      // Widget + dashboard sockets are token-authed (no cookies), so any
      // origin may connect — auth is the JWT handshake, not CORS.
      cors: { origin: '*' },
    });
    if (this.adapterCreator) io.adapter(this.adapterCreator as any);
    return io;
  }

  override async close(): Promise<void> {
    try {
      await this.pubClient?.quit();
    } catch {
      /* already gone */
    }
  }
}

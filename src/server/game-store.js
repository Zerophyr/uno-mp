export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export class RedisGameStore {
  constructor(redis, { ttlSeconds = 24 * 60 * 60, maxRetries = 6 } = {}) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.maxRetries = maxRetries;
  }

  async create(state) {
    const result = await this.redis.set(
      this.key(state.roomId),
      JSON.stringify(state),
      'EX',
      this.ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async get(roomId) {
    const value = await this.redis.get(this.key(roomId));
    return value ? JSON.parse(value) : null;
  }

  async update(roomId, mutate) {
    const key = this.key(roomId);

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const transactionRedis = this.redis.duplicate();
      try {
        await transactionRedis.watch(key);
        const value = await transactionRedis.get(key);
        if (!value) {
          throw new StoreError('ROOM_NOT_FOUND', 'Room not found.');
        }

        const state = JSON.parse(value);
        const result = await mutate(state);
        state.version = (state.version || 0) + 1;

        const committed = await transactionRedis
          .multi()
          .set(key, JSON.stringify(state), 'KEEPTTL')
          .exec();

        if (committed !== null) return { state, result };
      } finally {
        transactionRedis.disconnect();
      }
    }

    throw new StoreError('STATE_CONFLICT', 'The game changed concurrently. Please retry.');
  }

  key(roomId) {
    return `game:${roomId}`;
  }
}

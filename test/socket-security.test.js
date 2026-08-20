import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { io as createClient } from 'socket.io-client';
import { attachGameSocketServer } from '../src/server/socket-server.js';

class MemoryGameStore {
  states = new Map();

  async create(state) {
    if (this.states.has(state.roomId)) return false;
    this.states.set(state.roomId, structuredClone(state));
    return true;
  }

  async get(roomId) {
    const state = this.states.get(roomId);
    return state ? structuredClone(state) : null;
  }

  async update(roomId, mutate) {
    const state = await this.get(roomId);
    if (!state) {
      const error = new Error('Room not found.');
      error.name = 'StoreError';
      error.code = 'ROOM_NOT_FOUND';
      throw error;
    }
    const result = await mutate(state);
    state.version = (state.version || 0) + 1;
    this.states.set(roomId, structuredClone(state));
    return { state, result };
  }
}

function emitAck(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3_000).emit(eventName, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function nextEvent(socket, eventName) {
  return new Promise((resolve) => socket.once(eventName, resolve));
}

test('binds authority to the socket session and keeps hands private', async (context) => {
  const httpServer = createServer((_request, response) => response.end('ok'));
  const store = new MemoryGameStore();
  const io = attachGameSocketServer(httpServer, { store });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  const clients = [];

  const connect = async () => {
    const socket = createClient(url, { transports: ['websocket'], forceNew: true });
    clients.push(socket);
    await nextEvent(socket, 'connect');
    return socket;
  };

  context.after(async () => {
    for (const client of clients) client.disconnect();
    await io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const host = await connect();
  const guest = await connect();
  const hostResponse = await emitAck(host, 'create-room', { playerName: 'Host', isHost: false });
  assert.equal(hostResponse.ok, true);
  const guestResponse = await emitAck(guest, 'join-room', {
    roomId: hostResponse.session.roomId,
    playerName: 'Guest',
    isHost: true,
  });
  assert.equal(guestResponse.ok, true);

  const forgedStart = await emitAck(guest, 'start-game', { playerId: hostResponse.session.playerId });
  assert.deepEqual(forgedStart, {
    ok: false,
    error: { code: 'HOST_ONLY', message: 'Only the host can start the game.' },
  });

  const hostStatePromise = nextEvent(host, 'state-updated');
  const legitimateStart = await emitAck(host, 'start-game');
  assert.equal(legitimateStart.ok, true);
  const hostState = await hostStatePromise;
  assert.equal(hostState.status, 'Playing');
  assert.ok(hostState.players.find((player) => player.id === hostResponse.session.playerId).hand.length >= 7);

  const attacker = await connect();
  const forgedResume = await emitAck(attacker, 'resume-room', {
    roomId: hostResponse.session.roomId,
    playerId: hostResponse.session.playerId,
    sessionToken: guestResponse.session.sessionToken,
  });
  assert.equal(forgedResume.ok, false);
  assert.equal(forgedResume.error.code, 'INVALID_SESSION');

  const currentPlayer = hostState.players[hostState.currentPlayerIndex];
  const wrongSocket = currentPlayer.id === hostResponse.session.playerId ? guest : host;
  const forgedDraw = await emitAck(wrongSocket, 'draw-card', { playerId: currentPlayer.id });
  assert.equal(forgedDraw.ok, false);
  assert.equal(forgedDraw.error.code, 'NOT_YOUR_TURN');

  const watcher = await connect();
  const publicStatePromise = nextEvent(watcher, 'state-updated');
  const watchResponse = await emitAck(watcher, 'watch-room', { roomId: hostResponse.session.roomId });
  assert.equal(watchResponse.ok, true);
  const publicState = await publicStatePromise;
  assert.ok(publicState.players.every((player) => player.hand.length === 0));
  assert.ok(publicState.players.every((player) => !('sessionHash' in player)));
});

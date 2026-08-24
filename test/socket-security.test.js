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

  const roomState = store.states.get(hostResponse.session.roomId);
  roomState.turnDeadlineAt = Date.now() - 1;
  store.states.set(hostResponse.session.roomId, roomState);
  const currentSocket = currentPlayer.id === hostResponse.session.playerId ? host : guest;
  const expiredDraw = await emitAck(currentSocket, 'draw-card');
  assert.equal(expiredDraw.ok, false);
  assert.equal(expiredDraw.error.code, 'TURN_EXPIRED');
  roomState.turnDeadlineAt = Date.now() + 60_000;
  store.states.set(hostResponse.session.roomId, roomState);

  const watcher = await connect();
  const publicStatePromise = nextEvent(watcher, 'state-updated');
  const watchResponse = await emitAck(watcher, 'watch-room', { roomId: hostResponse.session.roomId });
  assert.equal(watchResponse.ok, true);
  const publicState = await publicStatePromise;
  assert.ok(publicState.players.every((player) => player.hand.length === 0));
  assert.ok(publicState.players.every((player) => !('sessionHash' in player)));

  const roomId = hostResponse.session.roomId;
  const finishedState = store.states.get(roomId);
  finishedState.status = 'Finished';
  finishedState.winnerId = hostResponse.session.playerId;
  finishedState.rematchVotes = [];
  store.states.set(roomId, finishedState);

  const hostVoteStatePromise = nextEvent(host, 'state-updated');
  const guestSawHostVotePromise = nextEvent(guest, 'state-updated');
  const hostVote = await emitAck(host, 'vote-rematch', { playerId: guestResponse.session.playerId });
  assert.equal(hostVote.ok, true);
  const hostVoteState = await hostVoteStatePromise;
  await guestSawHostVotePromise;
  assert.equal(hostVoteState.status, 'Finished');
  assert.equal(hostVoteState.rematchVoteCount, 1);
  assert.equal(hostVoteState.hasVotedRematch, true);
  assert.deepEqual(store.states.get(roomId).rematchVotes, [hostResponse.session.playerId]);

  const rematchStatePromise = nextEvent(guest, 'state-updated');
  const hostSawRematchPromise = nextEvent(host, 'state-updated');
  const guestVote = await emitAck(guest, 'vote-rematch', { playerId: hostResponse.session.playerId });
  assert.equal(guestVote.ok, true);
  const rematchState = await rematchStatePromise;
  await hostSawRematchPromise;
  assert.equal(rematchState.status, 'Playing');
  assert.deepEqual(store.states.get(roomId).rematchVotes, []);
  assert.ok(store.states.get(roomId).players.every((player) => player.hand.length === 7));
});

test('enforces the four-player lobby capacity on the server', async (context) => {
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
  const hostResponse = await emitAck(host, 'create-room', { playerName: 'Host' });
  const roomId = hostResponse.session.roomId;
  const joinedPlayers = new Map();

  for (const playerName of ['Second', 'Third', 'Fourth']) {
    const player = await connect();
    const response = await emitAck(player, 'join-room', { roomId, playerName });
    assert.equal(response.ok, true);
    joinedPlayers.set(playerName, { player, session: response.session });
  }

  assert.equal(store.states.get(roomId).players.length, 4);
  assert.equal(store.states.get(roomId).maxPlayers, 4);

  const fifth = await connect();
  const rejected = await emitAck(fifth, 'join-room', { roomId, playerName: 'Fifth' });
  assert.deepEqual(rejected, {
    ok: false,
    error: { code: 'ROOM_FULL', message: 'This room already has 4 players.' },
  });
  assert.equal(store.states.get(roomId).players.length, 4);

  const fourth = joinedPlayers.get('Fourth');
  const removedPromise = nextEvent(fourth.player, 'removed-from-room');
  const hostStatePromise = nextEvent(host, 'state-updated');
  const removed = await emitAck(host, 'remove-player', { playerId: fourth.session.playerId });
  assert.equal(removed.ok, true);
  assert.deepEqual(await removedPromise, { message: 'The host removed you from the lobby.' });
  const hostState = await hostStatePromise;
  assert.equal(hostState.players.length, 3);
  assert.equal(store.states.get(roomId).players.length, 3);
});

test('keeps a disconnected player in an active round and advances their timed-out turn', async (context) => {
  const httpServer = createServer((_request, response) => response.end('ok'));
  const store = new MemoryGameStore();
  const io = attachGameSocketServer(httpServer, {
    store,
    disconnectGraceMs: 40,
    turnDurationMs: 120,
  });
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
  const hostResponse = await emitAck(host, 'create-room', { playerName: 'Host' });
  const guestResponse = await emitAck(guest, 'join-room', {
    roomId: hostResponse.session.roomId,
    playerName: 'Guest',
  });

  const hostStartedPromise = nextEvent(host, 'state-updated');
  const guestStartedPromise = nextEvent(guest, 'state-updated');
  await emitAck(host, 'start-game');
  const [started] = await Promise.all([hostStartedPromise, guestStartedPromise]);
  const currentPlayer = started.players[started.currentPlayerIndex];
  const currentSocket = currentPlayer.id === hostResponse.session.playerId ? host : guest;
  const observingSocket = currentSocket === host ? guest : host;
  const handCountBefore = store.states.get(hostResponse.session.roomId).players
    .find((player) => player.id === currentPlayer.id).hand.length;

  const presencePromise = nextEvent(observingSocket, 'state-updated');
  currentSocket.disconnect();
  const presenceState = await presencePromise;
  assert.equal(presenceState.players.find((player) => player.id === currentPlayer.id).isConnected, false);

  const timeoutState = await new Promise((resolve) => {
    const handleState = (state) => {
      if (state.currentPlayerIndex !== started.currentPlayerIndex) {
        observingSocket.off('state-updated', handleState);
        resolve(state);
      }
    };
    observingSocket.on('state-updated', handleState);
  });

  assert.notEqual(timeoutState.currentPlayerIndex, started.currentPlayerIndex);
  const storedState = store.states.get(hostResponse.session.roomId);
  assert.equal(storedState.players.length, 2);
  assert.equal(
    storedState.players.find((player) => player.id === currentPlayer.id).hand.length,
    handCountBefore + 1,
  );
  assert.ok(storedState.players.some((player) => player.id === guestResponse.session.playerId));
});

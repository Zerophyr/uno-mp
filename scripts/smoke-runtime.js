import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const baseUrl = process.env.SMOKE_URL || 'http://127.0.0.1:3000';
const sockets = [];

function connect() {
  const socket = io(baseUrl, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out.')), 5_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

function emitAck(socket, eventName, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(5_000).emit(eventName, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function trackState(socket) {
  const tracker = { current: null };
  socket.on('state-updated', (state) => {
    tracker.current = state;
  });
  return tracker;
}

function waitForState(tracker, predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const timer = setInterval(() => {
      if (tracker.current && predicate(tracker.current)) {
        clearInterval(timer);
        resolve(tracker.current);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error('Expected state update did not arrive.'));
      }
    }, 20);
  });
}

try {
  const host = await connect();
  const hostState = trackState(host);
  const created = await emitAck(host, 'create-room', { playerName: 'Runtime Host' });
  assert.equal(created.ok, true);

  const guest = await connect();
  const joined = await emitAck(guest, 'join-room', {
    roomId: created.session.roomId,
    playerName: 'Runtime Guest',
  });
  assert.equal(joined.ok, true);

  const forgedStart = await emitAck(guest, 'start-game', {
    playerId: created.session.playerId,
    isHost: true,
  });
  assert.equal(forgedStart.ok, false);
  assert.equal(forgedStart.error.code, 'HOST_ONLY');

  const started = await emitAck(host, 'start-game');
  assert.equal(started.ok, true);
  const playingState = await waitForState(hostState, (state) => state.status === 'Playing');

  const tokenSwap = await connect();
  const rejectedResume = await emitAck(tokenSwap, 'resume-room', {
    roomId: created.session.roomId,
    playerId: created.session.playerId,
    sessionToken: joined.session.sessionToken,
  });
  assert.equal(rejectedResume.ok, false);
  assert.equal(rejectedResume.error.code, 'INVALID_SESSION');

  const currentPlayer = playingState.players[playingState.currentPlayerIndex];
  const attacker = currentPlayer.id === created.session.playerId ? guest : host;
  const forgedDraw = await emitAck(attacker, 'draw-card', { playerId: currentPlayer.id });
  assert.equal(forgedDraw.ok, false);
  assert.equal(forgedDraw.error.code, 'NOT_YOUR_TURN');

  const watcher = await connect();
  const watcherState = trackState(watcher);
  const watched = await emitAck(watcher, 'watch-room', { roomId: created.session.roomId });
  assert.equal(watched.ok, true);
  const publicState = await waitForState(watcherState, (state) => state.status === 'Playing');
  assert.equal(publicState.deck.length, 0);
  assert.equal('pendingDrawPlayerId' in publicState, false);
  assert.equal('pendingDrawCardId' in publicState, false);
  assert.ok(publicState.players.every((player) => player.hand.length === 0));
  assert.ok(publicState.players.every((player) => !('sessionHash' in player)));

  const resumed = await connect();
  const resumedState = trackState(resumed);
  const validResume = await emitAck(resumed, 'resume-room', joined.session);
  assert.equal(validResume.ok, true);
  const personalState = await waitForState(resumedState, (state) => state.status === 'Playing');
  const resumedPlayer = personalState.players.find(
    (player) => player.id === joined.session.playerId,
  );
  assert.ok(resumedPlayer.hand.length >= 7);
  assert.ok(personalState.players
    .filter((player) => player.id !== joined.session.playerId)
    .every((player) => player.hand.length === 0));

  console.log(JSON.stringify({
    ok: true,
    roomId: created.session.roomId,
    checks: [
      'host-authority',
      'socket-identity',
      'session-token-binding',
      'private-hands',
      'session-resume',
    ],
  }));
} finally {
  for (const socket of sockets) socket.disconnect();
}

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from 'socket.io';
import {
  GameError,
  callUno,
  createLobby,
  drawCard,
  passTurn,
  playCard,
  removePlayer,
  sanitizeState,
  startGame,
} from '../lib/game-engine.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_PATTERN = /^[A-Z0-9]{6}$/;
const MAX_PLAYERS = 10;

export function attachGameSocketServer(
  httpServer,
  { store, ioOptions = {}, disconnectGraceMs = 2 * 60 * 1000 },
) {
  const io = new Server(httpServer, {
    connectionStateRecovery: {
      maxDisconnectionDuration: disconnectGraceMs,
      skipMiddlewares: false,
    },
    maxHttpBufferSize: 100_000,
    ...ioOptions,
  });

  async function broadcastState(roomId, state) {
    const sockets = await io.in(roomName(roomId)).fetchSockets();
    for (const roomSocket of sockets) {
      const viewerId = roomSocket.data.roomId === roomId ? roomSocket.data.playerId || null : null;
      roomSocket.emit('state-updated', sanitizeState(state, viewerId));
    }
  }

  io.on('connection', (socket) => {
    if (socket.recovered && socket.data.roomId) {
      void store.get(socket.data.roomId).then((state) => {
        if (state) socket.emit('state-updated', sanitizeState(state, socket.data.playerId || null));
      });
    }

    register(socket, 'create-room', async (payload) => {
      const playerName = parsePlayerName(payload?.playerName);
      const session = issueSession();

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const roomId = createRoomId();
        const player = createPlayer(playerName, true, session);
        const state = createLobby(roomId, player);
        if (await store.create(state)) {
          await bindPlayer(socket, roomId, player.id);
          await broadcastState(roomId, state);
          return { session: publicSession(roomId, player.id, session.token) };
        }
      }

      throw new GameError('ROOM_CREATION_FAILED', 'Unable to create a unique room. Try again.');
    });

    register(socket, 'join-room', async (payload) => {
      const roomId = parseRoomId(payload?.roomId);
      const playerName = parsePlayerName(payload?.playerName);
      const session = issueSession();
      const player = createPlayer(playerName, false, session);

      const { state } = await store.update(roomId, (game) => {
        if (game.status !== 'Lobby') {
          throw new GameError('GAME_ALREADY_STARTED', 'The game has already started.');
        }
        if (game.players.length >= MAX_PLAYERS) {
          throw new GameError('ROOM_FULL', 'This room already has ten players.');
        }
        game.players.push(player);
      });

      await bindPlayer(socket, roomId, player.id);
      await broadcastState(roomId, state);
      return { session: publicSession(roomId, player.id, session.token) };
    });

    register(socket, 'resume-room', async (payload) => {
      const roomId = parseRoomId(payload?.roomId);
      const playerId = parseIdentifier(payload?.playerId, 'player ID');
      const sessionToken = parseIdentifier(payload?.sessionToken, 'session token', 200);
      const state = await requireState(store, roomId);
      const player = state.players.find((candidate) => candidate.id === playerId);

      if (!player || !sessionMatches(sessionToken, player.sessionHash)) {
        throw new GameError('INVALID_SESSION', 'This player session is no longer valid.');
      }

      await bindPlayer(socket, roomId, playerId);
      socket.emit('state-updated', sanitizeState(state, playerId));
      return { session: publicSession(roomId, playerId, sessionToken) };
    });

    register(socket, 'watch-room', async (payload) => {
      const roomId = parseRoomId(payload?.roomId);
      const state = await requireState(store, roomId);
      await bindWatcher(socket, roomId);
      socket.emit('state-updated', sanitizeState(state));
      return { roomId };
    });

    register(socket, 'start-game', async () => {
      const session = requireBoundPlayer(socket);
      const { state } = await store.update(session.roomId, (game) => {
        const player = game.players.find((candidate) => candidate.id === session.playerId);
        if (!player?.isHost) {
          throw new GameError('HOST_ONLY', 'Only the host can start the game.');
        }
        startGame(game);
      });
      await broadcastState(session.roomId, state);
      return {};
    });

    register(socket, 'play-card', async (payload) => {
      const session = requireBoundPlayer(socket);
      const cardId = parseIdentifier(payload?.cardId, 'card ID', 160);
      const chosenColor = payload?.chosenColor;
      const { state } = await store.update(session.roomId, (game) => {
        playCard(game, session.playerId, cardId, chosenColor);
      });
      await broadcastState(session.roomId, state);
      return {};
    });

    register(socket, 'draw-card', async () => {
      const session = requireBoundPlayer(socket);
      const { state } = await store.update(session.roomId, (game) => {
        drawCard(game, session.playerId);
      });
      await broadcastState(session.roomId, state);
      return {};
    });

    register(socket, 'pass-turn', async () => {
      const session = requireBoundPlayer(socket);
      const { state } = await store.update(session.roomId, (game) => {
        passTurn(game, session.playerId);
      });
      await broadcastState(session.roomId, state);
      return {};
    });

    register(socket, 'call-uno', async () => {
      const session = requireBoundPlayer(socket);
      const { state } = await store.update(session.roomId, (game) => {
        callUno(game, session.playerId);
      });
      await broadcastState(session.roomId, state);
      return {};
    });

    register(socket, 'leave-room', async () => {
      const session = requireBoundPlayer(socket);
      const { state } = await store.update(session.roomId, (game) => {
        removePlayer(game, session.playerId);
      });
      await socket.leave(roomName(session.roomId));
      socket.data.roomId = null;
      socket.data.playerId = null;
      await broadcastState(session.roomId, state);
      return {};
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId;
      const playerId = socket.data.playerId;
      if (!roomId || !playerId) return;

      setTimeout(() => {
        void removeDisconnectedPlayer(io, store, roomId, playerId, broadcastState);
      }, disconnectGraceMs).unref();
    });
  });

  return io;
}

async function removeDisconnectedPlayer(io, store, roomId, playerId, broadcastState) {
  const sockets = await io.in(roomName(roomId)).fetchSockets();
  if (sockets.some((socket) => socket.data.playerId === playerId)) return;

  try {
    const { state } = await store.update(roomId, (game) => removePlayer(game, playerId));
    await broadcastState(roomId, state);
  } catch (error) {
    if (error?.code !== 'ROOM_NOT_FOUND') console.error('Disconnect cleanup failed:', error);
  }
}

function register(socket, eventName, handler) {
  socket.on(eventName, async (payload, acknowledgement) => {
    const acknowledge = typeof acknowledgement === 'function' ? acknowledgement : () => {};
    try {
      const result = await handler(payload || {});
      acknowledge({ ok: true, ...result });
    } catch (error) {
      const code = error?.code || 'INTERNAL_ERROR';
      const message = error instanceof GameError || error?.name === 'StoreError'
        ? error.message
        : 'Unexpected server error.';
      if (code === 'INTERNAL_ERROR') console.error(`${eventName} failed:`, error);
      acknowledge({ ok: false, error: { code, message } });
    }
  });
}

async function bindPlayer(socket, roomId, playerId) {
  await leaveCurrentRoom(socket);
  socket.data.roomId = roomId;
  socket.data.playerId = playerId;
  await socket.join(roomName(roomId));
}

async function bindWatcher(socket, roomId) {
  await leaveCurrentRoom(socket);
  socket.data.roomId = roomId;
  socket.data.playerId = null;
  await socket.join(roomName(roomId));
}

async function leaveCurrentRoom(socket) {
  if (socket.data.roomId) await socket.leave(roomName(socket.data.roomId));
}

function requireBoundPlayer(socket) {
  if (!socket.data.roomId || !socket.data.playerId) {
    throw new GameError('SESSION_REQUIRED', 'Resume your player session first.');
  }
  return { roomId: socket.data.roomId, playerId: socket.data.playerId };
}

async function requireState(store, roomId) {
  const state = await store.get(roomId);
  if (!state) throw new GameError('ROOM_NOT_FOUND', 'Room not found.');
  return state;
}

function issueSession() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function createPlayer(name, isHost, session) {
  return {
    id: randomUUID(),
    name,
    hand: [],
    hasCalledUno: false,
    isHost,
    sessionHash: session.hash,
  };
}

function publicSession(roomId, playerId, sessionToken) {
  return { roomId, playerId, sessionToken };
}

function sessionMatches(token, expectedHash) {
  if (typeof expectedHash !== 'string') return false;
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseRoomId(value) {
  if (typeof value !== 'string') throw new GameError('INVALID_ROOM', 'Enter a valid room code.');
  const roomId = value.trim().toUpperCase();
  if (!ROOM_PATTERN.test(roomId)) throw new GameError('INVALID_ROOM', 'Enter a valid six-character room code.');
  return roomId;
}

function parsePlayerName(value) {
  if (typeof value !== 'string') throw new GameError('INVALID_NAME', 'Enter a player name.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24) {
    throw new GameError('INVALID_NAME', 'Player names must be between 1 and 24 characters.');
  }
  return name;
}

function parseIdentifier(value, label, maxLength = 80) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new GameError('INVALID_INPUT', `Invalid ${label}.`);
  }
  return value;
}

function createRoomId() {
  let roomId = '';
  for (let index = 0; index < 6; index += 1) {
    roomId += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  }
  return roomId;
}

function roomName(roomId) {
  return `room-${roomId}`;
}

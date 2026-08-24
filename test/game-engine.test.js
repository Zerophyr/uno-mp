import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GameError,
  MAX_PLAYERS,
  callUno,
  canPlayCard,
  createDeck,
  drawCard,
  expireTurn,
  passTurn,
  playCard,
  removePlayer,
  sanitizeState,
  startGame,
  voteRematch,
} from '../src/lib/game-engine.js';

function card(id, color, value) {
  return { id, color, value, filename: `${id}.jpg` };
}

function playingState(overrides = {}) {
  return {
    roomId: 'ABC123',
    status: 'Playing',
    maxPlayers: MAX_PLAYERS,
    roundNumber: 1,
    players: [
      { id: 'host', name: 'Host', isHost: true, hasCalledUno: false, sessionHash: 'secret-a', hand: [] },
      { id: 'guest', name: 'Guest', isHost: false, hasCalledUno: false, sessionHash: 'secret-b', hand: [] },
    ],
    deck: [],
    discardPile: [card('red-5', 'Red', '5')],
    currentPlayerIndex: 0,
    direction: 1,
    currentColor: 'Red',
    winnerId: null,
    lastPlayedCard: card('red-5', 'Red', '5'),
    pendingDrawPlayerId: null,
    pendingDrawCardId: null,
    rematchVotes: [],
    turnDeadlineAt: 2_000,
    turnDurationMs: 1_000,
    version: 1,
    ...overrides,
  };
}

test('creates a complete 108-card deck with unique IDs', () => {
  let identifier = 0;
  const deck = createDeck(() => String(identifier += 1));
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((entry) => entry.id)).size, 108);
});

test('requires at least two players and prevents restarting a game', () => {
  const lobby = playingState({ status: 'Lobby', players: [playingState().players[0]] });
  assert.throws(() => startGame(lobby), (error) => error instanceof GameError && error.code === 'NOT_ENOUGH_PLAYERS');

  const active = playingState();
  assert.throws(() => startGame(active), (error) => error instanceof GameError && error.code === 'GAME_ALREADY_STARTED');

  const fullLobby = playingState({
    status: 'Lobby',
    players: [
      ...playingState().players,
      { id: 'third', name: 'Third', isHost: false, hasCalledUno: false, sessionHash: 'secret-c', hand: [] },
      { id: 'fourth', name: 'Fourth', isHost: false, hasCalledUno: false, sessionHash: 'secret-d', hand: [] },
    ],
  });
  assert.doesNotThrow(() => startGame(fullLobby));

  const oversizedLobby = playingState({
    status: 'Lobby',
    players: [
      ...playingState().players,
      { id: 'third', name: 'Third', isHost: false, hasCalledUno: false, sessionHash: 'secret-c', hand: [] },
      { id: 'fourth', name: 'Fourth', isHost: false, hasCalledUno: false, sessionHash: 'secret-d', hand: [] },
      { id: 'fifth', name: 'Fifth', isHost: false, hasCalledUno: false, sessionHash: 'secret-e', hand: [] },
    ],
  });
  assert.throws(() => startGame(oversizedLobby), (error) => error instanceof GameError && error.code === 'TOO_MANY_PLAYERS');
});

test('enforces one draw followed by play or pass', () => {
  const drawn = card('red-7', 'Red', '7');
  const state = playingState({ deck: [drawn] });

  drawCard(state, 'host');
  assert.equal(state.pendingDrawCardId, drawn.id);
  assert.equal(state.currentPlayerIndex, 0);
  assert.throws(() => drawCard(state, 'host'), (error) => error.code === 'ALREADY_DREW');

  passTurn(state, 'host');
  assert.equal(state.pendingDrawCardId, null);
  assert.equal(state.currentPlayerIndex, 1);
});

test('automatically draws and passes when the turn deadline expires', () => {
  const timedCard = card('timed-draw', 'Blue', '3');
  const state = playingState({ deck: [timedCard] });

  assert.throws(() => expireTurn(state, 1_999), (error) => error.code === 'TURN_TIMER_ACTIVE');
  const result = expireTurn(state, 2_000, () => 0.5);

  assert.deepEqual(result, { playerId: 'host', drewCard: true });
  assert.equal(state.players[0].hand.at(-1).id, timedCard.id);
  assert.equal(state.currentPlayerIndex, 1);
  assert.equal(state.turnDeadlineAt, 3_000);
  assert.equal(state.pendingDrawPlayerId, null);
});

test('recycles the discard pile when the draw deck is empty', () => {
  const state = playingState({
    deck: [],
    discardPile: [
      card('blue-2', 'Blue', '2'),
      card('yellow-8', 'Yellow', '8'),
      card('red-5', 'Red', '5'),
    ],
  });

  drawCard(state, 'host', () => 0);
  assert.equal(state.discardPile.length, 1);
  assert.equal(state.discardPile[0].id, 'red-5');
  assert.equal(state.players[0].hand.length, 1);
});

test('requires a valid color for wild cards and restricts Wild Draw Four', () => {
  const wild = card('wild', 'Wild', 'Wild');
  const drawFour = card('draw-four', 'Wild', 'WildDrawFour');
  const matchingRed = card('red-9', 'Red', '9');
  const state = playingState();
  state.players[0].hand = [wild, drawFour, matchingRed];

  assert.throws(() => playCard(state, 'host', wild.id, 'Purple'), (error) => error.code === 'INVALID_COLOR');
  assert.equal(canPlayCard(drawFour, state, state.players[0].hand), false);
  assert.throws(() => playCard(state, 'host', drawFour.id, 'Blue'), (error) => error.code === 'CARD_NOT_PLAYABLE');
});

test('applies the UNO penalty unless the player called UNO first', () => {
  const first = playingState({ deck: [card('draw-a', 'Blue', '1'), card('draw-b', 'Green', '1')] });
  first.players[0].hand = [card('red-7', 'Red', '7'), card('blue-5', 'Blue', '5')];
  playCard(first, 'host', 'red-7');
  assert.equal(first.players[0].hand.length, 3);

  const second = playingState({ deck: [card('draw-c', 'Blue', '1'), card('draw-d', 'Green', '1')] });
  second.players[0].hand = [card('red-7b', 'Red', '7'), card('blue-5b', 'Blue', '5')];
  callUno(second, 'host');
  playCard(second, 'host', 'red-7b');
  assert.equal(second.players[0].hand.length, 1);
});

test('sanitized state never exposes secrets and derives viewer-specific rematch state', () => {
  const state = playingState({ deck: [card('secret-deck', 'Blue', '2')] });
  state.players[0].hand = [card('host-card', 'Red', '7')];
  state.players[1].hand = [card('guest-card', 'Blue', '7')];
  state.status = 'Finished';
  state.rematchVotes = ['host'];

  const hostView = sanitizeState(state, 'host');
  assert.deepEqual(hostView.deck, []);
  assert.equal(hostView.players[0].hand.length, 1);
  assert.deepEqual(hostView.players[1].hand, []);
  assert.equal('sessionHash' in hostView.players[0], false);
  assert.equal('rematchVotes' in hostView, false);
  assert.equal(hostView.rematchVoteCount, 1);
  assert.equal(hostView.rematchVotesRequired, 2);
  assert.equal(hostView.hasVotedRematch, true);
  assert.equal(hostView.canVoteRematch, true);

  const publicView = sanitizeState(state);
  assert.ok(publicView.players.every((player) => player.hand.length === 0));
  assert.equal(publicView.canVoteRematch, false);
});

test('starts a new round after a strict majority votes and ignores duplicate votes', () => {
  let identifier = 0;
  const state = playingState({
    status: 'Finished',
    winnerId: 'host',
    players: [
      ...playingState().players,
      { id: 'third', name: 'Third', isHost: false, hasCalledUno: false, sessionHash: 'secret-c', hand: [] },
    ],
  });

  voteRematch(state, 'host', { random: () => 0.5, idFactory: () => `new-${identifier += 1}` });
  voteRematch(state, 'host', { random: () => 0.5, idFactory: () => `new-${identifier += 1}` });
  assert.equal(state.status, 'Finished');
  assert.deepEqual(state.rematchVotes, ['host']);

  voteRematch(state, 'guest', { random: () => 0.5, idFactory: () => `new-${identifier += 1}` });
  assert.equal(state.status, 'Playing');
  assert.deepEqual(state.players.map((player) => player.id), ['host', 'guest', 'third']);
  assert.ok(state.players.every((player) => player.hand.length === 7));
  assert.deepEqual(state.rematchVotes, []);
  assert.equal(state.winnerId, null);
  assert.equal(state.roundNumber, 2);
  assert.equal(state.turnDurationMs, 1_000);
});

test('records round wins and keeps the score for a rematch', () => {
  let identifier = 0;
  const state = playingState();
  state.players[0].hand = [card('winning-card', 'Red', '7')];

  playCard(state, 'host', 'winning-card');
  assert.equal(state.status, 'Finished');
  assert.equal(state.players[0].wins, 1);
  assert.equal(state.turnDeadlineAt, null);

  voteRematch(state, 'host', { random: () => 0.5, idFactory: () => `score-${identifier += 1}` });
  voteRematch(state, 'guest', { random: () => 0.5, idFactory: () => `score-${identifier += 1}` });
  assert.equal(state.status, 'Playing');
  assert.equal(state.players[0].wins, 1);
});

test('recalculates the rematch majority when a player leaves', () => {
  let identifier = 0;
  const state = playingState({
    status: 'Finished',
    winnerId: 'host',
    players: [
      ...playingState().players,
      { id: 'third', name: 'Third', isHost: false, hasCalledUno: false, sessionHash: 'secret-c', hand: [] },
      { id: 'fourth', name: 'Fourth', isHost: false, hasCalledUno: false, sessionHash: 'secret-d', hand: [] },
    ],
    rematchVotes: ['host', 'guest'],
  });

  removePlayer(state, 'fourth', () => 0.5, () => `new-${identifier += 1}`);
  assert.equal(state.status, 'Playing');
  assert.deepEqual(state.players.map((player) => player.id), ['host', 'guest', 'third']);
  assert.ok(state.players.every((player) => player.hand.length === 7));
  assert.deepEqual(state.rematchVotes, []);
});

test('removes disconnected players, transfers host, and advances a blocked turn', () => {
  const state = playingState();
  state.players[0].hand = [card('returned', 'Blue', '3')];
  removePlayer(state, 'host', () => 0);

  assert.equal(state.players.length, 1);
  assert.equal(state.players[0].id, 'guest');
  assert.equal(state.players[0].isHost, true);
  assert.equal(state.status, 'Finished');
  assert.equal(state.winnerId, 'guest');
  assert.equal(state.players[0].wins, 1);
  assert.ok(state.deck.some((entry) => entry.id === 'returned'));
});

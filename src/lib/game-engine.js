import { randomUUID } from 'node:crypto';

export const COLORS = ['Red', 'Blue', 'Green', 'Yellow'];
export const VALUES = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'Skip', 'Reverse', 'DrawTwo',
];

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

export function createDeck(idFactory = randomUUID) {
  const deck = [];

  for (const color of COLORS) {
    deck.push(createCard(color, '0', idFactory));
    for (const value of VALUES.slice(1)) {
      deck.push(createCard(color, value, idFactory));
      deck.push(createCard(color, value, idFactory));
    }
  }

  for (let index = 0; index < 4; index += 1) {
    deck.push(createCard('Wild', 'Wild', idFactory));
    deck.push(createCard('Wild', 'WildDrawFour', idFactory));
  }

  return deck;
}

function createCard(color, value, idFactory) {
  let filename;
  if (color === 'Wild') {
    filename = value === 'WildDrawFour' ? 'Wild_Draw_4.jpg' : 'Wild.jpg';
  } else if (color === 'Red' && value === 'Reverse') {
    filename = 'RED_Reverse.jpg';
  } else {
    filename = `${color}_${value === 'DrawTwo' ? 'Draw_2' : value}.jpg`;
  }

  return {
    id: `${color}_${value}_${idFactory()}`,
    filename,
    color,
    value,
  };
}

export function shuffle(items, random = Math.random) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function createLobby(roomId, host) {
  return {
    roomId,
    status: 'Lobby',
    players: [host],
    deck: [],
    discardPile: [],
    currentPlayerIndex: 0,
    direction: 1,
    currentColor: 'Red',
    winnerId: null,
    lastPlayedCard: null,
    pendingDrawPlayerId: null,
    pendingDrawCardId: null,
    version: 0,
  };
}

export function sanitizeState(state, viewerPlayerId = null) {
  const sanitized = {
    ...state,
    deck: [],
    canPass: state.pendingDrawPlayerId === viewerPlayerId,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      isHost: player.isHost,
      hasCalledUno: player.hasCalledUno,
      hand: player.id === viewerPlayerId ? player.hand : [],
      handCount: player.hand.length,
    })),
  };
  delete sanitized.pendingDrawPlayerId;
  delete sanitized.pendingDrawCardId;
  return sanitized;
}

export function canPlayCard(card, state, hand = []) {
  const topCard = state.discardPile.at(-1);
  if (!topCard) return true;
  if (card.value === 'Wild') return true;
  if (card.value === 'WildDrawFour') {
    return !hand.some((candidate) => candidate.id !== card.id && candidate.color === state.currentColor);
  }
  return card.color === state.currentColor || card.value === topCard.value;
}

export function startGame(state, { random = Math.random, idFactory = randomUUID } = {}) {
  if (state.status !== 'Lobby') {
    throw new GameError('GAME_ALREADY_STARTED', 'The game has already started.');
  }
  if (state.players.length < 2) {
    throw new GameError('NOT_ENOUGH_PLAYERS', 'At least two players are required.');
  }
  if (state.players.length > 10) {
    throw new GameError('TOO_MANY_PLAYERS', 'UNO supports at most ten players.');
  }

  const deck = shuffle(createDeck(idFactory), random);
  for (const player of state.players) {
    player.hand = [];
    player.hasCalledUno = false;
    for (let count = 0; count < 7; count += 1) {
      player.hand.push(deck.pop());
    }
  }

  let initialDiscard = deck.pop();
  while (initialDiscard?.color === 'Wild') {
    deck.unshift(initialDiscard);
    initialDiscard = deck.pop();
  }
  if (!initialDiscard) {
    throw new GameError('DECK_EMPTY', 'Unable to start the game.');
  }

  state.status = 'Playing';
  state.deck = deck;
  state.discardPile = [initialDiscard];
  state.currentPlayerIndex = 0;
  state.direction = 1;
  state.currentColor = initialDiscard.color;
  state.winnerId = null;
  state.lastPlayedCard = initialDiscard;
  clearPendingDraw(state);

  if (initialDiscard.value === 'Skip') {
    state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
  } else if (initialDiscard.value === 'Reverse') {
    state.direction = -1;
    state.currentPlayerIndex = state.players.length === 2
      ? advanceIndex(state, state.currentPlayerIndex)
      : state.players.length - 1;
  } else if (initialDiscard.value === 'DrawTwo') {
    drawCards(state, state.players[0], 2, random);
    state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
  }

  return state;
}

export function callUno(state, playerId) {
  const player = requireCurrentPlayer(state, playerId);
  if (player.hand.length !== 2) {
    throw new GameError('UNO_NOT_AVAILABLE', 'Call UNO before playing your second-to-last card.');
  }
  player.hasCalledUno = true;
  return state;
}

export function playCard(state, playerId, cardId, chosenColor, random = Math.random) {
  const player = requireCurrentPlayer(state, playerId);
  const cardIndex = player.hand.findIndex((card) => card.id === cardId);
  if (cardIndex === -1) {
    throw new GameError('CARD_NOT_OWNED', 'That card is not in your hand.');
  }
  if (state.pendingDrawPlayerId === playerId && state.pendingDrawCardId !== cardId) {
    throw new GameError('DRAWN_CARD_ONLY', 'After drawing, you may only play the card you drew.');
  }

  const card = player.hand[cardIndex];
  if (!canPlayCard(card, state, player.hand)) {
    throw new GameError('CARD_NOT_PLAYABLE', 'That card cannot be played now.');
  }
  if (card.color === 'Wild' && !COLORS.includes(chosenColor)) {
    throw new GameError('INVALID_COLOR', 'Choose red, blue, green, or yellow.');
  }

  player.hand.splice(cardIndex, 1);
  state.discardPile.push(card);
  state.lastPlayedCard = card;
  state.currentColor = card.color === 'Wild' ? chosenColor : card.color;
  clearPendingDraw(state);

  if (player.hand.length === 1 && !player.hasCalledUno) {
    drawCards(state, player, 2, random);
  }
  player.hasCalledUno = false;

  if (player.hand.length === 0) {
    state.status = 'Finished';
    state.winnerId = playerId;
    return state;
  }

  if (card.value === 'Reverse') {
    if (state.players.length === 2) {
      state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
      state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
    } else {
      state.direction *= -1;
      state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
    }
    return state;
  }

  state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
  if (card.value === 'Skip') {
    state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
  } else if (card.value === 'DrawTwo' || card.value === 'WildDrawFour') {
    const drawCount = card.value === 'DrawTwo' ? 2 : 4;
    drawCards(state, state.players[state.currentPlayerIndex], drawCount, random);
    state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
  }

  return state;
}

export function drawCard(state, playerId, random = Math.random) {
  const player = requireCurrentPlayer(state, playerId);
  if (state.pendingDrawPlayerId === playerId) {
    throw new GameError('ALREADY_DREW', 'Play the drawn card or pass your turn.');
  }

  const card = drawOne(state, random);
  if (!card) {
    throw new GameError('NO_CARDS_AVAILABLE', 'No cards are available to draw.');
  }
  player.hand.push(card);
  player.hasCalledUno = false;

  if (canPlayCard(card, state, player.hand)) {
    state.pendingDrawPlayerId = playerId;
    state.pendingDrawCardId = card.id;
  } else {
    state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
  }

  return state;
}

export function passTurn(state, playerId) {
  requireCurrentPlayer(state, playerId);
  if (state.pendingDrawPlayerId !== playerId) {
    throw new GameError('PASS_NOT_AVAILABLE', 'You can only pass after drawing a playable card.');
  }
  clearPendingDraw(state);
  state.currentPlayerIndex = advanceIndex(state, state.currentPlayerIndex);
  return state;
}

export function removePlayer(state, playerId, random = Math.random) {
  const playerIndex = state.players.findIndex((player) => player.id === playerId);
  if (playerIndex === -1) return state;

  const [removedPlayer] = state.players.splice(playerIndex, 1);
  state.deck = shuffle([...state.deck, ...removedPlayer.hand], random);
  if (state.pendingDrawPlayerId === playerId) clearPendingDraw(state);

  if (state.players.length === 0) {
    state.status = 'Finished';
    state.winnerId = null;
    state.currentPlayerIndex = 0;
    return state;
  }

  if (removedPlayer.isHost) state.players[0].isHost = true;

  if (state.status === 'Playing') {
    if (state.players.length === 1) {
      state.status = 'Finished';
      state.winnerId = state.players[0].id;
      state.currentPlayerIndex = 0;
    } else if (playerIndex < state.currentPlayerIndex) {
      state.currentPlayerIndex -= 1;
    } else if (playerIndex === state.currentPlayerIndex) {
      state.currentPlayerIndex = state.direction === 1
        ? playerIndex % state.players.length
        : (playerIndex - 1 + state.players.length) % state.players.length;
    }
  }

  return state;
}

function requireCurrentPlayer(state, playerId) {
  if (state.status !== 'Playing') {
    throw new GameError('GAME_NOT_PLAYING', 'The game is not currently active.');
  }
  const player = state.players[state.currentPlayerIndex];
  if (!player || player.id !== playerId) {
    throw new GameError('NOT_YOUR_TURN', 'It is not your turn.');
  }
  return player;
}

function advanceIndex(state, index) {
  return (index + state.direction + state.players.length) % state.players.length;
}

function drawCards(state, player, count, random) {
  for (let index = 0; index < count; index += 1) {
    const card = drawOne(state, random);
    if (!card) break;
    player.hand.push(card);
  }
}

function drawOne(state, random) {
  if (state.deck.length === 0 && state.discardPile.length > 1) {
    const topCard = state.discardPile.pop();
    state.deck = shuffle(state.discardPile, random);
    state.discardPile = [topCard];
  }
  return state.deck.pop() || null;
}

function clearPendingDraw(state) {
  state.pendingDrawPlayerId = null;
  state.pendingDrawCardId = null;
}

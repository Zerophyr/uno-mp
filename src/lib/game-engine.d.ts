import type { Card, Color, GameState } from './types';

export const COLORS: Color[];
export const MAX_PLAYERS: number;
export const TURN_DURATION_MS: number;
export function canPlayCard(card: Card, state: GameState, hand?: Card[]): boolean;

import type { Card, Color, GameState } from './types';

export const COLORS: Color[];
export function canPlayCard(card: Card, state: GameState, hand?: Card[]): boolean;

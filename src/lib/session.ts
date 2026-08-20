import type { PlayerSession } from './types';

const PREFIX = 'uno-mp:session:';

export function savePlayerSession(session: PlayerSession): void {
  sessionStorage.setItem(`${PREFIX}${session.roomId}`, JSON.stringify(session));
}

export function loadPlayerSession(roomId: string): PlayerSession | null {
  const raw = sessionStorage.getItem(`${PREFIX}${roomId}`);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as Partial<PlayerSession>;
    if (
      session.roomId === roomId
      && typeof session.playerId === 'string'
      && typeof session.sessionToken === 'string'
    ) {
      return session as PlayerSession;
    }
  } catch {
    // Invalid session data is discarded below.
  }

  sessionStorage.removeItem(`${PREFIX}${roomId}`);
  return null;
}

export function clearPlayerSession(roomId: string): void {
  sessionStorage.removeItem(`${PREFIX}${roomId}`);
}

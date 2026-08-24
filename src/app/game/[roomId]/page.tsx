'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { canPlayCard } from '@/lib/game-engine';
import { emitWithAck, SocketRequestError } from '@/lib/protocol';
import { clearPlayerSession, loadPlayerSession } from '@/lib/session';
import { getSocket } from '@/lib/socket';
import type { Color, GameState } from '@/lib/types';

export default function GamePage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = params.roomId.toUpperCase();
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [playingCardId, setPlayingCardId] = useState<string | null>(null);
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [inviteCopied, setInviteCopied] = useState(false);
  const [removingPlayerId, setRemovingPlayerId] = useState<string | null>(null);

  const me = useMemo(() => state?.players.find((player) => player.id === playerId), [state, playerId]);
  const isMyTurn = useMemo(
    () => state?.status === 'Playing' && state.players[state.currentPlayerIndex]?.id === playerId,
    [state, playerId],
  );

  useEffect(() => {
    const socket = getSocket();
    const session = loadPlayerSession(roomId);
    if (!session) {
      const timer = window.setTimeout(() => {
        setActionError('No player session was found for this room. Join again from the homepage.');
        setLoading(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const handleState = (newState: GameState) => {
      setPlayerId(session.playerId);
      setState(newState);
      setClockOffsetMs(newState.serverNow - Date.now());
      setLoading(false);
      setActionError(null);
    };

    const resumeSession = async () => {
      try {
        await emitWithAck(socket, 'resume-room', session);
      } catch (requestError) {
        if (requestError instanceof SocketRequestError && requestError.code === 'INVALID_SESSION') {
          clearPlayerSession(roomId);
        }
        setActionError(requestError instanceof Error ? requestError.message : 'Unable to resume this game.');
        setLoading(false);
      }
    };

    const handleConnect = () => {
      if (!socket.recovered) void resumeSession();
    };
    const handleRemoved = ({ message }: { message?: string }) => {
      clearPlayerSession(roomId);
      router.push(`/?notice=${encodeURIComponent(message || 'You were removed from the room.')}`);
    };

    socket.on('state-updated', handleState);
    socket.on('removed-from-room', handleRemoved);
    socket.on('connect', handleConnect);
    if (socket.connected) void resumeSession();

    return () => {
      socket.off('state-updated', handleState);
      socket.off('removed-from-room', handleRemoved);
      socket.off('connect', handleConnect);
    };
  }, [roomId, router]);

  useEffect(() => {
    if (state?.status !== 'Playing') return;
    const updateClock = () => setNowMs(Date.now());
    updateClock();
    const timer = window.setInterval(updateClock, 250);
    return () => window.clearInterval(timer);
  }, [state?.status]);

  const runAction = async (eventName: string, payload: Record<string, unknown> = {}) => {
    setActionError(null);
    try {
      await emitWithAck(getSocket(), eventName, payload);
      return true;
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : 'The action failed.');
      return false;
    }
  };

  const handlePlayCard = async (cardId: string, chosenColor?: Color) => {
    const card = me?.hand.find((candidate) => candidate.id === cardId);
    if (!card) return;
    if (card.color === 'Wild' && !chosenColor) {
      setShowColorPicker(cardId);
      return;
    }

    setPlayingCardId(cardId);
    const succeeded = await runAction('play-card', { cardId, chosenColor });
    setPlayingCardId(null);
    if (succeeded) setShowColorPicker(null);
  };

  const handleLeaveRoom = async () => {
    if (await runAction('leave-room')) {
      clearPlayerSession(roomId);
      router.push('/');
    }
  };

  const handleCopyInvite = async () => {
    const inviteUrl = `${window.location.origin}/?room=${state?.roomId || roomId}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2_000);
    } catch {
      setActionError(`Share room code ${state?.roomId || roomId}.`);
    }
  };

  const handleRemovePlayer = async (targetPlayerId: string) => {
    setRemovingPlayerId(targetPlayerId);
    await runAction('remove-player', { playerId: targetPlayerId });
    setRemovingPlayerId(null);
  };

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-900 text-white">Loading...</div>;
  }
  if (!state) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-900 p-6 text-center text-white">{actionError || 'Room not found'}</div>;
  }

  if (state.status === 'Lobby') {
    return (
      <main className="flex min-h-screen flex-col items-center bg-slate-900 p-6 text-white">
        {actionError && <ErrorBanner message={actionError} />}
        <header className="mb-12 flex w-full max-w-md items-center justify-between">
          <div className="text-2xl font-black italic tracking-tighter text-red-500">UNO MP</div>
          <div className="flex items-center gap-2">
            <div className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400">
              ROOM: {state.roomId}
            </div>
            <button type="button" onClick={() => void handleCopyInvite()} className="rounded-full border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-slate-700">
              {inviteCopied ? 'COPIED ✓' : 'COPY INVITE'}
            </button>
          </div>
        </header>

        <button type="button" onClick={() => void handleLeaveRoom()} className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-white">Leave room</button>

        <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-800 p-8 shadow-2xl">
          <h2 className="mb-6 flex items-center gap-2 text-xl font-bold">
            Players <span className="rounded-md bg-slate-700 px-2 py-0.5 text-sm text-slate-400">{state.players.length}/{state.maxPlayers}</span>
          </h2>
          <div className="mb-8 space-y-3">
            {state.players.map((player) => (
              <div key={player.id} className={`flex items-center justify-between gap-3 rounded-xl border p-4 ${player.id === playerId ? 'border-red-500/30 bg-red-500/10' : 'border-slate-700 bg-slate-900'}`}>
                <div className="flex items-center gap-3">
                  <div className={`h-2 w-2 rounded-full ${player.isConnected ? 'bg-green-500' : 'bg-slate-500'}`} />
                  <div>
                    <div className="font-bold">{player.name} {player.id === playerId && '(You)'}</div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{player.isConnected ? 'Online' : 'Reconnecting'} • {player.wins} wins</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {player.isHost && <span className="rounded bg-yellow-500/20 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-yellow-500">Host</span>}
                  {me?.isHost && player.id !== playerId && (
                    <button type="button" onClick={() => void handleRemovePlayer(player.id)} disabled={Boolean(removingPlayerId)} className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-red-300 hover:bg-red-500/20 disabled:opacity-50">
                      {removingPlayerId === player.id ? 'REMOVING…' : 'REMOVE'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {me?.isHost ? (
            <button
              type="button"
              onClick={() => void runAction('start-game')}
              disabled={state.players.length < 2}
              className="w-full rounded-2xl bg-red-600 py-4 font-black text-white shadow-lg shadow-red-900/40 transition-all hover:bg-red-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              START GAME
            </button>
          ) : (
            <div className="animate-pulse text-center font-medium text-slate-500">Waiting for host to start...</div>
          )}
        </div>
      </main>
    );
  }

  const currentPlayer = state.players[state.currentPlayerIndex];

  return (
    <main className="flex min-h-screen flex-col overflow-hidden bg-slate-950 text-white">
      {actionError && <ErrorBanner message={actionError} />}
      <div className="flex gap-2 overflow-x-auto border-b border-white/5 bg-slate-900/50 p-3 backdrop-blur-md">
        {state.players.filter((player) => player.id !== playerId).map((player) => {
          const isActive = currentPlayer?.id === player.id;
          return (
            <div key={player.id} className={`min-w-[110px] flex-shrink-0 rounded-xl border p-2 transition-all motion-reduce:transition-none ${isActive ? 'scale-105 border-red-400 bg-red-500 shadow-lg shadow-red-500/20' : 'border-white/5 bg-slate-800/50'}`}>
              <div className="flex items-center gap-1 truncate text-[10px] font-bold uppercase tracking-tighter opacity-70"><span className={`h-1.5 w-1.5 rounded-full ${player.isConnected ? 'bg-green-300' : 'bg-slate-400'}`} />{player.name}</div>
              <div className="flex items-center justify-between text-lg font-black">
                {player.handCount}
                <span className="text-[9px] font-bold uppercase tracking-wider opacity-60">{player.wins}W</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="relative flex flex-grow flex-col items-center justify-center p-6">
        <div className="absolute right-4 top-4 flex items-center gap-2">
          <div className="rounded-full border border-white/10 bg-slate-800/80 px-3 py-1 text-[10px] font-bold tracking-widest text-slate-400 backdrop-blur-sm">
            ROUND {state.roundNumber} • {state.roomId}
          </div>
          <button
            type="button"
            onClick={() => void handleLeaveRoom()}
            className="rounded-full border border-white/10 bg-slate-800/80 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white"
          >
            Leave
          </button>
        </div>
        <div className="mb-8 flex items-center gap-3">
          <div className={`rounded-full border px-6 py-2 text-sm font-black uppercase tracking-widest transition-all motion-reduce:transition-none ${isMyTurn ? 'border-red-500 bg-red-600 shadow-xl shadow-red-900/40 motion-safe:animate-bounce' : 'border-white/5 bg-slate-800 opacity-50'}`}>
            {isMyTurn ? "IT'S YOUR TURN!" : `${currentPlayer?.name || 'Nobody'}'S TURN`}
          </div>
          <div role="timer" aria-label={`${turnSecondsRemaining(state, nowMs, clockOffsetMs)} seconds left in this turn`} className={`flex h-14 w-14 items-center justify-center rounded-full border-4 text-lg font-black tabular-nums ${turnSecondsRemaining(state, nowMs, clockOffsetMs) <= 5 ? 'border-yellow-300 bg-red-600 text-white motion-safe:animate-pulse' : 'border-white/20 bg-slate-800 text-white'}`}>
            {turnSecondsRemaining(state, nowMs, clockOffsetMs)}
          </div>
        </div>

        <div className="flex items-center gap-8">
          <button
            type="button"
            aria-label="Draw card"
            onClick={() => void runAction('draw-card')}
            disabled={!isMyTurn || state.canPass}
            className={`group relative h-36 w-24 rounded-xl border-2 bg-slate-800 transition-all ${isMyTurn && !state.canPass ? 'border-blue-500 shadow-2xl shadow-blue-500/20 active:scale-95' : 'border-white/5 opacity-40'}`}
          >
            <div className="absolute inset-2 flex items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-slate-900">
              <div className="-rotate-45 text-3xl font-black italic tracking-tighter text-red-500 opacity-20">UNO</div>
            </div>
            {isMyTurn && !state.canPass && <div className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-blue-500 text-xs font-black shadow-lg">DRAW</div>}
          </button>

          <div className="relative h-48 w-32">
            {state.discardPile.slice(-3).map((card, index) => (
              <div key={card.id} className="absolute inset-0 transition-transform duration-500" style={{ transform: `rotate(${(index - 1) * 5}deg) translate(${(index - 1) * 2}px, ${(index - 1) * 2}px)` }}>
                <Image src={`/cards/${card.filename}`} alt={describeCard(card)} width={128} height={192} className="h-full w-full rounded-xl border-2 border-white/10 object-contain shadow-2xl" />
              </div>
            ))}
            {state.discardPile.at(-1)?.color === 'Wild' && (
              <div className="absolute -right-4 -top-4 h-10 w-10 rounded-full border-4 border-slate-950 shadow-lg" style={{ backgroundColor: state.currentColor.toLowerCase() }} />
            )}
          </div>
        </div>
      </div>

      <div className={`border-t border-white/10 bg-slate-900/80 p-4 pb-10 backdrop-blur-xl transition-all ${isMyTurn ? 'ring-2 ring-red-500/50' : ''}`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Your Hand ({me?.hand.length || 0}) • {me?.wins || 0} wins</h3>
          <div className="flex w-full flex-wrap justify-end gap-3 sm:w-auto">
            {state.canPass && <button type="button" onClick={() => void runAction('pass-turn')} className="min-h-12 rounded-2xl bg-blue-500 px-6 py-3 text-sm font-black text-white shadow-lg shadow-blue-950/40 transition-transform active:scale-95">PASS</button>}
            {isMyTurn && (me?.hand.length || 0) === 2 && (
              <button
                type="button"
                onClick={() => void runAction('call-uno')}
                disabled={me?.hasCalledUno}
                className="min-h-14 flex-1 animate-pulse rounded-2xl border-4 border-white bg-yellow-400 px-6 py-3 text-lg font-black tracking-wide text-slate-950 shadow-2xl shadow-yellow-500/40 transition-transform hover:bg-yellow-300 active:scale-95 disabled:animate-none disabled:cursor-default disabled:border-yellow-100 disabled:bg-yellow-200 sm:min-h-16 sm:flex-none sm:px-10 sm:text-xl"
              >
                {me?.hasCalledUno ? 'UNO CALLED ✓' : 'CALL UNO!'}
              </button>
            )}
          </div>
        </div>

        <div className="-mx-2 flex snap-x gap-2 overflow-x-auto px-2 pb-4">
          {me?.hand.map((card) => {
            const playable = isMyTurn && canPlayCard(card, state, me.hand);
            return (
              <button
                type="button"
                key={card.id}
                disabled={!playable || Boolean(playingCardId)}
                onClick={() => void handlePlayCard(card.id)}
                aria-label={`Play ${describeCard(card)}`}
                className={`relative h-32 w-20 flex-shrink-0 snap-start transition-all motion-reduce:transition-none ${playable ? 'hover:-translate-y-4 active:scale-95' : 'opacity-40 grayscale-[0.5]'} ${playingCardId === card.id ? 'motion-safe:animate-bounce' : ''}`}
              >
                <Image src={`/cards/${card.filename}`} alt={describeCard(card)} width={80} height={128} className={`h-full w-full rounded-lg border object-contain shadow-xl ${playable ? 'border-white/20' : 'border-transparent'}`} />
              </button>
            );
          })}
        </div>
      </div>

      {showColorPicker && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-transparent p-4 pt-20 sm:items-center sm:p-6">
          <div className="w-full max-w-xs rounded-3xl border border-white/20 bg-slate-800/95 p-6 text-center shadow-2xl shadow-black/70 sm:p-8">
            <h3 className="mb-5 text-xl font-black">PICK A COLOR</h3>
            <div className="grid grid-cols-2 gap-4">
              {(['Red', 'Blue', 'Green', 'Yellow'] as Color[]).map((color) => (
                <button type="button" aria-label={`Choose ${color}`} key={color} onClick={() => void handlePlayCard(showColorPicker, color)} className="aspect-square rounded-2xl border-4 border-slate-900 shadow-xl transition-transform active:scale-90" style={{ backgroundColor: color.toLowerCase() }} />
              ))}
            </div>
            <button type="button" onClick={() => setShowColorPicker(null)} className="mt-5 min-h-11 w-full rounded-xl border border-white/20 bg-slate-900/80 px-4 py-2 text-sm font-black uppercase tracking-wider text-slate-200 hover:bg-slate-900">
              Cancel
            </button>
          </div>
        </div>
      )}

      {state.status === 'Finished' && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-y-auto bg-red-600/95 p-6 text-center">
          <div className="mb-3 text-7xl sm:text-8xl">🏆</div>
          <h2 className="mb-2 text-4xl font-black italic tracking-tighter sm:text-5xl">WINNER!</h2>
          <p className="mb-7 text-xl font-bold sm:text-2xl">{state.players.find((player) => player.id === state.winnerId)?.name}</p>
          <div className="mb-6 flex flex-wrap justify-center gap-2">
            {[...state.players].sort((left, right) => right.wins - left.wins).map((player) => (
              <span key={player.id} className="rounded-full bg-black/20 px-3 py-1 text-sm font-bold">{player.name}: {player.wins}</span>
            ))}
          </div>
          <div className="w-full max-w-sm space-y-3">
            <button
              type="button"
              onClick={() => void runAction('vote-rematch')}
              disabled={!state.canVoteRematch || state.hasVotedRematch}
              className="min-h-16 w-full rounded-2xl border-4 border-white bg-yellow-400 px-6 py-4 text-lg font-black text-slate-950 shadow-2xl transition-all hover:bg-yellow-300 active:scale-95 disabled:cursor-default disabled:border-yellow-100 disabled:bg-yellow-200 disabled:opacity-90"
            >
              {state.hasVotedRematch ? 'VOTE RECORDED ✓' : 'PLAY ANOTHER ROUND'}
            </button>
            <p className="text-sm font-bold text-white/90">
              {state.canVoteRematch
                ? `${state.rematchVoteCount} of ${state.rematchVotesRequired} votes needed`
                : 'Another player is required for a rematch'}
            </p>
            <button type="button" onClick={() => void handleLeaveRoom()} className="min-h-14 w-full rounded-2xl bg-white px-8 py-4 font-black text-red-600 shadow-2xl transition-all active:scale-95">BACK TO LOBBY</button>
          </div>
        </div>
      )}
    </main>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <div role="alert" className="w-full border-b border-red-500/30 bg-red-500/10 p-3 text-center text-sm text-red-200">{message}</div>;
}

function turnSecondsRemaining(state: GameState, nowMs: number, clockOffsetMs: number) {
  if (!state.turnDeadlineAt) return 0;
  return Math.max(0, Math.ceil((state.turnDeadlineAt - (nowMs + clockOffsetMs)) / 1_000));
}

function describeCard(card: { color: string; value: string }) {
  const value = card.value === 'DrawTwo'
    ? 'Draw Two'
    : card.value === 'WildDrawFour'
      ? 'Draw Four'
      : card.value;
  return card.color === 'Wild' ? `Wild ${value}`.replace('Wild Wild', 'Wild') : `${card.color} ${value}`;
}

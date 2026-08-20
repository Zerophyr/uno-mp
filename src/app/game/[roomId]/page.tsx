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

    socket.on('state-updated', handleState);
    socket.on('connect', handleConnect);
    if (socket.connected) void resumeSession();

    return () => {
      socket.off('state-updated', handleState);
      socket.off('connect', handleConnect);
    };
  }, [roomId]);

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
          <div className="rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400">
            ROOM: {state.roomId}
          </div>
        </header>

        <button type="button" onClick={() => void handleLeaveRoom()} className="mb-4 text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-white">Leave room</button>

        <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-800 p-8 shadow-2xl">
          <h2 className="mb-6 flex items-center gap-2 text-xl font-bold">
            Players <span className="rounded-md bg-slate-700 px-2 py-0.5 text-sm text-slate-400">{state.players.length}/10</span>
          </h2>
          <div className="mb-8 space-y-3">
            {state.players.map((player) => (
              <div key={player.id} className={`flex items-center justify-between rounded-xl border p-4 ${player.id === playerId ? 'border-red-500/30 bg-red-500/10' : 'border-slate-700 bg-slate-900'}`}>
                <div className="flex items-center gap-3">
                  <div className={`h-2 w-2 rounded-full ${player.id === playerId ? 'bg-red-500' : 'bg-green-500'}`} />
                  <span className="font-bold">{player.name} {player.id === playerId && '(You)'}</span>
                </div>
                {player.isHost && <span className="rounded bg-yellow-500/20 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-yellow-500">Host</span>}
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
            <div key={player.id} className={`min-w-[100px] flex-shrink-0 rounded-xl border p-2 transition-all ${isActive ? 'scale-105 border-red-400 bg-red-500 shadow-lg shadow-red-500/20' : 'border-white/5 bg-slate-800/50'}`}>
              <div className="truncate text-[10px] font-bold uppercase tracking-tighter opacity-70">{player.name}</div>
              <div className="flex items-center justify-between text-lg font-black">
                {player.handCount}
                <div className="h-4 w-3 rounded-sm border border-white/10 bg-white/20" />
              </div>
            </div>
          );
        })}
      </div>

      <div className="relative flex flex-grow flex-col items-center justify-center p-6">
        <div className="absolute right-4 top-4 flex items-center gap-2">
          <div className="rounded-full border border-white/10 bg-slate-800/80 px-3 py-1 text-[10px] font-bold tracking-widest text-slate-400 backdrop-blur-sm">
            ROOM: {state.roomId}
          </div>
          <button
            type="button"
            onClick={() => void handleLeaveRoom()}
            className="rounded-full border border-white/10 bg-slate-800/80 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white"
          >
            Leave
          </button>
        </div>
        <div className={`mb-8 rounded-full border px-6 py-2 text-sm font-black uppercase tracking-widest transition-all ${isMyTurn ? 'animate-bounce border-red-500 bg-red-600 shadow-xl shadow-red-900/40' : 'border-white/5 bg-slate-800 opacity-50'}`}>
          {isMyTurn ? "IT'S YOUR TURN!" : `${currentPlayer?.name || 'Nobody'}'S TURN`}
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
                <Image src={`/cards/${card.filename}`} alt={card.id} width={128} height={192} className="h-full w-full rounded-xl border-2 border-white/10 object-contain shadow-2xl" />
              </div>
            ))}
            {state.discardPile.at(-1)?.color === 'Wild' && (
              <div className="absolute -right-4 -top-4 h-10 w-10 rounded-full border-4 border-slate-950 shadow-lg" style={{ backgroundColor: state.currentColor.toLowerCase() }} />
            )}
          </div>
        </div>
      </div>

      <div className={`border-t border-white/10 bg-slate-900/80 p-4 pb-10 backdrop-blur-xl transition-all ${isMyTurn ? 'ring-2 ring-red-500/50' : ''}`}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Your Hand ({me?.hand.length || 0})</h3>
          <div className="flex gap-2">
            {state.canPass && <button type="button" onClick={() => void runAction('pass-turn')} className="rounded-full bg-blue-500 px-3 py-1 text-[10px] font-black text-white">PASS</button>}
            {(me?.hand.length || 0) === 2 && <button type="button" onClick={() => void runAction('call-uno')} className="animate-pulse rounded-full bg-yellow-500 px-3 py-1 text-[10px] font-black text-slate-950">UNO!</button>}
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
                className={`relative h-32 w-20 flex-shrink-0 snap-start transition-all ${playable ? 'hover:-translate-y-4 active:scale-95' : 'opacity-40 grayscale-[0.5]'} ${playingCardId === card.id ? 'animate-bounce' : ''}`}
              >
                <Image src={`/cards/${card.filename}`} alt={card.id} width={80} height={128} className={`h-full w-full rounded-lg border object-contain shadow-xl ${playable ? 'border-white/20' : 'border-transparent'}`} />
              </button>
            );
          })}
        </div>
      </div>

      {showColorPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-6 backdrop-blur-md">
          <div className="w-full max-w-xs rounded-3xl border border-white/10 bg-slate-800 p-8 text-center">
            <h3 className="mb-6 text-xl font-black">PICK A COLOR</h3>
            <div className="grid grid-cols-2 gap-4">
              {(['Red', 'Blue', 'Green', 'Yellow'] as Color[]).map((color) => (
                <button type="button" aria-label={`Choose ${color}`} key={color} onClick={() => void handlePlayCard(showColorPicker, color)} className="aspect-square rounded-2xl border-4 border-slate-900 shadow-xl transition-transform active:scale-90" style={{ backgroundColor: color.toLowerCase() }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {state.status === 'Finished' && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-red-600/95 p-6">
          <div className="mb-4 text-8xl">🏆</div>
          <h2 className="mb-2 text-5xl font-black italic tracking-tighter">WINNER!</h2>
          <p className="mb-8 text-2xl font-bold">{state.players.find((player) => player.id === state.winnerId)?.name}</p>
          <button type="button" onClick={() => { clearPlayerSession(roomId); router.push('/'); }} className="rounded-2xl bg-white px-8 py-4 font-black text-red-600 shadow-2xl transition-all active:scale-95">BACK TO LOBBY</button>
        </div>
      )}
    </main>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <div role="alert" className="w-full border-b border-red-500/30 bg-red-500/10 p-3 text-center text-sm text-red-200">{message}</div>;
}

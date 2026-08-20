'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { emitWithAck } from '@/lib/protocol';
import { getSocket } from '@/lib/socket';
import type { GameState } from '@/lib/types';

export default function ConsolePage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId.toUpperCase();
  const [state, setState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const handleState = (newState: GameState) => {
      setState(newState);
      setLoading(false);
      setError(null);
    };
    const watchRoom = async () => {
      try {
        await emitWithAck(socket, 'watch-room', { roomId });
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Unable to open console mode.');
        setLoading(false);
      }
    };
    const handleConnect = () => {
      if (!socket.recovered) void watchRoom();
    };

    socket.on('state-updated', handleState);
    socket.on('connect', handleConnect);
    if (socket.connected) void watchRoom();

    return () => {
      socket.off('state-updated', handleState);
      socket.off('connect', handleConnect);
    };
  }, [roomId]);

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-4xl font-black italic text-white animate-pulse">UNO MP</div>;
  if (!state) return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-8 text-center text-white">{error || `Room ${roomId} not found`}</div>;

  if (state.status === 'Lobby') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center border-[20px] border-slate-900 bg-slate-950 p-12 text-white">
        <div className="mb-4 animate-bounce text-8xl font-black italic tracking-tighter text-red-500">UNO MP</div>
        <div className="mb-16 text-3xl font-bold uppercase tracking-[0.3em] text-slate-500">Multiplayer Console</div>
        <div className="flex flex-col items-center rounded-[4rem] border-4 border-slate-800 bg-slate-900 p-16 text-center shadow-2xl">
          <div className="mb-4 text-xl font-black uppercase tracking-widest text-slate-400">Room Code</div>
          <div className="mb-12 text-9xl font-black tracking-tighter text-white">{state.roomId}</div>
          <div className="w-full max-w-xl">
            <h3 className="mb-8 text-2xl font-bold text-slate-500">PLAYERS JOINED ({state.players.length})</h3>
            <div className="flex flex-wrap justify-center gap-4">
              {state.players.map((player) => (
                <div key={player.id} className="rounded-3xl border-2 border-slate-700 bg-slate-800 px-8 py-4 text-2xl font-black">{player.name}</div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-16 flex items-center gap-4 font-bold text-slate-600"><div className="h-3 w-3 animate-ping rounded-full bg-red-500" />LIVE SESSION ACTIVE</div>
      </main>
    );
  }

  const currentPlayer = state.players[state.currentPlayerIndex];

  return (
    <main className="flex min-h-screen flex-col border-[20px] bg-slate-950 p-12 text-white transition-colors duration-500" style={{ borderColor: state.currentColor.toLowerCase() }}>
      <div className="mb-8 flex items-start justify-between">
        <div>
          <div className="mb-1 text-4xl font-black italic tracking-tighter text-red-500">UNO MP</div>
          <div className="text-sm font-black uppercase tracking-widest text-slate-500">CONSOLE MODE • {state.roomId}</div>
        </div>
        <div className="flex flex-col items-end">
          <div className="mb-2 text-xl font-black">DIRECTION</div>
          <div className={`text-4xl transition-all duration-500 ${state.direction === 1 ? 'rotate-0' : 'rotate-180'}`}>{state.direction === 1 ? '↻' : '↺'}</div>
        </div>
      </div>

      <div className="flex flex-grow items-center justify-center gap-24">
        <div className="flex w-80 flex-col gap-6">
          {state.players.map((player, index) => {
            const isActive = state.currentPlayerIndex === index;
            return (
              <div key={player.id} className={`flex items-center justify-between rounded-[2rem] border-4 p-6 transition-all duration-300 ${isActive ? 'scale-110 border-white bg-white text-slate-950 shadow-2xl' : 'border-slate-800 bg-slate-900 opacity-40'}`}>
                <div>
                  <div className="mb-1 text-xs font-black uppercase tracking-widest opacity-50">{index + 1}. PLAYER</div>
                  <div className="truncate text-2xl font-black">{player.name}</div>
                </div>
                <div className="text-4xl font-black italic">{player.handCount}</div>
              </div>
            );
          })}
        </div>

        <div className="relative">
          <div className="absolute inset-0 rounded-full opacity-30 blur-[120px] transition-all duration-700" style={{ backgroundColor: state.currentColor.toLowerCase() }} />
          <div className="relative z-10 flex flex-col items-center">
            <div className="mb-12 text-center">
              <div className="mb-2 text-sm font-black uppercase tracking-[0.5em] text-slate-500">CURRENT TURN</div>
              <div className="text-7xl font-black tracking-tighter">{currentPlayer?.name || '—'}</div>
            </div>
            <div className="relative h-[30rem] w-80">
              {state.discardPile.slice(-5).map((card, index) => (
                <div key={card.id} className="absolute inset-0 transition-all duration-700 ease-out" style={{ transform: `rotate(${(index - 2) * 8 + Math.sin(index) * 5}deg) translate(${(index - 2) * 10}px, ${(index - 2) * 5}px)`, zIndex: index }}>
                  <Image src={`/cards/${card.filename}`} alt={card.id} width={320} height={480} className="h-full w-full rounded-[2.5rem] border-4 border-white/5 object-contain shadow-2xl" />
                </div>
              ))}
            </div>
            <div className="mt-12 flex items-center gap-6 rounded-full border-2 border-slate-800 bg-slate-900/80 px-10 py-5 backdrop-blur-xl">
              <div className="text-xl font-black uppercase tracking-widest text-slate-400">ACTIVE COLOR</div>
              <div className="h-12 w-12 rounded-full border-4 border-slate-950 shadow-inner" style={{ backgroundColor: state.currentColor.toLowerCase() }} />
              <div className="text-3xl font-black uppercase" style={{ color: state.currentColor.toLowerCase() }}>{state.currentColor}</div>
            </div>
          </div>
        </div>
      </div>

      {state.status === 'Finished' && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-slate-950">
          <div className="mb-8 text-[12rem] animate-bounce">👑</div>
          <h2 className="mb-4 text-2xl font-black uppercase tracking-[1em] text-yellow-500 opacity-50">WE HAVE A WINNER</h2>
          <div className="mb-12 bg-gradient-to-b from-white to-slate-500 bg-clip-text text-9xl font-black italic tracking-tighter text-transparent">{state.players.find((player) => player.id === state.winnerId)?.name}</div>
        </div>
      )}
    </main>
  );
}

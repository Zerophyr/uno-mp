'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { emitWithAck, SocketRequestError } from '@/lib/protocol';
import { savePlayerSession } from '@/lib/session';
import { getSocket } from '@/lib/socket';
import type { PlayerSession } from '@/lib/types';

export default function Home() {
  const [roomId, setRoomId] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const enterGame = (session: PlayerSession) => {
    savePlayerSession(session);
    router.push(`/game/${session.roomId}`);
  };

  const handleCreateRoom = async () => {
    if (!playerName.trim()) {
      setError('Please enter your name.');
      return;
    }

    setPendingAction('create');
    setError(null);
    try {
      const { session } = await emitWithAck<{ session: PlayerSession }>(
        getSocket(),
        'create-room',
        { playerName },
      );
      enterGame(session);
    } catch (requestError) {
      setError(requestError instanceof SocketRequestError ? requestError.message : 'Unable to create the room.');
    } finally {
      setPendingAction(null);
    }
  };

  const handleJoinRoom = async () => {
    if (!playerName.trim() || !roomId.trim()) {
      setError('Please enter your name and room code.');
      return;
    }

    setPendingAction('join');
    setError(null);
    try {
      const { session } = await emitWithAck<{ session: PlayerSession }>(
        getSocket(),
        'join-room',
        { roomId, playerName },
      );
      enterGame(session);
    } catch (requestError) {
      setError(requestError instanceof SocketRequestError ? requestError.message : 'Unable to join the room.');
    } finally {
      setPendingAction(null);
    }
  };

  const handleConsoleMode = () => {
    const normalizedRoomId = roomId.trim().toUpperCase();
    if (!normalizedRoomId) {
      setError('Please enter a room code.');
      return;
    }
    router.push(`/console/${normalizedRoomId}`);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-6 font-sans text-white">
      <div className="w-full max-w-md space-y-8 rounded-2xl border border-slate-700 bg-slate-800 p-8 shadow-xl">
        <div className="text-center">
          <h1 className="mb-2 bg-gradient-to-br from-yellow-400 via-red-500 to-blue-500 bg-clip-text text-5xl font-black italic tracking-tighter text-transparent">
            UNO MP
          </h1>
          <p className="font-medium text-slate-400">Multiplayer Card Game</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="player-name" className="ml-1 text-xs font-bold uppercase tracking-widest text-slate-500">
              Your Nickname
            </label>
            <input
              id="player-name"
              type="text"
              maxLength={24}
              autoComplete="nickname"
              placeholder="e.g. Alex"
              className="w-full rounded-xl border border-slate-700 bg-slate-900 p-4 outline-none transition-all placeholder:text-slate-600 focus:ring-2 focus:ring-red-500"
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 pt-4">
            <button
              type="button"
              onClick={handleCreateRoom}
              disabled={pendingAction !== null}
              className="w-full rounded-xl bg-gradient-to-r from-red-600 to-red-500 p-4 font-bold text-white shadow-lg shadow-red-900/20 transition-all hover:from-red-500 hover:to-red-400 active:scale-95 disabled:opacity-50"
            >
              {pendingAction === 'create' ? 'Creating...' : 'HOST NEW GAME'}
            </button>
          </div>

          <div className="relative flex items-center py-4">
            <div className="flex-grow border-t border-slate-700" />
            <span className="mx-4 flex-shrink text-xs font-bold text-slate-500">OR JOIN ROOM</span>
            <div className="flex-grow border-t border-slate-700" />
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="room-code" className="ml-1 text-xs font-bold uppercase tracking-widest text-slate-500">
                Room Code
              </label>
              <input
                id="room-code"
                type="text"
                maxLength={6}
                autoCapitalize="characters"
                placeholder="ABCD12"
                className="w-full rounded-xl border border-slate-700 bg-slate-900 p-4 uppercase outline-none transition-all placeholder:text-slate-600 focus:ring-2 focus:ring-blue-500"
                value={roomId}
                onChange={(event) => setRoomId(event.target.value.toUpperCase())}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleJoinRoom}
                disabled={pendingAction !== null}
                className="rounded-xl bg-blue-600 p-4 font-bold text-white transition-all hover:bg-blue-500 active:scale-95 disabled:opacity-50"
              >
                {pendingAction === 'join' ? 'JOINING...' : 'JOIN AS PLAYER'}
              </button>
              <button
                type="button"
                onClick={handleConsoleMode}
                disabled={pendingAction !== null}
                className="rounded-xl bg-slate-700 p-4 font-bold text-white transition-all hover:bg-slate-600 active:scale-95 disabled:opacity-50"
              >
                CONSOLE MODE
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

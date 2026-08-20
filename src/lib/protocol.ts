import type { Socket } from 'socket.io-client';

export type SocketFailure = {
  ok: false;
  error: { code: string; message: string };
};

export type SocketSuccess<T> = { ok: true } & T;
export type SocketResponse<T> = SocketSuccess<T> | SocketFailure;

export class SocketRequestError extends Error {
  constructor(
    message: string,
    public readonly code = 'REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'SocketRequestError';
  }
}

export function emitWithAck<T>(
  socket: Socket,
  eventName: string,
  payload: object = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(8_000).emit(
      eventName,
      payload,
      (timeoutError: Error | null, response: SocketResponse<T>) => {
        if (timeoutError) {
          reject(new SocketRequestError('The server did not respond in time.', 'TIMEOUT'));
        } else if (!response?.ok) {
          reject(new SocketRequestError(response?.error?.message || 'Request failed.', response?.error?.code));
        } else {
          const data = Object.fromEntries(
            Object.entries(response).filter(([key]) => key !== 'ok'),
          );
          resolve(data as T);
        }
      },
    );
  });
}

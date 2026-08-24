# UNO MP

A self-hosted, real-time multiplayer UNO game for personal devices and shared displays.

## Features

- Mobile hand view: each authenticated player sees only their own cards.
- Optional public console view for a shared display.
- Server-authoritative rules and turn validation over Socket.IO.
- Session recovery after a temporary disconnect.
- Four-player rooms with live presence, host lobby controls, and shareable invite links.
- A server-authoritative 15-second turn timer with automatic draw-and-pass.
- Majority-vote rematches with persistent round wins.
- Redis persistence with a rolling-safe 24-hour room lifetime.
- Docker Compose deployment with application and Redis health checks.

## Stack

- **Framework**: [Next.js 16](https://nextjs.org/)
- **Server**: Custom Node.js/Express server.
- **Real-time**: [Socket.IO](https://socket.io/)
- **State Storage**: [Redis](https://redis.io/)
- **Styling**: Tailwind CSS 4
- **Orchestration**: Docker Compose

## Run with Docker Compose

1. Clone the repository:

   ```bash
   git clone https://github.com/Zerophyr/uno-mp.git
   cd uno-mp
   ```

2. Build and start the stack:

   ```bash
   docker compose up --build -d
   ```

3. Open `http://localhost:3000`. The console view is available at
   `http://localhost:3000/console/ROOM_ID`.

The application container is named `uno-mp`; Redis is internal-only and named
`uno-mp-redis`. The Compose volume retains active rooms across restarts.

## Local development

With Redis listening at `redis://localhost:6379`:

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Start the development server:

   ```bash
   npm run dev
   ```

Use `REDIS_URL`, `PORT`, `HOSTNAME`, and `TURN_DURATION_MS` to override the
defaults. Run the checks with `npm test`, `npm run lint`, and `npm run build`.
The default turn duration is 15,000 milliseconds.

The production browser flow can be checked with `npm run test:e2e`. This command
builds an isolated Docker Compose stack, runs the Playwright multiplayer test,
and removes the test containers and volume afterward. Install its Chromium
runtime once with `npx playwright install chromium`.

## Deployment

Route the public hostname to container port `3000`. Do not expose Redis. Both
services include health checks, and the app waits for Redis to become healthy.

## Implemented rules

- **Matching**: Color, number, or symbol.
- **Action Cards**: Skip, Reverse, Draw Two.
- **Wild Cards**: Wild, Wild Draw Four.
- **Winning**: Be the first to clear your hand.
- **Draw flow**: Draw once, then play the drawn card or pass.
- **UNO**: Call UNO before playing the second-to-last card or draw a penalty.
- **Turn time**: Play or draw within 15 seconds; expiry draws one card and passes.
- **Disconnects**: Active players keep their seat and time out normally so turn
  order and hands are not changed mid-round.

---
Originally created by [bizkut](https://github.com/bizkut).

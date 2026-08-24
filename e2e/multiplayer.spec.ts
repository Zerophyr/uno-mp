import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

async function createPlayerPage(context: BrowserContext) {
  return context.newPage();
}

async function joinRoom(page: Page, roomId: string, playerName: string) {
  await page.goto(`/?room=${roomId}`);
  await expect(page.getByRole('textbox', { name: 'Room Code' })).toHaveValue(roomId);
  await page.getByRole('textbox', { name: 'Your Nickname' }).fill(playerName);
  await page.getByRole('button', { name: 'JOIN AS PLAYER' }).click();
  await expect(page).toHaveURL(new RegExp(`/game/${roomId}$`));
}

async function verifyMultiplayerFlow(browser: Browser, viewport: { width: number; height: number }) {
  const contexts: BrowserContext[] = [];
  const createContext = async () => {
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport,
    });
    contexts.push(context);
    return context;
  };

  try {
    const hostContext = await createContext();
    const hostPage = await createPlayerPage(hostContext);
    await hostPage.goto('/');
    await hostPage.getByRole('textbox', { name: 'Your Nickname' }).fill('Host');
    await hostPage.getByRole('button', { name: 'HOST NEW GAME' }).click();
    await expect(hostPage).toHaveURL(/\/game\/[A-Z0-9]{6}$/);
    const roomId = new URL(hostPage.url()).pathname.split('/').at(-1) || '';

    await hostPage.getByRole('button', { name: 'COPY INVITE' }).click();
    await expect(hostPage.getByRole('button', { name: 'COPIED ✓' })).toBeVisible();
    const inviteUrl = await hostPage.evaluate(() => navigator.clipboard.readText());
    expect(inviteUrl).toContain(`?room=${roomId}`);

    const playerPages: Page[] = [hostPage];
    for (const playerName of ['Second', 'Third', 'Fourth']) {
      const context = await createContext();
      const page = await createPlayerPage(context);
      await joinRoom(page, roomId, playerName);
      playerPages.push(page);
    }

    await expect(hostPage.getByText('4/4', { exact: true })).toBeVisible();
    await expect(hostPage.getByRole('button', { name: 'START GAME' })).toBeEnabled();

    const fifthContext = await createContext();
    const fifthPage = await createPlayerPage(fifthContext);
    await fifthPage.goto(inviteUrl);
    await fifthPage.getByRole('textbox', { name: 'Your Nickname' }).fill('Fifth');
    await fifthPage.getByRole('button', { name: 'JOIN AS PLAYER' }).click();
    await expect(fifthPage.getByText('This room already has 4 players.')).toBeVisible();

    await hostPage.getByRole('button', { name: 'START GAME' }).click();
    for (const page of playerPages) {
      await expect(page.getByRole('heading', { name: /Your Hand \(\d+\)/ })).toBeVisible();
      await expect(page.getByRole('timer')).toHaveText(/^\d+$/);
      await expect(page.getByText(/ROUND 1/)).toBeVisible();
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
}

test('supports the complete four-player flow on mobile', async ({ browser }) => {
  await verifyMultiplayerFlow(browser, { width: 390, height: 844 });
});

test('supports the complete four-player flow on desktop', async ({ browser }) => {
  await verifyMultiplayerFlow(browser, { width: 1280, height: 800 });
});

/**
 * The mobile shell at `/m`, on a phone-sized touch screen (the `iphone` and
 * `pixel` projects in playwright.config.ts).
 *
 * As in console.e2e.ts, every assertion is about rendered content: a shell
 * that mounts and draws nothing must fail here, not pass.
 */
import { test, expect, type Page } from '@playwright/test';
import { startStubServer, type StubServer } from './stub-server';
import {
  ASK_OPTION_LABEL,
  ASK_QUESTION,
  ASSISTANT_PROSE,
  CHAT_ID,
  CHAT_TITLE,
  OTHER_CHAT_ID,
  OTHER_CHAT_TEXT,
  OTHER_CHAT_TITLE,
  PROJECT_SHORT_NAME,
  USER_TURN_TEXT,
} from './fixtures';

let server: StubServer;

test.beforeAll(async () => {
  server = await startStubServer();
});

test.afterAll(async () => {
  if (server.unhandled.length > 0) {
    console.warn(
      `Mobile API calls with no stub:\n  ${[...new Set(server.unhandled)].join('\n  ')}`
    );
  }
  await server.close();
});

/** Open a shell path and prove the shell mounted without throwing. */
async function open(page: Page, path: string): Promise<void> {
  const thrown: string[] = [];
  page.on('pageerror', error => thrown.push(error.message));
  await page.goto(`${server.url}${path}`);
  await expect(page.locator('.mobile-root')).toBeVisible();
  expect(thrown, 'the mobile shell threw while rendering').toEqual([]);
}

const chatPath = (id: string): string => `/m/c/${encodeURIComponent(id)}`;

test('/m reopens the chat last open on this phone', async ({ page }) => {
  await page.addInitScript(id => {
    localStorage.setItem('archon.mobile.lastChat', id);
  }, OTHER_CHAT_ID);
  await open(page, '/m');

  // The URL alone would pass on a redirect to a blank screen; the transcript
  // is what says the right chat opened.
  await expect(page).toHaveURL(new RegExp(`${chatPath(OTHER_CHAT_ID)}$`));
  await expect(page.getByText(OTHER_CHAT_TEXT)).toBeVisible();
});

test('/m with nothing remembered opens the chat list', async ({ page }) => {
  await open(page, '/m');
  const list = page.getByRole('navigation', { name: 'Chats' });
  await expect(list.getByText(CHAT_TITLE)).toBeVisible();
  await expect(list.getByText(OTHER_CHAT_TITLE)).toBeVisible();
  await expect(page).toHaveURL(/\/m$/);
});

test('a chat shows its transcript, fitted to the phone', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  await expect(page.getByRole('heading', { name: CHAT_TITLE })).toBeVisible();
  await expect(page.getByText(`${PROJECT_SHORT_NAME} ▸`)).toBeVisible();
  // Both turns: a stream that drew only one side would pass on either alone.
  await expect(page.getByText(USER_TURN_TEXT)).toBeVisible();
  await expect(page.getByText(ASSISTANT_PROSE)).toBeVisible();
  // Every panel under the transcript loaded: a failed read renders as text,
  // and text is what everything above looks for.
  await expect(page.getByText(/couldn.t load|failed to load/i)).toHaveCount(0);

  // Nothing wider than the screen: a desktop layout squeezed onto a phone
  // renders its text too, and scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // The composer sits at the bottom of the screen, not somewhere mid-page.
  const composer = page.getByRole('textbox', { name: 'Message' });
  const box = await composer.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  expect(box).not.toBeNull();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(height - 100);
});

test('sending a message puts it in the chat', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  const composer = page.getByRole('textbox', { name: 'Message' });
  const send = page.getByRole('button', { name: 'Send' });
  // Disabled while empty: half the proof that Send is wired to the text.
  await expect(send).toBeDisabled();

  await composer.fill('Sent from a phone.');
  await send.tap();

  // The stub queues every send, as a server at its cap does, so the message
  // shows as queued — once, and the box is empty again.
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText('Sent from a phone.')).toBeVisible();
  await expect(page.getByText('Sent from a phone.')).toHaveCount(1);
  await expect(composer).toHaveValue('');
});

test('an ask card answers with a tap, on finger-sized rows', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  await expect(page.getByText(ASK_QUESTION)).toBeVisible();
  const option = page.getByRole('button', { name: new RegExp(ASK_OPTION_LABEL) });
  const row = await option.boundingBox();
  expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);

  await option.tap();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Submit all 1' }).tap();

  // The answer is sent: it is in the queue, and not also echoed as sent.
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText(ASK_QUESTION)).toBeVisible();
  await expect(page.getByText(ASK_QUESTION)).toHaveCount(2);
});

test('the switcher lists chats by status and opens the one tapped', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  // The unread chat is counted on the button that opens the list.
  await page.getByRole('button', { name: 'Open chat list, 1 need you' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Switch chat' });
  await expect(sheet).toBeVisible();

  // Unread before idle, though the idle chat is the newer: by status, not by
  // recency. Reading the order is the assertion — both titles alone would
  // pass against a list in any order.
  const rows = sheet.getByRole('link');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(OTHER_CHAT_TITLE);
  await expect(rows.nth(0)).toContainText('Unread');
  await expect(rows.nth(1)).toContainText(CHAT_TITLE);
  await expect(rows.nth(1)).toContainText('Idle');

  await rows.nth(0).tap();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`${chatPath(OTHER_CHAT_ID)}$`));
  await expect(page.getByText(OTHER_CHAT_TEXT)).toBeVisible();
  await expect(page.getByText(USER_TURN_TEXT)).toHaveCount(0);
});

test('the shell is installable, and scoped to /m', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).not.toBeNull();
  const manifest = (await page.evaluate(async url => {
    const res = await fetch(url);
    return (await res.json()) as unknown;
  }, href ?? '')) as { start_url?: string; scope?: string; display?: string };
  expect(manifest).toMatchObject({ start_url: '/m/', scope: '/m/', display: 'standalone' });

  // The worker registered, for the shell's scope and no wider.
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe('/m/');
});

test('the desktop console on a phone offers the mobile view, once', async ({ page }) => {
  await page.goto(`${server.url}/console`);
  const banner = page.getByRole('region', { name: 'Mobile view' });
  await expect(banner).toBeVisible();
  // The desktop console carries none of the shell's install surface.
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);

  await banner.getByRole('button', { name: 'Dismiss' }).tap();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(page.locator('.console-root')).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test('coming back from the background reopens the streams and rereads the chat', async ({
  page,
}) => {
  const asked: string[] = [];
  page.on('request', request => asked.push(new URL(request.url()).pathname));
  await open(page, chatPath(CHAT_ID));
  await expect(page.getByText(ASSISTANT_PROSE)).toBeVisible();

  const count = (path: string): number => asked.filter(p => p === path).length;
  const dashboard = '/api/stream/__dashboard__';
  const chatStream = `/api/stream/${CHAT_ID}`;
  const messages = `/api/conversations/${CHAT_ID}/messages`;
  const before = [count(dashboard), count(chatStream), count(messages)];

  // What iOS does to a PWA sent to the background and brought back.
  const setVisibility = (state: 'hidden' | 'visible'): Promise<void> =>
    page.evaluate(value => {
      Object.defineProperty(document, 'visibilityState', { value, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  await setVisibility('hidden');
  await setVisibility('visible');

  await expect.poll(() => count(dashboard)).toBeGreaterThan(before[0] ?? 0);
  await expect.poll(() => count(chatStream)).toBeGreaterThan(before[1] ?? 0);
  await expect.poll(() => count(messages)).toBeGreaterThan(before[2] ?? 0);
});

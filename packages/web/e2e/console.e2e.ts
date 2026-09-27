/**
 * The console, in a browser, doing the four things a person needs it to do.
 *
 * Every assertion here is about RENDERED CONTENT, never about a status code or
 * a request having been made. The failure this suite exists for is a bundle
 * that loads, answers 200, and shows nothing — so an assertion a blank page
 * could also satisfy is not one worth writing, and the note beside each test
 * says what stops it being that.
 */
import { test, expect, type Page } from '@playwright/test';
import { startStubServer, type StubServer } from './stub-server';
import {
  ASK_OPTION_DETAIL,
  ASK_OPTION_LABEL,
  ASK_QUESTION,
  ASK_SECOND_OPTION_LABEL,
  ASSISTANT_PROSE,
  CHAT_TITLE,
  OTHER_CHAT_TEXT,
  OTHER_CHAT_TITLE,
  PROJECT_ID,
  PROJECT_SHORT_NAME,
  USER_TURN_TEXT,
} from './fixtures';

let server: StubServer;

test.beforeAll(async () => {
  server = await startStubServer();
});

test.afterAll(async () => {
  // Reported, not asserted. A console call this stub does not answer is worth
  // seeing — it is how a new API dependency shows up — but a route the console
  // handles a 404 from is not a broken console, and failing on one would make
  // this suite red for a change it is not about.
  if (server.unhandled.length > 0) {
    console.warn(
      `Console API calls with no stub:\n  ${[...new Set(server.unhandled)].join('\n  ')}`
    );
  }
  await server.close();
});

/**
 * Open the project's chat screen and prove the app mounted.
 *
 * The two checks here are what turn every later failure into a readable one.
 * `.console-root` is the element the whole console hangs off, so its absence
 * says "nothing rendered" rather than "this one selector was missing"; and a
 * script error is reported as itself, because React's error boundary replaces
 * the app with "Something went wrong" and every assertion after that fails for
 * the wrong-looking reason.
 *
 * No chat id in the URL, because the console does not take one: it opens the
 * remembered chat, or the newest. A fresh browser context remembers nothing, so
 * this lands on the first chat in the fixture — the one with the transcript.
 */
async function openChatScreen(page: Page): Promise<void> {
  const thrown: string[] = [];
  page.on('pageerror', error => thrown.push(error.message));
  await page.goto(`${server.url}/console/p/${PROJECT_ID}/chat`);
  await expect(page.locator('.console-root')).toBeVisible();
  expect(thrown, 'the console threw while rendering').toEqual([]);
}

test('the project rail lists the project and its chats', async ({ page }) => {
  await openChatScreen(page);

  // The project rail, asserted by NAME rather than by row count: a rail that
  // renders the right number of empty rows is the blank page in disguise.
  const projectRail = page.locator('#project-navigation');
  await expect(projectRail).toBeVisible();
  await expect(projectRail.getByText(PROJECT_SHORT_NAME, { exact: false }).first()).toBeVisible();

  // The chat rail, and BOTH chats in it. One title would pass against a list
  // that renders only its first row.
  const chats = page.getByLabel('Chats');
  await expect(chats).toBeVisible();
  await expect(chats.getByText(CHAT_TITLE)).toBeVisible();
  await expect(chats.getByText(OTHER_CHAT_TITLE)).toBeVisible();
});

test('opening a chat shows its transcript', async ({ page }) => {
  await openChatScreen(page);

  // The chat the console landed on. Both turns, because the user's turn is the
  // half a stream that rendered only assistant messages would drop silently.
  await expect(page.getByText(USER_TURN_TEXT)).toBeVisible();
  await expect(page.getByText(ASSISTANT_PROSE)).toBeVisible();

  // Now open the OTHER chat from the rail. Its transcript replaces the first
  // one — a stream that rendered whatever it loaded once and never again would
  // pass the assertions above and fail these.
  await page.getByLabel('Chats').getByText(OTHER_CHAT_TITLE).click();
  await expect(page.getByText(OTHER_CHAT_TEXT)).toBeVisible();
  await expect(page.getByText(USER_TURN_TEXT)).toHaveCount(0);
});

test('the composer accepts text and enables Send only once there is some', async ({ page }) => {
  await openChatScreen(page);

  const composer = page.getByPlaceholder('Message the agent…');
  await expect(composer).toBeEnabled();

  // Empty is the disabled state, and it is half the assertion: a Send button
  // that is always enabled passes the other half on its own.
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled();

  await composer.fill('The composer took this text.');
  await expect(composer).toHaveValue('The composer took this text.');
  await expect(send).toBeEnabled();
});

test('New chat puts the cursor in the message box', async ({ page }) => {
  await openChatScreen(page);
  const composer = page.getByPlaceholder('Message the agent…');
  // Focus elsewhere first: a composer that was already focused would pass
  // without New chat doing anything.
  await page.getByLabel('Chats').getByText(OTHER_CHAT_TITLE).click();
  await expect(composer).not.toBeFocused();

  await page.getByRole('button', { name: 'New chat' }).first().click();
  await expect(composer).toBeFocused();

  // Typing straight away lands in the box — the point of the focus.
  await page.keyboard.type('straight in');
  await expect(composer).toHaveValue('straight in');
});

test('C starts a new chat, and does nothing while typing', async ({ page }) => {
  await openChatScreen(page);
  const composer = page.getByPlaceholder('Message the agent…');
  await expect(page.getByText(USER_TURN_TEXT)).toBeVisible();

  // Typed into the box, `c` is a letter, not a shortcut.
  await composer.fill('');
  await composer.focus();
  await page.keyboard.type('cc');
  await expect(composer).toHaveValue('cc');
  await expect(page.getByText(USER_TURN_TEXT)).toBeVisible();

  // Outside the box it opens a new chat, and the cursor lands in its composer
  // without the key itself being typed there.
  await composer.blur();
  await page.keyboard.press('c');
  await expect(page.getByText(USER_TURN_TEXT)).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');
});

test('an ask block renders as clickable cards, not a JSON code block', async ({ page }) => {
  await openChatScreen(page);

  // The fallback FIRST, because it is the failure that looks like success. A
  // console that did not recognise the fence renders the block's JSON in a
  // <pre>, which is legible — every question and option is still there — so a
  // text assertion passes against it. This is the one that tells them apart.
  await expect(page.getByText(ASK_QUESTION)).toBeVisible();
  await expect(page.locator('pre', { hasText: '"questions"' })).toHaveCount(0);

  // Clickable: the option is a button that records being chosen. A card that
  // rendered its labels as plain text would satisfy everything above.
  const option = page.getByRole('button', { name: new RegExp(ASK_OPTION_LABEL) });
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute('aria-pressed', 'false');
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');

  // The option's supporting detail and the choice beside it: a card that drew
  // only the recommended option would still be the wrong question on screen.
  await expect(page.getByText(ASK_OPTION_DETAIL)).toBeVisible();
  await expect(
    page.getByRole('button', { name: new RegExp(ASK_SECOND_OPTION_LABEL) })
  ).toBeVisible();
});

test('an answer the server queues shows once, as queued', async ({ page }) => {
  await openChatScreen(page);

  // The stub answers every send as a server at its concurrency cap does:
  // queued, with an id. The page thinks the chat is idle, so it echoes the
  // message as sent — and the queued list shows it again unless the echo goes.
  await page.getByRole('button', { name: new RegExp(ASK_OPTION_LABEL) }).click();
  await page.getByRole('button', { name: 'Submit all 1' }).click();

  // The queued bubble first, because the other half passes on a page that
  // never sent anything: one card title and nothing else is also "once".
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText(ASK_QUESTION)).toBeVisible();

  // The card's own title, plus the queued bubble. A third is the echo.
  await expect(page.getByText(ASK_QUESTION)).toHaveCount(2);
});

/**
 * The mobile shell at `/m`, on a phone-sized touch screen (the `iphone` and
 * `pixel` projects in playwright.config.ts).
 *
 * As in console.e2e.ts, every assertion is about rendered content: a shell
 * that mounts and draws nothing must fail here, not pass.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { startStubServer, type StubServer } from './stub-server';
import {
  ARTIFACT_TEXT,
  ASK_OPTION_LABEL,
  ASK_QUESTION,
  ASK_SECOND_OPTION_LABEL,
  ASSISTANT_PROSE,
  CHAT_ID,
  CLOSED_ISSUE_TITLE,
  DEPLOY_TIP,
  GATE_MESSAGE,
  IMAGES,
  CHAT_TITLE,
  OTHER_CHAT_ID,
  OTHER_CHAT_TEXT,
  OTHER_CHAT_TITLE,
  OPEN_ISSUE_TITLE,
  PROJECT_ID,
  PROJECT_SHORT_NAME,
  README_HEADING,
  RUN_ARTIFACT,
  RUN_FIRST_STEP,
  RUN_ID,
  RUN_WORKFLOW,
  USER_TURN_TEXT,
} from './fixtures';

let server: StubServer;

test.beforeAll(async () => {
  server = await startStubServer();
});

// Every send queues on the stub, and a queued message closes the open
// question's chips — so each test starts with every queue empty.
test.beforeEach(() => {
  server.reset();
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
const projectPath = `/m/p/${PROJECT_ID}`;
const runPath = `/m/r/${RUN_ID}`;

/**
 * Drag one finger across an element, as a phone reports it: a touchstart, a
 * few touchmoves, a touchend. Playwright's touchscreen only taps.
 */
async function swipe(target: Locator, dx: number, dy: number): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('nothing to swipe on');
  // Clear of the left edge, where a rightward swipe means the chat list.
  const x = box.x + Math.min(box.width / 2, 80);
  const y = box.y + box.height / 2;
  await target.evaluate(
    (el, move) => {
      const at = (dx: number, dy: number): Touch =>
        new Touch({ identifier: 1, target: el, clientX: move.x + dx, clientY: move.y + dy });
      const fire = (type: string, touch: Touch, down: boolean): void => {
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: down ? [touch] : [],
            targetTouches: down ? [touch] : [],
            changedTouches: [touch],
          })
        );
      };
      fire('touchstart', at(0, 0), true);
      for (const step of [0.25, 0.5, 0.75, 1]) {
        fire('touchmove', at(move.dx * step, move.dy * step), true);
      }
      fire('touchend', at(move.dx, move.dy), false);
    },
    { x, y, dx, dy }
  );
}

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

test('a draft stays with its chat across a reload and a chat switch', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('Half a thought');

  await page.reload();
  await expect(composer).toHaveValue('Half a thought');

  // Another chat has its own draft, and coming back finds this one.
  await page.goto(`${server.url}${chatPath(OTHER_CHAT_ID)}`);
  await expect(page.getByText(OTHER_CHAT_TEXT)).toBeVisible();
  await expect(composer).toHaveValue('');
  await page.goBack();
  await expect(composer).toHaveValue('Half a thought');
});

test('an ask card answers with a tap, on finger-sized rows', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  const card = page.locator('[data-ask-card]');
  await expect(card.getByText(ASK_QUESTION)).toBeVisible();
  const option = card.getByRole('button', { name: new RegExp(ASK_OPTION_LABEL) });
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

test('an ask chip above the keys answers the question in one tap', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  const chips = page.getByRole('region', { name: 'Answer the question' });
  await expect(chips.getByText(ASK_QUESTION)).toBeVisible();
  const chip = chips.getByRole('button', { name: ASK_SECOND_OPTION_LABEL });
  expect((await chip.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  // Above the key row, which sits on the keyboard.
  const keys = await page.getByRole('toolbar', { name: 'Composer keys' }).boundingBox();
  expect((await chips.boundingBox())?.y ?? 0).toBeLessThan(keys?.y ?? 0);

  await chip.tap();

  // Sent as the card would send it: the question, numbered, with the answer.
  const queued = page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem');
  await expect(queued).toHaveCount(1);
  await expect(queued).toContainText(`1. ${ASK_QUESTION}`);
  await expect(queued).toContainText(ASK_SECOND_OPTION_LABEL);
  // Answered, so the chips are gone.
  await expect(chips).toHaveCount(0);
});

test('a photo from the library is shrunk, shown as a thumbnail, and sent', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  // A 3000×2000 PNG, drawn in the page: bigger than the 2048px long edge.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 2000;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.fillStyle = '#c33';
    context.fillRect(0, 0, 3000, 2000);
    return canvas.toDataURL('image/png');
  });
  const photo = {
    name: 'IMG_0001.png',
    mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'),
  };

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach from library' }).tap();
  await (await chooser).setFiles(photo);

  const tray = page.getByRole('region', { name: 'Attachments' });
  const thumbnail = tray.getByRole('img', { name: 'IMG_0001.jpg' });
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() => thumbnail.evaluate(img => (img as HTMLImageElement).naturalWidth))
    .toBe(2048);

  await page.getByRole('textbox', { name: 'Message' }).fill('Here is the screen.');
  await page.getByRole('button', { name: 'Send' }).tap();

  await expect(tray).toHaveCount(0);
  const queued = page.getByRole('list', { name: 'Queued messages' });
  await expect(queued.getByText('Here is the screen.')).toBeVisible();
  await expect(queued.getByText(/1 file/)).toBeVisible();
  // What reached the server is the re-encoded JPEG, not the camera's PNG.
  const files = await page.evaluate(async id => {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/queue`);
    return ((await res.json()) as { messages: { files: { name: string; mimeType: string }[] }[] })
      .messages[0]?.files;
  }, CHAT_ID);
  expect(files).toEqual([
    expect.objectContaining({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg' }),
  ]);
});

test("a chat's images open full screen, and swipe from one to the next", async ({ page }) => {
  await open(page, chatPath(OTHER_CHAT_ID));

  const [first, second] = IMAGES;
  await page.getByRole('img', { name: first.alt }).tap();
  const viewer = page.getByRole('dialog', { name: 'Image viewer' });
  await expect(viewer.getByRole('img', { name: first.alt })).toBeVisible();
  await expect(viewer.getByText('1 / 2')).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Share' })).toBeVisible();
  // Opened in the app, not in a browser tab.
  await expect(page).toHaveURL(new RegExp(`${chatPath(OTHER_CHAT_ID)}$`));

  await swipe(viewer.getByRole('img', { name: first.alt }), -150, 0);
  await expect(viewer.getByText('2 / 2')).toBeVisible();
  await expect(viewer.getByRole('img', { name: second.alt })).toBeVisible();

  await swipe(viewer.getByRole('img', { name: second.alt }), 0, 200);
  await expect(viewer).toHaveCount(0);
});

test('swiping a message right quotes it into the reply', async ({ page }) => {
  await open(page, chatPath(CHAT_ID));

  await swipe(page.getByText(USER_TURN_TEXT), 120, 0);

  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    `> ${USER_TURN_TEXT}\n\n`
  );
});

test('while the agent works, Send queues and its menu steers or interrupts', async ({ page }) => {
  server.setBusy(CHAT_ID, true);
  await open(page, chatPath(CHAT_ID));

  const composer = page.getByRole('textbox', { name: 'Message' });
  const more = page.getByRole('button', { name: 'More send options' });
  const menu = page.getByRole('dialog', { name: 'Send options' });
  const queued = page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem');
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeVisible();
  // A running turn will answer before the question does.
  await expect(page.getByRole('region', { name: 'Answer the question' })).toHaveCount(0);

  await composer.fill('Steer this in.');
  await more.tap();
  await menu.getByRole('button', { name: /Steer now/ }).tap();
  await expect.poll(() => [...server.controls]).toEqual(['steer queued-1']);
  await expect(queued.filter({ hasText: 'Steer this in.' })).toContainText('Sent into this turn');

  await composer.fill('Stop, and do this instead.');
  await more.tap();
  await menu.getByRole('button', { name: /Interrupt & send/ }).tap();
  await expect.poll(() => [...server.controls]).toEqual(['steer queued-1', `interrupt ${CHAT_ID}`]);
  const waiting = queued.filter({ hasText: 'Stop, and do this instead.' });
  await expect(waiting).toContainText('Queued');

  // Still waiting, so it can be taken back.
  await waiting.getByRole('button', { name: 'Remove' }).tap();
  await expect(waiting).toHaveCount(0);
  await expect(queued).toHaveCount(1);
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
  // The chat rows only: the sheet also links to Settings and to each project.
  const rows = sheet.getByRole('list').getByRole('link');
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

test("a chat's project opens from its header, and every tab shows its part", async ({ page }) => {
  server.showPausedRun();
  await open(page, chatPath(CHAT_ID));
  await page.getByRole('link', { name: `${PROJECT_SHORT_NAME} ▸` }).tap();
  await expect(page).toHaveURL(new RegExp(`${projectPath}$`));

  // Overview: the deploy, and the run stopped on you.
  await expect(page.getByRole('heading', { name: PROJECT_SHORT_NAME })).toBeVisible();
  await expect(page.getByTestId('mobile-deploy')).toContainText('1 merged PR waiting');
  const needsYou = page.getByRole('region', { name: 'Needs you' });
  await expect(needsYou.getByRole('link', { name: new RegExp(RUN_WORKFLOW) })).toBeVisible();

  const tabs = page.getByRole('navigation', { name: 'Project' });
  await tabs.getByRole('link', { name: 'Runs' }).tap();
  await expect(page).toHaveURL(new RegExp(`${projectPath}/runs$`));
  await expect(page.getByText('Runs start from a chat.')).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(RUN_WORKFLOW) })).toContainText(
    'Waiting for approval'
  );

  await tabs.getByRole('link', { name: 'Chats' }).tap();
  const chats = page.getByRole('list', { name: 'Chats in this project' });
  await expect(chats.getByRole('link')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();

  // Issues, one column at a time: the open one under Todo, the closed one under Done.
  await tabs.getByRole('link', { name: 'Issues' }).tap();
  await expect(page.getByText(OPEN_ISSUE_TITLE)).toBeVisible();
  await expect(page.getByText(CLOSED_ISSUE_TITLE)).toHaveCount(0);
  await page.getByRole('button', { name: /^Done/ }).tap();
  await expect(page.getByText(CLOSED_ISSUE_TITLE)).toBeVisible();
  await expect(page.getByText(OPEN_ISSUE_TITLE)).toHaveCount(0);

  // Files: the README opens rendered, and Back returns to its folder.
  await tabs.getByRole('link', { name: 'Files' }).tap();
  await page.getByRole('link', { name: /README\.md/ }).tap();
  await expect(page.getByRole('heading', { name: README_HEADING, level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the folder' }).tap();
  await expect(page.getByRole('list', { name: 'Files' }).getByText('src')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a run reads as a timeline, and its gate is approved from the phone', async ({ page }) => {
  server.showPausedRun();
  await open(page, runPath);

  await expect(page.getByRole('heading', { name: RUN_WORKFLOW })).toBeVisible();
  // The finished step with its duration, then the gate it is waiting on.
  const steps = page.getByRole('region', { name: 'Steps' }).getByRole('listitem');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText(RUN_FIRST_STEP);
  await expect(steps.nth(0)).toContainText('01:35');

  // The run's file opens in place.
  const artifacts = page.getByRole('region', { name: 'Artifacts' });
  await artifacts.getByRole('button', { name: new RegExp(RUN_ARTIFACT) }).tap();
  await expect(artifacts.getByText(ARTIFACT_TEXT.split('\n').at(-1) ?? '')).toBeVisible();

  const approval = page.getByRole('region', { name: 'Approval' });
  await expect(approval.getByText(GATE_MESSAGE)).toBeVisible();
  const approve = approval.getByRole('button', { name: 'Continue' });
  const reject = approval.getByRole('button', { name: 'Reject' });
  // Finger-sized, and sharing the width between them.
  const [a, r] = [await approve.boundingBox(), await reject.boundingBox()];
  expect(a?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(r?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((a?.width ?? 0) + (r?.width ?? 0)).toBeGreaterThan((page.viewportSize()?.width ?? 0) / 2);

  await approve.tap();
  await expect.poll(() => [...server.controls]).toEqual([`respond ${RUN_ID} approve`]);
  await expect(approval).toHaveCount(0);
  await expect(page.getByRole('banner')).toContainText('Completed');
});

test('Deploy asks first, then asks the server to deploy the waiting commit', async ({ page }) => {
  await open(page, projectPath);
  const deploy = page.getByTestId('mobile-deploy');
  await deploy.getByRole('button', { name: 'Deploy' }).tap();

  // Nothing is sent until the confirm is answered.
  const confirm = deploy.getByRole('group', { name: `Deploy ${DEPLOY_TIP.slice(0, 8)} now?` });
  await expect(confirm).toContainText('parked and resume after');
  expect(server.controls).toEqual([]);

  await confirm.getByRole('button', { name: 'Deploy now' }).tap();
  await expect.poll(() => [...server.controls]).toEqual([`deploy ${DEPLOY_TIP}`]);
  await expect(confirm).toHaveCount(0);
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

test("a chat's bell follows it, and the chat on screen is reported as seen", async ({ page }) => {
  await open(page, chatPath(CHAT_ID));
  // The open chat is reported, so the server does not push about it.
  await expect.poll(() => [...server.presence.values()]).toContain(CHAT_ID);

  await page.getByRole('button', { name: 'Notifications: default' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Notifications for this chat' });
  await sheet.getByRole('button', { name: /^Following/ }).tap();
  await expect.poll(() => server.controls).toContain(`notify conversation ${CHAT_ID} following`);
  await expect(page.getByRole('button', { name: 'Notifications: following' })).toBeVisible();
  const row = await sheet.getByRole('button', { name: /^Following/ }).boundingBox();
  expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);

  // Leaving the chat takes it off screen.
  await sheet.getByRole('button', { name: 'Close', exact: true }).tap();
  await page.getByRole('link', { name: `${PROJECT_SHORT_NAME} ▸` }).tap();
  await expect.poll(() => [...server.presence.values()]).not.toContain(CHAT_ID);
});

test('a project can be muted from its screen', async ({ page }) => {
  await open(page, projectPath);
  const mute = page.getByRole('button', { name: 'Mute this project' });
  await mute.tap();
  await expect.poll(() => server.controls).toContain(`notify project ${PROJECT_ID} muted`);
  await expect(page.getByRole('button', { name: 'Unmute this project' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  // A chat in a muted project shows its bell muted.
  await open(page, chatPath(CHAT_ID));
  await expect(page.getByRole('button', { name: 'Notifications: muted' })).toBeVisible();
});

test('Settings switches push on, or says how to install first on an iPhone', async ({
  page,
}, testInfo) => {
  // Headless Chromium's Notification.permission reads "denied" even when the
  // permission is granted; a phone that has not been asked yet says "default".
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
  });
  await open(page, '/m/settings');
  const section = page.getByRole('region', { name: 'Notifications' });
  if (testInfo.project.name === 'iphone') {
    // Safari in a tab cannot receive push; the only honest advice is installing.
    await expect(section.getByRole('note', { name: 'Add to Home Screen' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Turn on' })).toHaveCount(0);
  } else {
    await expect(section.getByRole('button', { name: 'Turn on' })).toBeEnabled();
  }

  const finished = section.getByRole('checkbox', { name: 'A run finished' });
  await expect(finished).toBeChecked();
  await finished.tap();
  await expect(finished).not.toBeChecked();
  await expect(section.getByRole('checkbox', { name: 'A chat needs you' })).toBeChecked();
});

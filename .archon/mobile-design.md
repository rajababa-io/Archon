# Archon mobile — design and build spec

Status: accepted 2026-09-28. Built by `archon-build-phased` against this file.
Clickable mockup: https://claude.ai/artifact/QRVHcjjrbRLEhwcT82ZwUe (owner-only).

## Goal

Use Archon from a phone — iOS and Android — with roughly desktop parity for the
work that matters away from a desk: chats (full-featured, with a keyboard
experience as good as a terminal client's), images in and out, projects, runs and
approvals, and push notifications when something needs the operator.

One operator, on the tailnet (`https://archon-cloud.encke-snake.ts.net`), web auth
off. Nothing here changes that access model.

## Decisions

| Question | Decision |
|---|---|
| Form | A **PWA**: a separate mobile shell at `/m` inside `packages/web`, sharing the console's data layer. The desktop console is not restyled. No app store, no native build. |
| Opens to | The last chat the operator was in. |
| Navigation | Chat-first. A switcher sheet (edge-swipe or header button) lists every chat grouped by project, sorted by chat status: awaiting first. |
| Chat | Full-featured: streaming, ask cards, queue / steer / interrupt, model picker, slash menu, `@` files, attachments. |
| Keyboard | An accessory key row pinned to the top of the on-screen keyboard; ask options as one-tap chips; gestures. |
| Images | Attach from camera, library, or paste (downscaled on device). Agent images (`/visual`, any markdown image) render exactly as on desktop via the shared `Markdown`. Full-screen viewer with zoom, swipe, and share. |
| Push | Standard Web Push from the PWA (VAPID). Triggers: a chat needs you (ask or approval), a run finished, a run failed. Per-chat default / muted / following; per-project mute. |
| Runs | View and approve only. Runs are launched from chat (the orchestrator's workflow tools); there is no launch form on mobile. |
| Deploy | Deploy status plus a confirm-to-deploy button on the project overview, using the existing deploy-request path. |
| Dropped on mobile | Workflow builder, the changes/diff panel, issue commenting, and every setting except those listed under Settings. |
| Voice | None built: the OS keyboard's dictation (or Wispr Flow) is the voice input. |
| Share-into-Archon | Not in this build. |
| Tablet | The phone layout stretches; no tablet-specific layout. |

## Architecture

- Code lives in `packages/web/src/experiments/console/mobile/`: its own
  `MobileApp.tsx`, `routes/`, and `components/`. It imports the console's
  `skills/` (API calls), `store/` (cache), `lib/` (`sse.ts`, `draft-store.ts`,
  `notify.ts`, `use-viewport.ts`, format helpers), `primitives/` (`ask.ts`,
  `file.ts`, `chat-status.ts`, `run.ts`), and presentational components that work
  at phone width (`Markdown`, `CodeBlock`, `AskCard`). It never imports the
  desktop layout (rail, panels, builder).
- Routes: `/m` (redirects to the last chat, else opens the switcher),
  `/m/c/:conversationId`, `/m/p/:projectId` (tabs: Overview, Runs, Chats, Issues,
  Files), `/m/r/:runId`, `/m/files/:projectId/*`, `/m/settings`.
- On a narrow touch viewport, `/console` shows a dismissible one-time
  "Open mobile view" banner. Never a forced redirect.
- PWA: a web app manifest (`start_url: /m`, `scope: /m`, `display: standalone`,
  theme colour from the console theme, maskable icons), `apple-touch-icon`, and a
  service worker that precaches the app shell and handles push. Keep the service
  worker scoped to `/m` so the desktop console's behaviour is unchanged.
- Transport is unchanged: REST under `/api/*` and SSE under `/api/stream/*`. iOS
  suspends background connections, so on `visibilitychange → visible` the shell
  reconnects SSE and invalidates the open chat and dashboard queries.

## Screens

**Chat.** Header: switcher button with a needs-you count badge, project ▸ chat
title (tap → project), status chip, notification bell. A compact status strip
(working with elapsed time, run executing, waiting on CI, ready → "Mark done").
Transcript: assistant markdown, tool calls collapsed to one line (tap to expand),
images tappable into the viewer, ask cards restyled for touch (44 px rows), inline
cards for runs the chat started with their approvals. Auto-scroll only while
pinned to the bottom, otherwise a "new" pill. Reaching the bottom writes the read
marker exactly as desktop does.

**Composer and keyboard.** The shell sizes itself to `visualViewport` and pins
the composer and key row to the keyboard's top edge (Android:
`interactive-widget=resizes-content`; iOS: a `--kb-inset` variable driven by
`visualViewport` resize and scroll). Nothing may jump when the keyboard opens.
Key row, horizontally scrollable, 44 px targets: hide keyboard, `/` slash menu
sheet, `@` file picker sheet (fuzzy search over the project tree), attach from
library, camera (`capture="environment"`), interrupt, model picker sheet, recall
last sent message, full-screen editor. When the chat has an unanswered ask block,
its options render as chips above the key row; one tap answers exactly as
`AskCard` does (multi-select asks: toggle chips plus Send; "Other…" focuses the
composer). Send: idle → send; while a turn is working → queue. A menu beside Send
offers Queue, Steer now (the existing queue-steer endpoint), and Interrupt & send.
Queued messages show dimmed and can be cancelled. Gestures: swipe the composer up
for the full-screen editor; swipe a message right to quote it; long-press a
message to copy / share / quote; pull to refresh the transcript; edge-swipe for
the switcher. Drafts persist per chat through the existing `draft-store`.

**Images.** Before upload, downscale to a 2048 px long edge and re-encode JPEG
(~85%) on device; keep the existing 5 × 10 MB server limits. A new chat may start
with a photo (conversation creation already accepts multipart, #118). Viewer:
full screen, pinch and double-tap zoom, swipe between the chat's images, swipe
down to close, Share through the Web Share API with the image file.

**Project.** Overview: deploy status plus a Deploy button with an inline confirm
("running chats are parked and resume after", which #177 already does); a
Needs-you list; recent chats. Runs: list with status and CI-wait clock; tap for
run detail; a one-line note that runs start from chat. Chats: the project's
chats with status, plus New chat. Issues: read-only list with a column filter
row. Files: tree browser and read-only viewer (markdown rendered, code
highlighted, images in the viewer).

**Run detail.** The DAG as a vertical timeline (status dot, name, duration); tap a
node for its events and output. Approval gates as full-width Approve / Reject.
Artifacts listed; images open in the viewer.

**Settings.** Push on this device (enable, test push, disable), the three global
triggers, default model for new chats, theme (system / light / dark), and a link
to the desktop console. Nothing else.

## Push notifications

- Server: a migration adding `remote_agent_push_subscriptions` (endpoint, p256dh,
  auth, user agent, created, last success; a row is deleted when the push service
  answers 404/410) and `remote_agent_notify_prefs` (scope global / project /
  conversation, mode default / muted / following, plus the three global toggles).
  Endpoints: `GET /api/push/vapid-key`, `POST|DELETE /api/push/subscribe`,
  `GET|PUT /api/push/prefs`, `POST /api/push/test`, `POST /api/push/presence`.
- Keys: VAPID keys come from `ARCHON_VAPID_PUBLIC`, `ARCHON_VAPID_PRIVATE`,
  `ARCHON_VAPID_SUBJECT`. Never generate or commit keys. When they are unset,
  push is disabled and Settings says exactly which variables are missing.
- Notifier: a server module subscribed to the same internal events that feed
  `/api/stream/__dashboard__`. It pushes when a chat becomes awaiting, and when a
  workflow run finishes or fails; per-chat `following` also pushes when a turn
  finishes. It suppresses a push for a chat currently visible on any client
  (presence heartbeat), and collapses repeats with a per-chat / per-run `tag`.
  Payloads stay minimal: title, one line, deep-link path.
- "Awaiting" is computed in the browser today (`primitives/chat-status.ts`). Move
  the pure predicate (an unanswered ask block in the last assistant message, or a
  run the chat started paused on a gate) into a shared package so the server and
  both UIs use one definition, and move its existing tests with it.
- Client: service worker `push` → `showNotification`; `notificationclick` focuses
  an open window and navigates, else opens the deep link. The permission prompt
  appears only from a tap (iOS requires it). When not installed on iOS, show an
  "Add to Home Screen" coach mark, since iOS delivers web push only to installed
  PWAs (16.4+). App badge = needs-you count where supported.
- Use a maintained Web Push library if it runs under Bun; otherwise implement
  VAPID signing and `aes128gcm` payload encryption with WebCrypto.

## Offline and failure states

App shell precached, so the app opens instantly. When the tailnet is unreachable,
say so plainly instead of rendering blank. The last ~10 viewed chats persist to
IndexedDB for offline reading; sending is disabled offline, with a clear state.

## Testing

Unit tests for the shared awaiting predicate, prefs resolution (global → project
→ chat), and notifier suppression and collapse. Playwright e2e for the mobile
shell under iPhone and Pixel device profiles in `packages/web/e2e/`, run by the
existing `console-browser` CI job: `/m` redirects to the last chat; the chat
renders its transcript; sending works; an ask chip answers an ask; an attachment
thumbnail appears; the image viewer opens; the switcher lists chats by status;
run approval works. Things only a real device can prove (keyboard behaviour, push
on a locked phone) go in a checklist in the final PR description.

## Phases

### Mobile shell, PWA, and chat

Create the `/m` shell described under Architecture, the web app manifest and
icons, the service worker (app-shell precache only in this phase), and the
narrow-viewport banner on `/console`. Build the Chat screen for reading and
sending — header, status strip, streaming transcript, collapsed tool calls, ask
cards restyled for touch, run cards with approvals, read marker — and the
Switcher sheet. Build the keyboard-safe layout (visualViewport sizing, composer
pinned above the keyboard) in this phase, with a plain composer and Send. Add
SSE reconnect and query invalidation on returning to the foreground. Add the
first Playwright mobile e2e tests (iPhone and Pixel profiles) covering redirect,
transcript, send, answering an ask card, and the switcher. The desktop console
must behave exactly as before.

### Composer, keyboard row, and images

Everything under "Composer and keyboard" and "Images": the accessory key row and
its sheets (slash, `@` files, model), ask chips, the Send menu with Queue / Steer
now / Interrupt & send using the existing queue, steer and interrupt endpoints,
dimmed cancellable queued messages, recall, the full-screen editor, the gestures,
per-chat drafts through `draft-store`, attachments from camera / library / paste
with on-device downscale, and the image viewer with zoom, swipe, and Web Share.
Extend the mobile e2e tests to cover ask chips, attachments, and the viewer.

### Projects, runs, issues, files, settings, and deploy

The Project screen with its five tabs, Run detail as a vertical timeline with
approvals and artifacts, read-only Issues and Files, the minimal Settings screen
(push controls may render disabled until the next phase wires them), and the
Deploy button with inline confirm using the same deploy-request path the desktop
`DeployStrip` uses. No run-launch form. Extend e2e to cover project navigation
and run approval.

### Web Push

Everything under "Push notifications": the migration, the endpoints, VAPID from
environment only, the notifier with presence suppression and tag collapse, the
shared awaiting predicate moved out of the browser with its tests, the service
worker push and click handlers, the per-chat bell and per-project mute, the
Settings push controls and test push, the iOS install coach mark, and the app
badge. Unit-test prefs resolution and notifier suppression.

### Offline, polish, and docs

The offline transcript cache and offline / tailnet-unreachable states; haptic
ticks on the key row where supported; a final pass for 44 px touch targets and
contrast in both themes. Delete the stale "a new conversation must be created
with a text-only first message" paragraph from the console README and describe
the mobile shell there. Add a docs page on installing Archon to a phone's Home
Screen and enabling push, including the VAPID environment variables. The PR
description must carry the real-device checklist from Testing.

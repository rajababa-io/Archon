# Console

The console is Archon's only shipped Web application. Its historical directory
name remains in place to avoid a mechanical move while the builder is changing.
It has two shells over one data layer: the desktop console at `/console`, and
the phone shell at `/m` (see [Mobile shell](#mobile-shell)).

## Routes

- `/console` → all runs
- `/console/settings` → assistant, provider, system, and identity settings
- `/console/builder` → experimental workflow builder and project picker
- `/console/builder/:name` → edit a project workflow selected by
  `?project=<id>`
- `/console/r/:runId` → run detail without requiring a project URL
- `/console/p/:projectId` → project runs
- `/console/p/:projectId/chat` → project operator chat
- `/console/p/:projectId/r/:runId` → project-scoped run detail

## Ownership

- Console API calls live in `skills/`.
- Reactive data lives in `store/cache.ts`.
- Generated API shapes come from `@/lib/api.generated`.
- Shared application code is limited to authentication, generated API types,
  node-reference parsing, IDE links, and global styling.
- The `builder/` subtree remains experimental and keeps its own pure model,
  validation, editor, and serialization layers.

## Chat behavior

The composer accepts up to five files of 10 MB each, on the first message of a
new conversation as on any other.

On authenticated installations, the console requests the signed-in user's
project conversation and sends the active identity with each turn. Solo
installations operate without an identity.

## Mobile shell

`mobile/` is the phone app at `/m`, an installable PWA (progressive web app).
It shares `skills/`, `store/`, `lib/`, `primitives/`, and the presentational
components that work at phone width (`Markdown`, `AskCard`, `ChatStream`), and
never imports the desktop layout. `/console` offers it once on a narrow touch
screen and never redirects.

- `/m` → the last chat open on this phone, else the chat list
- `/m/c/:conversationId` → a chat, with the key row, ask chips and image viewer
- `/m/p/:projectId/:tab?` → a project: Overview (deploy), Runs, Chats, Issues, Files
- `/m/r/:runId` → run detail as a timeline, with approvals and artifacts
- `/m/files/:projectId/*` → a read-only file
- `/m/settings` → push on this device, the push triggers, default model, theme

`mobile/pwa/` owns the installable pieces: the build emits `/m/manifest.webmanifest`
and `/m/sw.js`, a service worker scoped to `/m/` that precaches the shell and
shows push notifications. It never answers an API request.

Offline, the shell opens from that cache. `mobile/lib/reach.ts` decides whether
Archon can be reached from the chat list's last read, and a banner says when
it cannot. That read gives up after 10 seconds, because a dead tailnet link
hangs rather than refusing. The last 10 chats read are copied to IndexedDB
(`mobile/lib/saved-chats.ts`) and shown, marked as saved copies, only while
the server does not answer; sending is disabled. Copies are kept only on
installs with web auth off. `src/components/auth/MobileGate.tsx` records that
(it sits outside this tree because it reads the auth status through React
Query), and it is also what lets the shell open before the auth check answers.

Installing and push setup for operators:
[Archon on Your Phone](../../../../docs-web/src/content/docs/guides/mobile-app.md).

## Browser suite

`packages/web/e2e/` loads the built console in Chromium and asserts rendered
content — the rail lists chats, a chat shows its transcript, the composer takes
text, an ask block draws cards rather than a JSON code block. `mobile.e2e.ts`
runs the phone shell under iPhone and Pixel profiles. Every other check
in this repository is static, so all of them stay green while the bundle renders
a blank page. CI runs it as the `console-browser` job on every pull request.

Run it locally:

```bash
bun run build:web                        # the suite loads dist/, so build first
cd packages/web
npx playwright install chromium          # once
npx playwright test
```

It needs **Node on `PATH`** — Playwright's runner does not run under Bun. Files
are named `*.e2e.ts` rather than `*.spec.ts` so the repository's Bun inventory
never tries to collect them; the `e2e/` directory is this suite's inventory, and
a new file there runs by having been written.

`ARCHON_E2E_CHROMIUM_ARGS` passes extra flags to Chromium for a sandbox that
needs them — `ARCHON_E2E_CHROMIUM_ARGS='--no-sandbox' npx playwright test`. Do
not reach for `--single-process`: it tears the browser down with the first
`BrowserContext`, so every second test fails to open a page.

## Persisted view preferences

| Key | Default | Purpose |
| --- | --- | --- |
| `archon.console.detailView` | `log` | Run-detail tab |
| `archon.console.showToolCalls` | `1` | Show tool calls in the stream |
| `archon.console.showSystem` | `0` | Show system events |
| `archon.console.runNodeFilter` | `all` | Filter the run stream by node |
| `archon.console.railWidth` | unset | Project rail width |
| `archon.console.lastWorkflow` | unset | Last selected workflow |
| `archon.console.builderProject` | unset | Builder project selection |

Local storage reads are guarded and fall back to these defaults.

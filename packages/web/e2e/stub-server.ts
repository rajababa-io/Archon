/**
 * Serves the built console and a fixed API, on one origin, the way the real
 * server does.
 *
 * Why a stub and not the real server: this suite's question is whether the
 * bundle renders, and the answer has to be the same every time it is asked. A
 * real server would bring a database to seed, a provider registry to boot, and
 * an update check that reaches the network — three sources of a red run that
 * say nothing about the console. What the stub cannot drift on is the wire
 * shape: `fixtures.ts` types every row against the module that owns it, so a
 * server-side rename breaks the type-check rather than the browser.
 *
 * One origin matters. A production bundle sends `/api/...` relative and opens
 * its event streams on the same origin (`SSE_BASE_URL` is empty outside dev),
 * so serving the static files and the API from one listener is what the shipped
 * build actually does — no proxy, no CORS, no second port.
 *
 * Node's `http` rather than `Bun.serve`: the Playwright runner is a Node
 * process, and this module is imported into it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { components } from '@/lib/api.generated';
import type { Socket } from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACTS,
  ARTIFACT_TEXT,
  AUTH_STATUS,
  CHANGES,
  CHANGE_DIFF,
  CHATS,
  CHAT_ID,
  CONVERSATION_COUNTS,
  ISSUES,
  MESSAGES,
  OTHER_MESSAGES,
  PROJECT,
  PROJECT_ID,
  README_TEXT,
  ROOT_LISTING,
  RUN_ARTIFACT,
  RUN_EVENTS,
  RUN_ID,
  projectDeploy,
  runRow,
  type RawMessage,
} from './fixtures';

const DIST = resolve(fileURLToPath(new URL('../dist', import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface StubServer {
  /** Origin to point the browser at, e.g. `http://127.0.0.1:41234`. */
  readonly url: string;
  /** API paths the console asked for that this stub does not answer. */
  readonly unhandled: readonly string[];
  /**
   * Actions the console asked for: `steer <queued id>`, `interrupt <chat id>`,
   * `respond <run id> <decision>`, `deploy <sha>`, `notify <scope> <id> <mode>`,
   * `forget push device <id>`.
   */
  readonly controls: readonly string[];
  /** The chat each console last reported on screen (`null`: none), by its client id. */
  readonly presence: ReadonlyMap<string, string | null>;
  /** Put the fixture's run on the project, paused on its approval gate. */
  showPausedRun: () => void;
  /** Report a chat as mid-turn, or not. */
  setBusy: (chatId: string, busy: boolean) => void;
  /** Back to the fixture's world: no queues, nothing busy, no run, no controls recorded. */
  reset: () => void;
  close: () => Promise<void>;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * An event stream that sends nothing on its own — only the event a send would
 * make the real server emit, written by the send route.
 *
 * The console treats stream events as cache-invalidation triggers, so a quiet
 * stream leaves it reading the API — which is the deterministic path this suite
 * wants. Holding the socket open (rather than ending it) is what stops
 * `EventSource` from reconnecting in a loop and refetching underneath an
 * assertion.
 */
function openStream(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
}

/** The transcript for a chat — a different one per chat, so opening one shows. */
function messagesFor(platformId: string): RawMessage[] {
  return platformId === CHAT_ID ? MESSAGES : OTHER_MESSAGES;
}

/** Messages each chat has waiting behind a turn, keyed by platform id. */
type Queues = Map<string, components['schemas']['QueuedMessage'][]>;

/** What the stub holds between requests. */
interface StubState {
  unhandled: string[];
  queues: Queues;
  streams: Map<string, ServerResponse>;
  /** Chats the stub reports mid-turn, by platform id. */
  busy: Set<string>;
  /** Actions asked for, in the words `StubServer.controls` documents. */
  controls: string[];
  /** The fixture run: absent, paused on its gate, or answered. */
  run: 'none' | 'paused' | 'completed';
  /** What to be told about, as the push routes store it. */
  pushPrefs: components['schemas']['PushPrefs'];
  /** The browsers registered for push, as the list route answers them. */
  pushDevices: components['schemas']['PushDevice'][];
  /** The chat each console last reported on screen, by client id. */
  presence: Map<string, string | null>;
}

const PUSH_PREFS: components['schemas']['PushPrefs'] = {
  triggers: { awaiting: true, runFinished: true, runFailed: true },
  mutedProjects: [],
  conversations: {},
};

/** A phone app left behind by a reinstall, and the one that replaced it. */
const PUSH_DEVICES: components['schemas']['PushDevice'][] = [
  {
    id: 'push-old',
    label: 'iPhone · Home Screen app',
    created_at: '2026-09-28 12:00:00',
    last_success_at: null,
  },
  {
    id: 'push-new',
    label: 'Android · Chrome',
    created_at: '2026-09-30 10:00:00',
    last_success_at: '2026-09-30 11:00:00',
  },
];

type QueuedFile = components['schemas']['QueuedMessage']['files'][number];

/**
 * A send's text and attachments. JSON without files, multipart with them —
 * the two bodies the console's send skill writes, parsed as the real route
 * parses them.
 */
async function readSend(req: IncomingMessage): Promise<{ message: string; files: QueuedFile[] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const type = req.headers['content-type'] ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await new Response(body, { headers: { 'content-type': type } }).formData();
    const message = form.get('message');
    const files = form
      .getAll('files')
      .filter((f): f is File => typeof f !== 'string')
      .map(f => ({ name: f.name, mimeType: f.type, size: f.size }));
    return { message: typeof message === 'string' ? message : '', files };
  }
  const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  return { message: typeof json.message === 'string' ? json.message : '', files: [] };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, state: StubState): void {
  const { unhandled, queues, streams } = state;
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path.startsWith('/api/stream/')) {
    openStream(res);
    streams.set(decodeURIComponent(path.slice('/api/stream/'.length)), res);
    return;
  }

  if (method === 'GET' && path === '/api/auth/status') {
    sendJson(res, AUTH_STATUS);
    return;
  }

  // Better Auth's own endpoint. Web auth is off in this fixture, so there is no
  // session — the shape Better Auth returns for a signed-out browser is null.
  if (method === 'GET' && path === '/api/auth/get-session') {
    sendJson(res, null);
    return;
  }

  if (method === 'GET' && path === '/api/health') {
    // No chat is mid-turn and no deploy is running: the composer is enabled and
    // the deploy overlay stays down, which is the state the suite asserts.
    sendJson(res, {
      status: 'ok',
      concurrency: { activeConversationIds: [], activeTools: {} },
    });
    return;
  }

  if (method === 'GET' && path === '/api/codebases') {
    sendJson(res, [PROJECT]);
    return;
  }

  if (method === 'GET' && path === `/api/codebases/${PROJECT_ID}`) {
    sendJson(res, PROJECT);
    return;
  }

  if (method === 'GET' && path === '/api/conversations') {
    const scope = url.searchParams.get('state') ?? 'open';
    // Unfiltered by project, every row says which project it belongs to: the
    // mobile switcher and the palette read that list, across projects.
    const rows = url.searchParams.has('codebaseId')
      ? CHATS
      : CHATS.map(chat => ({ ...chat, codebase_id: PROJECT_ID }));
    sendJson(res, {
      conversations: scope === 'done' ? [] : rows,
      counts: CONVERSATION_COUNTS,
    });
    return;
  }

  const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path);
  if (method === 'GET' && messagesMatch !== null) {
    sendJson(res, messagesFor(decodeURIComponent(messagesMatch[1])));
    return;
  }

  // Whether the server is mid-turn for this chat. Unlocked unless a test made
  // the chat busy — the console asks this after a stream reconnect, because
  // the events that carry the answer are lost in the gap.
  const lockMatch = /^\/api\/conversations\/([^/]+)\/lock$/.exec(path);
  if (method === 'GET' && lockMatch !== null) {
    const chatId = decodeURIComponent(lockMatch[1]);
    const lock: components['schemas']['ConversationLockResponse'] = {
      conversationId: chatId,
      locked: state.busy.has(chatId),
    };
    sendJson(res, lock);
    return;
  }

  // The chat checkout's uncommitted changes, and one file's diff. Every chat
  // shows the same fixed change set; the panel test reads one file of it.
  if (method === 'GET' && /^\/api\/conversations\/[^/]+\/changes$/.test(path)) {
    sendJson(res, CHANGES);
    return;
  }
  if (method === 'GET' && /^\/api\/conversations\/[^/]+\/changes\/diff$/.test(path)) {
    if (url.searchParams.get('path') === CHANGE_DIFF.path) sendJson(res, CHANGE_DIFF);
    else sendJson(res, { error: 'No uncommitted change at that path' }, 404);
    return;
  }

  if (method === 'POST' && /^\/api\/conversations\/[^/]+\/read$/.test(path)) {
    sendJson(res, { success: true });
    return;
  }

  // The composer's send, answered the way a server at its concurrency cap
  // answers: queued, with an id. That is the case a page that believes the chat
  // is idle can get wrong, and never a reply — a fixture that grew one would be
  // asserting the server.
  const sendMatch = /^\/api\/conversations\/([^/]+)\/message$/.exec(path);
  if (method === 'POST' && sendMatch !== null) {
    const chatId = decodeURIComponent(sendMatch[1]);
    const chatQueue = queues.get(chatId) ?? [];
    queues.set(chatId, chatQueue);
    void readSend(req).then(body => {
      const message: components['schemas']['QueuedMessage'] = {
        id: `queued-${String(chatQueue.length + 1)}`,
        text: body.message,
        files: body.files,
        queuedAt: new Date().toISOString(),
        steering: false,
      };
      chatQueue.push(message);
      const dispatch: components['schemas']['DispatchResponse'] = {
        accepted: true,
        status: 'queued-capacity',
        queuedId: message.id,
      };
      sendJson(res, dispatch);
      // What the real server sends the moment a message joins the queue; the
      // console reads the queue only when told to.
      streams
        .get(chatId)
        ?.write(
          `data: ${JSON.stringify({ type: 'conversation_queue', conversationId: chatId })}\n\n`
        );
    });
    return;
  }

  const queueMatch = /^\/api\/conversations\/([^/]+)\/queue$/.exec(path);
  if (method === 'GET' && queueMatch !== null) {
    const chatId = decodeURIComponent(queueMatch[1]);
    // A busy chat's turn takes input mid-turn, as a Claude turn does.
    const queue: components['schemas']['ConversationQueueResponse'] = {
      conversationId: chatId,
      messages: queues.get(chatId) ?? [],
      steerable: state.busy.has(chatId),
    };
    sendJson(res, queue);
    return;
  }

  const steerMatch = /^\/api\/conversations\/([^/]+)\/queue\/([^/]+)\/steer$/.exec(path);
  if (method === 'POST' && steerMatch !== null) {
    const queuedId = decodeURIComponent(steerMatch[2]);
    state.controls.push(`steer ${queuedId}`);
    const queued = queues.get(decodeURIComponent(steerMatch[1]))?.find(m => m.id === queuedId);
    if (queued !== undefined) queued.steering = true;
    const steered: components['schemas']['SteerQueuedResponse'] = {
      status: queued === undefined ? 'not-queued' : 'sent',
    };
    sendJson(res, steered);
    return;
  }

  const withdrawMatch = /^\/api\/conversations\/([^/]+)\/queue\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && withdrawMatch !== null) {
    const chatQueue = queues.get(decodeURIComponent(withdrawMatch[1])) ?? [];
    const at = chatQueue.findIndex(m => m.id === decodeURIComponent(withdrawMatch[2]));
    const [message] = at === -1 ? [] : chatQueue.splice(at, 1);
    const withdrawn: components['schemas']['WithdrawQueuedResponse'] =
      message === undefined ? { status: 'not-queued' } : { status: 'withdrawn', message };
    sendJson(res, withdrawn);
    return;
  }

  const interruptMatch = /^\/api\/conversations\/([^/]+)\/interrupt$/.exec(path);
  if (method === 'POST' && interruptMatch !== null) {
    const chatId = decodeURIComponent(interruptMatch[1]);
    state.controls.push(`interrupt ${chatId}`);
    const stopped: components['schemas']['ConversationInterruptResponse'] = {
      conversationId: chatId,
      status: 'stopping',
    };
    sendJson(res, stopped);
    return;
  }

  // No runs, unless a test put the fixture's run on the project; no chat
  // launched it, so a chat's runs are always none. Counts included, as the
  // real route always sends them: without them the console's normalizer
  // throws and every runs list on the page renders its load error.
  if (method === 'GET' && path === '/api/dashboard/runs') {
    const runs =
      state.run === 'none' || url.searchParams.has('parentConversationId')
        ? []
        : [runRow(state.run)];
    const count = (status: string): number => runs.filter(r => r.status === status).length;
    const feed = {
      runs,
      total: runs.length,
      counts: {
        all: runs.length,
        running: 0,
        completed: count('completed'),
        failed: 0,
        cancelled: 0,
        pending: 0,
        paused: count('paused'),
      },
    };
    sendJson(res, feed);
    return;
  }

  if (method === 'GET' && path === `/api/workflows/runs/${RUN_ID}`) {
    if (state.run === 'none') sendJson(res, { error: 'Workflow run not found' }, 404);
    else sendJson(res, { run: runRow(state.run), events: RUN_EVENTS });
    return;
  }

  // Answering the gate resolves it, as the real route does before the run resumes.
  if (method === 'POST' && path === `/api/workflows/runs/${RUN_ID}/respond`) {
    void readJson(req).then(body => {
      state.controls.push(`respond ${RUN_ID} ${String(body.decision)}`);
      state.run = 'completed';
      sendJson(res, { success: true });
    });
    return;
  }

  if (method === 'GET' && path === `/api/runs/${RUN_ID}/artifacts`) {
    sendJson(res, ARTIFACTS);
    return;
  }
  if (method === 'GET' && path === `/api/artifacts/${RUN_ID}/${RUN_ARTIFACT}`) {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(ARTIFACT_TEXT);
    return;
  }

  // The project deploys this install, with merged work waiting behind Deploy now.
  if (path === `/api/projects/${PROJECT_ID}/deploy`) {
    if (method === 'GET') {
      sendJson(res, { deploy: projectDeploy });
      return;
    }
    if (method === 'POST') {
      void readJson(req).then(body => {
        state.controls.push(`deploy ${String(body.sha)}`);
        sendJson(res, { requested: true });
      });
      return;
    }
  }
  if (method === 'GET' && path === `/api/projects/${PROJECT_ID}/deploy/log`) {
    sendJson(res, { entries: [] });
    return;
  }

  // Web Push: configured, nothing muted. Changes are applied and recorded.
  if (method === 'GET' && path === '/api/push/vapid-key') {
    sendJson(res, { enabled: true, publicKey: 'BStubPublicKey' });
    return;
  }
  if (path === '/api/push/prefs') {
    if (method === 'GET') {
      sendJson(res, state.pushPrefs);
      return;
    }
    if (method === 'PUT') {
      void readJson(req).then(body => {
        const change = body as components['schemas']['PushPrefsChange'];
        const prefs = state.pushPrefs;
        if (change.scope === 'global') {
          prefs.triggers = { ...prefs.triggers, ...change.triggers };
        } else if (change.scope === 'project') {
          prefs.mutedProjects = prefs.mutedProjects.filter(id => id !== change.id);
          if (change.mode === 'muted') prefs.mutedProjects.push(change.id);
          state.controls.push(`notify project ${change.id} ${change.mode}`);
        } else {
          const kept = Object.entries(prefs.conversations).filter(([id]) => id !== change.id);
          if (change.mode !== 'default') kept.push([change.id, change.mode]);
          prefs.conversations = Object.fromEntries(kept);
          state.controls.push(`notify conversation ${change.id} ${change.mode}`);
        }
        sendJson(res, prefs);
      });
      return;
    }
  }
  if (method === 'GET' && path === '/api/push/subscriptions') {
    sendJson(res, { devices: state.pushDevices });
    return;
  }
  if (method === 'DELETE' && path.startsWith('/api/push/subscriptions/')) {
    const id = decodeURIComponent(path.slice('/api/push/subscriptions/'.length));
    state.pushDevices = state.pushDevices.filter(d => d.id !== id);
    state.controls.push(`forget push device ${id}`);
    sendJson(res, { success: true });
    return;
  }
  if (method === 'POST' && path === '/api/push/presence') {
    void readJson(req).then(body => {
      state.presence.set(String(body.clientId), (body.conversationId as string | null) ?? null);
      sendJson(res, { success: true });
    });
    return;
  }

  // The checkout: a README at the root beside an empty folder.
  if (method === 'GET' && path === `/api/codebases/${PROJECT_ID}/files`) {
    const dir = url.searchParams.get('path') ?? '';
    sendJson(res, dir === '' ? ROOT_LISTING : { path: dir, entries: [] });
    return;
  }
  if (method === 'GET' && path === `/api/codebases/${PROJECT_ID}/file`) {
    if (url.searchParams.get('path') === 'README.md') {
      sendJson(res, {
        path: 'README.md',
        content: README_TEXT,
        size: README_TEXT.length,
        etag: 'readme-1',
      });
    } else {
      sendJson(res, { error: 'File not found' }, 404);
    }
    return;
  }

  if (method === 'GET' && path === '/api/workflows') {
    sendJson(res, { workflows: [] });
    return;
  }

  if (method === 'GET' && path === `/api/projects/${PROJECT_ID}/issues`) {
    sendJson(res, ISSUES);
    return;
  }

  // Icon, colour and rail position. Nothing chosen, so the rail draws its
  // defaults — which is the state a newly-added project is in.
  if (path === `/api/projects/${PROJECT_ID}/presentation`) {
    sendJson(res, { presentation: null, sortOrder: null });
    return;
  }

  // The rail pushes its arrangement back on first render. Accepted and
  // discarded: this suite reads the rail, it does not rearrange it.
  if (method === 'PUT' && path === '/api/conversations/order') {
    sendJson(res, { success: true });
    return;
  }

  // Anything else is a 404 with the path recorded. A real server 404s too, so
  // this is not a special state the console has never seen — but the record
  // makes a newly-added console call visible instead of silent.
  unhandled.push(`${method} ${path}`);
  sendJson(res, { error: `No stub for ${method} ${path}` }, 404);
}

function serveStatic(res: ServerResponse, pathname: string): void {
  // `normalize` collapses `..` before the prefix check, so a crafted path
  // cannot read outside dist. The suite drives this server, but a test helper
  // that serves the filesystem still has no business serving all of it.
  const candidate = normalize(join(DIST, decodeURIComponent(pathname)));
  const isFile =
    (candidate === DIST || candidate.startsWith(DIST + sep)) &&
    existsSync(candidate) &&
    statSync(candidate).isFile();

  // The console is a single-page app: every unmatched path is a route, so it
  // gets index.html and React Router reads the URL.
  const file = isFile ? candidate : join(DIST, 'index.html');
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

/**
 * Start the stub on an ephemeral port.
 *
 * Ephemeral because the suite runs beside whatever else is on the machine —
 * and, in this repository, beside other worktrees doing the same thing.
 */
export async function startStubServer(): Promise<StubServer> {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(
      `No console build at ${DIST}. Run \`bun run build:web\` before the browser suite.`
    );
  }

  const state: StubState = {
    unhandled: [],
    queues: new Map(),
    streams: new Map(),
    busy: new Set(),
    controls: [],
    run: 'none',
    pushPrefs: structuredClone(PUSH_PREFS),
    pushDevices: structuredClone(PUSH_DEVICES),
    presence: new Map(),
  };
  // Held so `close()` can end the event streams: Node's `close` waits for open
  // sockets, and an SSE response is an open socket by design.
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) handleApi(req, res, url, state);
    else serveStatic(res, url.pathname);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The stub server did not bind a TCP port');
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    unhandled: state.unhandled,
    controls: state.controls,
    presence: state.presence,
    setBusy: (chatId, busy): void => {
      if (busy) state.busy.add(chatId);
      else state.busy.delete(chatId);
    },
    showPausedRun: (): void => {
      state.run = 'paused';
    },
    reset: (): void => {
      state.queues.clear();
      state.busy.clear();
      state.controls.length = 0;
      state.run = 'none';
      state.pushPrefs = structuredClone(PUSH_PREFS);
      state.pushDevices = structuredClone(PUSH_DEVICES);
      state.presence.clear();
    },
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, fail) => {
        server.close(err => {
          if (err) fail(err);
          else done();
        });
      });
    },
  };
}

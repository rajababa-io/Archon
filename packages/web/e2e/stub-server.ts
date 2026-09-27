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
  AUTH_STATUS,
  CHATS,
  CHAT_ID,
  CONVERSATION_COUNTS,
  MESSAGES,
  OTHER_MESSAGES,
  PROJECT,
  PROJECT_ID,
  type RawMessage,
} from './fixtures';

const DIST = resolve(fileURLToPath(new URL('../dist', import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  unhandled: string[],
  queues: Queues,
  streams: Map<string, ServerResponse>
): void {
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
    sendJson(res, {
      conversations: scope === 'done' ? [] : CHATS,
      counts: CONVERSATION_COUNTS,
    });
    return;
  }

  const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path);
  if (method === 'GET' && messagesMatch !== null) {
    sendJson(res, messagesFor(decodeURIComponent(messagesMatch[1])));
    return;
  }

  // Whether the server is mid-turn for this chat. Unlocked, which is what
  // makes the composer usable — the console asks this after a stream reconnect,
  // because the events that carry the answer are lost in the gap.
  const lockMatch = /^\/api\/conversations\/([^/]+)\/lock$/.exec(path);
  if (method === 'GET' && lockMatch !== null) {
    const lock: components['schemas']['ConversationLockResponse'] = {
      conversationId: decodeURIComponent(lockMatch[1]),
      locked: false,
    };
    sendJson(res, lock);
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
    void readJson(req).then(body => {
      const message: components['schemas']['QueuedMessage'] = {
        id: `queued-${String(chatQueue.length + 1)}`,
        text: typeof body.message === 'string' ? body.message : '',
        files: [],
        queuedAt: new Date().toISOString(),
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
    const queue: components['schemas']['ConversationQueueResponse'] = {
      conversationId: decodeURIComponent(queueMatch[1]),
      messages: queues.get(decodeURIComponent(queueMatch[1])) ?? [],
    };
    sendJson(res, queue);
    return;
  }

  if (method === 'GET' && path === '/api/dashboard/runs') {
    sendJson(res, { runs: [] });
    return;
  }

  if (method === 'GET' && path === '/api/workflows') {
    sendJson(res, { workflows: [] });
    return;
  }

  if (method === 'GET' && path === `/api/projects/${PROJECT_ID}/issues`) {
    sendJson(res, { issues: [] });
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

  const unhandled: string[] = [];
  const queues: Queues = new Map();
  const streams = new Map<string, ServerResponse>();
  // Held so `close()` can end the event streams: Node's `close` waits for open
  // sockets, and an SSE response is an open socket by design.
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) handleApi(req, res, url, unhandled, queues, streams);
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
    unhandled,
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

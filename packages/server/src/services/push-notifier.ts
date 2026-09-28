/**
 * The push notifier: decides when something deserves a notification on the
 * operator's phone, and sends it to every subscribed browser.
 *
 * It listens to the two in-process signals the dashboard stream is fed from:
 * a chat's turn ending (the conversation lock releasing) and the workflow
 * engine's run events. It pushes when
 *
 *   - a chat becomes awaiting — its turn ended on an unanswered ask block, or
 *     a run it started paused on a gate;
 *   - a workflow run finishes or fails;
 *   - a chat you FOLLOW finishes a turn.
 *
 * Runs executed by another process (a detached `archon` CLI run) emit their
 * events in that process, so they do not push. Chats start their runs inside
 * the server, which is where this listens.
 *
 * Two things keep it quiet. A push about a chat that is on screen in any
 * console right now is not sent (`ChatPresence`). And every push carries a
 * `tag` — one per chat, one per run — which the phone uses to replace the
 * previous notification for the same thing instead of stacking another.
 *
 * `decidePush` is the whole policy and is pure; `PushNotifier` does the
 * lookups and the delivery around it.
 */
import { awaitsAnswer, resolveChatMode, splitReply } from '@archon/awaiting';
import type { NotifyPrefs, PushSubscriptionRecord } from '@archon/core/db/push';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';
import { createLogger } from '@archon/paths';
import type { ChatPresence } from './push-presence';
import type { PushDelivery, VapidKeys } from './web-push';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('push');
  return cachedLog;
}

/**
 * What the service worker receives. The wire contract with
 * `packages/web/.../mobile/pwa/service-worker.js`: a title, one line, the tag
 * that collapses repeats, and the shell address a tap opens.
 */
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  path: string;
}

/**
 * Shell addresses a notification opens. They must match the phone's routes in
 * `mobile/lib/paths.ts`; `push-notifier.test.ts` checks them against it.
 */
export function chatLink(conversationId: string): string {
  return `/m/c/${encodeURIComponent(conversationId)}`;
}
export function runLink(runId: string): string {
  return `/m/r/${encodeURIComponent(runId)}`;
}
export const SETTINGS_LINK = '/m/settings';

/** What Settings' "Send a test" pushes. */
export const TEST_PUSH: PushPayload = {
  title: 'Archon',
  body: 'Test notification: push works on this device.',
  tag: 'test',
  path: SETTINGS_LINK,
};

/** A chat as a push names it: the id every client uses, its project, its title. */
export interface ChatRef {
  platformId: string;
  projectId: string | null;
  title: string | null;
}

export type PushTrigger =
  | { kind: 'question'; chat: ChatRef; question: string }
  | { kind: 'turn_finished'; chat: ChatRef; line: string }
  | { kind: 'approval'; runId: string; workflow: string; chat: ChatRef | null; message: string }
  | {
      kind: 'run_finished' | 'run_failed';
      runId: string;
      workflow: string;
      chat: ChatRef | null;
      projectId: string | null;
      line: string;
    };

const MAX_LINE = 140;

/** The first non-empty line of some text, cut to fit a notification. */
export function oneLine(text: string): string {
  const line =
    text
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0) ?? '';
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

function chatName(chat: ChatRef | null): string {
  return chat?.title?.trim() || 'A chat';
}

/**
 * Whether a trigger pushes, and what. Null when it does not.
 *
 * A muted chat or project pushes nothing. A followed chat pushes everything
 * about itself, whatever the global triggers say — the more specific choice
 * wins. Otherwise the global trigger for the kind decides, and a finished turn
 * pushes only for a followed chat. A chat on screen anywhere pushes nothing.
 */
export function decidePush(
  trigger: PushTrigger,
  prefs: NotifyPrefs,
  isVisible: (chatId: string) => boolean
): PushPayload | null {
  const chat = trigger.chat;
  const projectId =
    trigger.kind === 'run_finished' || trigger.kind === 'run_failed'
      ? (chat?.projectId ?? trigger.projectId)
      : (chat?.projectId ?? null);
  const mode = resolveChatMode(prefs, chat?.platformId ?? null, projectId);
  if (mode === 'muted') return null;
  const following = mode === 'following';

  const wanted = ((): boolean => {
    switch (trigger.kind) {
      case 'question':
      case 'approval':
        return following || prefs.triggers.awaiting;
      case 'turn_finished':
        return following;
      case 'run_finished':
        return following || prefs.triggers.runFinished;
      case 'run_failed':
        return following || prefs.triggers.runFailed;
    }
  })();
  if (!wanted) return null;
  if (chat !== null && isVisible(chat.platformId)) return null;

  switch (trigger.kind) {
    case 'question':
      return {
        title: `${chatName(chat)} needs you`,
        body: oneLine(trigger.question) || 'A question is waiting for your answer',
        tag: `chat:${trigger.chat.platformId}`,
        path: chatLink(trigger.chat.platformId),
      };
    case 'turn_finished':
      return {
        title: chatName(chat),
        body: oneLine(trigger.line) || 'Finished its turn',
        tag: `chat:${trigger.chat.platformId}`,
        path: chatLink(trigger.chat.platformId),
      };
    case 'approval':
      return {
        title: `${trigger.workflow} needs your approval`,
        body: oneLine(trigger.message) || chatName(chat),
        tag: `run:${trigger.runId}`,
        path: runLink(trigger.runId),
      };
    case 'run_finished':
    case 'run_failed':
      return {
        title: `${trigger.workflow} ${trigger.kind === 'run_finished' ? 'finished' : 'failed'}`,
        body: oneLine(trigger.line) || chatName(chat),
        tag: `run:${trigger.runId}`,
        path: runLink(trigger.runId),
      };
  }
}

/** The question a message asks: the first ask block's first title, else its prose. */
export function questionLine(content: string): string {
  for (const part of splitReply(content)) {
    if (part.kind === 'ask') return part.spec.questions[0]?.title ?? '';
  }
  return oneLine(content);
}

/** Everything the notifier reads and writes, injected so the policy can be tested alone. */
export interface PushNotifierDeps {
  /** Null when push is not configured: every trigger is dropped without a lookup. */
  keys: VapidKeys | null;
  presence: ChatPresence;
  readPrefs: () => Promise<NotifyPrefs>;
  listSubscriptions: () => Promise<PushSubscriptionRecord[]>;
  deleteSubscription: (endpoint: string) => Promise<boolean>;
  markDelivered: (id: string) => Promise<void>;
  send: (
    subscription: PushSubscriptionRecord,
    payload: string,
    keys: VapidKeys
  ) => Promise<PushDelivery>;
  /** A web chat by platform id; null when it does not exist or is not a visible chat. */
  findChat: (
    platformId: string
  ) => Promise<(ChatRef & { completed: boolean; dbId: string }) | null>;
  /** The chat's newest message. */
  newestMessage: (dbId: string) => Promise<{ role: string; content: string } | null>;
  /** A run and the chat that owns it, or null for a sub-run or a run that is gone. */
  findRun: (runId: string) => Promise<{
    workflow: string;
    projectId: string | null;
    chat: ChatRef | null;
  } | null>;
}

export interface PushFanout {
  delivered: number;
  failed: number;
  removed: number;
}

export class PushNotifier {
  constructor(private readonly deps: PushNotifierDeps) {}

  get enabled(): boolean {
    return this.deps.keys !== null;
  }

  /** A chat's turn ended: it is now asking you something, or — if you follow it — done. */
  async turnEnded(platformId: string): Promise<void> {
    if (!this.enabled) return;
    const chat = await this.deps.findChat(platformId);
    if (chat === null) return;
    const newest = await this.deps.newestMessage(chat.dbId);
    if (newest?.role !== 'assistant') return;
    const trigger: PushTrigger = awaitsAnswer({
      completed: chat.completed,
      newestAgentMessage: newest.content,
    })
      ? { kind: 'question', chat, question: questionLine(newest.content) }
      : { kind: 'turn_finished', chat, line: newest.content };
    await this.push(trigger);
  }

  /** A workflow engine event; only gates, completions and failures matter here. */
  async workflowEvent(event: WorkflowEmitterEvent): Promise<void> {
    if (!this.enabled) return;
    if (
      event.type !== 'approval_pending' &&
      event.type !== 'workflow_completed' &&
      event.type !== 'workflow_failed'
    ) {
      return;
    }
    const run = await this.deps.findRun(event.runId);
    if (run === null) return;
    const base = { runId: event.runId, workflow: run.workflow, chat: run.chat };
    const trigger: PushTrigger =
      event.type === 'approval_pending'
        ? { kind: 'approval', ...base, message: event.message }
        : event.type === 'workflow_completed'
          ? { kind: 'run_finished', ...base, projectId: run.projectId, line: chatName(run.chat) }
          : { kind: 'run_failed', ...base, projectId: run.projectId, line: event.error };
    await this.push(trigger);
  }

  private async push(trigger: PushTrigger): Promise<void> {
    const payload = decidePush(trigger, await this.deps.readPrefs(), id =>
      this.deps.presence.isVisible(id)
    );
    if (payload === null) return;
    const result = await this.deliver(payload);
    getLog().info({ kind: trigger.kind, tag: payload.tag, ...result }, 'push.sent');
  }

  /**
   * Send one payload to every subscribed browser. A subscription the push
   * service says is gone is deleted; any other failure is logged and kept.
   */
  async deliver(payload: PushPayload): Promise<PushFanout> {
    const keys = this.deps.keys;
    const out: PushFanout = { delivered: 0, failed: 0, removed: 0 };
    if (keys === null) return out;
    const body = JSON.stringify(payload);
    const subscriptions = await this.deps.listSubscriptions();
    await Promise.all(
      subscriptions.map(async sub => {
        const result = await this.deps.send(sub, body, keys);
        if (result.outcome === 'delivered') {
          out.delivered += 1;
          await this.deps.markDelivered(sub.id);
        } else if (result.outcome === 'gone') {
          out.removed += 1;
          await this.deps.deleteSubscription(sub.endpoint);
        } else {
          out.failed += 1;
          getLog().warn(
            { status: result.status, detail: result.detail, userAgent: sub.userAgent },
            'push.delivery_failed'
          );
        }
      })
    );
    return out;
  }
}

/**
 * Web Push, assembled at startup: the VAPID keys from the environment, the
 * presence registry, and a notifier wired to the database and to the two
 * in-process signals it listens to (see `push-notifier.ts`).
 */
import * as conversationDb from '@archon/core/db/conversations';
import * as messageDb from '@archon/core/db/messages';
import * as pushDb from '@archon/core/db/push';
import * as workflowDb from '@archon/core/db/workflows';
import type { Conversation } from '@archon/core';
import { getWorkflowEventEmitter } from '@archon/workflows/event-emitter';
import { createLogger } from '@archon/paths';
import type { WebAdapter } from '../adapters/web';
import type { PushRoutesDeps } from '../routes/push';
import { PushNotifier, type ChatRef } from './push-notifier';
import { ChatPresence } from './push-presence';
import { readVapidConfig, sendWebPush } from './web-push';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('push');
  return cachedLog;
}

/** A conversation the rail lists, as a push names it; null for a hidden worker or a deleted chat. */
function asChat(
  conversation: Conversation | null
): (ChatRef & { completed: boolean; dbId: string }) | null {
  if (conversation === null || conversation.hidden || conversation.deleted_at !== null) return null;
  return {
    platformId: conversation.platform_conversation_id,
    projectId: conversation.codebase_id,
    title: conversation.title,
    completed: conversation.completed_at !== null,
    dbId: conversation.id,
  };
}

type Chat = NonNullable<ReturnType<typeof asChat>>;

async function findChat(platformId: string): Promise<Chat | null> {
  return asChat(await conversationDb.getConversationByPlatformId('web', platformId));
}

async function newestMessage(dbId: string): Promise<{ role: string; content: string } | null> {
  return (await messageDb.getLastMessagePerConversation([dbId])).get(dbId) ?? null;
}

async function findRun(
  runId: string
): Promise<{ workflow: string; projectId: string | null; chat: Chat | null } | null> {
  const run = await workflowDb.getWorkflowRun(runId);
  // A sub-run is one step of its parent; the parent's own events speak for it.
  if (run?.parent_run_id !== null) return null;
  const owner = run.parent_conversation_id ?? run.conversation_id;
  const chat = asChat(await conversationDb.getConversationById(owner));
  return { workflow: run.workflow_name, projectId: run.codebase_id, chat };
}

export function startPush(webAdapter: WebAdapter): PushRoutesDeps {
  const vapid = readVapidConfig(process.env);
  if (vapid.enabled) getLog().info('push.enabled');
  else getLog().info({ missing: vapid.missing, problem: vapid.problem }, 'push.disabled');

  const presence = new ChatPresence();
  const notifier = new PushNotifier({
    keys: vapid.enabled ? vapid.keys : null,
    presence,
    readPrefs: pushDb.readNotifyPrefs,
    listSubscriptions: pushDb.listPushSubscriptions,
    deleteSubscription: pushDb.deletePushSubscription,
    markDelivered: pushDb.markPushDelivered,
    send: sendWebPush,
    findChat,
    newestMessage,
    findRun,
  });

  if (vapid.enabled) {
    const failed = (what: string, err: unknown): void => {
      getLog().error({ err, what }, 'push.notify_failed');
    };
    webAdapter.setTurnEndedListener(conversationId => {
      void notifier.turnEnded(conversationId).catch((err: unknown) => {
        failed('turn_ended', err);
      });
    });
    getWorkflowEventEmitter().subscribe(event => {
      void notifier.workflowEvent(event).catch((err: unknown) => {
        failed(event.type, err);
      });
    });
  }

  return { vapid, presence, notifier };
}

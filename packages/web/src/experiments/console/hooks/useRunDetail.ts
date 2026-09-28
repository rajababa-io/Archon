import { useEffect } from 'react';
import * as skill from '../skills';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { useRunStreamSSE } from '../lib/sse';
import { runMessageConversationId, type Run } from '../primitives/run';
import type { RunEvent } from '../primitives/event';
import type { Message } from '../primitives/message';

export interface RunDetailView {
  run: Run;
  events: RunEvent[];
}

export interface RunDetail {
  /** Undefined while loading; null only when there is no run id to load. */
  detail: RunDetailView | null | undefined;
  detailError: Error | undefined;
  messages: Message[] | undefined;
}

/**
 * One run as its detail screen reads it — the run with its workflow events,
 * and the messages of the conversation its agents wrote to — kept live.
 *
 * Messages are keyed by the *platform* conversation id, which the messages
 * route takes: a CLI run's own conversation, or a chat-dispatched run's worker
 * conversation (#2048). `runMessageConversationId` picks whichever is present.
 *
 * Live updates come from the run's conversation stream. Its events invalidate
 * the run and message keys and the cache refetches. A 30s refetch runs while
 * the run is still running or paused, because a stream that drops and
 * reconnects (sleep, a network change, a phone backgrounding the page) can miss
 * the terminal event. It stops once the run reaches a terminal state.
 */
export function useRunDetail(runId: string | undefined): RunDetail {
  const { data: detail, error: detailError } = useEntity<RunDetailView | null>(
    runId !== undefined ? K.run(runId) : 'noop:no-run-id',
    () => (runId !== undefined ? skill.getRun(runId) : Promise.resolve(null))
  );

  const conversationPlatformId = runMessageConversationId(detail?.run);
  const { data: messages } = useEntity<Message[]>(
    conversationPlatformId !== null
      ? K.messages(conversationPlatformId)
      : 'noop:no-conversation-id',
    () =>
      conversationPlatformId !== null
        ? skill.listMessages(conversationPlatformId)
        : Promise.resolve([])
  );

  useRunStreamSSE(conversationPlatformId, runId ?? null);

  const status = detail?.run.status;
  useEffect(() => {
    if (runId === undefined) return;
    if (status !== 'running' && status !== 'paused') return;
    const id = setInterval(() => {
      invalidate(K.run(runId));
      if (conversationPlatformId !== null) {
        invalidate(K.messages(conversationPlatformId));
      }
    }, 30000);
    return (): void => {
      clearInterval(id);
    };
  }, [runId, status, conversationPlatformId]);

  return { detail, detailError, messages };
}

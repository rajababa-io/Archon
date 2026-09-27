/**
 * Which chats the server is executing a turn for, right now.
 *
 * The poll is a backstop, not the mechanism. Both halves of this answer are
 * now pushed on the dashboard stream — the conversation lock as a trigger to
 * ask again, and the running tool as the thing itself (see
 * primitives/live-activity) — so the interval no longer carries the news; it
 * repairs. What it repairs is what a push cannot: the stream being down, an
 * event that landed while the tab was hidden, a run that never takes the
 * conversation lock at all, and a pushed value that has drifted from what
 * /api/health would say. Skipped entirely while the tab is hidden.
 *
 * It is deliberately still here rather than reduced to a reconnect snapshot.
 * A stream that reconnects re-asks (`onopen` in lib/sse), but a stream that
 * stays up while the server's answer changes underneath it — a background
 * workflow starting, an optimistic patch that was wrong — has no other way to
 * be corrected. One request every 30s is the price of that.
 *
 * IT ALSO CARRIES THE DEPLOY. `/api/health` reports what the deploy replacing
 * this server is doing, and lib/live-deploy reads it from here rather than
 * starting a timer of its own. That read must never cost a conversation turn —
 * a deploy waits for the turns in flight before it swaps the container, so
 * asking a chat how it is going is one of the things it waits for. A browser
 * GET is not a turn; see components/DeployStrip.
 *
 * ONE poll, however many readers. Two surfaces need this — the rail's per-row
 * mark and the project chip's roll-up — and both are on screen together on the
 * Chat tab. `invalidate` starts a load every time it is called, so two
 * independent intervals against one shared key would double the request rate
 * against `/api/health` for no extra truth. The interval is reference-counted
 * here instead.
 */

import { useEffect, useMemo } from 'react';
import * as skill from '../skills';
import type { ActiveChats, ActiveTool, DeployStatus } from '../skills/activeChats';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';

const POLL_MS = 30_000;

let readers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  if (document.visibilityState === 'visible') invalidate(K.activeChats);
}

export interface LiveChats {
  /** Platform conversation ids the server is executing a turn for. */
  ids: ReadonlySet<string>;
  /** What each of those is doing, when it is inside a tool. */
  tools: Readonly<Record<string, ActiveTool>>;
  /** Platform conversation ids with an open CI watch. */
  ciWaiting: ReadonlySet<string>;
  /**
   * Whether the server has answered yet.
   *
   * The difference between "not working" and "not asked yet" is not cosmetic:
   * a caller that treats the second as the first will describe a chat that is
   * mid-turn as one that has finished. Callers that draw a conclusion from the
   * ABSENCE of work must check this first.
   */
  known: boolean;
  /**
   * What a deploy replacing this server is doing. Undefined when the server has
   * not answered yet, or could not say — see lib/live-deploy, which is what
   * reads this.
   */
  deploy?: DeployStatus;
}

export function useLiveChats(): LiveChats {
  const { data } = useEntity<ActiveChats>(K.activeChats, skill.getActiveChats);

  useEffect(() => {
    readers += 1;
    if (timer === null) {
      timer = setInterval(tick, POLL_MS);
      document.addEventListener('visibilitychange', tick);
    }
    return (): void => {
      readers -= 1;
      if (readers === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
        document.removeEventListener('visibilitychange', tick);
      }
    };
  }, []);

  return useMemo(
    () => ({
      ids: new Set(data?.ids ?? []),
      tools: data?.tools ?? {},
      ciWaiting: new Set(data?.ciWaiting ?? []),
      known: data !== undefined,
      ...(data?.deploy ? { deploy: data.deploy } : {}),
    }),
    [data]
  );
}

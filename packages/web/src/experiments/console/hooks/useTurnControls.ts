import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { ComposerControl } from '../components/ChatComposer';

const NO_QUEUE: readonly skill.QueuedMessage[] = [];

export interface TurnControls {
  /** Messages waiting behind the running turn, oldest first — the server's list. */
  queued: readonly skill.QueuedMessage[];
  /** Queued ids with a withdraw in flight. */
  busyIds: ReadonlySet<string>;
  stopping: boolean;
  /** Something worth saying that is not a failure — e.g. a pull-back lost the race. */
  notice: string | null;
  controlRef: RefObject<ComposerControl | null>;
  stop: () => void;
  /** Send while the agent works: the server queues it. */
  queueSend: (text: string, files?: File[]) => void;
  edit: (message: skill.QueuedMessage) => void;
  remove: (message: skill.QueuedMessage) => void;
  /** Up in an empty composer: pull the newest queued message back. */
  pullBackLast: () => boolean;
}

/**
 * Stop, queue, and take back — everything the chat can do to a turn it did not
 * wait for.
 *
 * Every outcome here is the server's answer, not a local guess: the queue is
 * read from the server, a withdraw is only shown as withdrawn when the server
 * says it won the race with delivery, and the composer goes idle when the
 * server's lock event says the stopped turn has ended.
 *
 * @param conversationId - Platform id of the chat on screen; null for a chat
 *   not yet created, which has no turn to stop and nothing queued.
 * @param locked - The server's lock on that chat: a turn is executing right now.
 */
export function useTurnControls(conversationId: string | null, locked: boolean): TurnControls {
  const { data: queue } = useEntity<skill.ConversationQueue>(
    conversationId !== null ? K.conversationQueue(conversationId) : 'noop:no-conv-queue',
    () =>
      conversationId !== null
        ? skill.getConversationQueue(conversationId)
        : Promise.resolve({ conversationId: '', messages: [] })
  );
  const queued = queue?.messages ?? NO_QUEUE;

  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const controlRef = useRef<ComposerControl | null>(null);

  // A different chat is a different turn: none of this carries over.
  useEffect(() => {
    setStopping(false);
    setNotice(null);
    setBusyIds(new Set());
  }, [conversationId]);

  // The stopped turn has ended when the server says so: its reply `stopped`,
  // or — for a turn slower than the reply waits — its lock going down. The
  // LOCK, not `working`: a queued message starts the next turn the moment the
  // stopped one ends, and `working` can stay true straight across the gap.
  useEffect(() => {
    if (!locked) setStopping(false);
  }, [locked]);

  const stop = useCallback((): void => {
    if (conversationId === null) return;
    setStopping(true);
    setNotice(null);
    void skill
      .interruptConversation(conversationId)
      .then(result => {
        if (result.status === 'stopping') {
          setNotice('Stop sent — the agent has not ended its turn yet.');
        } else {
          setStopping(false);
          // Stopped or already idle: ask the lock again rather than waiting on
          // an event, in case this tab missed it.
          invalidate(K.conversationLock(conversationId));
        }
      })
      .catch((e: unknown) => {
        setStopping(false);
        setNotice(`Could not stop the agent: ${e instanceof Error ? e.message : 'unknown error'}`);
      });
  }, [conversationId]);

  const queueSend = useCallback(
    (text: string, files?: File[]): void => {
      if (conversationId === null) return;
      setNotice(null);
      void skill
        .sendMessage(conversationId, text, files)
        .then(() => {
          invalidate(K.conversationQueue(conversationId));
        })
        .catch((e: unknown) => {
          // Nothing was queued, so the text goes back where it came from rather
          // than vanishing with the error.
          controlRef.current?.restore(text);
          setNotice(`Not queued: ${e instanceof Error ? e.message : 'send failed'}`);
        });
    },
    [conversationId]
  );

  const withdraw = useCallback(
    (message: skill.QueuedMessage, then: (withdrawn: skill.QueuedMessage) => void): void => {
      if (conversationId === null) return;
      setNotice(null);
      setBusyIds(prev => new Set(prev).add(message.id));
      void skill
        .withdrawQueuedMessage(conversationId, message.id)
        .then(result => {
          if (result.status === 'withdrawn') then(result.message);
          else
            setNotice(
              'Already sent — the agent picked that message up before it could be taken back.'
            );
        })
        .catch((e: unknown) => {
          setNotice(`Could not take it back: ${e instanceof Error ? e.message : 'unknown error'}`);
        })
        .finally(() => {
          setBusyIds(prev => {
            const next = new Set(prev);
            next.delete(message.id);
            return next;
          });
          invalidate(K.conversationQueue(conversationId));
        });
    },
    [conversationId]
  );

  const edit = useCallback(
    (message: skill.QueuedMessage): void => {
      withdraw(message, withdrawn => {
        controlRef.current?.restore(withdrawn.text);
        if (withdrawn.files.length > 0) {
          setNotice('Its attachments were not kept — attach them again before sending.');
        }
      });
    },
    [withdraw]
  );

  const remove = useCallback(
    (message: skill.QueuedMessage): void => {
      withdraw(message, () => undefined);
    },
    [withdraw]
  );

  const pullBackLast = useCallback((): boolean => {
    const last = queued.at(-1);
    if (last === undefined || busyIds.has(last.id)) return false;
    edit(last);
    return true;
  }, [queued, busyIds, edit]);

  return {
    queued,
    busyIds,
    stopping,
    notice,
    controlRef,
    stop,
    queueSend,
    edit,
    remove,
    pullBackLast,
  };
}

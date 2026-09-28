/**
 * Web Push storage: the browsers subscribed to push, and what to be told about.
 *
 * One install serves one operator, so both belong to the install rather than
 * to a user. Resolving a chat's effective mode from these rows is the
 * notifier's job; this module stores and reads them.
 */
import { randomUUID } from 'crypto';
import { pool, getDialect } from './connection';

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  /** The browser's ECDH public key, base64url, as the Push API reports it. */
  p256dh: string;
  /** The browser's auth secret, base64url. */
  auth: string;
  userAgent: string | null;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
}

function toSubscription(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
  };
}

/**
 * Store a browser's subscription. Subscribing again from the same browser
 * returns the same endpoint, possibly with new keys, so the endpoint is the
 * identity and the keys are replaced.
 */
export async function savePushSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO remote_agent_push_subscriptions (id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    [randomUUID(), input.endpoint, input.p256dh, input.auth, input.userAgent]
  );
}

/** Forget a subscription. True when there was one to forget. */
export async function deletePushSubscription(endpoint: string): Promise<boolean> {
  const res = await pool.query('DELETE FROM remote_agent_push_subscriptions WHERE endpoint = $1', [
    endpoint,
  ]);
  return res.rowCount > 0;
}

export async function listPushSubscriptions(): Promise<PushSubscriptionRecord[]> {
  const res = await pool.query<PushSubscriptionRow>(
    `SELECT id, endpoint, p256dh, auth, user_agent FROM remote_agent_push_subscriptions
     ORDER BY created_at ASC`
  );
  return res.rows.map(toSubscription);
}

export async function markPushDelivered(id: string): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_push_subscriptions SET last_success_at = ${getDialect().now()} WHERE id = $1`,
    [id]
  );
}

export const NOTIFY_MODES = ['default', 'muted', 'following'] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

/** A project can only be muted; following is a chat's. */
export type ProjectNotifyMode = Exclude<NotifyMode, 'following'>;

/** The three global triggers. */
export interface NotifyTriggers {
  /** A chat needs you: an unanswered question, or a run it started paused on a gate. */
  awaiting: boolean;
  runFinished: boolean;
  runFailed: boolean;
}

export interface NotifyPrefs {
  triggers: NotifyTriggers;
  /** Muted projects, by codebase id. A project absent here is `default`. */
  mutedProjects: string[];
  /** Chats with a mode of their own, by platform conversation id. Absent is `default`. */
  conversations: Record<string, Exclude<NotifyMode, 'default'>>;
}

interface NotifyPrefRow {
  scope: string;
  scope_id: string;
  mode: string;
  // Postgres answers a boolean, SQLite an integer; NULL is "never set".
  notify_awaiting: boolean | number | null;
  notify_run_finished: boolean | number | null;
  notify_run_failed: boolean | number | null;
}

/** NULL and a missing row both mean on: push is opt-out per trigger. */
function triggerOn(value: boolean | number | null | undefined): boolean {
  return value === null || value === undefined || value === true || value === 1;
}

export async function readNotifyPrefs(): Promise<NotifyPrefs> {
  const res = await pool.query<NotifyPrefRow>(
    `SELECT scope, scope_id, mode, notify_awaiting, notify_run_finished, notify_run_failed
     FROM remote_agent_notify_prefs`
  );
  const global = res.rows.find(r => r.scope === 'global');
  const prefs: NotifyPrefs = {
    triggers: {
      awaiting: triggerOn(global?.notify_awaiting),
      runFinished: triggerOn(global?.notify_run_finished),
      runFailed: triggerOn(global?.notify_run_failed),
    },
    mutedProjects: [],
    conversations: {},
  };
  for (const row of res.rows) {
    if (row.scope === 'project' && row.mode === 'muted') prefs.mutedProjects.push(row.scope_id);
    if (row.scope === 'conversation' && (row.mode === 'muted' || row.mode === 'following')) {
      prefs.conversations[row.scope_id] = row.mode;
    }
  }
  return prefs;
}

export async function setNotifyTriggers(triggers: Partial<NotifyTriggers>): Promise<void> {
  const current = (await readNotifyPrefs()).triggers;
  const next = { ...current, ...triggers };
  const now = getDialect().now();
  await pool.query(
    `INSERT INTO remote_agent_notify_prefs
       (scope, scope_id, mode, notify_awaiting, notify_run_finished, notify_run_failed, updated_at)
     VALUES ('global', '', 'default', $1, $2, $3, ${now})
     ON CONFLICT (scope, scope_id) DO UPDATE
       SET notify_awaiting = excluded.notify_awaiting,
           notify_run_finished = excluded.notify_run_finished,
           notify_run_failed = excluded.notify_run_failed,
           updated_at = ${now}`,
    [next.awaiting, next.runFinished, next.runFailed]
  );
}

/**
 * Set a chat's or a project's mode. `default` removes the row, so "no row" is
 * the only way a scope can be default and the table holds only exceptions.
 */
export async function setNotifyMode(
  target:
    | { scope: 'project'; id: string; mode: ProjectNotifyMode }
    | { scope: 'conversation'; id: string; mode: NotifyMode }
): Promise<void> {
  if (target.mode === 'default') {
    await pool.query('DELETE FROM remote_agent_notify_prefs WHERE scope = $1 AND scope_id = $2', [
      target.scope,
      target.id,
    ]);
    return;
  }
  const now = getDialect().now();
  await pool.query(
    `INSERT INTO remote_agent_notify_prefs (scope, scope_id, mode, updated_at)
     VALUES ($1, $2, $3, ${now})
     ON CONFLICT (scope, scope_id) DO UPDATE SET mode = excluded.mode, updated_at = ${now}`,
    [target.scope, target.id, target.mode]
  );
}

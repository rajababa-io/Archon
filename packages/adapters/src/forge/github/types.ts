export interface WebhookEvent {
  action: 'opened' | 'closed' | 'created' | 'edited' | 'reopened' | 'labeled' | (string & {});
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    state: 'open' | 'closed';
    pull_request?: { url: string }; // Present if the issue is actually a PR
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    state: 'open' | 'closed';
    merged?: boolean;
    /** The commit the merge produced on the base branch; set once merged. */
    merge_commit_sha?: string | null;
    base?: { ref: string };
    changed_files?: number;
    additions?: number;
    deletions?: number;
  };
  comment?: {
    /** GitHub's numeric comment id */
    id?: number;
    body: string;
    user: { login: string };
    /** ISO timestamp of the comment's last update; GitHub bumps it on edit */
    updated_at?: string;
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
    html_url: string;
    default_branch: string;
  };
  sender: { login: string };
  /**
   * GitHub App webhook deliveries include the installation id on every event.
   * Used to short-circuit the per-(owner, repo) installation lookup in App
   * mode — saves one HTTP round trip per inbound event. Absent on PAT-mode
   * "manual webhook" deliveries; the adapter falls back to the lookup path.
   */
  installation?: { id: number };
}

export interface CheckRunCompletedEvent {
  action: 'completed';
  check_run: {
    status: 'completed';
    conclusion: string;
    completed_at: string;
    pull_requests: { number: number }[];
  };
  repository: { full_name: string };
  sender?: { login: string };
  installation?: { id: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCheckRunCompletedEvent(value: unknown): value is CheckRunCompletedEvent {
  if (!isRecord(value) || value.action !== 'completed') return false;
  const checkRun = value.check_run;
  const repository = value.repository;
  if (!isRecord(checkRun) || !isRecord(repository)) return false;
  if (
    checkRun.status !== 'completed' ||
    typeof checkRun.conclusion !== 'string' ||
    checkRun.conclusion === '' ||
    typeof checkRun.completed_at !== 'string' ||
    !Number.isFinite(Date.parse(checkRun.completed_at)) ||
    typeof repository.full_name !== 'string' ||
    repository.full_name === '' ||
    !Array.isArray(checkRun.pull_requests) ||
    checkRun.pull_requests.length === 0
  ) {
    return false;
  }
  return checkRun.pull_requests.every(
    pullRequest =>
      isRecord(pullRequest) &&
      typeof pullRequest.number === 'number' &&
      Number.isInteger(pullRequest.number) &&
      pullRequest.number > 0
  );
}

/**
 * What an installation-lifecycle delivery tells us: which installation it is
 * about, and which repositories it now covers or has stopped covering.
 *
 * GitHub sends two event names with this shape. `installation` announces the
 * App being installed on, or removed from, a whole account;
 * `installation_repositories` announces repositories being added to, or
 * removed from, an installation that already exists. Neither carries a
 * top-level `repository`, which is why they cannot go through the
 * issue/comment parsing path.
 */
export interface InstallationEventSummary {
  installationId: number;
  /** The account the App is installed on, when the payload names it. */
  account: string | undefined;
  /** Repositories this delivery says the installation now covers. */
  added: { owner: string; repo: string }[];
  /** Repositories this delivery says the installation no longer covers. */
  removed: { owner: string; repo: string }[];
}

/** Actions on the `installation` event that revoke access rather than grant it. */
const REVOKING_INSTALLATION_ACTIONS = new Set(['deleted', 'suspend']);

function parseRepositoryList(value: unknown): { owner: string; repo: string }[] {
  if (!Array.isArray(value)) return [];
  const parsed: { owner: string; repo: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.full_name !== 'string') continue;
    const [owner, repo] = entry.full_name.split('/');
    if (owner === undefined || owner === '' || repo === undefined || repo === '') continue;
    parsed.push({ owner, repo });
  }
  return parsed;
}

/**
 * Parse an `installation` or `installation_repositories` delivery. Returns
 * null when the payload does not carry the one field the caller needs — the
 * installation id — so the caller can raise a typed error instead of acting on
 * a shape it does not understand.
 */
export function parseInstallationEvent(value: unknown): InstallationEventSummary | null {
  if (!isRecord(value)) return null;
  const installation = value.installation;
  if (!isRecord(installation) || typeof installation.id !== 'number') return null;

  const account =
    isRecord(installation.account) && typeof installation.account.login === 'string'
      ? installation.account.login
      : undefined;

  // `installation` carries one `repositories` list whose meaning depends on the
  // action; `installation_repositories` carries an explicit added/removed pair.
  const revoking =
    typeof value.action === 'string' && REVOKING_INSTALLATION_ACTIONS.has(value.action);
  const wholeAccountList = parseRepositoryList(value.repositories);

  return {
    installationId: installation.id,
    account,
    added: revoking
      ? parseRepositoryList(value.repositories_added)
      : [...wholeAccountList, ...parseRepositoryList(value.repositories_added)],
    removed: [
      ...(revoking ? wholeAccountList : []),
      ...parseRepositoryList(value.repositories_removed),
    ],
  };
}

/**
 * A delivery whose shape the adapter cannot route. Thrown rather than returned
 * so an unparseable payload is loud in the logs instead of being dropped.
 *
 * The raw payload is attached for diagnostics but kept NON-ENUMERABLE on
 * purpose: webhook bodies contain issue and comment text, and pino's error
 * serializer walks enumerable own properties, so an enumerable field here
 * would put user-authored content into every log line that reports this error.
 */
export class MalformedWebhookEventError extends Error {
  readonly payload!: string;

  constructor(eventName: string | undefined, payload: string) {
    super(
      `Unroutable GitHub webhook delivery (event "${eventName ?? 'unknown'}"): ` +
        'no top-level "repository" and not an installation-lifecycle event.'
    );
    this.name = 'MalformedWebhookEventError';
    Object.defineProperty(this, 'payload', { value: payload, enumerable: false });
  }
}

/**
 * Whether a delivery names the repository the issue/comment path needs.
 * Validates only that identity — the rest of `WebhookEvent` is routed by the
 * optional-field checks in `parseEvent`.
 */
export function namesRepository(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const repository = value.repository;
  if (!isRecord(repository)) return false;
  const owner = repository.owner;
  return (
    isRecord(owner) &&
    typeof owner.login === 'string' &&
    owner.login !== '' &&
    typeof repository.name === 'string' &&
    repository.name !== ''
  );
}

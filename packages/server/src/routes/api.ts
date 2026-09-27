/**
 * REST API routes for the Archon Web UI.
 * Provides conversation, codebase, and SSE streaming endpoints.
 */

import { getTerminalRecord } from '@archon/workflows/terminal-record';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { isEffortRung } from '@archon/paths/effort';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import type { WebAdapter } from '../adapters/web';
import { boundMetadataToolOutputs } from '../adapters/web/truncate';
import { DASHBOARD_STREAM } from '../adapters/web/transport';
import {
  rm,
  readFile,
  writeFile,
  unlink,
  mkdir,
  readdir,
  realpath,
  stat,
  rename,
} from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { normalize, join, basename, dirname, resolve } from 'path';
import { randomUUID, createHash } from 'crypto';
import type { Context } from 'hono';
import { cleanupUploads } from './upload-cleanup';
import {
  ISSUE_DETAIL_QUERY,
  ISSUE_LIST_QUERY,
  githubGraphQl,
  isIssueReadFailure,
  repoSlug,
  resolveIssueSource,
  toIssue,
  toIssueDetail,
} from './github-issues';
import type {
  ConversationLockManager,
  AttachedFile,
  HandleMessageContext,
  TurnContext,
  GlobalConfig,
  TiersPatch,
  UserRole,
  SchemaVersionInfo,
  ChatModelRequest,
} from '@archon/core';
import {
  handleMessage,
  getDatabaseType,
  getSchemaVersion,
  loadConfig,
  loadRepoConfig,
  toSafeConfig,
  updateGlobalConfig,
  cloneRepository,
  registerRepository,
  registerFolder,
  ConversationNotFoundError,
  generateAndSetTitle,
  resolveTitleRequest,
  resolveNextChatModel,
  isPerUserGitHubEnabled,
  loadDeviceFlowConfig,
  startDeviceFlow,
  pollDeviceFlowOnce,
  persistGithubConnection,
  DeviceFlowError,
  GithubIdentityConflictError,
  getUserGithubTokenRecord,
  deleteUserGithubToken,
  isPerUserProviderKeysEnabled,
  persistProviderApiKey,
  InvalidProviderKeyError,
  listUserProviderKeys,
  deleteUserProviderKey,
  listConnectableVendors,
  buildAgentCredentialMatrix,
  normalizeCredentialVendor,
  SUBSCRIPTION_PROVIDERS,
  startOAuth,
  pollOAuth,
  OAuthCallbackPortBusyError,
  getUserAiPrefs,
  setUserTiers,
  setUserAliases,
  setUserDefault,
  DRAIN_REFUSAL_NOTICE,
} from '@archon/core';
import type { UserTiersPatch, UserAliasesPatch, AliasesPatch } from '@archon/core';
import { InvalidConfigError, parseWorkflowRunConfig } from '@archon/core/config';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { EffortLevel } from '@archon/workflows/schemas/effort';
import {
  findRepoRoot,
  removeWorktree,
  toRepoPath,
  toWorktreePath,
  readWorkingChanges,
  readWorkingFileDiff,
  NotAGitCheckoutError,
} from '@archon/git';
import { readConversationCheckout } from './conversation-checkout';
import {
  createLogger,
  getWorkflowFolderSearchPaths,
  getCommandFolderSearchPaths,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  getArchonWorkspacesPath,
  getHomeCommandsPath,
  getHomeWorkflowsPath,
  getRunArtifactsDirForRoot,
  isRunArtifactsEngineEntry,
  resolveRunStorageRoot,
  isInsideArchonHome,
  isInsideArchonWorkspaces,
  isPathInside,
  getArchonHome,
  isDocker,
  isWSL,
  getWSLDistroName,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
} from '@archon/paths';
import {
  discoverWorkflowsWithConfig,
  isValidWorkflowFolderSegment,
} from '@archon/workflows/workflow-discovery';
import { FIXTURES_DIR } from '@archon/workflows/fixture-layout';
import { parseWorkflow } from '@archon/workflows/loader';
import { isValidCommandName, isValidWorkflowName } from '@archon/workflows/command-validation';
import { BUNDLED_WORKFLOWS, BUNDLED_COMMANDS, isBinaryBuild } from '@archon/workflows/defaults';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  isApprovalContext,
  isGateResolved,
  isWorkflowWaitContext,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { MessageRow } from '@archon/core/schemas/message';
import { listCiWaitingPlatformConversationIds, type CiWatch } from '@archon/core/db/ci-watches';
import type { CiWatchDelivery } from '@archon/core/services/ci-watch';
import type { DashboardWorkflowRun } from '@archon/core/schemas/workflow-run';
import { findCommandFiles } from '@archon/core/utils/commands';
import { conversationCheckout } from '@archon/core/utils/conversation-checkout';
import { type DeployStatus, getDeployStatus } from '../services/deploy-status';
import { resumeWorkflowRunFromServer } from '../services/workflow-resume-service';
import { TURN_RESUMED_NOTICE, type ParkedTurnDispatcher } from '../services/deploy-park';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('api');
  return cachedLog;
}

interface RawWorkflowFile {
  absolutePath: string;
  filename: string;
  packaged: boolean;
  parsed: ReturnType<typeof parseWorkflow>;
}

async function tryReadWorkflowAt(dir: string, name: string): Promise<RawWorkflowFile | null> {
  const acceptedNames = new Set(name.includes('/') ? [name, basename(name)] : [name]);
  for (const ext of ['yaml', 'yml']) {
    const filename = `${name}.${ext}`;
    const absolutePath = join(dir, filename);
    try {
      const content = await readFile(absolutePath, 'utf-8');
      const parsed = parseWorkflow(content, filename);
      if (parsed.workflow !== null && !acceptedNames.has(parsed.workflow.name)) continue;
      return { absolutePath, filename, packaged: false, parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function findPackagedWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  let packs: string[];
  try {
    packs = await readdir(workflowsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let match: RawWorkflowFile | null = null;
  for (const pack of packs.sort((a, b) => a.localeCompare(b))) {
    if (pack === FIXTURES_DIR) continue;
    if (!isValidWorkflowFolderSegment(pack)) continue;
    const packPath = join(workflowsRoot, pack);
    try {
      if (!(await stat(packPath)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    let workflowFolders: string[];
    try {
      workflowFolders = await readdir(packPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const workflowFolder of workflowFolders.sort((a, b) => a.localeCompare(b))) {
      if (workflowFolder === FIXTURES_DIR) continue;
      if (!isValidWorkflowFolderSegment(workflowFolder)) continue;
      const workflowPath = join(packPath, workflowFolder);
      try {
        if (!(await stat(workflowPath)).isDirectory()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      let workflowEntries: string[];
      try {
        workflowEntries = await readdir(workflowPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const yamlFiles = workflowEntries
        .filter(entry => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .sort((a, b) => a.localeCompare(b));
      if (yamlFiles.length !== 1) continue;

      const yamlFilename = yamlFiles[0];
      const absolutePath = join(workflowPath, yamlFilename);
      let content: string;
      try {
        content = await readFile(absolutePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const parsed = parseWorkflow(content, yamlFilename);
      const yamlStem = yamlFilename.replace(/\.ya?ml$/, '');
      const isMalformedTarget =
        parsed.workflow === null && (yamlStem === name || workflowFolder === name);
      if (parsed.workflow?.name !== name && !isMalformedTarget) continue;
      if (match !== null) {
        throw new Error(`Multiple packaged workflows declare the name '${name}'`);
      }
      match = {
        absolutePath,
        filename: `${pack}/${workflowFolder}/${yamlFilename}`,
        packaged: true,
        parsed,
      };
    }
  }
  return match;
}

async function findWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  return (
    (await tryReadWorkflowAt(workflowsRoot, name)) ??
    (await findPackagedWorkflowAt(workflowsRoot, name))
  );
}

function isBundledWorkflowsRoot(workflowsRoot: string): boolean {
  return resolve(workflowsRoot) === resolve(dirname(getDefaultWorkflowsPath()));
}

function findBundledWorkflow(
  name: string
): { filename: string; parsed: ReturnType<typeof parseWorkflow> } | null {
  const direct = BUNDLED_WORKFLOWS[name];
  if (direct !== undefined) {
    const filename = `${name}.yaml`;
    const parsed = parseWorkflow(direct, filename);
    if (parsed.error !== null || parsed.workflow?.name === name) {
      return { filename, parsed };
    }
  }

  let match: {
    filename: string;
    parsed: ReturnType<typeof parseWorkflow>;
  } | null = null;
  for (const [filenameStem, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    if (filenameStem === name) continue;
    const filename = `${filenameStem}.yaml`;
    const parsed = parseWorkflow(content, filename);
    if (parsed.workflow?.name !== name) continue;
    if (match !== null) throw new Error(`Multiple bundled workflows declare the name '${name}'`);
    match = { filename, parsed };
  }
  return match;
}
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as envVarDb from '@archon/core/db/env-vars';
import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import * as messageDb from '@archon/core/db/messages';
import * as userDb from '@archon/core/db/users';
import {
  abandonWorkflow,
  AbandonOwnerNotStoppedError,
  cancelWorkflow,
  CancelRefusedError,
  describeAbandonOwner,
  approveWorkflow,
  rejectWorkflow,
  respondToWorkflow,
  assertRespondable,
  resetWorkflowNodeSessions,
} from '@archon/core/operations/workflow-operations';
import { getAuth, isWebAuthEnabled, getSignupMode, isApiGateEnabled } from '../auth';
import { errorSchema } from './schemas/common.schemas';
import { updateCheckResponseSchema } from './schemas/system.schemas';
import {
  workflowListResponseSchema,
  validateWorkflowBodySchema,
  validateWorkflowResponseSchema,
  getWorkflowResponseSchema,
  saveWorkflowBodySchema,
  deleteWorkflowResponseSchema,
  commandListResponseSchema,
  workflowRunListResponseSchema,
  workflowRunDetailSchema,
  workflowRunByWorkerResponseSchema,
  cancelWorkflowRunResponseSchema,
  workflowRunActionResponseSchema,
  dashboardRunsResponseSchema,
  dashboardRunsQuerySchema,
  workflowRunsQuerySchema,
  approveWorkflowRunBodySchema,
  rejectWorkflowRunBodySchema,
  respondWorkflowRunBodySchema,
  resetWorkflowNodeSessionsParamsSchema,
  resetWorkflowNodeSessionsQuerySchema,
  resetWorkflowNodeSessionsResponseSchema,
  listArtifactsResponseSchema,
} from './schemas/workflow.schemas';
import {
  slashCommandListQuerySchema,
  slashCommandListResponseSchema,
} from './schemas/command.schemas';
import { SLASH_COMMANDS, type SlashCommandSpec } from '@archon/core/handlers/command-registry';
import {
  conversationListResponseSchema,
  listConversationsQuerySchema,
  conversationIdParamsSchema,
  conversationLockResponseSchema,
  conversationCheckoutResponseSchema,
  conversationInterruptResponseSchema,
  conversationQueueResponseSchema,
  conversationChangesResponseSchema,
  conversationChangeDiffQuerySchema,
  conversationChangeDiffResponseSchema,
  queuedMessageParamsSchema,
  withdrawQueuedResponseSchema,
  conversationSchema,
  createConversationBodySchema,
  createConversationResponseSchema,
  updateConversationBodySchema,
  chatModelResponseSchema,
  setChatModelBodySchema,
  setConversationOrderBodySchema,
  successResponseSchema,
  messageListResponseSchema,
  listMessagesQuerySchema,
  dispatchResponseSchema,
} from './schemas/conversation.schemas';
import {
  codebaseListResponseSchema,
  codebaseSchema,
  codebaseIdParamsSchema,
  addCodebaseBodySchema,
  updateCodebaseBodySchema,
  deleteCodebaseResponseSchema,
  codebaseEnvVarsResponseSchema,
  setEnvVarBodySchema,
  codebaseEnvVarParamsSchema,
  envVarMutationResponseSchema,
  codebaseFilePathQuerySchema,
  codebaseFilesResponseSchema,
  codebaseFileResponseSchema,
  writeCodebaseFileBodySchema,
  writeCodebaseFileResponseSchema,
} from './schemas/codebase.schemas';
import {
  updateAssistantConfigBodySchema,
  updateAssistantConfigResponseSchema,
  configResponseSchema,
  updateTiersBodySchema,
  updateAliasesBodySchema,
  updateChatsBodySchema,
  codebaseEnvironmentsResponseSchema,
} from './schemas/config.schemas';
import {
  TIER_NAMES,
  isTierName,
  isEffortValidForProvider,
  validEffortsForProvider,
  normalizeStrictRunModelPreset,
  resolvePresetEffort,
  RunModelPresetValidationError,
} from '@archon/workflows/model-validation';
import type { RunModelOverrides } from '@archon/workflows/model-validation';
import {
  providerListResponseSchema,
  piModelListResponseSchema,
  opencodeCredentialListResponseSchema,
} from './schemas/provider.schemas';
import {
  authStatusResponseSchema,
  deviceStartResponseSchema,
  devicePollBodySchema,
  devicePollResponseSchema,
  githubConnectionStatusSchema,
  githubDisconnectResponseSchema,
} from './schemas/auth.schemas';
import {
  providerKeyListResponseSchema,
  providerKeyParamsSchema,
  providerKeySetBodySchema,
  providerKeySetResponseSchema,
  providerKeyDeleteResponseSchema,
  providerOAuthStartResponseSchema,
  providerOAuthPollBodySchema,
  providerOAuthPollResponseSchema,
} from './schemas/provider-key.schemas';
import {
  userAiPrefsResponseSchema,
  updateUserTiersBodySchema,
  updateUserAliasesBodySchema,
  updateUserDefaultBodySchema,
} from './schemas/user-ai-prefs.schemas';
import { mapDeviceFlowErrorToPollStatus } from './auth-poll-status';
import {
  getProviderInfoList,
  isRegisteredProvider,
  listPiModels,
  introspectOpencodeCredentials,
} from '@archon/providers';
import { messageSchema } from './schemas/conversation.schemas';
import { dagNodeSseEventSchema } from '../adapters/web/workflow-event.schemas';
import {
  workflowRunSchema,
  dashboardWorkflowRunSchema,
  workflowRunStatusSchema,
} from './schemas/workflow.schemas';

// Read app version: use build-time constant in binary, package.json in dev
let appVersion = 'unknown';
if (BUNDLED_IS_BINARY) {
  appVersion = BUNDLED_VERSION;
} else {
  try {
    const pkgContent = readFileSync(join(import.meta.dir, '../../../../package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent) as { version?: string };
    appVersion = pkg.version ?? 'unknown';
  } catch (err) {
    getLog().debug(
      { err, path: join(import.meta.dir, '../../../../package.json') },
      'api.version_read_failed'
    );
  }
}

type WorkflowSource = 'project' | 'bundled' | 'global';

/**
 * Resolve the on-disk artifact directory for a run, for EVERY project kind
 * (#2200).
 *
 * Both artifact routes previously did `parseOwnerRepo(codebase.name)` alone,
 * which returns null for a folder project (display name, no slash) and for a
 * no-remote local repo (bare basename) — so artifact browsing was silently dead
 * for two of the three project kinds Archon can register.
 *
 * The shared root resolver owns trusted persisted-root precedence and
 * relocation fallback; this route only composes the artifact directory.
 */
function resolveRunArtifactDir(
  run: { output_root?: string | null },
  codebase: { kind?: string | null; name: string; default_cwd: string } | null,
  runId: string
): string | null {
  const root = resolveRunStorageRoot(run, codebase);
  return root ? getRunArtifactsDirForRoot(root, runId) : null;
}

/**
 * Why a caller-supplied path was refused. The caller maps these to its own
 * status codes and wording, because "not found" and "you may not ask that" are
 * the same answer to an attacker and different answers to a UI.
 */
type ContainmentFailure = 'invalid' | 'missing' | 'escaped' | 'symlink-escape' | 'error';

type ContainedPath =
  | { ok: true; realRoot: string; realPath: string; relative: string }
  | { ok: false; reason: ContainmentFailure; err?: unknown };

/**
 * Resolve a caller-supplied relative path inside a fenced root, and prove it
 * stayed there.
 *
 * The chain, in order, because each step is defeated by the one before it:
 *   1. reject NUL bytes and `..` segments on the RAW input, before normalise
 *      can quietly collapse them;
 *   2. normalise and strip any leading separator, so the path is relative;
 *   3. join and check containment lexically;
 *   4. `realpath` BOTH sides and check again — every read follows symlinks, and
 *      a symlink inside a repo pointing at `~/.ssh` is ordinary, not exotic.
 *
 * Step 4 is why this returns a resolved path rather than a boolean: the caller
 * must read the path that was checked, not re-derive one that was not (#3160).
 */
/**
 * Version token for a file's bytes. A content hash, so two writes inside one
 * filesystem timestamp tick are still distinguishable and a clock that moves
 * backwards cannot make a stale file look fresh.
 */
function fileEtag(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * Separators for the RAW `..` scan below. `\` is a separator on Windows and an
 * ordinary filename character everywhere else, so the scan follows the host:
 * splitting on both unconditionally refused `..\..\etc\passwd` on POSIX, where
 * it names one file that simply is not there. Containment is still proved after
 * this, so the looser scan cannot admit an escape — it only stops a refusal
 * standing in for a 404.
 */
const RAW_PATH_SEGMENTS = process.platform === 'win32' ? /[/\\]/ : /\//;

/**
 * The separator a repo-relative path wears ON THE WIRE, which is `/` everywhere.
 *
 * `normalize()` returns the HOST's separator, so a Windows-hosted server answered
 * `src\index.ts` where a Linux one answered `src/index.ts` — the same file in the
 * same repo, with two different identifiers depending on which machine happened to
 * serve it. That value is not decoration: the files client joins it onto each
 * listing entry to build the child's path and sends it back, so the identifier a
 * client holds for a file was OS-dependent.
 *
 * Only the value that LEAVES is converted. `candidate` and `realPath` stay
 * host-native because they touch the filesystem, and the containment proof runs
 * on those, so nothing here participates in the escape check.
 *
 * Conditional on the host for the same reason `RAW_PATH_SEGMENTS` is: `\` is a
 * separator on Windows and an ordinary filename character everywhere else, so
 * converting unconditionally would rename a POSIX file that legitimately has one
 * in its name.
 */
const toWirePath = (p: string): string =>
  process.platform === 'win32' ? p.replaceAll('\\', '/') : p;

async function resolveContainedPath(root: string, rawRelative: string): Promise<ContainedPath> {
  if (
    rawRelative.includes('\0') ||
    rawRelative.split(RAW_PATH_SEGMENTS).some(seg => seg === '..')
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const relative = normalize(rawRelative).replace(/^[/\\]+/, '');
  const candidate = relative === '' || relative === '.' ? root : join(root, relative);

  if (!isPathInside(root, candidate, { includeRoot: true, lexical: true })) {
    return { ok: false, reason: 'escaped' };
  }

  let realRoot: string;
  let realPath: string;
  try {
    realRoot = await realpath(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'error', err };
  }
  try {
    realPath = await realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'error', err };
  }

  if (!isPathInside(realRoot, realPath, { includeRoot: true, lexical: true })) {
    return { ok: false, reason: 'symlink-escape' };
  }

  return {
    ok: true,
    realRoot,
    realPath,
    relative: relative === '.' ? '' : toWirePath(relative),
  };
}

// =========================================================================
// OpenAPI route configs (module-scope — pure config, no runtime dependencies)
// =========================================================================

/** First non-blank line of a workflow description — the one line the `/` menu shows. */
function firstLine(text: string | undefined): string | null {
  const line = text
    ?.split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0);
  return line ?? null;
}

/** Helper to build a JSON error response entry for createRoute configs. */
function jsonError(description: string): {
  content: { 'application/json': { schema: typeof errorSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorSchema } }, description };
}

const cwdQuerySchema = z.object({ cwd: z.string().optional() });
const workflowTargetQuerySchema = cwdQuerySchema.extend({
  source: z.enum(['project', 'global']).optional(),
});

const getWorkflowsRoute = createRoute({
  method: 'get',
  path: '/api/workflows',
  tags: ['Workflows'],
  summary: 'List available workflows',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowListResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getSlashCommandsRoute = createRoute({
  method: 'get',
  path: '/api/slash-commands',
  tags: ['Commands'],
  summary: "List the chat slash commands and the project's workflows, for the composer menu",
  request: { query: slashCommandListQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: slashCommandListResponseSchema } },
      description: 'OK',
    },
    404: jsonError('Project not found'),
    500: jsonError('Server error'),
  },
});

const validateWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/validate',
  tags: ['Workflows'],
  summary: 'Validate a workflow definition without saving',
  request: {
    body: {
      content: { 'application/json': { schema: validateWorkflowBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: validateWorkflowResponseSchema } },
      description: 'Validation result',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getWorkflowRoute = createRoute({
  method: 'get',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Fetch a single workflow definition',
  request: {
    params: z.object({ name: z.string() }),
    query: cwdQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getWorkflowResponseSchema } },
      description: 'Workflow definition',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const saveWorkflowRoute = createRoute({
  method: 'put',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Save (create or update) a workflow',
  request: {
    params: z.object({ name: z.string() }),
    query: workflowTargetQuerySchema,
    body: { content: { 'application/json': { schema: saveWorkflowBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getWorkflowResponseSchema } },
      description: 'Saved workflow',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const deleteWorkflowRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Delete a user-defined workflow',
  request: {
    params: z.object({ name: z.string() }),
    query: workflowTargetQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteWorkflowResponseSchema } },
      description: 'Deleted',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getCommandsRoute = createRoute({
  method: 'get',
  path: '/api/commands',
  tags: ['Commands'],
  summary: 'List available command names for the workflow node palette',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: commandListResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Conversation route configs
// =========================================================================

const getConversationsRoute = createRoute({
  method: 'get',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'List conversations',
  request: { query: listConversationsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getConversationRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Get a conversation by platform conversation ID',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationSchema } },
      description: 'Conversation',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

/**
 * Whether this conversation is executing a turn right now.
 *
 * Its own route rather than a field on the conversation read, because it is a
 * different kind of fact: the conversation row is persisted state, this is a
 * membership in a Map in this process's memory and it changes without the row
 * changing. Folding it into the row would make every conversation read a
 * mixture of the two, and would quietly make a cached row wrong.
 *
 * The console asks for it when its event stream reconnects — see
 * `useConversationSSE` — because the lock events emitted during the gap are
 * gone and nothing replays them.
 */
const getConversationLockRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/lock',
  tags: ['Conversations'],
  summary: 'Whether a conversation is executing a turn right now',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationLockResponseSchema } },
      description: 'Current lock state',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

/**
 * Where this conversation's agent edits: branch, live checkout or worktree, and
 * whether uncommitted work is sitting there.
 *
 * Its own route for the same reason as the lock: it is not persisted state.
 * It is read from git on every request, because the agent commits and switches
 * branch without the conversation row changing.
 */
const getConversationCheckoutRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/checkout',
  tags: ['Conversations'],
  summary: "The branch and folder a conversation's agent edits, and whether it is dirty",
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationCheckoutResponseSchema } },
      description: 'Current checkout state; unknown fields are null',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

/**
 * How long the interrupt route waits for the turn to end before answering
 * `stopping`. Only chooses which answer is sent — the lock is released by the
 * turn itself, whenever it ends.
 */
const INTERRUPT_WAIT_MS = 5000;

const interruptConversationRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/interrupt',
  tags: ['Conversations'],
  summary: "Stop the conversation's running turn",
  description:
    'Aborts the running chat turn through its provider. Output already streamed is kept and ' +
    'the turn is marked interrupted. Workflow runs the turn started are not affected. Queued ' +
    'messages stay queued and are delivered once the turn ends.',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationInterruptResponseSchema } },
      description: 'Outcome of the stop request',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getConversationQueueRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/queue',
  tags: ['Conversations'],
  summary: 'Messages waiting behind the running turn',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationQueueResponseSchema } },
      description: 'Queued messages, oldest first',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getConversationChangesRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/changes',
  tags: ['Conversations'],
  summary: "Uncommitted changes in the checkout this chat's agent runs in",
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationChangesResponseSchema } },
      description: 'Changed files with line counts',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getConversationChangeDiffRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/changes/diff',
  tags: ['Conversations'],
  summary: "One changed file's diff in this chat's checkout",
  request: { params: conversationIdParamsSchema, query: conversationChangeDiffQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationChangeDiffResponseSchema } },
      description: 'Unified diff',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const withdrawQueuedMessageRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}/queue/{queuedId}',
  tags: ['Conversations'],
  summary: 'Take a queued message back before it is delivered',
  request: { params: queuedMessageParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: withdrawQueuedResponseSchema } },
      description: 'Withdrawn, or no longer queued',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// Body validation is handled manually in the handler (multipart vs JSON
// branching), mirroring sendMessageRoute. Declaring `request.body` would force
// JSON validation to run on multipart payloads and reject them.
const createConversationRoute = createRoute({
  method: 'post',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'Create a new conversation (JSON or multipart with file uploads)',
  description:
    'Accepts `application/json` with `{ codebaseId?, message? }`, or ' +
    '`multipart/form-data` with optional `codebaseId` and `message` fields and ' +
    'optional file attachments (max 5 files, 10 MB each). Files require a ' +
    '`message` to attach them to. An empty body creates an empty conversation.',
  responses: {
    200: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Created conversation',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
    503: jsonError('Server is draining for a restart'),
  },
});

const getChatModelRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/model',
  tags: ['Conversations'],
  summary: "What the chat's next turn runs on: provider, model, effort, and its own pin",
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: chatModelResponseSchema } },
      description: "The next turn's model",
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const setChatModelRoute = createRoute({
  method: 'put',
  path: '/api/conversations/{id}/model',
  tags: ['Conversations'],
  summary: "Pin this chat's model and effort from its next turn (both null clears)",
  request: {
    params: conversationIdParamsSchema,
    body: {
      content: { 'application/json': { schema: setChatModelBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: chatModelResponseSchema } },
      description: "The next turn's model, with the new pin applied",
    },
    400: jsonError('The provider does not accept that model or effort'),
    404: jsonError('Not found'),
    409: jsonError('The chat no longer runs on that provider'),
    500: jsonError('Server error'),
  },
});

const updateConversationRoute = createRoute({
  method: 'patch',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Update a conversation (title, color, archived, completed, ready)',
  request: {
    params: conversationIdParamsSchema,
    body: {
      content: { 'application/json': { schema: updateConversationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Updated',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

/**
 * Declared before the `{id}` routes it sits beside so the static path is never
 * read as a conversation called "order".
 */
const setConversationOrderRoute = createRoute({
  method: 'put',
  path: '/api/conversations/order',
  tags: ['Conversations'],
  summary: 'Arrange a run of chats in the rail',
  request: {
    body: {
      content: { 'application/json': { schema: setConversationOrderBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Arranged',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

/**
 * Mark a chat read, clearing the rail's unread mark.
 *
 * A POST rather than a PATCH on the conversation: the client is not editing a
 * field it chose a value for, it is reporting that a human reached the bottom
 * of the stream. The server owns the timestamp, so there is no body.
 */
const markConversationReadRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/read',
  tags: ['Conversations'],
  summary: 'Record that a human has read this chat to the end',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Marked read',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const deleteConversationRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Soft-delete a conversation',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const listMessagesRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/messages',
  tags: ['Conversations'],
  summary: 'List message history for a conversation',
  request: {
    params: conversationIdParamsSchema,
    query: listMessagesQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: messageListResponseSchema } },
      description: 'Message list',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// Body validation is handled manually in the handler (multipart vs JSON branching).
// Declaring both content types in the OpenAPI route causes @hono/zod-openapi to
// validate JSON bodies against the multipart schema. We keep `request.body` empty
// and document the schemas via the OpenAPI spec comments instead.
const sendMessageRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/message',
  tags: ['Conversations'],
  summary: 'Send a message (JSON or multipart with file uploads)',
  description:
    'Accepts `application/json` with `{ message: string }` or `multipart/form-data` ' +
    'with a `message` field and optional file attachments (max 5 files, 10 MB each).',
  request: {
    params: conversationIdParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
    503: jsonError('Server is draining for a restart'),
  },
});

// =========================================================================
// Codebase route configs
// =========================================================================

const listCodebasesRoute = createRoute({
  method: 'get',
  path: '/api/codebases',
  tags: ['Codebases'],
  summary: 'List registered codebases',
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getCodebaseRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Get a codebase by ID',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const listCodebaseFilesRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/files',
  tags: ['Codebases'],
  summary: "List one directory of a codebase's checkout",
  request: { params: codebaseIdParamsSchema, query: codebaseFilePathQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseFilesResponseSchema } },
      description: 'Directory listing',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const readCodebaseFileRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/file',
  tags: ['Codebases'],
  summary: "Read one text file from a codebase's checkout",
  request: { params: codebaseIdParamsSchema, query: codebaseFilePathQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseFileResponseSchema } },
      description: 'File contents',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    413: jsonError('File too large'),
    415: jsonError('Unsupported media type'),
    500: jsonError('Server error'),
  },
});

const writeCodebaseFileRoute = createRoute({
  method: 'put',
  path: '/api/codebases/{id}/file',
  tags: ['Codebases'],
  summary: "Write one text file in a codebase's checkout",
  request: {
    params: codebaseIdParamsSchema,
    query: codebaseFilePathQuerySchema,
    body: {
      content: { 'application/json': { schema: writeCodebaseFileBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: writeCodebaseFileResponseSchema } },
      description: 'Written',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    409: jsonError('The file changed since it was read'),
    413: jsonError('File too large'),
    415: jsonError('Unsupported media type'),
    500: jsonError('Server error'),
  },
});

const addCodebaseRoute = createRoute({
  method: 'post',
  path: '/api/codebases',
  tags: ['Codebases'],
  summary: 'Register a codebase (clone from URL or register local path)',
  request: {
    body: {
      content: { 'application/json': { schema: addCodebaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase already existed',
    },
    201: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase created',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

/**
 * PATCH /api/codebases/{id} — correct a codebase's recorded remote.
 *
 * `repository_url` could previously only be FILLED, and only from inside the
 * clone path (`handlers/clone.ts`). A project registered from a local path got
 * `NULL` permanently, and a wrong value could never be corrected — the issues
 * board then answered `reason: 'no-repository'` forever with no supported way
 * out.
 *
 * Reporting only. `default_cwd` stays authoritative for where work happens, so
 * nothing here clones, moves, or re-points a working tree.
 */
const updateCodebaseRoute = createRoute({
  method: 'patch',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: "Update a codebase's recorded repository URL",
  request: {
    params: codebaseIdParamsSchema,
    body: {
      content: { 'application/json': { schema: updateCodebaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Updated codebase',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const deleteCodebaseRoute = createRoute({
  method: 'delete',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Delete a codebase and clean up associated resources',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteCodebaseResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Codebase env var route configs
// =========================================================================

const listEnvVarsRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/env',
  tags: ['Codebases'],
  summary: 'List env vars for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseEnvVarsResponseSchema } },
      description: 'Env vars for codebase',
    },
    404: jsonError('Codebase not found'),
  },
});

const setEnvVarRoute = createRoute({
  method: 'put',
  path: '/api/codebases/{id}/env',
  tags: ['Codebases'],
  summary: 'Set (upsert) an env var for a codebase',
  request: {
    params: codebaseIdParamsSchema,
    body: { content: { 'application/json': { schema: setEnvVarBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: envVarMutationResponseSchema } },
      description: 'Env var set',
    },
    404: jsonError('Codebase not found'),
  },
});

const deleteEnvVarRoute = createRoute({
  method: 'delete',
  path: '/api/codebases/{id}/env/{key}',
  tags: ['Codebases'],
  summary: 'Delete an env var from a codebase',
  request: { params: codebaseEnvVarParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: envVarMutationResponseSchema } },
      description: 'Env var deleted',
    },
    404: jsonError('Codebase not found'),
  },
});

// =========================================================================
// Workflow run route configs
// =========================================================================

// Body validation is handled manually in the handler (multipart vs JSON
// branching), mirroring sendMessageRoute. The OpenAPI spec describes the
// shapes via the description; declaring `request.body` would force JSON
// validation to run on multipart payloads and reject them.
const runWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/{name}/run',
  tags: ['Workflows'],
  summary: 'Run a workflow via the orchestrator (JSON or multipart with file uploads)',
  description:
    'Accepts `application/json` with `{ conversationId, message, inputs?, config?, tiers?, aliases? }` or ' +
    '`multipart/form-data` with `conversationId`, `message`, optional `inputs` and `config` fields ' +
    'holding their objects JSON-encoded, optional `tiers` and `aliases` JSON object fields, ' +
    'and optional file attachments (max 5 files, ' +
    "10 MB each). `inputs` supplies values for the workflow's declared `inputs:` " +
    '(#2554); it is validated against the declaration before any worktree, clone, or AI ' +
    'cost, so a missing required input or an undeclared key is refused up front. `config` ' +
    'supplies a sparse runtime layer; `tiers` and `aliases` rebind named model presets above it. ' +
    'Caller-supplied filesystem config paths are rejected.',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
    503: jsonError('Server is draining for a restart'),
  },
});

const listRunArtifactsRoute = createRoute({
  method: 'get',
  path: '/api/runs/{runId}/artifacts',
  tags: ['Workflows'],
  summary: "List a run's artifact files",
  description:
    "Walks the run's artifact directory and returns relative file paths with size + " +
    "mtime. Drives the console Artifacts tab. Leaves out only the engine's own " +
    '`.archon` child at the root, the same rule `archon workflow get` applies; a ' +
    "workflow's own dotfiles are listed. Resolves for every project kind — " +
    "`owner/repo`, `_local/<basename>`, and `_folder/<slug>` — preferring the run's " +
    'persisted `output_root` and re-deriving from the codebase when it is absent or ' +
    'no longer inside ARCHON_HOME. Returns `{ files: [] }` only when the location ' +
    'resolved and the run genuinely wrote nothing; returns 404 when the output ' +
    'location cannot be resolved at all.',
  request: {
    params: z.object({ runId: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: listArtifactsResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getDashboardRunsRoute = createRoute({
  method: 'get',
  path: '/api/dashboard/runs',
  tags: ['Workflows'],
  summary: 'List enriched workflow runs for the Command Center dashboard',
  request: { query: dashboardRunsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: dashboardRunsResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getWorkflowRunByWorkerRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/by-worker/{platformId}',
  tags: ['Workflows'],
  summary: 'Look up a workflow run by its worker conversation platform ID',
  request: { params: z.object({ platformId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunByWorkerResponseSchema } },
      description: 'Workflow run',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const listWorkflowRunsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs',
  tags: ['Workflows'],
  summary: 'List workflow runs',
  request: { query: workflowRunsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const cancelWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/cancel',
  tags: ['Workflows'],
  summary: 'Cancel a workflow run',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: cancelWorkflowRunResponseSchema } },
      description: 'Cancelled',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    409: jsonError(
      'No live owner answered, or the owner could not be stopped; the run was not changed'
    ),
    500: jsonError('Server error'),
  },
});

const resumeWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/resume',
  tags: ['Workflows'],
  summary: 'Resume a failed workflow run (dispatches resume on the parent web conversation)',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Resumed',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
    503: jsonError('Server is draining for a restart'),
  },
});

const signalWorkflowWaitBodySchema = z.object({
  event: z.string().min(1),
  resumeAt: z.string().datetime(),
  payload: z.unknown().optional(),
});

const signalWorkflowWaitRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/signal',
  tags: ['Workflows'],
  summary: 'Signal the exact external event awaited by a paused workflow run',
  request: {
    params: z.object({ runId: z.string() }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: signalWorkflowWaitBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Signal accepted; the scheduler will resume the workflow shortly',
    },
    400: jsonError('Run is not waiting on this event'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const abandonWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/abandon',
  tags: ['Workflows'],
  summary: 'Abandon a workflow run (mark as cancelled)',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Abandoned',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    409: jsonError('A live owner answered but could not be stopped; the run was not changed'),
    500: jsonError('Server error'),
  },
});

const approveWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/approve',
  tags: ['Workflows'],
  summary: 'Approve a paused workflow run',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: approveWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Approved',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const rejectWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/reject',
  tags: ['Workflows'],
  summary: 'Reject a paused workflow run',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: rejectWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Rejected',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const respondWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/respond',
  tags: ['Workflows'],
  summary: "Resolve a paused workflow run with any of the gate's declared decisions",
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: respondWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Responded',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const deleteWorkflowRunRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/runs/{runId}',
  tags: ['Workflows'],
  summary: 'Delete a workflow run and its events',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Deleted',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const resetWorkflowNodeSessionsRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/{name}/node-sessions',
  tags: ['Workflows'],
  summary:
    'Reset persisted per-node provider sessions for a workflow. Optional scope and node filters narrow the deletion.',
  request: {
    params: resetWorkflowNodeSessionsParamsSchema,
    query: resetWorkflowNodeSessionsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: resetWorkflowNodeSessionsResponseSchema } },
      description: 'Sessions deleted (deleted count may be 0)',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getWorkflowRunRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/{runId}',
  tags: ['Workflows'],
  summary: 'Get workflow run details with events',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunDetailSchema } },
      description: 'Workflow run detail',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Config / health route configs
// =========================================================================

const getConfigRoute = createRoute({
  method: 'get',
  path: '/api/config',
  tags: ['System'],
  summary: 'Get read-only configuration (safe subset)',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: configResponseSchema,
        },
      },
      description: 'Configuration',
    },
    500: jsonError('Server error'),
  },
});

const patchAssistantConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/assistants',
  tags: ['System'],
  summary: 'Update assistant configuration',
  request: {
    body: {
      content: { 'application/json': { schema: updateAssistantConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: updateAssistantConfigResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError('Invalid request body, or the resulting config is invalid'),
    500: jsonError('Server error'),
  },
});

const patchTiersConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/tiers',
  tags: ['System'],
  summary: 'Update model-tier presets (small/medium/large)',
  description:
    'Writes the `tiers:` config to ~/.archon/config.yaml. Ungated (works on solo ' +
    'installs). Per-tier merge; a `null` tier value unsets it.',
  request: {
    body: {
      content: { 'application/json': { schema: updateTiersBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: configResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError('Invalid request body, or the resulting config is invalid'),
    500: jsonError('Server error'),
  },
});

const patchAliasesConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/aliases',
  tags: ['System'],
  summary: 'Update @custom model aliases',
  description:
    'Writes the `aliases:` config to ~/.archon/config.yaml. Ungated (works on solo ' +
    'installs). Per-alias merge; a `null` alias value unsets it.',
  request: {
    body: {
      content: { 'application/json': { schema: updateAliasesBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: configResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError(
      'Invalid alias name, unknown provider, invalid effort, or the resulting config is invalid'
    ),
    500: jsonError('Server error'),
  },
});

const patchChatsConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/chats',
  tags: ['System'],
  summary: 'Update chat handoff thresholds',
  description:
    'Writes the `chats:` config to ~/.archon/config.yaml. Ungated (works on solo ' +
    'installs). Per-field merge; an absent field keeps its current value. ' +
    'Install-wide only — `chats` in a repo config is read by nothing.',
  request: {
    body: {
      content: { 'application/json': { schema: updateChatsBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: configResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError('Threshold outside 1-99, or a nudge at or above the handoff point'),
    500: jsonError('Server error'),
  },
});

const getPiModelsRoute = createRoute({
  method: 'get',
  path: '/api/providers/pi/models',
  tags: ['System'],
  summary: "List Pi's model catalog (cost/reasoning metadata for the tier picker)",
  description:
    'Best-effort hint surface: returns `{ models: [] }` when the Pi catalog ' +
    'cannot be loaded, never an error — tier/alias saves must not depend on it.',
  responses: {
    200: {
      content: { 'application/json': { schema: piModelListResponseSchema } },
      description: 'Pi model catalog (metadata only)',
    },
  },
});

const getProvidersRoute = createRoute({
  method: 'get',
  path: '/api/providers',
  tags: ['System'],
  summary: 'List registered AI providers',
  responses: {
    200: {
      content: { 'application/json': { schema: providerListResponseSchema } },
      description: 'List of registered providers',
    },
  },
});

const getOpencodeCredentialsRoute = createRoute({
  method: 'get',
  path: '/api/providers/opencode/credentials',
  tags: ['System'],
  summary: "Introspect OpenCode's backend providers and auth state",
  description:
    "Proxies the embedded OpenCode server's provider introspection (catalog, " +
    'env var names, install-wide connected state). Heavyweight: starts the ' +
    'embedded server when not already running — call on demand from the ' +
    'settings card, never on passive page load (#1955).',
  responses: {
    200: {
      content: { 'application/json': { schema: opencodeCredentialListResponseSchema } },
      description: 'OpenCode backend providers (metadata only, no secrets)',
    },
    503: jsonError('Embedded OpenCode runtime unavailable'),
  },
});

const authStatusRoute = createRoute({
  method: 'get',
  path: '/api/auth/status',
  tags: ['Auth'],
  summary: 'Web auth availability + signup posture (no auth required)',
  responses: {
    200: {
      content: { 'application/json': { schema: authStatusResponseSchema } },
      description: 'Auth status',
    },
  },
});

const githubDeviceStartRoute = createRoute({
  method: 'post',
  path: '/api/auth/github/device/start',
  tags: ['Auth'],
  summary: 'Start the GitHub device flow for the current web user',
  responses: {
    200: {
      content: { 'application/json': { schema: deviceStartResponseSchema } },
      description: 'Device + user codes',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
    500: jsonError('Device flow not configured or failed'),
  },
});

const githubDevicePollRoute = createRoute({
  method: 'post',
  path: '/api/auth/github/device/poll',
  tags: ['Auth'],
  summary: 'Poll the GitHub device flow once for the current web user',
  request: {
    body: { content: { 'application/json': { schema: devicePollBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: devicePollResponseSchema } },
      description: 'Poll status',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
    500: jsonError('Device flow not configured or failed'),
  },
});

const githubConnectionStatusRoute = createRoute({
  method: 'get',
  path: '/api/auth/github',
  tags: ['Auth'],
  summary: 'GitHub connection status for the current web user',
  responses: {
    200: {
      content: { 'application/json': { schema: githubConnectionStatusSchema } },
      description: 'Connection status',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
  },
});

const githubDisconnectRoute = createRoute({
  method: 'delete',
  path: '/api/auth/github',
  tags: ['Auth'],
  summary: 'Disconnect the current web user’s GitHub identity',
  responses: {
    200: {
      content: { 'application/json': { schema: githubDisconnectResponseSchema } },
      description: 'Disconnected',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
  },
});

// ---- Per-user AI-provider credential (API-key) connect endpoints ----
const providerKeyListRoute = createRoute({
  method: 'get',
  path: '/api/auth/providers',
  tags: ['Auth'],
  summary: 'List the current web user’s connected AI-provider keys',
  responses: {
    200: {
      content: { 'application/json': { schema: providerKeyListResponseSchema } },
      description: 'Connections (metadata only) + connectable provider catalog',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
  },
});

const providerKeySetRoute = createRoute({
  method: 'put',
  path: '/api/auth/providers/{provider}',
  tags: ['Auth'],
  summary: 'Connect (upsert) an API key for a provider for the current web user',
  request: {
    params: providerKeyParamsSchema,
    body: { content: { 'application/json': { schema: providerKeySetBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerKeySetResponseSchema } },
      description: 'Key stored (encrypted); response carries no secret value',
    },
    400: jsonError('Unknown provider or empty key'),
    401: jsonError('Web auth required (X-Archon-User header missing)'),
    404: jsonError('Per-user provider keys not enabled on this install'),
  },
});

const providerKeyDeleteRoute = createRoute({
  method: 'delete',
  path: '/api/auth/providers/{provider}',
  tags: ['Auth'],
  summary: 'Disconnect the current web user’s key for a provider',
  request: { params: providerKeyParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: providerKeyDeleteResponseSchema } },
      description: 'Disconnected (idempotent)',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
    404: jsonError('Per-user provider keys not enabled on this install'),
  },
});

const providerOAuthStartRoute = createRoute({
  method: 'post',
  path: '/api/auth/providers/{provider}/oauth/start',
  tags: ['Auth'],
  summary: 'Begin a subscription (OAuth) login for the current web user',
  request: { params: providerKeyParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: providerOAuthStartResponseSchema } },
      description: 'Login session started (mode + URL/user-code)',
    },
    400: jsonError('Provider does not support subscription login'),
    401: jsonError('Web auth required (X-Archon-User header missing)'),
    404: jsonError('Per-user provider keys not enabled on this install'),
    503: jsonError('OAuth callback port still held by a previous login attempt — retry shortly'),
  },
});

const providerOAuthPollRoute = createRoute({
  method: 'post',
  path: '/api/auth/providers/{provider}/oauth/poll',
  tags: ['Auth'],
  summary: 'Poll a subscription login session (submit pasted code for manual flows)',
  request: {
    params: providerKeyParamsSchema,
    body: { content: { 'application/json': { schema: providerOAuthPollBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: providerOAuthPollResponseSchema } },
      description: 'Poll status',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
    404: jsonError('Per-user provider keys not enabled on this install'),
  },
});

const userAiPrefsGetRoute = createRoute({
  method: 'get',
  path: '/api/auth/me/ai-prefs',
  tags: ['Auth'],
  summary: 'Get the current web user’s AI preferences (tiers/aliases/default assistant)',
  responses: {
    200: {
      content: { 'application/json': { schema: userAiPrefsResponseSchema } },
      description: 'The user’s stored prefs (raw per-user layer, not merged with config)',
    },
    401: jsonError('Web auth required'),
    500: jsonError('Server error'),
  },
});

const userAiPrefsTiersRoute = createRoute({
  method: 'patch',
  path: '/api/auth/me/ai-prefs/tiers',
  tags: ['Auth'],
  summary: 'Update the current web user’s model-tier presets (per-key merge; null unsets)',
  request: {
    body: {
      content: { 'application/json': { schema: updateUserTiersBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: userAiPrefsResponseSchema } },
      description: 'Updated prefs',
    },
    400: jsonError('Unknown provider or invalid effort'),
    401: jsonError('Web auth required'),
    500: jsonError('Server error'),
  },
});

const userAiPrefsAliasesRoute = createRoute({
  method: 'patch',
  path: '/api/auth/me/ai-prefs/aliases',
  tags: ['Auth'],
  summary: 'Update the current web user’s @custom aliases (per-key merge; null unsets)',
  request: {
    body: {
      content: { 'application/json': { schema: updateUserAliasesBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: userAiPrefsResponseSchema } },
      description: 'Updated prefs',
    },
    400: jsonError('Invalid alias name, unknown provider, or invalid effort'),
    401: jsonError('Web auth required'),
    500: jsonError('Server error'),
  },
});

const userAiPrefsDefaultRoute = createRoute({
  method: 'patch',
  path: '/api/auth/me/ai-prefs/default',
  tags: ['Auth'],
  summary:
    'Set (or clear with null) the current web user’s default assistant + default chat model (written atomically; omitted model clears any pin)',
  request: {
    body: {
      content: { 'application/json': { schema: updateUserDefaultBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: userAiPrefsResponseSchema } },
      description: 'Updated prefs',
    },
    400: jsonError('Unknown provider'),
    401: jsonError('Web auth required'),
    500: jsonError('Server error'),
  },
});

const getCodebaseEnvironmentsRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/environments',
  tags: ['Codebases'],
  summary: 'List isolation environments for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseEnvironmentsResponseSchema } },
      description: 'List of isolation environments',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

const getHealthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['System'],
  summary: 'Health check',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z
            .object({
              status: z.string(),
              adapter: z.string(),
              concurrency: z.record(z.string(), z.unknown()),
              runningWorkflows: z.number(),
              version: z.string().optional(),
              is_docker: z.boolean(),
              is_wsl: z.boolean(),
              wsl_distro: z.string().optional(),
              activePlatforms: z.array(z.string()).optional(),
              // Platform ids of chats with an open CI watch (`watch_ci`): the
              // rail shows them as "Waiting on CI" instead of Idle. Rides the
              // read that already reports which chats are working, so both
              // halves of "is anything happening here" arrive together.
              // Omitted when the read fails — health must answer regardless.
              ciWaitingConversationIds: z.array(z.string()).optional(),
              // Present only while the server is draining for a restart (see
              // /internal/drain). `holding` names each reason the box is not yet
              // drained, so an operator watching a deploy wait can see what it is
              // waiting for rather than only that it is waiting.
              drain: z
                .object({
                  state: z.enum(['draining', 'drained']),
                  requestedAt: z.string(),
                  expiresAt: z.string(),
                  refusedCount: z.number(),
                  holding: z.object({
                    activeConversations: z.number(),
                    queuedMessages: z.number(),
                    runningWorkflows: z.number(),
                  }),
                })
                .optional(),
              // What the deploy replacing this server is doing, derived from the
              // host's own files at read time (see services/deploy-status). It
              // rides THIS read rather than a route of its own because the
              // console already polls health, and because watching a deploy must
              // not take a conversation turn — a turn is one of the things the
              // deploy is waiting for. Omitted when the files cannot be read, so
              // the strip says nothing rather than something wrong.
              deploy: z
                .object({
                  phase: z.enum([
                    'requested',
                    'building',
                    'draining',
                    'swapping',
                    'verifying',
                    'idle',
                    'unknown',
                  ]),
                  sha: z.string().optional(),
                  startedAt: z.string().optional(),
                  step: z
                    .object({ number: z.number(), of: z.number(), name: z.string() })
                    .optional(),
                  holding: z.string().optional(),
                  last: z
                    .object({
                      at: z.string(),
                      verdict: z.enum(['OK', 'FAILED', 'REFUSED', 'KILLED']),
                      sha: z.string(),
                      reason: z.string().optional(),
                    })
                    .optional(),
                })
                .optional(),
              // Schema vintage (#2316) so a bug report can state which Archon build
              // created this database and which last applied schema to it. Omitted
              // when unrecorded or unreadable — health must answer regardless.
              schema: z
                .object({
                  createdAppVersion: z.string().nullable(),
                  appVersion: z.string(),
                  appliedAt: z.string().nullable(),
                })
                .optional(),
            })
            .openapi('HealthResponse'),
        },
      },
      description: 'Health status',
    },
  },
});

const getUpdateCheckRoute = createRoute({
  method: 'get',
  path: '/api/update-check',
  tags: ['System'],
  summary: 'Check for available updates',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: updateCheckResponseSchema,
        },
      },
      description: 'Update check result',
    },
  },
});

/**
 * Register all /api/* routes on the Hono app.
 */
/** What the routes hand back to the server for callers that live outside HTTP. */
export interface ApiRoutesHandle {
  /** Wake a CI watch's chat with its verdict. Throws when no web chat owns the watch. */
  deliverCiWatchMessage: (watch: CiWatch, message: string) => Promise<CiWatchDelivery>;
  /** Hand a turn a deploy parked back to its web chat. */
  dispatchParkedTurn: ParkedTurnDispatcher;
}

export function registerApiRoutes(
  app: OpenAPIHono,
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager,
  activePlatforms?: readonly string[]
): ApiRoutesHandle {
  app.openAPIRegistry.register('DagNodeSseEvent', dagNodeSseEventSchema);

  function apiError(
    c: Context,
    // 413/415 are here for the Files tab's two honest refusals — a file over
    // the size ceiling, and a binary that must not be streamed down a text
    // route. Both are the correct code for what happened; neither is
    // representable as one of the others without lying about the reason.
    status: 400 | 401 | 404 | 409 | 413 | 415 | 422 | 500 | 503,
    message: string,
    detail?: string
  ): Response {
    return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
  }

  /**
   * Validate a run request's declared-inputs map (#2554): a flat object whose every
   * value is a string, which is exactly the shape `readSubrunMetadata` will accept back
   * off the run row. Refuse anything else here rather than let it be persisted into a
   * shape the engine silently reads as absent.
   *
   * An empty object resolves to `undefined` so a caller sending `{}` is treated as
   * having supplied nothing, taking every declared default.
   */
  function parseRunInputsField(
    raw: unknown
  ): { ok: true; inputs?: Record<string, string> } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'inputs must be an object mapping input names to strings' };
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    const badKey = entries.find(([, value]) => typeof value !== 'string')?.[0];
    if (badKey !== undefined) {
      return { ok: false, error: `inputs value for '${badKey}' must be a string` };
    }
    return {
      ok: true,
      inputs: entries.length > 0 ? (raw as Record<string, string>) : undefined,
    };
  }

  function parseRunModelOverridesFields(
    rawTiers: unknown,
    rawAliases: unknown
  ): { ok: true; overrides?: RunModelOverrides } | { ok: false; error: string } {
    const parseMap = (
      raw: unknown,
      label: 'tiers' | 'aliases'
    ): { ok: true; value?: Record<string, string> } | { ok: false; error: string } => {
      if (raw === undefined || raw === null) return { ok: true };
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: `${label} must be an object mapping names to model specs` };
      }
      const entries = Object.entries(raw as Record<string, unknown>);
      for (const [name, spec] of entries) {
        if (typeof spec !== 'string' || spec.trim().length === 0) {
          return { ok: false, error: `${label} value for '${name}' must be a non-empty string` };
        }
        if (label === 'tiers' && !isTierName(name)) {
          return {
            ok: false,
            error: `Invalid tier '${name}'. Supported tiers: ${TIER_NAMES.join(', ')}`,
          };
        }
        if (label === 'aliases' && !name.startsWith('@')) {
          return { ok: false, error: `Alias '${name}' must start with '@'` };
        }
      }
      return {
        ok: true,
        value: entries.length > 0 ? (raw as Record<string, string>) : undefined,
      };
    };

    const tiers = parseMap(rawTiers, 'tiers');
    if (!tiers.ok) return tiers;
    const aliases = parseMap(rawAliases, 'aliases');
    if (!aliases.ok) return aliases;
    if (!tiers.value && !aliases.value) return { ok: true };
    return {
      ok: true,
      overrides: {
        ...(tiers.value ? { tiers: tiers.value } : {}),
        ...(aliases.value ? { aliases: aliases.value } : {}),
      } as RunModelOverrides,
    };
  }

  /**
   * Validate that a caller-supplied `cwd` is rooted at a registered codebase path.
   * This prevents path traversal — callers cannot read/write outside known project roots.
   */
  async function validateCwd(cwd: string): Promise<boolean> {
    const codebases = await codebaseDb.listCodebases();
    return codebases.some(cb =>
      isPathInside(cb.default_cwd, cwd, { includeRoot: true, lexical: true })
    );
  }

  // CORS for Web UI — allow-all is fine for a single-developer tool.
  // Override with WEB_UI_ORIGIN env var to restrict if exposing publicly.
  app.use('/api/*', cors({ origin: process.env.WEB_UI_ORIGIN || '*' }));

  // Server-side access gate: when web auth is enabled (and not opted out via
  // ARCHON_WEB_AUTH_REQUIRED=false), every /api/* request must resolve to an
  // identity or get 401 — this is what makes Better Auth the real access
  // boundary so a reverse-proxy auth sidecar can retire. Public exceptions:
  //   - /api/auth/* — the login/status/device-flow surface (can't gate login)
  //   - /api/health* — the Docker/uptime healthcheck MUST stay reachable
  // /webhooks/* (HMAC-verified) and /internal/* (loopback-guarded) are outside
  // /api/* and untouched. No-op when web auth is disabled (solo/local unchanged).
  // `resolveAuthContext`/`apiError` are function declarations below → hoisted.
  //
  // SECURITY: resolveAuthContext also accepts the trusted reverse-proxy header
  // (ARCHON_WEB_AUTH_HEADER, default `X-Archon-User`) as an identity. That header
  // is only safe to trust when the app is reachable solely through a proxy that
  // STRIPS it from inbound requests (or the app binds 127.0.0.1). If you retire
  // the proxy auth sidecar, the proxy MUST still strip that header — otherwise a
  // client can forge it and walk straight through this gate.
  const PUBLIC_API_GATE_PREFIXES = ['/api/auth/', '/api/health'];
  app.use('/api/*', async (c, next) => {
    if (!isApiGateEnabled()) return next();
    const path = c.req.path;
    if (PUBLIC_API_GATE_PREFIXES.some(p => path === p || path.startsWith(p))) return next();
    const ctx = await resolveAuthContext(c);
    if (!ctx) return apiError(c, 401, 'Authentication required');
    return next();
  });

  /**
   * Resolve the per-request auth context: `{ userId, role }`, or undefined when
   * no identity is present. This is the single chokepoint generalised from the
   * old header-only seam. Resolution order:
   *   1. Better Auth session (when web auth is enabled) → canonical
   *      remote_agent_users row via the 'web' platform identity.
   *   2. Trusted reverse-proxy header (ARCHON_WEB_AUTH_HEADER, default
   *      `X-Archon-User`) — kept for proxy deploys and the auth-service sidecar.
   *   3. undefined → NULL attribution, never elevated.
   *
   * `role` rides along on the canonical user row (defaults 'admin'); it is the
   * durable seam future per-resource scoping hooks into. Visibility stays open.
   *
   * SECURITY: header trust is only safe when Archon is reachable solely through
   * a reverse proxy (bind 127.0.0.1). The server logs a startup warning otherwise.
   */
  async function resolveAuthContext(
    c: Context
  ): Promise<{ userId: string; role: UserRole } | undefined> {
    // 1. Better Auth session first (no-op when web auth is disabled).
    const auth = getAuth();
    if (auth) {
      try {
        const session = await auth.api.getSession({ headers: c.req.raw.headers });
        if (session?.user) {
          const user = await userDb.findOrCreateUserByPlatformIdentity(
            'web',
            session.user.id,
            session.user.name ?? session.user.email ?? undefined
          );
          return { userId: user.id, role: user.role };
        }
      } catch (err) {
        // Session lookup failed (e.g. DB outage). Fall through to the header so a
        // proxy-authenticated deploy still resolves; absent that → undefined
        // (NULL attribution). warn (not error): this is the soft attribution seam
        // — it returns undefined rather than throwing. The /api/* gate maps that
        // undefined to a 401 (fail-closed); requireWebUser is the strict variant
        // that distinguishes a backend 503 from a missing identity.
        getLog().warn({ err: err as Error, path: c.req.path }, 'web.session_resolve_failed');
      }
    }

    // 2. Trusted reverse-proxy header.
    const headerName = process.env.ARCHON_WEB_AUTH_HEADER || 'X-Archon-User';
    const headerVal = c.req.header(headerName)?.trim();
    if (!headerVal) return undefined;
    try {
      const user = await userDb.findOrCreateUserByPlatformIdentity('web', headerVal, headerVal);
      return { userId: user.id, role: user.role };
    } catch (err) {
      // Best-effort attribution: the header WAS present, but identity resolution
      // failed (e.g. DB outage). Fall back to NULL attribution rather than
      // failing the request. headerPresent distinguishes this from "no header".
      getLog().warn(
        { err: err as Error, headerPresent: true, path: c.req.path },
        'web.user_resolve_failed'
      );
      return undefined;
    }
  }

  /** Soft attribution: call sites that only need the user id, not the role. */
  async function resolveWebUserId(c: Context): Promise<string | undefined> {
    return (await resolveAuthContext(c))?.userId;
  }

  /**
   * Strict variant for endpoints that REQUIRE a web identity (connect/disconnect).
   * Session-first then header, mirroring resolveAuthContext, but distinguishing a
   * missing identity (401) from a backend failure resolving it (503) — a DB
   * outage must not masquerade as "authentication required". Returns the resolved
   * context, or the HTTP error Response the caller should return verbatim.
   */
  async function requireWebUser(
    c: Context,
    failMessage = 'Web authentication required'
  ): Promise<{ userId: string; role: UserRole } | { error: Response }> {
    // 1. Better Auth session.
    const auth = getAuth();
    if (auth) {
      let session: Awaited<ReturnType<typeof auth.api.getSession>> | undefined;
      try {
        session = await auth.api.getSession({ headers: c.req.raw.headers });
      } catch (err) {
        getLog().error({ err: err as Error }, 'web.session_resolve_failed');
        return { error: apiError(c, 503, 'Could not verify session — backend unavailable') };
      }
      if (session?.user) {
        try {
          const user = await userDb.findOrCreateUserByPlatformIdentity(
            'web',
            session.user.id,
            session.user.name ?? session.user.email ?? undefined
          );
          return { userId: user.id, role: user.role };
        } catch (err) {
          getLog().error({ err: err as Error }, 'web.user_resolve_failed');
          return { error: apiError(c, 503, 'Could not verify web identity — backend unavailable') };
        }
      }
    }

    // 2. Trusted reverse-proxy header.
    const headerName = process.env.ARCHON_WEB_AUTH_HEADER || 'X-Archon-User';
    const headerVal = c.req.header(headerName)?.trim();
    if (!headerVal) return { error: apiError(c, 401, failMessage) };
    try {
      const user = await userDb.findOrCreateUserByPlatformIdentity('web', headerVal, headerVal);
      return { userId: user.id, role: user.role };
    } catch (err) {
      getLog().error({ err: err as Error, headerPresent: true }, 'web.user_resolve_failed');
      return { error: apiError(c, 503, 'Could not verify web identity — backend unavailable') };
    }
  }

  // GET /api/auth/status - web auth availability + signup posture.
  // Public (no identity required): the web UI calls this before login to decide
  // whether to render the login gate at all. When web auth is enabled the
  // /api/auth/* mount explicitly next()s Archon-owned paths (this one included)
  // before Better Auth's handler runs, so the request reaches here untouched
  // (see isArchonOwnedAuthPath in index.ts).
  registerOpenApiRoute(authStatusRoute, c => {
    return c.json({ enabled: isWebAuthEnabled(), signup: getSignupMode() });
  });

  // ---- GitHub device-flow connect endpoints ----
  registerOpenApiRoute(githubDeviceStartRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect GitHub');
    if ('error' in web) return web.error;
    if (!isPerUserGitHubEnabled()) {
      return apiError(c, 500, 'Per-user GitHub is not enabled on this install');
    }
    try {
      const { clientId } = loadDeviceFlowConfig();
      const device = await startDeviceFlow(clientId);
      return c.json({
        device_code: device.device_code,
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        interval: device.interval,
        expires_in: device.expires_in,
      });
    } catch (err) {
      getLog().error({ err: err as Error }, 'auth.github_device_start_failed');
      return apiError(c, 500, 'Failed to start GitHub device flow');
    }
  });

  registerOpenApiRoute(githubDevicePollRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect GitHub');
    if ('error' in web) return web.error;
    if (!isPerUserGitHubEnabled()) {
      return apiError(c, 500, 'Per-user GitHub is not enabled on this install');
    }
    const { device_code: deviceCode } = getValidatedBody(c, devicePollBodySchema);
    try {
      const { clientId } = loadDeviceFlowConfig();
      const result = await pollDeviceFlowOnce(clientId, deviceCode);
      if (result.status === 'pending' || result.status === 'slow_down') {
        return c.json({ status: 'pending' as const });
      }
      if (result.status === 'error') {
        // Terminal device-flow codes → client-visible status (testable helper).
        return c.json({ status: mapDeviceFlowErrorToPollStatus(result.code), detail: result.code });
      }
      // authorized
      const { githubLogin } = await persistGithubConnection(web.userId, result.token);
      return c.json({ status: 'connected' as const, githubLogin });
    } catch (err) {
      if (err instanceof GithubIdentityConflictError) {
        return c.json({ status: 'error' as const, detail: err.message });
      }
      if (err instanceof DeviceFlowError) {
        return c.json({ status: 'error' as const, detail: err.code });
      }
      getLog().error({ err: err as Error }, 'auth.github_device_poll_failed');
      return apiError(c, 500, 'Failed to poll GitHub device flow');
    }
  });

  registerOpenApiRoute(githubConnectionStatusRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      const record = await getUserGithubTokenRecord(web.userId);
      return c.json({ connected: record !== null, githubLogin: record?.github_login ?? null });
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.github_status_failed');
      return apiError(c, 500, 'Failed to read GitHub connection status');
    }
  });

  registerOpenApiRoute(githubDisconnectRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await deleteUserGithubToken(web.userId);
      return c.json({ success: true });
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.github_disconnect_failed');
      return apiError(c, 500, 'Failed to disconnect GitHub');
    }
  });

  // ---- Per-user AI-provider credential (API-key) connect endpoints ----
  // Gated on isPerUserProviderKeysEnabled() (TOKEN_ENCRYPTION_KEY). No response
  // carries a secret value: list/set return provider/kind/label only, delete
  // returns { success }.
  registerOpenApiRoute(providerKeyListRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to manage provider keys');
    if ('error' in web) return web.error;
    const available = listConnectableVendors();
    const subscriptionAvailable = [...SUBSCRIPTION_PROVIDERS].sort();
    if (!isPerUserProviderKeysEnabled()) {
      // Gate off: the console hides connect affordances on `enabled:false`;
      // the agents matrix still reports install-env/ambient readiness.
      return c.json({
        enabled: false,
        connections: [],
        available,
        subscriptionAvailable,
        agents: buildAgentCredentialMatrix([]),
      });
    }
    try {
      const connections = await listUserProviderKeys(web.userId);
      return c.json({
        enabled: true,
        connections,
        available,
        subscriptionAvailable,
        agents: buildAgentCredentialMatrix(connections),
      });
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.provider_keys_list_failed');
      return apiError(c, 500, 'Failed to list provider keys');
    }
  });

  registerOpenApiRoute(providerKeySetRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to manage provider keys');
    if ('error' in web) return web.error;
    if (!isPerUserProviderKeysEnabled()) {
      return apiError(c, 404, 'Per-user provider keys are not enabled on this install');
    }
    const provider = c.req.param('provider') ?? '';
    const { apiKey, label } = getValidatedBody(c, providerKeySetBodySchema);
    try {
      const result = await persistProviderApiKey(web.userId, provider, apiKey, label);
      return c.json({ success: true, ...result });
    } catch (err) {
      if (err instanceof InvalidProviderKeyError) {
        // Caller error (unknown provider / blank key) — the validation message is
        // safe to surface and carries no secret.
        return apiError(c, 400, err.message);
      }
      // Encryption / DB failure — opaque 500, never echo the internal message.
      getLog().error(
        { err: err as Error, userId: web.userId, provider },
        'auth.provider_key_set_failed'
      );
      return apiError(c, 500, 'Failed to store provider key');
    }
  });

  registerOpenApiRoute(providerKeyDeleteRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to manage provider keys');
    if ('error' in web) return web.error;
    if (!isPerUserProviderKeysEnabled()) {
      return apiError(c, 404, 'Per-user provider keys are not enabled on this install');
    }
    const provider = normalizeCredentialVendor(c.req.param('provider') ?? '');
    // No catalog check here (unlike PUT): delete is an idempotent no-op, so an
    // unknown/misspelled vendor id simply removes nothing and returns ok.
    // Legacy agent-keyed ids normalize so `DELETE .../claude` removes the
    // migrated `anthropic` row.
    try {
      await deleteUserProviderKey(web.userId, provider);
      return c.json({ success: true });
    } catch (err) {
      getLog().error(
        { err: err as Error, userId: web.userId, provider },
        'auth.provider_key_delete_failed'
      );
      return apiError(c, 500, 'Failed to disconnect provider key');
    }
  });

  // ---- Subscription (OAuth) connect: start + poll ----
  // The bridge holds Pi's in-flight login() server-side; start returns the URL/
  // user-code, poll(code?) feeds a pasted code (manual flows) and reports status.
  // No response carries a secret. Paths are under /api/auth/providers/ so they're
  // already exempt from the Better Auth catch-all (isArchonOwnedAuthPath).
  registerOpenApiRoute(providerOAuthStartRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect a subscription');
    if ('error' in web) return web.error;
    if (!isPerUserProviderKeysEnabled()) {
      return apiError(c, 404, 'Per-user provider keys are not enabled on this install');
    }
    // Normalize legacy agent-keyed ids ('claude' → 'anthropic') like every
    // other credential entry point — SUBSCRIPTION_PROVIDERS is vendor-keyed.
    const provider = normalizeCredentialVendor(c.req.param('provider') ?? '');
    if (!SUBSCRIPTION_PROVIDERS.has(provider)) {
      return apiError(
        c,
        400,
        `Provider '${provider}' does not support subscription login. ` +
          `Subscription providers: ${[...SUBSCRIPTION_PROVIDERS].sort().join(', ')}.`
      );
    }
    try {
      const start = await startOAuth(web.userId, provider);
      return c.json(start);
    } catch (err) {
      // A leaked callback port from a previous attempt is an expected,
      // retryable condition — log it at warn under its own event (an
      // error-level `…_failed` would pollute error dashboards on multi-user
      // installs) and surface the actionable message as a 503 instead of an
      // opaque 500 (#1963).
      if (err instanceof OAuthCallbackPortBusyError) {
        getLog().warn({ userId: web.userId, provider }, 'auth.provider_oauth_start_port_busy');
        return apiError(c, 503, err.message);
      }
      getLog().error(
        { err: err as Error, userId: web.userId, provider },
        'auth.provider_oauth_start_failed'
      );
      return apiError(c, 500, 'Failed to start subscription login');
    }
  });

  registerOpenApiRoute(providerOAuthPollRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect a subscription');
    if ('error' in web) return web.error;
    if (!isPerUserProviderKeysEnabled()) {
      return apiError(c, 404, 'Per-user provider keys are not enabled on this install');
    }
    // The `:provider` path segment only keeps the OAuth routes under one prefix
    // (so they're exempt from the Better Auth catch-all); poll itself keys off
    // sessionId + userId.
    const { sessionId, code } = getValidatedBody(c, providerOAuthPollBodySchema);
    // pollOAuth is bound to the session's userId, so a stranger's sessionId resolves
    // to an error status rather than another user's login.
    const result = pollOAuth(sessionId, web.userId, code);
    return c.json(result);
  });

  // ---- Per-user AI preferences (Phase 3) ----
  // Identity-gated (requireWebUser) but NOT gated on TOKEN_ENCRYPTION_KEY —
  // prefs are model names, not secrets. Highest-precedence resolver layer.

  /** Validate a tier/alias entry's provider + effort. Returns an error message or null. */
  function validatePresetEntry(
    label: string,
    entry: { provider: string; model: string; effort?: EffortLevel }
  ): string | null {
    if (!isRegisteredProvider(entry.provider)) {
      return `Unknown provider '${entry.provider}' for ${label}. Available: ${getProviderInfoList()
        .map(p => p.id)
        .join(', ')}`;
    }
    if (entry.effort !== undefined && !isEffortValidForProvider(entry.provider, entry.effort)) {
      return (
        `Invalid effort '${entry.effort}' for provider '${entry.provider}' (${label}). ` +
        `Valid: ${validEffortsForProvider(entry.provider)?.join(', ') ?? '(none)'}`
      );
    }
    return null;
  }

  /** Validate a custom alias name: must start with '@' and not shadow a tier keyword. */
  function validateAliasName(name: string): string | null {
    if ((TIER_NAMES as readonly string[]).includes(name)) {
      return `Alias name '${name}' is reserved (small/medium/large are tier keywords). Use a different name.`;
    }
    if (!name.startsWith('@')) {
      return `Alias name '${name}' must start with '@' (e.g. '@${name}').`;
    }
    return null;
  }

  function toCleanEntry(entry: { provider: string; model: string; effort?: EffortLevel }): {
    provider: string;
    model: string;
    effort?: EffortLevel;
  } {
    return {
      provider: entry.provider,
      model: entry.model,
      ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
    };
  }

  registerOpenApiRoute(userAiPrefsGetRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to read AI preferences');
    if ('error' in web) return web.error;
    try {
      return c.json(await getUserAiPrefs(web.userId));
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.user_ai_prefs_get_failed');
      return apiError(c, 500, 'Failed to read AI preferences');
    }
  });

  registerOpenApiRoute(userAiPrefsTiersRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to update AI preferences');
    if ('error' in web) return web.error;
    const body = getValidatedBody(c, updateUserTiersBodySchema);
    const patch: UserTiersPatch = {};
    for (const tier of TIER_NAMES) {
      const entry = body.tiers[tier];
      if (entry === undefined) continue;
      if (entry === null) {
        patch[tier] = null;
        continue;
      }
      const errMsg = validatePresetEntry(`tier '${tier}'`, entry);
      if (errMsg) return apiError(c, 400, errMsg);
      patch[tier] = toCleanEntry(entry);
    }
    try {
      await setUserTiers(web.userId, patch);
      return c.json(await getUserAiPrefs(web.userId));
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.user_ai_prefs_tiers_failed');
      return apiError(c, 500, 'Failed to update AI tier preferences');
    }
  });

  registerOpenApiRoute(userAiPrefsAliasesRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to update AI preferences');
    if ('error' in web) return web.error;
    const body = getValidatedBody(c, updateUserAliasesBodySchema);
    const patch: UserAliasesPatch = {};
    for (const [name, entry] of Object.entries(body.aliases)) {
      const nameErr = validateAliasName(name);
      if (nameErr) return apiError(c, 400, nameErr);
      if (entry === null) {
        patch[name] = null;
        continue;
      }
      const errMsg = validatePresetEntry(`alias '${name}'`, entry);
      if (errMsg) return apiError(c, 400, errMsg);
      patch[name] = toCleanEntry(entry);
    }
    try {
      await setUserAliases(web.userId, patch);
      return c.json(await getUserAiPrefs(web.userId));
    } catch (err) {
      getLog().error(
        { err: err as Error, userId: web.userId },
        'auth.user_ai_prefs_aliases_failed'
      );
      return apiError(c, 500, 'Failed to update AI alias preferences');
    }
  });

  registerOpenApiRoute(userAiPrefsDefaultRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to update AI preferences');
    if ('error' in web) return web.error;
    const { provider, model } = getValidatedBody(c, updateUserDefaultBodySchema);
    if (provider !== null && !isRegisteredProvider(provider)) {
      return apiError(
        c,
        400,
        `Unknown provider '${provider}'. Available: ${getProviderInfoList()
          .map(p => p.id)
          .join(', ')}`
      );
    }
    if (provider === null && typeof model === 'string') {
      return apiError(c, 400, 'Cannot set a default model without a default provider');
    }
    try {
      // Atomic write: provider + model always land together — an omitted
      // model clears any previous pin so it can't ride a provider switch.
      await setUserDefault(web.userId, provider, model ?? null);
      return c.json(await getUserAiPrefs(web.userId));
    } catch (err) {
      getLog().error(
        { err: err as Error, userId: web.userId },
        'auth.user_ai_prefs_default_failed'
      );
      return apiError(c, 500, 'Failed to update default assistant preference');
    }
  });

  // Shared lock/dispatch/error handling for message and workflow endpoints
  /** Maximum allowed upload size per file (10 MB) */
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  /** Maximum number of files per message (enforced server-side) */
  const MAX_FILES_PER_MESSAGE = 5;
  /**
   * Binary (non-text) MIME types explicitly allowed for upload.
   * All text/* types are accepted separately via isAllowedUploadType().
   */
  const ALLOWED_UPLOAD_BINARY_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    // application/json is a structured text type browsers may report for .json files
    'application/json',
  ]);

  /** Extensions accepted when browser reports an empty MIME type (code/config files). */
  const ALLOWED_UPLOAD_EXTENSIONS = new Set([
    '.md',
    '.txt',
    '.csv',
    '.xml',
    '.html',
    '.htm',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.env',
    '.log',
    '.css',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rb',
    '.go',
    '.java',
    '.c',
    '.cpp',
    '.cc',
    '.cxx',
    '.h',
    '.hpp',
    '.cs',
    '.php',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.rs',
    '.swift',
    '.kt',
    '.scala',
    '.r',
    '.sql',
  ]);

  /** Returns true if the MIME type is allowed for upload. */
  function isAllowedUploadType(mimeType: string, fileName: string): boolean {
    // All text/* types are acceptable (covers .md, .py, .rs, .go, .sh, .yaml, etc.)
    if (mimeType.startsWith('text/')) return true;
    if (ALLOWED_UPLOAD_BINARY_MIME_TYPES.has(mimeType)) return true;
    // Browsers assign empty MIME types to many code/config extensions — fall back to extension
    if (!mimeType) {
      const dotIndex = fileName.lastIndexOf('.');
      if (dotIndex !== -1) {
        return ALLOWED_UPLOAD_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase());
      }
    }
    return false;
  }

  /**
   * Persist multipart-uploaded files to the conversation's upload directory.
   * Called from /api/workflows/:name/run; /api/conversations/:id/message still
   * inlines the same validate-write-rollback logic and could migrate to this
   * helper as a separate hygiene pass.
   *
   * Returns either { ok: true, savedFiles, uploadDir } or a structured error
   * the caller forwards via apiError; on the success path the caller passes
   * savedFiles + uploadDir to dispatchToOrchestrator so cleanup happens
   * inside the lock handler.
   */
  async function persistUploadedFiles(
    conversationId: string,
    fileEntries: File[]
  ): Promise<
    | { ok: true; savedFiles: AttachedFile[]; uploadDir: string }
    | { ok: false; status: 400 | 500; error: string }
  > {
    if (fileEntries.length > MAX_FILES_PER_MESSAGE) {
      return {
        ok: false,
        status: 400,
        error: `Maximum ${MAX_FILES_PER_MESSAGE.toString()} files per message`,
      };
    }

    const archonHome = getArchonHome();
    const uploadDir = join(archonHome, 'artifacts', 'uploads', conversationId);
    if (!isPathInside(archonHome, uploadDir, { lexical: true })) {
      return { ok: false, status: 400, error: 'Invalid conversation ID' };
    }

    // Validate all files before writing any to disk.
    for (const entry of fileEntries) {
      const displayName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!isAllowedUploadType(entry.type, entry.name)) {
        return {
          ok: false,
          status: 400,
          error: `File "${displayName}" has an unsupported type: ${entry.type}`,
        };
      }
      if (entry.size > MAX_UPLOAD_BYTES) {
        return {
          ok: false,
          status: 400,
          error: `File "${displayName}" exceeds the 10 MB size limit`,
        };
      }
    }

    const savedFiles: AttachedFile[] = [];
    try {
      await mkdir(uploadDir, { recursive: true });
      for (const entry of fileEntries) {
        const fileId = randomUUID();
        const safeName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = join(uploadDir, `${fileId}_${safeName}`);
        await writeFile(filePath, Buffer.from(await entry.arrayBuffer()));
        const normalizedMime =
          entry.type.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
        savedFiles.push({
          path: filePath,
          name: safeName || fileId,
          mimeType: normalizedMime,
          size: entry.size,
        });
      }
    } catch (writeErr: unknown) {
      for (const f of savedFiles) {
        await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') {
            getLog().warn({ err, filePath: f.path, conversationId }, 'upload.rollback_failed');
          }
        });
      }
      getLog().error({ err: writeErr, conversationId }, 'upload.write_failed');
      return {
        ok: false,
        status: 500,
        error: 'Failed to save uploaded file. Check available disk space.',
      };
    }

    return { ok: true, savedFiles, uploadDir };
  }

  /**
   * How a cleanup failure is reported. Shared by both call sites so the dispatch
   * that was refused and the dispatch that ran log the same way. The removal
   * itself lives in `./upload-cleanup`, which owns its own tests — this route
   * used to carry a second copy of it.
   */
  function warnCleanup(
    conversationId: string
  ): (err: NodeJS.ErrnoException, ctx: { uploadDir?: string }) => void {
    return (err, ctx) => {
      getLog().warn(
        { err, ...ctx, conversationId },
        ctx.uploadDir === undefined ? 'upload.cleanup_failed' : 'upload.dir_cleanup_failed'
      );
    };
  }

  /**
   * Tell the chat's stream its queue changed. A trigger, not a payload: the
   * queue's authority is the lock manager, and the console refetches it.
   */
  function emitQueueChanged(conversationId: string): void {
    webAdapter
      .emitSSE(
        conversationId,
        JSON.stringify({ type: 'conversation_queue', conversationId, timestamp: Date.now() })
      )
      .catch((err: unknown) => {
        getLog().warn({ err, conversationId }, 'queue_event_emit_failed');
      });
  }

  /**
   * A message the user typed, as opposed to a turn the server started for them
   * (a gate resume). Only these can wait visibly in the queue and be taken back,
   * and only these are written to the transcript — at DELIVERY, not at send, so
   * a message withdrawn while queued never appears and the transcript's order
   * is the order the agent actually read them in.
   */
  interface UserTurn {
    persist: () => Promise<void>;
    files: { name: string; mimeType: string; size: number }[];
  }

  /**
   * Write a user's message to the transcript when its turn STARTS, which is what
   * `UserTurn.persist` does for every user turn. A failure is reported on the
   * chat's stream rather than thrown: the turn itself still runs.
   */
  async function persistDeliveredUserMessage(
    platformConversationId: string,
    conversationDbId: string,
    message: string,
    fileMeta: UserTurn['files'],
    userId: string | undefined
  ): Promise<void> {
    const meta = fileMeta.length > 0 ? { files: fileMeta } : undefined;
    try {
      await messageDb.addMessage(conversationDbId, 'user', message, meta, userId);
    } catch (e: unknown) {
      getLog().error({ err: e, conversationId: conversationDbId }, 'message_persistence_failed');
      try {
        await webAdapter.emitSSE(
          platformConversationId,
          JSON.stringify({
            type: 'warning',
            message: 'Message could not be saved to history',
            timestamp: Date.now(),
          })
        );
      } catch (sseErr: unknown) {
        getLog().error(
          { err: sseErr, conversationId: conversationDbId },
          'sse_warning_double_failure'
        );
      }
    }
  }

  async function dispatchToOrchestrator(
    conversationId: string,
    message: string,
    extraContext?: Omit<HandleMessageContext, 'isolationHints'>,
    filesToCleanup?: { files: AttachedFile[]; uploadDir: string },
    userTurn?: UserTurn
  ): Promise<{ accepted: boolean; status: string; queuedId?: string }> {
    // Set once acquireLock returns. A turn that starts immediately runs its
    // handler before that, so it reads false; a queued one starts later and
    // reads true — which is exactly when leaving the queue is news.
    let wasQueued = false;
    const cleanupStaged = async (): Promise<void> => {
      if (filesToCleanup)
        await cleanupUploads(
          filesToCleanup.files,
          filesToCleanup.uploadDir,
          warnCleanup(conversationId)
        );
    };
    const handler = async ({ signal }: TurnContext): Promise<void> => {
      // Emit lock:true at handler start so the UI knows processing has begun.
      // Fire-and-forget — if no SSE stream is connected yet, the event is buffered.
      webAdapter.emitLockEvent(conversationId, true);
      try {
        if (userTurn) {
          await userTurn.persist();
          if (wasQueued) emitQueueChanged(conversationId);
        }
        await handleMessage(webAdapter, conversationId, message, {
          isolationHints: { workflowType: 'thread', workflowId: conversationId },
          ...extraContext,
          abortSignal: signal,
        });
      } catch (error) {
        getLog().error({ err: error, conversationId }, 'handle_message_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'error',
              message: `Failed to process message: ${(error as Error).message ?? 'unknown error'}. Try /reset if the problem persists.`,
              classification: 'transient',
              timestamp: Date.now(),
            })
          );
        } catch (sseError) {
          getLog().error({ err: sseError, conversationId }, 'sse_error_emit_failed');
        }
      } finally {
        await webAdapter.emitLockEvent(conversationId, false);
        // Clean up uploaded files AFTER handleMessage completes so the AI subprocess
        // has had a chance to read them. Doing this in the HTTP handler's finally block
        // would delete files while the fire-and-forget lock handler is still running.
        await cleanupStaged();
      }
    };
    const result = await lockManager.acquireLock(
      conversationId,
      handler,
      userTurn
        ? {
            text: message,
            files: userTurn.files,
            // Withdrawn means the handler never runs, so nothing else will remove
            // what the upload staged.
            onWithdraw: cleanupStaged,
            parkable: {
              text: message,
              attachedFiles: extraContext?.attachedFiles ?? [],
              ...(extraContext?.userId !== undefined ? { userId: extraContext.userId } : {}),
            },
          }
        : undefined
    );

    if (result.status === 'refused-draining') {
      // The handler never ran, so nothing else will remove what the upload staged and
      // no lock event was ever emitted to pair a release with.
      await cleanupStaged();
      return { accepted: false, status: result.status };
    }

    if (result.status === 'queued-conversation' || result.status === 'queued-capacity') {
      wasQueued = true;
      if (userTurn) emitQueueChanged(conversationId);
      // Intentionally fire-and-forget: the lock-acquire signal (locked: true) is sent
      // optimistically so the UI shows a queued state immediately. It is not awaited
      // because we want the HTTP response to return before the SSE write completes.
      // The lock-release signal (locked: false) IS awaited inside the task callback
      // above to guarantee ordering — all tool results and flush must precede the
      // release event on the SSE stream.
      webAdapter.emitLockEvent(conversationId, true);
    }

    return {
      accepted: true,
      status: result.status,
      ...(result.queuedId === undefined ? {} : { queuedId: result.queuedId }),
    };
  }

  /**
   * Start a turn in a watch's chat, the way a gate auto-resume does, carrying
   * the verdict as a `system` row so the history shows who spoke.
   *
   * The drain is checked BEFORE the row is written: a refused delivery is
   * retried after the restart, and writing first would put the notice in the
   * history twice. A drain beginning between the check and the dispatch can
   * still duplicate it; the turn itself never runs twice, because the watch is
   * released only when the dispatch was refused.
   */
  async function deliverCiWatchMessage(watch: CiWatch, message: string): Promise<CiWatchDelivery> {
    const conv = await conversationDb.getConversationById(watch.conversationId);
    if (conv?.platform_type !== 'web' || !conv.platform_conversation_id) {
      throw new Error(`CI watch ${watch.id} has no web chat to deliver to`);
    }
    if (lockManager.isDraining()) return 'refused';
    await messageDb.addMessage(conv.id, 'system', message, {
      origin: 'ci-watch',
      ciWatchId: watch.id,
    });
    // The web adapter persists the reply through this mapping, and after a
    // restart nothing else has written it for a chat nobody has opened.
    webAdapter.setConversationDbId(conv.platform_conversation_id, conv.id);
    const result = await dispatchToOrchestrator(conv.platform_conversation_id, message, {
      machineOrigin: 'ci-watch',
    });
    return result.accepted ? 'delivered' : 'refused';
  }

  /**
   * Re-enter the orchestrator after a paused approval gate is resolved, so a
   * web-dispatched workflow continues (approve) or runs its on_reject prompt
   * (reject) without the user having to re-run the workflow command. The CLI's
   * `workflowApproveCommand` / `workflowRejectCommand` already auto-resume via
   * `workflowRunCommand({ resume: true })`; this is the web-side equivalent.
   *
   * Returns `true` when a resume dispatch was initiated, `false` otherwise (no
   * usable path to resume the run — see below — parent conversation deleted,
   * parent was on a non-web platform, or dispatch threw). Failures are
   * non-fatal: the gate decision is recorded regardless; when this returns
   * `false` the response text instructs the user to re-run the workflow
   * command.
   *
   * **No parent conversation at all** (`parent_conversation_id` is `NULL` —
   * every CLI-launched run): falls back to `resumeWorkflowRunFromServer`, which
   * executes the run directly with no conversation involved (#2008).
   *
   * **Cross-adapter guard**: a run WITH a parent conversation only
   * auto-resumes through the web dispatch when that parent is web-sourced.
   * `dispatchToOrchestrator` is wired to the web adapter + its lock manager,
   * so a Slack / Telegram / GitHub / Discord run being approved from the
   * dashboard must not route through it — the Slack thread would never see
   * the resumed output. Non-web parents skip auto-resume and the originating
   * platform's own re-run flow applies; this branch is unchanged by #2008.
   */
  async function tryAutoResumeAfterGate(
    run: WorkflowRun,
    action: 'approve' | 'reject' | 'respond',
    // Identity of the user who approved/rejected the gate. The resumed chat
    // turn executes as THIS user (sender-first, #1976/#1982) — without it the
    // dispatch would fall back to the conversation creator's prefs/credentials.
    // Undefined on solo installs (no web identity) → creator fallback applies.
    gateActorUserId?: string
  ): Promise<boolean> {
    if (lockManager.isDraining()) {
      // The gate decision is already recorded and the run stays paused; the three
      // routes' existing "not resumed" text already tells the user how to continue.
      getLog().info({ runId: run.id, action }, 'api.workflow_gate_auto_resume_skipped_draining');
      return false;
    }
    // Literal event names per action — greppable for ops tooling. Keeping the
    // branch explicit rather than templating avoids the earlier 3-segment
    // `api.workflow_*.dispatched` shape that broke `{domain}.{action}_{state}`.
    const events =
      action === 'approve'
        ? {
            dispatched: 'api.workflow_approve_auto_resume_dispatched' as const,
            skippedNoPlatformConv:
              'api.workflow_approve_auto_resume_skipped_no_platform_conv' as const,
            skippedNonWebParent: 'api.workflow_approve_auto_resume_skipped_non_web_parent' as const,
            failed: 'api.workflow_approve_auto_resume_failed' as const,
            headlessDispatched: 'api.workflow_approve_auto_resume_headless_dispatched' as const,
            headlessSkipped: 'api.workflow_approve_auto_resume_headless_skipped' as const,
          }
        : action === 'reject'
          ? {
              dispatched: 'api.workflow_reject_auto_resume_dispatched' as const,
              skippedNoPlatformConv:
                'api.workflow_reject_auto_resume_skipped_no_platform_conv' as const,
              skippedNonWebParent:
                'api.workflow_reject_auto_resume_skipped_non_web_parent' as const,
              failed: 'api.workflow_reject_auto_resume_failed' as const,
              headlessDispatched: 'api.workflow_reject_auto_resume_headless_dispatched' as const,
              headlessSkipped: 'api.workflow_reject_auto_resume_headless_skipped' as const,
            }
          : {
              dispatched: 'api.workflow_respond_auto_resume_dispatched' as const,
              skippedNoPlatformConv:
                'api.workflow_respond_auto_resume_skipped_no_platform_conv' as const,
              skippedNonWebParent:
                'api.workflow_respond_auto_resume_skipped_non_web_parent' as const,
              failed: 'api.workflow_respond_auto_resume_failed' as const,
              headlessDispatched: 'api.workflow_respond_auto_resume_headless_dispatched' as const,
              headlessSkipped: 'api.workflow_respond_auto_resume_headless_skipped' as const,
            };
    if (!run.parent_conversation_id) {
      // No parent conversation to dispatch a chat message through at all —
      // every CLI-launched run (#2008). Execute directly instead of skipping.
      const headlessResumed = await resumeWorkflowRunFromServer(run, gateActorUserId);
      getLog().info(
        { runId: run.id, workflowName: run.workflow_name },
        headlessResumed ? events.headlessDispatched : events.headlessSkipped
      );
      return headlessResumed;
    }
    try {
      const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
      const platformConvId = parentConv?.platform_conversation_id;
      if (!platformConvId) {
        // parentConv === null is a data-integrity signal (the parent
        // conversation was deleted while the run was paused) — worth
        // surfacing at info level so operators notice. Missing
        // platform_conversation_id on an existing row shouldn't happen and
        // stays at debug.
        const logFn =
          parentConv === null ? getLog().info.bind(getLog()) : getLog().debug.bind(getLog());
        logFn(
          {
            runId: run.id,
            parentConversationId: run.parent_conversation_id,
            parentDeleted: parentConv === null,
          },
          events.skippedNoPlatformConv
        );
        return false;
      }
      if (parentConv.platform_type !== 'web') {
        getLog().debug(
          {
            runId: run.id,
            parentConversationId: run.parent_conversation_id,
            platformType: parentConv.platform_type,
          },
          events.skippedNonWebParent
        );
        return false;
      }
      // Explicit resume targeting: `/workflow resume <id>` routes through the
      // command handler's resume path, which validates the run and hands the
      // orchestrator a resume request carrying that run. A bare `/workflow run <name>` would
      // instead rely on implicit resume detection and collide with the
      // ambiguity guard for any non-paused resumable state (#2075).
      const resumeMessage = `/workflow resume ${run.id}`;
      const dispatched = await dispatchToOrchestrator(platformConvId, resumeMessage, {
        userId: gateActorUserId,
      });
      if (!dispatched.accepted) {
        // Drain can begin between the entry guard above and this dispatch; falling
        // through to `true` would tell the user the run resumed when nothing started.
        getLog().info({ runId: run.id, action }, 'api.workflow_gate_auto_resume_skipped_draining');
        return false;
      }
      getLog().info(
        { runId: run.id, workflowName: run.workflow_name, platformConvId },
        events.dispatched
      );
      return true;
    } catch (err) {
      getLog().warn({ err: err as Error, runId: run.id }, events.failed);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // API transform helpers (Date → ISO string for wire shape)
  // ---------------------------------------------------------------------------

  type ApiConversation = z.infer<typeof conversationSchema>;
  type ApiCodebase = z.infer<typeof codebaseSchema>;
  type ApiMessage = z.infer<typeof messageSchema>;
  type ApiWorkflowRun = z.infer<typeof workflowRunSchema>;
  type ApiDashboardWorkflowRun = z.infer<typeof dashboardWorkflowRunSchema>;

  function toISOString(val: Date | string): string;
  function toISOString(val: Date | string | null | undefined): string | null;
  function toISOString(val: Date | string | null | undefined): string | null {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') return val;
    try {
      return val.toISOString();
    } catch (e) {
      getLog().error({ err: e as Error, invalidDate: val }, 'api.invalid_date_transform');
      return null;
    }
  }

  /**
   * The content of each chat's newest message, but only where that message is
   * an assistant reply that MIGHT hold an ask block — the agent's clickable
   * multiple-choice question. Everything else maps to nothing.
   *
   * The substring test here is a deliberate OVER-approximation and must stay
   * one. What actually counts as an ask block — a top-level fence, of any
   * length, not nested inside a longer one — is decided by the console's own
   * parser (`experiments/console/primitives/ask.ts`), which is where the
   * format is defined and where the card is rendered. The console cannot
   * import server code and the server cannot import the console, so the rule
   * lives in exactly one of them and this end only decides what is worth
   * SENDING. Being broader than the real rule costs a few KB on a chat that
   * turns out not to have one; being narrower would hide a question, so it is
   * the one direction this may never drift in.
   */
  async function lastMessageFacts(
    conversations: readonly import('@archon/core').Conversation[]
  ): Promise<Map<string, { askCandidate: string | null }>> {
    const out = new Map<string, { askCandidate: string | null }>();
    const last = await messageDb.getLastMessagePerConversation(conversations.map(c => c.id));
    for (const [conversationId, message] of last) {
      const isAsk = message.role === 'assistant' && message.content.includes('```ask');
      out.set(conversationId, { askCandidate: isAsk ? message.content : null });
    }
    return out;
  }

  function toApiConversation(row: import('@archon/core').Conversation): ApiConversation {
    return {
      ...row,
      created_at: toISOString(row.created_at),
      updated_at: toISOString(row.updated_at),
      deleted_at: toISOString(row.deleted_at),
      completed_at: toISOString(row.completed_at),
      last_read_at: toISOString(row.last_read_at),
      ready_at: toISOString(row.ready_at),
      last_activity_at: toISOString(row.last_activity_at),
    };
  }

  function toApiCodebase(row: import('@archon/core').Codebase): ApiCodebase {
    let commands = row.commands;
    if (typeof commands === 'string') {
      try {
        commands = JSON.parse(commands) as Record<string, { path: string; description: string }>;
      } catch (parseErr) {
        getLog().error({ err: parseErr as Error, codebaseId: row.id }, 'corrupted_commands_json');
        // Fallback: empty map keeps the API response valid and prevents the endpoint
        // from crashing. The corruption is already logged above for operator attention.
        commands = {};
      }
    }
    return {
      ...row,
      commands,
      created_at: toISOString(row.created_at),
      updated_at: toISOString(row.updated_at),
    };
  }

  function toApiMessage(row: MessageRow): ApiMessage {
    let metadata = row.metadata;
    if (typeof metadata !== 'string') {
      try {
        metadata = JSON.stringify(metadata);
      } catch (e) {
        getLog().error(
          { err: e as Error, messageId: row.id },
          'api.message_metadata_serialize_failed'
        );
        metadata = '{}';
      }
    }
    // Bound tool_result outputs in hydration responses — the DB keeps the full
    // value; only the browser-bound payload is capped (see #2236).
    return { ...row, metadata: boundMetadataToolOutputs(metadata) };
  }

  function toApiWorkflowRun(row: WorkflowRun): ApiWorkflowRun {
    return {
      ...row,
      started_at: toISOString(row.started_at),
      completed_at: toISOString(row.completed_at),
      last_activity_at: toISOString(row.last_activity_at),
    };
  }

  function toApiDashboardWorkflowRun(row: DashboardWorkflowRun): ApiDashboardWorkflowRun {
    return {
      ...row,
      started_at: toISOString(row.started_at),
      completed_at: toISOString(row.completed_at),
      last_activity_at: toISOString(row.last_activity_at),
    };
  }

  /**
   * Most conversations one listing returns. Generous rather than tuned: the
   * rail draws a project's chats, and a project accumulates finished ones
   * forever, so a limit sized to today's busiest project silently starts
   * dropping rows in a fortnight. The response carries `total` alongside, so
   * reaching this number is something a client can see and say.
   */
  const CONVERSATION_LIST_LIMIT = 500;

  // GET /api/conversations - List conversations
  registerOpenApiRoute(getConversationsRoute, async c => {
    try {
      const platformType = c.req.query('platform') ?? undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      // Non-enforcing "mine" filter: only narrows when an identity resolves.
      // Default visibility stays open (everyone sees everyone's conversations).
      const mine = c.req.query('mine') === 'true';
      const userId = mine ? (await resolveAuthContext(c))?.userId : undefined;
      if (mine && !userId && getAuth()) {
        // Narrowing was requested but no identity resolved on an install with
        // web auth configured — the list silently degrades to ALL conversations
        // (documented non-enforcing posture). Without web auth (solo installs,
        // where the console always sends mine=true) this is the normal path
        // and stays silent.
        getLog().warn({ route: 'GET /api/conversations' }, 'api.mine_filter_identity_unresolved');
      }
      const archivedParam = c.req.query('archived');
      const archived =
        archivedParam === 'archived' || archivedParam === 'all' ? archivedParam : 'active';
      // Omitted asks nothing, which is what every caller that predates the
      // lifecycle filter needs: it keeps the rows it already got.
      const stateParam = c.req.query('state');
      const state = stateParam === 'open' || stateParam === 'done' ? stateParam : 'all';
      // A caller may ask for fewer rows than the cap, but never more: the cap
      // is what keeps one request from reading an unbounded table. The query
      // schema has already refused anything that is not a positive integer,
      // so what is left to decide here is the absent case and the ceiling.
      const requested = Number(c.req.query('limit'));
      const limit =
        Number.isFinite(requested) && requested > 0
          ? Math.min(requested, CONVERSATION_LIST_LIMIT)
          : CONVERSATION_LIST_LIMIT;
      const { rows, counts } = await conversationDb.listConversations({
        limit,
        platformType,
        codebaseId,
        excludeEmpty: true,
        userId,
        archived,
        state,
      });
      const facts = await lastMessageFacts(rows);
      return c.json({
        conversations: rows.map(row => {
          const fact = facts.get(row.id);
          return {
            ...toApiConversation(row),
            ask_candidate: fact?.askCandidate ?? null,
          };
        }),
        counts,
      });
    } catch (error) {
      getLog().error({ err: error }, 'list_conversations_failed');
      return apiError(c, 500, 'Failed to list conversations');
    }
  });

  // GET /api/conversations/:id - Get single conversation by platform conversation ID
  registerOpenApiRoute(getConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      return c.json(toApiConversation(conv));
    } catch (error) {
      getLog().error({ err: error, platformId }, 'get_conversation_failed');
      return apiError(c, 500, 'Failed to get conversation');
    }
  });

  // GET /api/conversations/:id/lock - Is this conversation executing a turn?
  registerOpenApiRoute(getConversationLockRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      // Existence is checked so an id that names nothing gets a 404 rather than
      // `locked: false`, which reads as a real answer about a real chat.
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      return c.json({ conversationId: platformId, locked: lockManager.isActive(platformId) });
    } catch (error) {
      getLog().error({ err: error, platformId }, 'get_conversation_lock_failed');
      return apiError(c, 500, 'Failed to read conversation lock state');
    }
  });

  // GET /api/conversations/:id/checkout - Branch, folder and dirty state
  registerOpenApiRoute(getConversationCheckoutRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      const codebase =
        conv.codebase_id === null ? null : await codebaseDb.getCodebase(conv.codebase_id);
      return c.json(await readConversationCheckout(conv, codebase));
    } catch (error) {
      getLog().error({ err: error, platformId }, 'get_conversation_checkout_failed');
      return apiError(c, 500, 'Failed to read conversation checkout');
    }
  });

  // POST /api/conversations - Create new conversation
  // Accepts optional `message` field for atomic create+send (avoids ghost "Untitled" entries)
  registerOpenApiRoute(createConversationRoute, async c => {
    try {
      const userId = await resolveWebUserId(c);

      let codebaseId: string | undefined;
      let message: string | undefined;
      let fileEntries: File[] = [];

      const contentType = c.req.header('content-type') ?? '';
      if (contentType.includes('multipart/form-data')) {
        let body: Record<string, string | File | (string | File)[]>;
        try {
          body = await c.req.parseBody({ all: true });
        } catch (parseErr: unknown) {
          getLog().warn({ err: parseErr }, 'conversation.upload_parse_failed');
          return apiError(c, 400, 'Bad request', 'Invalid multipart form data');
        }
        if (typeof body.codebaseId === 'string' && body.codebaseId.length > 0) {
          codebaseId = body.codebaseId;
        }
        if (typeof body.message === 'string' && body.message.length > 0) {
          message = body.message;
        }
        const rawFiles = body.files;
        const fileList: (string | File)[] = Array.isArray(rawFiles)
          ? rawFiles
          : rawFiles !== undefined
            ? [rawFiles]
            : [];
        fileEntries = fileList.filter((e): e is File => e instanceof File);
        // Attachments ride a message; with no message there is nothing to
        // attach them to and nothing would ever read them.
        if (fileEntries.length > 0 && message === undefined) {
          return apiError(c, 400, 'Bad request', 'message is required when files are attached');
        }
      } else {
        // The body is optional (an empty POST creates an empty conversation),
        // so an absent body parses as `{}` rather than failing.
        let json: unknown = {};
        const rawBody = await c.req.text();
        if (rawBody.length > 0) {
          try {
            json = JSON.parse(rawBody);
          } catch {
            return apiError(c, 400, 'Bad request', 'Invalid JSON in request body');
          }
        }
        const parsed = createConversationBodySchema.safeParse(json);
        if (!parsed.success) {
          // Formatted exactly as validationErrorHook would have, so dropping the
          // declarative body above does not change this route's error contract.
          return c.json(
            { error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') },
            400
          );
        }
        codebaseId = parsed.data.codebaseId;
        message = parsed.data.message;
      }

      // Validate codebase exists if provided
      if (codebaseId) {
        const codebase = await codebaseDb.getCodebase(codebaseId);
        if (!codebase) {
          return apiError(c, 400, 'Codebase not found', `No codebase with id "${codebaseId}"`);
        }
      }

      // Refuse before the row exists: creating it and then refusing the dispatch would
      // leave exactly the ghost "Untitled" conversation this route dispatches atomically
      // to avoid. An empty conversation carries no work, so drain still allows it.
      if (message && lockManager.isDraining()) {
        return apiError(c, 503, DRAIN_REFUSAL_NOTICE);
      }

      const conversationId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Persist uploads before creating anything in the database, so a rejected
      // upload leaves no ghost conversation behind.
      let savedFiles: AttachedFile[] = [];
      let uploadDir = '';
      if (fileEntries.length > 0) {
        const saved = await persistUploadedFiles(conversationId, fileEntries);
        if (!saved.ok) {
          return c.json({ error: saved.error }, saved.status);
        }
        savedFiles = saved.savedFiles;
        uploadDir = saved.uploadDir;
        getLog().info(
          { conversationId, fileCount: savedFiles.length },
          'conversation.files_uploaded'
        );
      }

      const conversation = await conversationDb.getOrCreateConversation(
        'web',
        conversationId,
        codebaseId,
        undefined,
        userId
      );
      webAdapter.setConversationDbId(conversation.platform_conversation_id, conversation.id);

      // If message provided, dispatch it atomically (avoids ghost "Untitled" conversations)
      if (message) {
        try {
          // Same shape the send-message route persists: name/type/size only,
          // never the path — the file is deleted once the agent has read it.
          const meta =
            savedFiles.length > 0
              ? {
                  files: savedFiles.map(f => ({
                    name: f.name,
                    mimeType: f.mimeType,
                    size: f.size,
                  })),
                }
              : undefined;
          await messageDb.addMessage(conversation.id, 'user', message, meta, userId);
        } catch (e: unknown) {
          // Log only (no SSE warning) — the SSE stream isn't connected yet for new conversations.
          // The existing /message endpoint emits a warning because the stream is guaranteed to be active.
          getLog().error({ err: e, conversationId: conversation.id }, 'message_persistence_failed');
        }

        // Set placeholder title immediately so the sidebar never shows "Untitled conversation"
        const placeholderTitle = message.length > 60 ? message.slice(0, 60) + '...' : message;
        await conversationDb.updateConversationTitle(
          conversation.id,
          placeholderTitle,
          'automation'
        );

        // Generate proper AI title for non-command messages (fire-and-forget, overwrites placeholder).
        // Resolve the `small` tier (config tiers + per-user prefs) instead of the raw
        // assistant default — the config-default Codex model may not be usable on the
        // active account (e.g. ChatGPT-plan accounts, #1855). Both calls never throw.
        if (!message.startsWith('/')) {
          void resolveTitleRequest(conversation.ai_assistant_type, userId).then(titleRequest =>
            generateAndSetTitle(
              conversation.id,
              message,
              titleRequest.provider,
              getArchonWorkspacesPath(),
              undefined,
              titleRequest.options.assistantConfig,
              titleRequest.options
            )
          );
        }

        const extraContext: Omit<HandleMessageContext, 'isolationHints'> =
          savedFiles.length > 0 ? { userId, attachedFiles: savedFiles } : { userId };
        // Cleanup runs inside the lock handler after the agent has read the
        // files, never in this request's scope.
        const filesToCleanup = savedFiles.length > 0 ? { files: savedFiles, uploadDir } : undefined;
        const result = await dispatchToOrchestrator(
          conversation.platform_conversation_id,
          message,
          extraContext,
          filesToCleanup
        );
        // Backstop for a drain that begins after the check above: never answer
        // `dispatched: true` for a turn the lock manager refused.
        if (!result.accepted) return apiError(c, 503, DRAIN_REFUSAL_NOTICE);

        return c.json({
          conversationId: conversation.platform_conversation_id,
          id: conversation.id,
          dispatched: true,
          ...result,
        });
      }

      return c.json({ conversationId: conversation.platform_conversation_id, id: conversation.id });
    } catch (error) {
      getLog().error({ err: error }, 'create_conversation_failed');
      return apiError(c, 500, 'Failed to create conversation');
    }
  });

  // PATCH /api/conversations/:id - Update conversation (title, color, archived, completed, ready)
  registerOpenApiRoute(updateConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    const { title, color, archived, completed, ready } = getValidatedBody(
      c,
      updateConversationBodySchema
    );
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      if (title !== undefined) {
        // A rename through this route is a person choosing the name, so pin it.
        // Automatic titling only writes unpinned rows; without the pin the two
        // writers are indistinguishable and the edit gets undone.
        await conversationDb.updateConversationTitle(conv.id, title.slice(0, 255), 'person');
      }
      // `undefined` leaves the color alone; an explicit `null` clears it. The
      // schema already constrained any non-null value to CONVERSATION_COLORS.
      if (color !== undefined) {
        await conversationDb.updateConversationColor(conv.id, color);
      }
      // Symmetric on purpose: the same field archives and restores, so an
      // archive is never a one-way door the user cannot walk back through.
      if (archived !== undefined) {
        await conversationDb.setConversationArchived(conv.id, archived);
      }
      // Done and archived are set independently, in whichever combination the
      // caller asked for. A chat whose work has landed is very often one you
      // still want listed, and one you have tidied away is not necessarily
      // finished; collapsing the two into one field would make each imply the
      // other.
      if (completed !== undefined) {
        await conversationDb.setConversationCompleted(conv.id, completed);
      }
      // The agent's claim that the work is finished. Written before the
      // completion sweep below so an explicit `ready` in the same request is not
      // silently undone by it — a caller that says both is stating the end
      // state, and the end state it named is the one that is stored.
      if (ready !== undefined) {
        await conversationDb.setConversationReady(conv.id, ready);
      }
      // Marking a chat done ANSWERS the agent's claim, so the claim is spent.
      // Leaving it would show a chat as both finished and waiting to be judged,
      // and the rail would have to decide which — a precedence question that
      // only exists if this row is allowed to hold two contradictory states at
      // once. Clearing it here is what makes `ready` reachable in both
      // directions without the console doing anything: the mark that could only
      // turn on is the failure this whole signal is shaped around.
      if (completed === true && ready !== true) {
        await conversationDb.setConversationReady(conv.id, false);
      }
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'update_conversation_failed');
      return apiError(c, 500, 'Failed to update conversation');
    }
  });

  /** Wire shape of what the next turn runs on. */
  function chatModelBody(
    request: ChatModelRequest,
    conv: { pinned_model: string | null; pinned_effort: string | null }
  ): z.infer<typeof chatModelResponseSchema> {
    const effort = request.preset?.effort;
    return {
      provider: request.provider,
      model: request.model ?? null,
      effort: effort ?? null,
      pin: request.pinned
        ? {
            model: conv.pinned_model,
            effort: isEffortRung(conv.pinned_effort) ? conv.pinned_effort : null,
          }
        : null,
    };
  }

  // GET /api/conversations/:id/model - what the chat's next turn runs on (#132)
  registerOpenApiRoute(getChatModelRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) return apiError(c, 404, 'Conversation not found');
      const next = await resolveNextChatModel(conv, await resolveWebUserId(c));
      return c.json(chatModelBody(next, conv));
    } catch (error) {
      getLog().error({ err: error }, 'get_chat_model_failed');
      return apiError(c, 500, 'Failed to resolve the chat model');
    }
  });

  // PUT /api/conversations/:id/model - pin this chat's model/effort (#132).
  // Never touches the user's or the install's default: the pin lives on this
  // conversation's row and nowhere else. A turn already running resolved its
  // model before this write, so the pin applies from the next turn.
  registerOpenApiRoute(setChatModelRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    const { provider, model, effort } = getValidatedBody(c, setChatModelBodySchema);
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) return apiError(c, 404, 'Conversation not found');
      const userId = await resolveWebUserId(c);
      // A pin only applies on the provider the chat resolves to, so one
      // for any other provider would be stored and silently ignored. The
      // picker sends the provider it was showing; a mismatch means the default
      // assistant moved underneath it.
      const current = await resolveNextChatModel(conv, userId);
      if (provider !== current.provider) {
        return apiError(
          c,
          409,
          `This chat now runs on ${current.provider}, not ${provider} — reopen the picker.`
        );
      }
      // The registry is the gate: the provider's own strict parser for the
      // model, the shared effort ladder for effort.
      let pinnedModel = model;
      if (model !== null) {
        pinnedModel = normalizeStrictRunModelPreset({ provider, model }).model;
      }
      if (effort !== null) {
        const decision = resolvePresetEffort(provider, effort);
        if (!decision.ok) {
          return apiError(
            c,
            400,
            decision.reason === 'unsupported'
              ? `${provider} has no reasoning-effort control.`
              : `'${effort}' is not an effort ${provider} accepts.`
          );
        }
      }
      const pin =
        pinnedModel === null && effort === null ? null : { provider, model: pinnedModel, effort };
      await conversationDb.setConversationModelPin(conv.id, pin);
      const updated = await conversationDb.getConversationById(conv.id);
      if (!updated) return apiError(c, 404, 'Conversation not found');
      return c.json(chatModelBody(await resolveNextChatModel(updated, userId), updated));
    } catch (error) {
      if (error instanceof RunModelPresetValidationError) {
        return apiError(c, 400, error.message);
      }
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'set_chat_model_failed');
      return apiError(c, 500, 'Failed to set the chat model');
    }
  });

  // POST /api/conversations/:id/read - Clear the unread mark
  registerOpenApiRoute(markConversationReadRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      await conversationDb.markConversationRead(conv.id);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error, platformId }, 'mark_conversation_read_failed');
      return apiError(c, 500, 'Failed to mark conversation read');
    }
  });

  // PUT /api/conversations/order - Arrange the rail
  registerOpenApiRoute(setConversationOrderRoute, async c => {
    const { ids } = getValidatedBody(c, setConversationOrderBodySchema);
    try {
      const dbIds = await conversationDb.findConversationIdsByPlatformIds(ids);
      // An id the rail named but the database does not have is dropped rather
      // than rejected: a rail that has not refreshed since a chat was deleted
      // is a normal race, not a bad request, and the rest of the arrangement
      // is still exactly what the user asked for.
      const ordered = ids.map(id => dbIds.get(id)).filter((id): id is string => id !== undefined);
      await conversationDb.setConversationOrder(ordered);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error }, 'set_conversation_order_failed');
      return apiError(c, 500, 'Failed to arrange conversations');
    }
  });

  // DELETE /api/conversations/:id - Soft delete
  registerOpenApiRoute(deleteConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      await conversationDb.softDeleteConversation(conv.id);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'delete_conversation_failed');
      return apiError(c, 500, 'Failed to delete conversation');
    }
  });

  // GET /api/conversations/:id/messages - Message history
  registerOpenApiRoute(listMessagesRoute, async c => {
    const platformConversationId = c.req.param('id') ?? '';
    const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformConversationId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      const messages = await messageDb.listMessages(conv.id, limit);
      return c.json(messages.map(toApiMessage));
    } catch (error) {
      getLog().error({ err: error }, 'list_messages_failed');
      return apiError(c, 500, 'Failed to list messages');
    }
  });

  // POST /api/conversations/:id/message - Send message
  // Manual body parsing: multipart uses parseBody(), JSON uses req.json().
  registerOpenApiRoute(sendMessageRoute, async c => {
    const conversationId = c.req.param('id') ?? '';
    const userId = await resolveWebUserId(c);

    // Reject conversation IDs that could be used for path traversal when building
    // the upload directory. Web conversation IDs are alphanumeric with hyphens only.
    if (!/^[\w-]+$/.test(conversationId)) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    let message: string;
    let savedFiles: AttachedFile[] = [];
    let uploadDir = '';

    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      let body: Record<string, string | File | (string | File)[]>;
      try {
        body = await c.req.parseBody({ all: true });
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr, conversationId }, 'upload.parse_failed');
        return c.json({ error: 'Invalid multipart form data' }, 400);
      }

      const rawMessage = body.message;
      if (typeof rawMessage !== 'string' || !rawMessage) {
        return c.json({ error: 'message must be a non-empty string' }, 400);
      }
      message = rawMessage;

      const rawFiles = body.files;
      let fileList: (string | File)[];
      if (Array.isArray(rawFiles)) {
        fileList = rawFiles;
      } else if (rawFiles !== undefined) {
        fileList = [rawFiles];
      } else {
        fileList = [];
      }

      const fileEntries = fileList.filter((e): e is File => e instanceof File);
      if (fileEntries.length > 0) {
        const result = await persistUploadedFiles(conversationId, fileEntries);
        if (!result.ok) {
          return c.json({ error: result.error }, result.status);
        }
        savedFiles = result.savedFiles;
        uploadDir = result.uploadDir;
        getLog().info({ conversationId, fileCount: savedFiles.length }, 'message.files_uploaded');
      }
    } else {
      let body: { message?: unknown };
      try {
        body = await c.req.json();
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr, conversationId }, 'message.json_parse_failed');
        return c.json({ error: 'Invalid JSON in request body' }, 400);
      }

      if (typeof body.message !== 'string' || !body.message) {
        return c.json({ error: 'message must be a non-empty string' }, 400);
      }
      message = body.message;
    }

    // Look up conversation for message persistence
    let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
    try {
      conv = await conversationDb.findConversationByPlatformId(conversationId);
    } catch (e: unknown) {
      getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
    }

    // Sending to an archived chat brings it back. Archive means "not now", and a
    // message disappearing into a hidden thread is a surprise found much later.
    if (conv?.deleted_at != null) {
      try {
        await conversationDb.setConversationArchived(conv.id, false);
      } catch (e: unknown) {
        getLog().warn({ err: e, conversationId: conv.id }, 'conversation.restore_on_send_failed');
      }
    }

    // Omit path from persisted metadata — the on-disk file is ephemeral and will be
    // deleted after the AI processes it; storing stale paths would confuse future readers.
    const fileMeta = savedFiles.map(f => ({ name: f.name, mimeType: f.mimeType, size: f.size }));
    const persistUserMessage = async (): Promise<void> => {
      if (conv)
        await persistDeliveredUserMessage(conversationId, conv.id, message, fileMeta, userId);
    };
    if (conv) webAdapter.setConversationDbId(conversationId, conv.id);

    // Pass savedFiles to dispatchToOrchestrator so cleanup happens inside the lock handler,
    // AFTER handleMessage completes — not in the HTTP handler's finally block where the
    // fire-and-forget lock callback may still be running and the AI has not yet read the files.
    const extraContext: Omit<HandleMessageContext, 'isolationHints'> =
      savedFiles.length > 0 ? { userId, attachedFiles: savedFiles } : { userId };
    let filesToCleanup: { files: AttachedFile[]; uploadDir: string } | undefined;
    if (savedFiles.length > 0) {
      filesToCleanup = { files: savedFiles, uploadDir };
    }
    const result = await dispatchToOrchestrator(
      conversationId,
      message,
      extraContext,
      filesToCleanup,
      { persist: persistUserMessage, files: fileMeta }
    );
    if (!result.accepted) return apiError(c, 503, DRAIN_REFUSAL_NOTICE);
    return c.json(result);
  });

  // POST /api/conversations/:id/interrupt - Stop the running turn
  registerOpenApiRoute(interruptConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) return apiError(c, 404, 'Conversation not found');
      const turn = lockManager.interrupt(platformId);
      if (turn === undefined)
        return c.json({ conversationId: platformId, status: 'idle' as const });
      // Wait briefly so the common case answers "stopped" rather than making the
      // client wait for a lock event to learn it. A provider slower than this is
      // reported as still stopping — never as stopped, because the lock is held
      // until the turn really returns.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = await Promise.race([
        turn.then(() => true),
        new Promise<false>(resolve => {
          timer = setTimeout(() => {
            resolve(false);
          }, INTERRUPT_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      return c.json({
        conversationId: platformId,
        status: ended ? 'stopped' : 'stopping',
      } as const);
    } catch (error) {
      getLog().error({ err: error, platformId }, 'interrupt_conversation_failed');
      return apiError(c, 500, 'Failed to stop the turn');
    }
  });

  // GET /api/conversations/:id/queue - Messages waiting behind the running turn
  registerOpenApiRoute(getConversationQueueRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) return apiError(c, 404, 'Conversation not found');
      return c.json({ conversationId: platformId, messages: lockManager.listQueued(platformId) });
    } catch (error) {
      getLog().error({ err: error, platformId }, 'get_conversation_queue_failed');
      return apiError(c, 500, 'Failed to read the queue');
    }
  });

  /**
   * The checkout a chat's agent runs in, by the orchestrator's own rule
   * (`conversationCheckout`), never a path the request names. Null for a chat
   * with no project, or whose project row is gone.
   */
  const chatCheckout = async (conv: {
    codebase_id: string | null;
    cwd: string | null;
  }): Promise<string | null> => {
    if (conv.codebase_id === null) return null;
    const codebase = await codebaseDb.getCodebase(conv.codebase_id);
    return conversationCheckout(conv, codebase ?? undefined);
  };

  // GET /api/conversations/:id/changes - Uncommitted changes, read-only
  registerOpenApiRoute(getConversationChangesRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) return apiError(c, 404, 'Conversation not found');
      const checkout = await chatCheckout(conv);
      if (checkout === null) return c.json({ state: 'unscoped' as const });
      try {
        const changes = await readWorkingChanges(checkout);
        return c.json({ state: 'ok' as const, ...changes });
      } catch (error) {
        if (error instanceof NotAGitCheckoutError) {
          return c.json({ state: 'not-a-checkout' as const, path: checkout });
        }
        throw error;
      }
    } catch (error) {
      getLog().error({ err: error, platformId }, 'conversation_changes.list_failed');
      return apiError(c, 500, 'Failed to read changes');
    }
  });

  // GET /api/conversations/:id/changes/diff?path= - One changed file's diff
  registerOpenApiRoute(getConversationChangeDiffRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    const path = c.req.query('path') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) return apiError(c, 404, 'Conversation not found');
      const checkout = await chatCheckout(conv);
      if (checkout === null) return apiError(c, 404, 'This chat has no project checkout');
      let file;
      try {
        // The path must be one git itself lists as changed — the only files
        // this route will ever read — so a request cannot name its way to an
        // arbitrary file, and needs no traversal checks of its own.
        file = (await readWorkingChanges(checkout)).files.find(f => f.path === path);
      } catch (error) {
        if (error instanceof NotAGitCheckoutError) {
          return apiError(c, 404, 'This chat has no git checkout');
        }
        throw error;
      }
      if (file === undefined) return apiError(c, 404, 'No uncommitted change at that path');
      return c.json(await readWorkingFileDiff(checkout, file));
    } catch (error) {
      getLog().error({ err: error, platformId }, 'conversation_changes.diff_failed');
      return apiError(c, 500, 'Failed to read diff');
    }
  });

  // DELETE /api/conversations/:id/queue/:queuedId - Withdraw a queued message
  registerOpenApiRoute(withdrawQueuedMessageRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    const queuedId = c.req.param('queuedId') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) return apiError(c, 404, 'Conversation not found');
      const result = lockManager.withdraw(platformId, queuedId);
      if (result.status === 'withdrawn') emitQueueChanged(platformId);
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error, platformId, queuedId }, 'withdraw_queued_message_failed');
      return apiError(c, 500, 'Failed to withdraw the message');
    }
  });

  // GET /api/stream/__dashboard__ — multiplexed dashboard SSE (all workflow events)
  // IMPORTANT: Must be registered before /api/stream/:conversationId to avoid param capture.
  app.get('/api/stream/__dashboard__', async c => {
    return streamSSE(c, async stream => {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream(DASHBOARD_STREAM, stream);
      getLog().debug({ streamId: DASHBOARD_STREAM }, 'dashboard_sse_opened');

      stream.onAbort(() => {
        getLog().debug({ streamId: DASHBOARD_STREAM }, 'dashboard_sse_disconnected');
        webAdapter.removeStream(DASHBOARD_STREAM, stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error }, 'dashboard_sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream(DASHBOARD_STREAM, stream);
        getLog().debug({ streamId: DASHBOARD_STREAM }, 'dashboard_sse_closed');
      }
    });
  });

  // GET /api/stream/:conversationId - SSE streaming
  app.get('/api/stream/:conversationId', async c => {
    const conversationId = c.req.param('conversationId');

    return streamSSE(c, async stream => {
      // Send initial heartbeat immediately to flush HTTP headers.
      // Without this, EventSource stays in CONNECTING state until the first write.
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream(conversationId, stream);
      getLog().debug({ conversationId }, 'sse_stream_opened');

      stream.onAbort(() => {
        getLog().debug({ conversationId }, 'sse_client_disconnected');
        webAdapter.removeStream(conversationId, stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        // stream.sleep() throws when client disconnects — expected behavior.
        // Log unexpected errors for debugging.
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error, conversationId }, 'sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream(conversationId, stream);
        getLog().debug({ conversationId }, 'sse_stream_closed');
      }
    });
  });

  // GET /api/codebases - List codebases
  registerOpenApiRoute(listCodebasesRoute, async c => {
    try {
      const codebases = await codebaseDb.listCodebases();

      // Deduplicate by repository_url (keep most recently updated)
      const normalizeUrl = (url: string): string => url.replace(/\.git$/, '');
      const seen = new Map<string, (typeof codebases)[number]>();
      const deduped: (typeof codebases)[number][] = [];
      for (const cb of codebases) {
        if (!cb.repository_url) {
          deduped.push(cb);
          continue;
        }
        const key = normalizeUrl(cb.repository_url);
        const existing = seen.get(key);
        if (!existing || cb.updated_at > existing.updated_at) {
          seen.set(key, cb);
        }
      }
      deduped.push(...seen.values());
      deduped.sort((a, b) => a.name.localeCompare(b.name));

      return c.json(deduped.map(toApiCodebase));
    } catch (error) {
      getLog().error({ err: error }, 'list_codebases_failed');
      return apiError(c, 500, 'Failed to list codebases');
    }
  });

  // GET /api/codebases/:id - Codebase detail
  // =======================================================================
  // Files tab (#23) — read a project's checkout, one directory at a time.
  //
  // The fence is the project root itself, NOT ARCHON_HOME: a checkout sits
  // outside ARCHON_HOME by design, so isInsideArchonHome() would refuse every
  // legitimate read here. Containment is proved by resolveContainedPath, the
  // same chain the artifact route uses.
  //
  // Nothing is filtered out of a listing — `.git` and dotfiles included. A
  // file explorer that silently hides part of the tree is lying about what is
  // on disk, and the read path refuses binaries anyway.
  // =======================================================================

  /** Text only. A binary served down a text route is corruption with a 200 on it. */
  const MAX_FILE_BYTES = 1024 * 1024;

  /**
   * Resolve a project's root for either kind. `default_cwd` is the tree its
   * runs operate on, which is exactly the tree the Files tab must show.
   */
  const codebaseRoot = async (id: string): Promise<string | null> => {
    const codebase = await codebaseDb.getCodebase(id);
    return codebase?.default_cwd ?? null;
  };

  registerOpenApiRoute(listCodebaseFilesRoute, async c => {
    const id = c.req.param('id') ?? '';
    const rawPath = c.req.query('path') ?? '';
    try {
      const root = await codebaseRoot(id);
      if (root === null) {
        return apiError(c, 404, 'Codebase not found');
      }

      const contained = await resolveContainedPath(root, rawPath);
      if (!contained.ok) {
        if (contained.reason === 'invalid' || contained.reason === 'escaped') {
          getLog().warn({ codebaseId: id, path: rawPath }, 'codebase_files.path_escape_blocked');
          return apiError(c, 400, 'Invalid path');
        }
        if (contained.reason === 'symlink-escape') {
          getLog().warn({ codebaseId: id, path: rawPath }, 'codebase_files.symlink_escape_blocked');
          return apiError(c, 404, 'Directory not found');
        }
        if (contained.reason === 'missing') {
          return apiError(c, 404, 'Directory not found');
        }
        getLog().error(
          { err: contained.err, codebaseId: id, path: rawPath },
          'codebase_files.list_failed'
        );
        return apiError(c, 500, 'Failed to list directory');
      }

      const dirents = await readdir(contained.realPath, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map(async dirent => {
          // A symlink's own dirent says nothing about what it points at, so the
          // kind comes from stat — which follows it. A broken link stats ENOENT
          // and is reported as 'other' rather than removed from the listing:
          // it is on disk, and pretending otherwise is the same lie as filtering.
          let kind: 'file' | 'dir' | 'other';
          let size: number | null = null;
          if (dirent.isDirectory()) {
            kind = 'dir';
          } else if (dirent.isFile()) {
            kind = 'file';
          } else {
            kind = 'other';
          }
          try {
            const info = await stat(join(contained.realPath, dirent.name));
            kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other';
            size = info.isFile() ? info.size : null;
          } catch {
            // Broken symlink, or a file that vanished between readdir and stat.
            // Neither is an error worth failing the whole listing over.
          }
          return { name: dirent.name, kind, size };
        })
      );

      // Directories first, then files, each case-insensitively by name — the
      // order every file tree uses, so the list reads without being scanned.
      entries.sort((a, b) => {
        if (a.kind !== b.kind) {
          if (a.kind === 'dir') return -1;
          if (b.kind === 'dir') return 1;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      return c.json({ path: contained.relative, entries });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return apiError(c, 400, 'Not a directory');
      }
      getLog().error({ err: error, codebaseId: id }, 'codebase_files.list_failed');
      return apiError(c, 500, 'Failed to list directory');
    }
  });

  registerOpenApiRoute(readCodebaseFileRoute, async c => {
    const id = c.req.param('id') ?? '';
    const rawPath = c.req.query('path') ?? '';
    try {
      if (rawPath === '') {
        return apiError(c, 400, 'Invalid path');
      }
      const root = await codebaseRoot(id);
      if (root === null) {
        return apiError(c, 404, 'Codebase not found');
      }

      const contained = await resolveContainedPath(root, rawPath);
      if (!contained.ok) {
        if (contained.reason === 'invalid' || contained.reason === 'escaped') {
          getLog().warn({ codebaseId: id, path: rawPath }, 'codebase_files.path_escape_blocked');
          return apiError(c, 400, 'Invalid path');
        }
        if (contained.reason === 'symlink-escape') {
          getLog().warn({ codebaseId: id, path: rawPath }, 'codebase_files.symlink_escape_blocked');
          return apiError(c, 404, 'File not found');
        }
        if (contained.reason === 'missing') {
          return apiError(c, 404, 'File not found');
        }
        getLog().error(
          { err: contained.err, codebaseId: id, path: rawPath },
          'codebase_files.read_failed'
        );
        return apiError(c, 500, 'Failed to read file');
      }

      const info = await stat(contained.realPath);
      if (info.isDirectory()) {
        return apiError(c, 400, 'Path is a directory');
      }
      if (!info.isFile()) {
        return apiError(c, 415, 'Not a regular file');
      }
      if (info.size > MAX_FILE_BYTES) {
        // Refused whole, never truncated: half a file rendered as if it were
        // the file is worse than being told the file is too big to show.
        return apiError(
          c,
          413,
          `File is ${String(info.size)} bytes; the viewer shows files up to ${String(MAX_FILE_BYTES)}`
        );
      }

      const buffer = await readFile(contained.realPath);
      // A NUL byte is the practical binary tell, and it is the byte that would
      // corrupt a JSON string body. Checked over the whole buffer rather than a
      // prefix — the file is already bounded by MAX_FILE_BYTES.
      if (buffer.includes(0)) {
        return apiError(c, 415, 'Binary file — not shown');
      }

      // File CONTENTS are never logged, here or in any branch above.
      return c.json({
        path: contained.relative,
        content: buffer.toString('utf-8'),
        size: info.size,
        etag: fileEtag(buffer),
      });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'codebase_files.read_failed');
      return apiError(c, 500, 'Failed to read file');
    }
  });

  /**
   * Raw bytes, for images the viewer shows inline.
   *
   * NOT an OpenAPI route: the body is bytes, not JSON, so there is nothing for
   * the generated client types to describe. The browser consumes this as an
   * `<img src>`, never as a typed fetch.
   *
   * ONLY RASTER IMAGES. The content type is chosen from a fixed allow-list, so
   * a file in the repo can never dictate what this route claims to be serving.
   * SVG is deliberately absent: it is a script-bearing document, and serving it
   * from this origin would let a repo file run with the console's cookies. SVG
   * is text, so it opens in the editor like any other source file.
   */
  const IMAGE_TYPES: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };
  /** Images are bigger than source. Separate from MAX_FILE_BYTES on purpose. */
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  app.get('/api/codebases/:id/raw', async c => {
    const id = c.req.param('id');
    const rawPath = c.req.query('path') ?? '';
    try {
      if (rawPath === '') {
        return apiError(c, 400, 'Invalid path');
      }
      const extension = rawPath.slice(rawPath.lastIndexOf('.') + 1).toLowerCase();
      const contentType = IMAGE_TYPES[extension];
      if (contentType === undefined) {
        // Refused by TYPE before the file is even resolved: this route exists
        // for images, and an allow-list that is consulted first cannot be
        // talked into serving something else.
        return apiError(c, 415, 'Not an image this route serves');
      }

      const root = await codebaseRoot(id);
      if (root === null) {
        return apiError(c, 404, 'Codebase not found');
      }

      const contained = await resolveContainedPath(root, rawPath);
      if (!contained.ok) {
        if (contained.reason === 'invalid' || contained.reason === 'escaped') {
          getLog().warn({ codebaseId: id, path: rawPath }, 'codebase_files.path_escape_blocked');
          return apiError(c, 400, 'Invalid path');
        }
        if (contained.reason === 'symlink-escape') {
          getLog().warn({ codebaseId: id, path: rawPath }, 'codebase_files.symlink_escape_blocked');
          return apiError(c, 404, 'File not found');
        }
        if (contained.reason === 'missing') {
          return apiError(c, 404, 'File not found');
        }
        getLog().error(
          { err: contained.err, codebaseId: id, path: rawPath },
          'codebase_files.raw_failed'
        );
        return apiError(c, 500, 'Failed to read file');
      }

      const info = await stat(contained.realPath);
      if (!info.isFile()) {
        return apiError(c, 404, 'File not found');
      }
      if (info.size > MAX_IMAGE_BYTES) {
        return apiError(c, 413, `Image is ${String(info.size)} bytes; the limit is 10 MB`);
      }

      const bytes = await readFile(contained.realPath);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          // The browser must not re-sniff a type we chose deliberately.
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline',
          // A checkout changes under live runs; a cached image would show the
          // file as it was rather than as it is.
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'codebase_files.raw_failed');
      return apiError(c, 500, 'Failed to read file');
    }
  });

  registerOpenApiRoute(writeCodebaseFileRoute, async c => {
    const id = c.req.param('id') ?? '';
    const rawPath = c.req.query('path') ?? '';
    try {
      const body = await c.req.json<{ content?: unknown; etag?: unknown }>();
      const content = body.content;
      const etag = body.etag;
      if (typeof content !== 'string' || typeof etag !== 'string' || etag === '') {
        return apiError(c, 400, 'content and etag are required');
      }
      if (rawPath === '') {
        return apiError(c, 400, 'Invalid path');
      }

      const root = await codebaseRoot(id);
      if (root === null) {
        return apiError(c, 404, 'Codebase not found');
      }

      const contained = await resolveContainedPath(root, rawPath);
      if (!contained.ok) {
        if (contained.reason === 'invalid' || contained.reason === 'escaped') {
          getLog().warn({ codebaseId: id, path: rawPath }, 'codebase_files.path_escape_blocked');
          return apiError(c, 400, 'Invalid path');
        }
        if (contained.reason === 'symlink-escape') {
          getLog().warn({ codebaseId: id, path: rawPath }, 'codebase_files.symlink_escape_blocked');
          return apiError(c, 404, 'File not found');
        }
        if (contained.reason === 'missing') {
          // This endpoint edits files that exist. Creating one is a different
          // decision - a new path has no version to conflict with, so the
          // safety this route is built around would not apply to it.
          return apiError(c, 404, 'File not found');
        }
        getLog().error(
          { err: contained.err, codebaseId: id, path: rawPath },
          'codebase_files.write_failed'
        );
        return apiError(c, 500, 'Failed to write file');
      }

      const info = await stat(contained.realPath);
      if (!info.isFile()) {
        return apiError(c, 400, 'Not a regular file');
      }
      const incoming = Buffer.from(content, 'utf-8');
      if (incoming.byteLength > MAX_FILE_BYTES) {
        return apiError(
          c,
          413,
          `File is ${String(incoming.byteLength)} bytes; the limit is ${String(MAX_FILE_BYTES)}`
        );
      }
      if (incoming.includes(0)) {
        return apiError(c, 415, 'Binary content is not accepted on this route');
      }

      // THE CONFLICT CHECK. Read what is on disk NOW and compare it to the
      // version this edit started from. A run rewriting the file between the
      // read and this save is the ordinary case on this box, not an exotic
      // one, and without this the save would silently discard that work.
      const current = await readFile(contained.realPath);
      const currentEtag = fileEtag(current);
      if (currentEtag !== etag) {
        return apiError(
          c,
          409,
          'This file changed on disk since you opened it. Reload to see the current version.'
        );
      }

      // Write to a temp file in the SAME directory, then rename. rename(2) is
      // atomic within a filesystem, so a reader - or a crash - sees either the
      // old file or the new one, never a half-written source file. A temp file
      // elsewhere would make the rename a cross-device copy and lose that.
      const temp = join(dirname(contained.realPath), `.archon-write-${randomUUID()}`);
      try {
        await writeFile(temp, incoming, { mode: info.mode & 0o777 });
        await rename(temp, contained.realPath);
      } catch (err) {
        await unlink(temp).catch(() => undefined);
        throw err;
      }

      return c.json({
        path: contained.relative,
        size: incoming.byteLength,
        etag: fileEtag(incoming),
      });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'codebase_files.write_failed');
      return apiError(c, 500, 'Failed to write file');
    }
  });

  registerOpenApiRoute(getCodebaseRoute, async c => {
    try {
      const codebase = await codebaseDb.getCodebase(c.req.param('id') ?? '');
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }
      return c.json(toApiCodebase(codebase));
    } catch (error) {
      getLog().error({ err: error }, 'get_codebase_failed');
      return apiError(c, 500, 'Failed to get codebase');
    }
  });

  // POST /api/codebases - Add a project (clone from URL or register local path)
  registerOpenApiRoute(addCodebaseRoute, async c => {
    const body = getValidatedBody(c, addCodebaseBodySchema);

    try {
      // .refine() guarantees exactly one of url/path is present.
      // For a local path, detect git-ness: a non-git directory registers as a
      // folder project (kind: 'folder') instead of being rejected. Folder-ness
      // is detected here, not declared in the request body, so the web form
      // needs no new field.
      let result;
      if (body.url) {
        result = await cloneRepository(body.url);
      } else {
        const localPath = body.path ?? '';
        // Detect git-ness. A resolvable repo root → register as a repo project;
        // a definitive null ("not a git repository") → folder project. A THROW
        // is ambiguous: findRepoRoot throws both for a nonexistent path (benign
        // — fall through so registerFolder's own existence check produces the
        // clean error) and for a genuine git failure (git missing, timeout,
        // permission) on a path that DOES exist. The latter must NOT register:
        // it would permanently misclassify a real repo as kind:'folder'.
        let repoRoot: string | null = null;
        try {
          repoRoot = await findRepoRoot(localPath);
        } catch (err) {
          getLog().warn({ err, path: localPath }, 'api.add_codebase_repo_detect_failed');
          if (existsSync(localPath)) {
            return apiError(
              c,
              500,
              'Could not determine whether the path is a git repository (git failed — is git installed and the path readable?). Nothing was registered; retry once the underlying issue is resolved.'
            );
          }
        }
        result = repoRoot ? await registerRepository(localPath) : await registerFolder(localPath);
      }

      // Fetch the full codebase record for a consistent response
      const codebase = await codebaseDb.getCodebase(result.codebaseId);
      if (!codebase) {
        return apiError(c, 500, 'Codebase created but not found');
      }

      return c.json(toApiCodebase(codebase), result.alreadyExisted ? 200 : 201);
    } catch (error) {
      getLog().error({ err: error }, 'add_codebase_failed');
      return apiError(
        c,
        500,
        `Failed to add codebase: ${(error as Error).message ?? 'unknown error'}`
      );
    }
  });

  // DELETE /api/codebases/:id - Delete a project and clean up
  // PATCH /api/codebases/:id - correct the recorded remote
  registerOpenApiRoute(updateCodebaseRoute, async c => {
    const id = c.req.param('id') ?? '';
    const body = getValidatedBody(c, updateCodebaseBodySchema);

    try {
      if ((await codebaseDb.getCodebase(id)) === null) {
        return apiError(c, 404, 'Codebase not found');
      }

      // `.refine()` guarantees the key is present, so `undefined` cannot reach
      // `updateCodebase` — which is what keeps "not supplied" and "set to
      // null" distinguishable all the way down.
      await codebaseDb.updateCodebase(id, { repository_url: body.repository_url ?? null });

      const updated = await codebaseDb.getCodebase(id);
      if (updated === null) return apiError(c, 404, 'Codebase not found');
      return c.json(toApiCodebase(updated));
    } catch (error) {
      if (error instanceof codebaseDb.CodebaseNotFoundError) {
        return apiError(c, 404, 'Codebase not found');
      }
      getLog().error({ err: error, codebaseId: id }, 'update_codebase_failed');
      return apiError(c, 500, 'Failed to update codebase');
    }
  });

  registerOpenApiRoute(deleteCodebaseRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }

      // Clean up isolation environments (worktrees)
      const environments = await isolationEnvDb.listByCodebase(id);
      for (const env of environments) {
        try {
          await removeWorktree(toRepoPath(codebase.default_cwd), toWorktreePath(env.working_path));
          getLog().info({ path: env.working_path }, 'worktree_removed');
        } catch (wtErr) {
          // Worktree may already be gone — log but continue
          getLog().warn({ err: wtErr, path: env.working_path }, 'worktree_remove_failed');
        }
        await isolationEnvDb.updateStatus(env.id, 'destroyed');
      }

      // Delete from database (unlinks conversations and sessions)
      await codebaseDb.deleteCodebase(id);

      // Remove workspace directory from disk — only for Archon-managed repos
      const normalizedCwd = normalize(codebase.default_cwd);
      if (isInsideArchonWorkspaces(normalizedCwd)) {
        try {
          await rm(normalizedCwd, { recursive: true, force: true });
          getLog().info({ path: normalizedCwd }, 'workspace_removed');
        } catch (rmErr) {
          // Directory may not exist — log but don't fail
          getLog().warn({ err: rmErr, path: codebase.default_cwd }, 'workspace_remove_failed');
        }
      } else {
        getLog().info({ path: codebase.default_cwd }, 'external_repo_skip_deletion');
      }

      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error }, 'delete_codebase_failed');
      return apiError(c, 500, 'Failed to delete codebase');
    }
  });

  // GET /api/codebases/:id/env - List env var keys for a codebase (values never returned)
  registerOpenApiRoute(listEnvVarsRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      const envVars = await envVarDb.getCodebaseEnvVars(id);
      return c.json({ keys: Object.keys(envVars) });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'list_env_vars_failed');
      return apiError(c, 500, 'Failed to list env vars');
    }
  });

  // PUT /api/codebases/:id/env - Set (upsert) an env var
  registerOpenApiRoute(setEnvVarRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const body = getValidatedBody(c, setEnvVarBodySchema);
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      await envVarDb.setCodebaseEnvVar(id, body.key, body.value);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'set_env_var_failed');
      return apiError(c, 500, 'Failed to set env var');
    }
  });

  // DELETE /api/codebases/:id/env/:key - Delete an env var
  registerOpenApiRoute(deleteEnvVarRoute, async c => {
    const id = c.req.param('id') ?? '';
    const key = c.req.param('key') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      await envVarDb.deleteCodebaseEnvVar(id, key);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id, key }, 'delete_env_var_failed');
      return apiError(c, 500, 'Failed to delete env var');
    }
  });

  /**
   * Register a route with OpenAPI spec generation and input validation.
   * Zod validates inputs (query, params, body) at runtime via defaultHook.
   * Response schemas are used for OpenAPI spec generation only — output is not
   * validated at runtime. The `as never` cast bypasses TypedResponse constraints.
   */
  function registerOpenApiRoute(
    route: ReturnType<typeof createRoute>,
    handler: (c: Context) => Response | Promise<Response>
  ): void {
    app.openapi(route, handler as never);
  }

  /** Access Zod-validated body from a handler registered via registerOpenApiRoute. */
  function getValidatedBody<T>(c: Context, _schema: z.ZodType<T>): T {
    return (c.req as unknown as { valid(k: 'json'): T }).valid('json');
  }

  // Serve OpenAPI spec
  app.doc('/api/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Archon API', version: '1.0.0' },
  });

  // =========================================================================
  // Workflow endpoints
  // =========================================================================

  // GET /api/slash-commands - Slash commands + discovered workflows for the composer's `/` menu.
  // Every entry derives from the command registry the chat dispatch narrows to,
  // so the menu cannot miss a command the chat answers.
  registerOpenApiRoute(getSlashCommandsRoute, async c => {
    const codebaseId = c.req.query('codebaseId');
    try {
      let workingDir: string | null = null;
      if (codebaseId !== undefined) {
        const codebase = await codebaseDb.getCodebase(codebaseId);
        if (codebase === null) return apiError(c, 404, 'Project not found');
        workingDir = codebase.default_cwd;
      }

      const commands = SLASH_COMMANDS.flatMap((spec: SlashCommandSpec) => [
        { command: `/${spec.name}`, args: spec.args, description: spec.description },
        ...(spec.subcommands ?? []).map(sub => ({
          command: `/${spec.name} ${sub.name}`,
          args: sub.args,
          description: sub.description,
        })),
      ]);

      const { workflows } = await discoverWorkflowsWithConfig(workingDir, loadConfig);
      return c.json({
        commands,
        workflows: workflows.map(({ workflow }) => ({
          name: workflow.name,
          summary: firstLine(workflow.description),
        })),
      });
    } catch (error) {
      getLog().error({ err: error, codebaseId }, 'commands.list_failed');
      return apiError(c, 500, 'Failed to list commands');
    }
  });

  // GET /api/workflows - Discover available workflows
  registerOpenApiRoute(getWorkflowsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir: string | undefined = cwd;

      // Validate caller-supplied cwd against registered codebase paths
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        // Fallback to first codebase's default_cwd
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) {
          workingDir = codebases[0].default_cwd;
        }
      }

      // No project context (no cwd query param and no registered codebases) —
      // pass null to discovery so it returns bundled + home-scoped workflows.
      // This avoids a misleading empty state on first run, before any project
      // is registered, when bundled defaults are present
      const result = await discoverWorkflowsWithConfig(workingDir ?? null, loadConfig);

      // Resolve repo-owner-curated recommended list (per-project only).
      // Filter to names present in the discovered set; preserve declared order.
      // Stale names are silently ignored (advisory).
      const recommended: string[] = [];
      if (workingDir) {
        const repoConfig = await loadRepoConfig(workingDir);
        const declared = repoConfig.recommendedWorkflows ?? [];
        if (declared.length > 0) {
          const discoveredNames = new Set(result.workflows.map(ws => ws.workflow.name));
          const seen = new Set<string>();
          for (const name of declared) {
            if (discoveredNames.has(name) && !seen.has(name)) {
              recommended.push(name);
              seen.add(name);
            } else if (!discoveredNames.has(name)) {
              getLog().debug({ workingDir, name }, 'workflows.recommended_workflow_not_found');
            }
          }
        }
      }

      return c.json({
        workflows: result.workflows.map(ws => ({
          // Display shows what the AUTHOR wrote. Composition collapses workflow-level
          // node config onto the nodes and removes it (#1764), so the declared values are
          // layered back over the definition for this listing only — the console reads
          // `workflow.provider` to label a card, and execution never reads this response.
          workflow: Object.assign({}, ws.workflow, ws.declared),
          source: ws.source,
          // Keys the engine dropped from this YAML (#2213) — the console is the
          // surface most authors edit workflows on, so it has to carry them.
          ...(ws.parseWarnings && ws.parseWarnings.length > 0
            ? { parseWarnings: [...ws.parseWarnings] }
            : {}),
        })),
        recommended,
        errors: result.errors.length > 0 ? result.errors : undefined,
      });
    } catch (error) {
      // Workflow discovery can fail if cwd is stale or deleted — return empty with warning
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow_discovery_failed');
      return apiError(c, 500, `Workflow discovery failed: ${err.message}`);
    }
  });

  // POST /api/workflows/:name/run - Run a workflow via the orchestrator
  //
  // Accepts either:
  //   - application/json: { conversationId, message, inputs?, tiers?, aliases? }
  //   - multipart/form-data: those maps JSON-encoded + files[] (≤5, ≤10MB each)
  //
  // Multipart matches /api/conversations/:id/message so the console's draft
  // run input can attach screenshots / stack traces / paste-blobs the same
  // way a freeform chat message can.
  registerOpenApiRoute(runWorkflowRoute, async c => {
    const workflowName = c.req.param('name') ?? '';
    const userId = await resolveWebUserId(c);
    if (!isValidWorkflowName(workflowName)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    let message: string;
    let conversationId: string;
    let workflowInputs: Record<string, string> | undefined;
    let workflowModelOverrides: RunModelOverrides | undefined;
    let workflowRunConfig: WorkflowRunConfigInput | undefined;
    // Between-run continuation (#2747): run-id only — no name-based newest-wins.
    let adoptRunId: string | undefined;
    let supersedesRunId: string | undefined;
    let savedFiles: AttachedFile[] = [];
    let uploadDir = '';

    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      let body: Record<string, string | File | (string | File)[]>;
      try {
        body = await c.req.parseBody({ all: true });
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr }, 'run_workflow.multipart_parse_failed');
        return apiError(c, 400, 'Invalid multipart form data');
      }

      const rawMessage = body.message;
      const rawConv = body.conversationId;
      if (typeof rawMessage !== 'string' || !rawMessage) {
        return apiError(c, 400, 'message must be a non-empty string');
      }
      if (typeof rawConv !== 'string' || !rawConv || !/^[\w-]+$/.test(rawConv)) {
        return apiError(c, 400, 'conversationId must be a non-empty alphanumeric string');
      }
      message = rawMessage;
      conversationId = rawConv;

      if (body.configPath !== undefined) {
        return apiError(c, 400, 'configPath is not supported; send validated config content');
      }

      // Declared inputs (#2554). A form field can only be a string, so the map travels
      // JSON-encoded. A malformed field is refused rather than ignored — silently
      // dropping it would start the run without the values the caller thought it sent.
      const rawInputs = body.inputs;
      if (rawInputs !== undefined) {
        if (typeof rawInputs !== 'string') {
          return apiError(c, 400, 'inputs must be a JSON-encoded object of string values');
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(rawInputs);
        } catch (parseErr: unknown) {
          getLog().warn({ err: parseErr, workflowName }, 'run_workflow.inputs_parse_failed');
          return apiError(c, 400, 'inputs must be a JSON-encoded object of string values');
        }
        const parsed = parseRunInputsField(decoded);
        if (!parsed.ok) return apiError(c, 400, parsed.error);
        workflowInputs = parsed.inputs;
      }

      const decodeObjectField = (
        raw: string | File | (string | File)[] | undefined,
        label: 'tiers' | 'aliases'
      ): { ok: true; value?: unknown } | { ok: false; error: string } => {
        if (raw === undefined) return { ok: true };
        if (typeof raw !== 'string') {
          return { ok: false, error: `${label} must be a JSON-encoded object` };
        }
        try {
          return { ok: true, value: JSON.parse(raw) as unknown };
        } catch (parseErr: unknown) {
          getLog().warn(
            { err: parseErr, workflowName, field: label },
            'run_workflow.model_overrides_parse_failed'
          );
          return { ok: false, error: `${label} must be a JSON-encoded object` };
        }
      };
      const decodedTiers = decodeObjectField(body.tiers, 'tiers');
      if (!decodedTiers.ok) return apiError(c, 400, decodedTiers.error);
      const decodedAliases = decodeObjectField(body.aliases, 'aliases');
      if (!decodedAliases.ok) return apiError(c, 400, decodedAliases.error);
      const parsedOverrides = parseRunModelOverridesFields(
        decodedTiers.value,
        decodedAliases.value
      );
      if (!parsedOverrides.ok) return apiError(c, 400, parsedOverrides.error);
      workflowModelOverrides = parsedOverrides.overrides;

      if (body.config !== undefined) {
        if (typeof body.config !== 'string') {
          return apiError(c, 400, 'config must be a JSON-encoded object');
        }
        let decodedConfig: unknown;
        try {
          decodedConfig = JSON.parse(body.config) as unknown;
        } catch (parseErr: unknown) {
          getLog().warn({ err: parseErr, workflowName }, 'run_workflow.config_parse_failed');
          return apiError(c, 400, 'config must be a JSON-encoded object');
        }
        try {
          workflowRunConfig = parseWorkflowRunConfig(decodedConfig, {
            kind: 'http',
            label: 'inline',
          });
        } catch (error) {
          return apiError(c, 400, (error as Error).message);
        }
      }

      const rawFiles = body.files;
      const fileList: (string | File)[] = Array.isArray(rawFiles)
        ? rawFiles
        : rawFiles !== undefined
          ? [rawFiles]
          : [];
      const fileEntries = fileList.filter((e): e is File => e instanceof File);

      if (fileEntries.length > 0) {
        const result = await persistUploadedFiles(conversationId, fileEntries);
        if (!result.ok) {
          return apiError(c, result.status, result.error);
        }
        savedFiles = result.savedFiles;
        uploadDir = result.uploadDir;
        getLog().info(
          { conversationId, fileCount: savedFiles.length, workflowName },
          'run_workflow.files_uploaded'
        );
      }
    } else {
      let body: {
        conversationId?: unknown;
        message?: unknown;
        inputs?: unknown;
        tiers?: unknown;
        aliases?: unknown;
        config?: unknown;
        configPath?: unknown;
        adopt_run_id?: unknown;
        supersedes_run_id?: unknown;
      };
      try {
        body = await c.req.json();
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr }, 'run_workflow.json_parse_failed');
        return apiError(c, 400, 'Invalid JSON in request body');
      }
      if (typeof body.conversationId !== 'string' || !body.conversationId) {
        return apiError(c, 400, 'conversationId must be a non-empty string');
      }
      if (typeof body.message !== 'string' || !body.message) {
        return apiError(c, 400, 'message must be a non-empty string');
      }
      if (body.configPath !== undefined) {
        return apiError(c, 400, 'configPath is not supported; send validated config content');
      }
      const parsed = parseRunInputsField(body.inputs);
      if (!parsed.ok) return apiError(c, 400, parsed.error);
      workflowInputs = parsed.inputs;
      for (const [field, target] of [
        ['adopt_run_id', 'adopt'],
        ['supersedes_run_id', 'supersede'],
      ] as const) {
        const raw = body[field];
        if (raw === undefined) continue;
        if (typeof raw !== 'string' || !raw) {
          return apiError(c, 400, `${field} must be a non-empty run id`);
        }
        if (target === 'adopt') adoptRunId = raw;
        else supersedesRunId = raw;
      }
      if (adoptRunId && supersedesRunId) {
        return apiError(c, 400, 'adopt_run_id and supersedes_run_id are mutually exclusive');
      }
      const parsedOverrides = parseRunModelOverridesFields(body.tiers, body.aliases);
      if (!parsedOverrides.ok) return apiError(c, 400, parsedOverrides.error);
      workflowModelOverrides = parsedOverrides.overrides;
      if (body.config !== undefined) {
        try {
          workflowRunConfig = parseWorkflowRunConfig(body.config, {
            kind: 'http',
            label: 'inline',
          });
        } catch (error) {
          return apiError(c, 400, (error as Error).message);
        }
      }
      conversationId = body.conversationId;
      message = body.message;
    }

    try {
      // Persist user message and register DB ID (same as message endpoint).
      // File metadata (name/mime/size — no path, since the on-disk file is
      // ephemeral) goes into message metadata when present.
      let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
      try {
        conv = await conversationDb.findConversationByPlatformId(conversationId);
      } catch (e: unknown) {
        getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
      }
      if (conv) {
        try {
          const meta =
            savedFiles.length > 0
              ? {
                  files: savedFiles.map(f => ({
                    name: f.name,
                    mimeType: f.mimeType,
                    size: f.size,
                  })),
                }
              : undefined;
          await messageDb.addMessage(conv.id, 'user', message, meta, userId);
        } catch (e: unknown) {
          getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
        }
        webAdapter.setConversationDbId(conversationId, conv.id);
        if (!conv.title) {
          // Resolve the `small` tier (config tiers + per-user prefs) instead of the raw
          // assistant default (#1855). Both calls never throw.
          void resolveTitleRequest(conv.ai_assistant_type, userId).then(titleRequest =>
            generateAndSetTitle(
              conv.id,
              message,
              titleRequest.provider,
              getArchonWorkspacesPath(),
              workflowName,
              titleRequest.options.assistantConfig,
              titleRequest.options
            )
          );
        }
      }

      // Declared inputs ride the context, never `fullMessage` — encoding them into the
      // command string would make a supplied value indistinguishable from $ARGUMENTS
      // and would amount to inventing a chat grammar as a side effect (#2554/#2555).
      const fullMessage = `/workflow run ${workflowName} ${message}`;
      const extraContext: Omit<HandleMessageContext, 'isolationHints'> = {
        userId,
        ...(savedFiles.length > 0 ? { attachedFiles: savedFiles } : {}),
        ...(workflowInputs ? { workflowInputs } : {}),
        ...(workflowModelOverrides ? { workflowModelOverrides } : {}),
        ...(workflowRunConfig ? { workflowRunConfig } : {}),
        ...(adoptRunId ? { workflowAdoptRunId: adoptRunId } : {}),
        ...(supersedesRunId ? { workflowSupersedesRunId: supersedesRunId } : {}),
      };
      const filesToCleanup = savedFiles.length > 0 ? { files: savedFiles, uploadDir } : undefined;
      const result = await dispatchToOrchestrator(
        conversationId,
        fullMessage,
        extraContext,
        filesToCleanup
      );
      if (!result.accepted) return apiError(c, 503, DRAIN_REFUSAL_NOTICE);
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'run_workflow_failed');
      return apiError(c, 500, 'Failed to run workflow');
    }
  });

  // GET /api/dashboard/runs - Enriched workflow runs for Command Center
  // Supports server-side search, status/date filtering, and offset pagination.
  registerOpenApiRoute(getDashboardRunsRoute, async c => {
    try {
      const rawStatus = c.req.query('status');
      const validStatuses = workflowRunStatusSchema.options;
      type DashboardRunStatus = (typeof validStatuses)[number];
      const status: DashboardRunStatus | undefined =
        rawStatus && (validStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as DashboardRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const parentConversationId = c.req.query('parentConversationId') ?? undefined;
      const search = c.req.query('search')?.trim() || undefined;
      const after = c.req.query('after') ?? undefined;
      const before = c.req.query('before') ?? undefined;
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);
      const offsetRaw = Number(c.req.query('offset'));
      const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

      const result = await workflowDb.listDashboardRuns({
        status,
        codebaseId,
        parentConversationId,
        search,
        after,
        before,
        limit,
        offset,
      });
      return c.json({
        ...result,
        runs: result.runs.map(toApiDashboardWorkflowRun),
      });
    } catch (error) {
      getLog().error({ err: error }, 'list_dashboard_runs_failed');
      return apiError(c, 500, 'Failed to list dashboard runs');
    }
  });

  // POST /api/workflows/runs/:runId/cancel - Cancel a workflow run through the shared
  // owner-checked cancel: cooperative for a run this server executes, an owner stop for
  // one another process owns, and a 409 refusal when no owner answers.
  registerOpenApiRoute(cancelWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const result = await cancelWorkflow(runId);
      if (result.kind === 'cooperative') {
        return c.json({
          success: true,
          message: result.cancelled
            ? `Cancelled workflow: ${run.workflow_name}`
            : `Workflow ${run.workflow_name} already finished — nothing to cancel.`,
        });
      }
      let message = `Stopped the run's live owner process (pid ${String(result.pid)}), then cancelled workflow: ${run.workflow_name}`;
      if (result.cascadeFailures > 0) {
        message += ` — warning: ${String(result.cascadeFailures)} sub-run(s) could not be cancelled and may still be running`;
      }
      if (result.blockedParentRunId) {
        message += ` — parent run ${result.blockedParentRunId} was blocked on this sub-run and stays paused; resume it to fail the node cleanly or abandon it too`;
      }
      return c.json({ success: true, message });
    } catch (error) {
      if (error instanceof CancelRefusedError) {
        return apiError(c, error.reason === 'not_running' ? 400 : 409, error.message);
      }
      getLog().error({ err: error, runId }, 'cancel_workflow_run_api_failed');
      return apiError(c, 500, 'Failed to cancel workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/resume - Resume a workflow run
  registerOpenApiRoute(resumeWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(c, 400, `Cannot resume workflow in '${run.status}' status`);
      }
      // Covers both branches below: the headless execution bypasses the conversation
      // lock entirely, so nothing else would refuse it. The run keeps its current
      // status — drain starts no work and finishes none.
      if (lockManager.isDraining()) {
        return apiError(c, 503, DRAIN_REFUSAL_NOTICE);
      }
      // Dispatch resume by sending `/workflow resume <id>` to the parent web
      // conversation; the command handler validates the run and hands the
      // orchestrator a resume request carrying that run. Explicit targeting (not
      // a bare `/workflow run <name>`) so a genuinely-failed run resumes
      // directly instead of hitting the disambiguation prompt (#2075).
      // Mirrors the approve/reject auto-resume path.
      if (!run.parent_conversation_id) {
        // No parent conversation to dispatch a chat message through at all —
        // every CLI-launched run (#2008). Execute directly instead of 400ing.
        const headlessResumed = await resumeWorkflowRunFromServer(run, await resolveWebUserId(c));
        if (!headlessResumed) {
          return apiError(
            c,
            400,
            `This run was created outside the web UI. Use \`archon workflow resume ${runId}\` from the CLI to resume it.`
          );
        }
        getLog().info(
          { runId, workflowName: run.workflow_name },
          'api.workflow_run_resume_headless_dispatched'
        );
        return c.json({
          success: true,
          message: `Resuming workflow: ${run.workflow_name}`,
        });
      }
      const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
      if (!parentConv?.platform_conversation_id || parentConv.platform_type !== 'web') {
        return apiError(
          c,
          400,
          `Cannot resume from web UI: the run's parent conversation is not a web conversation. Use \`archon workflow resume ${runId}\` from the CLI.`
        );
      }
      const resumeMessage = `/workflow resume ${run.id}`;
      // Resume executes as the user who clicked resume (sender-first, #1982),
      // not the conversation creator. Undefined on solo installs → fallback.
      const dispatched = await dispatchToOrchestrator(
        parentConv.platform_conversation_id,
        resumeMessage,
        { userId: await resolveWebUserId(c) }
      );
      if (!dispatched.accepted) {
        // Drain can begin between the entry guard above and this dispatch.
        return apiError(c, 503, DRAIN_REFUSAL_NOTICE);
      }
      getLog().info(
        {
          runId,
          workflowName: run.workflow_name,
          platformConvId: parentConv.platform_conversation_id,
        },
        'api.workflow_run_resume_dispatched'
      );
      return c.json({
        success: true,
        message: `Resuming workflow: ${run.workflow_name}`,
      });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_resume_failed');
      return apiError(c, 500, 'Failed to resume workflow run');
    }
  });

  registerOpenApiRoute(signalWorkflowWaitRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    const { event, resumeAt, payload } = getValidatedBody(c, signalWorkflowWaitBodySchema);
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return apiError(c, 404, 'Workflow run not found');
      const wait = isWorkflowWaitContext(run.metadata?.wait) ? run.metadata.wait : undefined;
      if (wait?.kind !== 'event' || wait.event !== event || wait.resumeAt !== resumeAt) {
        return apiError(c, 400, `Run is not waiting on event '${event}'`);
      }
      const { signaled } = await workflowDb.signalWorkflowWait(runId, wait, payload);
      if (!signaled) {
        return apiError(c, 400, `Run is not waiting on event '${event}'`);
      }
      return c.json({
        success: true,
        message: `Signaled '${event}'. The workflow will resume shortly.`,
      });
    } catch (error) {
      getLog().error({ err: error, runId, event }, 'signal_workflow_wait_api_failed');
      return apiError(c, 500, 'Failed to signal workflow wait');
    }
  });

  // POST /api/workflows/runs/:runId/abandon - Abandon a workflow run
  registerOpenApiRoute(abandonWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      // A `failed` run is terminal per TERMINAL_WORKFLOW_STATUSES but remains
      // resumable, so the user must be able to discard it — only the two
      // non-resumable terminal states are blocked (the 400 mapping lives here;
      // abandonWorkflow re-validates).
      if (run.status === 'completed' || run.status === 'cancelled') {
        return apiError(
          c,
          400,
          `Cannot abandon run with status '${run.status}'. Only running, paused, or failed runs can be abandoned.`
        );
      }
      // Delegate to the SHARED op — a raw cancelWorkflowRun here previously skipped
      // the sub-run cascade cancel AND the container reclaim (M2), so a web abandon
      // orphaned children that CLI/chat abandons cleaned up.
      const { cascadeFailures, blockedParentRunId, owner } = await abandonWorkflow(runId);
      let message = `${describeAbandonOwner(owner).join(' ')} Abandoned workflow: ${run.workflow_name}`;
      if (cascadeFailures > 0) {
        message += ` — warning: ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running`;
      }
      if (blockedParentRunId) {
        message += ` — parent run ${blockedParentRunId} was blocked on this sub-run and stays paused; resume it to fail the node cleanly or abandon it too`;
      }
      return c.json({ success: true, message });
    } catch (error) {
      if (error instanceof AbandonOwnerNotStoppedError) {
        return apiError(c, 409, error.message);
      }
      getLog().error({ err: error, runId }, 'api.workflow_run_abandon_failed');
      return apiError(c, 500, 'Failed to abandon workflow run');
    }
  });

  /**
   * The approve / reject / respond routes' shared precondition, expressed as one
   * `runAttention` read mapped to this surface's 400s. Returns null when the route may
   * go on to resolve the gate.
   *
   * `requireReadableGate` mirrors the core split (`assertApprovable` vs
   * `assertRejectable`): approve refuses a run whose gate metadata cannot be read,
   * while reject and respond still resolve it — they fall back to
   * `approval?.nodeId ?? 'unknown'` for the audit event.
   *
   * The operations throw the same conclusions; mapping them here gives the console the
   * message instead of an opaque 500.
   */
  function pausedGateBlocker(
    run: WorkflowRun,
    childRedirectAdvice: string,
    requireReadableGate: boolean
  ): string | null {
    const attention = runAttention(run);
    const approvalRaw = run.metadata.approval;
    const approval = isApprovalContext(approvalRaw) ? approvalRaw : undefined;
    switch (attention?.kind) {
      case 'action_required':
        return 'Run is paused for an outside action. Complete it, then resume the run; abandon it if it should not continue.';
      case 'blocked_on_child':
        // Not an approvable gate — the parent resumes automatically when the child
        // completes. Send the caller to the run where the decision actually lives.
        return `Run is paused waiting on sub-run ${attention.childRunId}. ${childRedirectAdvice}`;
      case 'unreadable':
        if (attention.reason === 'malformed_gate') {
          return requireReadableGate ? 'Workflow run is paused but missing approval context' : null;
        }
        if (attention.reason === 'unrecognized_gate_type') {
          return `Workflow run has an unrecognized gate type '${String(approval?.type)}' — this Archon build cannot resolve it`;
        }
        return `Workflow run cannot be resolved: ${attention.detail}`;
      case undefined:
        // Post-#2075 the run stays 'paused' after a resolution, so status alone no
        // longer distinguishes "awaiting a response" from "awaiting resume".
        if (approval && isGateResolved(approval)) {
          return `Workflow run was already ${String(approval.resolved)} — resume in progress`;
        }
        // Paused with no gate at all — a durable `wait:`. There is nothing to approve.
        return requireReadableGate ? 'Workflow run is paused but missing approval context' : null;
      case 'awaiting_response':
        // The gate is open and this route may go on to resolve it.
        return null;
      case 'terminal':
        // Unreachable: every route checks `status !== 'paused'` before calling this.
        return null;
      default: {
        // Exhaustive by construction, so a fifth `RunAttention` kind becomes a compile
        // error here instead of a silently swallowed one — which is how this route
        // would reintroduce the opaque 500 the precondition exists to remove. The
        // other three consumers of the union already fail to compile the same way.
        const unreachable: never = attention;
        throw new Error(`pausedGateBlocker: unhandled attention ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // POST /api/workflows/runs/:runId/approve - Approve a paused workflow run
  registerOpenApiRoute(approveWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (run.status !== 'paused') {
        return apiError(c, 400, `Cannot approve workflow in '${run.status}' status`);
      }
      const approveBlocker = pausedGateBlocker(
        run,
        'Approve or reject the child run instead.',
        true
      );
      if (approveBlocker) {
        return apiError(c, 400, approveBlocker);
      }
      // Distinguish "no body sent" (legitimate bare approve) from "body sent but
      // unparseable" (client bug). Since #2074 a bare approve FINALIZES a
      // signal-bearing loop gate, so silently coercing a malformed body to {}
      // would discard intended feedback and finalize undiagnosed — reject it.
      const rawBody = await c.req.text();
      let body: { comment?: string } = {};
      if (rawBody.trim().length > 0) {
        try {
          body = JSON.parse(rawBody) as { comment?: string };
        } catch (parseError) {
          getLog().warn({ err: parseError, runId }, 'api.approve_body_parse_failed');
          return apiError(
            c,
            400,
            'Request body is not valid JSON — send {"comment": "..."} or no body'
          );
        }
      }
      // Shared gate logic (events, telemetry, metadata staging) — the run stays
      // 'paused' with metadata.approval.resolved = 'approved' (#2075). The
      // pre-checks above map the common error cases to 400s; approveWorkflow
      // re-validates and anything it throws past them is a 500.
      // The raw (possibly undefined) comment is passed through — approveWorkflow
      // defaults the recorded comment internally, but "no feedback" must survive
      // so a signal-bearing interactive-loop gate finalizes instead of re-running
      // (#2074, loop_feedback_given).
      await approveWorkflow(runId, body.comment);

      // Auto-resume: dispatch to the orchestrator so the workflow continues
      // without requiring the user to re-run the workflow command. Mirrors
      // what `workflowApproveCommand` does in the CLI. Requires
      // `parent_conversation_id` on the run (set by orchestrator-agent for any
      // web-dispatched workflow — foreground, interactive, and background via
      // the pre-created run) and a web-platform parent (guarded in the helper).
      const autoResumed = await tryAutoResumeAfterGate(run, 'approve', await resolveWebUserId(c));

      return c.json({
        success: true,
        message: autoResumed
          ? `Workflow approved: ${run.workflow_name}. Resuming workflow.`
          : `Workflow approved: ${run.workflow_name}. Run \`archon workflow resume ${runId}\` from the CLI to continue, or resume it from the originating conversation.`,
      });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_approve_failed');
      return apiError(c, 500, 'Failed to approve workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/reject - Reject a paused workflow run
  registerOpenApiRoute(rejectWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (run.status !== 'paused') {
        return apiError(c, 400, `Cannot reject workflow in '${run.status}' status`);
      }
      const rejectBlocker = pausedGateBlocker(
        run,
        'Reject the child run instead, or abandon this run to discard the whole tree.',
        false
      );
      if (rejectBlocker) {
        return apiError(c, 400, rejectBlocker);
      }
      // Mirror of the approve route's malformed-body guard: a swallowed parse
      // failure would silently drop the reviewer's reason.
      const rawBody = await c.req.text();
      let body: { reason?: string } = {};
      if (rawBody.trim().length > 0) {
        try {
          body = JSON.parse(rawBody) as { reason?: string };
        } catch (parseError) {
          getLog().warn({ err: parseError, runId }, 'api.reject_body_parse_failed');
          return apiError(
            c,
            400,
            'Request body is not valid JSON — send {"reason": "..."} or no body'
          );
        }
      }
      const reason = body.reason ?? 'Rejected';
      // Shared gate logic (events, telemetry, staging/cancel decision). When an
      // on_reject rework is staged the run stays 'paused' with
      // metadata.approval.resolved = 'rejected' (#2075).
      const result = await rejectWorkflow(runId, reason);

      if (result.cancelled) {
        return c.json({
          success: true,
          message: result.maxAttemptsReached
            ? `Workflow rejected and cancelled (max attempts reached): ${run.workflow_name}`
            : `Workflow rejected: ${run.workflow_name}`,
        });
      }

      // Auto-resume: dispatch to the orchestrator so the resolution actually
      // takes effect (legacy on_reject rework, or #2707 step 1's new-mode
      // structured resolution) without requiring the user to re-run the
      // workflow command. Mirrors what `workflowRejectCommand` does in the
      // CLI. Same cross-adapter guard as approve — only web parents auto-resume.
      const autoResumed = await tryAutoResumeAfterGate(run, 'reject', await resolveWebUserId(c));
      const resumeHint = `run \`archon workflow resume ${runId}\` from the CLI to trigger it`;

      return c.json({
        success: true,
        message: result.newMode
          ? autoResumed
            ? `Workflow rejected: ${run.workflow_name}. Continuing.`
            : `Workflow rejected: ${run.workflow_name}. The run will continue when it resumes — ${resumeHint}.`
          : autoResumed
            ? `Workflow rejected: ${run.workflow_name}. Running on-reject prompt.`
            : `Workflow rejected: ${run.workflow_name}. On-reject prompt will run when the run resumes — ${resumeHint}.`,
      });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_reject_failed');
      return apiError(c, 500, 'Failed to reject workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/respond - Resolve a paused workflow run with any
  // declared decision (#2707 step 2). 'approve'/'reject' produce the exact same
  // resolution as the dedicated routes above — respondToWorkflow delegates those two
  // ids to the same approveWorkflow/rejectWorkflow functions.
  registerOpenApiRoute(respondWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (run.status !== 'paused') {
        return apiError(c, 400, `Cannot respond to workflow in '${run.status}' status`);
      }
      const respondBlocker = pausedGateBlocker(
        run,
        'Respond on the child run instead, or abandon this run to discard the whole tree.',
        false
      );
      if (respondBlocker) {
        return apiError(c, 400, respondBlocker);
      }
      const rawBody = await c.req.text();
      let body: { decision?: string; text?: string } = {};
      if (rawBody.trim().length > 0) {
        try {
          body = JSON.parse(rawBody) as { decision?: string; text?: string };
        } catch (parseError) {
          getLog().warn({ err: parseError, runId }, 'api.respond_body_parse_failed');
          return apiError(
            c,
            400,
            'Request body is not valid JSON — send {"decision": "...", "text": "..."}'
          );
        }
      }
      if (!body.decision) {
        return apiError(c, 400, 'Request body must include a non-empty "decision"');
      }
      const decision = body.decision;

      // Pre-validate a non-default decision so an undeclared id is a 400 naming the
      // gate's actual options, not an opaque 500 — mirrors the approve/reject routes'
      // pre-checks above. 'approve'/'reject' skip this: assertRespondable enforces
      // decisionsAuthored, which legacy gates (the ones those two ids also serve)
      // never set — see assertRespondable's doc comment for why it is not consulted
      // for those two ids.
      if (decision !== 'approve' && decision !== 'reject') {
        try {
          assertRespondable(run, decision);
        } catch (validationError) {
          return apiError(c, 400, (validationError as Error).message);
        }
      }

      // Mirrors the dedicated /reject route's default: an empty/omitted text becomes
      // 'Rejected' rather than reaching a new-mode gate's structured output as ''.
      // Only for decision === 'reject' — every other decision (including 'approve',
      // which stays optional/undefined) is unaffected.
      const text = body.text ?? (decision === 'reject' ? 'Rejected' : undefined);
      const result = await respondToWorkflow(runId, decision, text);

      if ('cancelled' in result && result.cancelled) {
        return c.json({
          success: true,
          message: result.maxAttemptsReached
            ? `Workflow rejected and cancelled (max attempts reached): ${run.workflow_name}`
            : `Workflow rejected: ${run.workflow_name}`,
        });
      }

      // Auto-resume: dispatch to the orchestrator so the resolution actually takes
      // effect, mirroring approve/reject. Same cross-adapter guard — only web
      // parents auto-resume.
      const autoResumed = await tryAutoResumeAfterGate(run, 'respond', await resolveWebUserId(c));
      const resumeHint = `run \`archon workflow resume ${runId}\` from the CLI to trigger it`;

      return c.json({
        success: true,
        message: autoResumed
          ? `Workflow responded '${decision}': ${run.workflow_name}. Continuing.`
          : `Workflow responded '${decision}': ${run.workflow_name}. The run will continue when it resumes — ${resumeHint}.`,
      });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_respond_failed');
      return apiError(c, 500, 'Failed to respond to workflow run');
    }
  });

  // DELETE /api/workflows/runs/:runId - Delete a workflow run
  registerOpenApiRoute(deleteWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(
          c,
          400,
          `Cannot delete workflow in '${run.status}' status — cancel it first`
        );
      }
      await workflowDb.deleteWorkflowRun(runId);
      return c.json({ success: true, message: `Deleted workflow run: ${run.workflow_name}` });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_delete_failed');
      return apiError(c, 500, 'Failed to delete workflow run');
    }
  });

  // DELETE /api/workflows/:name/node-sessions - Reset persisted per-node provider sessions
  registerOpenApiRoute(resetWorkflowNodeSessionsRoute, async c => {
    const workflowName = c.req.param('name') ?? '';
    if (!workflowName) {
      return apiError(c, 400, 'Workflow name is required');
    }
    const scope = c.req.query('scope') ?? undefined;
    const node = c.req.query('node') ?? undefined;
    const confirm = c.req.query('confirm') ?? undefined;
    // Cross-scope reset (no scope) is destructive — require explicit confirmation so a
    // dropped `scope` param can't silently wipe every conversation's sessions. Mirrors
    // the CLI `--yes` guard.
    if (scope === undefined && confirm !== 'all-scopes') {
      return apiError(
        c,
        400,
        'Refusing to reset sessions across all scopes without confirmation. Pass ?scope=<key> to narrow, or ?confirm=all-scopes to confirm.'
      );
    }
    try {
      const { deleted } = await resetWorkflowNodeSessions({
        workflow_name: workflowName,
        scope_key: scope,
        node_id: node,
      });
      return c.json({ success: true, deleted });
    } catch (error) {
      getLog().error(
        { err: error, workflowName, scope, node },
        'api.workflow_reset_node_sessions_failed'
      );
      return apiError(c, 500, 'Failed to reset workflow node sessions');
    }
  });

  // GET /api/workflows/runs - List workflow runs
  registerOpenApiRoute(listWorkflowRunsRoute, async c => {
    try {
      const conversationId = c.req.query('conversationId') ?? undefined;
      const rawStatus = c.req.query('status');
      const validStatuses = workflowRunStatusSchema.options;
      type WorkflowRunStatus = (typeof validStatuses)[number];
      const status: WorkflowRunStatus | undefined =
        rawStatus && (validStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as WorkflowRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);
      // Non-enforcing "mine" filter: only narrows when an identity resolves.
      // Default visibility stays open (everyone sees everyone's runs).
      const mine = c.req.query('mine') === 'true';
      const userId = mine ? (await resolveAuthContext(c))?.userId : undefined;

      // Open-work inbox (#2747): a status-derived query, not a stored flag —
      // terminal failed runs with no adopter/successor. Mutually exclusive with
      // the other filters by contract; the inbox wins when combined.
      if (c.req.query('open') === 'true') {
        const openRuns = await workflowDb.findOpenWorkRuns({ codebaseId, limit });
        return c.json({ runs: openRuns.map(toApiWorkflowRun) });
      }

      const runs = await workflowDb.listWorkflowRuns({
        conversationId,
        status,
        limit,
        codebaseId,
        userId,
      });
      return c.json({ runs: runs.map(toApiWorkflowRun) });
    } catch (error) {
      getLog().error({ err: error }, 'list_workflow_runs_failed');
      return apiError(c, 500, 'Failed to list workflow runs');
    }
  });

  // GET /api/workflows/runs/by-worker/:platformId - Look up run by worker conversation
  // Must be registered before :runId to avoid "by-worker" matching as a runId
  registerOpenApiRoute(getWorkflowRunByWorkerRoute, async c => {
    try {
      const platformId = c.req.param('platformId') ?? '';
      const run = await workflowDb.getWorkflowRunByWorkerPlatformId(platformId);
      if (!run) {
        return apiError(c, 404, 'No workflow run found for this worker');
      }
      return c.json({ run: toApiWorkflowRun(run) });
    } catch (error) {
      getLog().error({ err: error }, 'workflow_run_by_worker_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }
  });

  // GET /api/workflows/runs/:runId - Get run details with events
  registerOpenApiRoute(getWorkflowRunRoute, async c => {
    try {
      const runId = c.req.param('runId') ?? '';
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const events = await workflowEventDb.listWorkflowEvents(runId);

      // Look up the run's conversation platform ID.
      // For web runs (parent_conversation_id set): conversation_id is the worker conversation → set worker_platform_id
      // For CLI runs (no parent): conversation_id is the single conversation → set conversation_platform_id only
      let workerPlatformId: string | undefined;
      let conversationPlatformId: string | undefined;
      if (run.conversation_id) {
        const conv = await conversationDb.getConversationById(run.conversation_id);
        if (run.parent_conversation_id) {
          // Web run: conversation_id points to the worker conversation
          workerPlatformId = conv?.platform_conversation_id;
        } else {
          // CLI run: conversation_id is the only conversation (no worker/parent split)
          conversationPlatformId = conv?.platform_conversation_id;
        }
      }

      // Look up parent conversation to get its platform_conversation_id for navigation
      let parentPlatformId: string | undefined;
      if (run.parent_conversation_id) {
        const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
        parentPlatformId = parentConv?.platform_conversation_id;
      }

      return c.json({
        run: {
          ...toApiWorkflowRun(run),
          worker_platform_id: workerPlatformId,
          parent_platform_id: parentPlatformId,
          conversation_platform_id: conversationPlatformId ?? null,
          terminal_record: getTerminalRecord(run.status, events),
        },
        events,
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_workflow_run_failed');
      return apiError(c, 500, 'Failed to get workflow run');
    }
  });

  // POST /api/workflows/validate - Validate a workflow definition without saving
  // MUST be registered before GET /api/workflows/:name so "validate" is not treated as :name
  registerOpenApiRoute(validateWorkflowRoute, async c => {
    const { definition } = getValidatedBody(c, validateWorkflowBodySchema);

    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    try {
      const result = parseWorkflow(yamlContent, 'validate-input.yaml');

      if (result.error) {
        return c.json({ valid: false, errors: [result.error.error] });
      }
      return c.json({ valid: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.validate_failed');
      return apiError(c, 500, 'Failed to validate workflow');
    }
  });

  // GET /api/workflows/:name - Fetch a single workflow definition
  registerOpenApiRoute(getWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidWorkflowName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      // 1. Try user-defined workflow in cwd.
      if (workingDir) {
        const [workflowFolder] = getWorkflowFolderSearchPaths();
        const projectWorkflowsRoot = join(workingDir, workflowFolder);
        try {
          const hit = await findWorkflowAt(projectWorkflowsRoot, name);
          const isSourceBundledPackage =
            hit?.packaged === true && isBundledWorkflowsRoot(projectWorkflowsRoot);
          if (hit && !isSourceBundledPackage) {
            const result = hit.parsed;
            if (result.error) {
              return apiError(c, 500, `Workflow file is invalid: ${result.error.error}`);
            }
            return c.json({
              workflow: result.workflow,
              filename: hit.filename,
              source: 'project' as WorkflowSource,
            });
          }
        } catch (err) {
          getLog().error({ err, name }, 'workflow.fetch_failed');
          return apiError(c, 500, 'Failed to read workflow');
        }
      }

      // 2. Fall back to home-scoped workflow (`~/.archon/workflows/`).
      // Mirrors the discovery order in `discoverWorkflowsWithConfig`.
      try {
        const hit = await findWorkflowAt(getHomeWorkflowsPath(), name);
        if (hit) {
          const result = hit.parsed;
          if (result.error) {
            return apiError(c, 500, `Home workflow file is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename: hit.filename,
            source: 'global' as WorkflowSource,
          });
        }
      } catch (err) {
        getLog().error({ err, name }, 'workflow.fetch_home_failed');
        return apiError(c, 500, 'Failed to read home-scoped workflow');
      }

      // 3. Fall back to bundled defaults.
      const bundled = findBundledWorkflow(name);
      if (bundled !== null) {
        const result = bundled.parsed;
        if (result.error) {
          return apiError(c, 500, `Bundled workflow is invalid: ${result.error.error}`);
        }
        return c.json({
          workflow: result.workflow,
          filename: bundled.filename,
          source: 'bundled' as WorkflowSource,
        });
      }

      if (!isBinaryBuild()) {
        try {
          const hit =
            (await tryReadWorkflowAt(getDefaultWorkflowsPath(), name)) ??
            (await findPackagedWorkflowAt(dirname(getDefaultWorkflowsPath()), name));
          if (hit) {
            const result = hit.parsed;
            if (result.error) {
              return apiError(c, 500, `Default workflow is invalid: ${result.error.error}`);
            }
            return c.json({
              workflow: result.workflow,
              filename: hit.filename,
              source: 'bundled' as WorkflowSource,
            });
          }
        } catch (err) {
          getLog().error({ err, name }, 'workflow.fetch_default_failed');
          return apiError(c, 500, 'Failed to read default workflow');
        }
      }

      return apiError(c, 404, `Workflow not found: ${name}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.get_failed');
      return apiError(c, 500, 'Failed to get workflow');
    }
  });

  // PUT /api/workflows/:name - Save (create or update) a workflow
  registerOpenApiRoute(saveWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    const targetSource = c.req.query('source');
    if (targetSource && targetSource !== 'project' && targetSource !== 'global') {
      return apiError(c, 400, 'Invalid workflow source');
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (targetSource === 'global') {
      workingDir = undefined;
    } else if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const { definition } = getValidatedBody(c, saveWorkflowBodySchema);

    // Serialize and validate before writing
    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    const parsed = parseWorkflow(yamlContent, `${name}.yaml`);
    if (parsed.error) {
      return apiError(c, 400, 'Workflow definition is invalid', parsed.error.error);
    }

    try {
      const source: WorkflowSource = targetSource === 'global' ? 'global' : 'project';
      const dirPath =
        source === 'global'
          ? getHomeWorkflowsPath()
          : join(workingDir, getWorkflowFolderSearchPaths()[0]);
      await mkdir(dirPath, { recursive: true });
      const existing = await findWorkflowAt(dirPath, name);
      if (existing?.packaged === true && isBundledWorkflowsRoot(dirPath)) {
        return apiError(c, 400, `Cannot overwrite bundled default workflow: ${name}`);
      }
      const filePath = existing?.absolutePath ?? join(dirPath, `${name}.yaml`);
      const filename = existing?.filename ?? `${name}.yaml`;
      await writeFile(filePath, yamlContent, 'utf-8');
      return c.json({
        workflow: parsed.workflow,
        filename,
        source,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.save_failed');
      return apiError(c, 500, 'Failed to save workflow');
    }
  });

  // DELETE /api/workflows/:name - Delete a user-defined workflow
  registerOpenApiRoute(deleteWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    const targetSource = c.req.query('source');
    if (targetSource && targetSource !== 'project' && targetSource !== 'global') {
      return apiError(c, 400, 'Invalid workflow source');
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (targetSource === 'global') {
      workingDir = undefined;
    } else if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const dir =
      targetSource === 'global'
        ? getHomeWorkflowsPath()
        : join(workingDir, getWorkflowFolderSearchPaths()[0]);

    try {
      const packaged = await findPackagedWorkflowAt(dir, name);
      if (packaged !== null) {
        if (isBundledWorkflowsRoot(dir)) {
          return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
        }
        await rm(dirname(packaged.absolutePath), { recursive: true });
        return c.json({ deleted: true, name });
      }
    } catch (err) {
      getLog().error({ err, name }, 'workflow.delete_failed');
      return apiError(c, 500, 'Failed to delete workflow');
    }

    // Remove both `.yaml` and `.yml` variants (discovery accepts either), so a
    // twin file can't stay active after a reported deletion.
    let deleted = false;
    for (const ext of ['yaml', 'yml']) {
      const filePath = join(dir, `${name}.${ext}`);
      try {
        await unlink(filePath);
        deleted = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        getLog().error({ err, name }, 'workflow.delete_failed');
        return apiError(c, 500, 'Failed to delete workflow');
      }
    }
    if (deleted) {
      return c.json({ deleted: true, name });
    }
    if (targetSource !== 'global') {
      try {
        if (findBundledWorkflow(name) !== null) {
          return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
        }
      } catch (err) {
        getLog().error({ err, name }, 'workflow.delete_failed');
        return apiError(c, 500, 'Failed to delete workflow');
      }
    }
    return apiError(c, 404, `Workflow not found: ${name}`);
  });

  // GET /api/commands - List available command names for the workflow node palette
  registerOpenApiRoute(getCommandsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      // Collect commands: precedence bundled < global < project (repo-defined wins).
      const commandMap = new Map<string, WorkflowSource>();

      // 1. Seed with bundled defaults
      for (const name of Object.keys(BUNDLED_COMMANDS)) {
        commandMap.set(name, 'bundled');
      }

      // 2. If not binary build, also check filesystem defaults
      if (!isBinaryBuild()) {
        try {
          const defaultsPath = getDefaultCommandsPath();
          const files = await findCommandFiles(defaultsPath);
          for (const { commandName } of files) {
            commandMap.set(commandName, 'bundled');
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err }, 'commands.list_defaults_failed');
          }
          // ENOENT: defaults path missing — not an error
        }
      }

      // 3. Home-scoped commands (~/.archon/commands/) override bundled
      try {
        const homeCommandsPath = getHomeCommandsPath();
        const files = await findCommandFiles(homeCommandsPath);
        for (const { commandName } of files) {
          commandMap.set(commandName, 'global');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLog().error({ err }, 'commands.list_home_failed');
        }
        // ENOENT: home commands dir not created yet — not an error
      }

      // 4. Project-defined commands override bundled AND global
      if (workingDir) {
        const searchPaths = getCommandFolderSearchPaths();
        for (const folder of searchPaths) {
          const dirPath = join(workingDir, folder);
          try {
            const files = await findCommandFiles(dirPath);
            for (const { commandName } of files) {
              commandMap.set(commandName, 'project');
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              getLog().error({ err, dirPath }, 'commands.list_project_failed');
            }
            // ENOENT: folder doesn't exist — skip
          }
        }
      }

      const commands = Array.from(commandMap.entries()).map(([name, source]) => ({ name, source }));
      return c.json({ commands });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'commands.list_failed');
      return apiError(c, 500, 'Failed to list commands');
    }
  });

  // GET /api/runs/:runId/artifacts - List artifact files for a run.
  // Walks the run's artifact directory and returns relative file paths with
  // size + mtime. Used by the console's Artifacts tab; the existing
  // `workflow_artifact` event stream is too sparse (bash/script nodes write
  // straight to $ARTIFACTS_DIR without emitting an event) to drive a file
  // browser on its own.
  registerOpenApiRoute(listRunArtifactsRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      return apiError(c, 400, 'Invalid run id');
    }

    let run: Awaited<ReturnType<typeof workflowDb.getWorkflowRun>>;
    try {
      run = await workflowDb.getWorkflowRun(runId);
    } catch (error) {
      getLog().error({ err: error, runId }, 'artifacts.run_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }
    if (!run) return apiError(c, 404, 'Workflow run not found');

    let codebase: Awaited<ReturnType<typeof codebaseDb.getCodebase>> | null = null;
    if (run.codebase_id) {
      try {
        codebase = await codebaseDb.getCodebase(run.codebase_id);
      } catch (error) {
        getLog().error(
          { err: error, runId, codebaseId: run.codebase_id },
          'artifacts.codebase_lookup_failed'
        );
        return apiError(c, 500, 'Failed to look up codebase');
      }
    }
    // An empty 200 here is indistinguishable from "the run produced nothing",
    // so an unresolvable output location is an explicit 404 (Fail Fast).
    const artifactDir = resolveRunArtifactDir(run, codebase, runId);
    if (!artifactDir) {
      getLog().warn({ runId, codebaseId: run.codebase_id }, 'artifacts.output_location_unresolved');
      return apiError(
        c,
        404,
        'Artifacts not available: could not resolve this run’s output location'
      );
    }
    if (!isInsideArchonHome(artifactDir)) {
      getLog().warn(
        { runId, artifactDir, archonHome: getArchonHome() },
        'artifacts.path_escape_blocked'
      );
      return apiError(c, 400, 'Invalid artifact path');
    }

    interface FileEntry {
      path: string;
      size: number;
      modifiedAt: string;
    }
    const files: FileEntry[] = [];

    async function walk(dir: string, rel: string): Promise<void> {
      let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        // The engine's own store is left out by the rule the CLI's listing shares;
        // a workflow's own dotfiles are its output and stay listed.
        if (isRunArtifactsEngineEntry(rel, entry.name)) continue;
        const child = join(dir, entry.name);
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(child, childRel);
        } else if (entry.isFile()) {
          try {
            const s = await stat(child);
            files.push({
              path: childRel,
              size: s.size,
              modifiedAt: s.mtime.toISOString(),
            });
          } catch (err) {
            // Race with deletion / permission flips: skip ENOENT / EACCES
            // silently, surface anything else so we don't return a half-list
            // with no diagnostic.
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'EACCES') continue;
            throw err;
          }
        }
      }
    }

    try {
      await walk(artifactDir, '');
    } catch (error) {
      getLog().error({ err: error, runId, artifactDir }, 'artifacts.walk_failed');
      return apiError(c, 500, 'Failed to list artifacts');
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return c.json({ files });
  });

  // GET /api/artifacts/:runId/* - Serve workflow artifact file contents
  // The wildcard captures the filename (e.g. "plan.md", "subdir/report.md").
  // Path traversal is blocked: any segment containing ".." is rejected.

  /**
   * The GitHub reader behind the console's issue board and issue dialog.
   *
   * The browser cannot call GitHub directly for a private repo, and a token
   * does not belong in the browser. Everything underneath this already
   * existed — the server holds credentials, other callers use Octokit, and a
   * project already carries its repository_url — but nothing had ever needed
   * issues, so there was no route to ask through.
   *
   * Read-only. Nothing here writes to GitHub.
   *
   * `app.get` rather than registerOpenApiRoute: the shape is a thin passthrough
   * of GitHub's own model and pinning it in the OpenAPI schema would make every
   * field GitHub adds a schema change.
   */

  /** GET /api/projects/:projectId/issues — the project's GitHub issues. */
  app.get('/api/projects/:projectId/issues', async c => {
    const projectId = c.req.param('projectId');
    const src = await resolveIssueSource(projectId);
    if (src === null) return c.json({ error: 'Project not found' }, 404);
    if (isIssueReadFailure(src)) return c.json({ issues: [], ...src });

    const slug = repoSlug(src);
    try {
      const out = await githubGraphQl(src, ISSUE_LIST_QUERY, {
        owner: src.owner,
        repo: src.repo,
      });
      if ('reason' in out) return c.json({ issues: [], repo: slug, reason: out.reason });
      const { repository } = out.data as { repository?: { issues?: { nodes?: unknown[] } } };
      const nodes = repository?.issues?.nodes ?? [];
      return c.json({ issues: nodes.map(toIssue), repo: slug, reason: null });
    } catch (err) {
      getLog().warn({ err, projectId }, 'issues.fetch_failed');
      return c.json({ issues: [], repo: slug, reason: 'unreachable' });
    }
  });

  /**
   * GET /api/projects/:projectId/issues/:number — one issue, with its body and
   * comment thread, so the console can show an issue without sending you to
   * github.com. github.com serves `x-frame-options: deny`, so an iframe was
   * never on the table; this returns the markdown and the client renders it.
   */
  app.get('/api/projects/:projectId/issues/:number', async c => {
    const projectId = c.req.param('projectId');
    const number = Number(c.req.param('number'));
    if (!Number.isInteger(number) || number <= 0) {
      return c.json({ issue: null, repo: null, reason: 'bad-issue-number' }, 400);
    }
    const src = await resolveIssueSource(projectId);
    if (src === null) return c.json({ error: 'Project not found' }, 404);
    if (isIssueReadFailure(src)) return c.json({ issue: null, ...src });

    const slug = repoSlug(src);
    try {
      const out = await githubGraphQl(src, ISSUE_DETAIL_QUERY, {
        owner: src.owner,
        repo: src.repo,
        number,
      });
      if ('reason' in out) return c.json({ issue: null, repo: slug, reason: out.reason });
      const { repository } = out.data as { repository?: { issue?: unknown } };
      const raw = repository?.issue;
      // A number nobody has used is not a failure of the reader.
      if (raw === null || raw === undefined) {
        return c.json({ issue: null, repo: slug, reason: 'no-such-issue' });
      }
      return c.json({ issue: toIssueDetail(raw), repo: slug, reason: null });
    } catch (err) {
      getLog().warn({ err, projectId, number }, 'issue.fetch_failed');
      return c.json({ issue: null, repo: slug, reason: 'unreachable' });
    }
  });

  /**
   * GET/PATCH /api/projects/:projectId/presentation — the console's own view of
   * a project: icon, colour, hand-arranged rail position, and brief.
   *
   * These lived in localStorage so the rail could ship without a restart. The
   * consequence was not designable-around: none of it followed you to another
   * machine, and a cleared browser lost all of it.
   *
   * PATCH merges rather than replaces, so two tabs editing different fields
   * cannot silently drop each other's work.
   */
  app.get('/api/projects/:projectId/presentation', async c => {
    const projectId = c.req.param('projectId');
    const found = await codebaseDb.getCodebasePresentation(projectId);
    if (found === null) return c.json({ error: 'Project not found' }, 404);
    return c.json(found);
  });

  app.patch('/api/projects/:projectId/presentation', async c => {
    const projectId = c.req.param('projectId');
    if ((await codebaseDb.getCodebase(projectId)) === null) {
      return c.json({ error: 'Project not found' }, 404);
    }

    let body: { presentation?: unknown; sortOrder?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const patch =
      typeof body.presentation === 'object' && body.presentation !== null
        ? (body.presentation as Record<string, unknown>)
        : null;
    const hasSort = 'sortOrder' in body;
    const sortOrder =
      typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)
        ? Math.trunc(body.sortOrder)
        : null;

    if (patch === null && !hasSort) return c.json({ error: 'Nothing to update' }, 400);

    try {
      if (patch !== null) await codebaseDb.updateCodebasePresentation(projectId, patch);
      if (hasSort) await codebaseDb.updateCodebaseSortOrder(projectId, sortOrder);
      return c.json(await codebaseDb.getCodebasePresentation(projectId));
    } catch (err) {
      getLog().warn({ err, projectId }, 'presentation.update_failed');
      return c.json({ error: 'Could not save' }, 500);
    }
  });

  // NOTE: Uses app.get() instead of registerOpenApiRoute because:
  //  1. Wildcard path params (*) are not representable in OpenAPI 3.0
  //  2. Response is raw text/markdown, not JSON
  app.get('/api/artifacts/:runId/*', async c => {
    const runId = c.req.param('runId');
    // Hono wildcards match but don't capture — extract filename from the URL path.
    // c.req.path is NOT percent-decoded, so we decode it manually.
    const prefix = `/api/artifacts/${runId}/`;
    const rawEncoded = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
    let rawFilename: string;
    try {
      rawFilename = decodeURIComponent(rawEncoded);
    } catch {
      return apiError(c, 400, 'Invalid filename');
    }

    // An empty name addresses the directory itself, which is not a file.
    // Everything else about the path is judged by resolveContainedPath.
    if (!rawFilename) {
      return apiError(c, 400, 'Invalid filename');
    }
    const filename = normalize(rawFilename).replace(/^[/\\]+/, '');
    if (!filename) {
      return apiError(c, 400, 'Invalid filename');
    }

    let run: Awaited<ReturnType<typeof workflowDb.getWorkflowRun>>;
    try {
      run = await workflowDb.getWorkflowRun(runId);
    } catch (error) {
      getLog().error({ err: error, runId }, 'artifacts.run_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }

    if (!run) {
      return apiError(c, 404, 'Workflow run not found');
    }

    // Resolve the run's output tree for every project kind — a persisted
    // output_root first, else the shared identity→paths resolver (#2200).
    const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
    const artifactDir = resolveRunArtifactDir(run, codebase, runId);
    if (!artifactDir) {
      getLog().error(
        { runId, codebaseId: run.codebase_id },
        'artifacts.output_location_unresolved'
      );
      return apiError(
        c,
        404,
        'Artifact not available: could not resolve this run’s output location'
      );
    }
    if (!isInsideArchonHome(artifactDir)) {
      getLog().warn(
        { runId, artifactDir, archonHome: getArchonHome() },
        'artifacts.path_escape_blocked'
      );
      return apiError(c, 400, 'Invalid artifact path');
    }
    // readFile follows symlinks, so the target is contained and the CHECKED
    // path is what gets read (#3160). Shared with the Files tab endpoints —
    // one guard chain, fixed in one place.
    const contained = await resolveContainedPath(artifactDir, filename);
    if (!contained.ok) {
      switch (contained.reason) {
        case 'invalid':
        case 'escaped':
          getLog().warn({ runId, filename, artifactDir }, 'artifacts.path_escape_blocked');
          return apiError(c, 400, 'Invalid filename');
        case 'symlink-escape':
          getLog().warn({ runId, filename, artifactDir }, 'artifacts.symlink_escape_blocked');
          return apiError(c, 404, 'Artifact file not found');
        case 'missing':
          return apiError(c, 404, 'Artifact file not found');
        default:
          getLog().error({ err: contained.err, runId, filename }, 'artifacts.read_failed');
          return apiError(c, 500, 'Failed to read artifact file');
      }
    }
    const realFilePath = contained.realPath;

    let content: string;
    try {
      content = await readFile(realFilePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, filename }, 'artifacts.read_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }

    const contentType = filename.endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : 'text/plain; charset=utf-8';
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  });

  // GET /api/config - Read-only configuration (safe subset only — no filesystem paths)
  registerOpenApiRoute(getConfigRoute, async c => {
    try {
      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_config_failed');
      return apiError(c, 500, 'Failed to get config');
    }
  });

  /**
   * A write the config validators refused is the caller's to fix: return it as a
   * 400 with the refused key. Anything else is a server fault and stays opaque.
   */
  function configUpdateFailed(
    c: Context,
    error: unknown,
    logEvent: string,
    message: string
  ): Response {
    if (error instanceof InvalidConfigError) {
      return apiError(c, 400, error.summary);
    }
    getLog().error({ err: error }, logEvent);
    return apiError(c, 500, message);
  }

  // PATCH /api/config/assistants - Update assistant configuration
  registerOpenApiRoute(patchAssistantConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateAssistantConfigBodySchema);

      const updates: Partial<GlobalConfig> = {};
      if (body.assistant !== undefined) {
        if (!isRegisteredProvider(body.assistant)) {
          return apiError(
            c,
            400,
            `Unknown provider '${body.assistant}'. Available: ${getProviderInfoList()
              .map(p => p.id)
              .join(', ')}`
          );
        }
        updates.defaultAssistant = body.assistant;
      }
      if (body.assistants !== undefined) {
        const unknownProviders = Object.keys(body.assistants).filter(
          id => !isRegisteredProvider(id)
        );
        if (unknownProviders.length > 0) {
          return apiError(
            c,
            400,
            `Unknown provider(s) in assistants: ${unknownProviders.join(', ')}. Available: ${getProviderInfoList()
              .map(p => p.id)
              .join(', ')}`
          );
        }
        updates.assistants = body.assistants;
      }

      await updateGlobalConfig(updates);

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.assistants_update_failed',
        'Failed to update assistant configuration'
      );
    }
  });

  // PATCH /api/config/tiers - Update model-tier presets (ungated — solo-OK, like /assistants)
  registerOpenApiRoute(patchTiersConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateTiersBodySchema);

      // Validate the provider of each tier we're SETTING (null = unset, skip).
      const tiers: TiersPatch = {};
      for (const tier of TIER_NAMES) {
        const entry = body.tiers[tier];
        if (entry === undefined) continue;
        if (entry === null) {
          tiers[tier] = null;
          continue;
        }
        const errMsg = validatePresetEntry(`tier '${tier}'`, entry);
        if (errMsg) return apiError(c, 400, errMsg);
        tiers[tier] = toCleanEntry(entry);
      }

      await updateGlobalConfig({ tiers });

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.tiers_update_failed',
        'Failed to update tier configuration'
      );
    }
  });

  // PATCH /api/config/aliases - Update @custom aliases (ungated — solo-OK, like /tiers)
  registerOpenApiRoute(patchAliasesConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateAliasesBodySchema);
      const aliases: AliasesPatch = {};
      for (const [name, entry] of Object.entries(body.aliases)) {
        const nameErr = validateAliasName(name);
        if (nameErr) return apiError(c, 400, nameErr);
        if (entry === null) {
          aliases[name] = null;
          continue;
        }
        const errMsg = validatePresetEntry(`alias '${name}'`, entry);
        if (errMsg) return apiError(c, 400, errMsg);
        aliases[name] = toCleanEntry(entry);
      }

      await updateGlobalConfig({ aliases });

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.aliases_update_failed',
        'Failed to update alias configuration'
      );
    }
  });

  // PATCH /api/config/chats - Update handoff thresholds (ungated — solo-OK, like /tiers)
  registerOpenApiRoute(patchChatsConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateChatsBodySchema);

      // Checked against the MERGED result, not the body alone: a PATCH that
      // only raises the nudge has to be compared with the handoff point
      // already on file, or the pair can be walked into an invalid state one
      // field at a time.
      const current = toSafeConfig(await loadConfig()).chats;
      const nudge = body.nudgeAtPercent ?? current.nudgeAtPercent;
      const handoff = body.handoffAtPercent ?? current.handoffAtPercent;
      if (nudge >= handoff) {
        return apiError(
          c,
          400,
          `Nudge (${String(nudge)}%) must be below the handoff point (${String(handoff)}%) — ` +
            'otherwise it would suggest wrapping up a chat that has already been handed off.'
        );
      }

      await updateGlobalConfig({ chats: body });

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      getLog().error({ err: error }, 'config.chats_update_failed');
      return apiError(c, 500, 'Failed to update chat configuration');
    }
  });

  // GET /api/providers - List registered AI providers
  registerOpenApiRoute(getProvidersRoute, c => {
    return c.json({ providers: getProviderInfoList() });
  });

  // GET /api/providers/pi/models - Pi model catalog (best-effort hint; [] on failure)
  registerOpenApiRoute(getPiModelsRoute, async c => {
    try {
      return c.json({ models: await listPiModels() });
    } catch (error) {
      // listPiModels already degrades internally; this belt-and-suspenders
      // keeps the documented "never errors" contract at the route boundary.
      getLog().warn({ err: error }, 'providers.pi_models_list_failed');
      return c.json({ models: [] });
    }
  });

  // GET /api/providers/opencode/credentials - OpenCode backend introspection
  // (on-demand; starts the embedded runtime). 503 on failure — never a silent [].
  registerOpenApiRoute(getOpencodeCredentialsRoute, async c => {
    try {
      const result = await introspectOpencodeCredentials();
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'providers.opencode_credentials_introspect_failed');
      return apiError(c, 503, 'Embedded OpenCode runtime unavailable');
    }
  });

  // GET /api/codebases/:id/environments - List isolation environments for a codebase
  registerOpenApiRoute(getCodebaseEnvironmentsRoute, async c => {
    try {
      const { id } = c.req.param();
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }

      const environments = await isolationEnvDb.listByCodebaseWithAge(id);
      return c.json({ environments });
    } catch (error) {
      getLog().error({ err: error }, 'codebases.environments_list_failed');
      return apiError(c, 500, 'Failed to list environments');
    }
  });

  // GET /api/health - Health check with web adapter info
  registerOpenApiRoute(getHealthRoute, async c => {
    const stats = lockManager.getStats();
    const runningWorkflowRows = await workflowDb.getRunningWorkflows();

    // Merge lock-based and DB-based active tracking.
    // Background workflows bypass the lock manager, so we combine both sources.
    const lockActiveSet = new Set(stats.activeConversationIds);
    const backgroundConversationIds = runningWorkflowRows
      .map(r => r.conversation_id)
      .filter(id => !lockActiveSet.has(id));
    const allActiveIds = [...stats.activeConversationIds, ...backgroundConversationIds];
    const wslDistro = getWSLDistroName();

    // Health is public (PUBLIC_API_GATE_PREFIXES) and must stay answerable when the
    // database is degraded, so a failed vintage read is logged and the key omitted
    // rather than turning the healthcheck into a 500. `createdAt` is deliberately not
    // exposed — the two version strings plus applied_at are what a bug report needs.
    let schema:
      | Pick<SchemaVersionInfo, 'createdAppVersion' | 'appVersion' | 'appliedAt'>
      | undefined;
    try {
      const info = await getSchemaVersion();
      if (info) {
        schema = {
          createdAppVersion: info.createdAppVersion,
          appVersion: info.appVersion,
          appliedAt: info.appliedAt,
        };
      }
    } catch (err) {
      getLog().warn({ err }, 'api.schema_version_read_failed');
    }

    // Read from files on every request, never persisted: the server being
    // replaced is the one answering, so a stored phase would be stale across
    // exactly the swap it describes. Health is public and must stay answerable,
    // so a failed read is logged and the key omitted — the same contract as the
    // schema vintage above.
    let deploy: DeployStatus | undefined;
    try {
      deploy = await getDeployStatus();
    } catch (err) {
      getLog().warn({ err }, 'api.deploy_status_read_failed');
    }

    let ciWaitingConversationIds: string[] | undefined;
    try {
      ciWaitingConversationIds = await listCiWaitingPlatformConversationIds();
    } catch (err) {
      getLog().warn({ err }, 'api.ci_waiting_read_failed');
    }

    // Drained is derived from the two counts this route already reports, so the
    // deploy's own busy check and the server's answer can never disagree.
    const drainStatus = lockManager.getDrainStatus();
    // A parked chat's turn may take a moment to honour its interrupt, but its work
    // is already saved for the next server, so the deploy is not waiting on it.
    const parkedIds = new Set(lockManager.getParkedConversationIds());
    const holding = {
      activeConversations: allActiveIds.filter(id => !parkedIds.has(id)).length,
      queuedMessages: stats.queuedTotal,
      runningWorkflows: runningWorkflowRows.length,
    };
    const drain = drainStatus
      ? {
          ...drainStatus,
          state: Object.values(holding).every(count => count === 0)
            ? ('drained' as const)
            : ('draining' as const),
          holding,
        }
      : undefined;

    return c.json({
      status: 'ok',
      adapter: 'web',
      concurrency: {
        ...stats,
        active: allActiveIds.length,
        activeConversationIds: allActiveIds,
        // What each of those chats is doing right now, so the rail can say
        // "Editing ChatPage.tsx" where it used to say "working". Rides the read
        // that already tells it WHICH chats are moving, rather than adding a
        // second poll to answer the other half of the same question. Only
        // chats with a tool in flight appear; the rest fall back to the word.
        activeTools: Object.fromEntries(webAdapter.currentActivity()),
      },
      runningWorkflows: runningWorkflowRows.length,
      version: appVersion,
      is_docker: isDocker(),
      is_wsl: isWSL(),
      ...(wslDistro ? { wsl_distro: wslDistro } : {}),
      activePlatforms: activePlatforms ? [...activePlatforms] : ['Web'],
      ...(ciWaitingConversationIds ? { ciWaitingConversationIds } : {}),
      ...(drain ? { drain } : {}),
      ...(deploy ? { deploy } : {}),
      ...(schema ? { schema } : {}),
    });
  });

  registerOpenApiRoute(getUpdateCheckRoute, async c => {
    const noUpdate = {
      updateAvailable: false,
      currentVersion: appVersion,
      latestVersion: appVersion,
      releaseUrl: '',
    };
    if (!BUNDLED_IS_BINARY) return c.json(noUpdate);
    const result = await checkForUpdate(appVersion);
    return c.json(result ?? noUpdate);
  });

  /**
   * Hand a turn a deploy parked back to its web chat. The server's replay owns
   * order and at-most-once; this owns delivery, through the same dispatch every
   * web turn takes. A resumed turn is system-authored, so nothing is written as a
   * user message; a queued message is written at delivery, like any other.
   */
  const dispatchParkedTurn: ParkedTurnDispatcher = async (conversationDbId, turn) => {
    const conversation = await conversationDb.getConversationById(conversationDbId);
    if (!conversation?.platform_conversation_id) return 'conversation_missing';
    const platformId = conversation.platform_conversation_id;
    webAdapter.setConversationDbId(platformId, conversation.id);

    if (turn.kind === 'resume') {
      // Before the dispatch, so the notice sits above the reply it introduces.
      await webAdapter
        .sendDurableNotice(platformId, TURN_RESUMED_NOTICE, { category: 'turn_resumed' })
        .catch((err: unknown) => {
          getLog().warn({ err, conversationId: platformId }, 'turn_resumed_notice_failed');
        });
      const result = await dispatchToOrchestrator(
        platformId,
        turn.prompt,
        turn.userId !== null ? { userId: turn.userId } : {}
      );
      return result.accepted ? 'dispatched' : 'refused_draining';
    }

    const { text, userId, attachedFiles } = turn.turn;
    const fileMeta = attachedFiles.map(f => ({ name: f.name, mimeType: f.mimeType, size: f.size }));
    const firstFile = attachedFiles[0];
    const result = await dispatchToOrchestrator(
      platformId,
      text,
      firstFile ? { userId, attachedFiles } : { userId },
      firstFile ? { files: attachedFiles, uploadDir: dirname(firstFile.path) } : undefined,
      {
        persist: () =>
          persistDeliveredUserMessage(platformId, conversation.id, text, fileMeta, userId),
        files: fileMeta,
      }
    );
    return result.accepted ? 'dispatched' : 'refused_draining';
  };

  return { deliverCiWatchMessage, dispatchParkedTurn };
}

/**
 * Skill API — the single mutation surface for the console.
 *
 * Every UI action in the console calls exactly one of these verbs.
 * Internal orchestrators (CLI, Claude Code skill, future LLM driver) call
 * the same verbs via their own transport. If a UI interaction can't be
 * expressed as a skill verb, the verb set is wrong, not the UI.
 */

export * from './auth';
export * from './activeChats';
export * from './deploy';
export * from './projectCounts';
export * from './issues';
export * from './presentation';
export * from './projects';
export * from './workflows';
export * from './slashCommands';
export * from './worktrees';
export * from './files';
export * from './runs';
export * from './startRun';
export * from './messages';
export * from './conversations';
export * from './checkout';
export * from './changes';
export * from './envVars';
export * from './settings';
export * from './providers';
export * from './github';
export * from './providerKeys';
export * from './push';
export * from './console-views';

export { HttpError } from '../lib/http';

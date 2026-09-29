/**
 * Zod schemas for the console tab-memory endpoints (`routes/console-views.ts`).
 */
import { z } from '@hono/zod-openapi';

/** Every tab a console view row can hold. All projects offers only runs and chat. */
export const consoleViewSchema = z
  .enum(['overview', 'runs', 'chat', 'issues', 'files'])
  .openapi('ConsoleView');

/** GET /api/console/views — the caller's choices, by scope id ('' is All projects). */
export const consoleViewsSchema = z
  .object({ views: z.record(z.string(), consoleViewSchema) })
  .openapi('ConsoleViews');

/** PUT /api/console/views — one choice. */
export const consoleViewChangeSchema = z
  .object({ scopeId: z.string().max(255), view: consoleViewSchema })
  .openapi('ConsoleViewChange');

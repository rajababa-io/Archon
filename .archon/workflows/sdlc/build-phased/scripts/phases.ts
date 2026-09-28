/**
 * Split the spec into per-phase work orders and seed the build state.
 *
 * The phases are the `### ` subsections of the spec's `## Phases` section, in file
 * order; each subsection's body is that phase's work order. Everything else in the
 * spec is context every phase reads from the spec itself, so it is not copied.
 *
 * Refuses a missing spec or one with no phases: there is nothing to build, and
 * guessing phases from prose would spend a night on a guess.
 *
 * Bound input: INPUTS_SPEC, the repository-relative spec path. When it is empty
 * (a run started from chat, which can pass only a message), the spec is the first
 * `.md` path in the trigger message (ARGUMENTS) that exists in the checkout.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { artifactsDir, emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { buildDir, type Phase, writeState } from './state.ts';

/** The ordered `### ` subsections under `## Phases`, with their bodies. */
export function parsePhases(markdown: string): { title: string; body: string }[] {
  const lines = markdown.split('\n');
  const phases: { title: string; body: string[] }[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      inSection = /^##\s+Phases\s*$/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const heading = inFence ? null : /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      phases.push({ title: heading[1] ?? '', body: [] });
    } else {
      phases[phases.length - 1]?.body.push(line);
    }
  }
  return phases.map(p => ({ title: p.title, body: p.body.join('\n').trim() }));
}

/** The first `.md` path in a free-text message that exists in the checkout. */
export function specFromMessage(message: string): string {
  const candidates = message.match(/[\w./-]+\.md\b/g) ?? [];
  return candidates.find(c => existsSync(resolve(c))) ?? '';
}

function main(): void {
  const spec = trimmed(process.env.INPUTS_SPEC) || specFromMessage(text(process.env.ARGUMENTS));
  if (spec === '') {
    refuse(
      'phases: no spec given — pass the spec path as the `spec` input, or name an ' +
        'existing .md file in the message that starts the run.'
    );
    return;
  }
  const specPath = resolve(spec);
  if (!existsSync(specPath)) {
    refuse(`phases: spec not found at ${spec} (resolved ${specPath}).`);
    return;
  }
  const parsed = parsePhases(readFileSync(specPath, 'utf8'));
  if (parsed.length === 0) {
    refuse(
      `phases: ${spec} has no phases — it needs a \`## Phases\` section with one ` +
        '`### ` subsection per phase, in build order.'
    );
    return;
  }
  const empty = parsed.find(p => p.body === '');
  if (empty !== undefined) {
    refuse(`phases: phase "${empty.title}" in ${spec} has no work order under its heading.`);
    return;
  }

  const artifacts = artifactsDir();
  const dir = buildDir(artifacts);
  const phases: Phase[] = parsed.map((p, i) => {
    const file = join(dir, `phase-${String(i + 1)}.md`);
    writeFileSync(file, `# Phase ${String(i + 1)} of ${String(parsed.length)}: ${p.title}\n\n${p.body}\n`);
    return { title: p.title, file };
  });
  writeState(artifacts, { spec, phases, next: 0, attempt: 1, stopped: '', log: [] });

  const last = phases[phases.length - 1];
  emit({
    total: phases.length,
    staged: phases.length > 1,
    last_title: last?.title ?? '',
    last_file: last?.file ?? '',
  });
}

if (import.meta.main) main();

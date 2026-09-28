import { useState, type CSSProperties, type ReactElement } from 'react';
import { RunCard } from '../components/RunCard';
import { ProjectTile } from '../components/ProjectTile';
import { OriginBadge } from '../components/OriginBadge';
import { BuilderPage } from '../builder/BuilderPage';
import { FIXTURES } from '../builder/fixtures';
import { importWorkflowDefinition } from '../builder/model';
import type { Run } from '../primitives/run';
import { AskCard } from '../components/AskCard';
import { AskErrorCard } from '../components/AskErrorCard';
import { parseAskSpec, splitReply, type AskParse, type ReplyPart } from '../primitives/ask';
import { FilesMock } from '../preview/FilesMock';

/**
 * Visual preview of the console's warm palette in context.
 * Route: /console/_preview. Not part of the product flow — a living reference
 * while we pin down the theme.
 */

const baseRun: Omit<Run, 'id' | 'workflow' | 'status'> = {
  projectId: 'demo',
  projectName: 'archon-core',
  costUsd: null,
  conversationId: null,
  parentConversationId: null,
  conversationPlatformId: null,
  workerPlatformId: null,
  parentPlatformId: null,
  origin: 'cli',
  outcome: null,
  startedAt: new Date(Date.now() - 4 * 60 * 1000 - 12 * 1000).toISOString(),
  finishedAt: null,
  lastActivityAt: null,
  workingPath: null,
  userMessage: '',
  activeNodes: [],
};

const SAMPLE_RUNS: Run[] = [
  {
    ...baseRun,
    id: 'a4f2c918-running',
    workflow: 'plan',
    status: 'running',
    activeNodes: ['plan/draft'],
    currentNode: 'plan/draft',
    lastTool: 'read_file',
  },
  {
    ...baseRun,
    id: '8f3d2a1c-paused',
    workflow: 'review',
    origin: 'web',
    status: 'paused',
    outcome: 'succeeded',
    startedAt: new Date(Date.now() - 14 * 60 * 1000 - 22 * 1000).toISOString(),
    approval: {
      nodeId: 'implement/verify',
      message: 'Approve running bun validate?',
      completionSignaled: false,
      decisions: [{ id: 'approve' }, { id: 'reject' }],
      decisionsAuthored: false,
    },
  },
  {
    ...baseRun,
    id: 'c1a5b9d3-failed',
    workflow: 'test',
    origin: 'slack',
    status: 'failed',
    startedAt: new Date(Date.now() - 2 * 60 * 1000 - 41 * 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    lastActivityAt: null,
    currentNode: 'implement/verify',
  },
  {
    ...baseRun,
    id: 'd7e9b4f2-completed',
    workflow: 'implement',
    origin: 'github',
    status: 'completed',
    outcome: 'failed',
    startedAt: new Date(Date.now() - 8 * 60 * 1000 - 14 * 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    lastActivityAt: null,
  },
  {
    ...baseRun,
    id: 'e5b3c742-cancelled',
    workflow: 'assist',
    origin: 'telegram',
    status: 'cancelled',
    startedAt: new Date(Date.now() - 47 * 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    lastActivityAt: null,
  },
];

const SAMPLE_PROJECTS = [
  { id: 'archon-core', name: 'archon-core' },
  { id: 'web-ui', name: 'web-ui' },
  { id: 'cli-tool', name: 'cli-tool' },
  { id: 'infra-ops', name: 'infra-ops' },
  { id: 'mobile-app', name: 'mobile-app' },
  { id: 'ml-pipeline', name: 'ml-pipeline' },
  { id: 'docs-site', name: 'docs-site' },
  { id: 'experiments', name: 'experiments' },
];

interface SwatchProps {
  role: string;
  cssVar: string;
  note?: string;
}

function Swatch({ role, cssVar, note }: SwatchProps): ReactElement {
  const chipStyle: CSSProperties = {
    backgroundColor: `var(${cssVar})`,
  };
  return (
    <div className="flex items-center gap-2.25 rounded border border-border bg-surface px-3 py-1.25">
      <div style={chipStyle} className="h-10 w-10 shrink-0 rounded" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-large font-medium text-text-primary">{role}</div>
        <div className="text-mini text-text-tertiary">{cssVar}</div>
        {note !== undefined ? (
          <div className="mt-0.5 text-small text-text-secondary">{note}</div>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <section className="flex flex-col gap-x-2.25 gap-y-1.75">
      <h2 className="text-small font-medium text-text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

const BUILDER_FIXTURE_KEYS = Object.keys(FIXTURES);

/**
 * Workflow Builder preview: fixture switcher over PR-1's typed fixtures so a
 * reviewer can see all eight node variants rendering with no server running.
 */
function BuilderPreview(): ReactElement {
  const [fixtureKey, setFixtureKey] = useState<string>('mixed');
  const definition = FIXTURES[fixtureKey];
  return (
    <div className="flex flex-col gap-x-2 gap-y-1.25">
      <div className="flex flex-wrap gap-x-2 gap-y-1.25">
        {BUILDER_FIXTURE_KEYS.map(key => (
          <button
            key={key}
            type="button"
            onClick={(): void => {
              setFixtureKey(key);
            }}
            className={`rounded border px-2.5 py-1 text-small transition-colors ${
              key === fixtureKey
                ? 'border-accent-bright/60 bg-surface-elevated text-text-primary'
                : 'border-border bg-surface text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {key}
          </button>
        ))}
      </div>
      <div className="h-[640px] overflow-hidden rounded border border-border">
        {definition !== undefined ? (
          <BuilderPage
            key={fixtureKey}
            initialWorkflow={importWorkflowDefinition(definition, fixtureKey)}
          />
        ) : null}
      </div>
      <p className="text-small text-text-tertiary">
        Fixture-backed only — no server I/O. Drag from the palette, connect nodes, edit in the
        inspector, and watch the YAML tab update.
      </p>
    </div>
  );
}

/**
 * Two questions so the pager, the recommendation and the free-text option are
 * all visible at once. Built through `parseAskSpec` rather than as a literal,
 * so the preview exercises the same path a real reply takes.
 */
const ASK_SAMPLE = parseAskSpec(
  JSON.stringify({
    questions: [
      {
        title: 'What is `framework` now?',
        chip: 'rajababa-io/framework',
        evidence:
          '**Last updated Jul 20** — two months cold, while `claude-skills` and `eng-skills` were both touched today. Exactly one file in `vault` mentions it.',
        options: [
          {
            label: 'Dead — archive it.',
            detail:
              'It was the ambition; skills became the real delivery mechanism. Archiving costs nothing and stops it competing for attention.',
            recommended: true,
            why: 'Two months cold while its two successors got touched today is the whole argument. Archiving is reversible.',
          },
          {
            label: 'Parked, not dead.',
            detail: "There's content in it you intend to come back to.",
          },
          {
            label: 'Still the canonical home for standards.',
            detail: '`claude-skills` and `eng-skills` are the executable layer.',
          },
        ],
      },
      {
        title: 'Is `atlas` still the graph store?',
        chip: 'rajababa-io/atlas',
        options: [
          { label: 'Still the graph store.', detail: 'FalkorDB runs out of it on adina.' },
          {
            label: 'Absorbed by vault.',
            detail: 'The schema files moved in August.',
            recommended: true,
            why: 'Nothing has written to atlas since.',
          },
        ],
      },
    ],
  })
);

/** A multi-answer question, so the preview shows the toggle behavior. */
const ASK_MULTI_SAMPLE = parseAskSpec(
  JSON.stringify({
    questions: [
      {
        title: 'Which of these should the sweep touch?',
        chip: 'rajababa-io',
        multi: true,
        options: [
          { label: 'framework', detail: 'Two months cold.' },
          { label: 'atlas', detail: 'Still serving FalkorDB.' },
          { label: 'wix-access', detail: 'Nothing has referenced it since July.' },
        ],
      },
    ],
  })
);

/**
 * A preview sample, rendered through the same parse result a real reply gets.
 *
 * The samples used to fall back to `{ questions: [] }`, which drew an empty
 * card if one of these literals was ever broken — the preview quietly failing
 * to preview the thing it exists to show. Now a broken sample reports itself.
 */
function AskSample({ parse }: { parse: AskParse }): ReactElement {
  return parse.ok ? (
    <AskCard spec={parse.spec} onAnswer={() => undefined} />
  ) : (
    <AskErrorCard reason={parse.reason} text={'(preview sample)'} />
  );
}

/**
 * The exact mistake this card was built for: an agent writing the schema from
 * memory as `question`/`value`/`description` instead of `title`/`label`/`detail`.
 */
const ASK_BROKEN = [
  '```ask',
  JSON.stringify(
    {
      questions: [
        {
          question: 'Which fix?',
          options: [{ value: 'renderer', description: 'Check in the parser.' }],
        },
      ],
    },
    null,
    2
  ),
  '```',
].join('\n');

/** The malformed block driven through the real `splitReply` path. */
function AskBrokenSample(): ReactElement | null {
  const part = splitReply(ASK_BROKEN).find(
    (p): p is Extract<ReplyPart, { kind: 'ask-error' }> => p.kind === 'ask-error'
  );
  return part === undefined ? null : <AskErrorCard reason={part.reason} text={part.text} />;
}

export function PreviewPage(): ReactElement {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-border px-4.75 py-2.5">
        <h1 className="text-large font-medium text-text-primary">Preview · warm palette</h1>
        <p className="text-small text-text-tertiary">
          Living reference. Not linked from nav. Visit /console/_preview.
        </p>
      </header>

      <main className="mx-auto flex w-full max-w-[1000px] flex-col gap-x-7.5 gap-y-6 px-4.75 py-5">
        <Section title="Files tab · three layouts to choose from">
          <FilesMock />
        </Section>

        <Section title="Workflow Builder · fixture-backed">
          <BuilderPreview />
        </Section>

        <Section title="Run cards · every status">
          <div className="flex flex-col gap-x-2 gap-y-1.25">
            {SAMPLE_RUNS.map(run => (
              <RunCard key={run.id} run={run} showProject={true} />
            ))}
          </div>
        </Section>

        <Section title="Project tiles · hash-based colors">
          <div className="flex flex-wrap gap-x-2.25 gap-y-1.75 rounded border border-border bg-surface p-4">
            {SAMPLE_PROJECTS.map((p, i) => (
              <ProjectTile
                key={p.id}
                projectId={p.id}
                name={p.name}
                selected={i === 0}
                onClick={(): void => {
                  /* preview only */
                }}
              />
            ))}
          </div>
          <p className="text-small text-text-tertiary">
            Color seeded deterministically from project id. First tile shown as the
            currently-selected scope.
          </p>
        </Section>

        <Section title="Origin badges">
          <div className="flex flex-wrap gap-x-2 gap-y-1.25">
            <OriginBadge origin="web" />
            <OriginBadge origin="cli" />
            <OriginBadge origin="slack" />
            <OriginBadge origin="telegram" />
            <OriginBadge origin="discord" />
            <OriginBadge origin="github" />
            <OriginBadge origin="unknown" />
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-x-2.25 gap-y-1.75">
            <button
              type="button"
              className="rounded bg-accent-bright px-3 py-1.5 text-large font-medium text-white/95 transition-opacity hover:brightness-110"
            >
              Primary · Add project
            </button>
            <button
              type="button"
              className="rounded border border-border bg-surface px-3 py-1.5 text-large text-text-primary transition-colors hover:bg-surface-hover"
            >
              Secondary · Cancel
            </button>
            <button
              type="button"
              className="rounded px-3 py-1.5 text-large text-error hover:bg-error/10"
            >
              Destructive · Remove
            </button>
            <button
              type="button"
              className="rounded bg-success/20 px-3 py-1.5 text-large font-medium text-success hover:bg-success/30"
            >
              Approve
            </button>
            <button
              type="button"
              className="rounded px-3 py-1.5 text-large text-error hover:underline"
            >
              Reject
            </button>
          </div>
        </Section>

        <Section title="Surfaces">
          <div className="grid grid-cols-2 gap-x-2.25 gap-y-1.75">
            <Swatch role="Surface" cssVar="--surface" note="main content bg" />
            <Swatch role="Surface inset" cssVar="--surface-inset" note="rail, inner wells" />
            <Swatch
              role="Surface elevated"
              cssVar="--surface-elevated"
              note="dialogs, popovers, selected chips"
            />
            <Swatch
              role="Surface hover"
              cssVar="--surface-hover"
              note="hover state on rows/cards"
            />
          </div>
        </Section>

        <Section title="Text">
          <div className="grid grid-cols-3 gap-x-2.25 gap-y-1.75">
            <Swatch role="Text primary" cssVar="--text-primary" />
            <Swatch role="Text secondary" cssVar="--text-secondary" />
            <Swatch role="Text tertiary" cssVar="--text-tertiary" />
          </div>
        </Section>

        <Section title="Accent (primary CTAs only)">
          <div className="grid grid-cols-3 gap-x-2.25 gap-y-1.75">
            <Swatch
              role="Accent bright"
              cssVar="--accent-bright"
              note="Add project, Submit, primary buttons"
            />
            <Swatch role="Accent" cssVar="--accent" />
            <Swatch role="Accent hover" cssVar="--accent-hover" />
          </div>
        </Section>

        <Section title="Status">
          <div className="grid grid-cols-2 gap-x-2.25 gap-y-1.75 md:grid-cols-3">
            <Swatch
              role="Running"
              cssVar="--running"
              note="active strip (pulsing) + dot; in-progress"
            />
            <Swatch role="Paused" cssVar="--warning" note="approval card, paused dot (pulsing)" />
            <Swatch role="Failed" cssVar="--error" note="failed strip, reject, destructive" />
            <Swatch
              role="Completed"
              cssVar="--success"
              note="completed strip (muted), check icons, Approve"
            />
          </div>
        </Section>

        <Section title="Ask card">
          <AskSample parse={ASK_SAMPLE} />
        </Section>

        <Section title="Ask card — multi-answer">
          <AskSample parse={ASK_MULTI_SAMPLE} />
        </Section>

        <Section title="Ask card — malformed">
          <AskBrokenSample />
        </Section>

        <Section title="Borders">
          <div className="grid grid-cols-2 gap-x-2.25 gap-y-1.75">
            <Swatch role="Border" cssVar="--border" />
            <Swatch role="Border bright" cssVar="--border-bright" />
          </div>
        </Section>
      </main>
    </div>
  );
}

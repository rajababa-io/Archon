import { Suspense, lazy, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Navigate, Routes, Route, useLocation, useNavigate } from 'react-router';
import { ProjectRail } from './components/ProjectRail';
import { DeployOverlay } from './components/DeployOverlay';
import { AddProjectDialog } from './components/AddProjectDialog';
import { ProjectPalette } from './components/ProjectPalette';
import { KeymapHelp } from './components/KeymapHelp';
import { WorkflowsPage } from './routes/WorkflowsPage';
import { BuilderConnected } from './builder/BuilderConnected';
import { RunsPage } from './routes/RunsPage';
import { ProjectLayout } from './routes/ProjectLayout';
import { RunDetailPage } from './routes/RunDetailPage';
import { ChatPage } from './routes/ChatPage';
// Lazy on purpose: react-arborist + CodeMirror are ~170 kB gzip, and a session
// that never opens the Files tab must not pay for them. This import is the only
// thing keeping them out of the initial bundle.
/* eslint-disable-next-line @typescript-eslint/naming-convention --
   A lazily-imported component has to be a module-level const (calling lazy()
   per render would remount the chunk every time), and JSX requires the
   PascalCase name the `variable` rule forbids. */
const FilesPage = lazy(() => import('./routes/FilesPage'));
import { IssuesPage } from './routes/IssuesPage';
import { OverviewPage } from './routes/OverviewPage';
import { PreviewPage } from './routes/PreviewPage';
import { SettingsPage } from './routes/SettingsPage';
import { invalidate } from './store/cache';
import { K } from './store/keys';
import { useKeymap, type Binding } from './lib/keymap';
import { useDashboardSSE } from './lib/sse';
import { SHORTCUTS } from './lib/shortcuts';
import './theme.css';
import './rail.css';

export function ConsoleApp(): ReactElement {
  // Mounted at the ROOT, not per route. The rail renders on every screen and
  // carries live run counts and the chat list, so a subscription that only
  // existed on the routes that happened to show runs left those numbers frozen
  // everywhere else while still looking live. One connection, always open.
  useDashboardSSE();

  const [addOpen, setAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => {
    setRailOpen(false);
  }, [pathname]);

  // `n` (new run) is owned by DraftRunCard's own window listener — only
  // mounted when a project is scoped — and stays there.
  const globalBindings = useMemo<readonly Binding[]>(
    () => [
      {
        keys: ['p'],
        label: 'Pick a project',
        run: (): void => {
          setPaletteOpen(true);
        },
      },
      {
        keys: ['?'],
        label: 'Show help',
        run: (): void => {
          setHelpOpen(v => !v);
        },
      },
      {
        keys: [','],
        label: 'Open settings',
        run: (): void => {
          navigate('/console/settings');
        },
      },
    ],
    [navigate]
  );
  useKeymap({
    bindings: globalBindings,
    enabled: !addOpen && !paletteOpen && !helpOpen,
  });

  return (
    <div className="console-root flex h-screen w-screen flex-col bg-surface text-text-primary">
      <header className="flex items-center gap-2.25 border-b border-border px-3 py-1.25 md:hidden">
        <button
          type="button"
          aria-controls="project-navigation"
          aria-expanded={railOpen}
          onClick={() => {
            setRailOpen(open => !open);
          }}
          className="rounded border border-border px-3 py-1.25"
        >
          {railOpen ? 'Close navigation' : 'Projects and settings'}
        </button>
        <span className="font-medium">Archon</span>
      </header>
      <div className="rail-shell flex min-h-0 flex-1">
        {railOpen ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => {
              setRailOpen(false);
            }}
            className="fixed inset-0 z-20 bg-black/60 md:hidden"
          />
        ) : null}
        <div
          id="project-navigation"
          className={`${railOpen ? 'fixed inset-y-0 left-0 z-30 flex max-w-[calc(100vw-3rem)] shadow-xl' : 'hidden'} md:static md:z-auto md:flex md:max-w-none md:shadow-none`}
        >
          <ProjectRail
            onAddProject={() => {
              setAddOpen(true);
              setRailOpen(false);
            }}
            onSearch={() => {
              setPaletteOpen(true);
              setRailOpen(false);
            }}
          />
        </div>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Routes>
            <Route path="settings" element={<SettingsPage />} />
            <Route path="workflows" element={<WorkflowsPage />} />
            <Route path="builder" element={<BuilderConnected />} />
            <Route path="builder/:name" element={<BuilderConnected />} />
            <Route path="_preview" element={<PreviewPage />} />
            {/* Pathless layout: everything project-scoped shares one header,
                mounted above the page so navigation never unmounts it. */}
            <Route element={<ProjectLayout />}>
              <Route index element={<RunsPage />} />
              <Route path="p/:projectId" element={<RunsPage />} />
              <Route path="p/:projectId/chat" element={<ChatPage />} />
              <Route path="p/:projectId/issues" element={<IssuesPage />} />
              <Route
                path="p/:projectId/files"
                element={
                  <Suspense
                    fallback={
                      <p className="px-4.75 py-2.5 text-body text-text-tertiary">
                        Loading the file viewer...
                      </p>
                    }
                  >
                    <FilesPage />
                  </Suspense>
                }
              />
              <Route path="p/:projectId/overview" element={<OverviewPage />} />
              <Route path="p/:projectId/r/:runId" element={<RunDetailPage />} />
            </Route>
            {/* Project-less run detail: LegacyRedirect resolves an old
                /workflows/runs/:runId bookmark here, where the project is not
                known from the path. It mounts outside ProjectLayout for that
                reason — RunDetailHeader handles the undefined project. */}
            <Route path="r/:runId" element={<RunDetailPage />} />
            <Route path="*" element={<Navigate to="/console" replace />} />
          </Routes>
        </main>
      </div>

      {/* Outside the rail-shell so it covers everything, and last so it stacks
          above the dialogs. Renders for `draining` and `swapping` only. */}
      <DeployOverlay />

      <AddProjectDialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
        }}
        onAdded={project => {
          invalidate(K.projects);
          navigate(`/console/p/${project.id}`);
        }}
      />

      <ProjectPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
        }}
      />

      <KeymapHelp
        open={helpOpen}
        onClose={() => {
          setHelpOpen(false);
        }}
        groups={SHORTCUTS}
      />
    </div>
  );
}

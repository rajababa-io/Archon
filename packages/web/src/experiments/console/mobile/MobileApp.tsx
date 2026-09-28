import { useEffect, useRef, type ReactElement } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router';
import { dashboardStreamKeys, useDashboardSSE } from '../lib/sse';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import { ChatScreen } from './routes/ChatScreen';
import { FileScreen } from './routes/FileScreen';
import { HomeScreen } from './routes/HomeScreen';
import { ProjectScreen } from './routes/ProjectScreen';
import { RunScreen } from './routes/RunScreen';
import { SettingsScreen } from './routes/SettingsScreen';
import { useReturnEpoch } from './lib/return-epoch';
import { useMobileHead } from './lib/head';
import { registerShellWorker } from './lib/service-worker';
import { setAppBadge } from './lib/push';
import { useMobileChats } from './lib/use-mobile-chats';
import { ReachBanner } from './components/ReachBanner';
import { OPEN_PATH_MESSAGE, SHELL_SCOPE } from './pwa/paths';
import { useViewportBox } from './lib/viewport';
import '../theme.css';
import '../rail.css';
import './mobile.css';

/** The dashboard stream, as a component so a key can replace it. */
function DashboardStream(): null {
  useDashboardSSE();
  return null;
}

/**
 * The Home Screen icon's badge follows the needs-you count while the app runs,
 * and the banner says when Archon cannot be reached.
 */
function ShellStatus(): ReactElement | null {
  const { chats, needsYou, reach } = useMobileChats();
  useEffect(() => {
    if (chats !== undefined && reach === 'online') setAppBadge(needsYou);
  }, [chats, needsYou, reach]);
  return <ReachBanner reach={reach} />;
}

/**
 * A tapped notification, when the app was already open: the worker posts the
 * page to show (see `pwa/service-worker.js`), and the app routes to it in place.
 */
function NotificationRouting(): null {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (data?.type !== OPEN_PATH_MESSAGE || typeof data.path !== 'string') return;
      if (data.path.startsWith(SHELL_SCOPE)) void navigate(data.path);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return (): void => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, [navigate]);
  return null;
}

/**
 * The phone shell at `/m`. Shares the console's data layer — skills, cache,
 * streams, primitives and presentational components — and none of its desktop
 * layout. Carries `console-root` because that is where the theme's tokens live.
 */
export function MobileApp(): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useViewportBox(rootRef);
  useMobileHead();
  useEffect(() => {
    registerShellWorker();
  }, []);

  // Back from the background, or back in reach: fresh streams, and everything
  // they would have kept live asked again. The chat screen does the same for
  // its own stream.
  const epoch = useReturnEpoch(() => {
    for (const key of dashboardStreamKeys()) invalidate(key);
    invalidate(K.allConversations);
  });

  return (
    <div ref={rootRef} className="console-root mobile-root bg-surface text-text-primary">
      <DashboardStream key={epoch} />
      <ShellStatus />
      <NotificationRouting />
      <Routes>
        <Route index element={<HomeScreen />} />
        <Route path="c/:conversationId" element={<ChatScreen />} />
        <Route path="p/:projectId/:tab?" element={<ProjectScreen />} />
        <Route path="r/:runId" element={<RunScreen />} />
        <Route path="files/:projectId/*" element={<FileScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/m" replace />} />
      </Routes>
    </div>
  );
}

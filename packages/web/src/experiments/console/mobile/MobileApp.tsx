import { useEffect, useRef, type ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { dashboardStreamKeys, useDashboardSSE } from '../lib/sse';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import { ChatScreen } from './routes/ChatScreen';
import { HomeScreen } from './routes/HomeScreen';
import { useForegroundEpoch } from './lib/foreground';
import { useMobileHead } from './lib/head';
import { registerShellWorker } from './lib/service-worker';
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

  // Back from the background: fresh streams, and everything they would have
  // kept live asked again. The chat screen does the same for its own stream.
  const epoch = useForegroundEpoch(() => {
    for (const key of dashboardStreamKeys()) invalidate(key);
    invalidate(K.allConversations);
  });

  return (
    <div ref={rootRef} className="console-root mobile-root bg-surface text-text-primary">
      <DashboardStream key={epoch} />
      <Routes>
        <Route index element={<HomeScreen />} />
        <Route path="c/:conversationId" element={<ChatScreen />} />
        <Route path="*" element={<Navigate to="/m" replace />} />
      </Routes>
    </div>
  );
}

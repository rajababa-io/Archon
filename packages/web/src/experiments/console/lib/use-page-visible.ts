import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return (): void => {
    document.removeEventListener('visibilitychange', onChange);
  };
}

function snapshot(): boolean {
  return document.visibilityState === 'visible';
}

/** Whether this tab is the one on screen, kept current as the reader leaves and returns. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}

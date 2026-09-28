import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronLeft, ChevronRight, Share, X } from 'lucide-react';
import { swipeOf } from '../lib/gesture';

export interface ViewerImage {
  src: string;
  alt: string;
}

interface ImageViewerProps {
  /** Every image in the chat, in transcript order. */
  images: readonly ViewerImage[];
  start: number;
  onClose: () => void;
}

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;

interface View {
  scale: number;
  x: number;
  y: number;
}
const FITTED: View = { scale: 1, x: 0, y: 0 };

/** The file name a shared image goes by: the last part of its URL's path. */
function fileName(src: string): string {
  try {
    const url = new URL(src, window.location.href);
    const path = url.searchParams.get('path') ?? url.pathname;
    const last = path.split('/').filter(Boolean).at(-1);
    return last ?? 'image';
  } catch {
    return 'image';
  }
}

interface TouchPoint {
  x: number;
  y: number;
}
const point = (t: Touch): TouchPoint => ({ x: t.clientX, y: t.clientY });
const distance = (a: TouchPoint, b: TouchPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * One of the chat's images, full screen: pinch or double-tap to zoom, drag to
 * pan a zoomed image, swipe sideways for the next one and down to close, and
 * Share hands the image file itself to the phone's share sheet.
 */
export function ImageViewer({ images, start, onClose }: ImageViewerProps): ReactElement | null {
  const [index, setIndex] = useState(start);
  const [view, setView] = useState<View>(FITTED);
  const [notice, setNotice] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const image = images[index];

  const go = (step: number): void => {
    setIndex(i => Math.max(0, Math.min(images.length - 1, i + step)));
    setView(FITTED);
    setNotice(null);
  };
  const goRef = useRef(go);
  goRef.current = go;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'ArrowRight') goRef.current(1);
      if (e.key === 'ArrowLeft') goRef.current(-1);
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Raw touch events rather than React's: a pinch has to cancel the page's own
  // zoom, which needs a listener that is not passive.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    let pinch: { distance: number; scale: number } | null = null;
    let drag: { from: TouchPoint; view: View } | null = null;
    let lastTap = 0;

    const down = (e: TouchEvent): void => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (a !== undefined && b !== undefined) {
        pinch = { distance: distance(point(a), point(b)), scale: viewRef.current.scale };
        drag = null;
      } else if (a !== undefined) {
        drag = { from: point(a), view: viewRef.current };
      }
    };
    const move = (e: TouchEvent): void => {
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      if (pinch !== null && a !== undefined && b !== undefined) {
        const scale = Math.max(
          1,
          Math.min(MAX_SCALE, (pinch.scale * distance(point(a), point(b))) / pinch.distance)
        );
        setView(v => (scale === 1 ? FITTED : { ...v, scale }));
      } else if (drag !== null && a !== undefined && drag.view.scale > 1) {
        const from = drag.from;
        const base = drag.view;
        setView({ ...base, x: base.x + a.clientX - from.x, y: base.y + a.clientY - from.y });
      }
    };
    const up = (e: TouchEvent): void => {
      if (e.touches.length > 0) return;
      const wasPinch = pinch !== null;
      pinch = null;
      const end = e.changedTouches[0];
      const began = drag;
      drag = null;
      if (wasPinch || end === undefined || began === null) return;
      const dx = end.clientX - began.from.x;
      const dy = end.clientY - began.from.y;
      if (began.view.scale === 1) {
        const swipe = swipeOf(dx, dy);
        if (swipe === 'left') goRef.current(1);
        else if (swipe === 'right') goRef.current(-1);
        else if (swipe === 'down') closeRef.current();
        if (swipe !== null) return;
      }
      if (Math.hypot(dx, dy) > 10) return;
      const now = Date.now();
      if (now - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0;
        setView(v => (v.scale > 1 ? FITTED : { scale: DOUBLE_TAP_SCALE, x: 0, y: 0 }));
      } else {
        lastTap = now;
      }
    };
    stage.addEventListener('touchstart', down, { passive: true });
    stage.addEventListener('touchmove', move, { passive: false });
    stage.addEventListener('touchend', up, { passive: true });
    stage.addEventListener('touchcancel', up, { passive: true });
    return (): void => {
      stage.removeEventListener('touchstart', down);
      stage.removeEventListener('touchmove', move);
      stage.removeEventListener('touchend', up);
      stage.removeEventListener('touchcancel', up);
    };
  }, []);

  const share = async (): Promise<void> => {
    if (image === undefined) return;
    setNotice(null);
    try {
      const response = await fetch(image.src);
      if (!response.ok) throw new Error(`the image answered ${String(response.status)}`);
      const blob = await response.blob();
      const file = new File([blob], fileName(image.src), { type: blob.type });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: image.alt || file.name });
      } else if (typeof navigator.share === 'function') {
        await navigator.share({ url: new URL(image.src, window.location.href).href });
      } else {
        setNotice('This browser cannot share. Long-press the image to save it instead.');
      }
    } catch (e: unknown) {
      // Closing the share sheet without choosing is not a failure.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setNotice(`Could not share: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  if (image === undefined) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="absolute inset-0 z-50 flex flex-col bg-black text-white"
    >
      <header className="mobile-safe-top flex shrink-0 items-center justify-between px-2 pb-1">
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="mobile-tap flex items-center justify-center"
        >
          <X aria-hidden className="h-6 w-6" />
        </button>
        <span className="text-small tabular-nums opacity-80">
          {String(index + 1)} / {String(images.length)}
        </span>
        <button
          type="button"
          aria-label="Share"
          onClick={() => {
            void share();
          }}
          className="mobile-tap flex items-center justify-center"
        >
          <Share aria-hidden className="h-5 w-5" />
        </button>
      </header>
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden"
        onDoubleClick={() => {
          setView(v => (v.scale > 1 ? FITTED : { scale: DOUBLE_TAP_SCALE, x: 0, y: 0 }));
        }}
      >
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          className="max-h-full max-w-full object-contain select-none"
          style={{
            transform: `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.scale)})`,
          }}
        />
        {index > 0 ? (
          <button
            type="button"
            aria-label="Previous image"
            onClick={() => {
              go(-1);
            }}
            className="mobile-tap absolute left-1 flex items-center justify-center rounded-full bg-black/40"
          >
            <ChevronLeft aria-hidden className="h-6 w-6" />
          </button>
        ) : null}
        {index < images.length - 1 ? (
          <button
            type="button"
            aria-label="Next image"
            onClick={() => {
              go(1);
            }}
            className="mobile-tap absolute right-1 flex items-center justify-center rounded-full bg-black/40"
          >
            <ChevronRight aria-hidden className="h-6 w-6" />
          </button>
        ) : null}
      </div>
      <footer className="mobile-sheet shrink-0 px-4 pb-2 text-center text-small opacity-80">
        {notice ?? (image.alt !== '' ? image.alt : null)}
      </footer>
    </div>
  );
}

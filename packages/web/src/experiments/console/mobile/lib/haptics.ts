/** Long enough to feel, short enough to read as a tick rather than a buzz. */
const TICK_MS = 8;

/**
 * A short haptic tick where the browser offers vibration — Android Chrome.
 * iOS Safari has no vibration API, so a tap there is silent.
 */
export function tick(): void {
  if ('vibrate' in navigator) navigator.vibrate(TICK_MS);
}

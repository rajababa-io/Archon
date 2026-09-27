import { describe, expect, test } from 'bun:test';
import { resolveChatsConfig } from './chats';

describe('resolveChatsConfig', () => {
  test('the defaults are about sharpness, not capacity', () => {
    const c = resolveChatsConfig(undefined);
    expect(c.nudgeAt).toBeCloseTo(0.4);
    expect(c.handoffAt).toBeCloseTo(0.5);
    expect(c.autoHandoff).toBe(true);
    expect(c.suggestNextMessage).toBe(true);
  });

  test('suggested next messages can be switched off', () => {
    expect(resolveChatsConfig({ suggestNextMessage: false }).suggestNextMessage).toBe(false);
  });

  test('percentages become fractions', () => {
    const c = resolveChatsConfig({ nudgeAtPercent: 25, handoffAtPercent: 60 });
    expect(c.nudgeAt).toBeCloseTo(0.25);
    expect(c.handoffAt).toBeCloseTo(0.6);
  });

  test('a value that cannot be meant is refused, not honoured', () => {
    // 0 would hand off on the first turn; 100 could never fire. Both are
    // silently useless in a way nobody discovers for days.
    expect(resolveChatsConfig({ handoffAtPercent: 0 }).handoffAt).toBeCloseTo(0.5);
    expect(resolveChatsConfig({ handoffAtPercent: 100 }).handoffAt).toBeCloseTo(0.5);
    expect(resolveChatsConfig({ handoffAtPercent: Number.NaN }).handoffAt).toBeCloseTo(0.5);
  });

  test('a nudge above the handoff point is refused — it would announce what already happened', () => {
    const c = resolveChatsConfig({ nudgeAtPercent: 70, handoffAtPercent: 50 });
    expect(c.nudgeAt).toBeCloseTo(0.4);
    expect(c.handoffAt).toBeCloseTo(0.5);
  });

  test('automation can be turned off without losing the threshold', () => {
    const c = resolveChatsConfig({ handoffAtPercent: 45, autoHandoff: false });
    expect(c.handoffAt).toBeCloseTo(0.45);
    expect(c.autoHandoff).toBe(false);
  });

  test('the percentages come back exact, not reconstructed from the fraction', () => {
    // The settings editor reads these. `0.4 * 100` is 40.00000000000001 in
    // floating point, so a caller converting back would put that in a form
    // field — hence toBe, not toBeCloseTo. This is the assertion that would
    // catch someone "simplifying" these away into a multiplication.
    const c = resolveChatsConfig({ nudgeAtPercent: 40, handoffAtPercent: 55 });
    expect(c.nudgeAtPercent).toBe(40);
    expect(c.handoffAtPercent).toBe(55);
  });

  test('a refused percentage reports the default it fell back to, not the input', () => {
    // Both representations describe the same decision, so they cannot
    // disagree: showing 70 in the editor while nudging at 40 is the dead
    // setting again, one field down.
    const c = resolveChatsConfig({ nudgeAtPercent: 70, handoffAtPercent: 50 });
    expect(c.nudgeAtPercent).toBe(40);
    expect(c.nudgeAt).toBeCloseTo(c.nudgeAtPercent / 100);
    expect(c.handoffAtPercent).toBe(50);
    expect(c.handoffAt).toBeCloseTo(c.handoffAtPercent / 100);
  });

  test('the CI wait alarm defaults to 20 minutes and keeps a usable value', () => {
    expect(resolveChatsConfig(undefined).ciWaitAlarmMinutes).toBe(20);
    expect(resolveChatsConfig({ ciWaitAlarmMinutes: 35 }).ciWaitAlarmMinutes).toBe(35);
  });

  test('a CI alarm that could never show, or is not whole minutes, falls back to the default', () => {
    // Past 24 hours the watch has already given up, so the alarm can never
    // appear; zero would mark every wait overdue the moment it starts.
    for (const bad of [0, -5, 12.5, Number.NaN, 24 * 60 + 1]) {
      expect(resolveChatsConfig({ ciWaitAlarmMinutes: bad }).ciWaitAlarmMinutes).toBe(20);
    }
    expect(resolveChatsConfig({ ciWaitAlarmMinutes: 24 * 60 }).ciWaitAlarmMinutes).toBe(24 * 60);
  });
});

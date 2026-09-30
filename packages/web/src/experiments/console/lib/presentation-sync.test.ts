import { describe, expect, it } from 'bun:test';
import { displayNameStep } from './presentation-sync';

describe('displayNameStep', () => {
  it("takes the server's rename over this browser's", () => {
    expect(displayNameStep({ displayName: 'Scratch' }, 'old')).toEqual({
      kind: 'apply',
      value: 'Scratch',
    });
  });

  it('applies a rename cleared on another machine', () => {
    expect(displayNameStep({ displayName: null }, 'Scratch')).toEqual({
      kind: 'apply',
      value: null,
    });
  });

  it('does nothing when both already agree', () => {
    expect(displayNameStep({ displayName: 'Scratch' }, 'Scratch')).toEqual({ kind: 'none' });
    expect(displayNameStep({ displayName: null }, null)).toEqual({ kind: 'none' });
  });

  it('uploads a rename the server has never held', () => {
    expect(displayNameStep({ color: 'green' }, 'Scratch')).toEqual({ kind: 'push' });
    expect(displayNameStep(null, 'Scratch')).toEqual({ kind: 'push' });
  });

  it('never uploads an absent rename — a new phone must not wipe the desktop', () => {
    expect(displayNameStep({ color: 'green' }, null)).toEqual({ kind: 'none' });
    expect(displayNameStep(null, null)).toEqual({ kind: 'none' });
  });
});

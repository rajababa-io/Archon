import { useCallback, useEffect, useState } from 'react';
import * as skill from '../../skills';
import type { PushPrefs, PushPrefsChange } from '../../skills';
import { errorDetail } from '../../lib/http';
import { set, useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushAvailability,
  readPushEnvironment,
  type PushAvailability,
} from './push';

export interface PushPrefsView {
  prefs: PushPrefs | undefined;
  error: Error | undefined;
  saving: boolean;
  failure: string | null;
  change: (change: PushPrefsChange) => Promise<void>;
}

/** What to be told about, and one change at a time to it. */
export function usePushPrefs(): PushPrefsView {
  const { data, error } = useEntity(K.pushPrefs, skill.getPushPrefs);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const change = useCallback(async (next: PushPrefsChange): Promise<void> => {
    setSaving(true);
    setFailure(null);
    try {
      set(K.pushPrefs, await skill.changePushPrefs(next));
    } catch (e) {
      setFailure(errorDetail(e));
    } finally {
      setSaving(false);
    }
  }, []);
  return { prefs: data, error, saving, failure, change };
}

export interface PushDeviceView {
  availability: PushAvailability;
  /** Null until this device's subscription has been read. */
  subscribed: boolean | null;
  busy: boolean;
  failure: string | null;
  /** Must be called from a tap. */
  enable: (publicKey: string) => Promise<void>;
  disable: () => Promise<void>;
}

/** Push on THIS device: whether it can be on, whether it is, and the switch. */
export function usePushDevice(): PushDeviceView {
  const [availability, setAvailability] = useState<PushAvailability>(() =>
    pushAvailability(readPushEnvironment())
  );
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (availability === 'install-first' || availability === 'unsupported') {
      setSubscribed(false);
      return;
    }
    let live = true;
    currentSubscription()
      .then(sub => {
        if (live) setSubscribed(sub !== null);
      })
      .catch((e: unknown) => {
        if (live) setFailure(errorDetail(e));
      });
    return (): void => {
      live = false;
    };
  }, [availability]);

  const act = useCallback(async (work: () => Promise<void>, on: boolean): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      setSubscribed(on);
    } catch (e) {
      setFailure(errorDetail(e));
    } finally {
      // A refused prompt changes what this device can do from here.
      setAvailability(pushAvailability(readPushEnvironment()));
      setBusy(false);
    }
  }, []);

  return {
    availability,
    subscribed,
    busy,
    failure,
    enable: publicKey => act(() => enablePush(publicKey), true),
    disable: () => act(disablePush, false),
  };
}

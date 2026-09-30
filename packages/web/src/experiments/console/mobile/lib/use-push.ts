import { useCallback, useEffect, useState } from 'react';
import * as skill from '../../skills';
import type { PushDevice, PushPrefs, PushPrefsChange } from '../../skills';
import { errorDetail } from '../../lib/http';
import { invalidate, set, useEntity } from '../../store/cache';
import { K } from '../../store/keys';
import {
  disablePush,
  enablePush,
  pushAvailability,
  readPushEnvironment,
  thisPushDevice,
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
  /** The server's id for this device while push is on here; null otherwise. */
  deviceId: string | null;
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
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (availability === 'install-first' || availability === 'unsupported') {
      setSubscribed(false);
      return;
    }
    let live = true;
    thisPushDevice()
      .then(id => {
        if (!live) return;
        setDeviceId(id);
        setSubscribed(id !== null);
      })
      .catch((e: unknown) => {
        if (live) setFailure(errorDetail(e));
      });
    return (): void => {
      live = false;
    };
  }, [availability]);

  /** `work` answers this device's id once it is on, or null once it is off. */
  const act = useCallback(async (work: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const id = await work();
      setDeviceId(id);
      setSubscribed(id !== null);
    } catch (e) {
      setFailure(errorDetail(e));
    } finally {
      // A refused prompt changes what this device can do from here.
      setAvailability(pushAvailability(readPushEnvironment()));
      setBusy(false);
      invalidate(K.pushDevices);
    }
  }, []);

  return {
    availability,
    subscribed,
    deviceId,
    busy,
    failure,
    enable: publicKey => act(() => enablePush(publicKey)),
    disable: () =>
      act(async () => {
        await disablePush();
        return null;
      }),
  };
}

export interface PushDevicesView {
  devices: PushDevice[] | undefined;
  error: Error | undefined;
  /** The id being removed, while a removal is in flight. */
  removing: string | null;
  failure: string | null;
  remove: (id: string) => Promise<void>;
}

/** Every browser registered for push, and forgetting one of them by id. */
export function usePushDevices(): PushDevicesView {
  const { data, error } = useEntity(K.pushDevices, skill.listPushDevices);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const remove = useCallback(async (id: string): Promise<void> => {
    setRemoving(id);
    setFailure(null);
    try {
      await skill.removePushDevice(id);
    } catch (e) {
      setFailure(errorDetail(e));
    } finally {
      setRemoving(null);
      invalidate(K.pushDevices);
    }
  }, []);
  return { devices: data, error, removing, failure, remove };
}

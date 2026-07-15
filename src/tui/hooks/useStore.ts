import { useEffect, useState } from 'react';
import type { SessionStore } from '../../core/store.js';
import type { Snapshot } from '../../core/types.js';

export function useStore(store: SessionStore): Snapshot | undefined {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(store.snapshot);
  useEffect(() => {
    const onSnapshot = (s: Snapshot) => setSnapshot(s);
    store.on('snapshot', onSnapshot);
    store.on('error', () => {});
    store.start();
    return () => {
      store.off('snapshot', onSnapshot);
      store.stop();
    };
  }, [store]);

  // 1s heartbeat so relative clocks ("2m ago") stay honest between snapshots
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return snapshot;
}

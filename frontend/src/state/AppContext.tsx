import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import PocketBase from 'pocketbase';
import { getClient, saolrianSend } from '../lib/pb';
import { getStoredEndpoint, setStoredEndpoint as persistEndpoint, getStoredTheme, setStoredTheme as persistTheme, getStoredMode, setStoredMode, type ThemeMode } from '../lib/storage';
import { useOfflineFlush } from '../lib/offline';
import type { MealSlot, Profile } from '../lib/types';

/** Small state layer: the PocketBase client + current profile + meal slots,
 * with refresh functions. Screens read everything from here. */

interface AppState {
  endpoint: string;
  pb: PocketBase | null;
  profile: Profile | null;
  slots: MealSlot[];
  latestWeight: number | null;
  theme: string;
  mode: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
  refreshProfile: () => Promise<void>;
  refreshSlots: () => Promise<void>;
  setEndpoint: (url: string) => void;
  clearEndpoint: () => void;
  setTheme: (color: string) => void;
  userId: string | null;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [endpoint, setEndpointState] = useState<string>(() => getStoredEndpoint());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [slots, setSlots] = useState<MealSlot[]>([]);
  const [latestWeight, setLatestWeight] = useState<number | null>(null);
  const [theme, setThemeState] = useState<string>(() => getStoredTheme() || '#0f7a5f');
  const [mode, setModeState] = useState<ThemeMode>(() => getStoredMode());
  const [systemDark, setSystemDark] = useState<boolean>(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);

  const setMode = useCallback((m: ThemeMode) => {
    setStoredMode(m);
    setModeState(m);
  }, []);
  // PocketBase's authStore is external mutable state React can't see —
  // bump this counter whenever auth changes so the Gate re-renders.
  const [authVersion, setAuthVersion] = useState(0);
  const bumpAuth = useCallback(() => setAuthVersion((v) => v + 1), []);

  const refreshProfile = useCallback(async () => {
    if (!endpoint) return;
    const pb = getClient(endpoint);
    if (!pb.authStore.isValid) return;
    try {
      const recs = await pb.collection('profiles').getFullList({
        filter: `user="${pb.authStore.record?.id}"`,
      });
      setProfile((recs[0] as unknown as Profile) ?? null);
      try {
        const w = await pb.collection('weights').getList(1, 1, {
          filter: `user="${pb.authStore.record?.id}"`,
          sort: '-measured_at',
        });
        setLatestWeight((w.items[0]?.['kg'] as number | undefined) ?? null);
      } catch {
        setLatestWeight(null);
      }
    } catch {
      setProfile(null);
    }
  }, [endpoint]);

  const refreshSlots = useCallback(async () => {
    if (!endpoint) return;
    const pb = getClient(endpoint);
    if (!pb.authStore.isValid) return;
    try {
      const recs = await pb.collection('meal_slots').getFullList({
        filter: `user="${pb.authStore.record?.id}"`,
        sort: 'sort_order',
      });
      setSlots(recs as unknown as MealSlot[]);
    } catch {
      setSlots([]);
    }
  }, [endpoint]);

  useEffect(() => {
    if (endpoint && getClient(endpoint).authStore.isValid) {
      void refreshProfile();
      void refreshSlots();
    }
  }, [endpoint, refreshProfile, refreshSlots, authVersion]);

  // React to auth changes (sign-in, sign-out) from anywhere in the app.
  useEffect(() => {
    if (!endpoint) return;
    const pb = getClient(endpoint);
    const unsub = pb.authStore.onChange(() => {
      bumpAuth();
      if (pb.authStore.isValid) {
        void refreshProfile();
        void refreshSlots();
      }
    });
    return unsub;
  }, [endpoint, bumpAuth, refreshProfile, refreshSlots]);

  // Reflect theme on :root as a live CSS variable.
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolvedTheme === 'dark' ? '#0c1622' : theme);
  }, [theme, resolvedTheme]);

  const setEndpoint = useCallback((url: string) => {
    persistEndpoint(url);
    setEndpointState(url);
  }, []);

  const clearEndpoint = useCallback(() => {
    try {
      localStorage.removeItem('saolrian-endpoint');
    } catch {
      /* ignore */
    }
    setProfile(null);
    setSlots([]);
    setLatestWeight(null);
    setEndpointState('');
  }, []);

  const setTheme = useCallback((color: string) => {
    persistTheme(color);
    setThemeState(color);
  }, []);

  const userId = useMemo(() => {
    if (!endpoint) return null;
    const pb = getClient(endpoint);
    return pb.authStore.isValid ? pb.authStore.record?.id ?? null : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, authVersion]);

  // Flush the offline diary queue whenever connectivity returns.
  useOfflineFlush();

  const value = useMemo<AppState>(
    () => ({
      endpoint,
      pb: endpoint ? getClient(endpoint) : null,
      profile,
      slots,
      latestWeight,
      theme,
      mode,
      resolvedTheme,
      setMode,
      refreshProfile,
      refreshSlots,
      setEndpoint,
      clearEndpoint,
      setTheme,
      userId,
    }),
    [endpoint, profile, slots, latestWeight, theme, mode, resolvedTheme, setMode, refreshProfile, refreshSlots, setEndpoint, clearEndpoint, setTheme, userId],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}

export { saolrianSend };

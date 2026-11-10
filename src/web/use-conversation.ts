import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ConversationEntry, ConversationPage, Run, Snapshot } from '../shared/types.ts';
import { api } from './api.ts';

type Window = ConversationPage & { projectId: string };
type Direction = 'before' | 'after' | 'latest';
const empty = { entries: [], hasBefore: false, hasAfter: false };

/** The window is the only owner of historical bodies; discarded entries are fetched again. */
export function useConversation(
  projectId: string | undefined,
  revision: Snapshot | undefined,
  following: RefObject<boolean>,
) {
  const [window, setWindow] = useState<Window>({ ...empty, projectId: '' });
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ direction: Direction | 'refresh'; error: Error }>();
  const [refreshTick, setRefreshTick] = useState(0);
  const [settledRuns, setSettledRuns] = useState<{ projectId: string; runs: Run[] }>();
  const refreshPending = useRef(false);
  const current = useRef(window);
  current.current = window;
  const generation = useRef(0);
  const pending = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);

  const load = useCallback(
    async (direction: Direction, liveUpdate = false) => {
      if (!projectId) return;
      if (pending.current) {
        if (liveUpdate) refreshPending.current = true;
        return;
      }
      const ticket = generation.current;
      const prior = current.current;
      const cursor =
        direction === 'before'
          ? prior.entries[0]?.cursor
          : direction === 'after'
            ? prior.entries.at(-1)?.cursor
            : undefined;
      if (direction !== 'latest' && !cursor) return;
      pending.current = true;
      setLoading(true);
      setFailure(undefined);
      try {
        const suffix = cursor ? `?${direction}=${encodeURIComponent(cursor)}` : '';
        const page = await api<ConversationPage>(
          `/projects/${projectId}/messages${suffix}`,
          undefined,
          'GET',
          controller.current?.signal,
        );
        if (ticket !== generation.current) return;
        setWindow((previous) => {
          if (liveUpdate && !following.current) {
            const known = new Set(previous.entries.map((entry) => entry.cursor));
            const additions = page.entries.filter((entry) => !known.has(entry.cursor));
            const overlaps = page.entries.some((entry) => known.has(entry.cursor));
            if (overlaps && previous.entries.length + additions.length <= 150)
              return { ...previous, entries: [...previous.entries, ...additions], hasAfter: false };
            return { ...previous, hasAfter: previous.hasAfter || additions.length > 0 };
          }
          if (direction === 'latest') return { ...page, projectId };
          const combined =
            direction === 'before'
              ? [...page.entries, ...previous.entries]
              : [...previous.entries, ...page.entries];
          const entries = [...new Map(combined.map((entry) => [entry.cursor, entry])).values()];
          const trimmed = entries.length > 150;
          return {
            projectId,
            entries: direction === 'before' ? entries.slice(0, 150) : entries.slice(-150),
            hasBefore: direction === 'before' ? page.hasBefore : previous.hasBefore || trimmed,
            hasAfter: direction === 'after' ? page.hasAfter : previous.hasAfter || trimmed,
          };
        });
        return true;
      } catch (error) {
        if (ticket === generation.current)
          setFailure({
            direction: liveUpdate ? 'refresh' : direction,
            error: error instanceof Error ? error : new Error(String(error)),
          });
      } finally {
        if (ticket === generation.current) {
          pending.current = false;
          setLoading(false);
          if (refreshPending.current) {
            refreshPending.current = false;
            setRefreshTick((value) => value + 1);
          }
        }
      }
    },
    [projectId, following],
  );

  useEffect(() => {
    generation.current++;
    controller.current = new AbortController();
    pending.current = false;
    refreshPending.current = false;
    current.current = { ...empty, projectId: projectId ?? '' };
    setWindow(current.current);
    setFailure(undefined);
    void load('latest');
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [projectId, load]);

  useEffect(() => {
    if (!projectId || current.current.projectId !== projectId) return;
    if (pending.current) {
      refreshPending.current = true;
      return;
    }
    const ticket = generation.current;
    const retained = current.current;
    if (!retained.entries.length) {
      void load('latest');
      return;
    }
    let alive = true;
    const refreshController = new AbortController();
    async function refresh() {
      const updates: ConversationEntry[] = [];
      for (let start = 0; start < retained.entries.length; start += 50) {
        const ids = retained.entries.slice(start, start + 50).map((entry) => entry.cursor);
        const page = await api<ConversationPage>(
          `/projects/${projectId}/messages?ids=${encodeURIComponent(ids.join(','))}`,
          undefined,
          'GET',
          refreshController.signal,
        );
        if (!alive || ticket !== generation.current) return;
        updates.push(...page.entries);
      }
      const replacements = new Map(updates.map((entry) => [entry.cursor, entry]));
      setWindow((previous) => ({
        ...previous,
        entries: previous.entries.map((entry) => replacements.get(entry.cursor) ?? entry),
      }));
      if (!current.current.hasAfter && !(await load('latest', true))) return;
      if (alive && ticket === generation.current)
        setSettledRuns({
          projectId: retained.projectId,
          runs: revision?.runs.filter((run) => run.projectId === projectId) ?? [],
        });
    }
    void refresh().catch((error: unknown) => {
      if (alive && ticket === generation.current)
        setFailure({
          direction: 'refresh',
          error: error instanceof Error ? error : new Error(String(error)),
        });
    });
    return () => {
      alive = false;
      refreshController.abort();
    };
  }, [revision, projectId, load, refreshTick]);

  const visible = window.projectId === projectId ? window : empty;
  return {
    ...visible,
    loading,
    failure,
    runs:
      settledRuns && settledRuns.projectId === projectId
        ? settledRuns.runs
        : (revision?.runs.filter((run) => run.projectId === projectId) ?? []),
    load,
    retry: () => {
      if (failure?.direction === 'refresh') {
        setFailure(undefined);
        setRefreshTick((value) => value + 1);
        return;
      }
      return load(failure?.direction ?? 'latest');
    },
    messages: visible.entries.flatMap((entry) => (entry.kind === 'message' ? [entry.value] : [])),
    activities: visible.entries.flatMap((entry) =>
      entry.kind === 'activity' ? [entry.value] : [],
    ),
  };
}

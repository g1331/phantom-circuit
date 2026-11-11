import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowPage } from '../shared/intake.ts';
import { api } from './api.ts';

export function useWorkflow(projectId: string, revision?: number) {
  const [result, setResult] = useState<{ projectId: string; page: WorkflowPage }>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const retained = useRef(result);
  const page = result?.projectId === projectId ? result.page : undefined;

  useEffect(() => {
    retained.current = result;
  }, [result]);

  const load = useCallback(
    async (before?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      try {
        const query = before ? `&before=${encodeURIComponent(before)}` : '';
        let incoming = await api<WorkflowPage>(
          `/projects/${projectId}/workflow?limit=30${query}`,
          undefined,
          'GET',
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const previous = retained.current;
        if (!before && previous?.projectId === projectId) {
          const oldest = previous.page.inputs.at(-1)?.input.id;
          const inputs = [...incoming.inputs];
          let tail = incoming;
          while (oldest && tail.next && !inputs.some((entry) => entry.input.id === oldest)) {
            tail = await api<WorkflowPage>(
              `/projects/${projectId}/workflow?limit=30&before=${encodeURIComponent(tail.next)}`,
              undefined,
              'GET',
              controller.signal,
            );
            if (controller.signal.aborted) return;
            inputs.push(...tail.inputs);
          }
          incoming = { ...incoming, inputs, next: tail.next };
        }
        setResult((previous) => {
          const current = previous?.projectId === projectId ? previous.page : undefined;
          const retain = current && before;
          const merged = retain
            ? new Map(current.inputs.map((entry) => [entry.input.id, entry]))
            : new Map<string, WorkflowPage['inputs'][number]>();
          for (const entry of incoming.inputs) merged.set(entry.input.id, entry);
          return {
            projectId,
            page: {
              ...incoming,
              inputs: [...merged.values()].sort(
                (a, b) =>
                  b.input.observedAt.localeCompare(a.input.observedAt) ||
                  b.input.updatedAt.localeCompare(a.input.updatedAt),
              ),
              next: incoming.next,
            },
          };
        });
        setError(undefined);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error(String(cause)));
      } finally {
        if (request.current === controller) {
          request.current = undefined;
          if (!controller.signal.aborted) setLoading(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      if (!document.hidden && !request.current) void load();
    }, 5000);
    return () => {
      clearInterval(interval);
      request.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!request.current) void load();
  }, [load, revision]);

  return {
    page,
    error,
    loading,
    refresh: () => load(),
    more: () => (page?.next ? load(page.next) : Promise.resolve()),
  };
}

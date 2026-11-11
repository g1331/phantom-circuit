import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowPage } from '../shared/intake.ts';
import { api } from './api.ts';

type Entries = WorkflowPage['inputs'];

export function useInputSummaries(projectId: string, ids: string[], revision?: number) {
  const key = [...new Set(ids)].sort().join(',');
  const [result, setResult] = useState<{ projectId: string; entries: Entries }>();
  const [error, setError] = useState<Error>();
  const request = useRef<AbortController | undefined>(undefined);
  const read = useCallback(async () => {
    if (!key || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    try {
      const inputIds = key.split(',');
      const batches: Promise<Entries>[] = [];
      for (let index = 0; index < inputIds.length; index += 50) {
        const batch = encodeURIComponent(inputIds.slice(index, index + 50).join(','));
        batches.push(
          api<Entries>(
            `/projects/${projectId}/workflow/inputs?ids=${batch}`,
            undefined,
            'GET',
            controller.signal,
          ),
        );
      }
      const entries = (await Promise.all(batches)).flat();
      if (controller.signal.aborted) return;
      setResult({ projectId, entries });
      setError(undefined);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }, [projectId, key]);

  useEffect(() => {
    void read();
    if (!key) return;
    const interval = setInterval(() => {
      if (!document.hidden) void read();
    }, 5000);
    return () => {
      clearInterval(interval);
      request.current?.abort();
      request.current = undefined;
    };
  }, [read, key]);

  useEffect(() => {
    void read();
  }, [read, revision]);

  return {
    entries: result?.projectId === projectId ? result.entries : [],
    error: key ? error : undefined,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowInputDetail } from '../shared/intake.ts';
import { api } from './api.ts';

export function useInputDetail(
  inputId: string,
  onChange: () => Promise<void>,
  beforeUpdate: () => void,
) {
  const [detail, setDetail] = useState<WorkflowInputDetail>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);

  const read = useCallback(async () => {
    if (request.current || acting.current) return;
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await api<WorkflowInputDetail>(
        `/inputs/${encodeURIComponent(inputId)}`,
        undefined,
        'GET',
        controller.signal,
      );
      if (controller.signal.aborted) return;
      beforeUpdate();
      setDetail(result);
      setError('');
    } catch (cause) {
      if (!controller.signal.aborted) setError(String(cause));
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }, [inputId, beforeUpdate]);

  useEffect(() => {
    void read();
    const interval = setInterval(() => {
      if (!document.hidden) void read();
    }, 5000);
    return () => {
      clearInterval(interval);
      request.current?.abort();
      request.current = undefined;
    };
  }, [read]);

  async function act(action: 'retry' | 'reconcile-reply') {
    acting.current = true;
    request.current?.abort();
    request.current = undefined;
    setBusy(true);
    setError('');
    try {
      const result = await api<WorkflowInputDetail>(`/inputs/${inputId}/${action}`, {});
      beforeUpdate();
      setDetail(result);
      await onChange();
    } catch (cause) {
      setError(String(cause));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  return { detail, error, busy, act };
}

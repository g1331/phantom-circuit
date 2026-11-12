import type { Run } from './types.ts';

export function runTiming(run: Run, now: number) {
  const started = Date.parse(run.startedAt);
  const active = !run.endedAt && ['running', 'waiting'].includes(run.status);
  const ended = run.endedAt ? Date.parse(run.endedAt) : active ? now : NaN;
  const interval =
    Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
  // Frozen duration is authoritative; an active Run always derives from its start.
  const durationMs =
    !active &&
    typeof run.durationMs === 'number' &&
    Number.isFinite(run.durationMs) &&
    run.durationMs >= 0
      ? run.durationMs
      : interval;
  return { durationMs, started, ended, interval, active };
}

/** Sum each Run once. Parallel execution can exceed the first-to-last wall clock. */
export function taskTiming(runs: Run[], now: number) {
  const records = runs.map((run) => runTiming(run, now));
  const durations = records.flatMap((record) =>
    record.durationMs === null ? [] : [record.durationMs],
  );
  const intervals = records.filter((record) => record.interval !== null);
  return {
    durationMs: durations.length ? durations.reduce((total, value) => total + value, 0) : null,
    durationPartial: durations.length < records.length,
    elapsedMs: intervals.length
      ? Math.max(...intervals.map((record) => record.ended)) -
        Math.min(...intervals.map((record) => record.started))
      : null,
    elapsedPartial: intervals.length < records.length,
    active: records.some((record) => record.active),
  };
}

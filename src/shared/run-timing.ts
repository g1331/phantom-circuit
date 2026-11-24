import type { Run, Task } from './types.ts';

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
export function taskTiming(runs: Run[], now: number, task: Pick<Task, 'stage' | 'endedAt'>) {
  const finished = ['done', 'cancelled'].includes(task.stage);
  const records = runs.map((run) => runTiming(run, now));
  const durations = records.flatMap((record) =>
    record.durationMs === null ? [] : [record.durationMs],
  );
  const intervals = records.filter((record) =>
    finished ? record.interval !== null : Number.isFinite(record.started) && record.started <= now,
  );
  const taskEnded = finished && task.endedAt ? Date.parse(task.endedAt) : NaN;
  const validStarts = Number.isFinite(taskEnded)
    ? (intervals.length
        ? intervals
        : records.filter((record) => Number.isFinite(record.started) && record.started <= taskEnded)
      ).map((record) => record.started)
    : intervals.map((record) => record.started);
  const maxRunEnd = intervals.length ? Math.max(...intervals.map((record) => record.ended)) : NaN;
  // Waiting ends with the Task, even when every Run has already stopped.
  const ended = !finished
    ? now
    : Number.isFinite(taskEnded)
      ? Number.isFinite(maxRunEnd)
        ? Math.max(taskEnded, maxRunEnd)
        : taskEnded
      : maxRunEnd;
  return {
    durationMs: durations.length ? durations.reduce((total, value) => total + value, 0) : null,
    durationPartial: durations.length < records.length,
    elapsedMs:
      validStarts.length && Number.isFinite(ended)
        ? Math.max(0, ended - Math.min(...validStarts))
        : null,
    elapsedPartial: intervals.length < records.length,
    active: records.some((record) => record.active) || (!finished && intervals.length > 0),
  };
}

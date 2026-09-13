import type { PMActivity, Run } from '../shared/types.ts';
import { Store } from './store.ts';
import { bounded, redactValue } from './redaction.ts';

function argumentPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(argumentPaths);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    if (/^(?:path|paths|filePath|file_path|cwd|workdir|worktree)$/i.test(key)) {
      if (typeof child === 'string') return [child];
      if (Array.isArray(child)) return child.filter((v): v is string => typeof v === 'string');
    }
    return argumentPaths(child);
  });
}

// Only explicitly readable summaries and structured actions cross this seam.
export class PMActivities {
  private pending = new Map<
    string,
    { kind: 'summary' | 'plan' | 'message'; parts: Map<number, string>; dirty: boolean }
  >();
  private timer?: NodeJS.Timeout;
  constructor(
    private store: Store,
    private run: Run,
  ) {}
  private flush(final = false) {
    for (const [key, entry] of this.pending) {
      if (!entry.dirty) continue;
      const raw = [...entry.parts]
        .sort(([a], [b]) => a - b)
        .map(([, text]) => text)
        .join('\n');
      // Hold the unfinished line: a credential can span any number of protocol deltas.
      const text = bounded(final ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1));
      if (text) {
        if (entry.kind === 'message')
          this.store.changes.emit('delta', {
            projectId: this.run.projectId,
            runId: this.run.id,
            role: 'pm',
            text,
            replace: true,
          });
        else
          this.store.activity(this.run, key, {
            kind: entry.kind,
            title: entry.kind === 'summary' ? '分析摘要' : '计划',
            status: 'running',
            details: { summary: text },
          });
      }
      entry.dirty = false;
    }
  }
  close() {
    if (this.timer) clearTimeout(this.timer);
    for (const entry of this.pending.values()) entry.dirty = true;
    this.flush(true);
    this.pending.clear();
  }
  notification(method: string, p: any) {
    const write = (
      key: string,
      kind: PMActivity['kind'],
      title: string,
      details: PMActivity['details'],
      status: PMActivity['status'] = 'running',
    ) => this.store.activity(this.run, key, { kind, title, details, status });
    if (method === 'turn/started') {
      write('prepare', 'phase', '上下文就绪', {}, 'completed');
      write('turn', 'phase', '分析与协调', {});
      return;
    }
    const deltaKind =
      method === 'item/reasoning/summaryTextDelta'
        ? 'summary'
        : method === 'item/plan/delta'
          ? 'plan'
          : method === 'item/agentMessage/delta'
            ? 'message'
            : undefined;
    if (deltaKind && typeof p.delta === 'string') {
      const key = p.itemId ?? deltaKind;
      const entry = this.pending.get(key) ?? {
        kind: deltaKind,
        parts: new Map<number, string>(),
        dirty: false,
      };
      const index = p.summaryIndex ?? 0;
      if ([...entry.parts.values()].reduce((sum, text) => sum + text.length, 0) < 32000)
        entry.parts.set(index, ((entry.parts.get(index) ?? '') + p.delta).slice(0, 32000));
      entry.dirty = true;
      this.pending.set(key, entry);
      if (!this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.flush();
        }, 250);
      return;
    }
    if (method === 'turn/plan/updated') {
      write('plan', 'plan', '更新计划', {
        summary: (p.plan ?? []).map((s: any) => `${s.status}: ${s.step}`).join('\n'),
      });
      return;
    }
    if (method === 'error') {
      write('error', 'error', '执行错误', { error: p.error?.message ?? 'Codex error' }, 'failed');
      return;
    }
    if (method !== 'item/started' && method !== 'item/completed') return;
    const item = p.item;
    if (!item?.id) return;
    const pending = this.pending.get(item.id);
    const accumulated = pending
      ? [...pending.parts]
          .sort(([a], [b]) => a - b)
          .map(([, text]) => text)
          .join('\n')
      : undefined;
    if (method === 'item/completed') {
      if (item.type === 'agentMessage')
        this.store.changes.emit('delta', {
          projectId: this.run.projectId,
          runId: this.run.id,
          role: 'pm',
          text: bounded(item.text ?? ''),
          replace: true,
        });
      this.pending.delete(item.id);
    }
    const status =
      item.status === 'failed' ||
      item.success === false ||
      (typeof item.exitCode === 'number' && item.exitCode !== 0)
        ? 'failed'
        : item.status === 'declined'
          ? 'paused'
          : method === 'item/completed'
            ? 'completed'
            : 'running';
    const details: PMActivity['details'] = {};
    switch (item.type) {
      case 'commandExecution':
        if (item.command !== undefined) details.command = item.command;
        if (item.cwd !== undefined) details.cwd = item.cwd;
        if (item.aggregatedOutput !== undefined) details.output = item.aggregatedOutput;
        write(item.id, 'command', '执行命令', details, status);
        break;
      case 'reasoning':
        write(
          item.id,
          'summary',
          '分析摘要',
          {
            summary: item.summary?.length
              ? item.summary
                  .map((s: any) => (typeof s === 'string' ? s : (s.text ?? '')))
                  .join('\n')
              : accumulated,
          },
          status,
        );
        break;
      case 'plan':
        write(item.id, 'plan', '计划', { summary: item.text ?? accumulated }, status);
        break;
      case 'mcpToolCall':
      case 'dynamicToolCall':
        write(
          item.id,
          'tool',
          `调用工具 ${item.tool ?? ''}`,
          {
            input: JSON.stringify(item.arguments),
            paths:
              item.arguments === undefined
                ? undefined
                : argumentPaths(redactValue(item.arguments)).join('\n'),
            output: JSON.stringify(item.result ?? item.contentItems),
            error: JSON.stringify(item.error),
          },
          status,
        );
        break;
      case 'fileChange':
        write(
          item.id,
          'files',
          '文件变更',
          { paths: (item.changes ?? []).map((c: any) => c.path).join('\n') },
          status,
        );
        break;
      case 'webSearch':
        write(
          item.id,
          'search',
          '搜索',
          { input: item.query ?? JSON.stringify(item.action) },
          status,
        );
        break;
      case 'contextCompaction':
        write(item.id, 'phase', '整理上下文', {}, status);
        break;
    }
  }
}

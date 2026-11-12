import { createHash } from 'node:crypto';
import {
  maintenanceRuleInput,
  type MaintenanceCandidate,
  type MaintenanceRule,
  type MaintenanceObservation,
  type MaintenancePage,
  type MaintenanceDetail,
  type MaintenanceHistory,
} from '../shared/maintenance.ts';
import { Store, Fault, id, now, redact } from './store.ts';
import type { GitHub } from './github.ts';

export class Maintenance {
  private scans = new Map<string, Promise<void>>();
  private nextScan = 0;
  constructor(
    private store: Store,
    private github: GitHub,
  ) {}

  rules(repoId: string) {
    const latest = new Map<string, MaintenanceRule>();
    for (const rule of this.store.list('maintenanceRule')) {
      if (rule.repoId === repoId && (latest.get(rule.ruleId)?.version ?? 0) < rule.version)
        latest.set(rule.ruleId, rule);
    }
    return [...latest.values()];
  }

  save(repoId: string, value: unknown, ruleId?: string) {
    const input = maintenanceRuleInput.parse(value);
    const repo = this.store.repo(repoId);
    return this.store.transaction(() => {
      const previous = ruleId
        ? this.rules(repoId).find((rule) => rule.ruleId === ruleId)
        : undefined;
      if (ruleId && !previous) throw new Fault('维护规则不存在', 404);
      if ((previous?.version ?? 0) !== input.expectedVersion)
        throw new Fault('维护规则已变化，请刷新后重试', 409);
      const { expectedVersion, ...settings } = input;
      const rule: MaintenanceRule = {
        ...settings,
        id: id(),
        ruleId: ruleId ?? id(),
        repoId,
        projectId: repo.projectId,
        version: expectedVersion + 1,
        createdAt: now(),
        author: 'user',
      };
      this.store.put('maintenanceRule', rule.id, rule);
      return rule;
    });
  }

  page(repoId: string, before?: string): MaintenancePage {
    this.store.repo(repoId);
    const records = this.store
      .list('maintenanceObservation')
      .filter((item) => item.repoId === repoId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const start = before ? records.findIndex((item) => item.id === before) + 1 : 0;
    if (before && start === 0) throw new Fault('观察分页位置不存在', 400);
    const slice = records.slice(start, start + 30);
    return {
      rules: this.rules(repoId),
      automaticExecutionAvailable: false,
      health: this.store.get('maintenanceHealth', repoId),
      observations: slice.map((item) => {
        const { body, evidence, ...candidate } = this.store.get(
          'maintenanceCandidate',
          item.candidateId,
        )!;
        return { ...item, candidate };
      }),
      next: records.length > start + 30 ? slice.at(-1)?.id : undefined,
    };
  }

  history(repoId: string, ruleId: string, before?: number): MaintenanceHistory {
    if (!this.rules(repoId).some((rule) => rule.ruleId === ruleId))
      throw new Fault('维护规则不存在', 404);
    const versions = this.store
      .list('maintenanceRule')
      .filter(
        (rule) =>
          rule.repoId === repoId &&
          rule.ruleId === ruleId &&
          (before === undefined || rule.version < before),
      )
      .sort((a, b) => b.version - a.version);
    return {
      versions: versions.slice(0, 30),
      next: versions.length > 30 ? versions[29].version : undefined,
    };
  }

  detail(repoId: string, observationId: string): MaintenanceDetail {
    const observation = this.store.get('maintenanceObservation', observationId);
    if (!observation || observation.repoId !== repoId) throw new Fault('维护观察记录不存在', 404);
    return {
      observation,
      candidate: this.store.get('maintenanceCandidate', observation.candidateId)!,
      rule: this.store.get('maintenanceRule', observation.authorizationVersionId)!,
    };
  }

  refresh(repoId: string) {
    const active = this.scans.get(repoId);
    if (active) return active;
    const job = this.scan(repoId);
    this.scans.set(repoId, job);
    void job.finally(() => this.scans.delete(repoId)).catch(() => {});
    return job;
  }

  private async scan(repoId: string) {
    const repo = this.store.repo(repoId);
    const rules = this.rules(repoId).filter((rule) => rule.mode !== 'off');
    if (!rules.length) return;
    try {
      const candidates = await this.github.readMaintenanceCandidates(
        repo,
        new Set(rules.map((rule) => rule.kind)),
      );
      this.store.transaction(() => {
        const current = this.rules(repoId);
        for (const rule of rules) {
          // Reads may race configuration changes. Only the exact retained version can commit.
          if (!current.some((item) => item.id === rule.id)) continue;
          for (const candidate of candidates) {
            if (candidate.kind === rule.kind) this.observe(rule, candidate);
          }
        }
        this.store.put('maintenanceHealth', repoId, {
          id: repoId,
          status: 'healthy',
          checkedAt: now(),
        });
      });
    } catch (error) {
      this.store.put('maintenanceHealth', repoId, {
        id: repoId,
        status: 'unavailable',
        checkedAt: now(),
        reason: redact(String(error)),
      });
      throw error;
    }
  }

  private observe(rule: MaintenanceRule, candidate: MaintenanceCandidate) {
    const tasks = this.store
      .list('task')
      .filter(
        (task) =>
          task.repoId === rule.repoId &&
          ((candidate.issue !== undefined && task.issue === candidate.issue) ||
            (task.pr !== undefined && candidate.pullRequests.includes(task.pr)) ||
            (candidate.head !== undefined &&
              (task.head === candidate.head ||
                task.deliveryRevision?.commit === candidate.head ||
                task.deliveryRevision?.head === candidate.head))),
      );
    const source = this.store.get('intakeSource', rule.repoId);
    const explicit =
      candidate.kind === 'issue' &&
      source &&
      candidate.body.startsWith(source.command) &&
      /^(?:\s|$)/.test(candidate.body.slice(source.command.length));
    const inputIds = new Set(
      this.store
        .list('sourceInput')
        .filter((input) => input.repoId === rule.repoId && input.number === candidate.issue)
        .map((input) => input.id),
    );
    const pendingRequest = this.store
      .list('inputAssessment')
      .some(
        (assessment) =>
          inputIds.has(assessment.inputId) &&
          (assessment.admission !== undefined || assessment.disposition.status === 'queued'),
      );
    const judgments = [
      {
        condition: `匹配${rule.kind === 'issue' ? '标签' : '工作流'}：${rule.selector}`,
        matched: candidate.selectorValues.includes(rule.selector),
      },
      {
        condition: `来源已等待至少 ${rule.minimumAgeMinutes} 分钟`,
        matched: candidate.ageMinutes >= rule.minimumAgeMinutes,
      },
      { condition: '来源活动由外部人类发起且没有宿主标记', matched: !candidate.selfGenerated },
      { condition: '没有已有工作关联', matched: tasks.length === 0 },
      { condition: '没有关联 PR 的 CI', matched: candidate.pullRequests.length === 0 },
      { condition: '显式请求继续由原接收入口处理', matched: !explicit && !pendingRequest },
    ];
    const holdReasons: string[] = [];
    if (this.store.project(rule.projectId).admissionPaused) holdReasons.push('用户已暂停团队接收');
    for (const task of tasks)
      if (task.control === 'paused')
        holdReasons.push(
          `${task.pausedByUser ? '用户已暂停关联工作' : '关联工作已暂停'}：${task.title}`,
        );
    if (!this.store.repo(rule.repoId).authorized) holdReasons.push('仓库尚未授权');
    const wouldAccept = judgments.every((item) => item.matched) && holdReasons.length === 0;
    const observationId = createHash('sha256')
      .update(
        JSON.stringify({
          candidate: candidate.id,
          rule: rule.id,
          judgments,
          holdReasons,
          tasks: tasks.map((task) => task.id),
        }),
      )
      .digest('hex');
    if (this.store.get('maintenanceObservation', observationId)) return;
    if (!this.store.get('maintenanceCandidate', candidate.id))
      this.store.put('maintenanceCandidate', candidate.id, candidate);
    const observation: MaintenanceObservation = {
      id: observationId,
      candidateId: candidate.id,
      repoId: rule.repoId,
      projectId: rule.projectId,
      ruleId: rule.ruleId,
      policyVersion: rule.version,
      authorizationVersionId: rule.id,
      mode: rule.mode,
      createdAt: now(),
      judgments,
      sourceAgeMinutes: candidate.ageMinutes,
      proposedScope: rule.scope,
      wouldAccept,
      recommendation: wouldAccept
        ? candidate.kind === 'issue'
          ? `建议评估 Issue #${candidate.issue}「${candidate.title}」；处理范围：${rule.scope}`
          : `建议调查默认分支工作流「${candidate.title}」在 ${candidate.head} 的失败；` +
            `处理范围：${rule.scope}`
        : '保留来源记录；先处理未满足的条件或沿已有工作继续。',
      execution: 'observation_only',
      holdReasons,
      taskIds: tasks.map((task) => task.id),
    };
    this.store.put('maintenanceObservation', observation.id, observation);
  }

  async pump() {
    if (Date.now() < this.nextScan) return;
    this.nextScan = Date.now() + 60_000;
    const repoIds = new Set(this.store.list('maintenanceRule').map((rule) => rule.repoId));
    await Promise.all([...repoIds].map((repoId) => this.refresh(repoId).catch(() => {})));
  }
}

import { TEAM_INSTRUCTIONS_LIMIT, teamInstructionsLength } from '../shared/team-instructions.ts';
import type {
  InstructionSuggestion,
  Run,
  TeamInstructionSections,
  TeamInstructionsVersion,
} from '../shared/types.ts';
import { Fault, now, type StoreContext } from './store-core.ts';

export function teamInstructionsHistory(ctx: StoreContext, projectId: string) {
  ctx.project(projectId);
  return ctx
    .list('teamInstructions')
    .filter((v) => v.projectId === projectId)
    .sort((a, b) => a.version - b.version);
}

export function currentTeamInstructions(
  ctx: StoreContext,
  projectId: string,
): TeamInstructionsVersion {
  return (
    teamInstructionsHistory(ctx, projectId).at(-1) ?? {
      projectId,
      version: 0,
      sections: { repository: '', engineering: '', delivery: '' },
      source: 'user',
      createdAt: '',
    }
  );
}

export function runTeamInstructions(ctx: StoreContext, run: Run): TeamInstructionsVersion {
  if (run.teamInstructionsVersion === undefined || run.teamInstructionsVersion === 0)
    return {
      projectId: run.projectId,
      version: 0,
      sections: { repository: '', engineering: '', delivery: '' },
      source: 'user',
      createdAt: '',
    };
  const version = ctx.get('teamInstructions', `${run.projectId}:${run.teamInstructionsVersion}`);
  if (!version) throw new Fault('运行使用的团队说明版本不存在', 409);
  return version;
}

export function saveTeamInstructions(
  ctx: StoreContext,
  projectId: string,
  sections: TeamInstructionSections,
  provenance: {
    source: 'user' | 'team';
    baseVersion: number;
    taskId?: string;
    restoredFromVersion?: number;
    suggestionId?: string;
    interruptionIds?: string[];
    interruptionCategories?: string[];
  },
) {
  return ctx.transaction(() => {
    const current = currentTeamInstructions(ctx, projectId);
    if (teamInstructionsLength(sections) > TEAM_INSTRUCTIONS_LIMIT)
      throw new Fault(`团队说明总长度不能超过 ${TEAM_INSTRUCTIONS_LIMIT} 字符；原版本未变`, 400);
    if (current.version !== provenance.baseVersion)
      throw new Fault('团队说明已更新，请重新载入后再保存', 409);
    if (provenance.taskId && ctx.task(provenance.taskId).projectId !== projectId)
      throw new Fault('来源任务不属于此项目', 400);
    const version: TeamInstructionsVersion = {
      source: provenance.source,
      taskId: provenance.taskId,
      restoredFromVersion: provenance.restoredFromVersion,
      suggestionId: provenance.suggestionId,
      interruptionIds: provenance.interruptionIds,
      interruptionCategories: provenance.interruptionCategories,
      projectId,
      version: current.version + 1,
      sections: structuredClone(sections),
      createdAt: now(),
    };
    ctx.put('teamInstructions', `${projectId}:${version.version}`, version);
    ctx.emitChange();
    return version;
  });
}

export function restoreTeamInstructions(
  ctx: StoreContext,
  projectId: string,
  version: number,
  baseVersion: number,
) {
  const previous = teamInstructionsHistory(ctx, projectId).find((v) => v.version === version);
  if (!previous) throw new Fault('团队说明版本不存在', 404);
  return ctx.transaction(() => {
    const restored = saveTeamInstructions(ctx, projectId, previous.sections, {
      source: 'user',
      baseVersion,
      restoredFromVersion: version,
    });
    for (const suggestion of ctx.list('suggestion')) {
      if (
        suggestion.projectId === projectId &&
        suggestion.status === 'adopted' &&
        suggestion.adoptedVersion! > version
      )
        ctx.put('suggestion', suggestion.id, { ...suggestion, status: 'reverted' });
    }
    return restored;
  });
}

export function recordRetrospective(
  ctx: StoreContext,
  taskId: string,
  input: Pick<
    InstructionSuggestion,
    'baseVersion' | 'category' | 'interruptionIds' | 'reason' | 'sections'
  >,
  status?: InstructionSuggestion['status'],
) {
  const task = ctx.task(taskId);
  const key = `retrospective:${taskId}`;
  const prior = ctx.get('suggestion', key);
  if (prior && prior.status !== 'running') return prior;
  if (input.sections && teamInstructionsLength(input.sections) > TEAM_INSTRUCTIONS_LIMIT)
    throw new Fault(`团队说明总长度不能超过 ${TEAM_INSTRUCTIONS_LIMIT} 字符；原版本未变`, 400);
  const change = (sections: TeamInstructionSections | undefined, baseVersion: number) => {
    if (!sections) return undefined;
    const base = teamInstructionsHistory(ctx, task.projectId).find(
      (v) => v.version === baseVersion,
    )?.sections ?? { repository: '', engineering: '', delivery: '' };
    return JSON.stringify(
      Object.entries(sections).filter(
        ([sectionKey, text]) => base[sectionKey as keyof TeamInstructionSections] !== text,
      ),
    );
  };
  const proposedChange = change(input.sections, input.baseVersion);
  const duplicate =
    proposedChange &&
    ctx
      .list('suggestion')
      .some(
        (s) =>
          s.projectId === task.projectId &&
          s.id !== key &&
          s.category === input.category &&
          change(s.sections, s.baseVersion) === proposedChange,
      );
  const suggestion: InstructionSuggestion = {
    ...input,
    id: key,
    taskId,
    projectId: task.projectId,
    createdAt: prior?.createdAt ?? now(),
    status: status ?? (duplicate || !input.sections ? 'no_change' : 'pending'),
    reason: duplicate ? '此前已记录同类修改，保留原决定。' : input.reason,
  };
  ctx.put('suggestion', key, suggestion);
  ctx.emitChange();
  if (suggestion.status === 'pending' && ctx.project(task.projectId).autoAdoptInstructions)
    return decideSuggestion(ctx, task.projectId, key, 'adopt');
  return suggestion;
}

export function decideSuggestion(
  ctx: StoreContext,
  projectId: string,
  suggestionId: string,
  action: 'adopt' | 'ignore',
) {
  return ctx.transaction(() => {
    ctx.project(projectId);
    const suggestion = ctx.get('suggestion', suggestionId);
    if (!suggestion || suggestion.projectId !== projectId) throw new Fault('建议不存在', 404);
    if (suggestion.status !== 'pending') throw new Fault('建议已处理', 409);
    let adoptedVersion: number | undefined;
    if (action === 'adopt') {
      if (!suggestion.sections) throw new Fault('建议没有修改内容', 400);
      adoptedVersion = saveTeamInstructions(ctx, projectId, suggestion.sections, {
        source: 'team',
        baseVersion: suggestion.baseVersion,
        taskId: suggestion.taskId,
        suggestionId,
        interruptionIds: suggestion.interruptionIds,
        interruptionCategories: [suggestion.category],
      }).version;
    }
    const next: InstructionSuggestion = {
      ...suggestion,
      status: action === 'adopt' ? 'adopted' : 'ignored',
      adoptedVersion,
    };
    ctx.put('suggestion', suggestionId, next);
    ctx.emitChange();
    return next;
  });
}

export function setAutoAdoptInstructions(ctx: StoreContext, projectId: string, enabled: boolean) {
  const project = { ...ctx.project(projectId), autoAdoptInstructions: enabled };
  ctx.put('project', projectId, project);
  ctx.emitChange();
  return project;
}

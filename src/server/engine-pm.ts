import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolSpec } from './codex.ts';
import { MessageImages } from './images.ts';
import { pmContext, readProjectRecords, RECALL_TOOL } from './pm-context.ts';
import { domainContext, instructions, taskPrompt } from './prompts.ts';
import {
  jsonSchema,
  priorityUpdateInput,
  resolveIncidentInput,
  taskInput,
} from './schemas.ts';
import { Fault, redact } from './store.ts';
import { engineeringMetadata } from './task-naming.ts';
import type { Message, Run, Task } from '../shared/types.ts';
import {
  acceptedDocumentChanges,
  ClarificationPause,
  configureInput,
  diagnosticDescriptor,
  documentInput,
  recallTool,
  reconcileIssueInput,
  requestClarificationInput,
  resolveInput,
  reviseInput,
  ROLE_ALLOWED_TOOLS,
  type EngineHost,
} from './engine-helpers.ts';

export function requestProductClarification(
  host: EngineHost,
  projectId: string,
  run: Run,
  fallbackSource: Message | undefined,
  task: Task | undefined,
  questions: Array<Record<string, unknown>>,
): never {
  const liveRun = host.store.get('run', run.id);
  const source = liveRun?.sourceMessageId
    ? host.store.get('message', liveRun.sourceMessageId)
    : fallbackSource;
  if (!source?.intent)
    throw new Fault('产品澄清必须绑定当前用户消息权限', 409, {
      code: 'clarification_source_missing',
    });
  const clarification = host.store.createClarification({
    projectId,
    sourceMessageId: source.id,
    ...(task ? { taskId: task.id } : {}),
    sourceIntent: source.intent,
    questions,
  });
  throw new ClarificationPause(clarification.id);
}

export function pmTrigger(
  host: EngineHost,
  run: Run,
  source: string,
  message?: Message,
  summary?: string,
) {
  const eventId = host.store.event('pm-trigger', source, {
    projectId: run.projectId,
    runId: run.id,
    taskId: run.taskId,
  });
  host.store.activity(run, 'trigger', {
    kind: 'trigger',
    title: source,
    status: 'completed',
    messageId: message?.id,
    eventId,
    details: {
      source,
      summary: message?.origin ? `${message.origin.url} · ${message.origin.actor.login}` : summary,
    },
  });
  host.store.activity(run, 'prepare', {
    kind: 'phase',
    title: '准备上下文',
    status: 'running',
    details: {},
  });
}

export async function pmTurn(
  host: EngineHost,
  projectId: string,
  content: string,
  source?: Message,
  task?: Task,
  trigger = '宿主事件：技术协调',
  recoveryItemId?: string,
  existingRun?: Run,
  coordinatingOwnerRunId?: string,
): Promise<string> {
  source ??= task?.issueOrigin ? host.store.get('message', task.sourceMessageId) : undefined;
  if (source?.origin) {
    host.store.sourceAuthority(source.id, projectId, task?.repoId);
    if (host.store.project(projectId).admissionPaused) throw new Fault('团队已暂停接收工作', 409);
  }
  const run =
    existingRun ??
    host.store.run('pm', projectId, 'pm', task, {
      sourceMessageId: source?.id,
      ...(recoveryItemId ? { recoveryItemId } : {}),
    });
  const recoveryDraftId = recoveryItemId
    ? host.store.get('recovery', recoveryItemId)?.draftId
    : undefined;
  if (source && ['steer_queued', 'steer_recovering'].includes(source.descriptor?.code ?? ''))
    host.store.updateMessage(source.id, { runId: run.id, sourceMessageId: source.id });
  const draft = host.store.assistantDraft(projectId, run.id, recoveryDraftId ?? run.id);
  host.store.updateMessage(draft.id, {
    runId: run.id,
    status: 'running',
    draftStatus: 'running',
    ...(source?.id ? { sourceMessageId: source.id } : {}),
  });
  pmTrigger(host, run, trigger, source, content);
  let draftText = draft.content;
  let draftTimer: NodeJS.Timeout | undefined;
  return host
    .withAgent(
      run,
      async (c, signal) => {
        const repos = host.store.list('repo').filter((r) => r.projectId === projectId);
        const cwd = join(host.dataDir, 'projects', projectId);
        await mkdir(cwd, { recursive: true });
        const tools: ToolSpec[] = [
          recallTool,
          ...(source?.origin
            ? [
                {
                  name: 'record_no_action',
                  description:
                    'Record an explicit no-action judgment for this external request. Give a usable original-Issue answer; only use when no Task is needed.',
                  inputSchema: jsonSchema(
                    z.object({ reason: z.string().trim().min(1).max(10000) }).strict(),
                  ),
                },
              ]
            : []),
          {
            name: 'request_clarification',
            description:
              'Pause affected source intent for a material product decision. Keep sourceMessageId and sourceIntent exactly as supplied; do not invent an answer.',
            inputSchema: jsonSchema(requestClarificationInput),
          },
          {
            name: 'resolve_incident',
            description:
              'Resolve one host incident with bounded technical guidance, pause it, or wait for a user decision.',
            inputSchema: jsonSchema(resolveIncidentInput),
          },
          {
            name: 'set_task_priority',
            description:
              'Adjust only priority metadata of this project unfinished tasks within coordination authority. No preemption, resume, requirement or evidence changes. Use expectedVersion (legacy=0) and unique requestId for safe retries.',
            inputSchema: jsonSchema(priorityUpdateInput),
          },
          {
            name: 'explain_scheduling',
            description:
              'Read current project candidates, every eligibility gate and project rotation; no start time promise and no mutations.',
            inputSchema: jsonSchema(z.object({}).strict()),
          },
          {
            name: 'revise_task',
            description:
              'Revise an existing task after explicit user implementation/feedback changes its product requirements. Re-publish acceptance criteria and invalidate old evidence. A running Dev/Review is stopped first (its worktree is kept) and later resumes from the revision. Cannot revise a completed task.',
            inputSchema: jsonSchema(reviseInput),
          },
          {
            name: 'record_domain_document',
            description:
              'Persist an agreed project document using the target repository’s existing paths and formats. This local design record does not edit a repository. Attach accepted document IDs to a later implementation ticket to publish through normal review.',
            inputSchema: jsonSchema(documentInput),
          },
          {
            name: 'create_task',
            description:
              'Create a vertical slice from the current explicit implementation request. Returns task IDs for blocking edges.',
            inputSchema: jsonSchema(taskInput),
          },
          {
            name: 'configure_repository',
            description:
              'Set verified project commands and required checks; cannot enable or authorize a repo.',
            inputSchema: jsonSchema(configureInput),
          },
          {
            name: 'resolve_task',
            description:
              'Resume a blocked technical task with concrete guidance; optionally upgrade to the complex profile.',
            inputSchema: jsonSchema(resolveInput),
          },
          {
            name: 'reconcile_task_issue',
            description:
              'Reconcile an uncertain create-issue and resume the original phase. ' +
              'Returns adopt, authorize (one creation), none, or blocked with evidence. ' +
              'Preserves user pauses; never rebuild the Task or bypass the host.',
            inputSchema: jsonSchema(reconcileIssueInput),
          },
        ];
        const effectiveSource = () => {
          const live = host.store.get('run', run.id);
          return live?.sourceMessageId ? host.store.get('message', live.sourceMessageId) : source;
        };
        let pendingClarification: ClarificationPause | undefined;
        const handler = async (name: string, args: unknown) => {
          if (name === RECALL_TOOL) return readProjectRecords(host.store, projectId, args);
          const currentSource = effectiveSource();
          if (currentSource?.origin) {
            host.store.sourceAuthority(currentSource.id, projectId);
            if (host.store.project(projectId).admissionPaused)
              throw new Fault('团队已暂停接收工作', 409);
          }
          const scopedTask = (taskId: string) =>
            currentSource?.origin
              ? host.store.sourceTask(currentSource.id, projectId, taskId)
              : host.store.task(taskId);
          if (name === 'record_no_action') {
            const input = z
              .object({ reason: z.string().trim().min(1).max(10000) })
              .strict()
              .parse(args);
            if (!currentSource?.origin) throw new Fault('此决定仅适用于外部来源', 403);
            return host.intake.noAction(currentSource.id, input.reason);
          }
          if (name === 'set_task_priority')
            return host.store.setTaskPriority(projectId, args, {
              actor: 'pm',
              sourceMessageId: currentSource?.id,
              runId: run.id,
            });
          if (name === 'explain_scheduling') {
            z.object({}).strict().parse(args);
            return host.store.explainScheduling(projectId);
          }
          if (name === 'revise_task') {
            if (!currentSource || !['implement', 'feedback'].includes(currentSource.intent ?? ''))
              throw new Fault('修改验收条件需要明确的用户实施或反馈消息');
            const input = reviseInput.parse(args);
            const old = scopedTask(input.taskId);
            host.store.sourceAuthority(currentSource.id, projectId, old.repoId);
            if (old.projectId !== projectId || ['done', 'cancelled'].includes(old.stage))
              throw new Fault('任务不在可修改范围');
            await host.checkExternalMerge(old);
            host.store.assertTaskExecutable(old.id);
            const naming = {
              changeType: input.changeType,
              scope: input.scope,
              summaryEn: input.summaryEn,
            };
            const renaming = Object.values(naming).some((value) => value !== undefined);
            if (renaming) {
              if (old.branch)
                throw new Fault('任务分支已按原命名创建，不能再修改 changeType、scope、summaryEn');
              try {
                engineeringMetadata(naming);
              } catch (error) {
                throw new Fault((error as Error).message);
              }
            }
            // The owner awaiting this PM decision cannot finish until this tool returns.
            const working = () =>
              host.store
                .activeRuns()
                .filter(
                  (r) => r.taskId === old.id && r.role !== 'pm' && r.id !== coordinatingOwnerRunId,
                );
            if (working().length) {
              // A user-authorized revision supersedes in-flight work: stop it, keeping the worktree.
              host.store.updateTaskControl(
                old.id,
                { control: 'paused', pausedByUser: false },
                'pause',
                {
                  source: 'pm',
                  reason: 'revise_task_stop',
                  runId: run.id,
                },
              );
              for (const r of working()) host.active.get(r.id)?.abort.abort();
              for (let i = 0; i < 240 && working().length; i++)
                await new Promise((resolve) => setTimeout(resolve, 250));
              if (working().length) throw new Fault('任务运行中，请先暂停并等待其停止');
            }
            if (
              host.store
                .list('clarification')
                .some(
                  (clarification) =>
                    clarification.sourceMessageId === old.sourceMessageId &&
                    (!clarification.review || clarification.taskId === old.id) &&
                    ['open', 'cancelled'].includes(clarification.status),
                )
            )
              throw new Fault('源消息产品澄清未形成可发布决定，不能修订任务', 409, {
                code: 'clarification_gate',
                params: { sourceMessageId: old.sourceMessageId },
              });
            const documentChanges = input.documentIds
              ? acceptedDocumentChanges(host.store, projectId, old.repoId, input.documentIds)
              : old.documentChanges;
            let revised = host.store.updateTaskControl(
              old.id,
              {
                spec: input.spec,
                acceptance: input.acceptance,
                // The original user authority is immutable across feedback revisions.
                control: 'paused',
                stage: old.worktree ? 'developing' : 'ready',
                devPhase: 'implement',
                reviews: [],
                reviewClarificationId: undefined,
                tests: [],
                mergeApproval: undefined,
                retries: 0,
                documentChanges,
                feedback: [...old.feedback, input.guidance],
                ...(renaming ? naming : {}),
              },
              'pause',
              { source: 'pm', reason: 'revise_task', runId: run.id },
            );
            try {
              if (revised.issue) await host.github.reviseIssue(revised);
              revised = host.store.updateTaskControl(
                old.id,
                { control: 'active', blocked: undefined },
                'resume',
                {
                  source: 'pm',
                  reason: 'revise_task_synced',
                  runId: run.id,
                },
              );
            } catch (e) {
              host.block(old.id, `任务修订尚未同步：${String(e)}`);
              throw e;
            }
            return revised;
          }
          if (name === 'request_clarification') {
            const input = requestClarificationInput.parse(args);
            if (input.sourceMessageId !== currentSource?.id)
              throw new Fault('产品澄清只能引用当前有效用户消息', 403);
            try {
              return requestProductClarification(
                host,
                projectId,
                run,
                currentSource,
                task,
                input.questions,
              );
            } catch (error) {
              if (error instanceof ClarificationPause) {
                pendingClarification = error;
                return { waitingForClarification: error.clarificationId };
              }
              throw error;
            }
          }
          if (name === 'resolve_incident') {
            const input = resolveIncidentInput.parse(args);
            if (currentSource?.origin) {
              const incident = host.store.get('incident', input.incidentId);
              if (!incident?.taskId) throw new Fault('外部来源不能处理无关的团队问题', 403);
              scopedTask(incident.taskId);
            }
            return host.resolveIncident(projectId, input.incidentId, input.action, input.guidance, {
              source: 'pm',
              reason: 'resolve_incident',
              runId: run.id,
            });
          }
          if (name === 'record_domain_document') {
            const input = documentInput.parse(args);
            if (currentSource?.origin)
              host.store.sourceAuthority(currentSource.id, projectId, input.repoId);
            return host.store.recordDocument(projectId, input);
          }
          if (name === 'create_task') {
            if (!currentSource || !['implement', 'feedback'].includes(currentSource.intent ?? ''))
              throw new Fault('当前回合没有新增实施授权');
            const input = taskInput.parse(args);
            const { documentIds, ...taskData } = input;
            const documentChanges = acceptedDocumentChanges(
              host.store,
              projectId,
              input.repoId,
              documentIds,
            );
            const created = host.store.createTask(
              {
                ...taskData,
                documentChanges,
                projectId,
                sourceMessageId: currentSource.id,
              },
              { actor: 'pm', runId: run.id },
            );
            // Publication is durable and reconciled separately; closed work switches do not prevent planning.
            return host.store.task(created.id);
          }
          if (name === 'configure_repository') {
            const input = configureInput.parse(args);
            if (currentSource?.origin)
              host.store.sourceAuthority(currentSource.id, projectId, input.repoId);
            if (host.store.repo(input.repoId).projectId !== projectId)
              throw new Fault('跨项目操作被拒绝', 403);
            return host.store.patchRepo(input.repoId, {
              commands: input.commands,
              requiredChecks: input.requiredChecks,
            });
          }
          if (name === 'resolve_task') {
            const input = resolveInput.parse(args);
            const t = scopedTask(input.taskId);
            if (t.projectId !== projectId || t.stage === 'done' || t.stage === 'cancelled')
              throw new Fault('任务不在可恢复范围');
            await host.resume(t.id, input, { source: 'pm', reason: 'resolve_task', runId: run.id });
            return host.store.task(t.id);
          }
          if (name === 'reconcile_task_issue') {
            const input = reconcileIssueInput.parse(args);
            scopedTask(input.taskId);
            return host.reconcileTaskIssue(projectId, input.taskId, {
              source: 'pm',
              reason: 'reconcile_task_issue',
              runId: run.id,
            });
          }
          throw new Fault('未知 PM 操作');
        };
        const profile = host.agentProfile(run);
        const thread = await c.thread({
          cwd,
          profile,
          instructions: await instructions('pm', { team: host.store.runTeamInstructions(run) }),
          threadId: run.resumeThreadId,
          writable: false,
          tools,
          toolHandler: handler,
          onUserInput: async (request: any) => {
            try {
              requestProductClarification(host, projectId, run, effectiveSource(), task, [
                {
                  id: String(request.id ?? 'question'),
                  question: String(request.message ?? request.title ?? '请确认产品行为'),
                  ...(Array.isArray(request.options)
                    ? {
                        options: request.options.map((option: unknown) => ({
                          value: String(option),
                          label: String(option),
                        })),
                      }
                    : {}),
                },
              ]);
            } catch (error) {
              if (error instanceof ClarificationPause) {
                pendingClarification = error;
                return undefined;
              }
              throw error;
            }
          },
          ...(run.agentKind === 'omp' ? ({ allowedTools: ROLE_ALLOWED_TOOLS.pm } as any) : {}),
        } as any);
        host.saveThread(run, thread);
        const contextPaths = await Promise.all(
          repos.map((r) =>
            host.workspaces.view(r, 'context', `refs/remotes/origin/${r.defaultBranch}`),
          ),
        );
        const context = await domainContext(contextPaths);
        const externalContext = source?.origin
          ? `External human GitHub Issue request. This is NOT a local Web user.
Source identity and admitted scope: ${JSON.stringify(source.origin)}.
Source title: ${JSON.stringify(host.store.get('sourceInput', source.origin.inputId)?.title)}.
At most ONE independently deliverable Task in the admitted repository,
bound to the ORIGINAL Issue. Never create another Issue or rewrite its body.
If several deliverables are needed, request_clarification BEFORE create_task.
If no Task is needed, explicitly record_no_action with the usable answer;
ending the turn alone is not a decision. Later Issue edits are context only,
not new authorization.
`
          : '';
        const prompt = `${externalContext}${pmContext(host.store, projectId)}\n${context}\n\nCurrent input intent: ${source?.intent ?? 'technical coordination (no new product scope)'}\n${task ? taskPrompt(task) : ''}\n\n${content}`;
        const imagePaths = source
          ? await new MessageImages(host.store, host.dataDir).paths(source)
          : [];
        const reply = await c.turn(
          thread,
          prompt,
          profile,
          signal,
          undefined,
          host.onTurn(run),
          imagePaths,
        );
        if (pendingClarification) throw pendingClarification;
        draftText = reply;
        host.store.updateMessage(draft.id, {
          content: reply,
          status: 'completed',
          draftStatus: 'completed',
        });
        return reply;
      },
      undefined,
      {
        pmSteer: true,
        onDelta: (delta) => {
          draftText += delta;
          if (!draftTimer)
            draftTimer = setTimeout(() => {
              draftTimer = undefined;
              // A credential may span deltas. Persist complete lines, as PMActivities does,
              // and coalesce the change events instead of refreshing the UI per character.
              const complete = draftText.slice(0, draftText.lastIndexOf('\n') + 1);
              if (complete)
                host.store.updateMessage(draft.id, {
                  content: redact(complete),
                  status: 'running',
                  draftStatus: 'running',
                });
            }, 100);
        },
      },
    )
    .catch((error) => {
      if (error instanceof ClarificationPause) {
        host.store.updateMessage(draft.id, {
          content: draftText || `已暂停，等待产品澄清：${error.clarificationId}`,
          status: 'completed',
          draftStatus: 'completed',
          descriptor: diagnosticDescriptor('clarification_waiting', error.message),
        });
        return `等待用户产品澄清：${error.clarificationId}`;
      }
      host.store.updateMessage(draft.id, {
        content: draftText,
        status: 'failed',
        draftStatus: 'failed',
      });
      throw error;
    })
    .finally(() => {
      if (draftTimer) clearTimeout(draftTimer);
    });
}

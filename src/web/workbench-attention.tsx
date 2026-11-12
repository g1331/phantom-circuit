import { Hand, Terminal } from 'lucide-react';
import type { Snapshot } from '../shared/types.ts';
import type { TeamView } from '../shared/team.ts';
import type { WorkflowPage } from '../shared/intake.ts';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';
import { useWhen } from './work-list.tsx';

export function WorkbenchAttention({
  state,
  team,
  projectId,
  page,
}: {
  state: Snapshot;
  team: TeamView;
  projectId: string;
  page?: WorkflowPage;
}) {
  const { t, duration, host, activityTitle } = useLocale();
  const when = useWhen();
  const projectMembers = team.members.filter((member) => !member.taskId);
  return (
    <>
      {team.waiting.length > 0 && (
        <section className="flow-attention">
          <h2>{t('brief.needsYou')}</h2>
          {team.waiting.map((request) => (
            <a
              key={request.id}
              href={routeHref({ page: 'conversation', projectId, view: request.id })}
            >
              <Hand size={16} aria-hidden="true" />
              <strong>{request.text}</strong>
              <span>{t(`team.request.${request.kind}`)}</span>
            </a>
          ))}
        </section>
      )}
      {projectMembers.map((member) => {
        const run = state.runs.find((item) => item.id === member.id);
        const input = page?.inputs.find(
          (entry) =>
            'messageId' in entry.assessment.disposition &&
            entry.assessment.disposition.messageId === run?.sourceMessageId,
        );
        const latest = state.activities
          ?.filter((activity) => activity.runId === member.id)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const event = state.events.find(
          (item) => item.runId === member.id && ['activity', 'command'].includes(item.type),
        );
        const action =
          latest && (!event || latest.updatedAt > event.at)
            ? `${activityTitle(latest.title)} · ${host(
                latest.details.command ??
                  latest.details.paths ??
                  latest.details.summary ??
                  latest.details.source ??
                  '',
              )}`
            : event?.message.split('\n')[0];
        return (
          <section key={member.id} className="flow-project-activity">
            <Terminal size={18} aria-hidden="true" />
            <a
              href={
                input
                  ? routeHref({ page: 'input', projectId, inputId: input.input.id })
                  : routeHref({ page: 'conversation', projectId })
              }
            >
              <strong>
                {t(member.contribution ? 'flow.contributor' : `team.role.${member.role}`)} ·{' '}
                {t(`team.doing.${member.activity}`)}
              </strong>
              {action && <span>{host(action)}</span>}
            </a>
            {member.since && (
              <time dateTime={member.since} title={when(member.since)}>
                {duration((Date.now() - Date.parse(member.since)) / 1000)}
              </time>
            )}
          </section>
        );
      })}
    </>
  );
}

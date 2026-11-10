import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Code2, MessagesSquare, Pause, Play, ScanEye, Siren } from 'lucide-react';
import type { Role, Snapshot } from '../shared/types.ts';
import { teamView, type TeamMember, type TeamWork, type WorkStep } from '../shared/team.ts';
import { useLocale } from './locale/provider.tsx';
import { WorkHold } from './work-hold.tsx';

const icons: Record<Role, typeof Code2> = {
  pm: MessagesSquare,
  dev: Code2,
  review: ScanEye,
  oncall: Siren,
};
const track: WorkStep[] = ['planned', 'building', 'reviewing', 'delivering'];

/** One shared clock, so every elapsed timer in the room ticks together. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function Member({ member, now }: { member: TeamMember; now: number }) {
  const { t } = useLocale();
  const Icon = icons[member.role];
  return (
    <li className={`team-member role-${member.role} is-working`}>
      <span className="team-avatar" aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="team-member-body">
        <span className="team-member-head">
          <strong>{t(`team.role.${member.role}`)}</strong>
          {member.since && (
            <time className="team-clock" dateTime={member.since}>
              {clock(now - Date.parse(member.since))}
            </time>
          )}
        </span>
        <span className="team-doing">
          {t(`team.doing.${member.activity}`)}
          <span className="team-dots" aria-hidden="true" />
        </span>
        {member.taskTitle && <span className="team-member-task">{member.taskTitle}</span>}
      </span>
    </li>
  );
}

function Work({ work, onOpen }: { work: TeamWork; onOpen: (id: string) => void }) {
  const { t } = useLocale();
  const at = track.indexOf(work.step);
  const live = work.teamHold ? work.teamHold === 'running' : work.owners.length > 0;
  const attention = work.teamHold && work.teamHold !== 'blocked' ? 'none' : work.attention;
  return (
    <li>
      <button
        className={`team-work attention-${attention} ${live ? 'is-live' : ''}`}
        onClick={() => onOpen(work.taskId)}
      >
        <span className="team-work-head">
          <strong>{work.title}</strong>
          {work.attention !== 'none' ? (
            <span className="team-badge">
              {work.teamHold
                ? t(`work.hold.${work.teamHold}`)
                : t(`team.attention.${work.attention}`)}
            </span>
          ) : (
            work.rounds > 0 && (
              <span className="team-rounds">{t('team.rounds', { count: work.rounds + 1 })}</span>
            )
          )}
        </span>
        <span className="team-track" aria-label={t(`team.step.${work.step}`)}>
          {track.map((step, i) => (
            <span
              key={step}
              className={i < at ? 'done' : i === at ? 'current' : ''}
              title={t(`team.step.${step}`)}
            />
          ))}
        </span>
        <span className="team-work-foot">
          <span>{t(`team.step.${work.step}`)}</span>
          {work.owners.length > 0 && (
            <span className="team-owners">
              {work.owners.map((role) => {
                const Icon = icons[role];
                return <Icon key={role} size={12} aria-label={t(`team.role.${role}`)} />;
              })}
            </span>
          )}
          {work.teamHold && <WorkHold work={work} />}
        </span>
      </button>
    </li>
  );
}

function feedGroups<T extends { taskTitle?: string }>(items: T[]) {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last[0].taskTitle === item.taskTitle) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

export function TeamRoom({
  state,
  projectId,
  busy,
  onOpenTask,
  onTeam,
}: {
  state: Snapshot;
  projectId: string;
  busy: boolean;
  onOpenTask: (taskId: string) => void;
  onTeam: (action: 'pause' | 'resume') => void;
}) {
  const { t, time, duration } = useLocale();
  const view = useMemo(() => teamView(state, projectId), [state, projectId]);
  const working = view.members.length;
  const now = useNow(working > 0);
  const open = view.work.filter((w) => w.step !== 'done' && w.step !== 'cancelled');
  const delivered = view.work.length - open.length;
  // Paused by the team control: every unfinished piece of work is held and none is running.
  const teamPaused = open.length > 0 && open.every((w) => w.attention === 'paused') && !working;
  return (
    <div className="page team-room team-full">
      <header className="page-header team-header">
        <div>
          <h1>{t('team.title')}</h1>
          <p className={working > 0 ? 'team-live' : ''}>
            {working > 0 && <span className="team-pulse" aria-hidden="true" />}
            {teamPaused
              ? t('team.paused')
              : working > 0
                ? t('team.working', { count: working })
                : t('team.allIdle')}
          </p>
        </div>
        {open.length > 0 && (
          <button
            className="team-control"
            disabled={busy}
            onClick={() => onTeam(teamPaused ? 'resume' : 'pause')}
          >
            {teamPaused ? <Play size={14} /> : <Pause size={14} />}
            {teamPaused ? t('team.resume') : t('team.pause')}
          </button>
        )}
      </header>

      {view.waiting.length > 0 && (
        <section className="team-section team-waiting">
          <h3>{t('team.waiting')}</h3>
          <ul>
            {view.waiting.map((request) => (
              <li key={request.id} className={`team-request kind-${request.kind}`}>
                <span className="team-request-kind">{t(`team.request.${request.kind}`)}</span>
                {request.taskTitle && <strong>{request.taskTitle}</strong>}
                <p>{request.text}</p>
                {request.taskId && (
                  <button className="team-link" onClick={() => onOpenTask(request.taskId!)}>
                    {t('team.open')} <ArrowUpRight size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.members.length > 0 && (
        <section className="team-section team-members-section">
          <h3>{t('team.members')}</h3>
          <ul className="team-members">
            {view.members.map((member) => (
              <Member key={member.id} member={member} now={now} />
            ))}
          </ul>
        </section>
      )}

      <section className="team-section">
        <h3>{t('team.work')}</h3>
        {open.length ? (
          <ul className="team-works">
            {open.map((work) => (
              <Work key={work.taskId} work={work} onOpen={onOpenTask} />
            ))}
          </ul>
        ) : (
          <p className="team-empty">{t('team.workEmpty')}</p>
        )}
        {delivered > 0 && <p className="team-more">{t('team.more', { count: delivered })}</p>}
      </section>

      <section className="team-section">
        <h3>{t('team.feed')}</h3>
        {view.feed.length ? (
          // Consecutive entries for the same work share one heading, as in the run log.
          feedGroups(view.feed).map((group) => (
            <section className="team-feed-group" key={group[0].id}>
              <h4>{group[0].taskTitle ?? t('team.feedGeneral')}</h4>
              <ol className="team-feed record-list">
                {group.map((item) => (
                  <li key={item.id} className={`feed-${item.kind} role-${item.role}`}>
                    <time dateTime={item.at}>{time(item.at)}</time>
                    <span>
                      <strong>{t(`team.role.${item.role}`)}</strong> {t(`team.feed.${item.kind}`)}
                    </span>
                    <span className="team-feed-took">
                      {t('team.turnTook', { duration: duration(item.durationMs / 1000) })}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ))
        ) : (
          <p className="team-empty">{t('team.feedEmpty')}</p>
        )}
      </section>
    </div>
  );
}

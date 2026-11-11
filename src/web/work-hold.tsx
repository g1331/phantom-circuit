import type { TeamWork } from '../shared/team.ts';
import { useLocale } from './locale/provider.tsx';

/** Shared client wording for an internal hold; raw diagnostics stay in task details. */
export function WorkHold({ work, showStatus = true }: { work: TeamWork; showStatus?: boolean }) {
  const { t } = useLocale();
  if (!work.teamHold) return null;
  if (work.attention === 'needs_user')
    return <span className="work-hold attention-pending">{t('team.attention.needs_user')}</span>;
  if (work.externalDeliveryPending)
    return (
      <span className="work-hold attention-pending">
        {t(work.externalMergePending ? 'task.remoteMerged' : 'task.externalPending')}
      </span>
    );
  return (
    <span className={`work-hold attention-${work.teamHold === 'blocked' ? 'blocked' : 'none'}`}>
      {showStatus && <>{t(`work.hold.${work.teamHold}`)} · </>}
      {t('work.teamResponsible')} · {t(`work.holdNext.${work.teamNext ?? 'diagnosis'}`)}
    </span>
  );
}

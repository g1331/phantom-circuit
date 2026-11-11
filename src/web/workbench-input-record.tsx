import type { WorkflowInputDetail } from '../shared/intake.ts';
import { useLocale } from './locale/provider.tsx';

export function InputRecord({ detail }: { detail: WorkflowInputDetail }) {
  const { t, date } = useLocale();
  const { input, assessment, replies } = detail;
  const when = (value: string) =>
    date(value, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  return (
    <details className="flow-detail-section flow-record" data-input-section="record">
      <summary>{t('flow.record')}</summary>
      <dl>
        <div>
          <dt>{t('flow.author')}</dt>
          <dd>
            {input.author.login} · {input.author.id}
          </dd>
        </div>
        <div>
          <dt>{t('flow.actor')}</dt>
          <dd>
            {input.actor.login} · {input.actor.id}
          </dd>
        </div>
        {input.bodyUpdatedAt && (
          <div>
            <dt>{t('flow.bodyUpdatedAt')}</dt>
            <dd>
              <time dateTime={input.bodyUpdatedAt}>{when(input.bodyUpdatedAt)}</time>
            </dd>
          </div>
        )}
        <div>
          <dt>{t('flow.observedAt')}</dt>
          <dd>
            <time dateTime={input.observedAt}>{when(input.observedAt)}</time>
          </dd>
        </div>
        <div>
          <dt>{t('flow.assessedAt')}</dt>
          <dd>
            <time dateTime={assessment.updatedAt}>{when(assessment.updatedAt)}</time>
          </dd>
        </div>
        <div>
          <dt>{t('flow.revision')}</dt>
          <dd>
            <code>{input.revision}</code>
          </dd>
        </div>
        {assessment.admission && (
          <div>
            <dt>{t('flow.command')}</dt>
            <dd>
              <code>{assessment.admission.command}</code> ·{' '}
              {t('flow.rules', { version: assessment.admission.policyVersion })}
            </dd>
          </div>
        )}
        {replies.map((reply) => (
          <div key={reply.id}>
            <dt>{t('flow.replyCreatedAt')}</dt>
            <dd>
              <time dateTime={reply.createdAt}>{when(reply.createdAt)}</time>
            </dd>
            {reply.state.status === 'sent' && (
              <>
                <dt>{t('flow.replySentAt')}</dt>
                <dd>
                  <a href={reply.state.url} target="_blank" rel="noreferrer">
                    {when(reply.state.sentAt)}
                  </a>
                </dd>
              </>
            )}
          </div>
        ))}
      </dl>
    </details>
  );
}

import {
  Check,
  CircleDashed,
  GitMerge,
  ListChecks,
  ScanEye,
  TerminalSquare,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Evidence, ReviewResult, Snapshot, Task } from '../shared/types.ts';
import { MarkdownContent } from './markdown-content.tsx';
import { Clamp } from './fold.tsx';
import { useLocale } from './locale/provider.tsx';
import { EngineeringReference } from './engineering-reference.tsx';

type Tone = 'pass' | 'fail' | 'pending' | 'merged' | 'attention';
const short = (sha?: string) => sha?.slice(0, 7) ?? '';

/** The newest result per command at one revision: reruns replace older attempts. */
function latestPerCommand(tests: Evidence[], head?: string) {
  const at = head ? tests.filter((e) => e.head === head) : tests;
  const byCommand = new Map<string, Evidence>();
  for (const evidence of at) {
    const seen = byCommand.get(evidence.command);
    if (!seen || seen.at <= evidence.at) byCommand.set(evidence.command, evidence);
  }
  return [...byCommand.values()];
}

/** Reviews still applicable to the work, preferring those at its current revision. */
function currentReviews(task: Task) {
  const live = task.reviews.filter((r) => !r.supersededByRunId);
  const atHead = live.filter((r) => r.head === task.head);
  return atHead.length ? atHead : live;
}

function Line({
  tone,
  icon,
  title,
  children,
}: {
  tone: Tone;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className={`receipt-line tone-${tone}`}>
      <span className="receipt-mark" aria-hidden="true">
        {tone === 'pass' ? <Check size={13} /> : tone === 'fail' ? <X size={13} /> : icon}
      </span>
      <div className="receipt-body">
        <h3>{title}</h3>
        {children}
      </div>
    </li>
  );
}

/**
 * The delivery receipt (ADR 0014): what was promised, what the host verified at the pinned
 * revision, what the independent reviewer concluded, and whether it reached the trunk.
 */
export function Receipt({ task, state }: { task: Task; state: Snapshot }) {
  const { t, duration } = useLocale();
  const repo = state.repos.find((r) => r.id === task.repoId);
  const branch = repo?.defaultBranch ?? 'main';
  const done = task.stage === 'done';
  const tests = latestPerCommand(task.tests, task.head);
  const failed = tests.filter((e) => e.exitCode !== 0);
  const reviews = currentReviews(task);
  const reviewModel = (r: ReviewResult) =>
    r.modelIdentity?.model ??
    r.model?.model ??
    state.runs.find((run) => run.id === r.runId)?.modelIdentity?.model;
  const reviewTone: Tone = !reviews.length
    ? 'pending'
    : reviews.every((r) => r.approved)
      ? 'pass'
      : reviews.some((r) => !r.approved && r.verdict !== 'needs_user')
        ? 'fail'
        : 'attention';
  return (
    <section className="receipt" aria-label={t('receipt.title')}>
      <h2>{t('receipt.title')}</h2>
      <ol>
        <Line
          tone={done ? 'pass' : 'pending'}
          icon={<ListChecks size={13} />}
          title={t('receipt.acceptance')}
        >
          <Clamp height={120}>
            <ul className="receipt-acceptance">
              {task.acceptance.map((item, i) => (
                <li key={i}>
                  <MarkdownContent
                    content={item}
                    label={t('acceptance.label', { count: i + 1 })}
                    copyable={false}
                  />
                </li>
              ))}
            </ul>
          </Clamp>
        </Line>

        <Line
          tone={!tests.length ? 'pending' : failed.length ? 'fail' : 'pass'}
          icon={<TerminalSquare size={13} />}
          title={t('receipt.validation')}
        >
          {!tests.length ? (
            <p className="receipt-note">{t('receipt.validationNone')}</p>
          ) : (
            <>
              <p className="receipt-note">
                {failed.length
                  ? t('receipt.failed', { count: failed.length })
                  : t('receipt.passed', { count: tests.length })}
                {task.head && <> · {t('receipt.validationAt', { head: short(task.head) })}</>}
              </p>
              {tests.map((evidence) => (
                <details
                  key={evidence.command}
                  className={
                    `fold fold-quiet test-evidence ` +
                    (evidence.exitCode === 0 ? 'passed' : 'failed')
                  }
                >
                  <summary>
                    <code>{evidence.command}</code>
                    {evidence.durationMs !== undefined && (
                      <span>{duration(evidence.durationMs / 1000)}</span>
                    )}
                  </summary>
                  <pre className="log-block">{evidence.output}</pre>
                </details>
              ))}
            </>
          )}
        </Line>

        <Line tone={reviewTone} icon={<ScanEye size={13} />} title={t('receipt.review')}>
          {!reviews.length ? (
            <p className="receipt-note">{t('receipt.reviewNone')}</p>
          ) : (
            reviews.map((r) => {
              const model = reviewModel(r);
              return (
                <div
                  className={`receipt-review ${
                    r.verdict === 'needs_user' ? 'attention' : r.approved ? 'approved' : 'changes'
                  }`}
                  key={r.runId ?? r.axis}
                >
                  <p className="receipt-note">
                    <strong>
                      {r.verdict === 'needs_user'
                        ? t('review.needsUser')
                        : r.approved
                          ? t('ui.approved')
                          : t('ui.changesRequested')}
                    </strong>
                    {model && <> · {t('receipt.reviewBy', { model })}</>}
                    {r.head && <> · {t('receipt.validationAt', { head: short(r.head) })}</>}
                  </p>
                  <Clamp height={120}>
                    <MarkdownContent
                      content={r.summary}
                      label={t('review.summary', { axis: r.axis })}
                      copyable={false}
                    />
                  </Clamp>
                  {r.findings.length > 0 && (
                    <details className="fold fold-quiet">
                      <summary>{t('receipt.findings', { count: r.findings.length })}</summary>
                      {r.findings.map((f, i) => (
                        <MarkdownContent
                          key={i}
                          content={f}
                          label={t('review.finding', { axis: r.axis, count: i + 1 })}
                          copyable={false}
                        />
                      ))}
                    </details>
                  )}
                </div>
              );
            })
          )}
        </Line>

        <Line
          tone={done ? 'merged' : 'pending'}
          icon={done || task.pendingMerge ? <GitMerge size={13} /> : <CircleDashed size={13} />}
          title={t('receipt.merge')}
        >
          <p className="receipt-note">
            {done
              ? t('receipt.merged', { branch })
              : task.stage === 'cancelled'
                ? t('receipt.cancelled')
                : task.pendingMerge || task.stage === 'merging'
                  ? t('receipt.merging', { branch })
                  : t('receipt.notMerged')}
            {done && task.head && <> · {short(task.head)}</>}
            {task.prUrl && (
              <>
                {' · '}
                <EngineeringReference task={task} kind="pr" />
              </>
            )}
          </p>
        </Line>
      </ol>
    </section>
  );
}

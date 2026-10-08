import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { List, X } from 'lucide-react';
import type { Message, PMActivity, Run } from '../shared/types.ts';
import { ActivityGroup, ActivityRow } from './pm-activity.tsx';
import { useLocale } from './locale/provider.tsx';

type Entry = { at: string; order: number } & ({ message: Message } | { activity: PMActivity });
type Item =
  { kind: 'message'; message: Message } | { kind: 'process'; runId: string; entries: Entry[] };

function presentation(messages: Message[], activities: PMActivity[], runs: Run[]): Item[] {
  const runIds = new Set(runs.filter((run) => run.role === 'pm').map((run) => run.id));
  const entries: Entry[] = [
    ...messages.map((message) => ({
      at: message.createdAt,
      order: message.timelineOrder ?? 0,
      message,
    })),
    ...activities.map((activity) => ({
      at: activity.startedAt,
      order: activity.timelineOrder ?? 0,
      activity,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const final = new Map<string, string>();
  for (const entry of entries) {
    if ('message' in entry && entry.message.role === 'assistant' && entry.message.runId)
      final.set(entry.message.runId, entry.message.id);
  }
  // A streamed draft can precede its tool evidence. Keep its answer after only
  // the immediately adjacent same-Run evidence, never crossing a human input.
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!('message' in entry) || final.get(entry.message.runId ?? '') !== entry.message.id)
      continue;
    let end = index + 1;
    while (end < entries.length) {
      const following = entries[end]!;
      if (!('activity' in following) || following.activity.runId !== entry.message.runId) break;
      end++;
    }
    if (end > index + 1) {
      entries.splice(index, 1);
      entries.splice(end - 1, 0, entry);
      index = end - 1;
    }
  }
  const result: Item[] = [];
  for (const entry of entries) {
    const message = 'message' in entry ? entry.message : undefined;
    const runId = 'activity' in entry ? entry.activity.runId : message?.runId;
    const process =
      'activity' in entry ||
      (message?.role === 'assistant' &&
        runId &&
        runIds.has(runId) &&
        final.get(runId) !== message.id);
    if (process && runId) {
      const previous = result.at(-1);
      if (previous?.kind === 'process' && previous.runId === runId) previous.entries.push(entry);
      else result.push({ kind: 'process', runId, entries: [entry] });
    } else if (message) result.push({ kind: 'message', message });
  }
  return result;
}

export function ConversationFlow({
  messages,
  activities,
  runs,
  roots,
  renderMessage,
  disclosures,
  following,
}: {
  messages: Message[];
  activities: PMActivity[];
  runs: Run[];
  roots: string[];
  renderMessage: (message: Message) => ReactNode;
  disclosures: Map<string, boolean>;
  following: RefObject<boolean>;
}) {
  const liveRuns = useRef(new Set<string>());
  for (const run of runs) {
    if (run.status === 'running' || run.status === 'waiting') liveRuns.current.add(run.id);
  }
  const items = useMemo(
    () => presentation(messages, activities, runs),
    [messages, activities, runs],
  );
  return items.map((item) => {
    if (item.kind === 'message') return renderMessage(item.message);
    const first = item.entries[0]!;
    const key = 'activity' in first ? first.activity.id : first.message.id;
    const run = runs.find((run) => run.id === item.runId);
    return (
      <ActivityGroup
        key={key}
        groupId={key}
        disclosures={disclosures}
        wasLive={liveRuns.current.has(item.runId)}
        following={following}
        run={run}
        runId={item.runId}
        activities={item.entries.flatMap((entry) => ('activity' in entry ? [entry.activity] : []))}
        runStatus={run?.status}
        roots={roots}
      >
        {item.entries.map((entry) =>
          'message' in entry ? (
            renderMessage(entry.message)
          ) : (
            <ActivityRow key={entry.activity.id} activity={entry.activity} roots={roots} />
          ),
        )}
      </ActivityGroup>
    );
  });
}

/** Preserve the visible reading anchor when content above it changes height. */
export function useReadingAnchor(
  scroll: RefObject<HTMLDivElement | null>,
  content: RefObject<HTMLDivElement | null>,
  following: RefObject<boolean>,
  identity: string,
) {
  useLayoutEffect(() => {
    const element = scroll.current;
    const body = content.current;
    if (!element || !body) return;
    let anchors: { element: HTMLElement; offset: number }[] = [];
    const capture = () => {
      if (following.current) {
        anchors = [];
        return;
      }
      const top = element.getBoundingClientRect().top;
      anchors = [...body.querySelectorAll<HTMLElement>('.message[id], .pm-process[id]')]
        .filter(
          (node) =>
            node.getBoundingClientRect().bottom > top &&
            node.getBoundingClientRect().top < top + element.clientHeight,
        )
        .map((node) => ({ element: node, offset: node.getBoundingClientRect().top - top }));
    };
    const restore = () => {
      if (following.current) return;
      const anchor = anchors.find(
        (anchor) => anchor.element.isConnected && anchor.element.getClientRects().length,
      );
      if (anchor)
        element.scrollTop +=
          anchor.element.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          anchor.offset;
    };
    element.addEventListener('scroll', capture, { passive: true });
    const observer = new ResizeObserver(restore);
    observer.observe(body);
    capture();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', capture);
    };
  }, [scroll, content, following, identity]);
}

export function TurnNavigator({
  messages,
  runs,
  scroll,
  onNavigate,
}: {
  messages: Message[];
  runs: Run[];
  scroll: RefObject<HTMLDivElement | null>;
  onNavigate: () => void;
}) {
  const { t } = useLocale();
  const [active, setActive] = useState('');
  const [preview, setPreview] = useState('');
  const [directory, setDirectory] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const rail = useRef<HTMLElement>(null);
  const users = messages
    .filter((message) => message.role === 'user')
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || (a.timelineOrder ?? 0) - (b.timelineOrder ?? 0),
    );
  const userIds = users.map((message) => message.id).join(',');
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const update = () => {
      const top = element.getBoundingClientRect().top + 48;
      let current = users[0]?.id ?? '';
      for (const message of users) {
        const anchor = document.getElementById(`message-${message.id}`);
        if (anchor && anchor.getBoundingClientRect().top <= top) current = message.id;
      }
      setActive(current);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [scroll, userIds]);
  useEffect(() => {
    const element = rail.current;
    if (!element || element.matches(':hover') || element.contains(document.activeElement)) return;
    const mark = element.querySelector<HTMLElement>('[aria-current="true"]');
    if (mark) element.scrollTop = Math.max(0, mark.offsetTop - element.clientHeight / 2);
  }, [active]);
  useEffect(() => {
    if (directory) dialog.current?.showModal();
    else dialog.current?.close();
  }, [directory]);
  const excerpt = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160);
  const response = (message: Message) => {
    const ids = new Set(
      runs.filter((run) => run.sourceMessageId === message.id).map((run) => run.id),
    );
    return (
      messages
        .filter(
          (reply) =>
            reply.role === 'assistant' &&
            (reply.sourceMessageId === message.id || (reply.runId && ids.has(reply.runId))),
        )
        .at(-1)?.content ?? ''
    );
  };
  function navigate(message: Message) {
    onNavigate();
    setDirectory(false);
    requestAnimationFrame(() => {
      const element = scroll.current;
      const anchor = document.getElementById(`message-${message.id}`);
      if (!element || !anchor) return;
      element.scrollTop +=
        anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - 20;
      anchor.focus({ preventScroll: true });
      setActive(message.id);
    });
  }
  if (users.length < 2) return null;
  const selected = users.find((message) => message.id === preview);
  return (
    <>
      <button
        className="turn-directory-trigger icon-button"
        aria-label={t('chat.directory')}
        onClick={() => setDirectory(true)}
      >
        <List size={18} />
      </button>
      <nav
        ref={rail}
        className="turn-rail"
        aria-label={t('chat.navigation')}
        onMouseLeave={() => setPreview('')}
      >
        {users.map((message, index) => (
          <button
            key={message.id}
            type="button"
            className="turn-mark"
            aria-describedby={preview === message.id ? `turn-preview-${message.id}` : undefined}
            aria-label={t('chat.jumpTurn', { turn: index + 1 })}
            aria-current={active === message.id ? 'true' : undefined}
            onMouseEnter={() => setPreview(message.id)}
            onFocus={() => setPreview(message.id)}
            onBlur={() => setPreview('')}
            onClick={() => navigate(message)}
          />
        ))}
      </nav>
      {selected && (
        <div className="turn-preview" id={`turn-preview-${selected.id}`} role="tooltip">
          <strong>{excerpt(selected.content) || t('ui.addImages')}</strong>
          {response(selected) && <p>{excerpt(response(selected))}</p>}
        </div>
      )}
      <dialog
        ref={dialog}
        className="turn-directory"
        aria-label={t('chat.directory')}
        onCancel={() => setDirectory(false)}
        onClose={() => setDirectory(false)}
      >
        <div className="turn-directory-heading">
          <h2>{t('chat.directory')}</h2>
          <button
            className="icon-button"
            aria-label={t('common.close')}
            onClick={() => setDirectory(false)}
          >
            <X size={18} />
          </button>
        </div>
        {users.map((message, index) => (
          <button
            className="turn-directory-item"
            key={message.id}
            aria-current={active === message.id ? 'true' : undefined}
            onClick={() => navigate(message)}
          >
            <span>{index + 1}</span>
            <span>{excerpt(message.content) || t('ui.addImages')}</span>
          </button>
        ))}
      </dialog>
    </>
  );
}

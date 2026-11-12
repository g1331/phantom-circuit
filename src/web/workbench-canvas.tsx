import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Github, Maximize, MessageSquare, Minus, Plus } from 'lucide-react';
import type { Snapshot } from '../shared/types.ts';
import type { TeamView } from '../shared/team.ts';
import type { FlowRow } from './workbench-board.tsx';
import { WorkbenchAttention } from './workbench-attention.tsx';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';

function origin(row: FlowRow) {
  return row.kind === 'input'
    ? `github:${row.entry.input.repoId}`
    : row.task.issueOrigin
      ? `github:${row.task.repoId}`
      : 'web';
}

function useConnections(key: string) {
  const surface = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ id: string; d: string; active: boolean }[]>([]);
  useLayoutEffect(() => {
    const root = surface.current;
    if (!root) return;
    let frame = 0;
    function measure() {
      if (!root || root.offsetWidth === 0) return;
      const bounds = root.getBoundingClientRect();
      const scale = bounds.width / root.offsetWidth;
      const nodes = new Map(
        [...root.querySelectorAll<HTMLElement>('[data-graph-node]')].map((node) => [
          node.dataset.graphNode,
          node,
        ]),
      );
      const edges = [...root.querySelectorAll<HTMLElement>('[data-graph-from]')];
      setPaths(
        edges.flatMap((target) => {
          const source = nodes.get(target.dataset.graphFrom);
          if (!source) return [];
          const start = source.getBoundingClientRect();
          const end = target.getBoundingClientRect();
          const x1 = (start.right - bounds.left) / scale;
          const y1 = (start.top + start.height / 2 - bounds.top) / scale;
          const x2 = (end.left - bounds.left) / scale;
          const y2 = (end.top + Math.min(end.height / 2, 80) - bounds.top) / scale;
          const bend = Math.max(32, (x2 - x1) / 2);
          return [
            {
              id: target.dataset.graphNode ?? '',
              d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
              active: target.dataset.graphActive === 'true',
            },
          ];
        }),
      );
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(root);
    root.querySelectorAll('[data-graph-node]').forEach((node) => observer.observe(node));
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [key]);
  return { surface, paths };
}

export function WorkCanvas({
  items,
  state,
  team,
  projectId,
  renderItem,
}: {
  items: FlowRow[];
  state: Snapshot;
  team: TeamView;
  projectId: string;
  renderItem: (row: FlowRow) => ReactNode;
}) {
  const { t } = useLocale();
  const [zoom, setZoom] = useState(1);
  const sources = items.length
    ? [...new Set(items.map(origin))]
    : state.repos.filter((repo) => repo.projectId === projectId).map((repo) => `github:${repo.id}`);
  const waiting = items.filter((row) => row.kind === 'input');
  const work = items.filter((row) => row.kind === 'work');
  const key = items.map((row) => `${row.id}:${origin(row)}:${row.active}`).join(',');
  const { surface, paths } = useConnections(key);
  return (
    <div className="work-canvas" data-zoom={zoom}>
      <div className="canvas-viewport">
        <div className="canvas-stage" ref={surface} style={{ zoom }}>
          <svg className="canvas-connections" aria-hidden="true">
            <defs>
              <marker
                id="flow-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
              </marker>
            </defs>
            {paths.map((path) => (
              <path
                key={path.id}
                d={path.d}
                className={path.active ? 'active' : ''}
                markerEnd="url(#flow-arrow)"
              />
            ))}
          </svg>
          <div className="canvas-sources">
            {sources.map((id) => {
              const repo = state.repos.find((item) => `github:${item.id}` === id);
              const sourceRows = items.filter((row) => origin(row) === id);
              const Icon = repo ? Github : MessageSquare;
              return (
                <section className="canvas-source" key={id} data-graph-node={id}>
                  <header>
                    <Icon size={25} aria-hidden="true" />
                    <div>
                      <strong>{repo ? 'GitHub' : t('flow.sourceWeb')}</strong>
                      {repo && <span>{repo.github}</span>}
                    </div>
                  </header>
                  <div className="canvas-source-links">
                    {sourceRows.slice(0, 3).map((row) => (
                      <a
                        key={row.id}
                        href={routeHref(
                          row.kind === 'input'
                            ? { page: 'input', projectId, inputId: row.id }
                            : { page: 'task', projectId, taskId: row.id },
                        )}
                      >
                        {row.kind === 'input' ? `Issue #${row.entry.input.number}` : row.task.title}
                      </a>
                    ))}
                  </div>
                  <a
                    className="canvas-source-settings"
                    href={routeHref({ page: repo ? 'sources' : 'conversation', projectId })}
                  >
                    {t(repo ? 'flow.settings' : 'flow.openConversation')}
                  </a>
                </section>
              );
            })}
          </div>
          <div className="canvas-assessment">
            <WorkbenchAttention state={state} team={team} projectId={projectId} />
            {waiting.map((row) => (
              <div
                key={row.id}
                data-graph-node={row.id}
                data-graph-from={origin(row)}
                data-graph-active={row.active}
              >
                {renderItem(row)}
              </div>
            ))}
          </div>
          <div className="canvas-work">
            {work.map((row) => (
              <div
                key={row.id}
                data-graph-node={row.id}
                data-graph-from={origin(row)}
                data-graph-active={row.active}
              >
                {renderItem(row)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="canvas-tools" role="group" aria-label={t('flow.reset')}>
        <button
          className="icon-button"
          aria-label={t('flow.zoomOut')}
          disabled={zoom <= 0.6}
          onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}
        >
          <Minus size={15} />
        </button>
        <output>{Math.round(zoom * 100)}%</output>
        <button
          className="icon-button"
          aria-label={t('flow.zoomIn')}
          disabled={zoom >= 1.4}
          onClick={() => setZoom((value) => Math.min(1.4, value + 0.1))}
        >
          <Plus size={15} />
        </button>
        <button className="icon-button" aria-label={t('flow.reset')} onClick={() => setZoom(1)}>
          <Maximize size={15} />
        </button>
      </div>
    </div>
  );
}

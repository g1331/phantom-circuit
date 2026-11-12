import type { ReactNode, KeyboardEvent } from 'react';
import { Github, Maximize, MessageSquare, Minus, Plus, RotateCcw } from 'lucide-react';
import type { Snapshot } from '../shared/types.ts';
import type { FlowRow } from './workbench-board.tsx';
import { useLocale } from './locale/provider.tsx';
import { routeHref } from './route.ts';
import { useCanvasView } from './use-canvas-view.ts';
import { CanvasConnections } from './canvas-connections.tsx';

function origin(row: FlowRow) {
  return row.kind === 'input'
    ? `github:${row.entry.input.repoId}`
    : row.task.issueOrigin
      ? `github:${row.task.repoId}`
      : 'web';
}

export function WorkCanvas({
  items,
  state,
  projectId,
  renderItem,
}: {
  items: FlowRow[];
  state: Snapshot;
  projectId: string;
  renderItem: (row: FlowRow) => ReactNode;
}) {
  const { t } = useLocale();
  const canvas = useCanvasView();
  const sources = [...new Set(items.map(origin))];
  const revision = items.map((row) => `${row.id}:${origin(row)}:${row.active}`).join(',');
  const { x, y, scale } = canvas.view;
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case 'ArrowLeft':
        canvas.pan(60, 0);
        break;
      case 'ArrowRight':
        canvas.pan(-60, 0);
        break;
      case 'ArrowUp':
        canvas.pan(0, 60);
        break;
      case 'ArrowDown':
        canvas.pan(0, -60);
        break;
      case '+':
      case '=':
        canvas.zoom(canvas.view.scale * 1.2);
        break;
      case '-':
        canvas.zoom(canvas.view.scale / 1.2);
        break;
      case '0':
        canvas.reset();
        break;
      case 'f':
        canvas.fit();
        break;
      default:
        return;
    }
    event.preventDefault();
  }
  return (
    <div className="work-canvas" data-zoom={canvas.view.scale}>
      <div
        className="canvas-viewport"
        ref={canvas.viewport}
        tabIndex={0}
        role="region"
        aria-label={t('flow.canvas')}
        title={t('flow.canvasHelp')}
        data-dragging={canvas.dragging || undefined}
        onPointerDown={canvas.pointerDown}
        onPointerMove={canvas.pointerMove}
        onPointerUp={canvas.pointerEnd}
        onPointerCancel={canvas.pointerEnd}
        onLostPointerCapture={canvas.pointerEnd}
        onKeyDown={keyDown}
        onFocusCapture={canvas.revealFocus}
      >
        <div
          className="canvas-stage"
          ref={canvas.surface}
          style={{
            transform: `translate(${x}px, ${y}px) scale(${scale})`,
          }}
        >
          <CanvasConnections surface={canvas.surface} revision={revision} />
          {sources.map((id) => {
            const repo = state.repos.find((item) => `github:${item.id}` === id);
            const sourceRows = items.filter((row) => origin(row) === id);
            const Icon = repo ? Github : MessageSquare;
            return (
              <div className="canvas-lane" key={id}>
                <section className="canvas-source" data-graph-node={id}>
                  <header>
                    <Icon size={22} aria-hidden="true" />
                    <div>
                      <strong>{repo ? 'GitHub' : t('flow.sourceWeb')}</strong>
                      <span>
                        {repo?.github ?? t('flow.workCount', { count: sourceRows.length })}
                      </span>
                    </div>
                  </header>
                  {repo && (
                    <a
                      className="canvas-source-settings"
                      href={routeHref({ page: 'sources', projectId })}
                    >
                      {t('flow.settings')}
                    </a>
                  )}
                </section>
                <div className="canvas-work">
                  {sourceRows.map((row) => (
                    <div
                      key={row.id}
                      data-graph-node={row.id}
                      data-graph-from={id}
                      data-graph-active={row.active}
                    >
                      {renderItem(row)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="canvas-tools" role="group" aria-label={t('flow.canvas')}>
        <button
          className="icon-button"
          aria-label={t('flow.zoomOut')}
          disabled={canvas.view.scale <= 0.15}
          onClick={() => canvas.zoom(canvas.view.scale / 1.2)}
        >
          <Minus size={16} />
        </button>
        <output>{Math.round(canvas.view.scale * 100)}%</output>
        <button
          className="icon-button"
          aria-label={t('flow.zoomIn')}
          disabled={canvas.view.scale >= 2}
          onClick={() => canvas.zoom(canvas.view.scale * 1.2)}
        >
          <Plus size={16} />
        </button>
        <button className="icon-button" aria-label={t('flow.fit')} onClick={canvas.fit}>
          <Maximize size={16} />
        </button>
        <button className="icon-button" aria-label={t('flow.reset')} onClick={canvas.reset}>
          <RotateCcw size={16} />
        </button>
      </div>
    </div>
  );
}

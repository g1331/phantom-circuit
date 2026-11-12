import { useEffect, useState, type RefObject } from 'react';

export function CanvasConnections({
  surface,
  revision,
}: {
  surface: RefObject<HTMLDivElement | null>;
  revision: string;
}) {
  const [paths, setPaths] = useState<{ id: string; d: string; active: boolean }[]>([]);
  useEffect(() => {
    const root = surface.current;
    if (!root) return;
    let frame = 0;
    function measure() {
      if (!root || !root.offsetWidth) return;
      const bounds = root.getBoundingClientRect();
      const scale = bounds.width / root.offsetWidth;
      const nodes = new Map(
        [...root.querySelectorAll<HTMLElement>('[data-graph-node]')].map((node) => [
          node.dataset.graphNode,
          node,
        ]),
      );
      setPaths(
        [...root.querySelectorAll<HTMLElement>('[data-graph-from]')].flatMap((target) => {
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
  }, [surface, revision]);
  return (
    <svg className="canvas-connections" aria-hidden="true">
      {paths.map((path) => (
        <path key={path.id} d={path.d} className={path.active ? 'active' : ''} />
      ))}
    </svg>
  );
}

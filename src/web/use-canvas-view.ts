import { useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from 'react';

type View = { x: number; y: number; scale: number };
const initial: View = { x: 32, y: 32, scale: 1 };
const desktop = () => window.matchMedia('(min-width: 661px)').matches;

export function useCanvasView() {
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const current = useRef(initial);
  const [view, setView] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; view: View } | undefined>(undefined);

  function update(next: View) {
    current.current = next;
    setView(next);
  }
  function zoom(scale: number, x?: number, y?: number) {
    const root = viewport.current;
    if (!root) return;
    const old = current.current;
    const next = Math.min(2, Math.max(0.15, scale));
    const cx = x ?? root.clientWidth / 2;
    const cy = y ?? root.clientHeight / 2;
    update({
      x: cx - ((cx - old.x) * next) / old.scale,
      y: cy - ((cy - old.y) * next) / old.scale,
      scale: next,
    });
  }
  function fit() {
    const root = viewport.current;
    const content = surface.current;
    if (!root || !content || !desktop()) return;
    const scale = Math.min(
      1,
      (root.clientWidth - 64) / content.offsetWidth,
      (root.clientHeight - 96) / content.offsetHeight,
    );
    const bounded = Math.max(0.15, scale);
    update({
      x: (root.clientWidth - content.offsetWidth * bounded) / 2,
      y: Math.max(24, (root.clientHeight - 48 - content.offsetHeight * bounded) / 2),
      scale: bounded,
    });
  }
  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root) return;
    if (desktop() && surface.current) {
      update({ ...initial, x: Math.max(32, (root.clientWidth - surface.current.offsetWidth) / 2) });
    }
    function wheel(event: WheelEvent) {
      if (!desktop()) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const bounds = root!.getBoundingClientRect();
        zoom(
          current.current.scale * Math.exp(-event.deltaY * 0.005),
          event.clientX - bounds.left,
          event.clientY - bounds.top,
        );
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root!.clientHeight : 1;
        update({
          ...current.current,
          x: current.current.x - (event.shiftKey ? event.deltaY : event.deltaX) * unit,
          y: current.current.y - (event.shiftKey ? 0 : event.deltaY) * unit,
        });
      }
    }
    root.addEventListener('wheel', wheel, { passive: false });
    return () => root.removeEventListener('wheel', wheel);
  }, []);

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!desktop() || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('a, button, input, textarea, article, section'))
      return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view: current.current,
    };
    setDragging(true);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    update({
      ...start.view,
      x: start.view.x + event.clientX - start.x,
      y: start.view.y + event.clientY - start.y,
    });
  }
  function pointerEnd() {
    drag.current = undefined;
    setDragging(false);
  }
  function revealFocus(event: FocusEvent<HTMLDivElement>) {
    const root = viewport.current;
    if (!root || event.target === root || !desktop()) return;
    const bounds = root.getBoundingClientRect();
    const target = event.target.getBoundingClientRect();
    if (
      target.left >= bounds.left &&
      target.right <= bounds.right &&
      target.top >= bounds.top &&
      target.bottom <= bounds.bottom - 64
    )
      return;
    update({
      ...current.current,
      x: current.current.x + bounds.left + bounds.width / 2 - target.left - target.width / 2,
      y: current.current.y + bounds.top + bounds.height / 2 - target.top - target.height / 2,
    });
  }
  return {
    viewport,
    surface,
    view,
    dragging,
    zoom,
    fit,
    reset: () => update(initial),
    pan: (x: number, y: number) =>
      update({ ...current.current, x: current.current.x + x, y: current.current.y + y }),
    revealFocus,
    pointerDown,
    pointerMove,
    pointerEnd,
  };
}

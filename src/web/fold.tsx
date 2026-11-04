import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale } from './locale/provider.tsx';
import { routeHref, type Route } from './route.ts';

/**
 * One disclosure row for every detail record: a chevron, a title and right-aligned facts on a
 * single line. The body mounts on first open, so long logs cost nothing until someone asks.
 */
export function Fold({
  title,
  meta,
  children,
  className = '',
  open: initial = false,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <details
      className={`fold ${className}`}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span className="fold-title">{title}</span>
        {meta && <span className="fold-meta">{meta}</span>}
      </summary>
      {open && <div className="fold-body">{children}</div>}
    </details>
  );
}

/** Long prose stays a few lines tall until the reader asks for the rest. */
export function Clamp({ children, height = 220 }: { children: ReactNode; height?: number }) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current!;
    // Within a 40px margin the whole text shows; a toggle that reveals two lines is noise.
    const measure = () => setOverflows(element.scrollHeight > height + 40);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [height]);
  const clamped = overflows && !open;
  return (
    <div className={`clamp ${clamped ? 'clamped' : ''}`}>
      <div ref={ref} className="clamp-body" style={clamped ? { maxHeight: height } : undefined}>
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          className="clamp-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? t('fold.less') : t('fold.more')}
        </button>
      )}
    </div>
  );
}

/** Sections within one page, each its own address so a reload or a shared link lands there. */
export function PageTabs({
  label,
  route,
  current,
  tabs,
}: {
  label: string;
  route: Route;
  current: string;
  tabs: { view: string; label: string; count?: number }[];
}) {
  const { number } = useLocale();
  return (
    <nav className="page-tabs" aria-label={label}>
      {tabs.map((tab, i) => (
        <a
          key={tab.view}
          href={routeHref({ ...route, view: i === 0 ? undefined : tab.view })}
          aria-current={current === tab.view ? 'page' : undefined}
        >
          {tab.label}
          {!!tab.count && <span className="page-tab-count">{number(tab.count)}</span>}
        </a>
      ))}
    </nav>
  );
}

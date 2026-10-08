import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export function PreferenceControl({
  className,
  label,
  icon,
  value,
  options,
  onChange,
}: {
  className: string;
  label: string;
  icon?: ReactNode;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    if (!open) {
      if (element.matches(':popover-open')) element.hidePopover();
      return;
    }
    if (!element.matches(':popover-open')) element.showPopover();
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(rect.right - element.offsetWidth, innerWidth - element.offsetWidth - 8))}px`;
      const below = rect.bottom + 4;
      element.style.top = `${Math.max(8, below + element.offsetHeight <= innerHeight - 8 ? below : rect.top - element.offsetHeight - 4)}px`;
    };
    place();
    element.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    const element = menu.current!;
    const toggle = () => {
      if (!element.matches(':popover-open')) setOpen(false);
    };
    element.addEventListener('toggle', toggle);
    return () => element.removeEventListener('toggle', toggle);
  }, []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        data-value={value}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
        <span className="control-label">{label}</span>
        <span className="choice-value">
          {options.find((option) => option.value === value)?.label}
          <ChevronDown size={13} />
        </span>
      </button>
      <div
        id={id}
        ref={menu}
        popover="auto"
        className="preference-menu"
        role="menu"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            if (event.key === 'Escape') event.preventDefault();
            setOpen(false);
            trigger.current?.focus();
            return;
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button'));
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            tabIndex={-1}
            aria-checked={option.value === value}
            data-value={option.value}
            onClick={() => {
              onChange(option.value);
              setOpen(false);
              trigger.current?.focus();
            }}
          >
            <span>{option.label}</span>
            <Check
              size={14}
              style={{ visibility: option.value === value ? 'visible' : 'hidden' }}
            />
          </button>
        ))}
      </div>
    </>
  );
}

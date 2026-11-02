import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useLocale, LanguageControl } from './locale/provider.tsx';

export function Metric({
  value,
  label,
  suffix,
  live,
}: {
  value: number;
  label: string;
  suffix?: string;
  live?: boolean;
}) {
  const { number } = useLocale();
  return (
    <div className="metric">
      <div className="metric-value">
        {number(value)}
        <span>{suffix}</span>
        {live && value > 0 && <span className="pulse-dot" />}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}
export function Empty({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      {icon}
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-content">
        <header>
          <div className="modal-heading">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="modal-toolbar">
            <LanguageControl />
            <button className="icon-button" aria-label={t('common.close')} onClick={onClose}>
              <X size={19} />
            </button>
          </div>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </dialog>
  );
}

import {
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { Send, X } from 'lucide-react';
import { useLocale } from './locale/provider.tsx';
import { ErrorText } from './error-text.tsx';
import { LocalUiError } from './api.ts';
import type { Message } from '../shared/types.ts';

export interface PMSubmission {
  content: string;
  images: File[];
  intent: NonNullable<Message['intent']>;
  deliveryMode: 'queue' | 'steer';
}
export interface PMComposerHandle {
  setDraft: (content: string) => void;
}
export function PMComposer({
  busy,
  pmBusy,
  onSend,
  modelControl,
  ref,
}: {
  busy: boolean;
  pmBusy: boolean;
  onSend: (submission: PMSubmission) => Promise<boolean>;
  modelControl: ReactNode;
  ref?: Ref<PMComposerHandle>;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState('');
  const [intent, setIntent] = useState<PMSubmission['intent']>('discuss');
  const [deliveryMode, setDeliveryMode] = useState<'queue' | 'steer'>('queue');
  const [error, setError] = useState<Error>();
  const [images, setImages] = useState<{ file: File; url: string }[]>([]);
  const [preview, setPreview] = useState<(typeof images)[number]>();
  const previewDialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (preview && previewDialog.current && !previewDialog.current.open)
      previewDialog.current.showModal();
  }, [preview]);
  useEffect(() => {
    if (preview && !images.includes(preview)) setPreview(undefined);
  }, [images, preview]);
  const imageDrafts = useRef(images);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  useImperativeHandle(ref, () => ({ setDraft }), []);
  function updateImages(next: typeof images) {
    for (const image of imageDrafts.current) {
      if (!next.includes(image)) URL.revokeObjectURL(image.url);
    }
    imageDrafts.current = next;
    setImages(next);
  }
  function addImages(files: File[]) {
    if (busy || sending.current) return;
    if (files.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
      setError(new LocalUiError('ui.onlyPngJpegAndWebpImagesAre'));
      return;
    }
    setError(undefined);
    updateImages([
      ...imageDrafts.current,
      ...files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
  }
  useEffect(
    () => () => {
      for (const image of imageDrafts.current) URL.revokeObjectURL(image.url);
    },
    [],
  );
  useLayoutEffect(() => {
    const element = draftRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(240, Math.max(52, element.scrollHeight))}px`;
  }, [draft]);
  useEffect(() => {
    if (!pmBusy) setDeliveryMode('queue');
  }, [pmBusy]);
  async function send() {
    if ((!draft.trim() && !images.length) || busy || sending.current) return;
    sending.current = true;
    setError(undefined);
    try {
      if (
        await onSend({
          content: draft,
          images: images.map((image) => image.file),
          intent,
          deliveryMode: pmBusy ? deliveryMode : 'queue',
        })
      ) {
        setDraft('');
        updateImages([]);
      }
    } finally {
      sending.current = false;
    }
  }
  return (
    <div className="composer">
      {error && (
        <div role="alert">
          {error instanceof LocalUiError ? t(error.key) : <ErrorText error={error} />}
        </div>
      )}
      {!!images.length && (
        <div className="image-drafts">
          {images.map((image) => (
            <div
              key={image.url}
              className="image-draft"
              title={`${image.file.name} · ${Math.max(1, Math.ceil(image.file.size / 1024))} KiB`}
            >
              <button
                type="button"
                className="image-preview-trigger"
                aria-label={t('images.preview', { name: image.file.name })}
                onClick={() => setPreview(image)}
              >
                <img src={image.url} alt={t('images.pending', { name: image.file.name })} />
              </button>
              <button
                type="button"
                className="image-remove"
                aria-label={t('images.remove', { name: image.file.name })}
                disabled={busy}
                onClick={() => updateImages(images.filter((item) => item !== image))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {preview && (
        <dialog
          ref={previewDialog}
          className="image-preview-dialog"
          aria-label={t('images.preview', { name: preview.file.name })}
          onClose={() => setPreview(undefined)}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              event.currentTarget.close();
          }}
        >
          <div className="image-preview-header">
            <span title={preview.file.name}>{preview.file.name}</span>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={() => previewDialog.current?.close()}
              autoFocus
            >
              <X size={18} />
            </button>
          </div>
          <img src={preview.url} alt={t('images.preview', { name: preview.file.name })} />
        </dialog>
      )}
      <textarea
        ref={draftRef}
        aria-label={t('chat.message')}
        title={t('chat.shortcut')}
        disabled={busy}
        placeholder={
          intent === 'discuss'
            ? t('chat.discussPlaceholder')
            : intent === 'implement'
              ? t('chat.implementPlaceholder')
              : t('chat.feedbackPlaceholder')
        }
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (!files.length) return;
          event.preventDefault();
          addImages(files);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-footer">
        <div className="composer-tools">
          <div className="image-picker">
            <label title={`${t('images.formats')} · ${t('images.pasteHint')}`}>
              {t('ui.addImages')}{' '}
              <input
                aria-label={t('ui.chooseImages')}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                disabled={busy}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  addImages(files);
                }}
              />
            </label>
          </div>
          <div className="intent-row">
            {(['discuss', 'implement', 'feedback'] as const).map((i) => (
              <button
                key={i}
                className={intent === i ? 'selected' : ''}
                title={`${i === 'discuss' ? t('chat.discussNote') : t('chat.implementNote')} · ${t('chat.shortcut')}`}
                aria-pressed={intent === i}
                onClick={() => setIntent(i)}
              >
                {
                  {
                    discuss: t('chat.talk'),
                    implement: t('chat.delegate'),
                    feedback: t('chat.feedback'),
                  }[i]
                }
              </button>
            ))}
          </div>
        </div>
        <div className="send-actions">
          <div className="send-controls">
            {modelControl}
            {pmBusy && (
              <select
                className="delivery-select"
                aria-label={t('delivery.mode')}
                value={deliveryMode}
                onChange={(event) => setDeliveryMode(event.target.value as 'queue' | 'steer')}
              >
                <option value="queue">{t('delivery.queue')}</option>
                <option value="steer">{t('delivery.steer')}</option>
              </select>
            )}
            <button
              className="send-button"
              disabled={(!draft.trim() && !images.length) || busy}
              onClick={() => void send()}
            >
              <span>
                {pmBusy
                  ? t(deliveryMode === 'steer' ? 'delivery.sendSteer' : 'delivery.sendQueue')
                  : t('common.send')}
              </span>
              <Send size={17} />
            </button>
          </div>
          {pmBusy && <small className="delivery-note">{t('delivery.steerFallback')}</small>}
        </div>
      </div>
    </div>
  );
}

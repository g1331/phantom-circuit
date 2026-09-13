import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState } from 'react';
import { useLocale } from './locale/provider.tsx';

const components: Components = {
  table: function Table({ children }) {
    const { t } = useLocale();
    return (
      <div className="markdown-table" role="region" aria-label={t('markdown.table')} tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
  a: ({ href, children, title }) =>
    href ? (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export function MarkdownContent({ content, label }: { content: string; label?: string }) {
  const { t } = useLocale();
  const [raw, setRaw] = useState(false);
  const [copyResult, setCopyResult] = useState<{
    content: string;
    message?: 'markdown.copied' | 'markdown.copyFailed';
  }>({ content: '' });
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopyResult({ content, message: 'markdown.copied' });
    } catch {
      setCopyResult({ content, message: 'markdown.copyFailed' });
    }
  }
  return (
    <section className="markdown-block" aria-label={label ?? t('markdown.content')}>
      <div className="markdown-tools" role="group" aria-label={t('markdown.controls')}>
        <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
          {t('markdown.pretty')}
        </button>
        <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
          {t('markdown.raw')}
        </button>
        <button type="button" onClick={() => void copy()}>
          {t('markdown.copy')}
        </button>
        <span role="status">
          {copyResult.content === content && copyResult.message ? t(copyResult.message) : ''}
        </span>
      </div>
      {raw ? (
        <pre className="markdown-source">{content}</pre>
      ) : (
        <div className="markdown-rendered">
          <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
            {content}
          </Markdown>
        </div>
      )}
    </section>
  );
}

import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState } from 'react';

const components: Components = {
  table: ({ children }) => (
    <div className="markdown-table" role="region" aria-label="表格，可横向滚动" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children, title }) =>
    href ? (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export function MarkdownContent({
  content,
  label = 'Markdown 内容',
}: {
  content: string;
  label?: string;
}) {
  const [raw, setRaw] = useState(false);
  const [copyResult, setCopyResult] = useState({ content: '', message: '' });
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopyResult({ content, message: '已复制' });
    } catch {
      setCopyResult({ content, message: '复制失败，请重试' });
    }
  }
  return (
    <section className="markdown-block" aria-label={label}>
      <div className="markdown-tools" role="group" aria-label="内容显示与复制">
        <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
          美化
        </button>
        <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
          原始
        </button>
        <button type="button" onClick={() => void copy()}>
          复制
        </button>
        <span role="status">{copyResult.content === content ? copyResult.message : ''}</span>
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

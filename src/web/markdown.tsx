import React from 'react';

// Render the block Markdown used by managed Task Issues as React nodes. External
// Issue text is never interpreted as HTML, and checkboxes are display-only.
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const key = i;
    if (!line.trim() || /^<!-- phantom-task:[^\s]+ -->$/.test(line)) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      blocks.push(
        <pre key={key}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(React.createElement(`h${heading[1].length}`, { key }, heading[2]));
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const content = lines[i].replace(/^[-*]\s+/, '');
        const task = /^\[([ xX])\]\s+(.+)$/.exec(content);
        items.push(
          <li key={i} className={task ? 'markdown-task' : undefined}>
            {task ? (
              <label>
                <input type="checkbox" checked={task[1] !== ' '} disabled />
                {task[2]}
              </label>
            ) : (
              content
            )}
          </li>,
        );
        i++;
      }
      blocks.push(<ul key={key}>{items}</ul>);
      continue;
    }
    const paragraph = [line];
    for (i++; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[-*]\s|```)/.test(lines[i]); i++)
      paragraph.push(lines[i]);
    blocks.push(<p key={key}>{paragraph.join('\n')}</p>);
  }
  return <div className="markdown-body">{blocks}</div>;
}

// Observation only: Node owns discovery, scheduling, results, and process exit.
export default async function* timingReporter(events) {
  for await (const { type, data } of events) {
    if (type === 'test:summary') {
      yield JSON.stringify({
        type,
        scope: data.file === undefined ? 'run' : 'file',
        ...data,
      }) + '\n';
    } else if (type === 'test:pass' || type === 'test:fail') {
      yield JSON.stringify({
        type,
        scope: data.details.type === 'suite' ? 'suite' : 'case',
        file: data.file,
        line: data.line,
        column: data.column,
        name: data.name,
        nesting: data.nesting,
        duration_ms: data.details.duration_ms,
        skip: data.skip,
        todo: data.todo,
      }) + '\n';
    }
  }
}

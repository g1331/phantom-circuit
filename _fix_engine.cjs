const fs = require('fs');
const file = 'src/server/engine.ts';
const buf = fs.readFileSync(file, 'utf8');
const hasCRLF = buf.includes('\r\n');
const nl = hasCRLF ? '\r\n' : '\n';
const lines = buf.split(/\r?\n/);
// 1-based 393 -> 0-based 392 (technical signature)
const techIdx = 392;
const sig = lines[techIdx];
if (!sig.includes('private async technical(task: Task, question: string, trigger')) {
  console.error('UNEXPECTED line 393: ' + JSON.stringify(sig));
  process.exit(1);
}
if (!lines[393].includes('private pmContext(projectId: string)')) {
  console.error('UNEXPECTED line 394: ' + JSON.stringify(lines[393]));
  process.exit(1);
}
if (!lines[403].trim().startsWith('}')) {
  console.error('UNEXPECTED line 404: ' + JSON.stringify(lines[403]));
  process.exit(1);
}
const out = lines.slice(0, techIdx)
  .concat(lines.slice(techIdx + 1, 404))
  .concat([sig])
  .concat(lines.slice(404));
fs.writeFileSync(file, out.join(nl), 'utf8');
console.log('ok, CRLF=' + hasCRLF + ', lines ' + lines.length + ' -> ' + out.length);

type PendingText = {
  remaining: string;
  safe: string;
  publish: (text: string) => void;
};

// Match the text consumers concatenate, retaining attribution for delayed fragments.
// Completed messages stay whole; delta fragments can publish their safe prefix immediately.
export class SecretTextStream {
  private pending: PendingText[] = [];
  constructor(
    private secret: string,
    private wholeMessages = false,
  ) {}

  push(text: string, publish: (text: string) => void) {
    this.pending.push({ remaining: text, safe: '', publish });
    let remaining = this.pending.map((p) => p.remaining).join('');
    let match: number;
    while ((match = remaining.indexOf(this.secret)) !== -1) {
      this.consume(match);
      this.consume(this.secret.length, '<REDACTED>');
      remaining = remaining.slice(match + this.secret.length);
    }
    let held = Math.min(this.secret.length - 1, remaining.length);
    while (held > 0 && !remaining.endsWith(this.secret.slice(0, held))) held--;
    this.consume(remaining.length - held);
    this.publishReady();
  }

  private consume(length: number, replacement?: string) {
    for (const part of this.pending) {
      if (!length) break;
      const count = Math.min(part.remaining.length, length);
      if (!count) continue;
      part.safe += replacement === undefined ? part.remaining.slice(0, count) : replacement;
      if (replacement !== undefined) replacement = '';
      part.remaining = part.remaining.slice(count);
      length -= count;
    }
  }

  private publishReady() {
    while (this.pending.length) {
      const part = this.pending[0];
      if (part.remaining) {
        if (!this.wholeMessages && part.safe) {
          const safe = part.safe;
          part.safe = '';
          part.publish(safe);
        }
        break;
      }
      this.pending.shift();
      if (part.safe || this.wholeMessages) part.publish(part.safe);
    }
  }

  finish() {
    // A terminal boundary cannot prove a candidate harmless to a later concatenating consumer.
    this.consume(
      this.pending.reduce((length, p) => length + p.remaining.length, 0),
      '<REDACTED>',
    );
    this.publishReady();
  }

  dispose() {
    this.pending = [];
    this.secret = '';
  }
}

/** Captures a child's stdout and stderr, each capped independently at `maxBufferBytes`. */
export class BoundedOutput {
  private readonly chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
  private readonly bytes: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };

  constructor(private readonly maxBufferBytes: number) {}

  /** Returns `false` when this chunk pushes its stream past the cap; the chunk is then dropped. */
  capture(stream: 'stdout' | 'stderr', chunk: Buffer): boolean {
    this.bytes[stream] += chunk.length;
    if (this.bytes[stream] > this.maxBufferBytes) {
      return false;
    }
    this.chunks[stream].push(chunk);
    return true;
  }

  text(stream: 'stdout' | 'stderr'): string {
    return Buffer.concat(this.chunks[stream]).toString('utf8');
  }
}
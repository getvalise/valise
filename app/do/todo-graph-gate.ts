/** FIFO writer barrier; concurrent readers preserve independent ticket progress. */
export class TodoGraphGate {
  private readers = 0;
  private writer = false;
  private readonly waiting: { write: boolean; enter: () => void }[] = [];

  async run<T>(write: boolean, operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((enter) => {
      this.waiting.push({ write, enter });
      this.drain();
    });
    try {
      return await operation();
    } finally {
      if (write) this.writer = false;
      else this.readers--;
      this.drain();
    }
  }

  private drain(): void {
    if (this.writer) return;
    while (this.waiting.length) {
      const next = this.waiting[0];
      if (next.write && this.readers) return;
      this.waiting.shift();
      if (next.write) this.writer = true;
      else this.readers++;
      next.enter();
      if (next.write) return;
    }
  }
}

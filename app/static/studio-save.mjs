export class SingleFlight {
  constructor() {
    this.pending = null;
  }

  run(task) {
    if (this.pending) return this.pending;
    let settled;
    settled = Promise.resolve().then(task).then(
      value => {
        if (this.pending === settled) this.pending = null;
        return value;
      },
      error => {
        if (this.pending === settled) this.pending = null;
        throw error;
      },
    );
    this.pending = settled;
    return settled;
  }
}

export class SaveQueue {
  constructor(operation, isCurrent, maxAttempts = 5) {
    this.operation = operation;
    this.isCurrent = isCurrent;
    this.maxAttempts = maxAttempts;
    this.flight = new SingleFlight();
  }

  async run(options) {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const saved = await this.flight.run(() => this.operation(options));
      if (!saved || this.isCurrent()) return saved;
    }
    return false;
  }
}

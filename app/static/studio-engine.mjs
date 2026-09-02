export function engineEvaluationText(evaluation = {}) {
  const value = Number(evaluation.value || 0);
  if (evaluation.type === "mate") return value > 0 ? `M${value}` : value < 0 ? `−M${Math.abs(value)}` : "Mate";
  const pawns = value / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

export function whiteEvaluationPercent(evaluation = {}) {
  const value = Number(evaluation.value || 0);
  if (evaluation.type === "mate") return value > 0 ? 100 : value < 0 ? 0 : 50;
  const pawns = Math.max(-30, Math.min(30, value / 100));
  return 50 + 50 * Math.tanh(pawns / 6);
}

export class EngineAnalysisController {
  constructor({ analyze, onResult, onError, delay = 250 }) {
    this.analyze = analyze;
    this.onResult = onResult;
    this.onError = onError;
    this.delay = delay;
    this.timer = null;
    this.abortController = null;
    this.token = 0;
  }

  schedule(moves) {
    this.cancel();
    const token = this.token;
    const input = [...moves];
    this.timer = setTimeout(async () => {
      this.timer = null;
      const controller = new AbortController();
      this.abortController = controller;
      try {
        const result = await this.analyze(input, { signal: controller.signal });
        if (token === this.token) this.onResult(result);
      } catch (error) {
        if (error?.name !== "AbortError" && token === this.token) this.onError(error);
      } finally {
        if (token === this.token) this.abortController = null;
      }
    }, this.delay);
  }

  cancel() {
    this.token += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.abortController?.abort();
    this.abortController = null;
  }
}

export interface ChargeOutcome {
  at: string;
  subscriptionId: number;
  status: "success" | "failure";
  error?: string;
}

export interface ExecutorHealthReport {
  status: "ok" | "unhealthy" | "disabled";
  enabled: boolean;
  running: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastRunError: string | null;
  expectedIntervalMs: number;
  msSinceLastRun: number | null;
  recentCharges: {
    successCount: number;
    failureCount: number;
    lastOutcomeAt: string | null;
    outcomes: ChargeOutcome[];
  };
}

const RECENT_OUTCOMES_MAX = 20;
const DEFAULT_EXPECTED_INTERVAL_MS = 5 * 60_000;

/**
 * Tracks the subscription executor's run/charge health in-process so
 * `GET /health` (and `GET /health/executor`) can report whether the executor
 * is actually charging subscriptions instead of silently stalling. The
 * executor writes here on every tick/charge; the health routes only read.
 */
class ExecutorHealthTracker {
  private enabled = false;
  private running = false;
  private startedAt: number | null = null;
  private lastRunAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastRunError: string | null = null;
  private expectedIntervalMs = DEFAULT_EXPECTED_INTERVAL_MS;
  private recentOutcomes: ChargeOutcome[] = [];

  markEnabled(expectedIntervalMs?: number): void {
    this.enabled = true;
    this.startedAt = Date.now();
    this.expectedIntervalMs =
      expectedIntervalMs && expectedIntervalMs > 0
        ? expectedIntervalMs
        : DEFAULT_EXPECTED_INTERVAL_MS;
  }

  markDisabled(): void {
    this.enabled = false;
    this.startedAt = null;
  }

  runStarted(): void {
    this.running = true;
  }

  runFinished(ok: boolean, error?: string, at = Date.now()): void {
    this.running = false;
    this.lastRunAt = at;
    if (ok) {
      this.lastSuccessAt = at;
      this.lastRunError = null;
    } else {
      this.lastRunError = error || "run failed";
    }
  }

  reset(): void {
    this.enabled = false;
    this.running = false;
    this.startedAt = null;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastRunError = null;
    this.expectedIntervalMs = DEFAULT_EXPECTED_INTERVAL_MS;
    this.recentOutcomes = [];
  }

  recordCharge(subscriptionId: number, status: ChargeOutcome["status"], error?: string): void {
    const outcome: ChargeOutcome = {
      at: new Date().toISOString(),
      subscriptionId,
      status,
      ...(status === "failure" && error ? { error } : {}),
    };
    this.recentOutcomes = [...this.recentOutcomes, outcome].slice(-RECENT_OUTCOMES_MAX);
  }

  getHealth(now = Date.now()): ExecutorHealthReport {
    const reference = this.lastRunAt ?? this.startedAt;
    const msSinceLastRun = reference != null ? now - reference : null;

    let status: ExecutorHealthReport["status"];
    if (!this.enabled) {
      status = "disabled";
    } else if (msSinceLastRun == null || msSinceLastRun > this.expectedIntervalMs) {
      status = "unhealthy";
    } else {
      status = "ok";
    }

    const outcomes = [...this.recentOutcomes];
    return {
      status,
      enabled: this.enabled,
      running: this.running,
      startedAt: this.startedAt != null ? new Date(this.startedAt).toISOString() : null,
      lastRunAt: this.lastRunAt != null ? new Date(this.lastRunAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt != null ? new Date(this.lastSuccessAt).toISOString() : null,
      lastRunError: this.lastRunError,
      expectedIntervalMs: this.expectedIntervalMs,
      msSinceLastRun,
      recentCharges: {
        successCount: outcomes.filter((o) => o.status === "success").length,
        failureCount: outcomes.filter((o) => o.status === "failure").length,
        lastOutcomeAt: outcomes.length > 0 ? outcomes[outcomes.length - 1].at : null,
        outcomes,
      },
    };
  }
}

export const executorHealth = new ExecutorHealthTracker();

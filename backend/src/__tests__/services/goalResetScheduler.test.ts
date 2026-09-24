jest.mock("../../services/goalService", () => ({
  resetDueGoals: jest.fn(),
}));

import { resetDueGoals } from "../../services/goalService";
import { GoalResetScheduler } from "../../services/goalResetScheduler";

const mockedResetDueGoals = resetDueGoals as jest.Mock;

describe("GoalResetScheduler", () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("calls resetDueGoals on tick()", async () => {
    mockedResetDueGoals.mockResolvedValue(0);
    const scheduler = new GoalResetScheduler();

    await scheduler.tick();

    expect(mockedResetDueGoals).toHaveBeenCalledTimes(1);
  });

  it("does not run a second tick concurrently while one is already in flight", async () => {
    let resolveFirst: () => void;
    mockedResetDueGoals.mockImplementationOnce(
      () => new Promise<number>((resolve) => { resolveFirst = () => resolve(0); })
    );
    const scheduler = new GoalResetScheduler();

    const first = scheduler.tick();
    const second = scheduler.tick(); // should be a no-op — first tick still running

    resolveFirst!();
    await Promise.all([first, second]);

    expect(mockedResetDueGoals).toHaveBeenCalledTimes(1);
  });

  it("logs and swallows an error instead of throwing, so the process keeps running", async () => {
    mockedResetDueGoals.mockRejectedValue(new Error("db unavailable"));
    const scheduler = new GoalResetScheduler();

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "GoalResetScheduler: tick failed:",
      "db unavailable"
    );
  });

  it("allows a subsequent tick after a prior one completes", async () => {
    mockedResetDueGoals.mockResolvedValue(0);
    const scheduler = new GoalResetScheduler();

    await scheduler.tick();
    await scheduler.tick();

    expect(mockedResetDueGoals).toHaveBeenCalledTimes(2);
  });

  it("start() schedules recurring ticks and stop() cancels them", async () => {
    jest.useFakeTimers();
    mockedResetDueGoals.mockResolvedValue(0);
    const scheduler = new GoalResetScheduler();

    scheduler.start();
    expect(mockedResetDueGoals).toHaveBeenCalledTimes(1); // immediate tick on start()

    // advanceTimersByTimeAsync (not the sync advanceTimersByTime) so the
    // still-in-flight immediate tick's promise actually settles and clears
    // `running` before the next interval fires — otherwise the scheduled
    // tick is (correctly) skipped by the overlap guard, and this assertion
    // flakes against an unrelated behavior instead of testing scheduling.
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockedResetDueGoals).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockedResetDueGoals).toHaveBeenCalledTimes(2); // no further ticks after stop()

    jest.useRealTimers();
  });

  it("start() is idempotent — calling it twice does not double the interval", async () => {
    jest.useFakeTimers();
    mockedResetDueGoals.mockResolvedValue(0);
    const scheduler = new GoalResetScheduler();

    scheduler.start();
    scheduler.start();
    mockedResetDueGoals.mockClear();

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockedResetDueGoals).toHaveBeenCalledTimes(1);

    scheduler.stop();
    jest.useRealTimers();
  });
});

import { RateLimiter } from "../../services/rateLimiter";

describe("RateLimiter", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("allows requests up to the configured maximum", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(true);
  });

  it("rejects a request once the maximum is exceeded within the window", () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(false);
  });

  it("tracks each key independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("b@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(false);
    expect(limiter.attempt("b@example.com")).toBe(false);
  });

  it("allows a request again once the window has elapsed", () => {
    jest.useFakeTimers();
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(false);

    jest.advanceTimersByTime(60_001);

    expect(limiter.attempt("a@example.com")).toBe(true);
  });

  it("clear resets every key", () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.attempt("a@example.com");
    limiter.clear();
    expect(limiter.attempt("a@example.com")).toBe(true);
  });
});

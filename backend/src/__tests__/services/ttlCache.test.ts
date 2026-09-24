import { TtlCache } from "../../services/ttlCache";

describe("TtlCache", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns undefined for a key that was never set", () => {
    const cache = new TtlCache<number>(1000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a value that was set, before it expires", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 42);
    expect(cache.get("a")).toBe(42);
  });

  it("expires a value after its TTL elapses", () => {
    jest.useFakeTimers();
    const cache = new TtlCache<number>(1000);
    cache.set("a", 42);

    jest.advanceTimersByTime(1001);

    expect(cache.get("a")).toBeUndefined();
  });

  it("does not expire a value exactly at the TTL boundary minus a moment", () => {
    jest.useFakeTimers();
    const cache = new TtlCache<number>(1000);
    cache.set("a", 42);

    jest.advanceTimersByTime(999);

    expect(cache.get("a")).toBe(42);
  });

  it("getOrSet computes and caches on a miss", async () => {
    const cache = new TtlCache<number>(1000);
    const compute = jest.fn().mockResolvedValue(7);

    const result = await cache.getOrSet("a", compute);

    expect(result).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("getOrSet returns the cached value without recomputing on a hit", async () => {
    const cache = new TtlCache<number>(1000);
    const compute = jest.fn().mockResolvedValue(7);

    await cache.getOrSet("a", compute);
    const second = await cache.getOrSet("a", compute);

    expect(second).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("getOrSet recomputes after the cached value expires", async () => {
    jest.useFakeTimers();
    const cache = new TtlCache<number>(1000);
    const compute = jest.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(8);

    await cache.getOrSet("a", compute);
    jest.advanceTimersByTime(1001);
    const second = await cache.getOrSet("a", compute);

    expect(second).toBe(8);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keys are independent of each other", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("clear removes every cached entry", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 1);
    cache.set("b", 2);

    cache.clear();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});

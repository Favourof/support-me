import { rpc } from "@stellar/stellar-sdk";
import {
  callSorobanRpc,
  getSorobanRpcUrls,
  resetSorobanRpcFailoverState,
  withSorobanRpcFailover,
  withSorobanRpcServer,
} from "../../services/sorobanRpc";

describe("Soroban RPC failover", () => {
  const originalUrls = process.env.SOROBAN_RPC_URLS;
  const originalEndpoints = process.env.SOROBAN_RPC_ENDPOINTS;
  const originalUrl = process.env.SOROBAN_RPC_URL;
  const originalTimeout = process.env.SOROBAN_RPC_TIMEOUT_MS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetSorobanRpcFailoverState();
    delete process.env.SOROBAN_RPC_URLS;
    delete process.env.SOROBAN_RPC_ENDPOINTS;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.SOROBAN_RPC_TIMEOUT_MS;
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalUrls === undefined) delete process.env.SOROBAN_RPC_URLS;
    else process.env.SOROBAN_RPC_URLS = originalUrls;
    if (originalEndpoints === undefined) delete process.env.SOROBAN_RPC_ENDPOINTS;
    else process.env.SOROBAN_RPC_ENDPOINTS = originalEndpoints;
    if (originalUrl === undefined) delete process.env.SOROBAN_RPC_URL;
    else process.env.SOROBAN_RPC_URL = originalUrl;
    if (originalTimeout === undefined) delete process.env.SOROBAN_RPC_TIMEOUT_MS;
    else process.env.SOROBAN_RPC_TIMEOUT_MS = originalTimeout;
    jest.restoreAllMocks();
  });

  it("parses, trims, and de-duplicates plural endpoints", () => {
    process.env.SOROBAN_RPC_URLS =
      " https://primary.example/rpc, https://secondary.example/rpc,https://primary.example/rpc ";

    expect(getSorobanRpcUrls()).toEqual([
      "https://primary.example/rpc",
      "https://secondary.example/rpc",
    ]);
  });

  it("keeps the legacy singular endpoint setting working", () => {
    process.env.SOROBAN_RPC_URL = "https://legacy.example/rpc";

    expect(getSorobanRpcUrls()).toEqual(["https://legacy.example/rpc"]);
  });

  it("retries a failing primary and uses the next endpoint", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { sequence: 42 } }),
      }) as unknown as typeof fetch;

    await expect(callSorobanRpc<{ sequence: number }>("getLatestLedger", {})).resolves.toEqual({
      sequence: 42,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe("https://primary.example/rpc");
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe("https://secondary.example/rpc");
  });

  it("keeps using the fallback after it has served a request", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ result: { sequence: 42 } }),
      }) as unknown as typeof fetch;

    await callSorobanRpc("getLatestLedger", {});
    await callSorobanRpc("getLatestLedger", {});

    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe("https://secondary.example/rpc");
  });

  it("applies the same failover policy to Stellar SDK server operations", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    const getHealth = jest
      .spyOn(rpc.Server.prototype, "getHealth")
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValueOnce({ status: "healthy" } as never);

    await expect(
      withSorobanRpcServer("sdkOperation", (server) => server.getHealth())
    ).resolves.toEqual({ status: "healthy" });
    expect(getHealth).toHaveBeenCalledTimes(2);
  });

  it("reports an aggregate error when every endpoint fails", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    const operation = jest.fn().mockRejectedValue(new Error("offline"));

    await expect(
      withSorobanRpcFailover("testOperation", operation, { timeoutMs: 20 })
    ).rejects.toThrow("failed on all configured endpoints");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("fails over when an endpoint operation times out", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    const operation = jest
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce("ok");

    await expect(
      withSorobanRpcFailover("testTimeout", operation, {
        timeoutMs: 5,
        totalTimeoutMs: 20,
      })
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

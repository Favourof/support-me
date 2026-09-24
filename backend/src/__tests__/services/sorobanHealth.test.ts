import { checkSorobanRpc } from "../../services/sorobanHealth";
import { resetSorobanRpcFailoverState } from "../../services/sorobanRpc";

describe("checkSorobanRpc", () => {
  const originalUrls = process.env.SOROBAN_RPC_URLS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetSorobanRpcFailoverState();
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalUrls === undefined) delete process.env.SOROBAN_RPC_URLS;
    else process.env.SOROBAN_RPC_URLS = originalUrls;
    jest.restoreAllMocks();
  });

  it("reports healthy when the primary fails and a fallback responds", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Unavailable" })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { sequence: 123 } }),
      }) as unknown as typeof fetch;

    await expect(checkSorobanRpc()).resolves.toMatchObject({ status: "ok" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("reports down only after every configured endpoint fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, statusText: "Unavailable" }) as unknown as typeof fetch;

    await expect(checkSorobanRpc()).resolves.toEqual({ status: "down" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

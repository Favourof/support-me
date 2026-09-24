jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../../services/sorobanHealth", () => ({
  checkSorobanRpc: jest.fn().mockResolvedValue({ status: "ok", latencyMs: 4 }),
}));

import request from "supertest";
import app from "../../app";

describe("GET /health", () => {
  it("returns 200 with an ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
    expect(res.body.dependencies.sorobanRpc.status).toBe("ok");
  });

  it("reports degraded status when Soroban RPC is unavailable", async () => {
    const { checkSorobanRpc } = await import("../../services/sorobanHealth");
    (checkSorobanRpc as jest.Mock).mockResolvedValueOnce({ status: "down" });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.dependencies.sorobanRpc.status).toBe("down");
  });
});

describe("unknown routes", () => {
  it("returns a structured 404", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual(
      expect.objectContaining({ error: "Not Found", code: "NOT_FOUND" })
    );
    expect(typeof res.body.requestId).toBe("string");
  });
});

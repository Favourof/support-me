import { recordAdminAction } from "../../services/adminAuditLog";

describe("recordAdminAction", () => {
  it("derives the actor from the authenticated request and records snapshots", async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const client = { adminAuditLog: { create } } as never;
    const req = {
      requestId: "request-123",
      user: { id: 42, walletAddress: "GADMIN" },
      body: { walletAddress: "GSPOOFED" },
    } as never;

    await recordAdminAction(client, req, {
      action: "creator.profile.update",
      targetType: "creator",
      targetId: "7",
      before: { walletAddress: "GOLD" },
      after: { walletAddress: "GNEW" },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        adminId: 42,
        adminWalletAddress: "GADMIN",
        action: "creator.profile.update",
        targetType: "creator",
        targetId: "7",
        requestId: "request-123",
        before: { walletAddress: "GOLD" },
        after: { walletAddress: "GNEW" },
      },
    });
  });

  it("redacts sensitive snapshot fields before persisting them", async () => {
    const create = jest.fn().mockResolvedValue({ id: 2 });
    const client = { adminAuditLog: { create } } as never;
    const req = { user: { id: 42, walletAddress: "GADMIN" } } as never;

    await recordAdminAction(client, req, {
      action: "test",
      targetType: "test",
      targetId: "1",
      after: { token: "do-not-store", nested: { secret: "also-hidden" } },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        after: { token: "[REDACTED]", nested: { secret: "[REDACTED]" } },
      }),
    });
  });

  it("refuses to write an audit row without an authenticated actor", async () => {
    const create = jest.fn();
    const client = { adminAuditLog: { create } } as never;

    await expect(
      recordAdminAction(client, {} as never, {
        action: "test",
        targetType: "test",
        targetId: "1",
      })
    ).rejects.toThrow("without an authenticated user");
    expect(create).not.toHaveBeenCalled();
  });
});

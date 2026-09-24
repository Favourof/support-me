jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), upsert: jest.fn() },
    creator: { findUnique: jest.fn() },
    magicLinkToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../services/email/mailer", () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

import { createHash } from "crypto";
import prisma from "../../prisma";
import { sendEmail } from "../../services/email/mailer";
import {
  magicLinkRateLimiter,
  requestMagicLink,
  verifyMagicLink,
} from "../../services/magicLink";

const mockedPrisma = prisma as unknown as {
  user: { findUnique: jest.Mock; upsert: jest.Mock };
  creator: { findUnique: jest.Mock };
  magicLinkToken: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  $transaction: jest.Mock;
};
const mockedSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;

beforeEach(() => {
  jest.clearAllMocks();
  magicLinkRateLimiter.clear();
  mockedPrisma.$transaction.mockImplementation((callback: (client: typeof mockedPrisma) => unknown) =>
    callback(mockedPrisma)
  );
});

describe("requestMagicLink (#15)", () => {
  it("emails a signed link for an email with no existing account", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.magicLinkToken.create.mockResolvedValue({});

    await requestMagicLink("New@Example.com");

    expect(mockedPrisma.magicLinkToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "new@example.com", userId: undefined }),
      })
    );
    expect(mockedSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "new@example.com", subject: expect.stringContaining("Sign in") })
    );
  });

  it("links the token to an existing account when the email already has one", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ id: 5, email: "existing@example.com" });
    mockedPrisma.magicLinkToken.create.mockResolvedValue({});

    await requestMagicLink("existing@example.com");

    expect(mockedPrisma.magicLinkToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 5 }) })
    );
  });

  it("stores only a hash of the token, never the raw token", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.magicLinkToken.create.mockResolvedValue({});

    await requestMagicLink("a@example.com");

    const storedData = mockedPrisma.magicLinkToken.create.mock.calls[0][0].data;
    expect(storedData.tokenHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex digest
    const emailedUrl = mockedSendEmail.mock.calls[0][0].text;
    expect(emailedUrl).not.toContain(storedData.tokenHash);
  });

  it("normalizes email casing/whitespace before storing and rate-limiting", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.magicLinkToken.create.mockResolvedValue({});

    await requestMagicLink("  Mixed@Case.COM  ");

    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "mixed@case.com" } });
  });

  it("rejects the 6th request for the same email within the rate-limit window", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.magicLinkToken.create.mockResolvedValue({});

    for (let i = 0; i < 5; i++) {
      await requestMagicLink("a@example.com");
    }

    await expect(requestMagicLink("a@example.com")).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("does not rate-limit different emails against each other", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.magicLinkToken.create.mockResolvedValue({});

    for (let i = 0; i < 5; i++) {
      await requestMagicLink("a@example.com");
    }

    await expect(requestMagicLink("b@example.com")).resolves.toBeUndefined();
  });
});

describe("verifyMagicLink (#15)", () => {
  const RAW_TOKEN = "test-token-value";
  const TOKEN_HASH = createHash("sha256").update(RAW_TOKEN).digest("hex");

  it("rejects an empty token", async () => {
    await expect(verifyMagicLink("")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a token that does not match any stored hash", async () => {
    mockedPrisma.magicLinkToken.findUnique.mockResolvedValue(null);

    await expect(verifyMagicLink("wrong-token")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an already-used token", async () => {
    mockedPrisma.magicLinkToken.findUnique.mockResolvedValue({
      tokenHash: TOKEN_HASH,
      email: "a@example.com",
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(verifyMagicLink(RAW_TOKEN)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an expired token", async () => {
    mockedPrisma.magicLinkToken.findUnique.mockResolvedValue({
      tokenHash: TOKEN_HASH,
      email: "a@example.com",
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(verifyMagicLink(RAW_TOKEN)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("creates a new account and issues a session for a first-time verification", async () => {
    const record = {
      tokenHash: TOKEN_HASH,
      email: "new@example.com",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    mockedPrisma.magicLinkToken.findUnique.mockResolvedValue(record);
    mockedPrisma.user.upsert.mockResolvedValue({
      id: 9,
      email: "new@example.com",
      walletAddress: null,
    });
    mockedPrisma.magicLinkToken.update.mockResolvedValue({});
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const session = await verifyMagicLink(RAW_TOKEN);

    expect(mockedPrisma.user.upsert).toHaveBeenCalledWith({
      where: { email: "new@example.com" },
      update: {},
      create: { email: "new@example.com" },
    });
    expect(session.user).toEqual({ id: 9, email: "new@example.com", walletAddress: null });
    expect(session.hasProfile).toBe(false);
    expect(typeof session.token).toBe("string");
  });

  it("attaches a returning account and reports its existing profile", async () => {
    const record = {
      tokenHash: TOKEN_HASH,
      email: "existing@example.com",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    mockedPrisma.magicLinkToken.findUnique.mockResolvedValue(record);
    mockedPrisma.user.upsert.mockResolvedValue({
      id: 3,
      email: "existing@example.com",
      walletAddress: "GABC",
    });
    mockedPrisma.magicLinkToken.update.mockResolvedValue({});
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 1, username: "bob" });

    const session = await verifyMagicLink(RAW_TOKEN);

    expect(session.hasProfile).toBe(true);
    expect(session.username).toBe("bob");
    expect(session.user.walletAddress).toBe("GABC");
  });

  it("marks the token used within the same transaction as the account upsert", async () => {
    const record = {
      tokenHash: TOKEN_HASH,
      email: "a@example.com",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    mockedPrisma.magicLinkToken.findUnique.mockResolvedValue(record);
    mockedPrisma.user.upsert.mockResolvedValue({ id: 1, email: "a@example.com", walletAddress: null });
    mockedPrisma.magicLinkToken.update.mockResolvedValue({});
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    await verifyMagicLink(RAW_TOKEN);

    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.magicLinkToken.update).toHaveBeenCalledWith({
      where: { tokenHash: TOKEN_HASH },
      data: { usedAt: expect.any(Date), userId: 1 },
    });
  });

  it("rejects a concurrent double-submit of the same token inside the transaction", async () => {
    const record = {
      tokenHash: TOKEN_HASH,
      email: "a@example.com",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    mockedPrisma.magicLinkToken.findUnique
      .mockResolvedValueOnce(record) // the initial pre-transaction check
      .mockResolvedValueOnce({ ...record, usedAt: new Date() }); // re-checked inside the transaction, already used by a racing request

    await expect(verifyMagicLink(RAW_TOKEN)).rejects.toMatchObject({ statusCode: 401 });
    expect(mockedPrisma.user.upsert).not.toHaveBeenCalled();
  });
});

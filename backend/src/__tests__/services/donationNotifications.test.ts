jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    creator: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));

jest.mock("../../services/email/mailer", () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

import { Donation } from "@prisma/client";
import prisma from "../../prisma";
import { sendEmail } from "../../services/email/mailer";
import { notifyDonationConfirmation, notifyDonationReceived } from "../../services/donationNotifications";

const mockedPrisma = prisma as unknown as {
  creator: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
};
const mockedSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;

const DONATION: Donation = {
  id: 1,
  creatorId: 7,
  senderAddress: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
  amount: 25,
  currency: "XLM",
  message: "keep it up!",
  transactionHash: "abc123",
  verified: true,
  onChainEventId: null,
  rpcEventId: null,
  operationIndex: 0,
  eventIndex: 0,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedSendEmail.mockResolvedValue(undefined);
});

describe("notifyDonationReceived (#17)", () => {
  it("emails the creator with the donation amount, sender, and message", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({
      id: 7,
      displayName: "Bob",
      user: { email: "bob@example.com" },
    });

    const sent = await notifyDonationReceived(DONATION);

    expect(sent).toBe(true);
    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
    const message = mockedSendEmail.mock.calls[0][0];
    expect(message.to).toBe("bob@example.com");
    expect(message.text).toContain("25");
    expect(message.text).toContain("XLM");
    expect(message.text).toContain("keep it up!");
  });

  it("never includes the full sender wallet address, only a truncated form", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({
      id: 7,
      user: { email: "bob@example.com" },
    });

    await notifyDonationReceived(DONATION);

    const message = mockedSendEmail.mock.calls[0][0];
    expect(message.text).not.toContain(DONATION.senderAddress);
    expect(message.html).not.toContain(DONATION.senderAddress);
  });

  it("returns false and sends nothing when the creator has no email on file", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, user: { email: null } });

    const sent = await notifyDonationReceived(DONATION);

    expect(sent).toBe(false);
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("returns false when the creator record itself cannot be found", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const sent = await notifyDonationReceived(DONATION);

    expect(sent).toBe(false);
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("propagates a send failure to the caller rather than swallowing it silently", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, user: { email: "bob@example.com" } });
    mockedSendEmail.mockRejectedValue(new Error("provider down"));

    await expect(notifyDonationReceived(DONATION)).rejects.toThrow("provider down");
  });
});

describe("notifyDonationConfirmation (#17)", () => {
  it("emails the supporter when their wallet matches a known account with an email", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 3,
      walletAddress: DONATION.senderAddress,
      email: "supporter@example.com",
    });
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, displayName: "Bob" });

    const sent = await notifyDonationConfirmation(DONATION);

    expect(sent).toBe(true);
    expect(mockedSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "supporter@example.com" })
    );
  });

  it("falls back to the creator's username when displayName is unset", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ email: "supporter@example.com" });
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob", displayName: null });

    await notifyDonationConfirmation(DONATION);

    const message = mockedSendEmail.mock.calls[0][0];
    expect(message.text).toContain("bob");
  });

  it("returns false when the supporter's wallet address is not a known account (the common case)", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    const sent = await notifyDonationConfirmation(DONATION);

    expect(sent).toBe(false);
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it("returns false when the known account has no email on file", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({ email: null });

    const sent = await notifyDonationConfirmation(DONATION);

    expect(sent).toBe(false);
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });
});

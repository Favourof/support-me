import { notifyDonationReceived } from "../../services/donationNotifications";
import prisma from "../../prisma";
import { emailService } from "../../services/email/emailService";

jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    creator: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

describe("notifyDonationReceived", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sends receipt email when creator has an email address", async () => {
    const mockSendReceipt = jest
      .spyOn(emailService, "sendDonationReceipt")
      .mockResolvedValueOnce({
        subject: "Test Subject",
        html: "<p>Test</p>",
        text: "Test",
      });

    (prisma.creator.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 1,
      username: "alice",
      displayName: "Alice Dev",
      user: {
        email: "alice@example.com",
      },
    });

    (prisma.creator.findFirst as jest.Mock).mockResolvedValueOnce({
      username: "bob",
      displayName: "Bob Supporter",
      walletAddress: "GBOB123",
    });

    const fakeDonation = {
      id: 42,
      creatorId: 1,
      senderAddress: "GBOB123",
      amount: 50,
      currency: "XLM",
      message: "Great work!",
      transactionHash: "tx_hash_123",
      createdAt: new Date("2026-04-01T12:00:00Z"),
    } as any;

    const result = await notifyDonationReceived(fakeDonation);

    expect(result).toBe(true);
    expect(mockSendReceipt).toHaveBeenCalledWith(
      "alice@example.com",
      expect.objectContaining({
        creatorName: "Alice Dev",
        donorName: "Bob Supporter",
        amount: 50,
        currency: "XLM",
        message: "Great work!",
        transactionHash: "tx_hash_123",
      })
    );
  });

  it("handles anonymous donor and no message gracefully", async () => {
    const mockSendReceipt = jest
      .spyOn(emailService, "sendDonationReceipt")
      .mockResolvedValueOnce({
        subject: "Anonymous Subject",
        html: "<p>Test</p>",
        text: "Test",
      });

    (prisma.creator.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 2,
      username: "coder",
      displayName: null,
      user: {
        email: "coder@example.com",
      },
    });

    const fakeDonation = {
      id: 43,
      creatorId: 2,
      senderAddress: "anonymous",
      amount: 10,
      currency: "USDC",
      message: null,
      transactionHash: null,
      createdAt: new Date("2026-04-01T12:00:00Z"),
    } as any;

    const result = await notifyDonationReceived(fakeDonation);

    expect(result).toBe(true);
    expect(mockSendReceipt).toHaveBeenCalledWith(
      "coder@example.com",
      expect.objectContaining({
        creatorName: "coder",
        donorName: null,
        donorAddress: "anonymous",
        amount: 10,
        currency: "USDC",
        message: null,
        transactionHash: null,
      })
    );
  });

  it("skips silently when creator has no email configured", async () => {
    const mockSendReceipt = jest.spyOn(emailService, "sendDonationReceipt");

    (prisma.creator.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 3,
      username: "wallet_only",
      user: {
        email: null,
      },
    });

    const fakeDonation = {
      id: 44,
      creatorId: 3,
      senderAddress: "GXYZ",
      amount: 5,
      currency: "XLM",
      message: null,
      transactionHash: null,
      createdAt: new Date(),
    } as any;

    const result = await notifyDonationReceived(fakeDonation);

    expect(result).toBe(false);
    expect(mockSendReceipt).not.toHaveBeenCalled();
  });
});

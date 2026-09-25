jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    subscription: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    donation: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../services/subscriptionNotifications", () => ({
  notifySubscriptionPaymentFailed: jest.fn(),
  notifySubscriptionRenewed: jest.fn(),
}));

import prisma from "../../prisma";
import { SubscriptionExecutor } from "../../services/subscriptionExecutor";
import { notifySubscriptionRenewed } from "../../services/subscriptionNotifications";

const mockedPrisma = prisma as unknown as {
  subscription: { findMany: jest.Mock; update: jest.Mock };
  donation: { upsert: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRenewed = notifySubscriptionRenewed as jest.Mock;

const subscription = {
  id: 4,
  creatorId: 7,
  supporterAddress: "G supporter",
  token: "XLM",
  amount: 2.5,
  intervalSecs: 60,
  onChainId: 11,
  active: true,
  nextChargeAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastChargeTxHash: null,
  lastChargedAt: null,
  lastError: null,
  failureNotifiedAt: null,
  subscribeTxHash: null,
} as never;

describe("SubscriptionExecutor donation indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.donation.upsert.mockResolvedValue({ id: 1 });
    mockedPrisma.subscription.update.mockResolvedValue(subscription);
    mockedPrisma.$transaction.mockResolvedValue(undefined);
    mockedRenewed.mockResolvedValue(undefined);
  });

  it("upserts a confirmed recurring charge by its on-chain identity", async () => {
    const executor = new SubscriptionExecutor() as any;
    executor.submitCharge = jest.fn().mockResolvedValue("charge-tx");

    await executor.charge(subscription);

    expect(mockedPrisma.donation.upsert).toHaveBeenCalledWith({
      where: {
        transactionHash_operationIndex_eventIndex: {
          transactionHash: "charge-tx",
          operationIndex: 0,
          eventIndex: 0,
        },
      },
      update: {},
      create: expect.objectContaining({
        transactionHash: "charge-tx",
        onChainEventId: "charge-tx:0:0",
        operationIndex: 0,
        eventIndex: 0,
      }),
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    creator: {
      findMany: jest.fn(),
    },
    donation: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

jest.mock("../../services/sorobanRpc", () => ({
  callSorobanRpc: jest.fn(),
  getSorobanRpcUrls: jest.fn(() => ["https://rpc.example"]),
}));

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import prisma from "../../prisma";
import { SorobanEventListener } from "../../services/sorobanEventListener";
import { DONATION_EVENT, eventBus } from "../../services/eventBus";
import { callSorobanRpc } from "../../services/sorobanRpc";

const mockedPrisma = prisma as unknown as {
  creator: { findMany: jest.Mock };
  donation: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    upsert: jest.Mock;
  };
};
const mockedRpc = callSorobanRpc as jest.Mock;

const encode = (value: unknown, type: "symbol" | "address" | "i128" | "string") =>
  xdr.ScVal.toXDR(nativeToScVal(value, { type })).toString("base64");

const makeEvent = (id: string, eventIndex = 0) => ({
  type: "contract",
  ledger: 100,
  id,
  txHash: "tx-replayed",
  operationIndex: 0,
  eventIndex,
  topic: [
    encode("donated", "symbol"),
    encode("GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW", "address"),
    encode("GBLOPB74SBZC2O24XTYSW4UOJ5LPQXUENXQK53RJUO5GYZIKTQ7OB365", "address"),
  ],
  value: xdr.ScVal.toXDR(
    nativeToScVal(
      { amount: 10_000_000n, memo: "hello", timestamp: 1_700_000_000n },
      { type: "map" }
    )
  ).toString("base64"),
});

describe("SorobanEventListener replay protection", () => {
  const originalContractId = process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID = "CDONATIONCONTRACT";
    mockedPrisma.creator.findMany.mockResolvedValue([{ id: 7 }]);
    mockedPrisma.donation.findFirst.mockResolvedValue(null);
    mockedPrisma.donation.findUnique.mockResolvedValue(null);
    mockedPrisma.donation.update.mockResolvedValue({ id: 1 });
    mockedRpc.mockImplementation(async (method: string) => {
      if (method === "getLatestLedger") return { sequence: 101 };
      if (method === "getEvents") return { events: [makeEvent("event-1")], cursor: "cursor-1" };
      throw new Error(`unexpected method ${method}`);
    });
  });

  afterAll(() => {
    if (originalContractId === undefined) delete process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID;
    else process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID = originalContractId;
  });

  it("upserts the same on-chain identity after a restart instead of duplicating", async () => {
    const stored = new Map<string, unknown>();
    mockedPrisma.donation.findUnique.mockImplementation(async ({ where }) =>
      stored.has(where.rpcEventId as string) ? { id: 1 } : null
    );
    mockedPrisma.donation.upsert.mockImplementation(async ({ where, create }) => {
      const key = where.rpcEventId as string;
      if (!stored.has(key)) stored.set(key, create);
      return stored.get(key);
    });

    const emitted = jest.fn();
    eventBus.on(DONATION_EVENT, emitted);
    try {
      await new SorobanEventListener().poll();
      await new SorobanEventListener().poll();
    } finally {
      eventBus.off(DONATION_EVENT, emitted);
    }

    expect(stored.size).toBe(1);
    expect(mockedPrisma.donation.upsert).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.donation.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { rpcEventId: "event-1" },
        create: expect.objectContaining({
          rpcEventId: "event-1",
          onChainEventId: "tx-replayed:0:0",
        }),
      })
    );
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct events from the same transaction separate", async () => {
    mockedRpc.mockImplementation(async (method: string) => {
      if (method === "getLatestLedger") return { sequence: 101 };
      if (method === "getEvents") {
        return { events: [makeEvent("event-0", 0), makeEvent("event-1", 1)] };
      }
      throw new Error(`unexpected method ${method}`);
    });
    mockedPrisma.donation.upsert.mockResolvedValue({ id: 1 });

    await new SorobanEventListener().poll();

    expect(mockedPrisma.donation.upsert).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.donation.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { rpcEventId: "event-0" } })
    );
    expect(mockedPrisma.donation.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { rpcEventId: "event-1" } })
    );
  });

  it("uses the response cursor for the next page", async () => {
    mockedPrisma.donation.upsert.mockResolvedValue({ id: 1 });
    const listener = new SorobanEventListener();

    await listener.poll();
    await listener.poll();

    expect(mockedRpc).toHaveBeenNthCalledWith(
      3,
      "getEvents",
      expect.objectContaining({ pagination: { limit: 50, cursor: "cursor-1" } })
    );
  });
});

jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    creator: {
      findUnique: jest.fn(),
    },
    donation: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    donationIdempotencyKey: {
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";

const mockedPrisma = prisma as unknown as {
  creator: { findUnique: jest.Mock };
  donation: { findMany: jest.Mock; count: jest.Mock; create: jest.Mock; upsert: jest.Mock };
  donationIdempotencyKey: {
    deleteMany: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
    create: jest.Mock;
  };
  $transaction: jest.Mock;
};

beforeEach(() => {
  mockedPrisma.$transaction.mockImplementation((callback: (client: typeof mockedPrisma) => unknown) =>
    callback(mockedPrisma)
  );
  mockedPrisma.donation.count.mockResolvedValue(0);
  mockedPrisma.donationIdempotencyKey.findUnique.mockResolvedValue(null);
});

describe("GET /api/donations", () => {
  it("returns all donations ordered by creation date", async () => {
    const donations = [{ id: 1, creatorId: 1, senderAddress: "GABC", amount: 5 }];
    mockedPrisma.donation.findMany.mockResolvedValue(donations);

    const res = await request(app).get("/api/donations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: donations, pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    expect(mockedPrisma.donation.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      where: { verified: true },
      skip: 0,
      take: 20,
    });
  });

  it("exposes the durable on-chain identity as eventId", async () => {
    mockedPrisma.donation.findMany.mockResolvedValue([
      { id: 1, transactionHash: "tx-1", onChainEventId: "tx-1:0:0" },
    ]);

    const res = await request(app).get("/api/donations");

    expect(res.body.items[0].eventId).toBe("tx-1:0:0");
  });

  it("filters by creatorUsername when provided as a query param", async () => {
    mockedPrisma.donation.findMany.mockResolvedValue([]);

    await request(app).get("/api/donations").query({ creatorUsername: "bob" });

    expect(mockedPrisma.donation.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      where: { creator: { username: "bob" }, verified: true },
      skip: 0,
      take: 20,
    });
  });
});

describe("POST /api/donations", () => {
  it("rejects a request without an idempotency key", async () => {
    const res = await request(app).post("/api/donations").send({
      creatorUsername: "bob",
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("rejects a request missing required fields with a validation error", async () => {
    const res = await request(app).post("/api/donations").send({ amount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the target creator does not exist", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const res = await request(app).post("/api/donations").set("Idempotency-Key", "missing-creator").send({
      creatorUsername: "unknown",
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("creates a donation for an existing creator", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    const created = {
      id: 1,
      creatorId: 7,
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      currency: "XLM",
    };
    mockedPrisma.donation.create.mockResolvedValue(created);

    const res = await request(app).post("/api/donations").set("Idempotency-Key", "donation-1").send({
      creatorUsername: "bob",
      senderAddress:
        "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      amount: 10,
      message: "nice work",
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(mockedPrisma.donation.create).toHaveBeenCalledWith({
      data: {
        creatorId: 7,
        senderAddress:
          "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
        amount: 10,
        currency: "XLM",
        message: "nice work",
        transactionHash: undefined,
        verified: true,
      },
    });
  });

  it("upserts a reported on-chain event by transaction and event index", async () => {
    const created = { id: 2, creatorId: 7, amount: 1.5, transactionHash: "tx-1" };
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    mockedPrisma.donation.upsert.mockResolvedValue(created);

    const res = await request(app)
      .post("/api/donations")
      .set("Idempotency-Key", "donation-2")
      .send({
        creatorUsername: "bob",
        senderAddress:
          "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
        amount: 1.5,
        transactionHash: "tx-1",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(mockedPrisma.donation.upsert).toHaveBeenCalledWith({
      where: {
        transactionHash_operationIndex_eventIndex: {
          transactionHash: "tx-1",
          operationIndex: 0,
          eventIndex: 0,
        },
      },
      update: {},
      create: expect.objectContaining({
        transactionHash: "tx-1",
        onChainEventId: "tx-1:0:0",
        operationIndex: 0,
        eventIndex: 0,
        verified: false,
      }),
    });
  });

  it("returns the original donation for a repeated idempotency key", async () => {
    const original = { id: 1, creatorId: 7, amount: 10 };
    mockedPrisma.donationIdempotencyKey.findUnique.mockResolvedValue({
      key: "donation-1",
      expiresAt: new Date(Date.now() + 60_000),
      donation: original,
    });

    const res = await request(app)
      .post("/api/donations")
      .set("Idempotency-Key", "donation-1")
      .send({
        creatorUsername: "bob",
        senderAddress:
          "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
        amount: 99,
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(original);
    expect(mockedPrisma.donation.create).not.toHaveBeenCalled();
  });
});

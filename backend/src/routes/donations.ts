import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../prisma";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import { createDonationSchema, listDonationsQuerySchema } from "../schemas/donations";
import { BadRequestError, NotFoundError } from "../errors/AppError";

const router = Router();

router.get(
  "/",
  validate({ query: listDonationsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { creatorUsername, page, limit } = req.query as unknown as {
      creatorUsername?: string;
      page: number;
      limit: number;
    };
    const where = {
      ...(creatorUsername ? { creator: { username: creatorUsername } } : {}),
      verified: true,
    };

    const [items, total] = await Promise.all([
      prisma.donation.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        where,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.donation.count({ where }),
    ]);

    const responseItems = items.map((item) => {
      const eventId =
        item.rpcEventId ||
        item.onChainEventId ||
        (item.transactionHash ? `${item.transactionHash}:0:0` : undefined);
      return eventId ? { ...item, eventId } : item;
    });

    return res.json({
      items: responseItems,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  })
);

router.post(
  "/",
  validate({ body: createDonationSchema }),
  asyncHandler(async (req, res) => {
    const idempotencyKey = req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) throw new BadRequestError("Idempotency-Key header is required");

    const {
      creatorUsername,
      senderAddress,
      amount,
      currency,
      message,
      transactionHash,
    } = req.body;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // A browser donation transaction currently contains one DonatedEvent, so
    // the client-facing report uses the canonical operation/event indices 0.
    // The Soroban listener owns the authoritative index and can reconcile the
    // row using its RPC-provided event identity.
    const operationIndex = 0;
    const eventIndex = 0;
    const onChainEventId = transactionHash
      ? `${transactionHash}:${operationIndex}:${eventIndex}`
      : undefined;
    const verified = !transactionHash;

    const record = async (client: Prisma.TransactionClient) => {
      await client.donationIdempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const existing = await client.donationIdempotencyKey.findUnique({
        where: { key: idempotencyKey },
        include: { donation: true },
      });
      if (existing && existing.expiresAt > new Date()) return existing.donation;
      if (existing) await client.donationIdempotencyKey.delete({ where: { key: idempotencyKey } });

      const creator = await client.creator.findUnique({ where: { username: creatorUsername } });
      if (!creator) throw new NotFoundError("Creator not found");

      const donation = onChainEventId
        ? await client.donation.upsert({
            where: {
              transactionHash_operationIndex_eventIndex: {
                transactionHash,
                operationIndex,
                eventIndex,
              },
            },
            update: {},
            create: {
              creatorId: creator.id,
              senderAddress,
              amount,
              currency,
              message,
              transactionHash,
              onChainEventId,
              operationIndex,
              eventIndex,
              verified: false,
            },
          })
        : await client.donation.create({
            data: {
              creatorId: creator.id,
              senderAddress,
              amount,
              currency,
              message,
              transactionHash,
              verified,
            },
          });
      await client.donationIdempotencyKey.create({
        data: { key: idempotencyKey, donationId: donation.id, expiresAt },
      });
      return donation;
    };

    let donation;
    try {
      donation = await prisma.$transaction(record);
    } catch (error) {
      // A concurrent retry can win the unique key constraint after both
      // transactions read the key as absent. Return that winner's donation.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.donationIdempotencyKey.findUnique({
          where: { key: idempotencyKey },
          include: { donation: true },
        });
        if (existing && existing.expiresAt > new Date()) donation = existing.donation;
        else if (onChainEventId) {
          // The event listener may have won the unique on-chain identity race
          // while this request was being processed. Its row is the canonical
          // result, so return it rather than surfacing a spurious 500.
          const onChainDonation = await prisma.donation.findUnique({
            where: {
              transactionHash_operationIndex_eventIndex: {
                transactionHash,
                operationIndex,
                eventIndex,
              },
            },
          });
          if (!onChainDonation) throw error;
          donation = onChainDonation;
        } else throw error;
      } else {
        throw error;
      }
    }
    return res.status(201).json(donation);
  })
);

export default router;

import { Router } from "express";
import { Donation, Prisma } from "@prisma/client";
import prisma from "../prisma";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import { createDonationSchema, listDonationsQuerySchema } from "../schemas/donations";
import { BadRequestError, NotFoundError } from "../errors/AppError";
import { notifyDonationConfirmation, notifyDonationReceived } from "../services/donationNotifications";

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
    const where = creatorUsername ? { creator: { username: creatorUsername } } : undefined;

    const [items, total] = await Promise.all([
      prisma.donation.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        where,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.donation.count({ where }),
    ]);

    return res.json({ items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  })
);

router.post(
  "/",
  validate({ body: createDonationSchema }),
  asyncHandler(async (req, res) => {
    const idempotencyKey = req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) throw new BadRequestError("Idempotency-Key header is required");

    const { creatorUsername, senderAddress, amount, currency, message, transactionHash } = req.body;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Tracks whether this request is the one that actually inserted the
    // donation row, as opposed to an idempotent replay returning the
    // original. Notifications must only fire once, on the real insert —
    // not on every retry a client makes with the same Idempotency-Key.
    let isNewDonation = false;

    const record = async (client: Prisma.TransactionClient): Promise<Donation> => {
      await client.donationIdempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const existing = await client.donationIdempotencyKey.findUnique({
        where: { key: idempotencyKey },
        include: { donation: true },
      });
      if (existing && existing.expiresAt > new Date()) return existing.donation;
      if (existing) await client.donationIdempotencyKey.delete({ where: { key: idempotencyKey } });

      const creator = await client.creator.findUnique({ where: { username: creatorUsername } });
      if (!creator) throw new NotFoundError("Creator not found");

      const donation = await client.donation.create({
        data: { creatorId: creator.id, senderAddress, amount, currency, message, transactionHash },
      });
      await client.donationIdempotencyKey.create({
        data: { key: idempotencyKey, donationId: donation.id, expiresAt },
      });
      isNewDonation = true;
      return donation;
    };

    let donation: Donation;
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
        else throw error;
      } else {
        throw error;
      }
    }

    // The donation is already committed; an email-provider outage must
    // never make the request fail or look like the donation didn't go
    // through. Each notification is independent (allSettled, not
    // Promise.all) so the creator's email failing doesn't skip the
    // supporter's, and each failure is logged individually.
    if (isNewDonation) {
      const [creatorResult, supporterResult] = await Promise.allSettled([
        notifyDonationReceived(donation),
        notifyDonationConfirmation(donation),
      ]);
      if (creatorResult.status === "rejected") {
        console.error(
          `Donation-received email failed for donation ${donation.id}:`,
          (creatorResult.reason as Error).message
        );
      }
      if (supporterResult.status === "rejected") {
        console.error(
          `Donation-confirmation email failed for donation ${donation.id}:`,
          (supporterResult.reason as Error).message
        );
      }
    }

    return res.status(201).json(donation);
  })
);

export default router;

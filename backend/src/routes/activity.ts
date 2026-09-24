import { Router } from "express";
import prisma from "../prisma";
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();

type EarningsByCurrency = Record<string, number>;

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = 10;
    const skip = (page - 1) * limit;

    const [totalSignups, totalCreators, totalByCurrency, perCreatorByCurrency, users, totalCount] =
      await Promise.all([
        prisma.user.count(),
        prisma.creator.count(),
        prisma.donation.groupBy({
          where: { verified: true },
          by: ["currency"],
          _sum: { amount: true },
        }),
        prisma.donation.groupBy({
          where: { verified: true },
          by: ["creatorId", "currency"],
          _sum: { amount: true },
        }),
        prisma.user.findMany({
          orderBy: { createdAt: "desc" },
          include: { creator: true },
          skip,
          take: limit,
        }),
        prisma.user.count(),
      ]);

    const earningsByCurrency: EarningsByCurrency = {};
    for (const row of totalByCurrency) {
      earningsByCurrency[row.currency] = row._sum.amount ?? 0;
    }

    const earningsByCreator = new Map<number, EarningsByCurrency>();
    for (const row of perCreatorByCurrency) {
      const bucket = earningsByCreator.get(row.creatorId) ?? {};
      bucket[row.currency] = row._sum.amount ?? 0;
      earningsByCreator.set(row.creatorId, bucket);
    }

    const userRows = users.map((u) => ({
      id: u.id,
      walletAddress: u.walletAddress,
      joinedAt: u.createdAt,
      username: u.creator?.username ?? null,
      displayName: u.creator?.displayName ?? null,
      earningsByCurrency: u.creator ? earningsByCreator.get(u.creator.id) ?? {} : {},
    }));

    return res.json({
      totalSignups,
      totalCreators,
      earningsByCurrency,
      users: userRows,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  })
);

export default router;

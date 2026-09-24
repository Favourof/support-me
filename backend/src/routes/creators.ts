import { Router } from "express";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import {
  createCreatorParamsSchema,
  createCreatorSchema,
  listCreatorsQuerySchema,
  updateCreatorSchema,
  usernameParamSchema,
} from "../schemas/creators";
import { ConflictError, NotFoundError, UnauthorizedError } from "../errors/AppError";

const router = Router();

// Discovery/search: browse creators by name or username, sorted by newest
// or by donation count ("most supported" — a currency-agnostic proxy for
// popularity, since a creator's donations can span multiple assets).
router.get(
  "/",
  validate({ query: listCreatorsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { q, sort, page, limit } = req.query as unknown as {
      q?: string;
      sort: "newest" | "most-supported";
      page: number;
      limit: number;
    };

    const where = q
      ? {
          OR: [
            { username: { contains: q, mode: "insensitive" as const } },
            { displayName: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : undefined;

    const orderBy =
      sort === "most-supported"
        ? { donations: { _count: "desc" as const } }
        : { createdAt: "desc" as const };

    const [creators, total] = await Promise.all([
      prisma.creator.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { donations: { where: { verified: true } } } },
        },
      }),
      prisma.creator.count({ where }),
    ]);

    return res.json({
      items: creators,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  })
);

router.get(
  "/me",
  authMiddleware as any,
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const creator = await prisma.creator.findUnique({ where: { userId: req.user.id } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    return res.json(creator);
  })
);

router.get(
  "/:username",
  validate({ params: usernameParamSchema }),
  asyncHandler(async (req, res) => {
    const { username } = req.params;
    const creator = await prisma.creator.findUnique({
      where: { username },
    });

    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    return res.json(creator);
  })
);

router.post(
  "/:username/create",
  authMiddleware as any,
  validate({ params: createCreatorParamsSchema, body: createCreatorSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const { walletAddress, displayName, bio, avatarUrl } = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const existing = await prisma.creator.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictError("Username already exists");
    }

    const userCreator = await prisma.creator.findUnique({
      where: { userId: req.user.id },
    });
    if (userCreator) {
      throw new ConflictError("User already has a creator profile");
    }

    const creator = await prisma.creator.create({
      data: {
        userId: req.user.id,
        username,
        walletAddress: walletAddress || "",
        displayName,
        bio,
        avatarUrl,
      },
    });

    return res.status(201).json(creator);
  })
);

router.put(
  "/:username",
  authMiddleware as any,
  validate({ params: usernameParamSchema, body: updateCreatorSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const updates = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const existing = await prisma.creator.findUnique({ where: { username } });
    if (!existing) {
      throw new NotFoundError("Creator not found");
    }

    // A profile can only be edited by its owner — otherwise anyone could
    // overwrite another creator's payout wallet and redirect their donations.
    if (existing.userId !== req.user.id) {
      throw new UnauthorizedError("You can only edit your own profile");
    }

    const creator = await prisma.creator.update({
      where: { username },
      data: updates,
    });

    return res.json(creator);
  })
);

export default router;

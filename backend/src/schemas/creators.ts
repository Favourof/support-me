import { z } from "zod";
import { assetCode, stellarAddress } from "./common";

export const usernameParamSchema = z.object({
  username: z.string().min(1, "username is required"),
});

export const listCreatorsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["newest", "most-supported"]).optional().default("newest"),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(50).optional().default(20),
});

export const leaderboardQuerySchema = z.object({
  // "creators" ranks by total received; "supporters" ranks by total given.
  type: z.enum(["creators", "supporters"]).optional().default("creators"),
  // Donations across different currencies are never summed together (1 XLM
  // and 1 USDC are not the same value), so a single currency is ranked at a
  // time — defaulting to XLM, the platform's default asset.
  currency: assetCode.optional().default("XLM"),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

const usernamePattern = /^[a-zA-Z0-9_-]{3,30}$/;

export const createCreatorSchema = z.object({
  // The signup form sends "" when no wallet is connected yet.
  walletAddress: stellarAddress.or(z.literal("")).optional(),
  displayName: z.string().max(80).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
});

export const createCreatorParamsSchema = z.object({
  username: z
    .string()
    .regex(usernamePattern, "username must be 3-30 characters (letters, numbers, _ or -)"),
});

export const updateCreatorSchema = z.object({
  displayName: z.string().max(80).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
  walletAddress: stellarAddress.optional(),
  // Values are usually full URLs, but a bare "Website" entry is stored as typed.
  socialLinks: z.record(z.string().max(32), z.string().max(300)).optional(),
  acceptsXlm: z.boolean().optional(),
  acceptsUsdc: z.boolean().optional(),
  acceptsUsdt: z.boolean().optional(),
  // Deprecated alongside Creator.donationGoal (see prisma/schema.prisma) —
  // still accepted here so an already-deployed frontend that hasn't picked
  // up the multi-goal UI doesn't break, but new goals should go through
  // POST /api/goals/:username instead. null clears a previously-set goal; a
  // positive integer sets it.
  donationGoal: z.number().int().positive().nullable().optional(),
});

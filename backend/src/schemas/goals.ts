import { z } from "zod";
import { assetCode } from "./common";

// Kept intentionally small (weekly/monthly) — see the comment on
// `RecurrenceInterval` in prisma/schema.prisma for why this isn't a general
// cron expression.
export const recurrenceIntervalSchema = z.enum(["WEEKLY", "MONTHLY"]);

export const goalStatusSchema = z.enum(["ACTIVE", "COMPLETED", "EXPIRED"]);

export const usernameParamSchema = z.object({
  username: z.string().min(1, "username is required"),
});

export const goalIdParamSchema = z.object({
  id: z.coerce.number().int().positive("id must be a positive integer"),
});

export const listGoalsQuerySchema = z.object({
  status: goalStatusSchema.optional(),
});

export const createGoalSchema = z
  .object({
    title: z.string().max(80).optional(),
    targetAmount: z.coerce.number().positive("targetAmount must be a positive number"),
    currency: assetCode.default("XLM"),
    recurring: z.boolean().optional().default(false),
    recurrenceInterval: recurrenceIntervalSchema.optional(),
  })
  .refine((data) => !data.recurring || data.recurrenceInterval, {
    message: "recurrenceInterval is required when recurring is true",
    path: ["recurrenceInterval"],
  });

export const updateGoalSchema = z
  .object({
    title: z.string().max(80).nullable().optional(),
    targetAmount: z.coerce.number().positive("targetAmount must be a positive number").optional(),
    status: goalStatusSchema.optional(),
    recurring: z.boolean().optional(),
    recurrenceInterval: recurrenceIntervalSchema.nullable().optional(),
  })
  .refine((data) => data.recurring !== true || data.recurrenceInterval, {
    message: "recurrenceInterval is required when recurring is true",
    path: ["recurrenceInterval"],
  });

import { Prisma, PrismaClient } from "@prisma/client";
import { NextFunction, Response } from "express";
import prisma from "../prisma";
import { AuthRequest } from "../middleware/auth";

export type AdminAuditClient = Prisma.TransactionClient | PrismaClient;

export interface AdminAuditActionInput {
  /** Stable dotted action name, for example `creator.profile.update`. */
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
}

/** Convert arbitrary route data into a Prisma JSON value without retaining
 * class instances, BigInts, or other values PostgreSQL JSON cannot encode. */
function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) return Prisma.JsonNull;

  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return String(value) as Prisma.InputJsonValue;
  }
}

/**
 * Persist one privileged action. Call this inside the same transaction as a
 * state-changing admin operation so an action cannot be committed without its
 * audit row (and vice versa).
 */
export async function recordAdminAction(
  client: AdminAuditClient,
  req: AuthRequest,
  input: AdminAuditActionInput
) {
  const adminId = req.user?.id;
  if (!req.user) {
    throw new Error("Cannot record an admin action without an authenticated user");
  }

  const data: Prisma.AdminAuditLogUncheckedCreateInput = {
    adminId,
    adminWalletAddress: req.user.walletAddress,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    requestId: req.requestId,
  };

  if (input.before !== undefined) data.before = jsonValue(redact(input.before));
  if (input.after !== undefined) data.after = jsonValue(redact(input.after));

  return client.adminAuditLog.create({ data });
}

/** Fire-and-forget variant for read/access auditing or legacy handlers that
 * cannot be placed in the mutation transaction. */
export async function recordAdminActionSafely(
  req: AuthRequest,
  input: AdminAuditActionInput,
  client: AdminAuditClient = prisma
): Promise<void> {
  try {
    await recordAdminAction(client, req, input);
  } catch (error) {
    console.error("Admin audit log write failed:", (error as Error).message);
  }
}

const SENSITIVE_KEYS = /password|secret|token|authorization|privatekey|apikey/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redact(item),
      ])
    );
  }
  return value;
}

/**
 * Safety net for future state-changing admin routes. Explicit handlers should
 * prefer recordAdminAction inside their mutation transaction; this middleware
 * ensures an otherwise-unannotated POST/PUT/PATCH/DELETE cannot silently
 * bypass the audit trail. GET access is handled separately by the overview
 * route, and failed requests are not recorded as successful actions.
 */
export function adminAuditMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.method === "GET" || req.path.startsWith("/audit-log")) {
    next();
    return;
  }

  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    const params = Object.entries(req.params || {})
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    void recordAdminActionSafely(req, {
      action: `admin.${req.method.toLowerCase()}.${req.path}`,
      targetType: "admin-route",
      targetId: params || req.path,
      after: redact(req.body),
    });
  });

  next();
}

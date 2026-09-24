import { Router } from "express";
import { Webhook } from "standardwebhooks";
import prisma from "../prisma";
import { asyncHandler } from "../middleware/asyncHandler";
import { log } from "../lib/logger";
import { BadRequestError } from "../errors/AppError";

const router = Router();

// Resend signs webhooks per the Svix/standardwebhooks spec, keyed to a
// per-endpoint secret from the Resend dashboard. Without it configured we
// can't tell a real bounce notification from a forged one, so refuse to
// process any payload.
//
// standardwebhooks (not the svix package) because svix ships ESM-only with
// no CommonJS build, which this project's ts-jest/CJS test setup can't load;
// standardwebhooks is the same verification implementation svix wraps, with
// a CJS build, so it's used directly here. Resend's docs name the headers
// svix-id/svix-timestamp/svix-signature; standardwebhooks itself expects
// webhook-id/webhook-timestamp/webhook-signature, so they're mapped below.
function getWebhookSecret(): string {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("RESEND_WEBHOOK_SECRET is not configured");
  }
  return secret;
}

interface ResendWebhookPayload {
  type: "email.sent" | "email.delivered" | "email.bounced" | "email.complained" | string;
  data: {
    email_id?: string;
    to?: string[];
    subject?: string;
    bounce?: { message?: string };
  };
}

/**
 * Receives Resend's delivery-status webhooks (delivered/bounced/complained)
 * and records them as EmailEvent rows linked by providerMessageId back to
 * the SENT row from mailer.ts, so a bounce is queryable against the send
 * that caused it. Mounted with express.raw() in app.ts (ahead of
 * express.json()) because Svix signature verification needs the exact raw
 * request body, not a re-serialized parsed one.
 */
router.post(
  "/resend",
  asyncHandler(async (req, res) => {
    const secret = getWebhookSecret();
    const payloadBody = req.body;
    if (!Buffer.isBuffer(payloadBody)) {
      throw new BadRequestError("Expected raw request body for webhook signature verification");
    }

    const webhook = new Webhook(secret);
    let event: ResendWebhookPayload;
    try {
      event = webhook.verify(payloadBody, {
        "webhook-id": req.header("svix-id") || "",
        "webhook-timestamp": req.header("svix-timestamp") || "",
        "webhook-signature": req.header("svix-signature") || "",
      }) as unknown as ResendWebhookPayload;
    } catch (err) {
      log("warn", "email webhook signature verification failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new BadRequestError("Invalid webhook signature");
    }

    const recipient = event.data.to?.[0];
    if (!recipient) {
      log("warn", "email webhook missing recipient", { type: event.type });
      return res.status(200).json({ received: true });
    }

    const eventTypeByResendType: Record<string, "DELIVERED" | "BOUNCED" | "COMPLAINED"> = {
      "email.delivered": "DELIVERED",
      "email.bounced": "BOUNCED",
      "email.complained": "COMPLAINED",
    };
    const type = eventTypeByResendType[event.type];
    if (!type) {
      // email.sent and any future event types Resend adds: nothing actionable
      // yet, acknowledge and move on rather than erroring on an unknown type.
      return res.status(200).json({ received: true });
    }

    await prisma.emailEvent.create({
      data: {
        recipient,
        subject: event.data.subject || "",
        type,
        providerMessageId: event.data.email_id,
        errorDetail: event.data.bounce?.message,
      },
    });

    if (type === "BOUNCED" || type === "COMPLAINED") {
      log("warn", "email delivery failure reported by provider", {
        to: recipient,
        type,
        providerMessageId: event.data.email_id,
        error: event.data.bounce?.message,
      });
    }

    return res.status(200).json({ received: true });
  })
);

export default router;

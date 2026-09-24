import prisma from "../../prisma";
import { log } from "../../lib/logger";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * How long a hard bounce or spam complaint suppresses further sends to that
 * address. Not permanent: an address can be fixed (typo corrected, mailbox
 * un-fulled) and Resend re-validates on every send anyway, so this only
 * needs to stop an immediate retry storm, not blocklist forever.
 */
const SUPPRESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Whether `to` had a bounce or complaint recorded within the suppression
 * window. Checked before every send so a caller retrying on a schedule (e.g.
 * the subscription executor's tick) doesn't keep hammering a dead address.
 */
async function isSuppressed(to: string): Promise<boolean> {
  const recentBadEvent = await prisma.emailEvent.findFirst({
    where: {
      recipient: to,
      type: { in: ["BOUNCED", "COMPLAINED"] },
      createdAt: { gte: new Date(Date.now() - SUPPRESSION_WINDOW_MS) },
    },
    select: { id: true },
  });
  return recentBadEvent !== null;
}

/**
 * Sends a transactional email through Resend's HTTP API when
 * `RESEND_API_KEY` is configured. Without it (local dev, CI), the message is
 * logged instead so the calling flow still runs end to end.
 *
 * Kept to a plain `fetch` so there's no SDK dependency to swap out if the
 * provider changes; only this function knows about Resend. Every attempt
 * (skipped, sent, or failed) is logged and recorded as an EmailEvent so
 * delivery problems are visible without grepping application logs.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (await isSuppressed(message.to)) {
    log("warn", "email send skipped: recipient suppressed", { to: message.to, subject: message.subject });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log("info", "email not sent: RESEND_API_KEY unset", { to: message.to, subject: message.subject });
    return;
  }

  let response: Response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "SupportMe <notifications@supportme.app>",
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : String(err);
    log("error", "email send failed: network error", { to: message.to, subject: message.subject, error: errorDetail });
    await prisma.emailEvent.create({
      data: { recipient: message.to, subject: message.subject, type: "FAILED", errorDetail },
    });
    throw err;
  }

  if (!response.ok) {
    const errorDetail = await response.text().catch(() => "");
    log("error", "email send failed: provider error", {
      to: message.to,
      subject: message.subject,
      status: response.status,
      error: errorDetail,
    });
    await prisma.emailEvent.create({
      data: {
        recipient: message.to,
        subject: message.subject,
        type: "FAILED",
        errorDetail: `HTTP ${response.status}: ${errorDetail}`,
      },
    });
    throw new Error(`Email provider responded ${response.status}: ${errorDetail}`);
  }

  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  log("info", "email sent", { to: message.to, subject: message.subject, providerMessageId: body?.id });
  await prisma.emailEvent.create({
    data: {
      recipient: message.to,
      subject: message.subject,
      type: "SENT",
      providerMessageId: body?.id,
    },
  });
}

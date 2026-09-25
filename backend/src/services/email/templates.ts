export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface DonationReceivedEmailContext {
  /** The creator's own dashboard link, where they can see the full donation. */
  dashboardUrl: string;
  amount: number;
  currency: string;
  /** Truncated for display; the full sender address is never emailed. */
  senderAddress: string;
  message?: string | null;
}

export interface DonationConfirmationEmailContext {
  creatorName: string;
  amount: number;
  currency: string;
  transactionHash?: string | null;
}

export interface MagicLinkEmailContext {
  /** Full verification URL (includes the token); never logged. */
  verifyUrl: string;
  expiresInMinutes: number;
}

export interface SubscriptionEmailContext {
  creatorName: string;
  amount: number;
  token: string;
  intervalSecs: number;
  /** Link to the supporter's subscriptions page, where they can manage/fix it. */
  manageUrl: string;
}

export interface RenewedEmailContext extends SubscriptionEmailContext {
  txHash: string;
  nextChargeAt: Date;
}

export interface PaymentFailedEmailContext extends SubscriptionEmailContext {
  /** Raw error recorded by the executor; classified into a human explanation. */
  error: string;
}

export type FailureReason = "allowance" | "balance" | "inactive" | "operational" | "unknown";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatAmount = (amount: number, token: string): string =>
  `${Number(amount.toFixed(7))} ${token}`;

const formatDate = (date: Date): string =>
  date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export function describeInterval(intervalSecs: number): string {
  const days = intervalSecs / 86400;
  if (days === 1) return "daily";
  if (days === 7) return "weekly";
  if (days >= 28 && days <= 31) return "monthly";
  if (days === 365) return "yearly";
  if (Number.isInteger(days)) return `every ${days} days`;
  return `every ${Math.round(intervalSecs / 3600)} hours`;
}

/**
 * Maps the executor's raw error (an RPC/simulation message) onto the cause a
 * supporter can actually act on. Order matters: allowance errors often also
 * mention "insufficient", so they're checked first. `Error(Contract, #N)`
 * codes are the Stellar Asset Contract's: 9 = allowance, 10 = balance,
 * 13 = missing trustline.
 *
 * "operational" covers failures on our side (executor misconfigured, RPC
 * unreachable, a charge that isn't due yet) — nothing the supporter can fix,
 * so they're never emailed about.
 */
export function classifyFailure(error: string): FailureReason {
  if (/executor not set|not yet due|did not confirm|fetch failed|ECONN|ETIMEDOUT|socket hang up/i.test(error)) {
    return "operational";
  }
  if (/allowance|approve|Error\(Contract, #9\)/i.test(error)) return "allowance";
  if (/insufficient|underfunded|balance|trustline|Error\(Contract, #(10|13)\)/i.test(error)) {
    return "balance";
  }
  if (/not active|inactive|cancel/i.test(error)) return "inactive";
  return "unknown";
}

const FAILURE_COPY: Record<FailureReason, { explanation: string; fix: string }> = {
  allowance: {
    explanation:
      "The spending allowance you approved for this recurring donation has run out, expired, or was revoked, so the charge couldn't be drawn from your wallet.",
    fix: "Open your subscriptions and re-approve the allowance for this donation.",
  },
  balance: {
    explanation: "Your wallet didn't have enough balance to cover this charge.",
    fix: "Top up your wallet with enough {token} to cover the charge. We'll retry automatically.",
  },
  inactive: {
    explanation: "This recurring donation is no longer active on-chain.",
    fix: "If you'd like to keep supporting this creator, start a new recurring donation from their page.",
  },
  operational: {
    explanation: "We ran into a temporary problem on our side while processing this charge.",
    fix: "No action is needed — we'll retry automatically.",
  },
  unknown: {
    explanation: "The network rejected the charge for a reason we couldn't pin down.",
    fix: "Check that your wallet is funded and the allowance is still approved. We'll retry automatically.",
  },
};

function layout(heading: string, bodyHtml: string, cta: { label: string; url: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 8px;font-size:14px;color:#78716c;">SupportMe</p>
        <h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(heading)}</h1>
        ${bodyHtml}
        <p style="margin:24px 0 0;">
          <a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">${escapeHtml(cta.label)}</a>
        </p>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function subscriptionRenewedEmail(ctx: RenewedEmailContext): RenderedEmail {
  const amount = formatAmount(ctx.amount, ctx.token);
  const cadence = describeInterval(ctx.intervalSecs);
  const nextDate = formatDate(ctx.nextChargeAt);

  const subject = `Your ${cadence} support for ${ctx.creatorName} was renewed`;

  const html = layout(
    `Thanks for supporting ${ctx.creatorName}!`,
    `<p style="margin:0 0 12px;line-height:1.5;">Your ${escapeHtml(cadence)} donation of <strong>${escapeHtml(amount)}</strong> to <strong>${escapeHtml(ctx.creatorName)}</strong> went through.</p>
        <p style="margin:0 0 12px;line-height:1.5;">Next charge: <strong>${escapeHtml(nextDate)}</strong></p>
        <p style="margin:0;font-size:13px;color:#78716c;word-break:break-all;">Transaction: ${escapeHtml(ctx.txHash)}</p>`,
    { label: "Manage subscription", url: ctx.manageUrl }
  );

  const text = [
    `Thanks for supporting ${ctx.creatorName}!`,
    "",
    `Your ${cadence} donation of ${amount} to ${ctx.creatorName} went through.`,
    `Next charge: ${nextDate}`,
    `Transaction: ${ctx.txHash}`,
    "",
    `Manage subscription: ${ctx.manageUrl}`,
  ].join("\n");

  return { subject, html, text };
}

export function subscriptionPaymentFailedEmail(ctx: PaymentFailedEmailContext): RenderedEmail {
  const amount = formatAmount(ctx.amount, ctx.token);
  const reason = classifyFailure(ctx.error);
  const { explanation } = FAILURE_COPY[reason];
  const fix = FAILURE_COPY[reason].fix.replace("{token}", ctx.token);
  const ctaLabel = reason === "allowance" ? "Re-approve allowance" : "Fix my subscription";

  const subject = `Action needed: your donation to ${ctx.creatorName} didn't go through`;

  const html = layout(
    "Your recurring donation couldn't be charged",
    `<p style="margin:0 0 12px;line-height:1.5;">We tried to charge your donation of <strong>${escapeHtml(amount)}</strong> to <strong>${escapeHtml(ctx.creatorName)}</strong>, but it didn't go through.</p>
        <p style="margin:0 0 12px;line-height:1.5;"><strong>What happened:</strong> ${escapeHtml(explanation)}</p>
        <p style="margin:0;line-height:1.5;"><strong>How to fix it:</strong> ${escapeHtml(fix)}</p>`,
    { label: ctaLabel, url: ctx.manageUrl }
  );

  const text = [
    "Your recurring donation couldn't be charged",
    "",
    `We tried to charge your donation of ${amount} to ${ctx.creatorName}, but it didn't go through.`,
    "",
    `What happened: ${explanation}`,
    `How to fix it: ${fix}`,
    "",
    `${ctaLabel}: ${ctx.manageUrl}`,
  ].join("\n");

  return { subject, html, text };
}

/** First 6 / last 4 characters, matching how Stellar addresses are
 * conventionally shortened for display; never the full address. */
function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Notifies a creator that they received a one-time donation. */
export function donationReceivedEmail(ctx: DonationReceivedEmailContext): RenderedEmail {
  const amount = formatAmount(ctx.amount, ctx.currency);
  const sender = truncateAddress(ctx.senderAddress);

  const subject = `You received a ${amount} donation!`;

  const html = layout(
    "You've received a new donation",
    `<p style="margin:0 0 12px;line-height:1.5;">Someone just supported you with <strong>${escapeHtml(amount)}</strong>.</p>
        <p style="margin:0 0 12px;line-height:1.5;">From: <span style="font-family:monospace;">${escapeHtml(sender)}</span></p>
        ${ctx.message ? `<p style="margin:0 0 12px;line-height:1.5;"><strong>Message:</strong> "${escapeHtml(ctx.message)}"</p>` : ""}`,
    { label: "View dashboard", url: ctx.dashboardUrl }
  );

  const text = [
    "You've received a new donation",
    "",
    `Someone just supported you with ${amount}.`,
    `From: ${sender}`,
    ...(ctx.message ? [`Message: "${ctx.message}"`] : []),
    "",
    `View dashboard: ${ctx.dashboardUrl}`,
  ].join("\n");

  return { subject, html, text };
}

/** Confirms to a supporter that their one-time donation was recorded. */
export function donationConfirmationEmail(ctx: DonationConfirmationEmailContext): RenderedEmail {
  const amount = formatAmount(ctx.amount, ctx.currency);

  const subject = `Thanks for supporting ${ctx.creatorName}!`;

  const html = layout(
    `Thanks for supporting ${ctx.creatorName}!`,
    `<p style="margin:0 0 12px;line-height:1.5;">Your donation of <strong>${escapeHtml(amount)}</strong> to <strong>${escapeHtml(ctx.creatorName)}</strong> was recorded.</p>
        ${
          ctx.transactionHash
            ? `<p style="margin:0;font-size:13px;color:#78716c;word-break:break-all;">Transaction: ${escapeHtml(ctx.transactionHash)}</p>`
            : ""
        }`,
    { label: "Support again", url: "https://supportme.app" }
  );

  const text = [
    `Thanks for supporting ${ctx.creatorName}!`,
    "",
    `Your donation of ${amount} to ${ctx.creatorName} was recorded.`,
    ...(ctx.transactionHash ? [`Transaction: ${ctx.transactionHash}`] : []),
  ].join("\n");

  return { subject, html, text };
}

/** The magic-link sign-in email (#15). */
export function magicLinkEmail(ctx: MagicLinkEmailContext): RenderedEmail {
  const subject = "Sign in to SupportMe";

  const html = layout(
    "Sign in to SupportMe",
    `<p style="margin:0 0 12px;line-height:1.5;">Click below to sign in. This link expires in ${ctx.expiresInMinutes} minutes and can only be used once.</p>
        <p style="margin:0;font-size:13px;color:#78716c;">If you didn't request this, you can safely ignore this email.</p>`,
    { label: "Sign in", url: ctx.verifyUrl }
  );

  const text = [
    "Sign in to SupportMe",
    "",
    `Click below to sign in. This link expires in ${ctx.expiresInMinutes} minutes and can only be used once.`,
    "",
    `Sign in: ${ctx.verifyUrl}`,
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");

  return { subject, html, text };
}

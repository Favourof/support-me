import { renderBaseLayout, escapeHtml } from "./baseLayout";

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

export interface DonationReceiptEmailContext {
  creatorName: string;
  donorName?: string | null;
  donorAddress?: string | null;
  amount: number;
  currency: string;
  message?: string | null;
  timestamp: Date;
  transactionHash?: string | null;
  dashboardUrl?: string;
}

export interface WelcomeEmailContext {
  username: string;
  profileUrl: string;
  dashboardUrl: string;
}

export type FailureReason = "allowance" | "balance" | "inactive" | "operational" | "unknown";

export const formatAmount = (amount: number, token: string): string =>
  `${Number(amount.toFixed(7))} ${token}`;

export const formatDate = (date: Date): string =>
  date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });

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
 * Shortens a Stellar address or transaction hash for readable email display.
 */
export function truncateHash(hash: string, left = 6, right = 6): string {
  if (!hash || hash.length <= left + right) return hash;
  return `${hash.slice(0, left)}...${hash.slice(-right)}`;
}

export function classifyFailure(error: string): FailureReason {
  if (
    /executor not set|not yet due|did not confirm|fetch failed|ECONN|ETIMEDOUT|socket hang up/i.test(
      error
    )
  ) {
    return "operational";
  }
  if (/allowance|approve|Error\(Contract, #9\)/i.test(error)) return "allowance";
  if (
    /insufficient|underfunded|balance|trustline|Error\(Contract, #(10|13)\)/i.test(error)
  ) {
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

/**
 * Generates an explorer link for Stellar testnet / public transactions.
 */
function getExplorerUrl(txHash: string): string {
  const isTestnet = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || "TESTNET").toUpperCase() === "TESTNET";
  const networkPrefix = isTestnet ? "testnet" : "public";
  return `https://stellar.expert/explorer/${networkPrefix}/tx/${txHash}`;
}

/**
 * Concrete template: Donation receipt email sent to creator when a donation is settled.
 */
export function donationReceiptEmail(ctx: DonationReceiptEmailContext): RenderedEmail {
  const formattedAmount = formatAmount(ctx.amount, ctx.currency);
  const formattedDate = formatDate(ctx.timestamp);
  const isAnonymous =
    !ctx.donorName && (!ctx.donorAddress || ctx.donorAddress.toLowerCase() === "anonymous");

  const donorDisplay = isAnonymous
    ? "An anonymous supporter"
    : ctx.donorName || (ctx.donorAddress ? truncateHash(ctx.donorAddress) : "A supporter");

  const subject = isAnonymous
    ? `You received an anonymous donation of ${formattedAmount}!`
    : `You received a ${formattedAmount} donation from ${donorDisplay}!`;

  const dashboardUrl =
    ctx.dashboardUrl ||
    `${(process.env.APP_URL || "https://supportme.app").replace(/\/$/, "")}/dashboard`;

  const txLink = ctx.transactionHash
    ? `<a href="${escapeHtml(getExplorerUrl(ctx.transactionHash))}" style="color:#0284c7;text-decoration:none;font-family:monospace;word-break:break-all;">${escapeHtml(
        truncateHash(ctx.transactionHash, 8, 8)
      )}</a>`
    : `<span style="color:#78716c;">Confirmed on-chain</span>`;

  const messageHtml = ctx.message && ctx.message.trim()
    ? `<div style="margin:20px 0;padding:16px 20px;background:#f5f5f4;border-left:4px solid #84cc16;border-radius:4px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#78716c;">Donor Message</p>
        <p style="margin:0;font-size:15px;line-height:1.5;color:#1c1917;font-style:italic;">&ldquo;${escapeHtml(
          ctx.message.trim()
        )}&rdquo;</p>
      </div>`
    : `<p style="margin:16px 0 20px;font-size:14px;color:#78716c;font-style:italic;">No message was included with this donation.</p>`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#44403c;">
      Hi <strong>${escapeHtml(ctx.creatorName)}</strong>,
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#44403c;">
      Great news! <strong>${escapeHtml(donorDisplay)}</strong> just sent you a donation to support your work.
    </p>

    <!-- Receipt Card -->
    <div style="background:#fafaf9;border:1px solid #e7e5e4;border-radius:10px;padding:20px;margin-bottom:24px;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#78716c;margin-bottom:4px;font-weight:600;">Total Received</div>
      <div style="font-size:28px;font-weight:800;color:#1c1917;margin-bottom:16px;">${escapeHtml(formattedAmount)}</div>
      
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #e7e5e4;font-size:13px;">
        <tr>
          <td style="padding:10px 0 6px;color:#78716c;">Supporter:</td>
          <td align="right" style="padding:10px 0 6px;font-weight:600;color:#1c1917;">${escapeHtml(donorDisplay)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#78716c;">Date:</td>
          <td align="right" style="padding:6px 0;font-weight:600;color:#1c1917;">${escapeHtml(formattedDate)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0 0;color:#78716c;">Transaction:</td>
          <td align="right" style="padding:6px 0 0;">${txLink}</td>
        </tr>
      </table>
    </div>

    ${messageHtml}
  `;

  const html = renderBaseLayout({
    title: subject,
    preheader: `You received ${formattedAmount} from ${donorDisplay}`,
    heading: isAnonymous ? "New Anonymous Donation!" : "New Donation Received!",
    bodyHtml,
    cta: {
      label: "View in Dashboard",
      url: dashboardUrl,
    },
    footerNotice:
      "You received this donation receipt because an on-chain transfer was recorded for your creator account.",
  });

  const textLines = [
    `Hi ${ctx.creatorName},`,
    "",
    `Great news! ${donorDisplay} just sent you a donation of ${formattedAmount}.`,
    "",
    "--- DONATION RECEIPT ---",
    `Amount: ${formattedAmount}`,
    `Supporter: ${donorDisplay}`,
    `Date: ${formattedDate}`,
    ctx.transactionHash ? `Transaction: ${getExplorerUrl(ctx.transactionHash)}` : "Transaction: Confirmed on-chain",
    "",
    ctx.message && ctx.message.trim()
      ? `Supporter Message: "${ctx.message.trim()}"`
      : "Supporter Message: (None included)",
    "",
    `View your dashboard: ${dashboardUrl}`,
  ];

  return { subject, html, text: textLines.join("\n") };
}

/**
 * Concrete template: Subscription renewal notice sent to supporter.
 */
export function subscriptionRenewedEmail(ctx: RenewedEmailContext): RenderedEmail {
  const amount = formatAmount(ctx.amount, ctx.token);
  const cadence = describeInterval(ctx.intervalSecs);
  const nextDate = formatDate(ctx.nextChargeAt);

  const subject = `Your ${cadence} support for ${ctx.creatorName} was renewed`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#44403c;">
      Your ${escapeHtml(cadence)} donation of <strong>${escapeHtml(amount)}</strong> to <strong>${escapeHtml(
    ctx.creatorName
  )}</strong> went through successfully.
    </p>

    <div style="background:#fafaf9;border:1px solid #e7e5e4;border-radius:10px;padding:20px;margin-bottom:20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:13px;">
        <tr>
          <td style="padding:4px 0;color:#78716c;">Creator:</td>
          <td align="right" style="padding:4px 0;font-weight:600;color:#1c1917;">${escapeHtml(ctx.creatorName)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#78716c;">Amount Charged:</td>
          <td align="right" style="padding:4px 0;font-weight:600;color:#1c1917;">${escapeHtml(amount)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#78716c;">Next Scheduled Charge:</td>
          <td align="right" style="padding:4px 0;font-weight:600;color:#1c1917;">${escapeHtml(nextDate)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0 0;color:#78716c;">Transaction:</td>
          <td align="right" style="padding:4px 0 0;">
            <a href="${escapeHtml(getExplorerUrl(ctx.txHash))}" style="color:#0284c7;text-decoration:none;font-family:monospace;">
              ${escapeHtml(truncateHash(ctx.txHash, 8, 8))}
            </a>
          </td>
        </tr>
      </table>
    </div>
  `;

  const html = renderBaseLayout({
    title: subject,
    preheader: `Your ${cadence} support of ${amount} to ${ctx.creatorName} renewed`,
    heading: `Thanks for supporting ${ctx.creatorName}!`,
    bodyHtml,
    cta: { label: "Manage Subscription", url: ctx.manageUrl },
  });

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

/**
 * Concrete template: Payment failed notification sent to supporter.
 */
export function subscriptionPaymentFailedEmail(ctx: PaymentFailedEmailContext): RenderedEmail {
  const amount = formatAmount(ctx.amount, ctx.token);
  const reason = classifyFailure(ctx.error);
  const { explanation } = FAILURE_COPY[reason];
  const fix = FAILURE_COPY[reason].fix.replace("{token}", ctx.token);
  const ctaLabel = reason === "allowance" ? "Re-approve allowance" : "Fix my subscription";

  const subject = `Action needed: your donation to ${ctx.creatorName} didn't go through`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#44403c;">
      We tried to charge your recurring donation of <strong>${escapeHtml(amount)}</strong> to <strong>${escapeHtml(
    ctx.creatorName
  )}</strong>, but the transaction didn't go through.
    </p>

    <div style="background:#fef2f2;border:1px solid #fee2e2;border-radius:10px;padding:20px;margin-bottom:20px;">
      <p style="margin:0 0 8px;font-size:13px;color:#991b1b;font-weight:600;">What happened:</p>
      <p style="margin:0 0 16px;font-size:14px;color:#7f1d1d;line-height:1.5;">${escapeHtml(explanation)}</p>
      <p style="margin:0 0 8px;font-size:13px;color:#991b1b;font-weight:600;">How to fix it:</p>
      <p style="margin:0;font-size:14px;color:#7f1d1d;line-height:1.5;">${escapeHtml(fix)}</p>
    </div>
  `;

  const html = renderBaseLayout({
    title: subject,
    preheader: `Action needed for your support to ${ctx.creatorName}`,
    heading: "Recurring donation charge failed",
    bodyHtml,
    cta: { label: ctaLabel, url: ctx.manageUrl },
  });

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
  const html = renderBaseLayout({
    title: subject,
    heading: "You've received a new donation",
    bodyHtml: `<p style="margin:0 0 12px;line-height:1.5;">Someone just supported you with <strong>${escapeHtml(amount)}</strong>.</p>
      <p style="margin:0 0 12px;line-height:1.5;">From: <span style="font-family:monospace;">${escapeHtml(sender)}</span></p>
      ${ctx.message ? `<p style="margin:0 0 12px;line-height:1.5;"><strong>Message:</strong> "${escapeHtml(ctx.message)}"</p>` : ""}`,
    cta: { label: "View dashboard", url: ctx.dashboardUrl },
  });
  const text = ["You've received a new donation", "", `Someone just supported you with ${amount}.`, `From: ${sender}`, ...(ctx.message ? [`Message: "${ctx.message}"`] : []), "", `View dashboard: ${ctx.dashboardUrl}`].join("\n");
  return { subject, html, text };
}

/** Confirms to a supporter that their one-time donation was recorded. */
export function donationConfirmationEmail(ctx: DonationConfirmationEmailContext): RenderedEmail {
  const amount = formatAmount(ctx.amount, ctx.currency);
  const subject = `Thanks for supporting ${ctx.creatorName}!`;
  const html = renderBaseLayout({
    title: subject,
    heading: subject,
    bodyHtml: `<p style="margin:0 0 12px;line-height:1.5;">Your donation of <strong>${escapeHtml(amount)}</strong> to <strong>${escapeHtml(ctx.creatorName)}</strong> was recorded.</p>${ctx.transactionHash ? `<p style="margin:0;font-size:13px;color:#78716c;word-break:break-all;">Transaction: ${escapeHtml(ctx.transactionHash)}</p>` : ""}`,
    cta: { label: "Support again", url: "https://supportme.app" },
  });
  const text = [`Thanks for supporting ${ctx.creatorName}!`, "", `Your donation of ${amount} to ${ctx.creatorName} was recorded.`, ...(ctx.transactionHash ? [`Transaction: ${ctx.transactionHash}`] : [])].join("\n");
  return { subject, html, text };
}

/** The magic-link sign-in email (#15). */
export function magicLinkEmail(ctx: MagicLinkEmailContext): RenderedEmail {
  const subject = "Sign in to SupportMe";
  const html = renderBaseLayout({
    title: subject,
    heading: subject,
    bodyHtml: `<p style="margin:0 0 12px;line-height:1.5;">Click below to sign in. This link expires in ${ctx.expiresInMinutes} minutes and can only be used once.</p><p style="margin:0;font-size:13px;color:#78716c;">If you didn't request this, you can safely ignore this email.</p>`,
    cta: { label: "Sign in", url: ctx.verifyUrl },
  });
  const text = ["Sign in to SupportMe", "", `Click below to sign in. This link expires in ${ctx.expiresInMinutes} minutes and can only be used once.`, "", `Sign in: ${ctx.verifyUrl}`, "", "If you didn't request this, you can safely ignore this email."].join("\n");
  return { subject, html, text };
}

/** Concrete template: Welcome email for newly registered creators. */
export function welcomeEmail(ctx: WelcomeEmailContext): RenderedEmail {
  const subject = `Welcome to SupportMe, @${ctx.username}!`;
  const bodyHtml = `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#44403c;">Welcome aboard! Your creator profile is now live and ready to accept one-time and recurring crypto donations.</p><div style="background:#fafaf9;border:1px solid #e7e5e4;border-radius:10px;padding:20px;margin-bottom:20px;"><p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#78716c;text-transform:uppercase;">Your Public Profile</p><p style="margin:0;font-size:16px;font-weight:700;"><a href="${escapeHtml(ctx.profileUrl)}" style="color:#1c1917;text-decoration:underline;">${escapeHtml(ctx.profileUrl)}</a></p></div><p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#44403c;">Share this link on your social profiles, GitHub, and streams to let supporters fund you directly on Stellar with near-instant settlement and low fees.</p>`;
  const html = renderBaseLayout({ title: subject, heading: "Welcome to SupportMe!", bodyHtml, cta: { label: "Go to Creator Dashboard", url: ctx.dashboardUrl } });
  const text = [`Welcome to SupportMe, @${ctx.username}!`, "", "Your creator profile is now live and ready to accept donations.", `Your public page: ${ctx.profileUrl}`, `Creator dashboard: ${ctx.dashboardUrl}`].join("\n");
  return { subject, html, text };
}

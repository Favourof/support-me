import { Donation } from "@prisma/client";
import prisma from "../prisma";
import { sendEmail } from "./email/mailer";
import { donationConfirmationEmail, donationReceivedEmail } from "./email/templates";

const dashboardUrl = (): string =>
  `${(process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/app/dashboard`;

/**
 * Emails the creator that they received a one-time donation. Returns
 * whether an email was actually sent, mirroring notifySubscriptionRenewed's
 * shape: false (not an error) when the creator hasn't given us an email
 * address, since wallet sign-in never requires one.
 */
export async function notifyDonationReceived(donation: Donation): Promise<boolean> {
  const creator = await prisma.creator.findUnique({
    where: { id: donation.creatorId },
    include: { user: true },
  });
  if (!creator?.user.email) return false;

  await sendEmail({
    to: creator.user.email,
    ...donationReceivedEmail({
      dashboardUrl: dashboardUrl(),
      amount: donation.amount,
      currency: donation.currency,
      senderAddress: donation.senderAddress,
      message: donation.message,
    }),
  });
  return true;
}

/**
 * Optionally confirms the donation to the supporter, when their wallet
 * address matches a known account with an email on file. Most donations
 * come from wallet-only supporters with no account at all, so returning
 * false here is the common case, not an error.
 */
export async function notifyDonationConfirmation(donation: Donation): Promise<boolean> {
  const [supporter, creator] = await Promise.all([
    prisma.user.findUnique({ where: { walletAddress: donation.senderAddress } }),
    prisma.creator.findUnique({ where: { id: donation.creatorId } }),
  ]);
  if (!supporter?.email) return false;

  await sendEmail({
    to: supporter.email,
    ...donationConfirmationEmail({
      creatorName: creator?.displayName || creator?.username || "a creator",
      amount: donation.amount,
      currency: donation.currency,
      transactionHash: donation.transactionHash,
    }),
  });
  return true;
}

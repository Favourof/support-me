import { sendEmail, EmailMessage } from "./mailer";
import {
  donationReceiptEmail,
  subscriptionRenewedEmail,
  subscriptionPaymentFailedEmail,
  welcomeEmail,
  DonationReceiptEmailContext,
  RenewedEmailContext,
  PaymentFailedEmailContext,
  WelcomeEmailContext,
  RenderedEmail,
} from "./templates";

export type EmailTemplateName =
  | "donation-receipt"
  | "subscription-renewed"
  | "subscription-failed"
  | "welcome";

export interface TemplateContextMap {
  "donation-receipt": DonationReceiptEmailContext;
  "subscription-renewed": RenewedEmailContext;
  "subscription-failed": PaymentFailedEmailContext;
  welcome: WelcomeEmailContext;
}

export class EmailService {
  /**
   * Renders a named template with the given context without sending it.
   */
  render<T extends EmailTemplateName>(
    template: T,
    context: TemplateContextMap[T]
  ): RenderedEmail {
    switch (template) {
      case "donation-receipt":
        return donationReceiptEmail(context as DonationReceiptEmailContext);
      case "subscription-renewed":
        return subscriptionRenewedEmail(context as RenewedEmailContext);
      case "subscription-failed":
        return subscriptionPaymentFailedEmail(context as PaymentFailedEmailContext);
      case "welcome":
        return welcomeEmail(context as WelcomeEmailContext);
      default:
        throw new Error(`Unknown email template: ${template}`);
    }
  }

  /**
   * Sends a raw email message via the configured provider.
   */
  async send(message: EmailMessage): Promise<void> {
    await sendEmail(message);
  }

  /**
   * Renders and sends an email template to a recipient.
   */
  async sendTemplate<T extends EmailTemplateName>(
    template: T,
    to: string,
    context: TemplateContextMap[T]
  ): Promise<RenderedEmail> {
    const rendered = this.render(template, context);
    await this.send({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    return rendered;
  }

  /**
   * Sends a donation receipt email to a creator.
   */
  async sendDonationReceipt(
    to: string,
    context: DonationReceiptEmailContext
  ): Promise<RenderedEmail> {
    return this.sendTemplate("donation-receipt", to, context);
  }

  /**
   * Sends a subscription renewal email to a supporter.
   */
  async sendSubscriptionRenewed(
    to: string,
    context: RenewedEmailContext
  ): Promise<RenderedEmail> {
    return this.sendTemplate("subscription-renewed", to, context);
  }

  /**
   * Sends a subscription payment failure email to a supporter.
   */
  async sendSubscriptionFailed(
    to: string,
    context: PaymentFailedEmailContext
  ): Promise<RenderedEmail> {
    return this.sendTemplate("subscription-failed", to, context);
  }

  /**
   * Sends a welcome email to a new creator.
   */
  async sendWelcome(to: string, context: WelcomeEmailContext): Promise<RenderedEmail> {
    return this.sendTemplate("welcome", to, context);
  }
}

export const emailService = new EmailService();

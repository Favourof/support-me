import {
  donationReceiptEmail,
  subscriptionRenewedEmail,
  subscriptionPaymentFailedEmail,
  welcomeEmail,
  classifyFailure,
  describeInterval,
  formatAmount,
} from "../../services/email/templates";
import { renderBaseLayout } from "../../services/email/baseLayout";

describe("BaseLayout", () => {
  it("renders with header, body content, CTA and footer legal links", () => {
    const html = renderBaseLayout({
      title: "Test Email",
      preheader: "Snippet preview",
      heading: "Hello Developer",
      bodyHtml: "<p>This is test email body</p>",
      cta: { label: "Click Here", url: "https://supportme.app/action" },
      footerNotice: "Custom footer notice",
      unsubscribeUrl: "https://supportme.app/settings",
    });

    expect(html).toContain("Support");
    expect(html).toContain("Me");
    expect(html).toContain("Hello Developer");
    expect(html).toContain("This is test email body");
    expect(html).toContain("Click Here");
    expect(html).toContain("https://supportme.app/action");
    expect(html).toContain("Custom footer notice");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Terms of Service");
    expect(html).toContain("Email Preferences");
  });
});

describe("Email Templates", () => {
  describe("donationReceiptEmail", () => {
    it("renders correctly for a named donor with message and txHash", () => {
      const email = donationReceiptEmail({
        creatorName: "sarah_artist",
        donorName: "Alice Wonderland",
        donorAddress: "GBX7...2XYZ",
        amount: 50.0,
        currency: "USDC",
        message: "Love your artwork, keep going!",
        timestamp: new Date("2026-04-15T12:00:00Z"),
        transactionHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        dashboardUrl: "https://supportme.app/dashboard",
      });

      expect(email.subject).toContain("50 USDC");
      expect(email.subject).toContain("Alice Wonderland");
      expect(email.html).toContain("sarah_artist");
      expect(email.html).toContain("Love your artwork, keep going!");
      expect(email.html).toContain("50 USDC");
      expect(email.html).toContain("stellar.expert");
      expect(email.text).toContain("50 USDC");
      expect(email.text).toContain("Alice Wonderland");
      expect(email.text).toContain("Love your artwork, keep going!");
    });

    it("renders correctly for an anonymous donor with no message", () => {
      const email = donationReceiptEmail({
        creatorName: "open_source_dev",
        donorName: null,
        donorAddress: null,
        amount: 100,
        currency: "XLM",
        message: null,
        timestamp: new Date("2026-04-15T12:00:00Z"),
      });

      expect(email.subject).toBe("You received an anonymous donation of 100 XLM!");
      expect(email.html).toContain("New Anonymous Donation!");
      expect(email.html).toContain("An anonymous supporter");
      expect(email.html).toContain("No message was included with this donation.");
      expect(email.text).toContain("An anonymous supporter");
      expect(email.text).toContain("Supporter Message: (None included)");
    });

    it("handles address donor when name is missing", () => {
      const email = donationReceiptEmail({
        creatorName: "streamer",
        donorName: null,
        donorAddress: "GBX7ABCDEF1234567890XYZ",
        amount: 25,
        currency: "XLM",
        timestamp: new Date("2026-04-15T12:00:00Z"),
      });

      expect(email.subject).toContain("GBX7AB...890XYZ");
      expect(email.html).toContain("GBX7AB...890XYZ");
    });
  });

  describe("subscriptionRenewedEmail", () => {
    it("renders renewed recurring donation email with interval and tx hash", () => {
      const email = subscriptionRenewedEmail({
        creatorName: "coder",
        amount: 15,
        token: "USDC",
        intervalSecs: 2592000,
        manageUrl: "https://supportme.app/app/subscriptions",
        txHash: "1234567890abcdef1234567890abcdef",
        nextChargeAt: new Date("2026-05-15T12:00:00Z"),
      });

      expect(email.subject).toContain("monthly support for coder was renewed");
      expect(email.html).toContain("15 USDC");
      expect(email.html).toContain("Manage Subscription");
      expect(email.text).toContain("https://supportme.app/app/subscriptions");
    });
  });

  describe("subscriptionPaymentFailedEmail", () => {
    it("classifies allowance error and shows allowance fix copy", () => {
      const email = subscriptionPaymentFailedEmail({
        creatorName: "coder",
        amount: 15,
        token: "USDC",
        intervalSecs: 2592000,
        manageUrl: "https://supportme.app/app/subscriptions",
        error: "Error(Contract, #9) allowance expired",
      });

      expect(email.subject).toContain("Action needed: your donation to coder didn't go through");
      expect(email.html).toContain("spending allowance you approved");
      expect(email.html).toContain("Re-approve allowance");
    });

    it("classifies balance error and shows top up copy", () => {
      const email = subscriptionPaymentFailedEmail({
        creatorName: "coder",
        amount: 15,
        token: "USDC",
        intervalSecs: 2592000,
        manageUrl: "https://supportme.app/app/subscriptions",
        error: "insufficient funds to cover transfer",
      });

      expect(email.text).toContain("didn't have enough balance");
      expect(email.html).toContain("have enough balance");
      expect(email.html).toContain("Top up your wallet");
    });
  });

  describe("welcomeEmail", () => {
    it("renders welcome email with profile and dashboard links", () => {
      const email = welcomeEmail({
        username: "new_creator",
        profileUrl: "https://supportme.app/new_creator",
        dashboardUrl: "https://supportme.app/dashboard",
      });

      expect(email.subject).toContain("Welcome to SupportMe, @new_creator!");
      expect(email.html).toContain("https://supportme.app/new_creator");
      expect(email.html).toContain("Go to Creator Dashboard");
    });
  });

  describe("helpers", () => {
    it("formats amounts cleanly without trailing zeros", () => {
      expect(formatAmount(10.5, "XLM")).toBe("10.5 XLM");
      expect(formatAmount(20.0, "USDC")).toBe("20 USDC");
    });

    it("describes intervals accurately", () => {
      expect(describeInterval(86400)).toBe("daily");
      expect(describeInterval(86400 * 7)).toBe("weekly");
      expect(describeInterval(86400 * 30)).toBe("monthly");
      expect(describeInterval(86400 * 365)).toBe("yearly");
    });

    it("classifies failures correctly", () => {
      expect(classifyFailure("fetch failed: ECONNREFUSED")).toBe("operational");
      expect(classifyFailure("allowance exceeded")).toBe("allowance");
      expect(classifyFailure("underfunded balance")).toBe("balance");
      expect(classifyFailure("subscription not active")).toBe("inactive");
      expect(classifyFailure("some random soroban error")).toBe("unknown");
    });
  });
});

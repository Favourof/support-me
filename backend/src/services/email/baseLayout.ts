export interface BaseLayoutOptions {
  title: string;
  preheader?: string;
  heading?: string;
  bodyHtml: string;
  cta?: {
    label: string;
    url: string;
  };
  footerNotice?: string;
  unsubscribeUrl?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DEFAULT_APP_URL = (process.env.APP_URL || "https://supportme.app").replace(/\/$/, "");

/**
 * Shared base email layout providing consistent SupportMe branding, responsive
 * container, typography, primary action CTA button, and accessible footer with
 * legal links and notification preferences.
 */
export function renderBaseLayout(opts: BaseLayoutOptions): string {
  const preheaderHtml = opts.preheader
    ? `<span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(
        opts.preheader
      )}</span>`
    : "";

  const headingHtml = opts.heading
    ? `<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;line-height:1.3;color:#1c1917;">${escapeHtml(
        opts.heading
      )}</h1>`
    : "";

  const ctaHtml = opts.cta
    ? `<div style="margin:28px 0 12px;">
        <a href="${escapeHtml(
          opts.cta.url
        )}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;letter-spacing:-0.01em;">${escapeHtml(
        opts.cta.label
      )} &rarr;</a>
      </div>`
    : "";

  const footerNoticeHtml = opts.footerNotice
    ? `<p style="margin:0 0 10px;font-size:12px;line-height:1.5;color:#a8a29e;">${escapeHtml(
        opts.footerNotice
      )}</p>`
    : `<p style="margin:0 0 10px;font-size:12px;line-height:1.5;color:#a8a29e;">You are receiving this transactional email because of activity associated with your account on SupportMe.</p>`;

  const unsubscribeHtml = opts.unsubscribeUrl
    ? `<a href="${escapeHtml(
        opts.unsubscribeUrl
      )}" style="color:#78716c;text-decoration:underline;">Email Preferences</a> &middot; `
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(opts.title)}</title>
  </head>
  <body style="margin:0;padding:32px 16px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1917;-webkit-font-smoothing:antialiased;">
    ${preheaderHtml}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e7e5e4;box-shadow:0 1px 3px rgba(0,0,0,0.05);overflow:hidden;">
      <!-- Header -->
      <tr>
        <td style="padding:28px 32px 20px;border-bottom:1px solid #f5f5f4;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td>
                <a href="${DEFAULT_APP_URL}" style="text-decoration:none;display:inline-flex;align-items:center;">
                  <span style="font-size:18px;font-weight:800;letter-spacing:-0.03em;color:#1c1917;">Support<span style="color:#84cc16;">Me</span></span>
                </a>
              </td>
              <td align="right" style="font-size:12px;color:#a8a29e;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">
                Receipt & Notification
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <!-- Content -->
      <tr>
        <td style="padding:32px;">
          ${headingHtml}
          ${opts.bodyHtml}
          ${ctaHtml}
        </td>
      </tr>
      <!-- Footer -->
      <tr>
        <td style="padding:24px 32px;background:#fafaf9;border-top:1px solid #f5f5f4;font-size:12px;color:#78716c;">
          ${footerNoticeHtml}
          <p style="margin:0;line-height:1.6;">
            ${unsubscribeHtml}
            <a href="${DEFAULT_APP_URL}/privacy" style="color:#78716c;text-decoration:underline;">Privacy Policy</a> &middot;
            <a href="${DEFAULT_APP_URL}/terms" style="color:#78716c;text-decoration:underline;">Terms of Service</a> &middot;
            <a href="${DEFAULT_APP_URL}" style="color:#78716c;text-decoration:underline;">SupportMe Platform</a>
          </p>
          <p style="margin:12px 0 0;font-size:11px;color:#a8a29e;">
            &copy; ${new Date().getFullYear()} SupportMe. All rights reserved.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

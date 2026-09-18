/**
 * Hand-rolled OTP email template.
 *
 * Constraints:
 *  - Table-based layout, 100% inline styles (Gmail/Outlook strip <style> blocks).
 *  - No external assets (images may be blocked; logos would fail).
 *  - Renders acceptably in light + dark clients.
 *
 * Returns both an HTML body and a plain-text fallback.
 */

export type OtpEmailInput = {
  otp: string;
  /** Shown in the greeting/subject context. */
  userName?: string | null;
  /** Org name for the bootstrap flow (optional). */
  orgName?: string | null;
  /** Copy only — must mirror OTP_TTL_MS. */
  expiresInMinutes?: number;
};

export type OtpEmailContent = {
  subject: string;
  html: string;
  text: string;
};

const BRAND = "AgilityOS";
const ACCENT = "#4f46e5"; // indigo-600
const INK = "#0f172a"; // slate-900
const MUTED = "#64748b"; // slate-500
const HAIRLINE = "#e2e8f0"; // slate-200
const CANVAS = "#f8fafc"; // slate-50
const CODE_BG = "#f1f5f9"; // slate-100

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render a 6-digit OTP with slight spacing for legibility. */
function spacedCode(otp: string): string {
  return otp.split("").join("&nbsp;&nbsp;");
}

export function buildOtpEmail(input: OtpEmailInput): OtpEmailContent {
  const expiresInMinutes = input.expiresInMinutes ?? 10;
  const safeName = input.userName ? escapeHtml(input.userName) : null;
  const greeting = safeName ? `Hi ${safeName},` : "Hi there,";
  const context = input.orgName
    ? `Finish setting up <strong style="color:${INK};">${escapeHtml(
        input.orgName,
      )}</strong> on ${BRAND}.`
    : `Welcome to ${BRAND}.`;

  const subject = `${input.otp} is your ${BRAND} verification code`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0; padding:0; width:100%; background-color:${CANVAS}; -webkit-font-smoothing:antialiased;">
  <!-- Preheader: hidden preview text -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
    Your ${BRAND} verification code is ${escapeHtml(
      input.otp,
    )}. It expires in ${expiresInMinutes} minutes.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CANVAS};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px; max-width:100%; background-color:#ffffff; border:1px solid ${HAIRLINE}; border-radius:16px; overflow:hidden;">
          <!-- Accent rule -->
          <tr>
            <td style="height:4px; background-color:${ACCENT}; line-height:4px; font-size:0;">&nbsp;</td>
          </tr>

          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 8px 40px;">
              <span style="font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif; font-size:18px; font-weight:700; letter-spacing:-0.02em; color:${INK};">${BRAND}</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:8px 40px 0 40px; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;">
              <h1 style="margin:16px 0 8px 0; font-size:22px; line-height:30px; font-weight:700; letter-spacing:-0.02em; color:${INK};">Verify your email</h1>
              <p style="margin:0 0 4px 0; font-size:15px; line-height:24px; color:${INK};">${greeting}</p>
              <p style="margin:0; font-size:15px; line-height:24px; color:${MUTED};">${context} Enter the code below to confirm this email address.</p>
            </td>
          </tr>

          <!-- OTP block -->
          <tr>
            <td style="padding:24px 40px 8px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CODE_BG}; border:1px solid ${HAIRLINE}; border-radius:12px;">
                <tr>
                  <td align="center" style="padding:22px 16px;">
                    <div style="font-family:'Courier New',Courier,monospace; font-size:34px; line-height:40px; font-weight:700; letter-spacing:2px; color:${INK};">${spacedCode(
                      input.otp,
                    )}</div>
                    <div style="margin-top:8px; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif; font-size:12px; line-height:18px; letter-spacing:0.06em; text-transform:uppercase; color:${MUTED};">One-time code</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Expiry + security note -->
          <tr>
            <td style="padding:8px 40px 32px 40px; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;">
              <p style="margin:16px 0 0 0; font-size:13px; line-height:20px; color:${MUTED};">
                This code expires in <strong style="color:${INK};">${expiresInMinutes} minutes</strong> and can only be used once.
              </p>
              <p style="margin:8px 0 0 0; font-size:13px; line-height:20px; color:${MUTED};">
                If you didn't request this, you can safely ignore this email — no changes will be made to your account.
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 40px;">
              <div style="height:1px; background-color:${HAIRLINE}; line-height:1px; font-size:0;">&nbsp;</div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 32px 40px; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;">
              <p style="margin:0; font-size:12px; line-height:18px; color:${MUTED};">
                Sent by ${BRAND}. Need help? Just reply to this email.
              </p>
            </td>
          </tr>
        </table>

        <!-- Legal / address line -->
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px; max-width:100%;">
          <tr>
            <td align="center" style="padding:16px 8px 0 8px; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;">
              <p style="margin:0; font-size:11px; line-height:16px; color:${MUTED};">
                You are receiving this because someone started a ${BRAND} sign-up with this email address.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `${BRAND} verification code`,
    "",
    greeting,
    "",
    `${input.orgName ? `Finish setting up ${input.orgName} on ${BRAND}. ` : `Welcome to ${BRAND}. `}Enter this code to confirm your email:`,
    "",
    `    ${input.otp}`,
    "",
    `This code expires in ${expiresInMinutes} minutes and can only be used once.`,
    "If you didn't request this, you can safely ignore this email.",
    "",
    `— ${BRAND}`,
  ].join("\n");

  return { subject, html, text };
}
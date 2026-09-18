/**
 * Employee invite email template (org-tree invitation flow).
 *
 * Same constraints as otpEmail.ts:
 *  - Table-based layout, 100% inline styles (Gmail/Outlook strip <style>).
 *  - No external assets.
 *  - Renders acceptably in light + dark clients.
 *
 * Returns both an HTML body and a plain-text fallback.
 */

export type InviteEmailInput = {
  /** Display name of the invitee (optional). */
  userName?: string | null;
  /** Org the invitee is being added to. */
  orgName?: string | null;
  /** Absolute link to the /accept/<token> page. */
  inviteUrl: string;
  /** Copy only — must mirror INVITE_TTL_MS. */
  expiresInHours?: number;
  /** Display name + email of the admin who sent the invite. */
  sentByName?: string | null;
};

export type InviteEmailContent = {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildInviteEmail(input: InviteEmailInput): InviteEmailContent {
  const expiresInHours = input.expiresInHours ?? 72;
  const safeName = input.userName ? escapeHtml(input.userName) : null;
  const greeting = safeName ? `Hi ${safeName},` : "Hi there,";
  const orgLine = input.orgName
    ? `You've been invited to join <strong style="color:${INK};">${escapeHtml(
        input.orgName,
      )}</strong> on ${BRAND}.`
    : `You've been invited to join your team on ${BRAND}.`;
  const sentByLine = input.sentByName
    ? `by <strong style="color:${INK};">${escapeHtml(input.sentByName)}</strong>`
    : "by an organisation admin";
  const subject = `You've been invited to ${escapeHtml(input.orgName ?? BRAND)}`;

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
    Set up your ${BRAND} account. This invitation link expires in ${expiresInHours} hours.
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
              <h1 style="margin:16px 0 8px 0; font-size:22px; line-height:30px; font-weight:700; letter-spacing:-0.02em; color:${INK};">Welcome to ${BRAND}</h1>
              <p style="margin:0 0 4px 0; font-size:15px; line-height:24px; color:${INK};">${greeting}</p>
              <p style="margin:0; font-size:15px; line-height:24px; color:${MUTED};">${orgLine} Set up your account to get started.</p>
            </td>
          </tr>

          <!-- CTA block -->
          <tr>
            <td style="padding:24px 40px 8px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CANVAS}; border:1px solid ${HAIRLINE}; border-radius:12px;">
                <tr>
                  <td align="center" style="padding:24px 16px;">
                    <a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block; background-color:${ACCENT}; color:#ffffff; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif; font-size:15px; font-weight:700; line-height:20px; text-decoration:none; padding:13px 28px; border-radius:10px;">Set up your account</a>
                    <div style="margin-top:12px; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif; font-size:12px; line-height:18px; color:${MUTED};">or paste this link into your browser:</div>
                    <div style="margin-top:4px; font-family:'Courier New',Courier,monospace; font-size:11px; line-height:16px; color:${MUTED}; word-break:break-all;">${escapeHtml(
                      input.inviteUrl,
                    )}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Expiry + security note -->
          <tr>
            <td style="padding:8px 40px 32px 40px; font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;">
              <p style="margin:16px 0 0 0; font-size:13px; line-height:20px; color:${MUTED};">
                This invitation was sent ${sentByLine} and expires in <strong style="color:${INK};">${expiresInHours} hours</strong>.
              </p>
              <p style="margin:8px 0 0 0; font-size:13px; line-height:20px; color:${MUTED};">
                If you weren't expecting this invitation, you can safely ignore this email.
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
                You are receiving this because an admin invited you to ${BRAND}.
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
    `You've been invited to ${input.orgName ?? BRAND}`,
    "",
    greeting,
    input.orgName
      ? `You've been invited to join ${input.orgName} on ${BRAND}.`
      : `You've been invited to join your team on ${BRAND}.`,
    "",
    "Set up your account at the link below:",
    "",
    `    ${input.inviteUrl}`,
    "",
    `This invitation is valid for ${expiresInHours} hours and can only be used once.`,
    "If you weren't expecting this invitation, you can safely ignore this email.",
    "",
    `— ${BRAND}`,
  ].join("\n");

  return { subject, html, text };
}
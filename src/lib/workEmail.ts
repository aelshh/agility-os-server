/**
 * Work-email validation.
 *
 * Blocks well-known personal / free email providers so that only
 * corporate email addresses are accepted for org bootstrap and
 * dashboard-role invite acceptance.
 *
 * This is intentionally kept as a simple domain-suffix blocklist.
 * It is NOT a claim that all other domains are corporate — it's
 * a first-pass friction gate. The list covers the vast majority of
 * personal-email traffic; edge cases can be corrected by admin review.
 */

const PERSONAL_DOMAINS = new Set([
  // Google
  "gmail.com",
  "googlemail.com",
  // Microsoft / Outlook
  "outlook.com",
  "outlook.in",
  "hotmail.com",
  "hotmail.in",
  "hotmail.co.uk",
  "live.com",
  "live.in",
  "msn.com",
  // Yahoo
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "ymail.com",
  // Apple
  "icloud.com",
  "me.com",
  "mac.com",
  // ProtonMail / encrypted providers
  "protonmail.com",
  "proton.me",
  "pm.me",
  // Others
  "rediffmail.com",
  "aol.com",
  "zohomail.com",  // Zoho's free tier (zoho.com for business is fine)
  "mail.com",
  "inbox.com",
  "gmx.com",
  "gmx.net",
  "tutanota.com",
  "tuta.io",
]);

/**
 * Returns true if the email domain is a known personal/free provider.
 * Throws if the email is malformed (no @ or no domain part).
 */
export function isPersonalEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false; // malformed — let Zod handle it
  const domain = email.slice(at + 1).toLowerCase();
  return PERSONAL_DOMAINS.has(domain);
}

/**
 * Returns true if the email is a valid work email (not a personal domain).
 * Use this in Zod `.refine()` calls.
 */
export function isWorkEmail(email: string): boolean {
  return !isPersonalEmail(email);
}

export const WORK_EMAIL_MESSAGE =
  "Please use your work email address. Personal email providers are not supported.";

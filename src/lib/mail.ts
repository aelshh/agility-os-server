import nodemailer, { type Transporter } from "nodemailer";

import { buildOtpEmail } from "./templates/otpEmail.js";

// ---------------------------------------------------------------------------
// Transporter (lazy singleton)
// ---------------------------------------------------------------------------

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  const host = process.env["SMTP_HOST"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];
  if (!host || !user || !pass) return null;

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port: Number(process.env["SMTP_PORT"] ?? 587),
      secure: process.env["SMTP_SECURE"] === "true",
      auth: { user, pass },
    });
  }
  return transporter;
}

function fromName(): string {
  return process.env["EMAIL_FROM_NAME"] ?? "AgilityOS";
}

function fromAddress(): string {
  const address = process.env["EMAIL_FROM"];
  if (!address) {
    throw new Error(
      "[mail] EMAIL_FROM is not set — must be an address on a domain verified in your mail provider",
    );
  }
  return address;
}

// ---------------------------------------------------------------------------
// sendOtpEmail
// ---------------------------------------------------------------------------

export type SendOtpEmailInput = {
  to: string;
  otp: string;
  userName?: string | null;
  orgName?: string | null;
};

/**
 * Sends the verification OTP email via SMTP.
 * Throws if SMTP is not configured or the send fails.
 */
export async function sendOtpEmail(input: SendOtpEmailInput): Promise<void> {
  const transporter = getTransporter();

  if (!transporter) {
    throw new Error(
      "[mail] SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — cannot send verification email",
    );
  }

  const { subject, html, text } = buildOtpEmail({
    otp: input.otp,
    ...(input.userName !== undefined ? { userName: input.userName } : {}),
    ...(input.orgName !== undefined ? { orgName: input.orgName } : {}),
  });

  try {
    await transporter.sendMail({
      from: {
        address: fromAddress(),
        name: fromName(),
      },
      to: input.to,
      subject,
      html,
      text,
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : (JSON.stringify(err, null, 2) ?? String(err));
    throw new Error(`[mail] SMTP send failed: ${message}`);
  }
}

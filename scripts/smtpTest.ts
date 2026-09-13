import "../src/lib/loadEnv.js";
import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST!;
const user = process.env.SMTP_USER!;
const pass = process.env.SMTP_PASS!;

const transporter = nodemailer.createTransport({
  host,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: { user, pass },
});

try {
  await transporter.verify();
  const masked = pass.length > 8 ? `${pass.slice(0, 4)}...${pass.slice(-4)}` : "(too short)";
  console.log(`SMTP auth OK — credentials accepted (host=${host}, user=${user}, pass=${masked}, len=${pass.length})`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const masked = pass.length > 8 ? `${pass.slice(0, 4)}...${pass.slice(-4)}` : "(too short)";
  console.error(`SMTP auth FAILED for ${user}@${host} (pass=${masked}, len=${pass.length}): ${message}`);
  process.exitCode = 1;
}
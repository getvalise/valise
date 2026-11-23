import { Resend } from "resend";

export type EmailEnv = {
  EMAIL_API_KEY?: string;
  /** The From header, on a domain the email provider has verified for this install. */
  EMAIL_FROM?: string;
  APP_ORIGIN: string;
};

const DEFAULT_EMAIL_FROM = "Valise <noreply@valise.run>";

export function emailSender(env: { EMAIL_FROM?: string }): string {
  return env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM;
}

/**
 * Send a verification email to a new member who created a password.
 * The link confirms their email address.
 */
export async function sendVerificationEmail(
  env: EmailEnv,
  to: string,
  token: string,
): Promise<void> {
  if (!env.EMAIL_API_KEY) {
    throw new Error("Verification email is not configured.");
  }
  const resend = new Resend(env.EMAIL_API_KEY);
  const link = new URL(`/verify-email/${token}`, env.APP_ORIGIN).toString();
  const { error } = await resend.emails.send({
    from: emailSender(env),
    to,
    subject: "Verify your Valise email",
    html: `<p>Welcome to Valise.</p>
<p>Click the link below to verify your email address:</p>
<p>You must also enter the password you chose at signup. If you did not sign up, ignore this email.</p>
<p><a href="${link}">${link}</a></p>
<p>This link is valid for 7 days.</p>`,
  });
  if (error) {
    console.error("Failed to send verification email:", error);
    throw new Error("Failed to send verification email.");
  }
}

/** 128-bit random token, base64url, no padding. */
export function verificationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

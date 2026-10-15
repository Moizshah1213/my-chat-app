import { config } from './config.js';

/**
 * Transactional email (blueprint §3: Resend / Postmark / SES).
 *
 * EMAIL_PROVIDER selects the transport:
 *   - "console" (default, dev): logs the message — the dev stand-in that the
 *     Phase 1 tests already capture tokens from.
 *   - "resend": posts to the Resend REST API using RESEND_API_KEY (no extra
 *     dependency; a single fetch). Falls back to console when the key is unset.
 *
 * Failures never throw into the request path — a mail outage must not fail a
 * signup/login; the error is logged instead.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Dev-only console marker (e.g. "[email:verify]") — tests capture tokens
   *  from this line; ignored by the Resend transport. */
  devMarker?: string;
  /** Dev-only raw token appended after "-> " on the console line. */
  devToken?: string;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const provider = (process.env.EMAIL_PROVIDER ?? 'console').toLowerCase();
  const from = process.env.EMAIL_FROM ?? config.emailFrom;

  if (provider === 'resend' && process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
      });
      if (!res.ok) {
        console.error(`[email] resend failed (${res.status}): ${await res.text()}`);
      }
      return;
    } catch (err) {
      console.error('[email] resend request failed', err);
      return;
    }
  }

  // Console dev stand-in. Token emails keep the "<marker> <to> -> <token>"
  // shape the test suite parses.
  if (msg.devMarker && msg.devToken) {
    console.log(`${msg.devMarker} ${msg.to} -> ${msg.devToken}`);
  } else {
    console.log(`[email] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
  }
}


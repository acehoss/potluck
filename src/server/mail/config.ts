/**
 * Mail transport configuration, mirroring `vapidConfig()` in
 * `src/server/push.ts`: read the environment at runtime, return null when the
 * SMTP transport is not configured, and let every consumer branch on that null
 * rather than sprinkling env reads around. Nothing here reaches out to SMTP —
 * that is the delivery primitive's job in `./index.ts`.
 *
 * The DreamHost mailbox creds (EMAIL_*) live only in the gitignored `.env` and
 * are threaded through compose; this module never logs their values.
 */

export type MailConfig = {
  from: string;
  smtp: {
    host: string;
    port: number;
    /** STARTTLS on 587: nodemailer secure:false + requireTLS:true. */
    secure: boolean;
    auth: { user: string; pass: string };
  };
};

/**
 * The runtime SMTP config, or null when mail is not configured. Requires the
 * full set of EMAIL_* transport vars — a partial config disables live send
 * rather than half-wiring it (fail-closed, like the VAPID null pattern).
 */
export function mailConfig(): MailConfig | null {
  const from = process.env.EMAIL_FROM;
  const host = process.env.EMAIL_SMTP_SERVER;
  const portRaw = process.env.EMAIL_SMTP_PORT;
  const user = process.env.EMAIL_USERNAME;
  const pass = process.env.EMAIL_PASSWORD;
  if (!from || !host || !portRaw || !user || !pass) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) return null;
  return {
    from,
    smtp: {
      host,
      port,
      // STARTTLS (587) is secure:false + requireTLS; implicit TLS (465) is
      // secure:true. Everything else falls back to STARTTLS semantics.
      secure: port === 465,
      auth: { user, pass },
    },
  };
}

/**
 * Whether the app actually hands messages to SMTP ('live') or only records
 * them in the CapturedEmail audit table ('capture'). Defaults to 'capture' so
 * an un-threaded stack never surprises real inboxes; the boot guard in
 * docker-entrypoint.sh enforces the dangerous combinations.
 */
export function mailMode(): 'capture' | 'live' {
  return process.env.MAIL_MODE === 'live' ? 'live' : 'capture';
}

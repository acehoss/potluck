/**
 * The dev mail filter: a pure, dependency-free function (modelled on
 * `isAllowedPushEndpoint` in `src/server/push-endpoint.ts`) that decides
 * whether one outgoing message may actually be delivered on a non-production
 * stack, and to whom. It is the one thing standing between a seeded/dev
 * deployment and a real stranger's inbox, so every branch fails CLOSED — when
 * in doubt, capture and do not send.
 *
 * It never touches SMTP, prefs, or the database; it just computes the delivery
 * recipients and header/subject rewrites from its inputs. The delivery
 * primitive in `./index.ts` acts on the result.
 */

export type ResolveInput = {
  /** The intended recipient address. */
  to: string;
  /** The message subject (rewritten in the result on dev stacks). */
  subject: string;
  /** Regex sources; the recipient matching ANY is delivered as-is in dev. */
  allowlist: string[];
  /** Addresses non-allowlisted mail is redirected to in dev. Empty = none. */
  redirect: string[];
  /** Prepended to the subject in dev (never in production). */
  subjectPrefix: string;
  /** True on a real production stack: deliver to `to` untouched. */
  production: boolean;
};

export type ResolveResult = {
  /** The addresses SMTP should actually be handed (empty when captureOnly). */
  deliverTo: string[];
  /** True = record the CapturedEmail row but do NOT send. */
  captureOnly: boolean;
  /** The possibly-prefixed subject. */
  subject: string;
  /** The original intended recipient for the X-Original-To header, or null. */
  xOriginalTo: string | null;
};

/** Compile one regex source, treating a parse failure as "never matches". */
function safeMatch(source: string, value: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch {
    // A malformed allowlist entry must not open the gate, and must not throw
    // out of the filter — treat it as non-matching (fail toward not-delivering).
    return false;
  }
  return re.test(value);
}

/**
 * Decide delivery for one outgoing message. See the module doc for the
 * fail-closed contract; the rules, in order:
 *
 *  - production → deliver to `to` verbatim, no prefix, no redirect.
 *  - dev, `to` matches an allowlist regex → delivered as-is (prefix applied).
 *  - dev, `to` does not match, redirect non-empty → redirected (original
 *    recorded in X-Original-To).
 *  - dev, `to` does not match, redirect empty → captureOnly.
 *  - allowlist empty AND redirect empty → captureOnly.
 */
export function resolveRecipients(input: ResolveInput): ResolveResult {
  const { to, allowlist, redirect, subjectPrefix, production } = input;

  if (production) {
    return { deliverTo: [to], captureOnly: false, subject: input.subject, xOriginalTo: null };
  }

  const subject = subjectPrefix + input.subject;
  const allowed = allowlist.some((src) => safeMatch(src, to));

  if (allowed) {
    return { deliverTo: [to], captureOnly: false, subject, xOriginalTo: null };
  }

  // Non-allowlisted: redirect if we have somewhere to send it, else capture.
  if (redirect.length > 0) {
    return { deliverTo: [...redirect], captureOnly: false, subject, xOriginalTo: to };
  }

  return { deliverTo: [], captureOnly: true, subject, xOriginalTo: to };
}

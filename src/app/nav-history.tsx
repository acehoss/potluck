'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * History-aware back navigation (Round Q6). Hardcoded back hrefs lie when a page
 * is reachable from several places (e.g. Items opens from Home AND a deep link).
 * Instead we keep a tiny in-app nav stack in `sessionStorage` and let a page's
 * BackLink go `router.back()` when there IS an in-app previous page, or fall
 * back to a sensible parent when the tab was opened cold on a deep link.
 *
 * No server involvement; the stack lives per-tab and is empty on a fresh load.
 */

const KEY = 'potluck-nav';
const CAP = 50;

function readStack(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function writeStack(stack: string[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stack));
  } catch {
    // Private mode / quota — degrade to fallback-only back navigation.
  }
}

/**
 * Mounted once in the root layout (renders nothing). Records each pathname the
 * tab visits, skipping consecutive duplicates and capping the stack length so a
 * long session can't grow it without bound.
 */
export function NavTracker() {
  const pathname = usePathname();
  useEffect(() => {
    const stack = readStack();
    if (stack[stack.length - 1] === pathname) return;
    stack.push(pathname);
    if (stack.length > CAP) stack.splice(0, stack.length - CAP);
    writeStack(stack);
  }, [pathname]);
  return null;
}

/**
 * The standard `←` header control. If the tab has an in-app previous page it
 * pops the stack and calls `router.back()` (returning where the user actually
 * came from); on a cold deep link it pushes `fallback` instead. `href` is set
 * to the fallback so middle-click / open-in-new-tab still lands somewhere sane.
 */
export function BackLink({ fallback, label }: { fallback: string; label?: string }) {
  const router = useRouter();
  return (
    <Link
      href={fallback}
      data-testid="back-link"
      aria-label={label ?? 'Back'}
      onClick={(e) => {
        e.preventDefault();
        const stack = readStack();
        if (stack.length > 1) {
          stack.pop();
          writeStack(stack);
          router.back();
        } else {
          router.push(fallback);
        }
      }}
      className="shrink-0 text-lg text-text-muted"
    >
      ←
    </Link>
  );
}

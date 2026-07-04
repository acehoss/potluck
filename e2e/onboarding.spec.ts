import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { login, PASSWORD } from './helpers';

/**
 * Round 1 slice 4 acceptance — onboarding + instance admin (REWORK A1/A3/A4/D2):
 *
 *  - A household invite founds a NEW household whose first connection edge is
 *    the inviter's (anonymous acceptance: account + household + ACTIVE edge in
 *    one step).
 *  - A signed-in user accepts a member invite into a SECOND household
 *    (multi-membership onboarding) and the acting household switches.
 *  - The instance-admin surface: /admin usage view, the growth toggle gating
 *    who may mint household invites, and non-admin redirects.
 *
 * Accepted household invites create REAL households in the shared DB, so
 * every test-created household uses the 'casa-' slug prefix and a container-
 * seam sweep removes them (pre-clean AND finally) — leftovers would grow
 * Aaron's /more card count and break slice1's scoped assertions on rerun.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);

function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

/**
 * Sweep every casa-* household this spec ever created (any run). Every table
 * that FKs Household(id) must be cleared before the household row — pantries,
 * invites, restocks, items, products, orders, memberships, connections — or
 * SQLite's FK constraint (better-sqlite3 enforces it) blocks the delete. This
 * is test teardown reaching around the product's append-only guards, not an
 * app flow. Also removes the casa users and any invite THEY minted (which
 * points back at their now-deleted household).
 */
const sweep = `
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_URL.replace(/^file:/, ''));
  const users = db.prepare("SELECT id FROM User WHERE email LIKE '%@casa.test'").all().map(r => r.id);
  const hhs = db.prepare("SELECT id FROM Household WHERE slug LIKE 'casa%'").all().map(r => r.id);
  // Invites minted BY casa users (any household) and invites INTO casa households.
  for (const uid of users) db.prepare("DELETE FROM Invite WHERE createdById = ?").run(uid);
  for (const id of hhs) {
    db.prepare("DELETE FROM OrderLine WHERE orderId IN (SELECT id FROM \\"Order\\" WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM \\"Order\\" WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Invite WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Lot WHERE restockId IN (SELECT r.id FROM Restock r JOIN Pantry p ON p.id = r.pantryId WHERE p.householdId = ?)").run(id);
    db.prepare("DELETE FROM Restock WHERE purchaserHouseholdId = ? OR pantryId IN (SELECT id FROM Pantry WHERE householdId = ?)").run(id, id);
    db.prepare("DELETE FROM Product WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Item WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Pantry WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Membership WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM LedgerSeen WHERE counterpartyHouseholdId = ? OR ownHouseholdId = ?").run(id, id);
    db.prepare("DELETE FROM LedgerEntry WHERE creditorHouseholdId = ? OR debtorHouseholdId = ?").run(id, id);
    db.prepare("DELETE FROM Connection WHERE householdAId = ? OR householdBId = ?").run(id, id);
    // Founded households get the three preset circles (REWORK P4); a Connection
    // references them, so drop scopes + circles after the connection, before the
    // household (Circle FKs Household with no cascade).
    db.prepare("DELETE FROM PantryCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM ItemCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM MembershipCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = ?)").run(id);
    db.prepare("DELETE FROM Circle WHERE householdId = ?").run(id);
    db.prepare("DELETE FROM Household WHERE id = ?").run(id);
  }
  for (const id of users) {
    db.prepare("DELETE FROM Session WHERE userId = ?").run(id);
    db.prepare("DELETE FROM Membership WHERE userId = ?").run(id);
    db.prepare("DELETE FROM User WHERE id = ?").run(id);
  }
`;

async function rpc(page: Page, path: string, data: Record<string, unknown>) {
  const res = await page.request.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

const FRIEND_GRANTS = {
  pantry: true,
  lending: true,
  recipes: true,
  shareTo: true,
  shareFrom: true,
  reshare: false,
};

test('a household invite founds a new connected household (anonymous acceptance)', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name.slice(0, 4);
  const casa = `Casa-${P}-${RUN}`;
  execInApp(sweep);
  const guestContext = await browser.newContext({ baseURL: BASE });
  try {
    // Aaron mints the invite from the connections card (Friend preset default).
    await login(page, 'aaron');
    await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
    await page.getByTestId('invite-household-open').click();
    await page.getByTestId('invite-household-submit').click();
    const link = (await page.getByTestId('household-invite-url').textContent())!.trim();
    expect(link).toContain('/invite/');

    // A stranger accepts: names their household, registers, lands signed in.
    const guest = await guestContext.newPage();
    await guest.goto(link);
    await expect(guest.getByText('invited you to start your own household')).toBeVisible();
    await guest.getByTestId('invite-household-name').fill(casa);
    await guest.getByLabel('Your name').fill('Cass');
    // Non-exact: the Username <label> wraps a hint span, so the field's
    // accessible name is "Username How you sign in…", not "Username".
    await guest.getByLabel('Username').fill(`cass-${P}-${RUN}`);
    await guest.getByLabel('Email').fill(`cass-${P}-${RUN}@casa.test`);
    await guest.getByLabel('Password').fill(PASSWORD);
    await guest.getByRole('button', { name: 'Start my household' }).click();
    await expect(guest).toHaveURL(/\/$/);
    await expect(guest.getByTestId('tab-bar')).toBeVisible();

    // The first edge exists with Friend grants BOTH ways: the newcomer sees
    // Heise's shared pantry group, and Aaron sees Casa connected.
    await expect(
      guest.getByTestId('pantry-group').filter({ hasText: casa }),
    ).toContainText('your household');
    await expect(guest.getByTestId('pantry-group').filter({ hasText: 'Heise' })).toBeVisible();

    // Founded households start pantry-less — the owner creates the first one.
    await guest.getByTestId('add-pantry').click();
    await guest.getByTestId('add-pantry-name').fill('Casa Shelf');
    await guest.getByTestId('add-pantry-save').click();
    await expect(
      guest.getByTestId('pantry-row').filter({ hasText: 'Casa Shelf' }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByTestId('connection-row').filter({ hasText: casa }),
    ).toContainText('connected');

    // The link is one-shot.
    const again = await guestContext.newPage();
    await again.goto(link);
    await expect(again.getByText('invalid, expired, or already used')).toBeVisible();
  } finally {
    await guestContext.close();
    execInApp(sweep);
  }
});

test('a signed-in user accepts a member invite into a second household and switches', async ({
  page,
  browser,
}, testInfo) => {
  const P = testInfo.project.name.slice(0, 4);
  const casa = `Casa2-${P}-${RUN}`;
  execInApp(sweep);
  const theoContext = await browser.newContext({ baseURL: BASE });
  try {
    // Bootstrap an ephemeral household through the REAL invite flow (Aaron
    // mints; API-accepted for brevity), then its owner mints a member invite.
    await login(page, 'aaron');
    const minted = await rpc(page, 'invite.createHousehold', { grants: FRIEND_GRANTS });
    expect(minted.status).toBe(200);
    const token = (minted.body.result.data.path as string).split('/invite/')[1];
    const guestContext = await browser.newContext({ baseURL: BASE });
    const guest = await guestContext.newPage();
    const accepted = await rpc(guest, 'auth.acceptInvite', {
      token,
      name: 'Cass',
      username: `cass2-${P}-${RUN}`,
      email: `cass2-${P}-${RUN}@casa.test`,
      password: PASSWORD,
      householdName: casa,
    });
    expect(accepted.status).toBe(200);
    const memberInvite = await rpc(guest, 'invite.create', {});
    expect(memberInvite.status).toBe(200);
    const memberPath = memberInvite.body.result.data.path as string;
    await guestContext.close();

    // Theo (existing Heise member) opens it SIGNED IN and joins.
    const theo = await theoContext.newPage();
    await login(theo, 'theo');
    await theo.goto(memberPath);
    await expect(theo.getByText("You're signed in as Theo")).toBeVisible();
    await theo.getByTestId('invite-accept-existing').click();
    await theo.waitForURL(/\/$/);
    // The acting household switched to the new membership…
    await expect(
      theo.getByTestId('pantry-group').filter({ hasText: casa }),
    ).toContainText('your household');
    // …and the switcher now exists (multi-membership) listing both.
    await theo.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
    const switcher = theo.getByTestId('household-switcher');
    await expect(switcher).toContainText('Heise');
    await expect(switcher).toContainText(casa);

    // A second acceptance of a member invite he already holds conflicts.
    const dupInvite = await rpc(theo, 'invite.create', {});
    expect(dupInvite.status).toBe(200);
    const dup = await rpc(theo, 'auth.acceptInviteExisting', {
      token: (dupInvite.body.result.data.path as string).split('/invite/')[1],
    });
    expect(dup.status).toBe(409);
  } finally {
    await theoContext.close();
    execInApp(sweep);
  }
});

test('instance admin: usage view, growth toggle, and non-admin gates', async ({
  page,
  browser,
}) => {
  // Aaron (first user = admin) reaches /admin from More.
  await login(page, 'aaron');
  await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
  await page.getByTestId('admin-link').click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId('admin-usage-row').first()).toBeVisible();
  expect(await page.getByTestId('admin-usage-row').count()).toBeGreaterThanOrEqual(3);

  // Flip the UI toggle and WAIT for the write to commit before probing — the
  // checkbox is optimistic, so the server value lands a beat later.
  const setToggle = async (allow: boolean) => {
    const box = page.getByTestId('admin-allow-household-invites');
    const landed = page.waitForResponse((r) =>
      r.url().includes('/api/trpc/admin.setAllowMemberHouseholdInvites'),
    );
    if (allow) await box.check();
    else await box.uncheck();
    expect((await landed).ok()).toBe(true);
  };

  const danaContext = await browser.newContext({ baseURL: BASE });
  const dana = await danaContext.newPage();
  await login(dana, 'dana');
  try {
    // Toggle OFF: a non-admin manager can no longer mint household invites…
    await setToggle(false);
    await expect(page.getByTestId('admin-allow-household-invites')).not.toBeChecked();
    const denied = await rpc(dana, 'invite.createHousehold', { grants: FRIEND_GRANTS });
    expect(denied.status).toBe(403);
    // …while the admin still can (invites are inert rows; no cleanup needed).
    const adminMint = await rpc(page, 'invite.createHousehold', { grants: FRIEND_GRANTS });
    expect(adminMint.status).toBe(200);

    // Toggle back ON restores members' ability.
    await setToggle(true);
    await expect(page.getByTestId('admin-allow-household-invites')).toBeChecked();
    const allowed = await rpc(dana, 'invite.createHousehold', { grants: FRIEND_GRANTS });
    expect(allowed.status).toBe(200);

    // Non-admins never see the surface: no card, and /admin bounces home.
    // Anchor on the URL before asserting absence — toHaveCount(0) is satisfied
    // by ANY page without the testid, including one still mid-navigation, and
    // the follow-up goto would then race the in-flight nav (webkit loses).
    await dana.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
    await expect(dana).toHaveURL(/\/more$/);
    await expect(dana.getByRole('heading', { name: 'More' })).toBeVisible();
    await expect(dana.getByTestId('admin-link')).toHaveCount(0);
    await dana.goto('/admin');
    await expect(dana).toHaveURL(/\/$/);
    // The toggle itself is admin-only at the API too.
    const flip = await rpc(dana, 'admin.setAllowMemberHouseholdInvites', { allow: false });
    expect(flip.status).toBe(403);
  } finally {
    // Restore the default even if an assertion above failed mid-flight.
    await rpc(page, 'admin.setAllowMemberHouseholdInvites', { allow: true });
    await danaContext.close();
  }
});

test('household-invite minting needs manageConnections', async ({ page }) => {
  await login(page, 'theo'); // TEEN preset
  const denied = await rpc(page, 'invite.createHousehold', { grants: FRIEND_GRANTS });
  expect(denied.status).toBe(403);
});

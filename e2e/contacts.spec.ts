import { execFileSync } from 'node:child_process';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';
import { apiLogin, login, PASSWORD } from './helpers';

/**
 * Phase-2 Round C acceptance — the CONTACT LAYER (REWORK P5). A person's card
 * (User.photoPath/phone/bio) plus a household's pickup logistics
 * (Household.address/pickupNotes) become visible to CONNECTED households. Two
 * rules under test, both proven end to end against the real compose stack:
 *
 *  1. The connection is the GATE (no capability): any ACTIVE-connected household
 *     — even a share-only edge with no pantry/lending/recipes grant — reads the
 *     card + pickup logistics; an UNCONNECTED pair 404s (existence never leaks).
 *  2. Which MEMBERS show is governed by Membership.visibility against the circle
 *     the OWNING household placed the viewer into (P4): ALL always / SELECT only
 *     the listed circles / PRIVATE never. Own-household is unfiltered.
 *
 * The vCard route and contacts.household share ONE resolver, so the file also
 * proves the two never disagree, and that a PENDING request preview leaks names/
 * photos/bios ONLY — never phone/email/address before accept.
 *
 * Seeded topology (prisma/seed.ts — load-bearing for the whole suite):
 *   Heise (aaron admin, marie multi-membership, theo Teen) — In-Laws (dana) —
 *   Neighbors (nia). Heise↔In-Laws Family (full), Heise↔Neighbors Neighbors
 *   (share-only), In-Laws↔Neighbors UNCONNECTED. Contact fixtures: every user
 *   has phone 555-01xx + bio; every household an address + pickup notes.
 *
 * RESTORE-INVARIANT: workers:1 shares one accumulating DB and later files assert
 * this exact topology + fixture values, so EVERY profile / visibility / contact
 * mutation on a seeded user or household is read-before-write and restored to its
 * exact prior value in a finally. The one ephemeral household (request-preview)
 * is created and swept through the container seam (connections.spec's pattern).
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now().toString(36);
const uniq = (name: string, project: string) => `${name} ${project}-${RUN}`;

/** Seeded fixture values this file asserts against (prisma/seed.ts). */
const SEED = {
  heise: { addressPart: '742 Evergreen Terrace', pickupPart: 'Side door' },
  inlaws: { addressPart: '18 Oakhurst Lane', addressFull: '18 Oakhurst Lane\nShelbyville', pickupPart: 'Ring the bell twice' },
  aaron: { email: 'aaron@demo.coop', phone: '555-0142' },
  marie: { email: 'marie@demo.coop' },
  theo: { email: 'theo@demo.coop', phone: '555-0144' },
  dana: { email: 'dana@demo.coop', phone: '555-0188', bio: 'Gardener with a chest freezer full of surplus.' },
  nia: { email: 'nia@demo.coop' },
} as const;

/** Either a Page's request context or a headless apiLogin context. */
type Api = Pick<APIRequestContext, 'get' | 'post'>;

const FRIEND = { pantry: true, lending: true, recipes: true, shareTo: true, shareFrom: true, reshare: false };

/** Run a Node one-liner inside the app container (see connections.spec.ts). */
function execInApp(script: string) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

/** tRPC POST as the api's signed-in user; raw envelope (status + body). */
async function rpc(api: Api, path: string, data: Record<string, unknown>) {
  const res = await api.post(`/api/trpc/${path}`, { data });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** POST and assert 200, returning result.data. */
async function ok(api: Api, path: string, data: Record<string, unknown>) {
  const r = await rpc(api, path, data);
  expect(r.status, `${path} ${JSON.stringify(data)} → ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result.data;
}

/** tRPC GET (query) as the api's signed-in user; raw envelope (status + body). */
async function query(api: Api, path: string, input: Record<string, unknown>) {
  const res = await api.get(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** GET and assert 200, returning result.data. */
async function queryOk(api: Api, path: string, input: Record<string, unknown>) {
  const q = await query(api, path, input);
  expect(q.status, `${path} ${JSON.stringify(input)} → ${JSON.stringify(q.body)}`).toBe(200);
  return q.body.result.data;
}

type ContactMember = {
  membershipId: string;
  userId: string;
  name: string;
  photoPath: string | null;
  phone: string | null;
  email: string;
  bio: string | null;
};
type ContactHousehold = {
  householdName: string;
  slug: string;
  address: string | null;
  pickupNotes: string | null;
  members: ContactMember[];
};

/** The viewer's contact view of a household (own or ACTIVE-connected). */
function contactHousehold(api: Api, householdId: string): Promise<ContactHousehold> {
  return queryOk(api, 'contacts.household', { householdId });
}

/** A member of a contact-household payload by seeded email. */
function byEmail(h: ContactHousehold, email: string): ContactMember | undefined {
  return h.members.find((m) => m.email === email);
}

/** name → id for every household the api's user can see (their own + connections). */
async function householdIds(api: Api): Promise<Map<string, string>> {
  const res = await api.get('/api/trpc/household.overview');
  expect(res.ok()).toBe(true);
  const data = (await res.json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; name: string }[];
  };
  return new Map(data.households.map((h) => [h.name, h.id]));
}

/** The acting household's circle id named `name` (manageConnections-gated). */
async function circleId(api: Api, name: string): Promise<string> {
  const res = await api.get('/api/trpc/circle.list');
  expect(res.ok(), 'circle.list should be reachable to a manager').toBe(true);
  const circles = (await res.json()).result.data.circles as { id: string; name: string }[];
  const found = circles.find((c) => c.name === name);
  if (!found) throw new Error(`no circle named ${name}`);
  return found.id;
}

// ---------------------------------------------------------------------------

test('contact reads ride the connection: connected sees card+logistics, unconnected 404s, own is unfiltered', async () => {
  const aaron = await apiLogin('aaron');
  const nia = await apiLogin('nia');

  const ids = await householdIds(aaron);
  const heiseId = ids.get('Heise')!;
  const inlawsId = ids.get('In-Laws')!;

  // Aaron (Heise, in In-Laws' Family circle) reads In-Laws: pickup logistics +
  // dana's full card (phone/email/bio) come back — the FULL contact grant.
  const inlaws = await contactHousehold(aaron, inlawsId);
  expect(inlaws.address).toContain(SEED.inlaws.addressPart);
  expect(inlaws.pickupNotes).toContain(SEED.inlaws.pickupPart);
  const dana = byEmail(inlaws, SEED.dana.email)!;
  expect(dana, 'dana is visible to Heise over the Family edge').toBeTruthy();
  expect(dana.phone).toBe(SEED.dana.phone);
  expect(dana.email).toBe(SEED.dana.email);
  expect(dana.bio).toBe(SEED.dana.bio);

  // Nia (Neighbors) is NOT connected to In-Laws → 404, and the existence of the
  // household never leaks (same NOT_FOUND a missing id would give).
  expect((await query(nia, 'contacts.household', { householdId: inlawsId })).status).toBe(404);

  // But the SHARE-ONLY Heise↔Neighbors edge still connects: nia reads Heise 200.
  // The connection is the gate — no pantry/recipes grant is needed for contacts,
  // so the card + pickup logistics come through on a bare share-only circle.
  const heiseForNia = await contactHousehold(nia, heiseId);
  expect(heiseForNia.address).toContain(SEED.heise.addressPart);
  expect(heiseForNia.pickupNotes).toContain(SEED.heise.pickupPart);
  expect(byEmail(heiseForNia, SEED.aaron.email), 'nia sees Heise members (default ALL)').toBeTruthy();

  // Own household is returned unfiltered — all three Heise members regardless of
  // any visibility setting.
  const ownHeise = await contactHousehold(aaron, heiseId);
  expect(byEmail(ownHeise, SEED.aaron.email)).toBeTruthy();
  expect(byEmail(ownHeise, SEED.marie.email)).toBeTruthy();
  expect(byEmail(ownHeise, SEED.theo.email)).toBeTruthy();
});

test('member visibility via circles: PRIVATE hides, SELECT scopes; self-serve vs manageHousehold', async () => {
  const aaron = await apiLogin('aaron');
  const dana = await apiLogin('dana'); // In-Laws → Heise Family
  const nia = await apiLogin('nia'); // Neighbors → Heise Neighbors circle
  const theo = await apiLogin('theo'); // Teen: no manageHousehold

  const heiseId = (await householdIds(aaron)).get('Heise')!;
  const heiseFamily = await circleId(aaron, 'Family');

  // Membership ids from Aaron's own (unfiltered) household read.
  const ownHeise = await contactHousehold(aaron, heiseId);
  const aaronMembership = byEmail(ownHeise, SEED.aaron.email)!.membershipId;
  const marieMembership = byEmail(ownHeise, SEED.marie.email)!.membershipId;
  const theoMembership = byEmail(ownHeise, SEED.theo.email)!.membershipId;

  try {
    // Aaron PRIVATE: dana's read of Heise no longer lists aaron, still lists the
    // other two (visibility is per-member, not per-household).
    await ok(aaron, 'membership.setVisibility', { membershipId: aaronMembership, visibility: 'PRIVATE' });
    const danaSees = await contactHousehold(dana, heiseId);
    expect(byEmail(danaSees, SEED.aaron.email), 'aaron PRIVATE → hidden').toBeUndefined();
    expect(byEmail(danaSees, SEED.marie.email), 'marie still visible').toBeTruthy();
    expect(byEmail(danaSees, SEED.theo.email), 'theo still visible').toBeTruthy();

    // Aaron SELECT [Family]: dana (In-Laws sits in Heise's Family) sees him again;
    // nia (Neighbors circle) does not — SELECT is scoped to the listed circle.
    await ok(aaron, 'membership.setVisibility', {
      membershipId: aaronMembership,
      visibility: 'SELECT',
      circleIds: [heiseFamily],
    });
    expect(byEmail(await contactHousehold(dana, heiseId), SEED.aaron.email), 'SELECT[Family]: dana sees').toBeTruthy();
    expect(byEmail(await contactHousehold(nia, heiseId), SEED.aaron.email), 'SELECT[Family]: nia does not').toBeUndefined();

    // Self-serve: Theo (Teen, no manageHousehold) may set HIS OWN visibility.
    expect((await rpc(theo, 'membership.setVisibility', { membershipId: theoMembership, visibility: 'PRIVATE' })).status).toBe(200);
    // But NOT another member's: same household, so it's the capability gate (403),
    // not the cross-household 404.
    expect(
      (await rpc(theo, 'membership.setVisibility', { membershipId: marieMembership, visibility: 'PRIVATE' })).status,
      "theo can't set marie's card → 403 (manageHousehold)",
    ).toBe(403);
  } finally {
    // Exact prior value: seed leaves every membership at the default ALL.
    await rpc(aaron, 'membership.setVisibility', { membershipId: aaronMembership, visibility: 'ALL' });
    await rpc(theo, 'membership.setVisibility', { membershipId: theoMembership, visibility: 'ALL' });
  }
});

test('request preview leaks names/photos/bios only — never phone/email/address; 404s after decline', async () => {
  const HH = 'e2e-creq-hh';
  const UID = 'e2e-creq-user';
  const SLUG = 'e2e-creq';
  const EMAIL = 'creq.e2e@demo.coop';
  const NAME = 'Contact Req (e2e)';
  const BIO = 'Robin here, waves, brings pie'; // commas: proves the preview carries bio verbatim
  const cleanup = `
    const D = require('better-sqlite3');
    const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
    db.prepare("DELETE FROM MembershipCircle WHERE circleId IN (SELECT id FROM Circle WHERE householdId = '${HH}')").run();
    db.prepare("DELETE FROM Connection WHERE householdAId = '${HH}' OR householdBId = '${HH}'").run();
    db.prepare("DELETE FROM Circle WHERE householdId = '${HH}'").run();
    db.prepare("DELETE FROM Session WHERE userId = '${UID}'").run();
    db.prepare("DELETE FROM Membership WHERE userId = '${UID}'").run();
    db.prepare("DELETE FROM User WHERE id = '${UID}'").run();
    db.prepare("DELETE FROM Household WHERE id = '${HH}'").run();
  `;
  execInApp(cleanup); // clear any leak from an interrupted run
  execInApp(`
    const { hashSync } = require('@node-rs/argon2');
    const D = require('better-sqlite3');
    const db = new D(process.env.DATABASE_URL.replace(/^file:/, ''));
    db.prepare("INSERT OR IGNORE INTO Household (id, name, slug) VALUES ('${HH}', '${NAME}', '${SLUG}')").run();
    const hash = hashSync('${PASSWORD}', { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    db.prepare("INSERT OR IGNORE INTO User (id, username, name, email, passwordHash, phone, bio) VALUES ('${UID}', '${UID}', 'Robin', '${EMAIL}', ?, '555-0199', '${BIO}')").run(hash);
    db.prepare("INSERT OR IGNORE INTO Membership (id, userId, householdId, manageHousehold, manageConnections, receiveStock, placeOrders, spend, fulfill, adjustInventory, lendBorrow, postShares, editRecipes, settleMoney) VALUES ('m-${UID}', '${UID}', '${HH}', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)").run();
  `);

  const aaron = await apiLogin('aaron');
  const robin = await apiLogin(EMAIL);
  try {
    // Robin mints a circle of their own and requests Heise by handle.
    const robinCircle = (await ok(robin, 'circle.create', { name: 'Requesters', grants: FRIEND })).id;
    await ok(robin, 'connection.request', { slug: 'heise', circleId: robinCircle });

    // Aaron finds the incoming PENDING edge and previews it.
    const connRes = await aaron.get('/api/trpc/connection.list');
    const conns = (await connRes.json()).result.data.connections as Array<{
      id: string;
      counterparty: { name: string };
      status: string;
      requestedByUs: boolean;
    }>;
    const pending = conns.find((c) => c.counterparty.name === NAME && c.status === 'PENDING' && !c.requestedByUs);
    expect(pending, 'aaron has an incoming pending request from Robin').toBeTruthy();
    const connectionId = pending!.id;

    const preview = await queryOk(aaron, 'contacts.requestPreview', { connectionId });
    expect(preview.householdName).toBe(NAME);
    expect(Array.isArray(preview.members)).toBe(true);
    const robinMember = (preview.members as Array<{ name: string; bio: string | null }>).find((m) => m.name === 'Robin');
    expect(robinMember, 'the requester member is previewed').toBeTruthy();
    expect(robinMember!.bio).toBe(BIO); // bio carries through verbatim, commas and all

    // The payload carries name/photoPath/bio ONLY — no contact details pre-accept.
    for (const m of preview.members as Array<Record<string, unknown>>) {
      expect(Object.keys(m).sort()).toEqual(['bio', 'name', 'photoPath']);
      expect(m).not.toHaveProperty('phone');
      expect(m).not.toHaveProperty('email');
      expect(m).not.toHaveProperty('address');
      expect(m).not.toHaveProperty('userId');
      expect(m).not.toHaveProperty('membershipId');
    }
    // No household address/pickupNotes on the preview envelope either.
    expect(preview).not.toHaveProperty('address');
    expect(preview).not.toHaveProperty('pickupNotes');

    // Decline deletes the edge → the preview 404s (existence gone with it).
    await ok(aaron, 'connection.respond', { connectionId, accept: false });
    expect((await query(aaron, 'contacts.requestPreview', { connectionId })).status).toBe(404);
  } finally {
    execInApp(cleanup);
  }
});

test('vCard route: reach-gated, RFC-escaped, session-required, and private-member 404', async () => {
  const aaron = await apiLogin('aaron');
  const nia = await apiLogin('nia');
  const dana = await apiLogin('dana');

  const inlawsId = (await householdIds(aaron)).get('In-Laws')!;
  const danaId = byEmail(await contactHousehold(aaron, inlawsId), SEED.dana.email)!.userId;

  // Read-before-write so we can restore dana's card exactly.
  const danaProfile = (await (await dana.get('/api/trpc/profile.get')).json()).result.data as {
    bio: string | null;
  };
  const commaBio = 'Beans, jars, and surplus'; // forces RFC 6350 §3.4 comma escaping

  try {
    // Give dana a comma bio so the vCard NOTE must escape.
    await ok(dana, 'profile.update', { bio: commaBio });

    // Aaron (connected) downloads dana's card: a real text/vcard file with the
    // seeded fields, and both the address newline and the bio commas escaped.
    const res = await aaron.get(`/api/vcard/${danaId}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/vcard');
    const body = await res.text();
    expect(body).toContain('FN:Dana');
    expect(body).toContain(`TEL;TYPE=CELL:${SEED.dana.phone}`);
    expect(body).toContain(`EMAIL:${SEED.dana.email}`);
    // ADR street component carries the household address, newline escaped to \n.
    expect(body).toContain('ADR;TYPE=HOME:;;18 Oakhurst Lane\\nShelbyville;;;;');
    // NOTE carries the bio with each comma escaped as \, (never a raw comma).
    expect(body).toContain('NOTE:Beans\\, jars\\, and surplus');

    // Nia is not connected to In-Laws → 404 for dana (existence never leaks).
    expect((await nia.get(`/api/vcard/${danaId}`)).status()).toBe(404);

    // Unauthenticated → 401 (the route session-gates before resolving).
    const anon = await playwrightRequest.newContext({ baseURL: BASE });
    try {
      expect((await anon.get(`/api/vcard/${danaId}`)).status()).toBe(401);
    } finally {
      await anon.dispose();
    }

    // A member dana hides (PRIVATE, self-serve) drops out of the SAME resolver:
    // aaron's card download 404s, matching what contacts.household would show.
    const danaMembership = byEmail(await contactHousehold(aaron, inlawsId), SEED.dana.email)!.membershipId;
    await ok(dana, 'membership.setVisibility', { membershipId: danaMembership, visibility: 'PRIVATE' });
    expect((await aaron.get(`/api/vcard/${danaId}`)).status(), 'PRIVATE member → 404').toBe(404);
  } finally {
    await rpc(dana, 'profile.update', { bio: danaProfile.bio });
    const danaMembership = byEmail(await contactHousehold(dana, inlawsId), SEED.dana.email)?.membershipId;
    if (danaMembership) await rpc(dana, 'membership.setVisibility', { membershipId: danaMembership, visibility: 'ALL' });
  }
});

test('profile update is self-serve (no capability) and holds the fresh-avatar contract', async () => {
  const theo = await apiLogin('theo');
  const dana = await apiLogin('dana');

  const inlawsId = (await householdIds(dana)).get('In-Laws')!;
  const heiseId = (await householdIds(dana)).get('Heise')!;

  // Read-before-write: capture theo's exact card.
  const before = (await (await theo.get('/api/trpc/profile.get')).json()).result.data as {
    phone: string | null;
    bio: string | null;
  };
  const newPhone = `555-07${RUN.slice(-2)}`;
  const newBio = 'Teen fixture — updated by e2e.';

  try {
    // Theo (Teen, NO capability path for profile) updates his own card — it is
    // the person's, not the household's — and it shows up in a connection's read.
    await ok(theo, 'profile.update', { phone: newPhone, bio: newBio });
    const theoAsDanaSees = byEmail(await contactHousehold(dana, heiseId), SEED.theo.email)!;
    expect(theoAsDanaSees.phone).toBe(newPhone);
    expect(theoAsDanaSees.bio).toBe(newBio);

    // Avatar contract: photoPath must be a fresh "avatars" upload; a bogus path
    // 400s (never trust a client string that later drives a file unlink), and
    // the rejected mutation leaves the rest of the card untouched.
    expect((await rpc(theo, 'profile.update', { photoPath: 'not/an/avatar.png' })).status).toBe(400);
    const stillThere = byEmail(await contactHousehold(dana, heiseId), SEED.theo.email)!;
    expect(stillThere.phone, 'the 400 rolled back — phone unchanged').toBe(newPhone);

    // (In-Laws id fetched above only to prove the read helper resolves both.)
    expect(inlawsId).toBeTruthy();
  } finally {
    await rpc(theo, 'profile.update', { phone: before.phone, bio: before.bio });
  }
});

test('household.updateContact is manageHousehold-gated; owner edit round-trips and restores', async () => {
  const aaron = await apiLogin('aaron');
  const theo = await apiLogin('theo'); // Teen: no manageHousehold

  const heiseId = (await householdIds(aaron)).get('Heise')!;
  // Read-before-write: capture Heise's exact pickup logistics.
  const before = await contactHousehold(aaron, heiseId);

  const newAddress = 'e2e address\nline two';
  const newNotes = 'e2e pickup notes';
  try {
    // Theo lacks manageHousehold → 403 (capability, not visibility).
    expect((await rpc(theo, 'household.updateContact', { address: newAddress, pickupNotes: newNotes })).status).toBe(403);

    // Aaron (Owner) edits, and the change round-trips through the contact read.
    await ok(aaron, 'household.updateContact', { address: newAddress, pickupNotes: newNotes });
    const after = await contactHousehold(aaron, heiseId);
    expect(after.address).toBe(newAddress);
    expect(after.pickupNotes).toBe(newNotes);
  } finally {
    // Restore the seeded address/pickup notes exactly.
    await rpc(aaron, 'household.updateContact', {
      address: before.address,
      pickupNotes: before.pickupNotes,
    });
  }
});

// ---------------------------------------------------------------------------
// UI smoke (LAST — runs only once contact-ui's surfaces have landed). Held via
// SendMessage coordination; excluded from the API run with
//   --grep-invert "UI smoke"
// until contact-ui confirms the testids below are wired.

/** Receive one 3-unit lot into the signed-in user's own pantry via the API. */
async function receiveLotApi(api: Api, retailer: string) {
  const ov = (await (await api.get('/api/trpc/household.overview')).json()).result.data as {
    yourHouseholdId: string;
    households: { id: string; pantries: { id: string }[] }[];
  };
  const own = ov.households.find((h) => h.id === ov.yourHouseholdId)!;
  const pantryId = own.pantries[0].id;
  const created = await ok(api, 'restock.create', {
    pantryId,
    retailer,
    purchasedAt: new Date().toISOString().slice(0, 10),
    purchaserHouseholdId: ov.yourHouseholdId,
    receiptTotalCents: null,
  });
  await ok(api, 'restock.saveLine', {
    restockId: created.id,
    newProductName: retailer,
    purchasedCount: 3,
    receivedCount: 3,
    lineTotalCents: 300,
    bestBy: null,
  });
  await ok(api, 'restock.finalize', { restockId: created.id, acknowledgedVarianceCents: null });
  const got = await api.get(`/api/trpc/restock.get?input=${encodeURIComponent(JSON.stringify({ id: created.id }))}`);
  const lots = (await got.json()).result.data.lots as { id: string }[];
  return { pantryId, restockId: created.id as string, lotId: lots[0].id };
}

test('UI smoke: profile edit, In-Laws contact card + detail sheet, and READY-order pickup info', async ({
  page,
}, testInfo) => {
  const P = testInfo.project.name;
  const api = page.request; // the browser session's tRPC context
  await login(page, 'aaron');

  // Restore aaron's phone whatever happens.
  const before = (await (await api.get('/api/trpc/profile.get')).json()).result.data as { phone: string | null };
  const dana = await apiLogin('dana');
  let orderId: string | undefined;
  let restockId: string | undefined;

  try {
    // (1) Profile edit from More → the card, its edit sheet, and a saved phone.
    await page.getByTestId('tab-bar').getByRole('link', { name: 'More' }).click();
    await expect(page.getByTestId('profile-card')).toBeVisible();
    await page.getByTestId('profile-edit').click();
    await expect(page.getByTestId('profile-sheet')).toBeVisible();
    await page.getByTestId('profile-phone').fill('555-0100');
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-sheet')).toBeHidden();
    await expect
      .poll(async () => (await (await api.get('/api/trpc/profile.get')).json()).result.data.phone)
      .toBe('555-0100');

    // (2) In-Laws contact page (read-only): pickup logistics FIRST — the contact
    //     card with address, map link, and pickup notes — then dana's member card
    //     → detail sheet with the big tel:/sms:/email rows and the "Save contact"
    //     vCard link. (The same testids appear on /more as the OWN-household
    //     EDITOR; these live on a different page, so no strict-mode collision.)
    const inlawsId = (await householdIds(api)).get('In-Laws')!;
    await page.goto(`/households/${inlawsId}`);
    await expect(page.getByTestId('contact-page')).toBeVisible();
    await expect(page.getByTestId('household-contact-card')).toBeVisible();
    await expect(page.getByTestId('household-address')).toContainText(SEED.inlaws.addressPart);
    await expect(page.getByTestId('household-map-link')).toBeVisible();
    await expect(page.getByTestId('household-pickup-notes')).toContainText(SEED.inlaws.pickupPart);

    const danaCard = page.getByTestId('member-card').filter({ hasText: 'Dana' });
    await danaCard.click();
    const sheet = page.getByTestId('member-detail-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('member-phone')).toBeVisible();
    await expect(sheet.getByTestId('member-sms')).toBeVisible();
    await expect(sheet.getByTestId('member-email')).toBeVisible();
    await expect(sheet.getByTestId('member-vcard')).toBeVisible();

    // (3) READY-order pickup info for a buyer: build a minimal order aaron places
    //     against a fresh In-Laws lot, dana readies it, and aaron's order page
    //     surfaces the pickup address.
    const { pantryId, lotId, restockId: rid } = await receiveLotApi(dana, uniq('Pickup Beans', P));
    restockId = rid;
    const cart = await ok(api, 'order.addToCart', { pantryId, lotId, quantity: 1 });
    orderId = cart.orderId as string;
    await ok(api, 'order.submit', { orderId });
    await ok(dana, 'order.startPicking', { orderId });
    await ok(dana, 'order.markReady', { orderId });

    await page.goto(`/orders/${orderId}`);
    await expect(page.getByTestId('order-pickup-info')).toBeVisible();
    await expect(page.getByTestId('order-pickup-info')).toContainText(SEED.inlaws.addressPart);
  } finally {
    await rpc(api, 'profile.update', { phone: before.phone });
    // A READY order can't cancel (guard is DRAFT/REQUESTED) — SQL-drop the order
    // (cascades OrderLine, releasing the hold) and the ephemeral restock (cascades
    // its lots), so no money posts and no seeded inventory is touched.
    const parts: string[] = [];
    if (orderId) parts.push(`db.prepare("DELETE FROM \\"Order\\" WHERE id='${orderId}'").run();`);
    if (restockId) parts.push(`db.prepare("DELETE FROM Restock WHERE id='${restockId}'").run();`);
    if (parts.length) {
      execInApp(
        `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_URL.replace(/^file:/,''));` +
          parts.join(''),
      );
    }
  }
});

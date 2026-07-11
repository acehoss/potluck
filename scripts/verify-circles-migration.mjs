/**
 * Proof harness for the 20260704150000_circles migration (docs/archive/mutual-aid-rework-2026-07.md P4).
 *
 * Builds a synthetic pre-circles world with the pathological cases the
 * data-preserving migration must survive — distinct grant tuples, two
 * connections sharing one tuple, all-false ACTIVE/SEVERED sides, an all-false
 * PENDING addressee, counterparty names that collide with preset circle names,
 * and a household with zero connections — applies the EXACT migration SQL, then
 * asserts behavior-equivalence: every connection side's assigned circle grants
 * exactly what its old per-side grant tuple granted (NULL means all-false on a
 * PENDING addressee), presets are seeded, names stay unique, and pantry/item
 * shared maps to ALL/PRIVATE.
 *
 * Run: node scripts/verify-circles-migration.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, '../prisma/migrations/20260704150000_circles/migration.sql');

const GRANTS = ['Pantry', 'Lending', 'Recipes', 'ShareTo', 'ShareFrom', 'Reshare'];
const tuple = (p, l, r, st, sf, rs) => ({ Pantry: p, Lending: l, Recipes: r, ShareTo: st, ShareFrom: sf, Reshare: rs });
const NONE = tuple(0, 0, 0, 0, 0, 0);
const FAMILY = tuple(1, 1, 1, 1, 1, 1);
const FRIENDS = tuple(1, 1, 1, 1, 1, 0);
const NEIGHBORS = tuple(0, 0, 0, 1, 1, 0);
const PANTRY_ONLY = tuple(1, 0, 0, 0, 0, 0);
const LENDING_ONLY = tuple(0, 1, 0, 0, 0, 0);

// Households — hC is literally named "Family" to collide with a preset name.
const households = [
  { id: 'hA', name: 'Alpha' },
  { id: 'hB', name: 'Beta' },
  { id: 'hC', name: 'Family' },
  { id: 'hD', name: 'Delta' },
  { id: 'hE', name: 'Echo' }, // zero connections
];

// Connections: [id, A, B, status, aTuple, bTuple]. Ids ordered so c2 < c3 (the
// shared-tuple pair) makes hC the representative counterparty → preset collision.
const connections = [
  ['c1', 'hA', 'hB', 'ACTIVE', FAMILY, NEIGHBORS],
  ['c2', 'hA', 'hC', 'ACTIVE', PANTRY_ONLY, FAMILY], // hA custom pantry-only; rep counterparty "Family"
  ['c3', 'hA', 'hD', 'ACTIVE', PANTRY_ONLY, FRIENDS], // same hA tuple as c2 → one shared circle
  ['c4', 'hB', 'hC', 'PENDING', LENDING_ONLY, NONE], // requester hB granted; addressee hC all-false → NULL
  ['c5', 'hB', 'hD', 'SEVERED', NONE, NEIGHBORS], // all-false SEVERED → "No access" circle
  ['c6', 'hC', 'hD', 'ACTIVE', NONE, FAMILY], // all-false ACTIVE → "No access" circle
];

function build(db) {
  db.exec(`
    CREATE TABLE "Household" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "Membership" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "householdId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "Connection" (
      "id" TEXT PRIMARY KEY, "householdAId" TEXT NOT NULL, "householdBId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING', "requestedByHouseholdId" TEXT,
      "aGrantsPantry" BOOLEAN NOT NULL DEFAULT false, "aGrantsLending" BOOLEAN NOT NULL DEFAULT false,
      "aGrantsRecipes" BOOLEAN NOT NULL DEFAULT false, "aGrantsShareTo" BOOLEAN NOT NULL DEFAULT false,
      "aGrantsShareFrom" BOOLEAN NOT NULL DEFAULT false, "aGrantsReshare" BOOLEAN NOT NULL DEFAULT false,
      "bGrantsPantry" BOOLEAN NOT NULL DEFAULT false, "bGrantsLending" BOOLEAN NOT NULL DEFAULT false,
      "bGrantsRecipes" BOOLEAN NOT NULL DEFAULT false, "bGrantsShareTo" BOOLEAN NOT NULL DEFAULT false,
      "bGrantsShareFrom" BOOLEAN NOT NULL DEFAULT false, "bGrantsReshare" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "activatedAt" DATETIME, "severedAt" DATETIME
    );
    CREATE TABLE "Pantry" ("id" TEXT PRIMARY KEY, "householdId" TEXT NOT NULL, "name" TEXT NOT NULL, "shared" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "Item" ("id" TEXT PRIMARY KEY, "clientKey" TEXT, "householdId" TEXT NOT NULL, "name" TEXT NOT NULL, "photoPath" TEXT, "notes" TEXT, "feeCents" INTEGER NOT NULL DEFAULT 0, "shared" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  const hh = db.prepare('INSERT INTO "Household" ("id","name","slug") VALUES (?,?,?)');
  for (const h of households) hh.run(h.id, h.name, h.id);
  db.prepare('INSERT INTO "Membership" ("id","userId","householdId") VALUES (?,?,?)').run('m1', 'u1', 'hA');
  const cols = [];
  for (const s of ['a', 'b']) for (const g of GRANTS) cols.push(`${s}Grants${g}`);
  const ins = db.prepare(
    `INSERT INTO "Connection" ("id","householdAId","householdBId","status","requestedByHouseholdId",${cols
      .map((c) => `"${c}"`)
      .join(',')}) VALUES (?,?,?,?,?,${cols.map(() => '?').join(',')})`,
  );
  for (const [id, a, b, status, at, bt] of connections) {
    const vals = GRANTS.map((g) => at[g]).concat(GRANTS.map((g) => bt[g]));
    ins.run(id, a, b, status, status === 'PENDING' ? a : null, ...vals);
  }
  // Pantries / items: one shared, one private each on hA / hB.
  db.prepare('INSERT INTO "Pantry" ("id","householdId","name","shared") VALUES (?,?,?,?)').run('pS', 'hA', 'Shared', 1);
  db.prepare('INSERT INTO "Pantry" ("id","householdId","name","shared") VALUES (?,?,?,?)').run('pP', 'hB', 'Private', 0);
  db.prepare('INSERT INTO "Item" ("id","householdId","name","shared") VALUES (?,?,?,?)').run('iS', 'hA', 'Shared', 1);
  db.prepare('INSERT INTO "Item" ("id","householdId","name","shared") VALUES (?,?,?,?)').run('iP', 'hB', 'Private', 0);
}

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
};

function circleTuple(db, circleId) {
  if (circleId == null) return null;
  const c = db.prepare('SELECT * FROM "Circle" WHERE "id"=?').get(circleId);
  return tuple(c.grantsPantry, c.grantsLending, c.grantsRecipes, c.grantsShareTo, c.grantsShareFrom, c.grantsReshare);
}
const sameTuple = (x, y) => GRANTS.every((g) => !!x[g] === !!y[g]);
const isAllFalse = (t) => GRANTS.every((g) => !t[g]);

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
build(db);
db.exec(readFileSync(MIGRATION, 'utf8'));

console.log('\nBehavior-equivalence (each side\'s circle grants == old tuple):');
for (const [id, a, b, status, at, bt] of connections) {
  const row = db.prepare('SELECT "aCircleId","bCircleId" FROM "Connection" WHERE "id"=?').get(id);
  for (const [side, owner, orig, circleId] of [
    ['a', a, at, row.aCircleId],
    ['b', b, bt, row.bCircleId],
  ]) {
    if (circleId == null) {
      ok(status === 'PENDING' && isAllFalse(orig), `${id}.${side} (${owner}) NULL ⇔ all-false PENDING addressee`);
    } else {
      const circle = db.prepare('SELECT "householdId" FROM "Circle" WHERE "id"=?').get(circleId);
      const equiv = sameTuple(circleTuple(db, circleId), orig);
      ok(equiv && circle.householdId === owner, `${id}.${side} (${owner}) → own circle granting exactly its old tuple`);
    }
  }
}

console.log('\nStructural invariants:');
for (const h of households) {
  const presets = db
    .prepare("SELECT name FROM \"Circle\" WHERE \"householdId\"=? AND name IN ('Neighbors','Friends','Family')")
    .all(h.id);
  ok(presets.length === 3, `${h.name} (${h.id}) has all three preset circles`);
  const names = db.prepare('SELECT name FROM "Circle" WHERE "householdId"=?').all(h.id).map((r) => r.name);
  ok(new Set(names).size === names.length, `${h.name} circle names are unique (${names.length} circles)`);
}
ok(db.prepare('SELECT COUNT(*) n FROM "Circle" WHERE "householdId"=?').get('hE').n === 3, 'Echo (zero connections) has exactly the 3 presets, no customs');

console.log('\nActive edges keep both sides non-null:');
for (const [id] of connections.filter((c) => c[3] === 'ACTIVE')) {
  const row = db.prepare('SELECT "aCircleId","bCircleId" FROM "Connection" WHERE "id"=?').get(id);
  ok(row.aCircleId != null && row.bCircleId != null, `${id} ACTIVE ⇒ both circle sides assigned`);
}
const c4 = db.prepare('SELECT "bCircleId" FROM "Connection" WHERE "id"=?').get('c4');
ok(c4.bCircleId == null, 'c4 PENDING addressee (all-false) left unassigned (NULL)');

console.log('\nPreset-name collision + shared-tuple reuse:');
const hAcustom = db
  .prepare("SELECT name FROM \"Circle\" WHERE \"householdId\"='hA' AND \"grantsPantry\"=1 AND \"grantsLending\"=0 AND \"grantsRecipes\"=0 AND \"grantsShareTo\"=0")
  .all();
ok(hAcustom.length === 1, 'Alpha has ONE pantry-only custom circle shared by c2 & c3');
ok(hAcustom[0] && hAcustom[0].name !== 'Family', `Alpha's custom named after "Family" household was suffixed to avoid the preset clash (got "${hAcustom[0]?.name}")`);
const c2a = db.prepare('SELECT "aCircleId" FROM "Connection" WHERE "id"=?').get('c2').aCircleId;
const c3a = db.prepare('SELECT "aCircleId" FROM "Connection" WHERE "id"=?').get('c3').aCircleId;
ok(c2a === c3a, 'c2.a and c3.a resolve to the SAME shared custom circle');

console.log('\n"No access" circles for all-false ACTIVE/SEVERED:');
for (const [id, owner, side] of [['c5', 'hB', 'a'], ['c6', 'hC', 'a']]) {
  const circleId = db.prepare(`SELECT "${side}CircleId" AS c FROM "Connection" WHERE "id"=?`).get(id).c;
  const t = circleTuple(db, circleId);
  ok(circleId != null && isAllFalse(t), `${id}.${side} (${owner}) → a real (non-null) all-false "No access" circle`);
}

console.log('\nPantry / Item visibility mapping:');
ok(db.prepare('SELECT "visibility" v FROM "Pantry" WHERE "id"=?').get('pS').v === 'ALL', 'shared pantry → visibility ALL');
ok(db.prepare('SELECT "visibility" v FROM "Pantry" WHERE "id"=?').get('pP').v === 'PRIVATE', 'private pantry → visibility PRIVATE');
ok(db.prepare('SELECT "visibility" v FROM "Item" WHERE "id"=?').get('iS').v === 'ALL', 'shared item → visibility ALL');
ok(db.prepare('SELECT "visibility" v FROM "Item" WHERE "id"=?').get('iP').v === 'PRIVATE', 'private item → visibility PRIVATE');
ok(db.prepare('SELECT "visibility" v FROM "Membership" WHERE "id"=?').get('m1').v === 'ALL', 'membership visibility defaults ALL');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
db.close();
process.exit(failures === 0 ? 0 : 1);

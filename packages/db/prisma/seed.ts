/**
 * SEED SCRIPT — Initial data only.
 *
 * ⚠️  SAFETY: This script is NEVER run automatically.
 *     It requires SEED_CONFIRM=yes to execute against production.
 *     It uses upsert (insert-or-skip) so it cannot overwrite existing records.
 *     It checks for existing child records before creating them.
 *
 * Usage:
 *   Local:      npm run db:seed
 *   Production: SEED_CONFIRM=yes DATABASE_URL=... npx tsx prisma/seed.ts
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  // ── Production guard ──────────────────────────────────────
  const isProduction =
    process.env.NODE_ENV === "production" ||
    (process.env.DATABASE_URL || "").includes("railway");

  if (isProduction && process.env.SEED_CONFIRM !== "yes") {
    console.error(
      "🛑  Refusing to seed a production database.\n" +
      "    Set SEED_CONFIRM=yes if you really mean it.\n" +
      "    This is a safety check — seeds should almost never run in prod."
    );
    process.exit(1);
  }

  console.log("Seeding database...");

  // Michael (Queen)
  const michael = await db.user.upsert({
    where: { email: "thom.mr@gmail.com" },
    update: {},
    create: {
      email: "thom.mr@gmail.com",
      name: "Michael Thom",
      role: "queen",
      status: "active",
      passwordHash: await bcrypt.hash("changeme123", 12),
    },
  });

  // Apiary
  const apiary = await db.apiary.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Rowayton Apiary",
      address: "364 Rowayton Ave, Norwalk, CT 06853",
      latitude: 41.0634,
      longitude: -73.4468,
    },
  });

  // Hive 1 & 2
  const hiveData = [
    { id: "00000000-0000-0000-0000-000000000010", name: "Hive 1" },
    { id: "00000000-0000-0000-0000-000000000020", name: "Hive 2" },
  ];

  for (const hd of hiveData) {
    const hive = await db.hive.upsert({
      where: { id: hd.id },
      update: {},
      create: {
        id: hd.id,
        apiaryId: apiary.id,
        name: hd.name,
        breed: "Buckfast",
        source: "Mann Lake",
        installDate: new Date("2026-04-18"),
        status: "active",
      },
    });

    // Check if hive already has components (don't overwrite user edits)
    const existingCount = await db.hiveComponent.count({ where: { hiveId: hive.id } });
    if (existingCount > 0) {
      console.log(`  ${hd.name}: ${existingCount} components already exist, skipping`);
      continue;
    }

    // Default component stack — correct physical order bottom to top:
    // bottom-board(0) → entrance-reducer(1) → brood-box(2) → top-feeder(3) → inner-cover(4) → outer-cover(5)
    const components = [
      { type: "bottom-board", position: 0, frameCount: null },
      { type: "entrance-reducer", position: 1, frameCount: null },
      { type: "brood-box", position: 2, frameCount: 10 },
      { type: "top-feeder", position: 3, frameCount: null },
      { type: "inner-cover", position: 4, frameCount: null },
      { type: "outer-cover", position: 5, frameCount: null },
    ];

    for (const comp of components) {
      const created = await db.hiveComponent.create({
        data: { hiveId: hive.id, ...comp },
      });

      // Create frames for brood boxes
      if (comp.frameCount) {
        for (let i = 1; i <= comp.frameCount; i++) {
          await db.frame.create({
            data: { componentId: created.id, position: i },
          });
        }
      }
    }
    console.log(`  ${hd.name}: created ${components.length} components`);
  }

  // Mann Lake Order #816651 — Bees
  await db.financialTransaction.upsert({
    where: { id: "00000000-0000-0000-0000-000000000100" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000100",
      date: new Date("2026-01-15"),
      type: "expense",
      category: "Bees",
      vendor: "Mann Lake",
      description: "2x Buckfast bee packages",
      orderRef: "#816651",
      total: 425.29,
      tax: 0,
      lineItems: {
        create: [
          { description: "Buckfast Italian Bee Package (3 lb)", qty: 2, unitPrice: 212.65, amount: 425.29 },
        ],
      },
    },
  });

  // Mann Lake Order #823823 — Equipment
  await db.financialTransaction.upsert({
    where: { id: "00000000-0000-0000-0000-000000000101" },
    update: {},
    create: {
      id: "00000000-0000-0000-0000-000000000101",
      date: new Date("2026-03-10"),
      type: "expense",
      category: "Equipment",
      vendor: "Mann Lake",
      description: "Hive equipment — frames, suit, gloves, feeder, covers, entrance reducers",
      orderRef: "#823823",
      subtotal: 499.43,
      tax: 31.08,
      total: 530.51,
      lineItems: {
        create: [
          { description: '9 1/8" Black Frames (case/20)', qty: 2, sku: "WW895", unitPrice: 73.99, amount: 147.98 },
          { description: "Vented Beekeeping Suit (L)", qty: 1, sku: "VS311", unitPrice: 194.99, amount: 194.99 },
          { description: "Goatskin Gloves (L)", qty: 1, sku: "GL110", unitPrice: 24.99, amount: 24.99 },
          { description: "10-Frame Top Feeder", qty: 2, sku: "FD320", unitPrice: 22.99, amount: 45.98 },
          { description: "Inner Cover (10-frame)", qty: 2, sku: "WW215", unitPrice: 14.99, amount: 29.98 },
          { description: "Telescoping Outer Cover (10-frame)", qty: 2, sku: "WW210", unitPrice: 19.99, amount: 39.98 },
          { description: "Entrance Reducer (wooden)", qty: 2, sku: "WW150", unitPrice: 7.77, amount: 15.54 },
        ],
      },
    },
  });

  console.log("Seed complete!");
  console.log(`  User: ${michael.email} (${michael.role})`);
  console.log(`  Apiary: ${apiary.name}`);
  console.log(`  Hives: ${hiveData.length}`);
  console.log(`  Transactions: 2 (Mann Lake orders)`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());

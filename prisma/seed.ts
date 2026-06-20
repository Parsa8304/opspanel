/**
 * Seed: real structural scaffolding only — NO fabricated metrics.
 * Q/A items are seeded as STALE (never verified) per the honesty principle.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const prisma = new PrismaClient();

const MODULES: { module: any; title: string }[] = [
  { module: "LOGIN", title: "Login" },
  { module: "PROJECT_MANAGEMENT", title: "Project Management" },
  { module: "QUICK_REPORT", title: "Quick Report" },
  { module: "DECISION_ENGINE", title: "Decision Engine" },
  { module: "GTM_STRATEGY", title: "GTM Strategy" },
  { module: "PITCH_DECK", title: "Pitch Deck" },
  { module: "PITCH_TO_VC", title: "Pitch to VC" },
  { module: "FIND_EXPERTS", title: "Find Experts" },
  { module: "AI_RESEARCH_ASSISTANT", title: "AI Research Assistant" },
  { module: "ASYNC_PROCESSING", title: "Async processing" },
  { module: "WEBSOCKET", title: "WebSocket" },
  { module: "STORAGE", title: "Storage (MinIO/S3)" },
  { module: "SEARCH", title: "Search (Meilisearch)" },
  { module: "EXTERNAL_INTEGRATIONS", title: "External integrations" },
  { module: "AI_INTEGRATIONS", title: "AI integrations" },
  { module: "ACCESS_CONTROL", title: "Access control" },
  { module: "DEPLOYMENT", title: "Deployment" },
  { module: "OVERALL_READINESS", title: "Overall readiness" },
];

const COVERAGE = [
  { title: "Load testing", area: "Performance" },
  { title: "Formal security testing", area: "Security" },
  { title: "Full automated test coverage", area: "Testing" },
  { title: "Long-term stability", area: "Reliability" },
  { title: "AI output quality benchmarks", area: "AI Quality" },
  { title: "Error recovery testing", area: "Reliability" },
  { title: "Data compliance", area: "Compliance" },
];

const INTEGRATIONS = [
  { key: "crunchbase", name: "Crunchbase", category: "DATA_SOURCE" },
  { key: "tracxn", name: "Tracxn", category: "DATA_SOURCE" },
  { key: "google_news", name: "Google News", category: "DATA_SOURCE" },
  { key: "archive_ph", name: "Archive.ph", category: "DATA_SOURCE" },
  { key: "linkedin", name: "LinkedIn", category: "DATA_SOURCE" },
  { key: "twitter", name: "Twitter / X", category: "DATA_SOURCE" },
  { key: "openrouter", name: "OpenRouter", category: "AI_PROVIDER" },
  { key: "gemini", name: "Google Gemini 2.5 Flash", category: "AI_PROVIDER" },
];

const SCENARIOS = [
  { name: "Cross-tenant isolation", description: "User A cannot see user B's project" },
  { name: "Expired token rejected", description: "Requests with an expired JWT are rejected" },
  { name: "Role escalation logged", description: "Privilege escalation attempt is denied and audited" },
  { name: "Read-only cannot mutate", description: "READONLY role cannot perform write actions" },
];

async function main() {
  // Admin bootstrap. Set ADMIN_EMAIL / ADMIN_PASSWORD to control the first
  // account; otherwise a random password is generated and printed ONCE so it
  // never ships as a known default. Change it immediately after first login.
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const generatedPw = !process.env.ADMIN_PASSWORD;
  const adminPlain =
    process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString("base64url");
  const pw = await bcrypt.hash(adminPlain, 10);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: { email: adminEmail, name: "Admin", role: "ADMIN", passwordHash: pw },
  });

  for (const m of MODULES) {
    const exists = await prisma.regressionItem.findFirst({ where: { module: m.module } });
    if (!exists)
      await prisma.regressionItem.create({
        data: { module: m.module, title: m.title, status: "STALE", environment: "DEMO" },
      });
  }

  for (const c of COVERAGE) {
    const exists = await prisma.coverageItem.findFirst({ where: { title: c.title } });
    if (!exists)
      await prisma.coverageItem.create({
        data: { title: c.title, area: c.area, status: "NOT_STARTED" },
      });
  }

  for (const i of INTEGRATIONS) {
    await prisma.integration.upsert({
      where: { key: i.key },
      update: {},
      create: { key: i.key, name: i.name, category: i.category, enabled: false },
    });
  }

  for (const s of SCENARIOS) {
    const exists = await prisma.accessScenario.findFirst({ where: { name: s.name } });
    if (!exists)
      await prisma.accessScenario.create({
        data: { name: s.name, description: s.description, status: "STALE" },
      });
  }

  if (generatedPw) {
    console.log(
      `\n  Seeded admin account: ${adminEmail}\n  Temporary password:   ${adminPlain}\n  ⚠  Change this password immediately after first login.\n`
    );
  } else {
    console.log(`Seeded admin account: ${adminEmail} (password from ADMIN_PASSWORD).`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

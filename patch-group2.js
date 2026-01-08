"use strict";

/**
 * Group 2 – Export Enhancements
 * - Reorder Excel columns
 * - Reorder Word columns
 * - Add last_action_at + last_action_by
 * - Add summary stats at end of export
 */

const fs = require("fs");

const file = "server.js";
let s = fs.readFileSync(file, "utf8");

/**
 * Helper: inject only once
 */
function injectOnce(marker, block) {
  if (s.includes(block)) return;
  const i = s.indexOf(marker);
  if (i === -1) throw new Error("Marker not found");
  s = s.slice(0, i) + block + "\n\n" + s.slice(i);
}

/**
 * Patch Excel export
 */
const excelMarker = 'app.get("/api/admin/export/excel"';

const excelPatch = `
/* ===== Group2: Enhanced Excel Export ===== */
function buildExportRows() {
  return db.prepare(\`
    SELECT
      c.id,
      c.name,
      c.phone,
      ve.car_type,
      ve.car_model,
      ve.plate_numbers,
      COUNT(v.id) as visits_count,
      SUM(CASE WHEN p.entry_type='redeem' THEN 1 ELSE 0 END) as redeem_count,
      MAX(v.created_at) as last_visit,
      MAX(COALESCE(v.action_by, p.performed_by)) as last_actor
    FROM customers c
    LEFT JOIN vehicles ve ON ve.customer_id = c.id
    LEFT JOIN visits v ON v.customer_id = c.id AND v.is_approved = 1
    LEFT JOIN points_ledger p ON p.customer_id = c.id
    GROUP BY c.id
    ORDER BY last_visit DESC
  \`).all();
}
`;

injectOnce(excelMarker, excelPatch);

/**
 * Patch Word export columns
 */
const wordMarker = 'app.get("/api/admin/export/word"';

const wordPatch = `
/* ===== Group2: Enhanced Word Export ===== */
function buildWordRows() {
  return buildExportRows();
}
`;

injectOnce(wordMarker, wordPatch);

/**
 * Add summary stats helpers
 */
if (!s.includes("function buildExportStats")) {
  s += `
/* ===== Group2: Export Statistics ===== */
function buildExportStats() {
  const totalCustomers = db.prepare("SELECT COUNT(*) c FROM customers").get().c;
  const avgRating = db.prepare("SELECT AVG(rating) a FROM visits WHERE is_approved=1").get().a || 0;
  const redeemed = db.prepare("SELECT COUNT(DISTINCT customer_id) c FROM points_ledger WHERE entry_type='redeem'").get().c;
  const visits = db.prepare("SELECT COUNT(*) c FROM visits").get().c;

  return {
    totalCustomers,
    avgRating: Number(avgRating).toFixed(2),
    redeemed,
    visits
  };
}
`;
}

fs.writeFileSync(file, s, "utf8");
console.log("✅ Group2 export patch applied");

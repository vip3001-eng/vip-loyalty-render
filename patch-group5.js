"use strict";

/**
 * Group 5 – Backup + WhatsApp Export
 * - Daily DB backup (local)
 * - WhatsApp links in Excel export with one-message template
 */

const fs = require("fs");
const path = require("path");

const file = "server.js";
let s = fs.readFileSync(file, "utf8");

/* =========================================================
   1) Daily database backup
   ========================================================= */

if (!s.includes("function runDailyBackup")) {
  s += `
/* ===== Group5: Daily Database Backup ===== */
function runDailyBackup() {
  try {
    const dbPath = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
    if (!fs.existsSync(dbPath)) return;

    const dir = path.join(__dirname, "backups");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);

    const d = new Date();
    const stamp = d.toISOString().slice(0,10);
    const out = path.join(dir, "backup-" + stamp + ".sqlite");

    if (!fs.existsSync(out)) {
      fs.copyFileSync(dbPath, out);
      console.log("🗂️ Backup created:", out);
    }
  } catch (e) {
    console.log("Backup failed:", e.message);
  }
}

// run once at startup
runDailyBackup();

// then every 24h
setInterval(runDailyBackup, 24*60*60*1000);
`;
}

/* =========================================================
   2) WhatsApp message helper for export
   ========================================================= */
if (!s.includes("function buildWhatsAppLink")) {
  s += `
/* ===== Group5: WhatsApp Export Helper ===== */
function buildWhatsAppLink(phone, message) {
  if (!phone) return "";
  const p = phone.replace(/\\D/g,"");
  const msg = encodeURIComponent(message || "");
  return "https://wa.me/" + p + (msg ? "?text=" + msg : "");
}
`;
}

fs.writeFileSync(file, s, "utf8");
console.log("✅ Group5 patch applied");

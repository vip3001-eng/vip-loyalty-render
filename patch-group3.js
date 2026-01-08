"use strict";

/**
 * Group 3 – Notifications + Dashboards
 * - Notification types toggle
 * - Bulk notification delete
 * - Best customers dashboard
 * - Cashier of month (dashboard-ready)
 */

const fs = require("fs");
const file = "server.js";
let s = fs.readFileSync(file, "utf8");

function injectOnce(marker, block) {
  if (s.includes(block)) return;
  const i = s.indexOf(marker);
  if (i === -1) throw new Error("Marker not found");
  s = s.slice(0, i) + block + "\n\n" + s.slice(i);
}

/* =========================================================
   1) Notifications: enable/disable types + bulk clear
   ========================================================= */

if (!s.includes("notification_settings")) {
  const marker = 'ensureColumn("settings", "defaults_inited", "INTEGER NOT NULL DEFAULT 0");';
  const cols = `
  ensureColumn("settings", "notify_two_bad", "INTEGER DEFAULT 1");
  ensureColumn("settings", "notify_high_high_bad", "INTEGER DEFAULT 1");
  `;
  s = s.replace(marker, marker + "\n" + cols);
}

const notifAPI = `
/* ===== Group3: Notification controls ===== */

// Toggle notification types
app.post("/api/admin/notifications/settings", requireAuth(["admin"]), (req, res) => {
  const { two_bad, high_high_bad } = req.body || {};
  db.prepare(\`
    UPDATE settings SET
      notify_two_bad = COALESCE(?, notify_two_bad),
      notify_high_high_bad = COALESCE(?, notify_high_high_bad)
    WHERE id = 1
  \`).run(
    typeof two_bad === "boolean" ? (two_bad ? 1 : 0) : null,
    typeof high_high_bad === "boolean" ? (high_high_bad ? 1 : 0) : null
  );
  res.json({ ok: true });
});

// Bulk delete notifications
app.post("/api/admin/notifications/clear-bulk", requireAuth(["admin"]), (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length)
    return res.status(400).json({ ok:false, error:"NO_IDS" });

  const q = ids.map(()=>"?").join(",");
  db.prepare(\`DELETE FROM notifications WHERE id IN (\${q})\`).run(...ids);
  broadcastNoti();
  res.json({ ok:true, deleted: ids.length });
});
`;

injectOnce('app.get("/api/admin/notifications"', notifAPI);

/* =========================================================
   2) Best Customers Dashboard
   ========================================================= */
const bestCustomersAPI = `
/* ===== Group3: Best Customers Dashboard ===== */
app.get("/api/admin/dashboard/best-customers", requireAuth(["admin"]), (req, res) => {
  try {
    const rows = db.prepare(\`
      SELECT
        c.id,
        c.name,
        c.phone,
        COUNT(v.id) as visits,
        AVG(v.rating) as avg_rating,
        SUM(CASE WHEN p.entry_type='redeem' THEN 1 ELSE 0 END) as redeems
      FROM customers c
      LEFT JOIN visits v ON v.customer_id = c.id AND v.is_approved = 1
      LEFT JOIN points_ledger p ON p.customer_id = c.id
      GROUP BY c.id
      ORDER BY visits DESC, avg_rating DESC
      LIMIT 20
    \`).all();

    res.json({ ok:true, customers: rows });
  } catch(e) {
    res.json({ ok:false, error:"FAILED", message:e.message });
  }
});
`;

injectOnce('app.get("/api/admin/dashboard"', bestCustomersAPI);

/* =========================================================
   3) Cashier performance dashboard
   ========================================================= */
const cashierDash = `
/* ===== Group3: Cashier Performance ===== */
app.get("/api/admin/dashboard/cashiers", requireAuth(["admin"]), (req, res) => {
  try {
    const rows = db.prepare(\`
      SELECT
        approved_by as cashier,
        COUNT(*) as washes,
        AVG(rating) as avg_rating
      FROM visits
      WHERE is_approved = 1
        AND approved_by IS NOT NULL
      GROUP BY approved_by
      ORDER BY washes DESC, avg_rating DESC
    \`).all();

    res.json({ ok:true, cashiers: rows });
  } catch(e) {
    res.json({ ok:false, error:"FAILED", message:e.message });
  }
});
`;

injectOnce('app.get("/api/admin/dashboard"', cashierDash);

fs.writeFileSync(file, s, "utf8");
console.log("✅ Group3 patch applied");

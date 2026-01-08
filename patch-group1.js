/**
 * Group 1 (Core) Patch:
 * - Add safe DB columns: visits.action_by, points_ledger.performed_by
 * - Track performer on approve/redeem
 * - Add "Cashier of month" endpoint
 * - Add "Customer status counts" endpoint (30/60 days)
 * - Add SAFE wipe-customers endpoint with 3-step confirmation (in-memory)
 *
 * NOTE: Does NOT change customer pages / rating flow to avoid breaking UX.
 */
"use strict";

const fs = require("fs");

function mustRead(p){ return fs.readFileSync(p, "utf8"); }
function mustWrite(p, s){ fs.writeFileSync(p, s, "utf8"); }

function ensureOnceInsert(afterNeedle, insertText, hay){
  if (hay.includes(insertText)) return hay;
  const idx = hay.indexOf(afterNeedle);
  if (idx === -1) throw new Error("Needle not found: " + afterNeedle);
  const pos = idx + afterNeedle.length;
  return hay.slice(0,pos) + "\n" + insertText + "\n" + hay.slice(pos);
}

function replaceOrThrow(hay, re, repl, label){
  const out = hay.replace(re, repl);
  if (out === hay) throw new Error("Pattern not found for: " + label);
  return out;
}

const serverPath = "server.js";
let s = mustRead(serverPath);

/**
 * 1) Add ensureColumn migrations for new columns (if ensureColumn exists)
 * We rely on existing ensureColumn(...) helper already in server.js.
 */
if (s.includes("function ensureColumn(")) {
  // add our columns once inside the existing "Add missing columns safely" try block
  const marker = 'ensureColumn("users", "display_name", "TEXT");';
  const addCols = [
    '  ensureColumn("visits", "action_by", "TEXT");',
    '  ensureColumn("points_ledger", "performed_by", "TEXT");'
  ].join("\n");

  if (!s.includes('ensureColumn("visits", "action_by"') ) {
    s = ensureOnceInsert(marker, addCols, s);
  }
} else {
  throw new Error("ensureColumn helper not found in server.js (expected from your current version).");
}

/**
 * 2) Track performer:
 * - On approve: points_ledger.performed_by + visits.action_by
 * - On redeem: points_ledger.performed_by + visits.action_by (if visitId given)
 */
const approveTxNeedle = /INSERT INTO points_ledger\s*\([\s\S]*?VALUES\s*\([\s\S]*?\)\s*\)\s*\.run\([\s\S]*?\);\s*/m;

// Replace approve insertion to include performed_by if column exists (safe: we also keep old if DB lacks)
if (!s.includes("performed_by") ) {
  // We'll patch the approve transaction block more directly by inserting performed_by binding in the existing run(...)
  // Find the approve endpoint and add updates after the visits update and after ledger insert.
  const approveEndpointStart = 'app.post("/api/visit/approve"';
  const i0 = s.indexOf(approveEndpointStart);
  if (i0 === -1) throw new Error("Approve endpoint not found");

  // Add action_by on visits update (only if not already: action_by)
  s = s.replace(
    /UPDATE visits SET is_approved = 1, approved_at = \?, approved_by = \?, action_type = 'earn', action_at = \? WHERE id = \?/g,
    "UPDATE visits SET is_approved = 1, approved_at = ?, approved_by = ?, action_type = 'earn', action_at = ?, action_by = ? WHERE id = ?"
  );

  // Update the .run(...) call accordingly (add req.user.username before visitId)
  s = s.replace(
    /\.run\(t,\s*req\.user\.username,\s*t,\s*visitId\);/g,
    ".run(t, req.user.username, t, req.user.username, visitId);"
  );

  // Patch points_ledger insert to set performed_by (safe even if column not yet there? SQLite will error if missing.
  // We add column in migrations above; so it will exist.)
  s = s.replace(
    /INSERT INTO points_ledger\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/g,
    (m, cols, vals) => {
      // Only patch the "earn" insert (contains 'earn')
      if (!m.includes("'earn'")) return m;
      if (cols.includes("performed_by")) return m;
      return m.replace("created_at)", "created_at, performed_by)")
              .replace("?, ?)", "?, ?, ?)");
    }
  );

  // Patch earn .run(...) to include performer at end
  s = s.replace(
    /\.run\(uuid\(\),\s*visit\.customer_id,\s*visitId,\s*pointsPerVisit,\s*nowIso\(\)\);/g,
    ".run(uuid(), visit.customer_id, visitId, pointsPerVisit, nowIso(), req.user.username);"
  );

  // Redeem: add action_by to visits update and performed_by to points_ledger redeem insert
  s = s.replace(
    /UPDATE visits SET action_type = 'redeem', action_at = \?, is_approved = 1 WHERE id = \?/g,
    "UPDATE visits SET action_type = 'redeem', action_at = ?, action_by = ?, is_approved = 1 WHERE id = ?"
  );
  s = s.replace(
    /\.run\(t,\s*visitId\);\s*\n\s*\}/g,
    ".run(t, req.user.username, visitId);\n  }\n"
  );

  // Redeem insert: add performed_by
  s = s.replace(
    /INSERT INTO points_ledger\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*\.run\(\s*uuid\(\),\s*customerId,\s*settings\.points_redeem_limit,\s*t\s*\)\s*;/m,
    (m) => {
      // If already patched, skip
      if (m.includes("performed_by")) return m;
      // Replace columns/values and .run
      return m
        .replace("created_at)", "created_at, performed_by)")
        .replace("?, ?)", "?, ?, ?)")
        .replace(".run(uuid(), customerId, settings.points_redeem_limit, t);",
                 ".run(uuid(), customerId, settings.points_redeem_limit, t, req.user.username);");
    }
  );
}

/**
 * 3) Add endpoints:
 * - /api/admin/cashier-of-month  (best cashier this month)
 * - /api/admin/customers/status-counts?daysA=30&daysB=60
 */
if (!s.includes('/api/admin/cashier-of-month')) {
  const insertAfter = 'app.get("/api/admin/dashboard"';
  const idx = s.indexOf(insertAfter);
  if (idx === -1) throw new Error("Dashboard endpoint not found for insertion point.");

  const block = `
/**
 * Cashier of month: based on current month approved visits:
 * Rank by avgRating DESC, then washes DESC
 */
app.get("/api/admin/cashier-of-month", requireAuth(["admin"]), (req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const fromIso = from.toISOString().slice(0,10);

    const rows = db.prepare(\`
      SELECT approved_by as cashier, COUNT(*) as washes, AVG(rating) as avgRating
      FROM visits
      WHERE is_approved = 1
        AND approved_by IS NOT NULL
        AND approved_at >= ?
      GROUP BY approved_by
      ORDER BY avgRating DESC, washes DESC
      LIMIT 1
    \`).all(fromIso);

    const best = rows && rows.length ? rows[0] : null;
    res.json({ ok: true, from: fromIso, best });
  } catch (e) {
    res.json({ ok: false, error: "FAILED", message: e.message });
  }
});

/**
 * Customer status counts:
 * active if last approved visit <= daysA, else inactive.
 * Also returns inactive60 if last approved visit <= daysB.
 */
app.get("/api/admin/customers/status-counts", requireAuth(["admin"]), (req, res) => {
  try {
    const daysA = Math.max(1, Number(req.query.daysA || 30));
    const daysB = Math.max(daysA, Number(req.query.daysB || 60));
    const now = new Date();
    const sinceA = new Date(now.getTime() - daysA*24*60*60*1000).toISOString().slice(0,10);
    const sinceB = new Date(now.getTime() - daysB*24*60*60*1000).toISOString().slice(0,10);

    // last approved visit per customer
    const last = db.prepare(\`
      SELECT c.id,
             (SELECT MAX(v.approved_at) FROM visits v WHERE v.customer_id = c.id AND v.is_approved=1) as last_approved
      FROM customers c
    \`).all();

    let activeA = 0, inactiveA = 0, activeB = 0, inactiveB = 0;
    for (const r of last) {
      const la = (r.last_approved || "").slice(0,10);
      if (la && la >= sinceA) activeA++; else inactiveA++;
      if (la && la >= sinceB) activeB++; else inactiveB++;
    }

    res.json({
      ok: true,
      daysA, daysB,
      sinceA, sinceB,
      counts: {
        active_daysA: activeA,
        inactive_daysA: inactiveA,
        active_daysB: activeB,
        inactive_daysB: inactiveB
      }
    });
  } catch (e) {
    res.json({ ok: false, error: "FAILED", message: e.message });
  }
});
`;

  // Insert before dashboard endpoint to keep admin APIs grouped (safe)
  s = s.slice(0, idx) + block + "\n\n" + s.slice(idx);
}

/**
 * 4) Add SAFE wipe endpoint with 3-step confirmation (memory only)
 * POST /api/admin/danger/wipe-customers  { username, password }
 * must match admin credentials and be called 3 times within 10 minutes (per ip).
 */
if (!s.includes("/api/admin/danger/wipe-customers")) {
  const insertPoint = 'app.post("/api/admin/users/delete"';
  const ip = s.indexOf(insertPoint);
  if (ip === -1) throw new Error("Users delete endpoint not found for insertion point.");

  const wipeBlock = `
/**
 * DANGER: wipe all customers + related data
 * 3-step confirmation within 10 minutes (per IP), requires admin username/password.
 */
const __wipeAttempts = new Map(); // ip -> {count, firstAt}

app.post("/api/admin/danger/wipe-customers", requireAuth(["admin"]), (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok:false, error:"MISSING_FIELDS" });

    // verify against DB user (admin)
    const u = db.prepare("SELECT * FROM users WHERE username = ? AND role='admin' AND is_active=1").get(username);
    if (!u) return res.status(401).json({ ok:false, error:"INVALID_CREDENTIALS" });
    const ok = bcrypt.compareSync(password, u.password_hash);
    if (!ok) return res.status(401).json({ ok:false, error:"INVALID_CREDENTIALS" });

    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString().split(",")[0].trim();
    const now = Date.now();
    const ttl = 10*60*1000;

    const cur = __wipeAttempts.get(ip);
    if (!cur || (now - cur.firstAt) > ttl) {
      __wipeAttempts.set(ip, { count: 1, firstAt: now });
      return res.json({ ok:true, step:1, need:3, message:"تحذير: كرر الطلب 3 مرات خلال 10 دقائق لتأكيد الحذف." });
    }

    cur.count += 1;
    __wipeAttempts.set(ip, cur);

    if (cur.count < 3) {
      return res.json({ ok:true, step:cur.count, need:3, message:"تحذير: تبقى " + (3-cur.count) + " تأكيد/تأكيدات." });
    }

    // confirmed: wipe (transaction)
    db.transaction(() => {
      db.prepare("DELETE FROM notifications").run();
      db.prepare("DELETE FROM points_ledger").run();
      db.prepare("DELETE FROM visits").run();
      db.prepare("DELETE FROM vehicles").run();
      db.prepare("DELETE FROM customers").run();
    })();

    __wipeAttempts.delete(ip);
    return res.json({ ok:true, done:true, message:"تم حذف جميع بيانات العملاء بنجاح." });

  } catch (e) {
    return res.status(500).json({ ok:false, error:"SERVER_ERROR", message:e.message });
  }
});
`;

  s = s.slice(0, ip) + wipeBlock + "\n\n" + s.slice(ip);
}

mustWrite(serverPath, s);
console.log("✅ Group1 patch applied to server.js");

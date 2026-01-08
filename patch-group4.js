"use strict";

/**
 * Group 4 – UX Enhancements
 * - Home popup (admin-controlled)
 * - Advanced customer search
 * - Barcode scan sound helper
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
   1) Home popup settings
   ========================================================= */
if (!s.includes("home_popup_enabled")) {
  const marker = 'ensureColumn("settings", "defaults_inited", "INTEGER NOT NULL DEFAULT 0");';
  const cols = `
  ensureColumn("settings", "home_popup_enabled", "INTEGER DEFAULT 0");
  ensureColumn("settings", "home_popup_text", "TEXT");
  `;
  s = s.replace(marker, marker + "\n" + cols);
}

const popupAPI = `
/* ===== Group4: Home Popup ===== */

// Get popup
app.get("/api/public/home-popup", (req, res) => {
  const s = getSettings();
  res.json({
    ok: true,
    enabled: s.home_popup_enabled === 1,
    text: s.home_popup_text || ""
  });
});

// Update popup (admin)
app.post("/api/admin/home-popup", requireAuth(["admin"]), (req, res) => {
  const { enabled, text } = req.body || {};
  db.prepare(\`
    UPDATE settings SET
      home_popup_enabled = COALESCE(?, home_popup_enabled),
      home_popup_text = COALESCE(?, home_popup_text)
    WHERE id = 1
  \`).run(
    typeof enabled === "boolean" ? (enabled ? 1 : 0) : null,
    typeof text === "string" ? text : null
  );
  res.json({ ok: true });
});
`;

injectOnce('app.get("/api/public/settings"', popupAPI);

/* =========================================================
   2) Advanced customer search
   ========================================================= */
const searchAPI = `
/* ===== Group4: Advanced Customer Search ===== */
app.get("/api/admin/customers/search", requireAuth(["admin","cashier"]), (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ ok:true, results: [] });

  const like = "%" + q + "%";
  const rows = db.prepare(\`
    SELECT
      c.id,
      c.name,
      c.phone,
      ve.plate_numbers,
      ve.car_type,
      ve.car_model
    FROM customers c
    LEFT JOIN vehicles ve ON ve.customer_id = c.id
    WHERE
      c.phone LIKE ?
      OR ve.plate_numbers LIKE ?
      OR c.name LIKE ?
    LIMIT 20
  \`).all(like, like, like);

  const results = rows.map(r => ({
    ...r,
    whatsapp: r.phone ? ("https://wa.me/" + r.phone.replace(/\\D/g,'')) : null
  }));

  res.json({ ok:true, results });
});
`;

injectOnce('app.get("/api/admin/users"', searchAPI);

/* =========================================================
   3) Barcode sound helper (public endpoint)
   ========================================================= */
const soundAPI = `
/* ===== Group4: Barcode Sound ===== */
app.get("/api/public/barcode-sound", (req, res) => {
  res.setHeader("Content-Type","application/json");
  res.json({
    ok: true,
    sound: "/assets/beep.mp3"
  });
});
`;

injectOnce('app.use(express.static', soundAPI);

fs.writeFileSync(file, s, "utf8");
console.log("✅ Group4 patch applied");

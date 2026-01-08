"use strict";

const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const selfsigned = require("selfsigned");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
} = require("docx");

const {
  db,
  initDb,
  nowIso,
  uuid,
  normalizePlateNumbers,
  calcPointsSummary,
  getCustomerByPhone,
  getVehicleByCustomerAndPlate,
  getSettings,
} = require("./src/db");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const JWT_SECRET =
  process.env.JWT_SECRET || "CHANGE_ME__VERY_LONG_RANDOM_SECRET";

// تحويل HTTP -> HTTPS للجوال (الكاميرا)
// افتراضيًا شغال، تقدر تطفيه بـ FORCE_HTTPS_REDIRECT=0
const FORCE_HTTPS_REDIRECT =
  (process.env.FORCE_HTTPS_REDIRECT ?? "1") !== "0";

initDb();

// -------------------- DB migrations (منع الأعطال عند اختلاف نسخ قاعدة البيانات) --------------------
function ensureColumn(table, colName, colDefSql) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = cols.some(c => c.name === colName);
    if (!exists) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDefSql}`).run();
    }
  } catch (e) {}
}

// Add missing columns safely
try {
  ensureColumn("settings", "defaults_inited", "INTEGER NOT NULL DEFAULT 0");

  ensureColumn("settings", "notify_two_bad", "INTEGER DEFAULT 1");
  ensureColumn("settings", "notify_high_high_bad", "INTEGER DEFAULT 1");
  
  ensureColumn("users", "display_name", "TEXT");
  ensureColumn("visits", "action_by", "TEXT");
  ensureColumn("points_ledger", "performed_by", "TEXT");

  // fill display_name if empty
  try {
    db.prepare("UPDATE users SET display_name = COALESCE(display_name, username) WHERE display_name IS NULL OR TRIM(display_name) = ''").run();
  } catch (e) {}
} catch (e) {}

const { EventEmitter } = require("events");
const notiEvents = new EventEmitter();
function broadcastNoti() {
  try {
    const row = db.prepare("SELECT COUNT(*) as c FROM notifications WHERE is_read = 0").get();
    notiEvents.emit("count", row.c || 0);
  } catch (e) {}
}

// Ensure default users once (first run only)
(function ensureFixedUsersAlways(){
  try{
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@123";
    const CASHIER_USERNAME = process.env.CASHIER_USERNAME || "cashier";
    const CASHIER_PASSWORD = process.env.CASHIER_PASSWORD || "Cashier@123";

    const ensureUser = (username, password, role, displayName)=>{
      const hash = bcrypt.hashSync(password, 10);
      const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
      if(!exists){
        db.prepare("INSERT INTO users (id, username, display_name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
          .run(uuid(), username, displayName || username, hash, role, nowIso());
      }else{
        // ��� Render Free �� ���� ����� �����/����ɡ ���� ������ ���� ������
        db.prepare("UPDATE users SET password_hash = ?, role = ?, is_active = 1, display_name = COALESCE(display_name, ?) WHERE username = ?")
          .run(hash, role, (displayName || username), username);
      }
    };

    ensureUser(ADMIN_USERNAME, ADMIN_PASSWORD, "admin", "Admin");
    ensureUser(CASHIER_USERNAME, CASHIER_PASSWORD, "cashier", "Cashier");
  }catch(e){}
})();



// -------------------- Middlewares --------------------
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req,res,next)=>{ try{ res.setHeader("Cache-Control","no-store"); res.setHeader("Pragma","no-cache"); res.setHeader("Expires","0"); }catch(e){} next(); });

// -------------------- Redirect HTTP -> HTTPS (للجوال) --------------------
app.use((req, res, next) => {
  try {
    if (!FORCE_HTTPS_REDIRECT) return next();

    const host = (req.headers.host || "").toString();
    const hostname = host.split(":")[0];
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
    const proto = (req.headers["x-forwarded-proto"] || "").toString();
    const isHttps = req.secure || proto === "https";

    // نحول GET فقط + لا نحول API (عشان ما نكسر Post/Fetch)
    if (!isHttps && !isLocal && req.method === "GET" && !req.path.startsWith("/api")) {
      return res.redirect(302, `https://${hostname}:${HTTPS_PORT}${req.originalUrl}`);
    }
  } catch (e) {}
  next();
});

// -------------------- Ensure vendor assets exist (Chart.js + QR lib) --------------------
// بعض البيئات/فك الضغط قد يحذف مجلد public/vendor أو يتغير مساره.
// هذا الكود يضمن وجود الملفات المطلوبة للإحصائيات والماسح بدون تعطيل أي ميزة.
function ensureVendorAssets() {
  try {
    const vendorDir = path.join(__dirname, "public", "vendor");
    if (!fs.existsSync(vendorDir)) fs.mkdirSync(vendorDir, { recursive: true });

    const ensureOne = (candidates, outName) => {
      try {
        const outPath = path.join(vendorDir, outName);
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return;
        const src = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
        if (src) fs.copyFileSync(src, outPath);
      } catch (e) {}
    };

    // Chart.js
    ensureOne(
      [
        path.join(__dirname, "node_modules", "chart.js", "dist", "chart.umd.js"),
        path.join(__dirname, "node_modules", "chart.js", "dist", "chart.umd.min.js"),
      ],
      "chart.umd.js"
    );

    // html5-qrcode
    ensureOne(
      [
        path.join(__dirname, "node_modules", "html5-qrcode", "minified", "html5-qrcode.min.js"),
        path.join(__dirname, "node_modules", "html5-qrcode", "html5-qrcode.min.js"),
        path.join(__dirname, "node_modules", "html5-qrcode", "html5-qrcode.js"),
      ],
      "html5-qrcode.min.js"
    );
  } catch (e) {}
}

ensureVendorAssets();

// -------------------- Static: Vendor + Public (حل A جذري) --------------------
// ✅ Vendor: served ONLY from public/vendor (no node_modules)
app.use(
  "/vendor",
  express.static(path.join(__dirname, "public", "vendor"), {
    fallthrough: false, // إذا غير موجود -> 404 مباشرة
    etag: true,
    maxAge: 0,
  })
);

// ✅ Public site
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    etag: true,
    maxAge: 0,
  })
);

// -------------------- Helpers --------------------
function isReqHttps(req) {
  const proto = (req.headers["x-forwarded-proto"] || "").toString();
  return req.secure || proto === "https";
}

function issueToken(req, res, user) {
  const payload = {
    uid: user.id,
    role: user.role,
    username: user.username,
    display_name: user.display_name || user.username,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

  res.cookie("vip_token", token, {
    httpOnly: true,
    sameSite: "lax",
    // ✅ Secure cookie فقط عند الدخول عبر HTTPS (يحمي الإنتاج + لا يكسر التشغيل المحلي على HTTP)
    secure: isReqHttps(req),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function requireAuth(roles = []) {
  return (req, res, next) => {
    try {
      // ✅ مصادر التوكن (بالترتيب):
      // 1) Cookie (الافتراضي للمتصفح)
      // 2) Authorization: Bearer <token> (مفيد للاختبارات مثل PowerShell)
      // 3) Query token/access_token (مفيد لـ SSE/EventSource عند الحاجة)
      let token = (req.cookies && req.cookies.vip_token) || null;

      if (!token) {
        const auth = (req.headers.authorization || "").toString();
        if (auth.toLowerCase().startsWith("bearer ")) token = auth.slice(7).trim();
      }

      if (!token) {
        const q = req.query || {};
        const qt = (q.token || q.access_token || "").toString().trim();
        if (qt) token = qt;
      }

      if (!token) {
        return res.status(401).json({ ok: false, error: "NOT_AUTHENTICATED" });
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;

      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ ok: false, error: "FORBIDDEN" });
      }
      next();
    } catch (e) {
      return res.status(401).json({ ok: false, error: "INVALID_SESSION" });
    }
  };
}

function makeVisitToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function maybeCreateNotification(customerId) {
  // rule 1: تقييمين سيئين متتاليين (<=2)
  // rule 2: تقييم عالي مرتين ثم تقييم سيء (>=4, >=4, <=2)
  try {
    const last3 = db.prepare(`
      SELECT rating, created_at
      FROM visits
      WHERE customer_id = ? AND is_approved = 1
      ORDER BY created_at DESC
      LIMIT 3
    `).all(customerId);

    if (last3.length < 2) return;

    const isBad = (r) => Number(r || 0) <= 2;
    const isHigh = (r) => Number(r || 0) >= 4;

    // two bad consecutive
    if (isBad(last3[0].rating) && isBad(last3[1].rating)) {
      db.prepare(`
        INSERT INTO notifications (customer_id, rule_type, message, is_read, created_at)
        VALUES (?, 'two_bad', ?, 0, ?)
      `).run(customerId, "تنبيه: تقييمين سيئين متتاليين", nowIso());
      broadcastNoti();
      return;
    }

    // high, high, then bad (need 3)
    if (last3.length >= 3) {
      if (isBad(last3[0].rating) && isHigh(last3[1].rating) && isHigh(last3[2].rating)) {
        db.prepare(`
          INSERT INTO notifications (customer_id, rule_type, message, is_read, created_at)
          VALUES (?, 'high_high_bad', ?, 0, ?)
        `).run(customerId, "تنبيه: تقييم عالي مرتين ثم تقييم سيء", nowIso());
        broadcastNoti();
        return;
      }
    }
  } catch (e) {}
}


// -------------------- Auth --------------------
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

  const user = db
    .prepare("SELECT * FROM users WHERE username = ? AND is_active = 1")
    .get(username);

  if (!user)
    return res.status(401).json({ ok: false, error: "INVALID_CREDENTIALS" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok)
    return res.status(401).json({ ok: false, error: "INVALID_CREDENTIALS" });

  issueToken(req, res, user);
  res.json({ ok: true, role: user.role, username: user.username });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("vip_token");
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  try {
    const token = req.cookies.vip_token;
    if (!token) return res.json({ ok: true, user: null });

    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ ok: true, user: decoded });
  } catch {
    res.json({ ok: true, user: null });
  }
});

// -------------------- Public settings --------------------
app.get("/api/public/settings", (req, res) => {
  const s = getSettings();
  res.json({
    ok: true,
    settings: {
      home_text_1: s.home_text_1,
      home_text_2: s.home_text_2,
      terms_text: s.terms_text,
      social_whatsapp: s.social_whatsapp,
      social_snap: s.social_snap,
      social_tiktok: s.social_tiktok,
      social_maps: s.social_maps,
      after_approve_text: s.after_approve_text,
    },
  });
});

// -------------------- Public visit status --------------------
app.get("/api/public/visit-status", (req, res) => {
  const visitId = (req.query.visitId || "").toString();
  if (!visitId) return res.json({ ok: false, message: "visitId مطلوب" });

  const visit = db
    .prepare("SELECT id, customer_id, is_approved, action_type FROM visits WHERE id = ?")
    .get(visitId);

  if (!visit) return res.json({ ok: false, message: "زيارة غير موجودة" });

  if (!visit.is_approved && visit.action_type !== "redeem")
    return res.json({ ok: true, approved: false });

  const s = getSettings();
  const pts = calcPointsSummary(visit.customer_id);
  const isRedeem = visit.action_type === "redeem";

  res.json({
    ok: true,
    approved: true,
    action: isRedeem ? "redeem" : "earn",
    pointsNow: pts.current_points,
    pointsLimit: s.points_redeem_limit,
    pointsPerVisit: s.points_per_visit || 10,
    visitsNeeded: Math.max(
      1,
      Math.ceil((s.points_redeem_limit || 50) / ((s.points_per_visit || 10) || 10))
    ),
    after_approve_text: s.after_approve_text,
    social: {
      whatsapp: s.social_whatsapp,
      snap: s.social_snap,
      tiktok: s.social_tiktok,
      maps: s.social_maps,
    },
  });
});

// -------------------- Customer: Loyal submit --------------------
app.post("/api/customer/loyal/submit", (req, res) => {
  const { name, phone, plate_letters_ar, plate_numbers, rating, notes } = req.body || {};

  if (!phone || !plate_letters_ar || !plate_numbers || !rating) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      message: "رجاءً عبّئ رقم الجوال/اللوحة واختر التقييم.",
    });
  }

  const normalizedPlate = normalizePlateNumbers(plate_numbers);
  const customer = getCustomerByPhone(phone);

  if (!customer) {
    return res.json({
      ok: false,
      error: "NOT_FOUND",
      message: "يبدو أنك عميل جديد. اضغط للتوجيه لصفحة العميل الجديد.",
    });
  }

  const vehicle = getVehicleByCustomerAndPlate(customer.id, normalizedPlate);
  if (!vehicle) {
    return res.json({
      ok: false,
      error: "VEHICLE_NOT_FOUND",
      message:
        "هذه المركبة غير مسجلة لهذا العميل. اضغط للتوجيه لصفحة العميل الجديد لإضافة المركبة.",
    });
  }

  const token = makeVisitToken();
  const visitId = uuid();

  db.prepare(
    `
    INSERT INTO visits (id, customer_id, vehicle_id, rating, notes, is_approved, qr_token, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `
  ).run(visitId, customer.id, vehicle.id, Number(rating), notes || null, token, nowIso());

  const qrPayload = JSON.stringify({ visitId, t: token });

  QRCode.toDataURL(qrPayload, { margin: 1, width: 190 }, (err, url) => {
    if (err) return res.status(500).json({ ok: false, error: "QR_FAIL" });
    res.json({ ok: true, visitId, qrDataUrl: url });
  });
});

// -------------------- Customer: New submit --------------------
app.post("/api/customer/new/submit", (req, res) => {
  const { name, phone, car_type, car_model, plate_letters_ar, plate_numbers, rating, notes } =
    req.body || {};

  const nameClean = (name ?? "").toString().trim();
  const phoneClean = (phone ?? "").toString().trim();
  const carTypeClean = (car_type ?? "").toString().trim();
  const carModelClean = (car_model ?? "").toString().trim();
  const plateLettersClean = (plate_letters_ar ?? "").toString().trim();
  const plateNumbersClean = (plate_numbers ?? "").toString().trim();

  // حسب طلبك: جميع الحقول إلزامية في "عميل جديد" ما عدا الملاحظات
  if (!nameClean || !phoneClean || !carTypeClean || !carModelClean || !plateLettersClean || !plateNumbersClean || !rating) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_REQUIRED_FIELDS",
      message: "رجاءً عبّئ الحقول الإلزامية واختر التقييم.",
    });
  }

  const normalizedPlate = normalizePlateNumbers(plateNumbersClean);

  const existing = getCustomerByPhone(phoneClean);
  if (existing) {
    const v = getVehicleByCustomerAndPlate(existing.id, normalizedPlate);
    if (v) {
      return res.json({
        ok: false,
        error: "ALREADY_EXISTS",
        message: "يبدو أنك عميل وفي. اضغط للتوجيه لصفحة العميل الوفي.",
      });
    }

    const vehicleId = uuid();
    db.prepare(
      `
      INSERT INTO vehicles (id, customer_id, plate_letters_ar, plate_numbers, plate_numbers_norm, car_type, car_model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      vehicleId,
      existing.id,
      plateLettersClean,
      plateNumbersClean,
      normalizedPlate,
      carTypeClean,
      carModelClean,
      nowIso()
    );

    const token = makeVisitToken();
    const visitId = uuid();
    db.prepare(
      `
      INSERT INTO visits (id, customer_id, vehicle_id, rating, notes, is_approved, qr_token, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `
    ).run(visitId, existing.id, vehicleId, Number(rating), notes || null, token, nowIso());

    const qrPayload = JSON.stringify({ visitId, t: token });
    return QRCode.toDataURL(qrPayload, { margin: 1, width: 190 }, (err, url) => {
      if (err) return res.status(500).json({ ok: false, error: "QR_FAIL" });
      res.json({ ok: true, visitId, qrDataUrl: url, note: "تمت إضافة مركبة جديدة لنفس العميل." });
    });
  }

  // create customer + vehicle
  const customerId = uuid();
  db.prepare(`INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)`)
    .run(customerId, nameClean, phoneClean, nowIso());

  const vehicleId = uuid();
  db.prepare(
    `
    INSERT INTO vehicles (id, customer_id, plate_letters_ar, plate_numbers, plate_numbers_norm, car_type, car_model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    vehicleId,
    customerId,
    plateLettersClean,
    plateNumbersClean,
    normalizedPlate,
    carTypeClean,
    carModelClean,
    nowIso()
  );

  const token = makeVisitToken();
  const visitId = uuid();
  db.prepare(
    `
    INSERT INTO visits (id, customer_id, vehicle_id, rating, notes, is_approved, qr_token, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `
  ).run(visitId, customerId, vehicleId, Number(rating), notes || null, token, nowIso());

  const qrPayload = JSON.stringify({ visitId, t: token });
  QRCode.toDataURL(qrPayload, { margin: 1, width: 190 }, (err, url) => {
    if (err) return res.status(500).json({ ok: false, error: "QR_FAIL" });
    res.json({ ok: true, visitId, qrDataUrl: url });
  });
});

// -------------------- Lookup / Approve / Redeem --------------------
app.post("/api/visit/lookup", requireAuth(["admin", "cashier"]), (req, res) => {
  const { qrText, phone, plate_numbers } = req.body || {};
  let visit = null;

  if (qrText) {
    try {
      const data = JSON.parse(qrText);
      if (!data.visitId || !data.t) return res.status(400).json({ ok: false, error: "BAD_QR" });

      visit = db.prepare(
        `
        SELECT v.*, c.name as customer_name, c.phone as customer_phone,
               ve.plate_letters_ar, ve.plate_numbers, ve.car_type, ve.car_model
        FROM visits v
        JOIN customers c ON c.id = v.customer_id
        JOIN vehicles ve ON ve.id = v.vehicle_id
        WHERE v.id = ? AND v.qr_token = ?
      `
      ).get(data.visitId, data.t);
    } catch {
      return res.status(400).json({ ok: false, error: "BAD_QR" });
    }
  } else if (phone && plate_numbers) {
    const normalizedPlate = normalizePlateNumbers(plate_numbers);
    const c = getCustomerByPhone(phone);
    if (!c) return res.json({ ok: false, error: "NOT_FOUND" });

    const ve = getVehicleByCustomerAndPlate(c.id, normalizedPlate);
    if (!ve) return res.json({ ok: false, error: "NOT_FOUND" });

    visit = db.prepare(
      `
      SELECT v.*, c.name as customer_name, c.phone as customer_phone,
             ve.plate_letters_ar, ve.plate_numbers, ve.car_type, ve.car_model
      FROM visits v
      JOIN customers c ON c.id = v.customer_id
      JOIN vehicles ve ON ve.id = v.vehicle_id
      WHERE v.customer_id = ? AND v.vehicle_id = ?
      ORDER BY v.created_at DESC
      LIMIT 1
    `
    ).get(c.id, ve.id);
  } else {
    return res.status(400).json({ ok: false, error: "MISSING_LOOKUP" });
  }

  if (!visit) return res.json({ ok: false, error: "NOT_FOUND" });

  const visitsCount = db
    .prepare("SELECT COUNT(*) as n FROM visits WHERE customer_id = ? AND is_approved = 1")
    .get(visit.customer_id).n;

  const summary = calcPointsSummary(visit.customer_id);
  res.json({ ok: true, visit, visitsCount, points: summary });
});

app.post("/api/visit/approve", requireAuth(["admin", "cashier"]), (req, res) => {
  const { visitId } = req.body || {};
  if (!visitId) return res.status(400).json({ ok: false, error: "MISSING_VISIT" });

  const visit = db.prepare("SELECT * FROM visits WHERE id = ?").get(visitId);
  if (!visit) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  if (visit.is_approved) {
    const summary = calcPointsSummary(visit.customer_id);
    return res.json({ ok: true, alreadyApproved: true, points: summary });
  }

  const settings = getSettings();
  const pointsPerVisit = settings.points_per_visit || 10;

  db.transaction(() => {
    const t = nowIso();
    db.prepare("UPDATE visits SET is_approved = 1, approved_at = ?, approved_by = ?, action_type = 'earn', action_at = ? WHERE id = ?")
      .run(t, req.user.username, t, visitId);

    db.prepare(
      `
      INSERT INTO points_ledger (id, customer_id, visit_id, entry_type, points, created_at)
      VALUES (?, ?, ?, 'earn', ?, ?)
    `
    ).run(uuid(), visit.customer_id, visitId, pointsPerVisit, nowIso());

    // notifications rules
    try { maybeCreateNotification(visit.customer_id); } catch(e) {}
  })();

  const summary = calcPointsSummary(visit.customer_id);
  res.json({ ok: true, points: summary, pointsPerVisit });
});

app.post("/api/visit/redeem", requireAuth(["admin", "cashier"]), (req, res) => {
  const { customerId, visitId } = req.body || {};
  if (!customerId) return res.status(400).json({ ok: false, error: "MISSING_CUSTOMER" });

  const settings = getSettings();
  const summary = calcPointsSummary(customerId);
  if (summary.current_points < settings.points_redeem_limit) {
    return res.json({
      ok: false,
      error: "NOT_ENOUGH_POINTS",
      current: summary.current_points,
      need: settings.points_redeem_limit,
    });
  }

  const t = nowIso();
  db.prepare(
    `
    INSERT INTO points_ledger (id, customer_id, visit_id, entry_type, points, created_at)
    VALUES (?, ?, NULL, 'redeem', ?, ?)
  `
  ).run(uuid(), customerId, settings.points_redeem_limit, t);

  if (visitId) {
    db.prepare("UPDATE visits SET action_type = 'redeem', action_at = ?, is_approved = 1 WHERE id = ?")
      .run(t, visitId);
  }

  const after = calcPointsSummary(customerId);
  res.json({ ok: true, points: after });
});

// -------------------- Admin dashboard/stats --------------------

/**
 * Cashier of month: based on current month approved visits:
 * Rank by avgRating DESC, then washes DESC
 */
app.get("/api/admin/cashier-of-month", requireAuth(["admin"]), (req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const fromIso = from.toISOString().slice(0,10);

    const rows = db.prepare(`
      SELECT approved_by as cashier, COUNT(*) as washes, AVG(rating) as avgRating
      FROM visits
      WHERE is_approved = 1
        AND approved_by IS NOT NULL
        AND approved_at >= ?
      GROUP BY approved_by
      ORDER BY avgRating DESC, washes DESC
      LIMIT 1
    `).all(fromIso);

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
    const last = db.prepare(`
      SELECT c.id,
             (SELECT MAX(v.approved_at) FROM visits v WHERE v.customer_id = c.id AND v.is_approved=1) as last_approved
      FROM customers c
    `).all();

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



/* ===== Group3: Best Customers Dashboard ===== */
app.get("/api/admin/dashboard/best-customers", requireAuth(["admin"]), (req, res) => {
  try {
    const rows = db.prepare(`
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
    `).all();

    res.json({ ok:true, customers: rows });
  } catch(e) {
    res.json({ ok:false, error:"FAILED", message:e.message });
  }
});



/* ===== Group3: Cashier Performance ===== */
app.get("/api/admin/dashboard/cashiers", requireAuth(["admin"]), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        approved_by as cashier,
        COUNT(*) as washes,
        AVG(rating) as avg_rating
      FROM visits
      WHERE is_approved = 1
        AND approved_by IS NOT NULL
      GROUP BY approved_by
      ORDER BY washes DESC, avg_rating DESC
    `).all();

    res.json({ ok:true, cashiers: rows });
  } catch(e) {
    res.json({ ok:false, error:"FAILED", message:e.message });
  }
});


app.get("/api/admin/dashboard", requireAuth(["admin"]), (req, res) => {
  const avgRating =
    db.prepare("SELECT AVG(rating) as avgRating FROM visits WHERE is_approved = 1").get().avgRating || 0;

  const cashiers = db.prepare(
    `
    SELECT approved_by as cashier, COUNT(*) as washes, AVG(rating) as avgRating
    FROM visits
    WHERE is_approved = 1
    GROUP BY approved_by
    ORDER BY washes DESC
  `
  ).all();

  res.json({ ok: true, avgRating, cashiers });
});



// -------------------- Admin Notifications --------------------

/* ===== Group3: Notification controls ===== */

// Toggle notification types
app.post("/api/admin/notifications/settings", requireAuth(["admin"]), (req, res) => {
  const { two_bad, high_high_bad } = req.body || {};
  db.prepare(`
    UPDATE settings SET
      notify_two_bad = COALESCE(?, notify_two_bad),
      notify_high_high_bad = COALESCE(?, notify_high_high_bad)
    WHERE id = 1
  `).run(
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
  db.prepare(`DELETE FROM notifications WHERE id IN (${q})`).run(...ids);
  broadcastNoti();
  res.json({ ok:true, deleted: ids.length });
});


app.get("/api/admin/notifications", requireAuth(["admin"]), (req, res) => {
  const showAll = (req.query.all === "1");
  let sql = `
    SELECT n.*, c.name as customer_name, c.phone as customer_phone
    FROM notifications n
    JOIN customers c ON c.id = n.customer_id
  `;
  if (!showAll) sql += ` WHERE n.is_read = 0 `;
  sql += ` ORDER BY n.created_at DESC LIMIT 100 `;
  const rows = db.prepare(sql).all();
  res.json({ ok: true, notifications: rows });
});

// unread badge
app.get("/api/admin/notifications/unread-count", requireAuth(["admin"]), (req, res) => {
  const row = db.prepare("SELECT COUNT(*) as c FROM notifications WHERE is_read = 0").get();
  res.json({ ok: true, count: row.c || 0 });
});

// aliases (توافق/تسهيل اختبارات)
app.get("/api/admin/notifications/unreadCount", requireAuth(["admin"]), (req, res) => {
  const row = db.prepare("SELECT COUNT(*) as c FROM notifications WHERE is_read = 0").get();
  res.json({ ok: true, count: row.c || 0 });
});
app.get("/api/admin/notifications/unreadcount", requireAuth(["admin"]), (req, res) => {
  const row = db.prepare("SELECT COUNT(*) as c FROM notifications WHERE is_read = 0").get();
  res.json({ ok: true, count: row.c || 0 });
});


// stream count (SSE)
app.get("/api/admin/notifications/stream", requireAuth(["admin"]), (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (res.flushHeaders) res.flushHeaders();

  const send = (count) => {
    res.write("event: count\n");
    res.write("data: " + JSON.stringify({ count }) + "\n\n");
  };

  try {
    const row = db.prepare("SELECT COUNT(*) as c FROM notifications WHERE is_read = 0").get();
    send(row.c || 0);
  } catch (e) {
    send(0);
  }

  const onCount = (c) => send(c);
  notiEvents.on("count", onCount);

  const keep = setInterval(() => { res.write(":keep\n\n"); }, 25000);
  req.on("close", () => {
    clearInterval(keep);
    notiEvents.off("count", onCount);
  });
});

app.post("/api/admin/notifications/mark-read", requireAuth(["admin"]), (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "MISSING_ID" });
  db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ?").run(id);
  broadcastNoti();
  res.json({ ok: true });
});

app.post("/api/admin/notifications/clear", requireAuth(["admin"]), (req, res) => {
  db.prepare("DELETE FROM notifications").run();
  broadcastNoti();
  res.json({ ok: true });
});

app.get("/api/admin/notifications/detail", requireAuth(["admin"]), (req, res) => {
  const id = Number(req.query.id || 0);
  if (!id) return res.status(400).json({ ok: false, error: "MISSING_ID" });

  const notification = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
  if (!notification) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

  const customer = db.prepare("SELECT id, name, phone, created_at FROM customers WHERE id = ?").get(notification.customer_id);

  const visits = db.prepare(`
    SELECT v.id, v.created_at, v.rating, v.is_approved, v.approved_by,
           u.username as cashier_username, u.display_name as cashier_name,
           ve.plate_letters_ar, ve.plate_numbers
    FROM visits v
    JOIN vehicles ve ON ve.id = v.vehicle_id
    LEFT JOIN users u ON u.username = v.approved_by
    WHERE v.customer_id = ?
    ORDER BY v.created_at DESC
    LIMIT 50
  `).all(notification.customer_id);

  res.json({ ok: true, notification, customer, visits });
});

// Rolling stats (آخر 30 يوم)
app.get("/api/admin/stats/rolling", requireAuth(["admin"]), (req, res) => {
  const days = 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString().slice(0, 10);

  const cashierRows = db.prepare(
    `
    SELECT approved_by as cashier, COUNT(*) as washes, AVG(rating) as avgRating
    FROM visits
    WHERE is_approved = 1 AND approved_at >= ? AND approved_by IS NOT NULL
    GROUP BY approved_by
    ORDER BY washes DESC
  `
  ).all(sinceIso);

  const ratingDist = db.prepare(
    `
    SELECT rating, COUNT(*) as c
    FROM visits
    WHERE is_approved = 1 AND approved_at >= ?
    GROUP BY rating
    ORDER BY rating
  `
  ).all(sinceIso);

  const earnedCount = db.prepare(
    `SELECT COUNT(*) as c FROM points_ledger WHERE entry_type='earn' AND created_at >= ?`
  ).get(sinceIso).c || 0;

  const redeemedCount = db.prepare(
    `SELECT COUNT(*) as c FROM points_ledger WHERE entry_type='redeem' AND created_at >= ?`
  ).get(sinceIso).c || 0;

  res.json({
    ok: true,
    since: sinceIso,
    windowDays: days,
    cashierRows,
    ratingDist,
    earnedCount,
    redeemedCount,
  });
});

// -------------------- Settings (admin) --------------------
app.get("/api/admin/settings", requireAuth(["admin"]), (req, res) => {
  res.json({ ok: true, settings: getSettings() });
});

app.post("/api/admin/settings", requireAuth(["admin"]), (req, res) => {
  const {
    home_text_1,
    home_text_2,
    terms_text,
    social_whatsapp,
    social_snap,
    social_tiktok,
    social_maps,
    after_approve_text,
    points_add_limit,
    points_redeem_limit,
    points_per_visit,
  } = req.body || {};

  db.prepare(
    `
    UPDATE settings SET
      home_text_1 = COALESCE(?, home_text_1),
      home_text_2 = COALESCE(?, home_text_2),
      terms_text = COALESCE(?, terms_text),
      social_whatsapp = ?,
      social_snap = ?,
      social_tiktok = ?,
      social_maps = ?,
      after_approve_text = COALESCE(?, after_approve_text),
      points_add_limit = COALESCE(?, points_add_limit),
      points_redeem_limit = COALESCE(?, points_redeem_limit),
      points_per_visit = COALESCE(?, points_per_visit)
    WHERE id = 1
  `
  ).run(
    home_text_1 || null,
    home_text_2 || null,
    terms_text || null,
    social_whatsapp || null,
    social_snap || null,
    social_tiktok || null,
    social_maps || null,
    after_approve_text || null,
    points_add_limit ? Number(points_add_limit) : null,
    points_redeem_limit ? Number(points_redeem_limit) : null,
    points_per_visit ? Number(points_per_visit) : null
  );

  res.json({ ok: true, settings: getSettings() });
});

// -------------------- Users management --------------------
app.get("/api/admin/users", requireAuth(["admin"]), (req, res) => {
  const users = db
    .prepare("SELECT id, username, display_name, role, is_active, created_at FROM users ORDER BY created_at DESC")
    .all();
  res.json({ ok: true, users });
});

app.post("/api/admin/users/add", requireAuth(["admin"]), (req, res) => {
  const { username, password, role, display_name } = req.body || {};
  if (!username || !password || !role)
    return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
  if (!["admin", "cashier"].includes(role))
    return res.status(400).json({ ok: false, error: "BAD_ROLE" });

  const exists = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
  if (exists) return res.status(409).json({ ok: false, error: "USERNAME_EXISTS" });

  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)"
  ).run(uuid(), username, display_name || username, hash, role, nowIso());

  res.json({ ok: true });
});

app.post("/api/admin/users/update", requireAuth(["admin"]), (req, res) => {
  const { id, role, is_active, password } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "MISSING_ID" });

  if (role && !["admin", "cashier"].includes(role))
    return res.status(400).json({ ok: false, error: "BAD_ROLE" });

  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
  }
  if (role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  if (typeof is_active !== "undefined")
    db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(is_active ? 1 : 0, id);

  res.json({ ok: true });
});


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


app.post("/api/admin/users/delete", requireAuth(["admin"]), (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "MISSING_ID" });
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ ok: true });
});

// -------------------- Export --------------------

/* ===== Group2: Enhanced Excel Export ===== */
function buildExportRows() {
  return db.prepare(`
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
  `).all();
}


app.get("/api/admin/export/excel", requireAuth(["admin"]), async (req, res) => {
  const customers = db.prepare(
    `
    SELECT c.*,
      (SELECT COUNT(*) FROM visits v WHERE v.customer_id = c.id AND v.is_approved = 1) as visits_count,
      (SELECT COUNT(*) FROM points_ledger p WHERE p.customer_id = c.id AND p.entry_type = 'redeem') as redeem_count,
      (SELECT AVG(v.rating) FROM visits v WHERE v.customer_id = c.id AND v.is_approved = 1) as avg_rating
    FROM customers c
    ORDER BY c.created_at DESC
  `
  ).all();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Customers");
  ws.columns = [
    { header: "الاسم", key: "name", width: 22 },
    { header: "رقم الجوال", key: "phone", width: 16 },
    { header: "تاريخ التسجيل", key: "created_at", width: 22 },
    { header: "عدد الزيارات", key: "visits_count", width: 12 },
    { header: "مرات الاستبدال", key: "redeem_count", width: 12 },
    { header: "معدل التقييم", key: "avg_rating", width: 12 },
  ];

  customers.forEach((c) => {
    ws.addRow({
      name: c.name,
      phone: c.phone,
      created_at: c.created_at,
      visits_count: c.visits_count,
      redeem_count: c.redeem_count,
      avg_rating: c.avg_rating ? Number(c.avg_rating).toFixed(2) : "",
    });
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", "attachment; filename=vip-customers.xlsx");
  await wb.xlsx.write(res);
  res.end();
});


/* ===== Group2: Enhanced Word Export ===== */
function buildWordRows() {
  return buildExportRows();
}


app.get("/api/admin/export/word", requireAuth(["admin"]), async (req, res) => {
  const customers = db.prepare(
    `
    SELECT c.*,
      (SELECT COUNT(*) FROM visits v WHERE v.customer_id = c.id AND v.is_approved = 1) as visits_count,
      (SELECT COUNT(*) FROM points_ledger p WHERE p.customer_id = c.id AND p.entry_type = 'redeem') as redeem_count,
      (SELECT AVG(v.rating) FROM visits v WHERE v.customer_id = c.id AND v.is_approved = 1) as avg_rating
    FROM customers c
    ORDER BY c.created_at DESC
    LIMIT 200
  `
  ).all();

  const rows = [
    new TableRow({
      children: ["الاسم", "الجوال", "تاريخ التسجيل", "الزيارات", "الاستبدال", "معدل التقييم"].map(
        (t) =>
          new TableCell({
            children: [
              new Paragraph({
                children: [new TextRun({ text: t, bold: true })],
              }),
            ],
          })
      ),
    }),
  ];

  customers.forEach((c) => {
    rows.push(
      new TableRow({
        children: [
          c.name,
          c.phone,
          c.created_at,
          String(c.visits_count),
          String(c.redeem_count),
          c.avg_rating ? Number(c.avg_rating).toFixed(2) : "",
        ].map((t) => new TableCell({ children: [new Paragraph(String(t))] })),
      })
    );
  });

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: "تقرير عملاء VIP (مختصر)", bold: true })],
          }),
          new Paragraph(""),
          new Table({ rows }),
        ],
      },
    ],
  });

  const buf = await Packer.toBuffer(doc);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  res.setHeader("Content-Disposition", "attachment; filename=vip-customers.docx");
  res.send(buf);
});

// -------------------- API 404 + Error handler --------------------
app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: "NOT_FOUND", message: "المسار غير موجود" });
});

app.use((err, req, res, next) => {
  console.error("SERVER_ERROR", err);
  res.status(500).json({ ok: false, error: "SERVER_ERROR", message: "حدث خطأ بالخادم. أعد المحاولة." });
});

// catch-all for non-api
app.use((req, res) => {
  res.status(404).send("Not Found");
});

// -------------------- HTTP + HTTPS --------------------
const httpServer = http.createServer(app);
httpServer.listen(PORT, () => {
  console.log(`VIP Loyalty running on http://localhost:${PORT}`);
});

try {
  const certDir = path.join(__dirname, ".cert");
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir);

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const pems = selfsigned.generate(
      [{ name: "commonName", value: "VIP Loyalty" }],
      { days: 365, keySize: 2048 }
    );
    fs.writeFileSync(keyPath, pems.private, "utf8");
    fs.writeFileSync(certPath, pems.cert, "utf8");
  }

  const opts = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  https.createServer(opts, app).listen(HTTPS_PORT, () => {
    const ips = [];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === "IPv4" && !n.internal) ips.push(n.address);
      }
    }
    const ipHint = ips.length ? `https://${ips[0]}:${HTTPS_PORT}` : `https://localhost:${HTTPS_PORT}`;
    console.log(`HTTPS (camera): ${ipHint}  (قد تظهر رسالة تحذير - اختر متابعة)`);
  });
} catch (e) {
  console.log("HTTPS disabled:", e.message);
}





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

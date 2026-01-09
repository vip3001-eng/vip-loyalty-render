const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data.sqlite");
const db = new Database(dbPath);

function nowIso() {
  return new Date().toISOString();
}

function initDb() {
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      plate_letters_ar TEXT NOT NULL,
      plate_numbers TEXT NOT NULL,
      plate_numbers_norm TEXT NOT NULL,
      car_type TEXT,
      car_model TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vehicles_customer_plate ON vehicles(customer_id, plate_numbers_norm);

    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      notes TEXT,
      is_approved INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      approved_by TEXT,
      action_type TEXT, -- 'earn' | 'redeem' (��� ����� ��� ������ �� ���� QR)
      action_at TEXT,
      qr_token TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS points_ledger (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      visit_id TEXT,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('earn','redeem')),
      points INTEGER NOT NULL CHECK(points > 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(visit_id) REFERENCES visits(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      home_text_1 TEXT NOT NULL DEFAULT '����� �� �� ���� ������ VIP',
      home_text_2 TEXT NOT NULL DEFAULT '���� ��� ������ ����� ����� ����',
      terms_text TEXT NOT NULL DEFAULT '������ ��������: ...',
      social_whatsapp TEXT,
      social_snap TEXT,
      social_tiktok TEXT,
      social_maps TEXT,
      after_approve_text TEXT NOT NULL DEFAULT '������ ��� �������� ��������� �������',
      points_add_limit INTEGER NOT NULL DEFAULT 50,
      points_redeem_limit INTEGER NOT NULL DEFAULT 50,
      points_per_visit INTEGER NOT NULL DEFAULT 10
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','cashier')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );
  `);

  // Lightweight migrations (add missing columns safely)
  const cols = db.prepare("PRAGMA table_info(visits)").all().map(r=>r.name);
  if (!cols.includes("action_type")) db.exec("ALTER TABLE visits ADD COLUMN action_type TEXT");
  if (!cols.includes("action_at")) db.exec("ALTER TABLE visits ADD COLUMN action_at TEXT");

  // Users/notifications migrations
  try {
    const ucols = db.prepare("PRAGMA table_info(users)").all().map(r=>r.name);
    if(!ucols.includes("display_name")) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
  } catch(e) {}
  try {
    const ncols = db.prepare("PRAGMA table_info(notifications)").all().map(r=>r.name);
    if(!ncols.includes("meta")) db.exec("ALTER TABLE notifications ADD COLUMN meta TEXT");
  } catch(e) {}

  // Settings migrations (social maps + after approve text)
  try{
    const scols = db.prepare("PRAGMA table_info(settings)").all().map(r=>r.name);
    if(!scols.includes("terms_text")) db.exec("ALTER TABLE settings ADD COLUMN terms_text TEXT");
    if(!scols.includes("social_maps")) db.exec("ALTER TABLE settings ADD COLUMN social_maps TEXT");
    if(!scols.includes("after_approve_text")) db.exec("ALTER TABLE settings ADD COLUMN after_approve_text TEXT");
    if(!scols.includes("defaults_inited")) db.exec("ALTER TABLE settings ADD COLUMN defaults_inited INTEGER NOT NULL DEFAULT 0");
    // default terms_text if null
    db.prepare("UPDATE settings SET terms_text = COALESCE(terms_text, '������ ��������: ...') WHERE id = 1").run();
    // default after_approve_text if null
    db.prepare("UPDATE settings SET after_approve_text = COALESCE(after_approve_text, '������ ��� �������� ��������� �������') WHERE id = 1").run();
    // default defaults_inited if null
    db.prepare("UPDATE settings SET defaults_inited = COALESCE(defaults_inited, 0) WHERE id = 1").run();
  }catch(e){}

  // Ensure settings row exists
  db.prepare("INSERT OR IGNORE INTO settings (id) VALUES (1)").run();
}

function uuid() {
  // lightweight uuid v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Normalize: keep digits (Arabic-Indic & Latin) and map Arabic-Indic to Latin
function normalizePlateNumbers(input) {
  const map = {
    "0":"0","1":"1","2":"2","3":"3","4":"4","5":"5","6":"6","7":"7","8":"8","9":"9"
  };
  const s = String(input || "").trim();
  let out = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (map[ch]) out += map[ch];
  }
  return out;
}

function getCustomerByPhone(phone) {
  return db.prepare("SELECT * FROM customers WHERE phone = ?").get(phone);
}

function getVehicleByCustomerAndPlate(customerId, plateNumbersNorm) {
  return db.prepare("SELECT * FROM vehicles WHERE customer_id = ? AND plate_numbers_norm = ?").get(customerId, plateNumbersNorm);
}

function getSettings() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}

function calcPointsSummary(customerId) {
  const earned = db.prepare("SELECT COALESCE(SUM(points),0) as s FROM points_ledger WHERE customer_id = ? AND entry_type = 'earn'").get(customerId).s;
  const redeemed = db.prepare("SELECT COALESCE(SUM(points),0) as s FROM points_ledger WHERE customer_id = ? AND entry_type = 'redeem'").get(customerId).s;
  return { earned_points: earned, redeemed_points: redeemed, current_points: Math.max(0, earned - redeemed) };
}

// Patch INSERT statements that need ids: use triggers? easiest: override prepare wrappers? We'll provide helper for id creation at insert in seed.
module.exports = {
  db,
  initDb,
  nowIso,
  uuid,
  normalizePlateNumbers,
  getCustomerByPhone,
  getVehicleByCustomerAndPlate,
  getSettings,
  calcPointsSummary
};



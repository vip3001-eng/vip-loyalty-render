const bcrypt = require("bcryptjs");
const { db, initDb, nowIso, uuid } = require("./src/db");

initDb();

/**
 * ensureUser:
 * - إذا المستخدم غير موجود: ينشئه
 * - إذا موجود: يحدث كلمة المرور والدور ويعيد تفعيل الحساب
 *   (مفيد للتجارب المحلية حتى ما تعلق بسبب كلمات مرور قديمة)
 */
function ensureUser(username, password, role) {
  const hash = bcrypt.hashSync(password, 10);
  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username);

  if (!exists) {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    ).run(uuid(), username, hash, role, nowIso());
    return;
  }

  db.prepare(
    "UPDATE users SET password_hash = ?, role = ?, is_active = 1 WHERE username = ?"
  ).run(hash, role, username);
}

ensureUser("admin", "admin123", "admin");
ensureUser("cashier", "cashier123", "cashier");

// default socials example (can be changed from admin settings)
db.prepare(`
  UPDATE settings SET
    social_whatsapp = COALESCE(social_whatsapp, 'https://wa.me/966000000000'),
    social_snap = COALESCE(social_snap, 'https://www.snapchat.com/'),
    social_tiktok = COALESCE(social_tiktok, 'https://www.tiktok.com/'),
    social_maps = COALESCE(social_maps, 'https://maps.google.com/'),
    terms_text = COALESCE(terms_text, 'الشروط والأحكام: ...')
  WHERE id = 1
`).run();

console.log("Seed done. Default users ensured (admin/cashier) + passwords reset.");

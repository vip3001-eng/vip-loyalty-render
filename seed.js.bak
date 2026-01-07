const bcrypt = require("bcryptjs");
const { db, initDb, nowIso, uuid } = require("./src/db");

initDb();

/**
 * ensureUser:
 * - ط¥ط°ط§ ط§ظ„ظ…ط³طھط®ط¯ظ… ط؛ظٹط± ظ…ظˆط¬ظˆط¯: ظٹظ†ط´ط¦ظ‡
 * - ط¥ط°ط§ ظ…ظˆط¬ظˆط¯: ظٹط­ط¯ط« ظƒظ„ظ…ط© ط§ظ„ظ…ط±ظˆط± ظˆط§ظ„ط¯ظˆط± ظˆظٹط¹ظٹط¯ طھظپط¹ظٹظ„ ط§ظ„ط­ط³ط§ط¨
 *   (ظ…ظپظٹط¯ ظ„ظ„طھط¬ط§ط±ط¨ ط§ظ„ظ…ط­ظ„ظٹط© ط­طھظ‰ ظ…ط§ طھط¹ظ„ظ‚ ط¨ط³ط¨ط¨ ظƒظ„ظ…ط§طھ ظ…ط±ظˆط± ظ‚ط¯ظٹظ…ط©)
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
    terms_text = COALESCE(terms_text, 'ط§ظ„ط´ط±ظˆط· ظˆط§ظ„ط£ط­ظƒط§ظ…: ...')
  WHERE id = 1
`).run();

console.log("Seed done. Default users ensured (admin/cashier) + passwords reset.");




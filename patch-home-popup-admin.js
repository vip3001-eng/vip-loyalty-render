/**
 * Patch: Home Popup Admin Controls
 * - Adds DB columns: settings.home_popup_enabled, settings.home_popup_text
 * - Extends /api/admin/settings GET/POST to read & save them
 * - Adds controls in public/admin.html settings modal (checkbox + textarea)
 * Idempotent: safe to run multiple times.
 */
const fs = require("fs");

function upsertColumnInServerJs(serverPath){
  if(!fs.existsSync(serverPath)) throw new Error("server.js not found");
  let s = fs.readFileSync(serverPath, "utf8");

  // 1) Ensure columns are created on startup (server.js migrations area)
  // Add two ensureColumn lines after ensureColumn("settings","defaults_inited"...)
  if (!s.includes('ensureColumn("settings", "home_popup_enabled"')) {
    s = s.replace(
      /ensureColumn\("settings",\s*"defaults_inited",\s*"INTEGER NOT NULL DEFAULT 0"\);\s*/m,
      (m) => m +
        '  ensureColumn("settings", "home_popup_enabled", "INTEGER NOT NULL DEFAULT 0");\n' +
        '  ensureColumn("settings", "home_popup_text", "TEXT");\n'
    );
  }

  // 2) Extend GET /api/admin/settings response (it already returns getSettings(), so usually OK)
  // Nothing needed here unless getSettings() filters columns (we handle in POST too)

  // 3) Extend POST /api/admin/settings to accept + save home_popup_enabled/home_popup_text
  // Add variables to destructuring
  if (!s.includes("home_popup_enabled") || !s.includes("home_popup_text")) {
    s = s.replace(
      /const\s*\{\s*([\s\S]*?)\}\s*=\s*req\.body\s*\|\|\s*\{\}\s*;\s*/m,
      (full, inside) => {
        // only patch the admin settings handler block, not other handlers:
        // If this matched wrong place, keep safe by requiring after "/api/admin/settings" exists near it.
        return full;
      }
    );

    // Patch specifically inside admin settings POST handler block by targeting its destructure
    s = s.replace(
      /app\.post\("\/api\/admin\/settings"[\s\S]*?const\s*\{\s*([\s\S]*?)\}\s*=\s*req\.body\s*\|\|\s*\{\}\s*;/m,
      (block, inside) => {
        if (inside.includes("home_popup_enabled") || inside.includes("home_popup_text")) return block;
        const extra = "\n    home_popup_enabled,\n    home_popup_text,";
        return block.replace(inside, inside.replace(/\s*$/, "") + extra);
      }
    );

    // Add fields into UPDATE settings query
    if (!s.includes("home_popup_enabled =")) {
      s = s.replace(
        /after_approve_text\s*=\s*COALESCE\(\?,\s*after_approve_text\),/m,
        (m) => m + "\n      home_popup_enabled = COALESCE(?, home_popup_enabled),\n      home_popup_text = COALESCE(?, home_popup_text),"
      );
    }

    // Add values into .run(...) argument list (after_approve_text)
    // We insert right after after_approve_text || null,
    if (!s.includes("home_popup_enabled ?")) {
      s = s.replace(
        /after_approve_text\s*\|\|\s*null,\s*/m,
        (m) => m + "    (typeof home_popup_enabled !== 'undefined' ? (home_popup_enabled ? 1 : 0) : null),\n    (home_popup_text ?? null),\n"
      );
    }
  }

  fs.writeFileSync(serverPath, s, "utf8");
}

function patchAdminHtml(adminPath){
  if(!fs.existsSync(adminPath)) {
    console.log("⚠ admin.html not found (skipped):", adminPath);
    return;
  }
  let h = fs.readFileSync(adminPath, "utf8");

  // Add UI fields in settings modal: checkbox + textarea
  if (!h.includes('id="home_popup_enabled"')) {
    // Try to place after terms_text field (common)
    const ui = `
<!-- Home Popup (Admin-controlled) -->
<div class="field" style="margin-top:12px">
  <label style="display:flex;align-items:center;gap:10px">
    <input type="checkbox" id="home_popup_enabled" />
    <span>تفعيل الرسالة المنبثقة بالصفحة الرئيسية</span>
  </label>
</div>
<div class="field" style="margin-top:10px">
  <label>نص الرسالة المنبثقة</label>
  <textarea id="home_popup_text" rows="4" style="width:100%;resize:vertical"></textarea>
  <small style="opacity:.8">سيظهر النص مع زر “تم” عند تفعيلها.</small>
</div>
`;
    if (h.includes('id="terms_text"')) {
      h = h.replace(/(<textarea[^>]*id="terms_text"[\s\S]*?<\/textarea>)/m, `$1\n${ui}`);
    } else {
      // fallback: inject before settings save button or end of modal
      h = h.replace(/(<button[^>]*id="saveSettings"[\s\S]*?>)/m, `${ui}\n$1`);
    }
  }

  // Patch JS to load/save new fields
  // Look for code that sets inputs from settings (home_text_1/home_text_2/terms_text)
  // We add assignments for home_popup_enabled/home_popup_text.
  if (!h.includes("home_popup_enabled")) {
    h = h.replace(
      /(document\.getElementById\("home_text_1"\)[\s\S]*?;\s*)/m,
      (m) => m
    );
  }

  // Add in load settings handler: after fetch /api/admin/settings
  if (!h.includes('document.getElementById("home_popup_text")')) {
    h = h.replace(
      /(fetch\(["']\/api\/admin\/settings["']\)[\s\S]*?then\(d=>\{\s*const\s*s\s*=\s*d\.settings\s*\|\|\s*\{\};[\s\S]*?)(\}\)\s*;)/m,
      (prefix, tail) => {
        const inject = `
  try{
    const en = !!s.home_popup_enabled;
    const txt = (s.home_popup_text ?? "");
    const cb = document.getElementById("home_popup_enabled");
    const ta = document.getElementById("home_popup_text");
    if(cb) cb.checked = en;
    if(ta) ta.value = txt;
  }catch(e){}
`;
        // If already present, skip
        if (prefix.includes("home_popup_text")) return prefix + tail;
        return prefix + inject + tail;
      }
    );
  }

  // Add in save settings payload: include new fields
  if (!h.includes("home_popup_text:")) {
    h = h.replace(
      /(const\s+payload\s*=\s*\{[\s\S]*?\};)/m,
      (m) => {
        if (m.includes("home_popup_enabled") || m.includes("home_popup_text")) return m;
        // Insert before closing }
        return m.replace(/\}\s*;\s*$/m,
          `,
  home_popup_enabled: (document.getElementById("home_popup_enabled")?.checked || false),
  home_popup_text: (document.getElementById("home_popup_text")?.value || "")
};`
        );
      }
    );
  }

  fs.writeFileSync(adminPath, h, "utf8");
}

try{
  upsertColumnInServerJs("./server.js");
  patchAdminHtml("./public/admin.html");
  console.log("✅ Home popup admin controls patched successfully");
}catch(e){
  console.error("❌ Patch failed:", e.message);
  process.exit(1);
}

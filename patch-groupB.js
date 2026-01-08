"use strict";

const fs = require("fs");
const path = require("path");

function read(p){ return fs.readFileSync(p,"utf8"); }
function write(p,s){ fs.writeFileSync(p,s,"utf8"); }

function injectBeforeOnce(hay, marker, block, guard){
  if (hay.includes(guard)) return hay;
  const i = hay.indexOf(marker);
  if (i === -1) return null;
  return hay.slice(0,i) + block + "\n" + hay.slice(i);
}

function patchServer(){
  const server = path.join(process.cwd(),"server.js");
  if(!fs.existsSync(server)) throw new Error("server.js not found");
  let s = read(server);

  // Ensure DB columns exist (safe)
  if (!s.includes('home_popup_enabled')) {
    const needle = 'ensureColumn("users", "display_name", "TEXT");';
    if (s.includes(needle)) {
      s = s.replace(needle, needle + `
  // --- GroupB: popup + version (safe) ---
  ensureColumn("settings", "home_popup_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "home_popup_text", "TEXT");
  ensureColumn("settings", "home_popup_version", "INTEGER NOT NULL DEFAULT 1");
`);
    }
  }

  // Replace /api/admin/customer-search with stronger query (if exists)
  // If not exists, inject new one.
  const routeGuard = "GroupB: Admin customer search v2";
  if (!s.includes(routeGuard)) {

    // Remove old route if present (best-effort)
    s = s.replace(/\/\*\s*-+\s*GroupA:\s*Admin customer search[\s\S]*?app\.get\(\"\/api\/admin\/customer-search\"[\s\S]*?\n\}\);\n\n/g, "");

    const marker = '// -------------------- Settings (admin) --------------------';
    const block = `
/* -------------------- GroupB: Admin customer search v2 -------------------- */
function normalizePhoneToWa(phone){
  const d = String(phone||"").replace(/\\D+/g,"");
  if (!d) return "";
  if (d.length === 10 && d.startsWith("05")) return "966" + d.slice(1);
  if (d.startsWith("966")) return d;
  return d;
}

app.get("/api/admin/customer-search", requireAuth(["admin"]), (req,res)=>{
  const q = String((req.query.q||"")).trim();
  if (!q) return res.json({ ok:true, items: [] });

  const like = "%" + q.replace(/%/g,"") + "%";
  try{
    const rows = db.prepare(\`
      SELECT
        c.id as customer_id,
        c.name as name,
        c.phone as phone,

        -- آخر زيارة فعلياً
        (SELECT v.created_at
          FROM visits v
          WHERE v.customer_id=c.id
          ORDER BY v.created_at DESC
          LIMIT 1
        ) as last_visit_at,

        -- آخر لوحة (من آخر زيارة)
        (SELECT ve.plate_letters_ar||' '||ve.plate_numbers
          FROM visits v2
          JOIN vehicles ve ON ve.id=v2.vehicle_id
          WHERE v2.customer_id=c.id
          ORDER BY v2.created_at DESC
          LIMIT 1
        ) as last_plate,

        -- آخر عملية (اعتماد/استبدال) + المنفذ (لو متوفر)
        (SELECT COALESCE(MAX(v3.approved_at), MAX(v3.action_at))
          FROM visits v3
          WHERE v3.customer_id=c.id
        ) as last_action_at,

        (SELECT COALESCE(
            (SELECT v4.approved_by FROM visits v4 WHERE v4.customer_id=c.id AND v4.approved_by IS NOT NULL ORDER BY v4.approved_at DESC LIMIT 1),
            (SELECT v5.approved_by FROM visits v5 WHERE v5.customer_id=c.id AND v5.approved_by IS NOT NULL ORDER BY v5.action_at DESC LIMIT 1)
          )
        ) as last_actor

      FROM customers c
      WHERE c.phone LIKE ? OR c.name LIKE ?
      OR EXISTS (
        SELECT 1 FROM vehicles ve
        WHERE ve.customer_id=c.id
          AND (ve.plate_numbers LIKE ? OR ve.plate_numbers_norm LIKE ? OR ve.plate_letters_ar LIKE ?)
      )
      ORDER BY COALESCE(last_visit_at, c.created_at) DESC
      LIMIT 50
    \`).all(like, like, like, like, like);

    const items = rows.map(r=>{
      const wa = normalizePhoneToWa(r.phone);
      return {
        id: r.customer_id,
        name: r.name,
        phone: r.phone,
        last_visit_at: r.last_visit_at || null,
        last_plate: r.last_plate || "",
        last_action_at: r.last_action_at || null,
        last_actor: r.last_actor || "",
        wa_link: wa ? ("https://wa.me/" + wa) : ""
      };
    });

    res.json({ ok:true, items });
  }catch(e){
    res.json({ ok:false, error:"SERVER_ERROR" });
  }
});
`;
    const out = injectBeforeOnce(s, marker, block, routeGuard);
    if (out) s = out;
  }

  // Ensure admin popup endpoints exist (safe, no duplicates)
  if (!s.includes('/api/admin/home-popup')) {
    const marker = 'app.get("/api/admin/settings"';
    const block = `
/* -------------------- GroupB: Home popup (admin endpoints) -------------------- */
app.get("/api/admin/home-popup", requireAuth(["admin"]), (req,res)=>{
  try{
    const row = db.prepare("SELECT home_popup_enabled, home_popup_text, home_popup_version FROM settings WHERE id=1").get();
    res.json({ ok:true, enabled: !!(row && row.home_popup_enabled), text: (row && row.home_popup_text) ? String(row.home_popup_text) : "", version: Number((row && row.home_popup_version) || 1) });
  }catch(e){
    res.json({ ok:false, error:"SERVER_ERROR" });
  }
});

app.post("/api/admin/home-popup", requireAuth(["admin"]), (req,res)=>{
  try{
    const enabled = req.body && (req.body.enabled ? 1 : 0);
    const text = (req.body && typeof req.body.text !== "undefined") ? String(req.body.text) : "";
    db.prepare("UPDATE settings SET home_popup_enabled=?, home_popup_text=?, home_popup_version=COALESCE(home_popup_version,1)+1 WHERE id=1")
      .run(enabled, text);
    const row = db.prepare("SELECT home_popup_enabled, home_popup_text, home_popup_version FROM settings WHERE id=1").get();
    res.json({ ok:true, enabled: !!row.home_popup_enabled, text: row.home_popup_text||"", version: Number(row.home_popup_version||1) });
  }catch(e){
    res.json({ ok:false, error:"SERVER_ERROR" });
  }
});

`;
    const out = injectBeforeOnce(s, marker, block, 'GroupB: Home popup (admin endpoints)');
    if (out) s = out;
  }

  // Ensure public popup endpoint exists
  if (!s.includes('/api/public/home-popup')) {
    const marker = 'app.get("/api/public/settings"';
    const block = `
/* -------------------- GroupB: Home popup (public endpoint) -------------------- */
app.get("/api/public/home-popup",(req,res)=>{
  try{
    const row=db.prepare("SELECT home_popup_enabled,home_popup_text,home_popup_version FROM settings WHERE id=1").get();
    res.json({ok:true,enabled:!!(row&&row.home_popup_enabled),text:String((row&&row.home_popup_text)||""),version:Number((row&&row.home_popup_version)||1)});
  }catch(e){
    res.json({ok:true,enabled:false,text:"",version:1});
  }
});

`;
    const out = injectBeforeOnce(s, marker, block, 'GroupB: Home popup (public endpoint)');
    if (out) s = out;
  }

  write(server, s);
  console.log("✅ GroupB: server.js patched");
}

function patchIndexOnceOnly(){
  const f = path.join(process.cwd(),"public","index.html");
  if(!fs.existsSync(f)) { console.log("⚠ index.html not found"); return; }
  let h = read(f);

  // Replace any previous popup script with "once per device" logic (guarded)
  if (!h.includes("GroupB: Home popup once")) {
    const block = `
<!-- GroupB: Home popup once per device -->
<script>
(function(){
  fetch('/api/public/home-popup',{cache:'no-store'}).then(r=>r.json()).then(d=>{
    if(!d || !d.ok || !d.enabled) return;

    // ✅ مرة واحدة فقط لكل جهاز (حتى لو تغير الإصدار)
    // إذا تبيها "مرة لكل إصدار" غيّر ONCE_MODE = false
    var ONCE_MODE = true;

    var onceKey = 'vip_home_popup_seen_once';
    var versionKey = 'vip_home_popup_seen_v';
    var v = String(d.version||1);

    if(ONCE_MODE){
      if(localStorage.getItem(onceKey)==='1') return;
    }else{
      if(localStorage.getItem(versionKey)===v) return;
    }

    var overlay = document.getElementById('home-popup-overlay');
    var textEl  = document.getElementById('home-popup-text');
    var closeBtn= document.getElementById('home-popup-close');
    if(!overlay || !textEl || !closeBtn) return;

    textEl.textContent = d.text || '';
    overlay.style.display = 'flex';
    closeBtn.onclick = function(){
      try{
        if(ONCE_MODE) localStorage.setItem(onceKey,'1');
        else localStorage.setItem(versionKey, v);
      }catch(e){}
      overlay.style.display = 'none';
    };
  }).catch(()=>{});
})();
</script>
`;
    // If previous GroupA script exists, keep overlay and just inject v2 script near end.
    if (h.includes("</body>")) {
      h = h.replace("</body>", block + "\n</body>");
      write(f, h);
      console.log("✅ GroupB: index.html popup logic updated (once only)");
    }
  } else {
    console.log("ℹ GroupB popup logic already present");
  }
}

function patchAdminSearchUI(){
  const f = path.join(process.cwd(),"public","admin.html");
  if(!fs.existsSync(f)) { console.log("⚠ admin.html not found"); return; }
  let h = read(f);

  if (!h.includes("GroupB: Search cards v2")) {
    const block = `
<!-- GroupB: Search cards v2 -->
<script>
(function(){
  function fmt(dt){
    try{
      if(!dt) return '';
      const x = new Date(dt);
      if(isNaN(x.getTime())) return String(dt);
      return x.toLocaleString('ar-SA');
    }catch(e){ return String(dt||''); }
  }

  function ensureBox(){
    let box = document.getElementById('vip-search-results');
    if(box) return box;
    box = document.createElement('div');
    box.id = 'vip-search-results';
    box.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:10px;';
    document.body.appendChild(box);
    return box;
  }

  async function runSearch(q){
    const box = ensureBox();
    box.innerHTML = '<div style="color:#9aa0a6">... جارٍ البحث</div>';
    try{
      const r = await fetch('/api/admin/customer-search?q=' + encodeURIComponent(q), {cache:'no-store'});
      const d = await r.json();
      if(!d || !d.ok){ box.innerHTML='<div style="color:#ff6b6b">تعذر البحث</div>'; return; }
      const items = d.items || [];
      if(!items.length){ box.innerHTML='<div style="color:#9aa0a6">لا توجد نتائج</div>'; return; }

      box.innerHTML = items.map(it=>{
        const wa = it.wa_link ? '<a href="'+it.wa_link+'" target="_blank" style="background:#1f7a3a;color:#fff;padding:7px 12px;border-radius:10px;text-decoration:none;font-weight:900;">واتساب</a>' : '';
        const lastVisit = fmt(it.last_visit_at);
        const lastAction = fmt(it.last_action_at);
        const actor = (it.last_actor||'').trim();
        const meta = [
          lastVisit ? ('آخر زيارة: ' + lastVisit) : '',
          it.last_plate ? ('لوحة: ' + it.last_plate) : '',
          lastAction ? ('آخر عملية: ' + lastAction) : '',
          actor ? ('المنفّذ: ' + actor) : ''
        ].filter(Boolean).join(' — ');

        return `
          <div style="background:#0f0f12;border:1px solid #2a2a33;border-radius:14px;padding:12px;display:flex;justify-content:space-between;gap:12px;align-items:center;">
            <div style="min-width:0;">
              <div style="font-weight:950;font-size:16px">${(it.name||'—')}</div>
              <div style="color:#caa43b;font-weight:900;margin-top:2px">${(it.phone||'')}</div>
              <div style="color:#9aa0a6;font-size:12px;margin-top:6px;line-height:1.6">${meta || ''}</div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0;">${wa}</div>
          </div>
        `;
      }).join('');
    }catch(e){
      const box = ensureBox();
      box.innerHTML='<div style="color:#ff6b6b">تعذر البحث</div>';
    }
  }

  // Hook: if there's a bottom bar input "ابحث..." use it
  window.addEventListener('load', ()=>{
    const inputs = Array.from(document.querySelectorAll('input'));
    const input = inputs.find(i => (i.placeholder||'').includes('ابحث')) || inputs[inputs.length-1];
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent||'').trim()==='بحث');
    if(input){
      input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ const q=(input.value||'').trim(); if(q) runSearch(q); } });
    }
    if(btn && input){
      btn.addEventListener('click', ()=>{ const q=(input.value||'').trim(); if(q) runSearch(q); });
    }
  });
})();
</script>
`;
    if (h.includes("</body>")) {
      h = h.replace("</body>", block + "\n</body>");
      write(f, h);
      console.log("✅ GroupB: admin.html search cards upgraded");
    }
  } else {
    console.log("ℹ GroupB search UI already present");
  }
}

patchServer();
patchIndexOnceOnly();
patchAdminSearchUI();

console.log("✅ GroupB installed safely");

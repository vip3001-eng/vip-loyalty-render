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

function appendBeforeBodyEndOnce(h, block, guard){
  if (h.includes(guard)) return h;
  if (!h.includes("</body>")) return null;
  return h.replace("</body>", block + "\n</body>");
}

function patchServer(){
  const server = path.join(process.cwd(),"server.js");
  if(!fs.existsSync(server)) throw new Error("server.js not found");
  let s = read(server);

  // Add columns (safe) if ensureColumn exists in file
  if (!s.includes('home_popup_enabled')) {
    const needle = 'ensureColumn("users", "display_name", "TEXT");';
    if (s.includes(needle)) {
      s = s.replace(needle, needle + `
  // --- GroupB FIX: popup fields ---
  ensureColumn("settings", "home_popup_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "home_popup_text", "TEXT");
  ensureColumn("settings", "home_popup_version", "INTEGER NOT NULL DEFAULT 1");
`);
    }
  }

  // Customer search v2 endpoint
  const searchGuard = "GroupB FIX: Admin customer search v2";
  if (!s.includes(searchGuard)) {
    const marker = '// -------------------- Settings (admin) --------------------';
    const block = `
/* -------------------- GroupB FIX: Admin customer search v2 -------------------- */
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

        (SELECT v.created_at
          FROM visits v
          WHERE v.customer_id=c.id
          ORDER BY v.created_at DESC
          LIMIT 1
        ) as last_visit_at,

        (SELECT ve.plate_letters_ar||' '||ve.plate_numbers
          FROM visits v2
          JOIN vehicles ve ON ve.id=v2.vehicle_id
          WHERE v2.customer_id=c.id
          ORDER BY v2.created_at DESC
          LIMIT 1
        ) as last_plate,

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
    const out = injectBeforeOnce(s, marker, block, searchGuard);
    if (out) s = out;
  }

  // Admin popup endpoints
  const adminPopupGuard = "GroupB FIX: Home popup (admin endpoints)";
  if (!s.includes(adminPopupGuard)) {
    const marker = 'app.get("/api/admin/settings"';
    const block = `
/* -------------------- GroupB FIX: Home popup (admin endpoints) -------------------- */
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
    const out = injectBeforeOnce(s, marker, block, adminPopupGuard);
    if (out) s = out;
  }

  // Public popup endpoint
  const publicPopupGuard = "GroupB FIX: Home popup (public endpoint)";
  if (!s.includes(publicPopupGuard)) {
    const marker = 'app.get("/api/public/settings"';
    const block = `
/* -------------------- GroupB FIX: Home popup (public endpoint) -------------------- */
app.get("/api/public/home-popup",(req,res)=>{
  try{
    const row=db.prepare("SELECT home_popup_enabled,home_popup_text,home_popup_version FROM settings WHERE id=1").get();
    res.json({ok:true,enabled:!!(row&&row.home_popup_enabled),text:String((row&&row.home_popup_text)||""),version:Number((row&&row.home_popup_version)||1)});
  }catch(e){
    res.json({ok:true,enabled:false,text:"",version:1});
  }
});
`;
    const out = injectBeforeOnce(s, marker, block, publicPopupGuard);
    if (out) s = out;
  }

  write(server, s);
  console.log("✅ GroupB FIX: server.js patched");
}

function patchIndex(){
  const f = path.join(process.cwd(),"public","index.html");
  if(!fs.existsSync(f)) { console.log("⚠ index.html not found"); return; }
  let h = read(f);

  // Ensure overlay exists with our IDs
  if (!h.includes('id="home-popup-overlay"')) {
    const overlay = `
<!-- GroupB FIX: Home popup overlay -->
<div id="home-popup-overlay" style="display:none;position:fixed;inset:0;background:#000c;z-index:9999;align-items:center;justify-content:center;">
  <div style="background:#111;border:2px solid gold;color:#fff;padding:20px;border-radius:12px;max-width:90%;text-align:center;">
    <div id="home-popup-text" style="white-space:pre-wrap;line-height:1.8;"></div>
    <button id="home-popup-close" style="margin-top:15px;padding:10px 22px;background:gold;border:none;border-radius:10px;font-weight:900;">تم</button>
  </div>
</div>
`;
    const out = appendBeforeBodyEndOnce(h, overlay, "GroupB FIX: Home popup overlay");
    if (out) h = out;
  }

  // Once-only script (per device)
  if (!h.includes("GroupB FIX: Home popup once")) {
    const script = `
<!-- GroupB FIX: Home popup once -->
<script>
(function(){
  fetch('/api/public/home-popup',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(!d || !d.ok || !d.enabled) return;

    // ✅ مرة واحدة فقط لكل جهاز
    var onceKey = 'vip_home_popup_seen_once';
    try{ if(localStorage.getItem(onceKey)==='1') return; }catch(e){}

    var overlay = document.getElementById('home-popup-overlay');
    var textEl  = document.getElementById('home-popup-text');
    var closeBtn= document.getElementById('home-popup-close');
    if(!overlay || !textEl || !closeBtn) return;

    textEl.textContent = d.text || '';
    overlay.style.display = 'flex';
    closeBtn.onclick = function(){
      try{ localStorage.setItem(onceKey,'1'); }catch(e){}
      overlay.style.display = 'none';
    };
  }).catch(function(){});
})();
</script>
`;
    const out2 = appendBeforeBodyEndOnce(h, script, "GroupB FIX: Home popup once");
    if (out2) h = out2;
  }

  write(f, h);
  console.log("✅ GroupB FIX: index.html patched");
}

function patchAdmin(){
  const f = path.join(process.cwd(),"public","admin.html");
  if(!fs.existsSync(f)) { console.log("⚠ admin.html not found"); return; }
  let h = read(f);

  // Add admin panel for popup enable/text
  if (!h.includes("GroupB FIX: Admin popup panel")) {
    const panel = `
<!-- GroupB FIX: Admin popup panel -->
<script>
(function(){
  function el(tag, css, html){
    var e=document.createElement(tag);
    if(css) e.style.cssText=css;
    if(typeof html==='string') e.innerHTML=html;
    return e;
  }

  function mount(){
    if(document.getElementById('vip-home-popup-admin-panel')) return;

    var wrap = el('div',
      'background:#0f0f12;border:1px solid #2a2a33;border-radius:14px;padding:12px;margin:12px;'
    );
    wrap.id='vip-home-popup-admin-panel';
    wrap.innerHTML =
      '<div style="font-weight:950;margin-bottom:8px">رسالة الصفحة الرئيسية</div>'+
      '<label style="display:flex;align-items:center;gap:10px;margin-bottom:10px;color:#caa43b;font-weight:900">'+
        '<input id="vipPopupEnabled" type="checkbox" style="transform:scale(1.2)"/> تشغيل الرسالة'+
      '</label>'+
      '<textarea id="vipPopupText" rows="4" style="width:100%;background:#0b0b0f;color:#fff;border:1px solid #2a2a33;border-radius:12px;padding:10px;resize:vertical" placeholder="اكتب نص الرسالة هنا..."></textarea>'+
      '<button id="vipPopupSave" style="margin-top:10px;width:100%;padding:10px;border:none;border-radius:12px;background:gold;font-weight:950">حفظ</button>'+
      '<div id="vipPopupHint" style="margin-top:8px;color:#9aa0a6;font-size:12px">تظهر مرة واحدة لكل عميل (كل جهاز).</div>';

    // Insert near top of body (safe)
    document.body.insertBefore(wrap, document.body.firstChild);

    fetch('/api/admin/home-popup',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      if(!d || !d.ok) return;
      document.getElementById('vipPopupEnabled').checked = !!d.enabled;
      document.getElementById('vipPopupText').value = d.text || '';
    }).catch(function(){});

    document.getElementById('vipPopupSave').onclick = function(){
      var enabled = document.getElementById('vipPopupEnabled').checked;
      var text = document.getElementById('vipPopupText').value || '';
      fetch('/api/admin/home-popup',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({enabled: enabled, text: text})
      }).then(function(r){return r.json();}).then(function(d){
        alert(d && d.ok ? 'تم الحفظ' : 'تعذر الحفظ');
      }).catch(function(){ alert('تعذر الحفظ'); });
    };
  }

  window.addEventListener('load', mount);
})();
</script>
`;
    const out = appendBeforeBodyEndOnce(h, panel, "GroupB FIX: Admin popup panel");
    if (out) h = out;
  }

  // Upgrade search rendering (NO nested backticks)
  if (!h.includes("GroupB FIX: Search cards v2")) {
    const script = `
<!-- GroupB FIX: Search cards v2 -->
<script>
(function(){
  function fmt(dt){
    try{
      if(!dt) return '';
      var x = new Date(dt);
      if(isNaN(x.getTime())) return String(dt);
      return x.toLocaleString('ar-SA');
    }catch(e){ return String(dt||''); }
  }

  function ensureBox(){
    var box = document.getElementById('vip-search-results');
    if(box) return box;
    box = document.createElement('div');
    box.id = 'vip-search-results';
    box.style.cssText = 'margin:12px;display:flex;flex-direction:column;gap:10px;';
    document.body.appendChild(box);
    return box;
  }

  function card(it){
    var wa = it.wa_link ? '<a href="'+it.wa_link+'" target="_blank" style="background:#1f7a3a;color:#fff;padding:7px 12px;border-radius:10px;text-decoration:none;font-weight:900;">واتساب</a>' : '';
    var metaParts = [];
    if(it.last_visit_at) metaParts.push('آخر زيارة: ' + fmt(it.last_visit_at));
    if(it.last_plate) metaParts.push('لوحة: ' + it.last_plate);
    if(it.last_action_at) metaParts.push('آخر عملية: ' + fmt(it.last_action_at));
    if(it.last_actor) metaParts.push('المنفّذ: ' + it.last_actor);
    var meta = metaParts.join(' — ');

    return ''
    + '<div style="background:#0f0f12;border:1px solid #2a2a33;border-radius:14px;padding:12px;display:flex;justify-content:space-between;gap:12px;align-items:center;">'
    +   '<div style="min-width:0;">'
    +     '<div style="font-weight:950;font-size:16px">' + (it.name||'—') + '</div>'
    +     '<div style="color:#caa43b;font-weight:900;margin-top:2px">' + (it.phone||'') + '</div>'
    +     '<div style="color:#9aa0a6;font-size:12px;margin-top:6px;line-height:1.6">' + (meta||'') + '</div>'
    +   '</div>'
    +   '<div style="display:flex;gap:8px;flex-shrink:0;">' + wa + '</div>'
    + '</div>';
  }

  async function runSearch(q){
    var box = ensureBox();
    box.innerHTML = '<div style="color:#9aa0a6">... جارٍ البحث</div>';
    try{
      var r = await fetch('/api/admin/customer-search?q=' + encodeURIComponent(q), {cache:'no-store'});
      var d = await r.json();
      if(!d || !d.ok){ box.innerHTML='<div style="color:#ff6b6b">تعذر البحث</div>'; return; }
      var items = d.items || [];
      if(!items.length){ box.innerHTML='<div style="color:#9aa0a6">لا توجد نتائج</div>'; return; }
      box.innerHTML = items.map(card).join('');
    }catch(e){
      box.innerHTML='<div style="color:#ff6b6b">تعذر البحث</div>';
    }
  }

  window.addEventListener('load', function(){
    var inputs = Array.from(document.querySelectorAll('input'));
    var input = inputs.find(function(i){ return (i.placeholder||'').includes('ابحث'); }) || inputs[inputs.length-1];
    var btn = Array.from(document.querySelectorAll('button')).find(function(b){ return (b.textContent||'').trim()==='بحث'; });
    if(input){
      input.addEventListener('keydown', function(e){
        if(e.key==='Enter'){
          var q=(input.value||'').trim();
          if(q) runSearch(q);
        }
      });
    }
    if(btn && input){
      btn.addEventListener('click', function(){
        var q=(input.value||'').trim();
        if(q) runSearch(q);
      });
    }
  });
})();
</script>
`;
    const out2 = appendBeforeBodyEndOnce(h, script, "GroupB FIX: Search cards v2");
    if (out2) h = out2;
  }

  write(f, h);
  console.log("✅ GroupB FIX: admin.html patched");
}

patchServer();
patchIndex();
patchAdmin();
console.log("✅ GroupB FIX installed safely");

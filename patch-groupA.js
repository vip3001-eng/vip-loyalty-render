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

function ensureInServerMigrations(serverTxt){
  // add settings columns safely near existing ensureColumn calls
  if (serverTxt.includes('home_popup_enabled') && serverTxt.includes('customer_search')) return serverTxt;

  const needle = 'ensureColumn("users", "display_name", "TEXT");';
  if (!serverTxt.includes(needle)) return serverTxt; // don't break if structure changed

  const add = `
  // --- GroupA: home popup + customer search columns (safe) ---
  ensureColumn("settings", "home_popup_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "home_popup_text", "TEXT");
  ensureColumn("settings", "home_popup_version", "INTEGER NOT NULL DEFAULT 1");
  // marker only:
  // customer_search
`;
  if (serverTxt.includes(add.trim())) return serverTxt;
  return serverTxt.replace(needle, needle + add);
}

function ensureServerRoutes(serverTxt){
  // 1) public home popup endpoint (insert before /api/public/settings)
  if (!serverTxt.includes('/api/public/home-popup')) {
    const marker = 'app.get("/api/public/settings"';
    const block = `
/* -------------------- GroupA: Home popup (public) -------------------- */
app.get("/api/public/home-popup",(req,res)=>{
  try{
    const row = db.prepare("SELECT home_popup_enabled, home_popup_text, home_popup_version FROM settings WHERE id=1").get();
    res.json({ ok:true, enabled: !!(row && row.home_popup_enabled), text: (row && row.home_popup_text) ? String(row.home_popup_text) : "", version: Number((row && row.home_popup_version) || 1) });
  }catch(e){
    res.json({ ok:true, enabled:false, text:"", version:1 });
  }
});

`;
    const out = injectBeforeOnce(serverTxt, marker, block, 'GroupA: Home popup (public)');
    if (out) serverTxt = out;
  }

  // 2) admin popup endpoints (insert before /api/admin/settings)
  if (!serverTxt.includes('/api/admin/home-popup')) {
    const marker = 'app.get("/api/admin/settings"';
    const block = `
/* -------------------- GroupA: Home popup (admin) -------------------- */
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
    // bump version so clients show once again after change
    db.prepare("UPDATE settings SET home_popup_enabled=?, home_popup_text=?, home_popup_version=COALESCE(home_popup_version,1)+1 WHERE id=1")
      .run(enabled, text);
    const row = db.prepare("SELECT home_popup_enabled, home_popup_text, home_popup_version FROM settings WHERE id=1").get();
    res.json({ ok:true, enabled: !!row.home_popup_enabled, text: row.home_popup_text||"", version: Number(row.home_popup_version||1) });
  }catch(e){
    res.json({ ok:false, error:"SERVER_ERROR" });
  }
});

`;
    const out = injectBeforeOnce(serverTxt, marker, block, 'GroupA: Home popup (admin)');
    if (out) serverTxt = out;
  }

  // 3) customer search endpoint (insert before Settings section marker)
  if (!serverTxt.includes('/api/admin/customer-search')) {
    const marker = '// -------------------- Settings (admin) --------------------';
    const block = `
/* -------------------- GroupA: Admin customer search -------------------- */
function normalizePhoneToWa(phone){
  const d = String(phone||"").replace(/\\D+/g,"");
  if (!d) return "";
  // KSA: 05xxxxxxxx -> 9665xxxxxxxx
  if (d.length === 10 && d.startsWith("05")) return "966" + d.slice(1);
  if (d.startsWith("966")) return d;
  return d;
}

app.get("/api/admin/customer-search", requireAuth(["admin"]), (req,res)=>{
  const q = String((req.query.q||"")).trim();
  if (!q) return res.json({ ok:true, items: [] });

  const like = "%" + q.replace(/%/g,"") + "%";
  try{
    // latest visit per customer + one vehicle plate snapshot
    const rows = db.prepare(`
      SELECT
        c.id as customer_id,
        c.name as name,
        c.phone as phone,
        (SELECT MAX(v.created_at) FROM visits v WHERE v.customer_id=c.id) as last_visit_at,
        (SELECT v2.created_at FROM visits v2 WHERE v2.customer_id=c.id ORDER BY v2.created_at DESC LIMIT 1) as last_visit_at2,
        (SELECT ve.plate_letters_ar||' '||ve.plate_numbers FROM vehicles ve
          JOIN visits v3 ON v3.vehicle_id=ve.id
          WHERE v3.customer_id=c.id
          ORDER BY v3.created_at DESC LIMIT 1
        ) as last_plate
      FROM customers c
      WHERE c.phone LIKE ? OR c.name LIKE ?
      OR EXISTS (
        SELECT 1 FROM vehicles ve
        WHERE ve.customer_id=c.id
          AND (ve.plate_numbers LIKE ? OR ve.plate_numbers_norm LIKE ? OR ve.plate_letters_ar LIKE ?)
      )
      ORDER BY COALESCE(last_visit_at2,last_visit_at) DESC
      LIMIT 50
    `).all(like, like, like, like, like);

    const items = rows.map(r=>{
      const wa = normalizePhoneToWa(r.phone);
      return {
        id: r.customer_id,
        name: r.name,
        phone: r.phone,
        last_visit_at: r.last_visit_at2 || r.last_visit_at || null,
        last_plate: r.last_plate || "",
        wa_link: wa ? ("https://wa.me/" + wa) : ""
      };
    });

    res.json({ ok:true, items });
  }catch(e){
    res.json({ ok:false, error:"SERVER_ERROR" });
  }
});

`;
    const out = injectBeforeOnce(serverTxt, marker, block, 'GroupA: Admin customer search');
    if (out) serverTxt = out;
  }

  return serverTxt;
}

function patchServer(){
  const server = path.join(process.cwd(),"server.js");
  if (!fs.existsSync(server)) throw new Error("server.js not found");
  let s = read(server);

  s = ensureInServerMigrations(s);
  s = ensureServerRoutes(s);

  write(server, s);
  console.log("✅ GroupA: server.js patched");
}

function patchIndex(){
  const f = path.join(process.cwd(),"public","index.html");
  if (!fs.existsSync(f)) { console.log("⚠ index.html not found, skipped"); return; }
  let h = read(f);

  if (!h.includes('id="home-popup-overlay"')) {
    const block = `
<!-- GroupA: Home popup (shows once per device per version) -->
<div id="home-popup-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99999;align-items:center;justify-content:center;">
  <div style="background:#0f0f12;border:2px solid #caa43b;color:#fff;padding:18px;border-radius:14px;max-width:92%;width:420px;text-align:center;">
    <div id="home-popup-text" style="white-space:pre-wrap;line-height:1.8;"></div>
    <button id="home-popup-close" style="margin-top:14px;padding:10px 22px;background:#caa43b;border:none;border-radius:10px;font-weight:700;">تم</button>
  </div>
</div>
<script>
(function(){
  fetch('/api/public/home-popup',{cache:'no-store'}).then(r=>r.json()).then(d=>{
    if(!d || !d.ok || !d.enabled) return;
    var v = String(d.version || 1);
    var key = 'vip_home_popup_seen_v';
    if(localStorage.getItem(key) === v) return; // show مرة وحدة
    var overlay = document.getElementById('home-popup-overlay');
    var textEl  = document.getElementById('home-popup-text');
    var closeBtn= document.getElementById('home-popup-close');
    if(!overlay || !textEl || !closeBtn) return;
    textEl.textContent = d.text || '';
    overlay.style.display = 'flex';
    closeBtn.onclick = function(){
      try{ localStorage.setItem(key, v); }catch(e){}
      overlay.style.display = 'none';
    };
  }).catch(()=>{});
})();
</script>
`;
    // insert before </body>
    if (h.includes("</body>")) {
      h = h.replace("</body>", block + "\n</body>");
      write(f, h);
      console.log("✅ GroupA: index.html popup injected");
    } else {
      console.log("⚠ index.html has no </body>, skipped");
    }
  } else {
    console.log("ℹ index.html popup already present");
  }
}

function patchAdmin(){
  const f = path.join(process.cwd(),"public","admin.html");
  if (!fs.existsSync(f)) { console.log("⚠ admin.html not found, skipped"); return; }
  let h = read(f);

  // Inject a small popup-config button + modal (independent, won't break layout)
  if (!h.includes("vip-popup-config-modal")) {
    const block = `
<!-- GroupA: Home popup config (admin) + Customer search enhance -->
<div id="vip-popup-config-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:99999;align-items:center;justify-content:center;">
  <div style="background:#0f0f12;border:2px solid #caa43b;color:#fff;padding:16px;border-radius:14px;max-width:92%;width:520px;">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div style="font-weight:800;">رسالة الصفحة الرئيسية</div>
      <button id="vip-popup-close-modal" style="background:transparent;border:1px solid #444;color:#fff;border-radius:10px;padding:6px 10px;">✕</button>
    </div>
    <label style="display:block;margin-top:12px;">
      <input id="vip-popup-enabled" type="checkbox" style="transform:scale(1.2);margin-inline-end:8px;"> تشغيل الرسالة
    </label>
    <textarea id="vip-popup-textarea" rows="5" style="width:100%;margin-top:10px;background:#15151a;color:#fff;border:1px solid #333;border-radius:10px;padding:10px;resize:vertical;" placeholder="اكتب نص الرسالة..."></textarea>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px;">
      <button id="vip-popup-save" style="background:#caa43b;border:none;border-radius:10px;padding:10px 14px;font-weight:800;">حفظ</button>
    </div>
    <div id="vip-popup-hint" style="margin-top:10px;color:#9aa0a6;font-size:12px;">* تظهر للعميل مرة واحدة لكل جهاز بعد كل تعديل (version).</div>
  </div>
</div>

<button id="vip-open-popup-config" style="position:fixed;bottom:16px;left:16px;z-index:9999;background:#0f0f12;border:1px solid #caa43b;color:#caa43b;border-radius:999px;padding:10px 14px;font-weight:800;">
  رسالة الرئيسية
</button>

<script>
(function(){
  // Popup config
  const openBtn = document.getElementById('vip-open-popup-config');
  const modal = document.getElementById('vip-popup-config-modal');
  const closeBtn = document.getElementById('vip-popup-close-modal');
  const enabledEl = document.getElementById('vip-popup-enabled');
  const textEl = document.getElementById('vip-popup-textarea');
  const saveBtn = document.getElementById('vip-popup-save');
  const hint = document.getElementById('vip-popup-hint');

  function openModal(){
    modal.style.display = 'flex';
    fetch('/api/admin/home-popup',{cache:'no-store'}).then(r=>r.json()).then(d=>{
      if(!d || !d.ok) return;
      enabledEl.checked = !!d.enabled;
      textEl.value = d.text || '';
      hint.textContent = '* الإصدار الحالي: ' + (d.version||1) + ' — تظهر مرة واحدة لكل جهاز.';
    }).catch(()=>{});
  }
  function closeModal(){ modal.style.display = 'none'; }

  if(openBtn && modal && closeBtn && saveBtn){
    openBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e)=>{ if(e.target===modal) closeModal(); });

    saveBtn.addEventListener('click', ()=>{
      fetch('/api/admin/home-popup',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ enabled: enabledEl.checked, text: textEl.value })
      }).then(r=>r.json()).then(d=>{
        if(d && d.ok){
          hint.textContent = '✅ تم الحفظ. الإصدار الجديد: ' + (d.version||1);
          setTimeout(closeModal, 600);
        }else{
          hint.textContent = '❌ تعذر الحفظ';
        }
      }).catch(()=>{ hint.textContent='❌ تعذر الحفظ'; });
    });
  }

  // Customer search: hook any search box + render results with last visit date/time + WhatsApp
  function fmt(dt){
    try{
      if(!dt) return '';
      const x = new Date(dt);
      if(isNaN(x.getTime())) return String(dt);
      return x.toLocaleString('ar-SA');
    }catch(e){ return String(dt||''); }
  }

  function findSearchUI(){
    const inputs = Array.from(document.querySelectorAll('input')).filter(i=>{
      const ph = (i.getAttribute('placeholder')||'');
      return ph.includes('ابحث') || ph.includes('الجوال') || ph.includes('اللوحة') || ph.includes('الاسم');
    });
    const input = inputs[inputs.length-1];
    if(!input) return null;
    const btn = Array.from(document.querySelectorAll('button')).find(b=>{
      const t = (b.textContent||'').trim();
      return t === 'بحث' || t.includes('بحث');
    });
    return { input, btn };
  }

  function ensureResultsBox(){
    let box = document.getElementById('vip-search-results');
    if(box) return box;
    box = document.createElement('div');
    box.id = 'vip-search-results';
    box.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:10px;';
    // try to insert near bottom search panel
    const ui = findSearchUI();
    if(ui && ui.input && ui.input.parentElement){
      ui.input.parentElement.appendChild(box);
    }else{
      document.body.appendChild(box);
    }
    return box;
  }

  async function runSearch(q){
    const box = ensureResultsBox();
    box.innerHTML = '<div style="color:#9aa0a6">... جارٍ البحث</div>';
    try{
      const r = await fetch('/api/admin/customer-search?q=' + encodeURIComponent(q), {cache:'no-store'});
      const d = await r.json();
      if(!d || !d.ok){ box.innerHTML='<div style="color:#ff6b6b">تعذر البحث</div>'; return; }
      const items = d.items || [];
      if(!items.length){ box.innerHTML='<div style="color:#9aa0a6">لا توجد نتائج</div>'; return; }
      box.innerHTML = items.map(it=>{
        const wa = it.wa_link ? '<a href="'+it.wa_link+'" target="_blank" style="background:#1f7a3a;color:#fff;padding:6px 10px;border-radius:10px;text-decoration:none;font-weight:800;">واتساب</a>' : '';
        return `
          <div style="background:#0f0f12;border:1px solid #2a2a33;border-radius:14px;padding:12px;display:flex;justify-content:space-between;gap:12px;align-items:center;">
            <div style="min-width:0;">
              <div style="font-weight:900">${(it.name||'—')}</div>
              <div style="color:#caa43b;font-weight:800">${(it.phone||'')}</div>
              <div style="color:#9aa0a6;font-size:12px">آخر زيارة: ${fmt(it.last_visit_at)} ${it.last_plate?(' — لوحة: '+it.last_plate):''}</div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0;">${wa}</div>
          </div>
        `;
      }).join('');
    }catch(e){
      const box = ensureResultsBox();
      box.innerHTML='<div style="color:#ff6b6b">تعذر البحث</div>';
    }
  }

  window.addEventListener('load', ()=>{
    const ui = findSearchUI();
    if(!ui) return;
    const {input, btn} = ui;
    if(btn){
      btn.addEventListener('click', ()=>{ const q=(input.value||'').trim(); if(q) runSearch(q); });
    }
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ const q=(input.value||'').trim(); if(q) runSearch(q);} });
  });
})();
</script>
`;
    if (h.includes("</body>")) {
      h = h.replace("</body>", block + "\n</body>");
      write(f, h);
      console.log("✅ GroupA: admin.html enhanced (popup config + better search results)");
    } else {
      console.log("⚠ admin.html has no </body>, skipped");
    }
  } else {
    console.log("ℹ admin.html enhancements already present");
  }
}

patchServer();
patchIndex();
patchAdmin();

console.log("✅ GroupA installed safely");

const fs = require("fs");

function read(p){ return fs.readFileSync(p,"utf8"); }
function write(p,s){ fs.writeFileSync(p,s,"utf8"); }

function ensureOnceInsert(text, needle, insert){
  if(text.includes(insert.trim())) return text;
  const i = text.indexOf(needle);
  if(i === -1) throw new Error("Insert marker not found: " + needle.slice(0,40));
  return text.slice(0,i) + insert + "\n" + text.slice(i);
}

function patchServer(){
  const p = "./server.js";
  let s = read(p);

  // 1) Ensure settings columns for home popup (safe: uses existing ensureColumn if present)
  if(!s.includes('ensureColumn("settings", "home_popup_enabled"')){
    const marker = 'ensureColumn("settings", "defaults_inited"';
    const addCols = `
  ensureColumn("settings", "home_popup_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("settings", "home_popup_text", "TEXT");
`;
    s = s.replace(marker, marker + '\n' + addCols);
  }

  // 2) Public endpoint: /api/public/home-popup
  if(!s.includes('"/api/public/home-popup"')){
    const insertBefore = 'app.get("/api/public/settings"';
    const block = `
/* ==================== Home Popup (Public) ==================== */
app.get("/api/public/home-popup",(req,res)=>{
  try{
    const row = db.prepare("SELECT home_popup_enabled, home_popup_text FROM settings WHERE id=1").get();
    res.json({ ok:true, enabled: !!(row && row.home_popup_enabled), text: (row && row.home_popup_text) ? String(row.home_popup_text) : "" });
  }catch(e){
    res.json({ ok:true, enabled:false, text:"" });
  }
});
/* ==================== /Home Popup ==================== */
`;
    s = ensureOnceInsert(s, insertBefore, block);
  }

  // 3) Admin endpoints to manage popup safely (without touching existing settings update)
  if(!s.includes('"/api/admin/home-popup"')){
    const insertBefore = 'app.get("/api/admin/settings"';
    const block = `
/* ==================== Home Popup (Admin) ==================== */
app.get("/api/admin/home-popup", requireAuth(["admin"]), (req,res)=>{
  try{
    const row = db.prepare("SELECT home_popup_enabled, home_popup_text FROM settings WHERE id=1").get();
    res.json({ ok:true, enabled: !!(row && row.home_popup_enabled), text: (row && row.home_popup_text) ? String(row.home_popup_text) : "" });
  }catch(e){
    res.json({ ok:false, error:"SERVER_ERROR" });
  }
});

app.post("/api/admin/home-popup", requireAuth(["admin"]), (req,res)=>{
  try{
    const enabledRaw = req.body && req.body.enabled;
    const textRaw = req.body && req.body.text;

    const enabled = (enabledRaw === true || enabledRaw === "1" || enabledRaw === 1 || enabledRaw === "true");
    const text = (textRaw ?? "").toString();

    db.prepare("UPDATE settings SET home_popup_enabled = ?, home_popup_text = ? WHERE id = 1")
      .run(enabled ? 1 : 0, text);

    res.json({ ok:true });
  }catch(e){
    res.json({ ok:false, error:"SERVER_ERROR" });
  }
});
/* ==================== /Home Popup (Admin) ==================== */
`;
    s = ensureOnceInsert(s, insertBefore, block);
  }

  write(p, s);
}

function patchIndex(){
  const p = "./public/index.html";
  let h = read(p);

  if(!h.includes('id="home-popup"')){
    const block = `
<!-- ===== Home Popup ===== -->
<div id="home-popup" style="display:none;position:fixed;inset:0;background:#000c;z-index:9999;align-items:center;justify-content:center">
  <div style="background:#111;border:2px solid gold;color:#fff;padding:18px;border-radius:12px;max-width:92%;text-align:center">
    <div id="home-popup-text" style="white-space:pre-line;line-height:1.8"></div>
    <button id="home-popup-close" style="margin-top:14px;padding:10px 22px;background:gold;border:none;border-radius:10px;font-weight:800">تم</button>
  </div>
</div>
<script>
(async function(){
  try{
    const r = await fetch('/api/public/home-popup', {cache:'no-store'});
    const d = await r.json();
    if(!d || !d.enabled) return;

    const text = (d.text||'').toString().trim();
    if(!text) return;

    // ✅ يظهر مرة واحدة فقط لكل عميل لكل نص (إذا تغيّر النص يظهر مرة ثانية مرة واحدة)
    const key = 'vip_home_popup_seen_text_v1';
    const seenText = localStorage.getItem(key) || '';
    if(seenText === text) return;

    document.getElementById('home-popup-text').innerText = text;
    const box = document.getElementById('home-popup');
    box.style.display = 'flex';

    document.getElementById('home-popup-close').onclick = function(){
      box.style.display = 'none';
      try{ localStorage.setItem(key, text); }catch(e){}
    };
  }catch(e){}
})();
</script>
<!-- ===== /Home Popup ===== -->
`;
    h = h.replace(/<\/body>/i, block + "\n</body>");
    write(p, h);
  }
}

function patchAdminHtml(){
  const p = "./public/admin.html";
  if(!fs.existsSync(p)) return; // لو ما عندك صفحة أدمن في public ما نكسر شيء
  let h = read(p);

  // 1) Add Home Popup Admin Box (simple box, independent of existing settings modal)
  if(!h.includes('id="vipHomePopupBox"')){
    const box = `
<!-- ==================== Home Popup Admin Box ==================== -->
<div id="vipHomePopupBox" style="margin:14px 0;padding:12px;border:2px solid gold;border-radius:12px;background:#111;color:#fff">
  <div style="font-weight:800;margin-bottom:8px">رسالة الصفحة الرئيسية</div>
  <label style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
    <input id="vipHomePopupEnabled" type="checkbox" />
    <span>تشغيل الرسالة</span>
  </label>
  <textarea id="vipHomePopupText" rows="4" placeholder="اكتب نص الرسالة هنا..." style="width:100%;padding:10px;border-radius:10px;border:1px solid #333;background:#000;color:#fff;resize:vertical"></textarea>
  <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
    <button id="vipHomePopupSave" style="padding:10px 14px;border-radius:10px;border:none;background:gold;color:#000;font-weight:800">حفظ</button>
    <span id="vipHomePopupMsg" style="opacity:.85"></span>
  </div>
  <div style="margin-top:8px;opacity:.75;font-size:12px">
    ملاحظة: الرسالة تظهر للعميل مرة واحدة فقط لكل نص. إذا غيّرت النص ستظهر مرة واحدة من جديد.
  </div>
</div>
<!-- ==================== /Home Popup Admin Box ==================== -->
<script id="vipHomePopupAdminJS">
(async function(){
  const enabledEl = document.getElementById('vipHomePopupEnabled');
  const textEl = document.getElementById('vipHomePopupText');
  const msgEl = document.getElementById('vipHomePopupMsg');
  const saveBtn = document.getElementById('vipHomePopupSave');

  async function load(){
    try{
      const r = await fetch('/api/admin/home-popup', {credentials:'include', cache:'no-store'});
      const d = await r.json();
      if(d && d.ok){
        enabledEl.checked = !!d.enabled;
        textEl.value = d.text || '';
      }
    }catch(e){}
  }

  async function save(){
    msgEl.textContent = '... جاري الحفظ';
    try{
      const r = await fetch('/api/admin/home-popup',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        credentials:'include',
        body: JSON.stringify({ enabled: enabledEl.checked, text: textEl.value || '' })
      });
      const d = await r.json();
      msgEl.textContent = (d && d.ok) ? '✅ تم الحفظ' : '❌ فشل الحفظ';
    }catch(e){
      msgEl.textContent = '❌ خطأ اتصال';
    }
    setTimeout(()=>{ msgEl.textContent=''; }, 2000);
  }

  saveBtn.addEventListener('click', save);
  load();
})();
</script>
`;
    h = h.replace(/<\/body>/i, box + "\n</body>");
  }

  // 2) Improve customer search rendering: add last visit date/time in result + modal (only if the search script exists)
  if(h.includes('vipCustomerSearchBoxJS') && !h.includes('آخر زيارة')){
    // add to cards
    h = h.replace(
      /<div style="opacity:\.9">لوحة: '\+\(\(x\.plate_letters_ar\|\|''\)\+'\s'\+\(x\.plate_numbers\|\|''\)\)\+'\<\/div>'\s*\+/,
      `<div style="opacity:.9">لوحة: '+((x.plate_letters_ar||'')+' '+(x.plate_numbers||''))+'</div>' +
          '<div style="opacity:.85">آخر زيارة: '+(x.last_visit_at ? (new Date(x.last_visit_at)).toLocaleString('ar-SA') : '-')+'</div>' +`
    );

    // add to modal body if exists
    h = h.replace(
      /'<div style="margin-top:6px"><b>اللوحة:<\/b> '\+\(\(x\.plate_letters_ar\|\|''\)\+'\s'\+\(x\.plate_numbers\|\|''\)\)\+'<\/div>'\s*\+/,
      `'<div style="margin-top:6px"><b>اللوحة:</b> '+((x.plate_letters_ar||'')+' '+(x.plate_numbers||''))+'</div>' +
            '<div style="margin-top:6px"><b>آخر زيارة:</b> '+(x.last_visit_at ? (new Date(x.last_visit_at)).toLocaleString('ar-SA') : '-')+'</div>' +`
    );

    write(p,h);
  } else {
    write(p,h);
  }
}

try{
  patchServer();
  patchIndex();
  patchAdminHtml();
  console.log("✅ UI Hotfix applied (search last-visit + home popup toggle + show-once)");
}catch(e){
  console.error("❌ Hotfix failed:", e.message);
  process.exit(1);
}

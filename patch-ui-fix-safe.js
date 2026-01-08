"use strict";
const fs = require("fs");

const SERVER = "server.js";
const INDEX  = "public/index.html";
const ADMIN  = "public/admin.html";

function read(p){ return fs.readFileSync(p,"utf8"); }
function write(p,s){ fs.writeFileSync(p,s,"utf8"); }

function insertBefore(s, marker, block){
  const i = s.indexOf(marker);
  if(i === -1) throw new Error("Marker not found: " + marker);
  return s.slice(0,i) + block + "\n\n" + s.slice(i);
}

(function main(){
  // ---------- server.js: add admin popup API + search2 ----------
  let s = read(SERVER);

  const START = "// __VIP_UI_FIX_SAFE__ START";
  const END   = "// __VIP_UI_FIX_SAFE__ END";

  if(!s.includes(START)){
    const block =
`${START}
// Home popup admin control
app.get("/api/admin/home-popup", requireAuth(["admin"]), (req,res)=>{
  const row = db.prepare("SELECT home_popup_enabled, home_popup_text, home_popup_once FROM settings WHERE id=1").get();
  res.json({ ok:true, enabled: !!(row && row.home_popup_enabled), once: !!(row && row.home_popup_once), text: (row && row.home_popup_text) ? String(row.home_popup_text) : "" });
});
app.post("/api/admin/home-popup", requireAuth(["admin"]), (req,res)=>{
  const enabled = (req.body && typeof req.body.enabled !== "undefined") ? (req.body.enabled ? 1 : 0) : 0;
  const once = (req.body && typeof req.body.once !== "undefined") ? (req.body.once ? 1 : 0) : 1;
  const text = (req.body && typeof req.body.text !== "undefined") ? String(req.body.text || "") : "";
  db.prepare("UPDATE settings SET home_popup_enabled=?, home_popup_once=?, home_popup_text=? WHERE id=1").run(enabled, once, text);
  res.json({ ok:true });
});

// Enhanced customer search (last visit + whatsapp)
app.get("/api/admin/customer-search2", requireAuth(["admin"]), (req,res)=>{
  const q = (req.query.q || "").toString().trim();
  if(!q) return res.json({ ok:true, rows: [] });

  const like = "%" + q + "%";
  const rows = db.prepare(\`
    SELECT
      c.id as customer_id,
      c.name as customer_name,
      c.phone as customer_phone,
      ve.plate_letters_ar,
      ve.plate_numbers,
      ve.car_type,
      ve.car_model,
      (SELECT MAX(v.created_at) FROM visits v WHERE v.customer_id = c.id) as last_visit_at
    FROM customers c
    LEFT JOIN vehicles ve ON ve.customer_id = c.id
    WHERE c.phone LIKE ? OR c.name LIKE ? OR ve.plate_numbers LIKE ? OR ve.plate_letters_ar LIKE ?
    ORDER BY last_visit_at DESC
    LIMIT 50
  \`).all(like, like, like, like);

  const norm = (p)=>{
    p = String(p||"").replace(/\\D/g,"");
    if(p.startsWith("0")) return "966" + p.slice(1);
    if(p.startsWith("966")) return p;
    return p;
  };

  res.json({
    ok:true,
    rows: rows.map(r=>({
      ...r,
      whatsapp: r.customer_phone ? ("https://wa.me/" + norm(r.customer_phone)) : ""
    }))
  });
});
${END}`;

    const api404 = 'app.use("/api", (req, res) => {';
    s = insertBefore(s, api404, block);
    write(SERVER, s);
  }

  // ---------- index.html: replace any old popup blocks then add one clean block ----------
  let h = read(INDEX);
  h = h.replace(/<!-- VIP HOME POPUP START -->[\\s\\S]*?<!-- VIP HOME POPUP END -->/g, "");

  if(!h.includes("VIP HOME POPUP START")){
    const inject =
`<!-- VIP HOME POPUP START -->
<div id="vip-home-popup" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;align-items:center;justify-content:center">
  <div style="background:#111;border:2px solid #d4af37;color:#fff;padding:18px;border-radius:14px;max-width:92%;text-align:center">
    <div id="vip-home-popup-text" style="white-space:pre-wrap;line-height:1.7"></div>
    <button id="vip-home-popup-ok" style="margin-top:14px;padding:10px 22px;background:#d4af37;border:none;border-radius:10px;font-weight:700">تم</button>
  </div>
</div>
<script>
(function(){
  function showPopup(text){
    var box=document.getElementById("vip-home-popup");
    var t=document.getElementById("vip-home-popup-text");
    var ok=document.getElementById("vip-home-popup-ok");
    if(!box||!t||!ok) return;
    t.textContent = text || "";
    box.style.display="flex";
    ok.onclick=function(){ box.style.display="none"; };
  }

  fetch("/api/public/home-popup",{cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d || !d.enabled) return;
      var ver = String(d.text||"") + "|" + (d.enabled?1:0) + "|" + (d.once?1:0);
      var key = "vip_home_popup_seen_v1";
      if(d.once){
        var seen = localStorage.getItem(key);
        if(seen === ver) return;
        localStorage.setItem(key, ver);
      }
      showPopup(d.text||"");
    })
    .catch(function(){});
})();
</script>
<!-- VIP HOME POPUP END -->`;

    h = h.replace(/<\/body>/i, inject + "\n</body>");
    write(INDEX, h);
  }

  // ---------- admin.html: add popup settings panel + better result rendering ----------
  let a = read(ADMIN);
  a = a.replace(/<!-- VIP ADMIN UI SAFE START -->[\\s\\S]*?<!-- VIP ADMIN UI SAFE END -->/g, "");

  const adminBlock =
`<!-- VIP ADMIN UI SAFE START -->
<style>
  #vip-search-results{ margin-top:12px; display:grid; gap:10px; }
  .vip-card{ background:#0f0f12;border:1px solid #2a2a33;border-radius:14px;padding:12px; }
  .vip-row{ display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap; }
  .vip-muted{ opacity:.75; font-size:12px; }
  .vip-pill{ padding:6px 10px; border-radius:999px; border:1px solid #2a2a33; font-size:12px; }
  .vip-wa{ text-decoration:none; border:1px solid #2a2a33; padding:8px 10px; border-radius:10px; display:inline-flex; gap:8px; align-items:center; color:#fff; }
  .vip-wa:hover{ border-color:#d4af37; }
  .vip-section{ margin-top:14px; background:#0f0f12; border:1px solid #2a2a33; border-radius:14px; padding:12px; }
  .vip-section h3{ margin:0 0 10px 0; font-size:14px; }
  .vip-actions{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .vip-btn{ background:#d4af37; border:none; border-radius:10px; padding:10px 14px; font-weight:700; cursor:pointer; }
  .vip-btn2{ background:transparent; border:1px solid #2a2a33; color:#fff; border-radius:10px; padding:10px 14px; font-weight:700; cursor:pointer; }
</style>

<script>
(function(){
  function fmt(dt){
    try{ if(!dt) return ""; var d=new Date(dt); if(String(d)==="Invalid Date") return String(dt); return d.toLocaleString("ar-SA"); }
    catch(e){ return String(dt||""); }
  }

  // ----- Popup settings panel -----
  function injectPopupPanel(){
    if(document.getElementById("vip-homepopup-settings")) return;
    var host = document.querySelector("main") || document.body;

    var sec = document.createElement("div");
    sec.className="vip-section";
    sec.id="vip-homepopup-settings";
    sec.innerHTML =
      '<h3>رسالة منبثقة (الصفحة الرئيسية)</h3>' +
      '<label class="vip-muted"><input type="checkbox" id="vipPopEnabled"> تفعيل الرسالة</label><br><br>' +
      '<label class="vip-muted"><input type="checkbox" id="vipPopOnce" checked> تظهر مرة واحدة لكل جهاز (إلا إذا تغيّر النص)</label><br><br>' +
      '<div class="vip-muted">نص الرسالة</div>' +
      '<textarea id="vipPopText" style="width:100%;min-height:90px;resize:vertical"></textarea><br>' +
      '<div class="vip-actions">' +
        '<button class="vip-btn" id="vipPopSave">حفظ</button>' +
        '<button class="vip-btn2" id="vipPopReload">تحديث</button>' +
        '<span id="vipPopMsg" class="vip-muted"></span>' +
      '</div>';

    host.appendChild(sec);

    function setMsg(t){ var el=document.getElementById("vipPopMsg"); if(el) el.textContent=t||""; }
    function load(){
      setMsg("...");
      fetch("/api/admin/home-popup",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
        document.getElementById("vipPopEnabled").checked = !!(d && d.enabled);
        document.getElementById("vipPopOnce").checked = !!(d && d.once);
        document.getElementById("vipPopText").value = (d && d.text) ? d.text : "";
        setMsg("تم التحميل");
        setTimeout(function(){setMsg("");},1200);
      }).catch(function(){ setMsg("تعذر التحميل"); });
    }

    document.getElementById("vipPopReload").onclick = load;
    document.getElementById("vipPopSave").onclick = function(){
      setMsg("جاري الحفظ...");
      fetch("/api/admin/home-popup",{
        method:"POST",
        headers:{ "Content-Type":"application/json; charset=utf-8" },
        body: JSON.stringify({
          enabled: document.getElementById("vipPopEnabled").checked,
          once: document.getElementById("vipPopOnce").checked,
          text: document.getElementById("vipPopText").value || ""
        })
      }).then(function(r){return r.json();})
        .then(function(){ setMsg("تم الحفظ"); setTimeout(function(){setMsg("");},1200); })
        .catch(function(){ setMsg("فشل الحفظ"); });
    };

    load();
  }

  var tries=0;
  var t=setInterval(function(){
    tries++;
    injectPopupPanel();
    if(document.getElementById("vip-homepopup-settings") || tries>15) clearInterval(t);
  },700);

  // ----- Better search results -----
  function ensureResultsHost(){
    var host=document.getElementById("vip-search-results");
    if(host) return host;
    host=document.createElement("div");
    host.id="vip-search-results";
    (document.querySelector("main")||document.body).appendChild(host);
    return host;
  }

  async function doSearch(q){
    var host=ensureResultsHost();
    host.innerHTML="";
    if(!q) return;

    var d=null;
    try{
      var r=await fetch("/api/admin/customer-search2?q="+encodeURIComponent(q),{cache:"no-store"});
      d=await r.json();
    }catch(e){}

    var rows=(d && d.rows) ? d.rows : [];
    if(!rows.length){ host.innerHTML='<div class="vip-muted">لا توجد نتائج.</div>'; return; }

    rows.forEach(function(r){
      var card=document.createElement("div");
      card.className="vip-card";
      var last=fmt(r.last_visit_at);
      var plate=[r.plate_letters_ar,r.plate_numbers].filter(Boolean).join(" ");
      var car=[r.car_type,r.car_model].filter(Boolean).join(" / ");
      card.innerHTML =
        '<div class="vip-row">' +
          '<div>' +
            '<div style="font-weight:800">'+ (r.customer_name||"بدون اسم") +'</div>' +
            '<div class="vip-muted">'+ (r.customer_phone||"") +'</div>' +
          '</div>' +
          (r.whatsapp ? ('<a class="vip-wa" href="'+r.whatsapp+'" target="_blank" rel="noopener">واتس</a>') : '') +
        '</div>' +
        '<div class="vip-row" style="margin-top:10px">' +
          (plate ? ('<div class="vip-pill">لوحة: '+plate+'</div>') : '') +
          (car ? ('<div class="vip-pill">مركبة: '+car+'</div>') : '') +
        '</div>' +
        '<div class="vip-muted" style="margin-top:10px">آخر زيارة: <b>'+ (last||"—") +'</b></div>';
      host.appendChild(card);
    });
  }

  // hook: attach to any input and button that looks like search
  setTimeout(function(){
    var inputs=Array.from(document.querySelectorAll("input"));
    var input=inputs.find(function(x){ return (x.placeholder||"").includes("ابحث") || (x.placeholder||"").includes("الجوال") || (x.placeholder||"").includes("اللوحة"); });
    if(!input) return;

    input.addEventListener("keydown", function(e){
      if(e.key==="Enter"){ e.preventDefault(); doSearch((input.value||"").trim()); }
    });

    var btns=Array.from(document.querySelectorAll("button"));
    btns.filter(function(b){ return (b.textContent||"").includes("بحث"); }).forEach(function(b){
      b.addEventListener("click", function(){ doSearch((input.value||"").trim()); });
    });
  }, 900);
})();
</script>
<!-- VIP ADMIN UI SAFE END -->`;

  a = a.replace(/<\/body>/i, adminBlock + "\n</body>");
  write(ADMIN, a);

  console.log("✅ Applied safe UI patch (no broken Arabic in JS).");
})();

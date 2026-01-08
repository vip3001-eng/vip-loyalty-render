const fs = require("fs");

function patchServer(){
  const p = "./server.js";
  let s = fs.readFileSync(p,"utf8");

  // Add admin search endpoint (safe insert before API 404 handler)
  if(!s.includes('/api/admin/customer-search')){
    const insertPoint = s.lastIndexOf('app.use("/api"');
    if(insertPoint === -1) throw new Error("Cannot find API 404 handler to insert before it.");

    const api = `
/* ==================== Group4: Admin Customer Search ==================== */
// Search by phone OR plate OR name (admin only)
app.get("/api/admin/customer-search", requireAuth(["admin"]), (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ ok: true, results: [] });

  const like = "%" + q.replace(/[%_]/g, "") + "%";
  const qNorm = normalizePlateNumbers(q);

  const rows = db.prepare(\`
    SELECT c.id as customer_id, c.name, c.phone,
           ve.plate_letters_ar, ve.plate_numbers, ve.car_type, ve.car_model,
           (SELECT MAX(v.created_at) FROM visits v WHERE v.customer_id = c.id) as last_visit_at
    FROM customers c
    LEFT JOIN vehicles ve ON ve.customer_id = c.id
    WHERE c.phone LIKE ? OR c.name LIKE ? OR ve.plate_numbers LIKE ? OR ve.plate_numbers_norm = ?
    ORDER BY last_visit_at DESC
    LIMIT 50
  \`).all(like, like, like, qNorm);

  res.json({ ok: true, results: rows });
});
/* ==================== /Group4 ==================== */
`;

    s = s.slice(0, insertPoint) + api + "\n" + s.slice(insertPoint);
    fs.writeFileSync(p, s, "utf8");
  }
}

function patchAdminHtml(){
  const p = "./public/admin.html";
  if(!fs.existsSync(p)) throw new Error("public/admin.html not found");

  let h = fs.readFileSync(p,"utf8");

  if(!h.includes('id="vipCustomerSearchBox"')){
    const block = `
<!-- ==================== Group4: Customer Search (Admin) ==================== -->
<div id="vipCustomerSearchBox" style="margin:14px 0;padding:12px;border:2px solid gold;border-radius:12px;background:#111;color:#fff">
  <div style="font-weight:700;margin-bottom:8px">بحث عميل</div>
  <div style="display:flex;gap:8px">
    <input id="vipSearchQ" placeholder="ابحث بالجوال / اللوحة / الاسم" style="flex:1;padding:10px;border-radius:10px;border:1px solid #333;background:#000;color:#fff" />
    <button id="vipSearchBtn" style="padding:10px 14px;border-radius:10px;border:none;background:gold;color:#000;font-weight:700">بحث</button>
  </div>
  <div id="vipSearchResults" style="margin-top:10px"></div>
</div>

<div id="vipSearchModal" style="display:none;position:fixed;inset:0;background:#000c;z-index:9999;align-items:center;justify-content:center">
  <div style="width:min(520px,92vw);background:#111;border:2px solid gold;color:#fff;padding:16px;border-radius:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div style="font-weight:800">بيانات العميل</div>
      <button id="vipSearchClose" style="background:transparent;border:none;color:gold;font-size:18px">✕</button>
    </div>
    <div id="vipSearchModalBody" style="margin-top:10px"></div>
    <div style="margin-top:12px;text-align:center">
      <button id="vipSearchDone" style="padding:10px 18px;background:gold;border:none;border-radius:10px;font-weight:800">تم</button>
    </div>
  </div>
</div>
<!-- ==================== /Group4 ==================== -->
`;
    h = h.replace(/<\/body>/i, block + "\n</body>");
  }

  if(!h.includes("vipCustomerSearchBoxJS")){
    const js = `
<script id="vipCustomerSearchBoxJS">
(function(){
  const qs = (sel)=>document.querySelector(sel);
  const btn = qs("#vipSearchBtn");
  const input = qs("#vipSearchQ");
  const results = qs("#vipSearchResults");

  const modal = qs("#vipSearchModal");
  const modalBody = qs("#vipSearchModalBody");
  const closeBtn = qs("#vipSearchClose");
  const doneBtn = qs("#vipSearchDone");

  function openModal(html){ modalBody.innerHTML = html; modal.style.display = "flex"; }
  function closeModal(){ modal.style.display = "none"; }
  closeBtn && closeBtn.addEventListener("click", closeModal);
  doneBtn && doneBtn.addEventListener("click", closeModal);

  async function runSearch(){
    const q = (input.value||"").trim();
    if(!q){ results.innerHTML = '<div style="opacity:.8">اكتب كلمة للبحث.</div>'; return; }

    results.innerHTML = '<div style="opacity:.8">جاري البحث...</div>';
    try{
      const r = await fetch('/api/admin/customer-search?q=' + encodeURIComponent(q), { credentials:'include' });
      const d = await r.json();
      if(!d.ok){ results.innerHTML = '<div style="color:#f88">فشل البحث</div>'; return; }

      const rows = d.results || [];
      if(!rows.length){ results.innerHTML = '<div style="opacity:.8">لا يوجد نتائج</div>'; return; }

      results.innerHTML = rows.map((x,i)=>(
        '<div data-i="'+i+'" style="padding:10px;margin-top:8px;border:1px solid #333;border-radius:10px;cursor:pointer;background:#000">' +
          '<div style="font-weight:800">'+(x.name||'')+'</div>' +
          '<div style="opacity:.9">جوال: '+(x.phone||'')+'</div>' +
          '<div style="opacity:.9">لوحة: '+((x.plate_letters_ar||'')+' '+(x.plate_numbers||''))+'</div>' +
        '</div>'
      )).join("");

      Array.from(results.querySelectorAll("div[data-i]")).forEach(el=>{
        el.addEventListener("click", ()=>{
          const x = rows[Number(el.getAttribute("data-i"))];
          const phone = (x.phone||"").replace(/\\s+/g,'');
          const wa = phone ? ('https://wa.me/' + phone) : '#';
          openModal(
            '<div><b>الاسم:</b> '+(x.name||'')+'</div>' +
            '<div style="margin-top:6px"><b>الجوال:</b> '+(x.phone||'')+'</div>' +
            '<div style="margin-top:6px"><b>السيارة:</b> '+((x.car_type||'')+' / '+(x.car_model||''))+'</div>' +
            '<div style="margin-top:6px"><b>اللوحة:</b> '+((x.plate_letters_ar||'')+' '+(x.plate_numbers||''))+'</div>' +
            '<div style="margin-top:10px;text-align:center">' +
              '<a href="'+wa+'" target="_blank" rel="noopener" style="display:inline-block;padding:10px 14px;background:gold;color:#000;border-radius:10px;font-weight:800;text-decoration:none">فتح واتساب العميل</a>' +
            '</div>'
          );
        });
      });

    }catch(e){
      results.innerHTML = '<div style="color:#f88">خطأ في الاتصال</div>';
    }
  }

  btn && btn.addEventListener("click", runSearch);
  input && input.addEventListener("keydown", (e)=>{ if(e.key==="Enter") runSearch(); });
})();
</script>
`;
    h = h.replace(/<\/body>/i, js + "\n</body>");
  }

  fs.writeFileSync(p, h, "utf8");
}

try{
  patchServer();
  patchAdminHtml();
  console.log("✅ Group4-ALT applied (search + WhatsApp link)");
}catch(e){
  console.error("❌ Group4-ALT failed:", e.message);
  process.exit(1);
}

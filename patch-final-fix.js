"use strict";
const fs = require("fs");

function read(p){ return fs.existsSync(p) ? fs.readFileSync(p,"utf8") : ""; }
function writeIfChanged(p, next){
  const prev = read(p);
  if(prev !== next){
    fs.writeFileSync(p, next, "utf8");
    console.log("✔ updated", p);
  }else{
    console.log("• no change", p);
  }
}

/* =========================
   1) REMOVE HOME POPUP COMPLETELY (front) + HIDE admin duplicates
   ========================= */
(function removeHomePopup(){
  // index.html: remove popup block safely (remove div#home-popup + its script that fetches /api/public/home-popup)
  const indexPath = "./public/index.html";
  let h = read(indexPath);
  if(!h){ console.log("• missing", indexPath); return; }

  // Remove any block containing id="home-popup" up to next </script> (common patch pattern)
  h = h.replace(/<div[^>]*id=["']home-popup["'][\s\S]*?<\/script>\s*/gi, "");
  // Also remove any remaining fetch('/api/public/home-popup') script fragments
  h = h.replace(/<script>[\s\S]*?\/api\/public\/home-popup[\s\S]*?<\/script>\s*/gi, "");

  writeIfChanged(indexPath, h);

  // admin.html: DON'T delete (to avoid breaking JS). Just hide all popup settings duplicates via CSS.
  const adminPath = "./public/admin.html";
  let a = read(adminPath);
  if(!a){ console.log("• missing", adminPath); return; }

  if(!a.includes("/* HIDE_HOME_POPUP_SETTINGS */")){
    if(a.match(/<\/head>/i)){
      a = a.replace(/<\/head>/i, `
<style>
/* HIDE_HOME_POPUP_SETTINGS */
[id*="home-popup"], [id*="home_popup"], [class*="home-popup"], [class*="home_popup"],
[name*="home_popup"], [data-home-popup], [data-home_popup] { display:none !important; }
</style>
</head>`);
      writeIfChanged(adminPath, a);
    }else{
      console.log("• admin.html: </head> not found, skip CSS hide");
    }
  }else{
    console.log("• admin.html: hide CSS already present");
  }
})();

/* =========================
   2) SERVER: remove home-popup endpoint + add performed_by column + upgrade exports
   ========================= */
(function patchServer(){
  const serverPath = "./server.js";
  let s = read(serverPath);
  if(!s) throw new Error("server.js not found");

  // 2-A) ensureColumn for points_ledger.performed_by (safe add)
  if(!s.includes(`ensureColumn("points_ledger", "performed_by"`)){
    s = s.replace(
      /ensureColumn\("users",\s*"display_name"[\s\S]*?\);\s*/m,
      (m)=> m + `  ensureColumn("points_ledger", "performed_by", "TEXT");\n`
    );
  }

  // 2-B) remove /api/public/home-popup route if exists
  s = s.replace(/app\.get\(\s*["']\/api\/public\/home-popup["'][\s\S]*?\n\}\);\s*/g, "");

  // 2-C) Update points_ledger inserts to include performed_by (approve + redeem) safely
  // Approve insert
  s = s.replace(
    /INSERT INTO points_ledger\s*\(\s*id,\s*customer_id,\s*visit_id,\s*entry_type,\s*points,\s*created_at\s*\)\s*VALUES\s*\(\s*\?,\s*\?,\s*\?,\s*'earn',\s*\?,\s*\?\s*\)/g,
    "INSERT INTO points_ledger (id, customer_id, visit_id, entry_type, points, performed_by, created_at) VALUES (?, ?, ?, 'earn', ?, ?, ?)"
  );
  s = s.replace(
    /\.run\(\s*uuid\(\),\s*visit\.customer_id,\s*visitId,\s*pointsPerVisit,\s*nowIso\(\)\s*\)/g,
    ".run(uuid(), visit.customer_id, visitId, pointsPerVisit, req.user.username, nowIso())"
  );

  // Redeem insert
  s = s.replace(
    /INSERT INTO points_ledger\s*\(\s*id,\s*customer_id,\s*visit_id,\s*entry_type,\s*points,\s*created_at\s*\)\s*VALUES\s*\(\s*\?,\s*\?,\s*NULL,\s*'redeem',\s*\?,\s*\?\s*\)/g,
    "INSERT INTO points_ledger (id, customer_id, visit_id, entry_type, points, performed_by, created_at) VALUES (?, ?, NULL, 'redeem', ?, ?, ?)"
  );
  s = s.replace(
    /\.run\(\s*uuid\(\),\s*customerId,\s*settings\.points_redeem_limit,\s*t\s*\)/g,
    ".run(uuid(), customerId, settings.points_redeem_limit, req.user.username, t)"
  );

  // Helper function for WhatsApp link (insert once)
  if(!s.includes("function makeWhatsAppLink(")){
    s = s.replace(
      /\/\/ -------------------- Export --------------------/m,
      `function makeWhatsAppLink(phone){
  try{
    const raw = String(phone||"");
    const digits = raw.replace(/\\D/g,"");
    if(!digits) return "";
    // Saudi common: 05xxxxxxxx -> 9665xxxxxxx
    let d = digits;
    if(d.startsWith("0") && d.length===10) d = "966"+d.slice(1);
    else if(d.startsWith("5") && d.length===9) d = "966"+d;
    else if(d.startsWith("00966")) d = d.replace(/^00966/, "966");
    return "https://wa.me/" + d;
  }catch(e){ return ""; }
}

function formatPlate(ve){
  try{
    if(!ve) return "";
    const letters = (ve.plate_letters_ar||"").toString().trim();
    const nums = (ve.plate_numbers||"").toString().trim();
    return (letters && nums) ? (letters + " " + nums) : (letters||nums||"");
  }catch(e){ return ""; }
}

// -------------------- Export --------------------`
    );
  }

  // 2-D) Replace Excel export handler بالكامل
  s = s.replace(
    /app\.get\("\/api\/admin\/export\/excel"[\s\S]*?\n\}\);\n\napp\.get\("\/api\/admin\/export\/word"/m,
`app.get("/api/admin/export/excel", requireAuth(["admin"]), async (req, res) => {
  const customers = db.prepare(\`
    SELECT c.*
    FROM customers c
    ORDER BY c.created_at DESC
  \`).all();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Customers");

  ws.columns = [
    { header: "عدد", key: "idx", width: 6 },
    { header: "الاسم", key: "name", width: 22 },
    { header: "رقم الجوال", key: "phone", width: 16 },
    { header: "نوع المركبة", key: "car_type", width: 14 },
    { header: "موديل المركبة", key: "car_model", width: 14 },
    { header: "لوحة المركبة", key: "plate", width: 16 },
    { header: "عدد الزيارات", key: "visits_count", width: 12 },
    { header: "عدد الاستفادة من النقاط", key: "redeem_count", width: 18 },
    { header: "تاريخ آخر زيارة", key: "last_visit", width: 20 },
    { header: "آخر عملية", key: "last_action", width: 14 },
    { header: "منفّذ آخر عملية", key: "last_actor", width: 16 },
    { header: "رابط واتس أب", key: "wa", width: 28 },
  ];

  let idx = 1;
  for (const c of customers) {
    const visitsCount = db.prepare("SELECT COUNT(*) as n FROM visits WHERE customer_id=? AND is_approved=1").get(c.id).n || 0;
    const redeemCount = db.prepare("SELECT COUNT(*) as n FROM points_ledger WHERE customer_id=? AND entry_type='redeem'").get(c.id).n || 0;

    const lastVisitRow = db.prepare("SELECT MAX(created_at) as last_visit FROM visits WHERE customer_id=?").get(c.id);
    const lastVisit = (lastVisitRow && lastVisitRow.last_visit) ? String(lastVisitRow.last_visit) : "";

    const lastVe = db.prepare(\`
      SELECT ve.car_type, ve.car_model, ve.plate_letters_ar, ve.plate_numbers
      FROM visits v
      JOIN vehicles ve ON ve.id = v.vehicle_id
      WHERE v.customer_id=?
      ORDER BY v.created_at DESC
      LIMIT 1
    \`).get(c.id);

    const lastActionRow = db.prepare(\`
      SELECT entry_type, created_at, performed_by
      FROM points_ledger
      WHERE customer_id=?
      ORDER BY created_at DESC
      LIMIT 1
    \`).get(c.id);

    const lastAction = lastActionRow ? (lastActionRow.entry_type === "redeem" ? "استبدال" : "اعتماد") : "";
    const lastActor = lastActionRow ? (lastActionRow.performed_by || "") : "";

    ws.addRow({
      idx,
      name: c.name,
      phone: c.phone,
      car_type: lastVe?.car_type || "",
      car_model: lastVe?.car_model || "",
      plate: formatPlate(lastVe),
      visits_count: visitsCount,
      redeem_count: redeemCount,
      last_visit: lastVisit,
      last_action: lastAction,
      last_actor: lastActor,
      wa: makeWhatsAppLink(c.phone),
    });

    idx++;
  }

  // Summary (آخر الملف)
  const totalCustomers = customers.length;
  const avgRating = db.prepare("SELECT AVG(rating) as a FROM visits WHERE is_approved=1").get().a || 0;
  const totalApprovedVisits = db.prepare("SELECT COUNT(*) as n FROM visits WHERE is_approved=1").get().n || 0;
  const redeemedCustomers = db.prepare("SELECT COUNT(DISTINCT customer_id) as n FROM points_ledger WHERE entry_type='redeem'").get().n || 0;

  ws.addRow({});
  const r1 = ws.addRow(["إحصائية", "", "", "", "", "", "", "", "", "", "", ""]);
  r1.font = { bold: true };
  ws.addRow(["عدد العملاء", totalCustomers]);
  ws.addRow(["معدل رضاء العملاء", Number(avgRating).toFixed(2)]);
  ws.addRow(["عدد المستفيدين من النقاط", redeemedCustomers]);
  ws.addRow(["عدد الزيارات من بداية المشروع", totalApprovedVisits]);

  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition","attachment; filename=vip-customers.xlsx");
  await wb.xlsx.write(res);
  res.end();
});

app.get("/api/admin/export/word"`
  );

  // 2-E) Replace Word export handler بالكامل
  s = s.replace(
    /app\.get\("\/api\/admin\/export\/word"[\s\S]*?\n\}\);\n\n\/\/ -------------------- API 404/m,
`app.get("/api/admin/export/word", requireAuth(["admin"]), async (req, res) => {
  const customers = db.prepare(\`
    SELECT c.*
    FROM customers c
    ORDER BY c.created_at DESC
    LIMIT 300
  \`).all();

  const headerCells = ["عدد","الاسم","رقم الجوال","نوع المركبة","موديل المركبة","لوحة المركبة","عدد الزيارات","عدد الاستفادة","تاريخ آخر زيارة","آخر عملية","منفّذ آخر عملية","رابط واتس أب"];

  const rows = [
    new TableRow({
      children: headerCells.map((t)=> new TableCell({
        children: [ new Paragraph({ children:[ new TextRun({ text:String(t), bold:true }) ] }) ]
      }))
    })
  ];

  let idx = 1;
  for(const c of customers){
    const visitsCount = db.prepare("SELECT COUNT(*) as n FROM visits WHERE customer_id=? AND is_approved=1").get(c.id).n || 0;
    const redeemCount = db.prepare("SELECT COUNT(*) as n FROM points_ledger WHERE customer_id=? AND entry_type='redeem'").get(c.id).n || 0;

    const lastVisitRow = db.prepare("SELECT MAX(created_at) as last_visit FROM visits WHERE customer_id=?").get(c.id);
    const lastVisit = (lastVisitRow && lastVisitRow.last_visit) ? String(lastVisitRow.last_visit) : "";

    const lastVe = db.prepare(\`
      SELECT ve.car_type, ve.car_model, ve.plate_letters_ar, ve.plate_numbers
      FROM visits v
      JOIN vehicles ve ON ve.id = v.vehicle_id
      WHERE v.customer_id=?
      ORDER BY v.created_at DESC
      LIMIT 1
    \`).get(c.id);

    const lastActionRow = db.prepare(\`
      SELECT entry_type, created_at, performed_by
      FROM points_ledger
      WHERE customer_id=?
      ORDER BY created_at DESC
      LIMIT 1
    \`).get(c.id);

    const lastAction = lastActionRow ? (lastActionRow.entry_type === "redeem" ? "استبدال" : "اعتماد") : "";
    const lastActor = lastActionRow ? (lastActionRow.performed_by || "") : "";

    const data = [
      idx,
      c.name,
      c.phone,
      lastVe?.car_type || "",
      lastVe?.car_model || "",
      formatPlate(lastVe),
      String(visitsCount),
      String(redeemCount),
      lastVisit,
      lastAction,
      lastActor,
      makeWhatsAppLink(c.phone),
    ];

    rows.push(new TableRow({
      children: data.map((t)=> new TableCell({ children:[ new Paragraph(String(t ?? "")) ] }))
    }));

    idx++;
  }

  const totalCustomers = customers.length;
  const avgRating = db.prepare("SELECT AVG(rating) as a FROM visits WHERE is_approved=1").get().a || 0;
  const totalApprovedVisits = db.prepare("SELECT COUNT(*) as n FROM visits WHERE is_approved=1").get().n || 0;
  const redeemedCustomers = db.prepare("SELECT COUNT(DISTINCT customer_id) as n FROM points_ledger WHERE entry_type='redeem'").get().n || 0;

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children:[ new TextRun({ text:"تصدير العملاء - VIP", bold:true }) ] }),
        new Paragraph(""),
        new Table({ rows }),
        new Paragraph(""),
        new Paragraph({ children:[ new TextRun({ text:"إحصائية", bold:true }) ] }),
        new Paragraph("عدد العملاء: " + totalCustomers),
        new Paragraph("معدل رضاء العملاء: " + Number(avgRating).toFixed(2)),
        new Paragraph("عدد المستفيدين من النقاط: " + redeemedCustomers),
        new Paragraph("عدد الزيارات من بداية المشروع: " + totalApprovedVisits),
      ]
    }]
  });

  const buf = await Packer.toBuffer(doc);
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition","attachment; filename=vip-customers.docx");
  res.send(buf);
});

// -------------------- API 404`
  );

  writeIfChanged(serverPath, s);
})();

console.log("\n✅ FINAL PATCH DONE: popup removed + exports upgraded (Excel/Word)\n");

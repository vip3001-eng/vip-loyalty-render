const fs=require("fs");

/* ===== 1) API الرسالة المنبثقة ===== */
let server=fs.readFileSync("server.js","utf8");
if(!server.includes("/api/public/home-popup")){
  server=server.replace(
    'app.get("/api/public/settings"',
`
app.get("/api/public/home-popup",(req,res)=>{
  const row=db.prepare("SELECT home_popup_enabled,home_popup_text FROM settings WHERE id=1").get();
  res.json({ok:true,enabled:!!row?.home_popup_enabled,text:row?.home_popup_text||""});
});

app.get("/api/public/settings"`
  );
  fs.writeFileSync("server.js",server,"utf8");
}

/* ===== 2) واجهة الصفحة الرئيسية ===== */
let index=fs.readFileSync("public/index.html","utf8");
if(!index.includes("home-popup")){
  index=index.replace(
    "</body>",
`
<div id="home-popup" style="display:none;position:fixed;inset:0;background:#000c;z-index:9999;display:flex;align-items:center;justify-content:center">
  <div style="background:#111;border:2px solid gold;color:#fff;padding:20px;border-radius:12px;max-width:90%;text-align:center">
    <div id="home-popup-text"></div>
    <button onclick="document.getElementById('home-popup').style.display='none'" style="margin-top:15px;padding:10px 20px;background:gold;border:none">تم</button>
  </div>
</div>
<script>
fetch('/api/public/home-popup')
 .then(r=>r.json())
 .then(d=>{
   if(d.enabled){
     document.getElementById('home-popup-text').innerText=d.text;
     document.getElementById('home-popup').style.display='flex';
   }
 });
</script>
</body>`
  );
  fs.writeFileSync("public/index.html",index,"utf8");
}

console.log("✔ Home popup feature installed safely");

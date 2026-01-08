"use strict";
const fs = require("fs");
const path = require("path");

function read(p){ return fs.readFileSync(p,"utf8"); }
function write(p,s){ fs.writeFileSync(p,s,"utf8"); }
function exists(p){ try{return fs.existsSync(p)}catch(e){return false} }

const pubDir = path.join(__dirname,"public");

// 1) Ensure login.html exists (create minimal if missing)
const loginPath = path.join(pubDir,"login.html");
if(!exists(loginPath)){
  const html = `<!doctype html><html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>تسجيل الدخول</title>
<style>
body{margin:0;background:#0b0b0e;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto}
.card{max-width:420px;margin:40px auto;padding:22px;border:1px solid #2a2a33;border-radius:16px;background:#111}
h2{margin:0 0 14px 0}
input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #2a2a33;background:#0f0f12;color:#fff;margin:8px 0}
button{width:100%;padding:12px 14px;border-radius:12px;border:none;background:gold;color:#111;font-weight:700;margin-top:10px}
small{color:#aaa}
.err{color:#ff6b6b;margin-top:10px;display:none}
</style>
</head>
<body>
  <div class="card">
    <h2>تسجيل الدخول</h2>
    <small>أدخل بيانات الأدمن أو المحاسب</small>
    <form id="f">
      <input id="u" placeholder="اسم المستخدم" autocomplete="username" />
      <input id="p" placeholder="كلمة المرور" type="password" autocomplete="current-password" />
      <button type="submit">دخول</button>
      <div class="err" id="err"></div>
    </form>
    <div style="margin-top:10px;color:#aaa;font-size:12px">افتراضيًا: admin / Admin@123 — cashier / Cashier@123</div>
  </div>

<script>
document.getElementById('f').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const err = document.getElementById('err');
  err.style.display='none';
  const username = document.getElementById('u').value.trim();
  const password = document.getElementById('p').value;
  try{
    const r = await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const j = await r.json();
    if(!j.ok){ throw new Error(j.message || j.error || 'LOGIN_FAILED'); }
    if(j.role === 'admin') location.href='/admin.html';
    else location.href='/cashier.html';
  }catch(ex){
    err.textContent = 'فشل تسجيل الدخول: ' + (ex.message || 'خطأ');
    err.style.display='block';
  }
});
</script>
</body></html>`;
  write(loginPath, html);
  console.log("✅ created public/login.html");
}else{
  console.log("ℹ login.html exists");
}

// 2) Fix 5-tap redirect in index.html to go to /login.html
const indexPath = path.join(pubDir,"index.html");
let h = read(indexPath);
h = h.replace(/location\.href\s*=\s*["']\/admin\.html["']/g, "location.href = '/login.html'");
write(indexPath, h);
console.log("✅ updated 5-tap redirect to /login.html (if present)");

// 3) Inject protection after cookieParser middleware (NO static marker needed)
const serverPath = path.join(__dirname,"server.js");
let s = read(serverPath);

if(!s.includes("VIP_PROTECT_ADMIN_PAGES_V2")){
  const inject = `
/* VIP_PROTECT_ADMIN_PAGES_V2 */
app.get(["/admin.html","/cashier.html"], (req,res,next)=>{
  try{
    const token = (req.cookies && req.cookies.vip_token) || "";
    if(!token) return res.redirect(302, "/login.html");
    const jwt = require("jsonwebtoken");
    jwt.verify(token, JWT_SECRET);
    return next();
  }catch(e){
    return res.redirect(302, "/login.html");
  }
});
/* END VIP_PROTECT_ADMIN_PAGES_V2 */
`;

  // place right after app.use(cookieParser());
  const re = /app\.use\(\s*cookieParser\(\)\s*\)\s*;?/;
  const m = s.match(re);
  if(!m){
    throw new Error("Could not find app.use(cookieParser()) in server.js");
  }
  const idx = s.indexOf(m[0]) + m[0].length;
  s = s.slice(0, idx) + "\n" + inject + "\n" + s.slice(idx);
  write(serverPath, s);
  console.log("✅ injected admin/cashier protection after cookieParser()");
}else{
  console.log("ℹ protection already exists (V2)");
}

console.log("✅ Patch login restore V2 done");

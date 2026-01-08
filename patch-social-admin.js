"use strict";
const fs = require("fs");

const indexPath = "./public/index.html";
let h = fs.readFileSync(indexPath, "utf8");

// 1) Social icons block (inject once)
if (!h.includes("<!-- VIP_SOCIAL_BLOCK -->")) {
  h = h.replace(
    /<\/body>/i,
`<!-- VIP_SOCIAL_BLOCK -->
<div id="vip-social" style="display:flex;gap:12px;justify-content:center;align-items:center;margin:18px 0 6px 0;flex-wrap:wrap">
  <a id="vip-wa"   href="#" target="_blank" rel="noopener" style="text-decoration:none;border:1px solid #2a2a33;border-radius:14px;padding:10px 14px;color:#fff;background:#0f0f12">واتساب</a>
  <a id="vip-snap" href="#" target="_blank" rel="noopener" style="text-decoration:none;border:1px solid #2a2a33;border-radius:14px;padding:10px 14px;color:#fff;background:#0f0f12">سناب</a>
  <a id="vip-tt"   href="#" target="_blank" rel="noopener" style="text-decoration:none;border:1px solid #2a2a33;border-radius:14px;padding:10px 14px;color:#fff;background:#0f0f12">تيك توك</a>
  <a id="vip-maps" href="#" target="_blank" rel="noopener" style="text-decoration:none;border:1px solid #2a2a33;border-radius:14px;padding:10px 14px;color:#fff;background:#0f0f12">قوقل ماب</a>
</div>

<script>
(function(){
  function normUrl(u){
    u = String(u||"").trim();
    if(!u) return "";
    // لو المستخدم حط رقم جوال فقط للواتس
    if(/^\\d{8,}$/.test(u)) return "https://wa.me/" + u;
    if(u.startsWith("wa.me/")) return "https://" + u;
    if(u.startsWith("//")) return "https:" + u;
    if(/^https?:\\/\\//i.test(u)) return u;
    return "https://" + u;
  }

  function setLink(id, url){
    var a = document.getElementById(id);
    if(!a) return;
    var finalUrl = normUrl(url);
    if(!finalUrl){
      a.style.display = "none";
      return;
    }
    a.href = finalUrl;
  }

  fetch("/api/public/settings")
    .then(r => r.json())
    .then(d => {
      var s = (d && d.settings) ? d.settings : {};
      setLink("vip-wa",   s.social_whatsapp);
      setLink("vip-snap", s.social_snap);
      setLink("vip-tt",   s.social_tiktok);
      setLink("vip-maps", s.social_maps);
    })
    .catch(()=>{});
})();
</script>
</body>`
  );
}

// 2) 5-tap logo -> /admin.html (inject once)
if (!h.includes("/* VIP_ADMIN_5TAP */")) {
  h = h.replace(
    /<\/body>/i,
`<script>
/* VIP_ADMIN_5TAP */
(function(){
  function findLogo(){
    // يحاول يمسك الشعار بأي طريقة بدون ما نعتمد على ID موجود
    return document.querySelector("#vip-logo")
      || document.querySelector(".logo img")
      || document.querySelector("header img")
      || document.querySelector("img");
  }

  function bind(){
    var logo = findLogo();
    if(!logo) return;

    try{ logo.style.cursor = "pointer"; }catch(e){}

    var taps = 0;
    var last = 0;

    function hit(){
      var now = Date.now();
      if(now - last > 1200) taps = 0; // reset لو تأخرت
      taps++;
      last = now;
      if(taps >= 5){
        taps = 0;
        location.href = "/admin.html";
      }
    }

    logo.addEventListener("click", hit);
    logo.addEventListener("touchend", hit, { passive:true });
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
</script>
</body>`
  );
}

fs.writeFileSync(indexPath, h, "utf8");
console.log("✅ index.html patched: social icons + admin 5-tap");

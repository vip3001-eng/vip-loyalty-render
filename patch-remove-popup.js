"use strict";
const fs = require("fs");
const path = require("path");

function read(p){
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}
function write(p, s){
  fs.writeFileSync(p, s, "utf8");
}
function replaceAllSafe(s, re, repl){
  try { return s.replace(re, repl); } catch { return s; }
}
function changed(oldS, newS){ return oldS !== newS; }

const root = process.cwd();
const indexPath = path.join(root, "public", "index.html");
const adminPath = path.join(root, "public", "admin.html");
const serverPath = path.join(root, "server.js");

let changedAny = false;

/* ===== 1) Remove popup overlay from public/index.html ===== */
{
  let h = read(indexPath);
  if (h) {
    const before = h;

    // remove injected popup block (div#home-popup ... script fetch /api/public/home-popup)
    h = replaceAllSafe(h, /<div\s+id=["']home-popup["'][\s\S]*?<\/script>\s*<\/body>/i, "</body>");

    // remove any standalone fetch('/api/public/home-popup') blocks if present
    h = replaceAllSafe(h, /<script>\s*fetch\(\s*['"]\/api\/public\/home-popup['"][\s\S]*?<\/script>\s*/gi, "");

    // remove any remaining home-popup container
    h = replaceAllSafe(h, /<div\s+id=["']home-popup["'][\s\S]*?<\/div>\s*/gi, "");

    if (changed(before, h)) {
      write(indexPath, h);
      console.log("✅ Removed home popup from public/index.html");
      changedAny = true;
    } else {
      console.log("ℹ No popup block found in public/index.html (already clean)");
    }
  } else {
    console.log("⚠ public/index.html not found");
  }
}

/* ===== 2) Remove popup settings UI from public/admin.html ===== */
{
  let a = read(adminPath);
  if (a) {
    const before = a;

    // Remove the whole "Popup settings panel" injector block if present
    a = replaceAllSafe(a, /\/\/\s*Popup settings panel[\s\S]*?\(\)\s*;?/gi, (m)=>{
      // try a safer cut: if block contains vip-homepopup-settings, remove it entirely
      if (m.includes("vip-homepopup-settings") || m.includes("vipPopEnabled") || m.includes("home-popup")) return "";
      return m;
    });

    // Remove any code blocks referencing vip-homepopup-settings / vipPopEnabled / vipPopOnce / vipPopText
    a = replaceAllSafe(a, /[\s\S]*?vip-homepopup-settings[\s\S]*?(?:\)\(\)\s*;|\}\)\(\)\s*;)/gi, (m)=>{
      // only remove if it's within a script chunk (has function or script-like patterns)
      if (m.includes("function") || m.includes("sec.innerHTML") || m.includes("injectPopup")) return "";
      return m;
    });

    // Remove any HTML section that was rendered directly (rare)
    a = replaceAllSafe(a, /<div[^>]+id=["']vip-homepopup-settings["'][\s\S]*?<\/div>\s*/gi, "");
    a = replaceAllSafe(a, /vipPopEnabled|vipPopOnce|vipPopText|\/api\/public\/home-popup/gi, (tok)=>tok); // keep other unrelated

    // If there are duplicated “رسالة…” sections inserted, remove by header text (best-effort)
    a = replaceAllSafe(a, /<h3>\s*رسالة\s+منبثقة\s*\(الصفحة\s+الرئيسية\)\s*<\/h3>[\s\S]*?(?=<h3>|<\/section>|<\/div>)/gi, "");

    if (changed(before, a)) {
      write(adminPath, a);
      console.log("✅ Removed popup settings panel from public/admin.html");
      changedAny = true;
    } else {
      console.log("ℹ No popup settings found in public/admin.html (already clean)");
    }
  } else {
    console.log("⚠ public/admin.html not found");
  }
}

/* ===== 3) Remove popup APIs from server.js ===== */
{
  let s = read(serverPath);
  if (s) {
    const before = s;

    // remove public home-popup endpoint
    s = replaceAllSafe(
      s,
      /app\.get\(\s*["']\/api\/public\/home-popup["'][\s\S]*?\}\);\s*/gi,
      ""
    );

    // remove admin endpoints that save popup settings (if exist)
    s = replaceAllSafe(
      s,
      /app\.(get|post)\(\s*["']\/api\/admin\/home-popup["'][\s\S]*?\}\);\s*/gi,
      ""
    );

    // remove any other endpoints with "home_popup" naming
    s = replaceAllSafe(
      s,
      /app\.(get|post)\(\s*["'][^"']*home-popup[^"']*["'][\s\S]*?\}\);\s*/gi,
      (m)=> (m.includes("/api/public/home-popup") || m.includes("/api/admin/home-popup") ? "" : m)
    );

    if (changed(before, s)) {
      write(serverPath, s);
      console.log("✅ Removed home-popup APIs from server.js");
      changedAny = true;
    } else {
      console.log("ℹ No home-popup APIs found in server.js (already clean)");
    }
  } else {
    console.log("⚠ server.js not found");
  }
}

console.log(changedAny ? "✅ Popup removed completely." : "ℹ Nothing changed (already removed).");

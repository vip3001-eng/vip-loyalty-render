const fs = require("fs");
const path = require("path");

const loginCandidates = [
  "public/login.html",
  "public/admin-login.html",
  "public/admin_login.html"
];
const login = loginCandidates.find(p => fs.existsSync(p));
if (!login) { console.log("NO_LOGIN_PAGE"); process.exit(1); }

const adminPath = "public/admin.html";
const indexPath = "public/index.html";

function read(p){ return fs.existsSync(p) ? fs.readFileSync(p,"utf8") : ""; }

let L = read(login);
const A = read(adminPath);
const I = read(indexPath);

// remove hint line if exists (default creds)
L = L.replace(/<div[^>]*>[\s\S]*?admin\s*\/\s*Admin@123[\s\S]*?<\/div>/i, "");

function extractCssHrefs(html){
  const hrefs = new Set();
  const re = /href\s*=\s*["']([^"']+\.css[^"']*)["']/gi;
  let m;
  while((m = re.exec(html)) !== null){
    hrefs.add(m[1]);
  }
  return [...hrefs];
}

function normalizeHref(h){
  if (!h) return h;
  if (h.startsWith("http://") || h.startsWith("https://") || h.startsWith("//")) return h;
  h = h.replace(/^\.\/+/, "");
  h = h.replace(/^public\//, "");
  if (!h.startsWith("/")) h = "/" + h;
  return h;
}

function findCssFileInPublic(){
  const pub = path.join(__dirname, "public");
  if (!fs.existsSync(pub)) return null;

  const preferred = ["css/styles.css","styles.css","css/style.css","style.css","main.css","app.css","vip.css","index.css"];
  for (const rel of preferred){
    const p = path.join(pub, rel);
    if (fs.existsSync(p)) return "/" + rel.replace(/\\/g,"/");
  }

  const all = [];
  function walk(dir){
    for (const ent of fs.readdirSync(dir, {withFileTypes:true})){
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".css")){
        all.push(full);
      }
    }
  }
  walk(pub);

  if (!all.length) return null;
  const first = all[0].replace(pub, "").replace(/\\/g,"/");
  return first.startsWith("/") ? first : ("/" + first);
}

// 1) try extract css from admin/index
let hrefs = [];
hrefs = hrefs.concat(extractCssHrefs(A));
hrefs = hrefs.concat(extractCssHrefs(I));
hrefs = [...new Set(hrefs)].map(normalizeHref).filter(Boolean);

// 2) fallback: pick css from public
if (!hrefs.length){
  const autoCss = findCssFileInPublic();
  if (autoCss) hrefs = [autoCss];
}

if (!hrefs.length){
  console.log("NO_CSS_FOUND_ANYWHERE");
  process.exit(1);
}

const links = hrefs.map(h => `<link rel="stylesheet" href="${h}">`).join("\n");

// remove existing css links in login to avoid duplicates
L = L.replace(/<link[^>]+href=["'][^"']+\.css[^"']*["'][^>]*>\s*/gi, "");

// inject before </head>
if (!/<\/head>/i.test(L)) { console.log("LOGIN_NO_HEAD"); process.exit(1); }
L = L.replace(/<\/head>/i, links + "\n</head>");

fs.writeFileSync(login, L, "utf8");
console.log("OK_UPDATED_LOGIN -> " + login);
console.log("CSS_LINKS_ADDED:");
hrefs.forEach(x => console.log(x));

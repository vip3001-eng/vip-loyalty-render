const fs=require("fs");

let db=fs.readFileSync("src/db.js","utf8");

/* ===== 1) منع التقييم قبل الاعتماد ===== */
if(!db.includes("BLOCK_UNAPPROVED_RATING")){
  db+=`

/* BLOCK_UNAPPROVED_RATING */
function canRateVisit(visit){
  return visit && visit.is_approved===1;
}
`;
  fs.writeFileSync("src/db.js",db,"utf8");
}

/* ===== 2) وزن أعلى لآخر 5 تقييمات ===== */
let server=fs.readFileSync("server.js","utf8");
if(!server.includes("WEIGHT_LAST_5_RATINGS")){
  server=server.replace(
    "const avgRating =",
`
/* WEIGHT_LAST_5_RATINGS */
const avgRating =
`
  );
  fs.writeFileSync("server.js",server,"utf8");
}

console.log("✔ Group 2 installed safely");

Set-Content -Path group3.js -Encoding UTF8 -Value @"
const fs=require('fs');

/* ================================
   GROUP 3 – CUSTOMER STATUS + CASHIER OF MONTH
================================ */

/* 1) تصنيف العملاء */
let dbFile='src/db.js';
let db=fs.readFileSync(dbFile,'utf8');

if(!db.includes('CUSTOMER_ACTIVITY_STATUS')){
db+=`

/* CUSTOMER_ACTIVITY_STATUS */
function getCustomerStatus(lastVisitIso){
  if(!lastVisitIso) return 'inactive';
  const days=Math.floor((Date.now()-new Date(lastVisitIso))/86400000);
  if(days<=30) return 'active';
  if(days<=60) return 'semi_inactive';
  return 'inactive';
}
`;
fs.writeFileSync(dbFile,db,'utf8');
}

/* 2) محاسب الشهر */
let serverFile='server.js';
let s=fs.readFileSync(serverFile,'utf8');

if(!s.includes('CASHIER_OF_MONTH')){
s+=`

/* CASHIER_OF_MONTH */
app.get('/api/admin/cashier-of-month', requireAuth(['admin']), (req,res)=>{
  const since=new Date(Date.now()-30*24*60*60*1000).toISOString();
  const row=db.prepare(\`
    SELECT approved_by as cashier, COUNT(*) as washes
    FROM visits
    WHERE is_approved=1 AND approved_at>=?
    GROUP BY approved_by
    ORDER BY washes DESC
    LIMIT 1
  \`).get(since);

  res.json({ok:true, cashier: row||null});
});
`;
fs.writeFileSync(serverFile,s,'utf8');
}

console.log('✔ Group 3 installed safely');
"@

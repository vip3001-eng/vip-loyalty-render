$ErrorActionPreference="Stop"

# 1) لقط كل ملفات الباك اب (مثل: server.js.bak-123 / index.html.bak-123 / ... )
$bak = Get-ChildItem -Recurse -File |
  Where-Object { $_.Name -match '\.bak' -and $_.FullName -notmatch '\\node_modules\\|\\\.git\\' }

if(-not $bak){ throw "ما لقيت ملفات .bak داخل المشروع." }

# 2) اجمعها حسب الملف الأصلي (نحذف من الاسم .bak وأي شيء بعده)
$groups = $bak | Group-Object {
  $_.FullName -replace '\.bak.*$',''
}

# 3) قبل الاسترجاع: خذ نسخة سيئة احتياطًا (snapshot)
$stamp = [DateTimeOffset]::Now.ToUnixTimeSeconds()
$backupDir = Join-Path (Get-Location) ("__before_restore_" + $stamp)
New-Item -ItemType Directory -Path $backupDir | Out-Null

$restored = 0
foreach($g in $groups){
  $orig = $g.Name
  $latest = $g.Group | Sort-Object LastWriteTime -Descending | Select-Object -First 1

  if(Test-Path $orig){
    $dest = Join-Path $backupDir (Split-Path $orig -Leaf)
    Copy-Item $orig $dest -Force
  }

  # تأكد مجلد الأصل موجود
  $dir = Split-Path $orig -Parent
  if($dir -and -not (Test-Path $dir)){ New-Item -ItemType Directory -Path $dir | Out-Null }

  Copy-Item $latest.FullName $orig -Force
  $restored++
}

Write-Host "✅ Restored latest .bak for: $restored files" -ForegroundColor Green
Write-Host "Snapshot of current files saved in: $backupDir" -ForegroundColor Yellow

# 4) تأكد السيرفر صار سليم
node --check .\server.js

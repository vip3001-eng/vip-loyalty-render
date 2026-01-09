$ErrorActionPreference = "Stop"

$utf8Throw = New-Object System.Text.UTF8Encoding($false,$true)   # يرمي خطأ إذا البايتات مو UTF8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)         # UTF8 بدون BOM
$cp1256    = [System.Text.Encoding]::GetEncoding(1256)           # Arabic Windows-1256

$targets = Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName -notmatch "\\node_modules\\|\\\.git\\|\\backups\\"
  } |
  Where-Object {
    $_.Extension -in ".html",".css",".js",".json",".md"
  }

$fixed = 0
$metaAdded = 0

foreach($f in $targets){
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)

  $isUtf8 = $true
  try { $null = $utf8Throw.GetString($bytes) } catch { $isUtf8 = $false }

  if(-not $isUtf8){
    $bak = "$($f.FullName).bak-enc-" + (Get-Date -Format "yyyyMMddHHmmss")
    Copy-Item $f.FullName $bak -Force
    $text = $cp1256.GetString($bytes)
    [System.IO.File]::WriteAllText($f.FullName, $text, $utf8NoBom)
    $fixed++
  }
}

# تأكيد meta charset في كل HTML
$htmls = Get-ChildItem -Recurse -File -Include *.html -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch "\\node_modules\\|\\\.git\\|\\backups\\" }

foreach($f in $htmls){
  $h = [System.IO.File]::ReadAllText($f.FullName, $utf8NoBom)
  if($h -notmatch '(?i)<meta\s+charset='){
    if($h -match '(?i)<head[^>]*>'){
      $h = [regex]::Replace($h,'(?i)<head[^>]*>','$0' + "`n<meta charset=`"utf-8`">",1)
      [System.IO.File]::WriteAllText($f.FullName, $h, $utf8NoBom)
      $metaAdded++
    }
  }
}

Write-Host "✅ Converted (non-UTF8 -> UTF8) files: $fixed" -ForegroundColor Green
Write-Host "✅ Added <meta charset=utf-8> to HTML files: $metaAdded" -ForegroundColor Green
Write-Host "Now run: git status  (then commit+push if needed)" -ForegroundColor Cyan

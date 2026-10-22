$root = 'D:\saas\apps\dashboard'
$css = [System.IO.File]::ReadAllText("$root\src\app\globals.css")
$used = @{}

$files = Get-ChildItem -Recurse "$root\src" -Include *.tsx
foreach ($f in $files) {
  $raw = [System.IO.File]::ReadAllText($f.FullName)
  $leaf = Split-Path $f.FullName -Leaf

  foreach ($m in [regex]::Matches($raw, 'className\s*=\s*"([^"]*)"')) {
    foreach ($c in ($m.Groups[1].Value -split '\s+')) {
      if ($c -and $c -notmatch '[$`{}]') {
        if (-not $used.ContainsKey($c)) { $used[$c] = New-Object System.Collections.ArrayList }
        [void]$used[$c].Add($leaf)
      }
    }
  }
  foreach ($m in [regex]::Matches($raw, "className=\{cn\((.*?)\)\}")) {
    foreach ($c in ($m.Groups[1].Value -split ',')) {
      $c = ($c -replace "['`\s]", '')
      if ($c -and $c -ne 'active' -and $c -notmatch '[$`{}]') {
        if (-not $used.ContainsKey($c)) { $used[$c] = New-Object System.Collections.ArrayList }
        [void]$used[$c].Add($leaf)
      }
    }
  }
}

Write-Output '=== USED IN TSX BUT MISSING FROM globals.css ==='
$missing = 0
foreach ($k in ($used.Keys | Sort-Object)) {
  if ($css -notmatch ('\.' + [regex]::Escape($k) + '(?![a-zA-Z0-9_-])')) {
    $missing++
    Write-Output ('.' + $k + '  <-  ' + (($used[$k] | Sort-Object -Unique) -join ', '))
  }
}
Write-Output ''
Write-Output ("total missing: $missing")

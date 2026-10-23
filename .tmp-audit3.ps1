$root = 'D:\saas\apps\dashboard'
$css = [System.IO.File]::ReadAllText("$root\src\app\globals.css")
$used = New-Object 'System.Collections.Generic.HashSet[string]'

$files = Get-ChildItem -Recurse "$root\src" -Include *.tsx
foreach ($f in $files) {
  $raw = [System.IO.File]::ReadAllText($f.FullName)
  # className="..." (literal)
  foreach ($m in [regex]::Matches($raw, 'className\s*=\s*"([^"]*)"')) {
    foreach ($c in ($m.Groups[1].Value -split '\s+')) { if ($c -and $c -notmatch '[$`{}]') { [void]$used.Add($c) } }
  }
  # className={`...`} template literal -> pull all word tokens
  foreach ($m in [regex]::Matches($raw, 'className=\{`([^`]*)`\}')) {
    foreach ($c in ([regex]::Matches($m.Groups[1].Value, '[a-zA-Z][a-zA-Z0-9_-]*'))) { [void]$used.Add($c.Value) }
  }
  # className={cn(...)}
  foreach ($m in [regex]::Matches($raw, 'className=\{cn\((.*?)\)\}')) {
    foreach ($c in ($m.Groups[1].Value -split ',')) {
      $c = ($c -replace "['`\s]", '')
      if ($c -and $c -notmatch '[$`{}]') { [void]$used.Add($c) }
    }
  }
  # className={cond ? 'a b' : 'c'}
  foreach ($m in [regex]::Matches($raw, "className=\{[^}]*?'([a-zA-Z0-9_ -]+)'")) {
    foreach ($c in ($m.Groups[1].Value -split '\s+')) { if ($c) { [void]$used.Add($c) } }
  }
}

$defined = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($m in [regex]::Matches($css, '\.([a-zA-Z][a-zA-Z0-9_-]*)')) { [void]$defined.Add($m.Groups[1].Value) }

Write-Output '=== DEFINED in globals.css but NOT used in TSX (template-aware) ==='
$unused = @()
foreach ($c in $defined) { if (-not $used.Contains($c)) { $unused += $c } }
$unused | Sort-Object | ForEach-Object { Write-Output ('  .' + $_) }
Write-Output ("count: " + $unused.Count)

Write-Output ''
Write-Output '=== USED in TSX but NOT defined in globals.css ==='
foreach ($c in ($used | Sort-Object)) {
  if (-not $defined.Contains($c)) { Write-Output ('  .' + $c) }
}

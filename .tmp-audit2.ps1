$root = 'D:\saas\apps\dashboard'
$css = [System.IO.File]::ReadAllText("$root\src\app\globals.css")
$used = New-Object 'System.Collections.Generic.HashSet[string]'

$files = Get-ChildItem -Recurse "$root\src" -Include *.tsx
foreach ($f in $files) {
  $raw = [System.IO.File]::ReadAllText($f.FullName)
  foreach ($m in [regex]::Matches($raw, 'className\s*=\s*"([^"]*)"')) {
    foreach ($c in ($m.Groups[1].Value -split '\s+')) {
      if ($c -and $c -notmatch '[$`{}]') { [void]$used.Add($c) }
    }
  }
  foreach ($m in [regex]::Matches($raw, 'className=\{cn\((.*?)\)\}')) {
    foreach ($c in ($m.Groups[1].Value -split ',')) {
      $c = ($c -replace "['`\s]", '')
      if ($c -and $c -notmatch '[$`{}]') { [void]$used.Add($c) }
    }
  }
}

# collect class selectors defined in globals.css
$defined = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($m in [regex]::Matches($css, '\.([a-zA-Z][a-zA-Z0-9_-]*)')) {
  [void]$defined.Add($m.Groups[1].Value)
}

Write-Output '=== CSS classes DEFINED in globals.css but NOT used in any TSX ==='
$unused = @()
foreach ($c in $defined) { if (-not $used.Contains($c)) { $unused += $c } }
$unused | Sort-Object | ForEach-Object { Write-Output ('  .' + $_) }
Write-Output ("count: " + $unused.Count)

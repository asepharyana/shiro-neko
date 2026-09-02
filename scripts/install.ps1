# Installs shiro-neko from a GitHub release.
#
#   irm https://raw.githubusercontent.com/zakirkun/shiro-neko/main/scripts/install.ps1 | iex
#
# Set $env:SHIRO_VERSION to pin a version, $env:SHIRO_INSTALL_DIR to change the target.
$ErrorActionPreference = 'Stop'

$repo = if ($env:SHIRO_REPO) { $env:SHIRO_REPO } else { 'zakirkun/shiro-neko' }
$installDir = if ($env:SHIRO_INSTALL_DIR) { $env:SHIRO_INSTALL_DIR } else { Join-Path $HOME '.bun\bin' }

if ([Environment]::Is64BitOperatingSystem -ne $true) {
  Write-Error 'shiro: only 64-bit Windows is supported'
}
$asset = 'shiro-windows-x64.exe'

$base = if ($env:SHIRO_VERSION) {
  "https://github.com/$repo/releases/download/v$($env:SHIRO_VERSION -replace '^v','')"
} else {
  "https://github.com/$repo/releases/latest/download"
}

$tmp = Join-Path $env:TEMP "shiro-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  Write-Host "downloading $asset from $base"
  $downloaded = Join-Path $tmp $asset
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $downloaded -UseBasicParsing

  # Verify against the published checksums when they are available; a corrupted
  # 90 MB download otherwise fails later as an unexplained crash.
  try {
    $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing).Content
    $line = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" } | Select-Object -First 1)
    if ($line) {
      $expected = ($line -split '\s+')[0]
      $actual = (Get-FileHash -Path $downloaded -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne $expected.ToLower()) {
        Write-Error 'shiro: checksum mismatch, refusing to install'
      }
    }
  } catch {
    Write-Host 'no checksums published for this release, skipping verification'
  }

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  $target = Join-Path $installDir 'shiro.exe'
  Move-Item -Force -Path $downloaded -Destination $target

  Write-Host "installed $target"
  & $target --version

  $onPath = ($env:PATH -split ';' | Where-Object { $_ -and (Join-Path $_ '') -eq (Join-Path $installDir '') })
  if ($onPath) {
    Write-Host 'run: shiro'
  } else {
    Write-Host ''
    Write-Host "$installDir is not on PATH. Add it:"
    Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `"`$env:PATH;$installDir`", 'User')"
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

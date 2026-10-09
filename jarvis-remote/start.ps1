# Avvia Jarvis Remote su Windows e, se vuoi, lo rende raggiungibile con un link https.
#   .\start.bat                solo su questo PC (http://localhost:8787)
#   .\start.bat --tailscale    link https privato, visibile solo sui TUOI dispositivi (consigliato)
#   .\start.bat --cloudflare   link https pubblico temporaneo (protetto solo dal codice di accesso)
#   .\start.bat --lan          anche sulla rete di casa (solo http: niente microfono né installazione)
param([string]$Mode = '')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $env:PORT) { $env:PORT = '8787' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Serve Node.js 18 o più recente. Installalo con:  winget install OpenJS.NodeJS.LTS  (poi riapri il terminale)'
  exit 1
}
$userBin = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path $userBin)) {
  Write-Host 'Claude Code non trovato. Installalo con:  irm https://claude.ai/install.ps1 | iex  poi esegui "claude" una volta per fare il login.'
  exit 1
}

$tunnel = $null
$serveOn = $false
$extra = @()
try {
  switch ($Mode) {
    '--tailscale' {
      if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
        Write-Host 'Installa Tailscale (https://tailscale.com/download), accedi, poi riprova.'; exit 1
      }
      tailscale serve --bg $env:PORT | Out-Null
      $serveOn = $true
      $dns = ((tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
      if (-not $dns) { Write-Host 'Non riesco a leggere il nome Tailscale di questo PC.'; exit 1 }
      $env:JARVIS_PUBLIC_URL = "https://$dns"
      Write-Host "Indirizzo privato: $($env:JARVIS_PUBLIC_URL) (installa Tailscale anche su telefono/altro PC e accedi con lo stesso account)"
    }
    '--cloudflare' {
      if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
        Write-Host 'Installa cloudflared con:  winget install Cloudflare.cloudflared'; exit 1
      }
      $out = New-TemporaryFile; $err = New-TemporaryFile
      $tunnel = Start-Process cloudflared -ArgumentList "tunnel --url http://127.0.0.1:$($env:PORT)" `
        -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
      $url = $null
      for ($i = 0; $i -lt 30 -and -not $url; $i++) {
        Start-Sleep -Seconds 1
        $m = Select-String -Path $err, $out -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value }
      }
      if (-not $url) { Write-Host "Il tunnel non è partito, vedi $err"; exit 1 }
      $env:JARVIS_PUBLIC_URL = $url
      Write-Host 'ATTENZIONE: questo indirizzo è raggiungibile da chiunque lo conosca; ti protegge solo il codice di accesso.'
    }
    '--lan' { $extra = @('--lan') }
    ''      { }
    default { Write-Host "Opzione sconosciuta: $Mode"; exit 1 }
  }
  node server.js @extra
}
finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
  if ($serveOn) { tailscale serve reset 2>$null | Out-Null }
}

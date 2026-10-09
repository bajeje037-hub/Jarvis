#!/usr/bin/env bash
# Avvia Jarvis Remote e, se vuoi, lo rende raggiungibile con un link https.
#   ./start.sh               solo su questo computer (http://localhost:8787)
#   ./start.sh --tailscale   link https privato, visibile solo sui TUOI dispositivi (consigliato)
#   ./start.sh --cloudflare  link https pubblico temporaneo (protetto solo dal codice di accesso)
#   ./start.sh --lan         anche sulla rete di casa (solo http: niente microfono né installazione)
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
export PORT
MODE="${1:-}"

command -v node >/dev/null || { echo "Serve Node.js 18 o più recente: brew install node"; exit 1; }

cleanup() { [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true; [ "$MODE" = "--tailscale" ] && tailscale serve reset >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

case "$MODE" in
  --tailscale)
    command -v tailscale >/dev/null || { echo "Installa Tailscale (https://tailscale.com/download), accedi, poi riprova."; exit 1; }
    tailscale serve --bg "$PORT" >/dev/null
    DNS="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).Self.DNSName||"").replace(/\.$/,"")))')"
    [ -n "$DNS" ] || { echo "Non riesco a leggere il nome Tailscale di questo Mac."; exit 1; }
    export JARVIS_PUBLIC_URL="https://$DNS"
    echo "Indirizzo privato: $JARVIS_PUBLIC_URL (installa Tailscale anche su telefono/PC e accedi con lo stesso account)"
    ;;
  --cloudflare)
    command -v cloudflared >/dev/null || { echo "Installa cloudflared: brew install cloudflared"; exit 1; }
    LOG="$(mktemp)"
    cloudflared tunnel --url "http://127.0.0.1:$PORT" >"$LOG" 2>&1 &
    TUNNEL_PID=$!
    for _ in $(seq 1 30); do
      URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
      [ -n "$URL" ] && break; sleep 1
    done
    [ -n "${URL:-}" ] || { echo "Il tunnel non è partito, vedi $LOG"; exit 1; }
    export JARVIS_PUBLIC_URL="$URL"
    echo "ATTENZIONE: questo indirizzo è raggiungibile da chiunque lo conosca; ti protegge solo il codice di accesso."
    ;;
  --lan) set -- --lan ;;
  "") set -- ;;
  *) echo "Opzione sconosciuta: $MODE"; exit 1 ;;
esac

node server.js "$@"

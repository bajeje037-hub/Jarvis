# Jarvis Remote

Comanda **Jarvis** (Claude Code sul tuo Mac) dal telefono o da un altro PC, a voce o scrivendo.
È una web app installabile (PWA) più un piccolo server che gira sul Mac e lancia `claude -p`
con gli stessi parametri dell'app Jarvis. Nessuna dipendenza da installare, solo Node.js 18+.

```
telefono / PC  ──https──►  tunnel (Tailscale)  ──►  server su Mac  ──►  claude -p …
   (la PWA)                                          (questa cartella)   (i tuoi progetti)
```

## Avvio rapido (sul Mac)

Serve Node.js (`brew install node`) e Claude Code già installato e con il login fatto.

```bash
cd jarvis-remote
./start.sh --tailscale
```

Il terminale stampa un **link di accesso**. Aprilo sul telefono: il dispositivo viene collegato
e l'indirizzo si ripulisce dal codice. Poi installa l'app:

- **iPhone (Safari):** Condividi › Aggiungi a Home
- **Android (Chrome):** menu ⋮ › Installa app
- **PC (Chrome/Edge):** icona di installazione nella barra degli indirizzi

## Come ottenere il link

| Opzione | Comando | Quando usarla |
|---|---|---|
| **Tailscale** (consigliata) | `./start.sh --tailscale` | Link https privato, visibile solo ai tuoi dispositivi. Installa Tailscale anche su telefono/PC con lo stesso account. |
| Cloudflare Tunnel | `./start.sh --cloudflare` | Nessun account sul telefono, ma l'indirizzo è pubblico: ti protegge solo il codice. Cambia a ogni avvio. |
| Rete di casa | `./start.sh --lan` | Solo http: **microfono e installazione non funzionano**, la scrittura sì. |

Il microfono del browser e l'installazione come app richiedono **https** (o `localhost`).

## Windows

**Solo come telecomando** (il server resta sul Mac): sul PC apri il link in Chrome o Edge e clicca l'icona di installazione nella barra degli indirizzi. Non serve altro.

**Server su Windows** (Claude Code gira sul PC Windows), da PowerShell:

```powershell
# 1. Node.js (una volta sola)
winget install OpenJS.NodeJS.LTS

# 2. Claude Code, versione nativa (una volta sola), poi riapri PowerShell
irm https://claude.ai/install.ps1 | iex
claude          # fai il login e chiudi

# 3. Avvio, dalla cartella jarvis-remote
.\start.bat --tailscale
```

Per il link https privato installa Tailscale (`winget install Tailscale.Tailscale`) e accedi. Anche `--cloudflare`
(`winget install Cloudflare.cloudflared`) e `--lan` funzionano come su Mac. Senza opzioni parte solo su `http://localhost:8787`.
`start.bat` si può avviare anche con un doppio clic.

Note per Windows:
- Serve il vero `claude.exe` (installer nativo o WinGet, in `%USERPROFILE%\.local\bin`). L'installazione via npm crea uno script `.cmd` che il server non può avviare.
- Con «Ferma» il server chiude tutto l'albero di processi della sessione (Windows non ha l'interruzione gentile).
- Il PC deve restare acceso e non in sospensione, altrimenti il link non risponde.
- Se `.local\bin` non è nel PATH il server lo cerca comunque; per cambiare cartella usa la variabile `CLAUDE_BIN`.
- Questa parte non è stata provata su un Windows reale, solo il server su Linux con un finto `claude`.

## Jarvis.exe (Windows) e Jarvis.apk (Android)

- **Jarvis.exe**: doppio clic e parte tutto (server + finestra dell'app). Al primo avvio crea l'icona sul Desktop e nel menu Start.
  Se c'è Tailscale prepara anche il link https per il telefono, mostrato in Impostazioni › «Collega il telefono».
  Chiudere la finestra nera spegne Jarvis. Opzioni: `--autostart` (parte con Windows), `--no-window`, `--no-tunnel`, `--shortcut`.
  Serve comunque Claude Code installato e con il login fatto sul PC.
- **Jarvis.apk**: telecomando per Android. Al primo avvio chiede il link di accesso (con `?t=…`), poi lo ricorda.
  La dettatura usa il riconoscimento vocale di sistema (il WebView non ha quello del browser). Il server resta sul PC.
  Installa l'APK consentendo «Origini sconosciute»; Play Protect può mostrare un avviso perché non viene dal Play Store.

### Come ottenere i due file

I file non si possono compilare da questa cartella senza gli strumenti Windows/Android: li costruisce GitHub in automatico.

1. Crea un repository **privato** su GitHub (la chiave di firma dell'APK è nella cartella `android/`) e carica tutto il contenuto di questa cartella.
2. Scheda **Actions** › «Crea Jarvis.exe e Jarvis.apk» › **Run workflow**. Dopo 5-10 minuti, nella pagina dell'esecuzione trovi in fondo
   gli **Artifacts** `Jarvis-Windows` (Jarvis.exe) e `Jarvis-Android` (Jarvis.apk).
3. Con un tag (`git tag v1.0.0 && git push --tags`) i file finiscono anche in **Releases**, comodi da scaricare dal telefono.

Alternativa solo Windows, senza GitHub: da un PC Windows con Node.js 22 esegui `node build/build-exe.js` (serve internet) e trovi `dist/Jarvis.exe`.
Per l'APK in locale: apri la cartella `android/` con Android Studio e scegli Build › Build APK.

## Cosa puoi dire

- «Crea una pagina con un orologio» → nuova sessione di Claude Code
- «Nel progetto sito, sistema l'header» → parte nella cartella `sito` (sottocartelle di `projectsRoot`)
- «Aggiungi anche il footer» → riprende la sessione conclusa da meno di 10 minuti
- «A che punto sei?», «Fermati», «Pulisci»
- «Ricordati che preferisco TypeScript» → preferenza salvata e passata a tutte le sessioni future
- Con «Ascolta il nome Jarvis» attivo (Impostazioni) basta dire «Jarvis, …» ad app aperta

Quando una sessione parla (frasi brevi di avanzamento e risultato finale) il telefono la legge a voce.

## Configurazione

Al primo avvio nasce `~/.jarvis-remote/config.json` (permessi 600):

| Chiave | Significato |
|---|---|
| `token` | Il codice di accesso (generato, 192 bit). Cancella il file per cambiarlo. |
| `projectsRoot` | Cartella le cui sottocartelle sono i progetti (default: la tua home) |
| `defaultCwd` | Dove partono le richieste senza progetto |
| `allowBypass` | `false` di default. Le sessioni usano `acceptEdits`, non saltano i permessi |
| `model` | Modello di Claude Code (vuoto = predefinito) |
| `port`, `host` | Default `8787` su `127.0.0.1` |

Variabili utili: `PORT`, `CLAUDE_BIN` (percorso di `claude`), `JARVIS_PROJECTS_ROOT`, `JARVIS_REMOTE_HOME`.

## Sicurezza (leggi questa parte)

Questo server permette di far eseguire comandi e modificare file sul tuo Mac da remoto.

- Il server ascolta solo su `127.0.0.1`: arriva dall'esterno solo tramite il tunnel che scegli tu.
- Ogni richiesta richiede il codice (cookie HttpOnly/SameSite=Strict o header Bearer); 10 errori in 10 minuti bloccano l'IP.
- Chi ha il link con `?t=` ha accesso completo: non condividerlo né pubblicarlo. Per revocarlo cancella `token` da `config.json` e riavvia.
- Le sessioni non saltano i permessi: Claude Code in modalità `acceptEdits` rifiuta ciò che richiederebbe un ok, e la sessione risulta «Serve il tuo ok» (non c'è modo di rispondere da remoto).
- Preferisci **Tailscale** a Cloudflare: con Cloudflare l'unica barriera è il codice.
- `ANTHROPIC_API_KEY` viene tolta dall'ambiente dei processi figli, come fa Jarvis: si usa l'abbonamento Claude Code.

## Differenze rispetto all'app Jarvis per Mac

- La **dettatura** è quella del browser (Web Speech API): su Chrome/Android e Safari/iOS l'audio può passare dai server di Google o Apple. L'app per Mac usa il riconoscimento di macOS.
- Niente scorciatoie globali, nessun `open` sul Mac, nessun supporto Codex, nessun orchestratore: le richieste vanno direttamente a Claude Code.
- Gli avanzamenti arrivano solo ad app aperta; a schermo spento il telefono non è avvisato (le notifiche push richiederebbero un servizio esterno).
- Il server funziona anche su Windows e Linux (vedi sezione Windows); `start.sh` è per macOS/Linux, `start.bat` per Windows.

## Test

`node test/run.js` avvia il server con un finto `claude` e controlla autenticazione, sessioni,
continuazione, stop, memoria, SSE e protezioni (23 controlli).

## Struttura

```
server.js          server HTTP, sessioni, SSE, autenticazione
lib/parser.js      parser dello stream di Claude Code (porting di StreamParsers.swift)
launcher.js        punto di ingresso di Jarvis.exe
build/             creazione dell'.exe (bundle.js, build-exe.js, icona)
android/           app Android (WebView + dettatura nativa)
.github/workflows  build automatico di .exe e .apk
public/            la PWA (index.html, app.js, style.css, sw.js, manifest, icone)
start.sh           avvio + tunnel (macOS/Linux)
start.bat/.ps1     avvio + tunnel (Windows)
test/              test end-to-end e finto claude
```

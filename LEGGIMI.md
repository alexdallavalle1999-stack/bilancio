# Bilancio

App personale per spese ed entrate (PWA). I dati restano sul telefono, nell'archivio del browser; la copia di sicurezza è il backup cifrato che salvi su Drive.

## Pubblicazione su GitHub Pages
1. Su github.com crea un repository nuovo (es. `bilancio`), pubblico.
2. "Add file" → "Upload files": trascina **il contenuto** di questa cartella (index.html deve stare nella radice del repository), poi "Commit changes".
3. Settings → Pages → Source: "Deploy from a branch", Branch: `main`, cartella `/ (root)` → Save.
4. Dopo un minuto l'app è su `https://<tuo-utente>.github.io/bilancio/`.

Nel repository c'è solo il codice: nessun dato personale.

## Sul telefono
1. Apri l'indirizzo con Chrome → menu ⋮ → "Installa app" (o "Aggiungi a schermata Home").
2. Altro → Backup e ripristino → "Scegli file di backup" → seleziona `dati_iniziali_bilancio.json`.
3. Altro → Importa estratto conto → carica l'estratto BBVA (Excel o PDF).
4. Altro → Backup e ripristino → "Crea backup e salva su Drive".

## Cambio telefono
Installa l'app sul nuovo telefono, Altro → Backup e ripristino → "Scegli file di backup", prendi l'ultimo backup da Drive e inserisci la password.

## Copia di prova
La cartella `test/` è una copia dell'app per provare le novità: si apre da `https://<utente>.github.io/bilancio/test/`, si installa come app separata ("Bilancio Test") e usa un archivio dati suo, separato da quello dell'app vera.

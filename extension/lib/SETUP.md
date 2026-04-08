# lib/ — Required Libraries

Place the following two files in this folder before using the PDF parser:

## pdf.js (Mozilla) — v4+ ES module format

1. Go to: https://github.com/mozilla/pdf.js/releases
2. Click the latest release
3. Under "Assets", download: `pdfjs-X.X.X-dist.zip`
4. Unzip it — copy these two files into this `lib/` folder:
   - `pdf.mjs`        → `extension/lib/pdf.mjs`
   - `pdf.worker.mjs` → `extension/lib/pdf.worker.mjs`

## After adding the files

Reload the extension in Chrome:
- Go to `chrome://extensions`
- Find "GroceryDeals Entry Automation"
- Click the refresh/reload icon (↺)

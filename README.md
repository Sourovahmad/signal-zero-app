# Build A Complete Desktop (desktop application)

The folder `site/` holds the website exactly as it was delivered and
quality-checked. `main.js` opens it in a desktop window with Electron.

## Run it

    npm install
    npm start

## Build installers

    npm run pack     # an unpacked app in dist/, quick to try
    npm run dist     # installers for this operating system in dist/

Installers are unsigned. Signing needs your own developer certificate; see the
electron-builder documentation for `mac.identity`, `win.certificateFile` and
notarization.

## Update the website

Replace the contents of `site/` with a newer delivered site and build again.

// SIGNAL ZERO - Electron shell (offline desktop window).
// CommonJS (package.json has no "type", so .js = CommonJS; the app itself uses
// .mjs ES modules loaded by the renderer). Loads index.html from local files
// with no network access.
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    backgroundColor: '#05100a',
    title: 'SIGNAL ZERO',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

'use strict';

const path = require('path');
const { app, BrowserWindow, session } = require('electron');

async function run() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(path.join(__dirname, 'dom-sanitizer.html'));
  const result = await window.webContents.executeJavaScript('window.runWritCraftDomSanitizerProbe()', true);
  process.stdout.write(`WRITCRAFT_DOM_SANITIZER_RESULT=${JSON.stringify(result)}\n`);
  window.destroy();
  app.quit();
}

run().catch(error => {
  process.stderr.write(`DOM sanitizer fixture failed: ${error?.stack || error}\n`);
  app.exit(1);
});

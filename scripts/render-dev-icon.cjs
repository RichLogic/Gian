const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.setPath('userData', process.env.GIAN_ICON_PROFILE);
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '../packages/desktop/renderer/gian-icon.svg'), 'utf8')
    .replace('</svg>', '<rect x="782" y="48" width="424" height="190" rx="36" fill="#17191b" stroke="#ffffff" stroke-width="12"/><text x="994" y="183" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-weight="700" font-size="132">DEV</text></svg>');
  const window = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true, show: false, frame: false, transparent: true, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{width:100%;height:100%}</style>' + svg));
  const frame = await window.webContents.capturePage();
  writeFileSync(process.env.GIAN_ICON_OUTPUT, frame.toPNG());
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

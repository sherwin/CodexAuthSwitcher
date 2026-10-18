const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { windowIcon } = require('../electron/desktop-shell.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-smoke-'));
let finished = false;
function finish(error) {
    if (finished) return; finished = true;
    clearTimeout(deadline);
    if (error) { console.error(error.message); process.exitCode = 1; }
    else console.log('DESKTOP_SMOKE_OK ' + process.platform);
    app.quit();
}
const deadline = setTimeout(() => { console.error('Desktop startup timed out'); app.exit(1); }, 30000);
app.setPath('userData', path.join(root, 'electron'));
for (const [name, leaf] of [['AUTH_SWITCHER_HOME','state'],['AUTH_SWITCHER_AUTH_DIR','accounts'],['CODEX_HOME','codex']]) {
    process.env[name] = path.join(root,leaf); fs.mkdirSync(process.env[name], { recursive: true });
}
// A temporary empty account directory makes this test entirely offline.
app.on('browser-window-created', (_event, window) => {
    window.webContents.on('render-process-gone', () => finish(Error('Renderer process exited')));
    window.webContents.once('did-finish-load', async () => {
        try {
            const result = await window.webContents.executeJavaScript('window.authSwitcher.call("status")');
            if (!result.ok || !result.result.proxy_running) throw Error('Native preload could not reach its local gateway');
            const rendered = await window.webContents.executeJavaScript('Boolean(document.querySelector("#workspace-tabs") && document.querySelector("#codex-modes"))');
            if (!rendered || nativeImage.createFromPath(windowIcon()).isEmpty()) throw Error('Desktop UI or native icon is missing');
            // Let the renderer's initial refresh finish before shutting down its gateway.
            await window.webContents.executeJavaScript(`new Promise(resolve => {
                const ready = () => document.querySelector('#refresh').disabled
                    ? setTimeout(ready, 20) : resolve();
                ready();
            })`);
            finish();
        } catch (error) { finish(error); }
    });
});
const reservation = net.createServer();
reservation.listen(0,'127.0.0.1', () => {
    const port = reservation.address().port;
    reservation.close(() => {
        fs.writeFileSync(path.join(process.env.AUTH_SWITCHER_HOME,'proxy.json'), JSON.stringify({
            key:'offline-smoke-key', port, enabled:false, auth_directory:process.env.AUTH_SWITCHER_AUTH_DIR,
        }));
        require('../electron/main.cjs');
    });
});

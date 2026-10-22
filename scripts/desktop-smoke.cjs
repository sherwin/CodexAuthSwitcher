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
            await window.webContents.executeJavaScript(`(async () => {
                document.querySelector('#add-deepseek').click();
                if (!document.querySelector('#deepseek-dialog').open) throw Error('DeepSeek form did not open');
                document.querySelector('#deepseek-name').value = 'DeepSeek smoke';
                document.querySelector('#deepseek-url').value = 'https://example.com/v1/';
                document.querySelector('#deepseek-key').value = 'offline-deepseek-key';
                document.querySelector('#deepseek-form').requestSubmit();
                await new Promise((resolve, reject) => {
                    const ready = () => {
                        if (document.querySelector('#deepseek-dialog').open && !document.querySelector('#save-deepseek').disabled)
                            return reject(Error(document.querySelector('#deepseek-status').textContent || 'Save did not start'));
                        if (!document.querySelector('#save-deepseek').disabled && !document.querySelector('#refresh').disabled) resolve();
                        else setTimeout(ready, 20);
                    };
                    ready();
                });
                const list = await window.authSwitcher.call('accounts');
                const account = list.result.accounts.find(item => item.name === 'DeepSeek smoke.json');
                if (!account || account.base_url !== 'https://example.com/v1') throw Error('Desktop did not save DeepSeek fields');
                if (JSON.stringify(list).includes('offline-deepseek-key')) throw Error('Saved key leaked to renderer');
                if (!document.querySelector('#accounts').textContent.includes('编辑配置')) throw Error('DeepSeek card missing');
                if (document.querySelector('#codex-accounts').textContent.includes('DeepSeek smoke')) throw Error('DeepSeek listed for Codex auth-file');
                document.querySelector('#accounts .actions button').click();
                if (document.querySelector('#deepseek-key').value || document.querySelector('#deepseek-key').required)
                    throw Error('Edit must preserve key without returning it');
                document.querySelector('#deepseek-url').value = 'https://api.deepseek.com';
                document.querySelector('#deepseek-form').requestSubmit();
                await new Promise(resolve => {
                    const ready = () => document.querySelector('#save-deepseek').disabled || document.querySelector('#refresh').disabled
                        ? setTimeout(ready, 20) : resolve();
                    ready();
                });
                if (document.querySelector('#deepseek-dialog').open) throw Error('DeepSeek edit failed');
                if (document.querySelector('#deepseek-key').value) throw Error('Closed form retained API Key');
            })()`);
            const account = JSON.parse(fs.readFileSync(path.join(process.env.AUTH_SWITCHER_AUTH_DIR, 'DeepSeek smoke.json')));
            if (account.DEEPSEEK_API_KEY !== 'offline-deepseek-key' || account.base_url !== 'https://api.deepseek.com')
                throw Error('Desktop edit did not preserve the saved Key');
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

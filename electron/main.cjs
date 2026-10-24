const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, clipboard, net, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { windowIcon, installDesktopShell } = require('./desktop-shell.cjs');
if (process.platform === 'win32') app.setAppUserModelId('com.sherwin.codex-auth-switcher.electron');

let window;
let tray;
let gateway;
let quitting = false;
let shutdownPromise;
let service;
let directory;
let networkBusy = false;
let externalService = false;

// Membership is a ChatGPT web endpoint. Use the desktop's normal Chromium network
// stack and system proxy, without sharing browser cookies; inference stays in Node.
const gatewayOptions = { fetchSubscription: (url, options) => net.fetch(url, { ...options, credentials: 'omit' }) };

function createWindow() {
    window = new BrowserWindow({ width: 1060, height: 790, minWidth: 800, minHeight: 580,
        title: 'Codex Auth Switcher', backgroundColor: '#10151f',
        icon: windowIcon(),
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
            nodeIntegration: false, sandbox: true } });
    window.loadFile(path.join(__dirname, 'index.html'));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => { window?.show(); window?.focus(); });
    app.whenReady().then(async () => {
        service = await import('../proxy/server.mjs');
        if (process.platform === 'win32' && !(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY)) {
            const { systemProxyFetch } = await import('../proxy/system-proxy.mjs');
            gatewayOptions.fetchUpstream = systemProxyFetch(url => session.defaultSession.resolveProxy(url));
        }
        const storage = await import('../proxy/storage.mjs');
        directory = storage.defaultDirectory;
        await storage.initialize(directory);
        const statePath = path.join(directory, 'proxy.json');
        let state = await storage.readJSON(statePath);
        // Match the signed-in identity on first launch; later launches honor the saved route.
        if (!state.selected_file) {
            const { sameIdentity } = await import('../proxy/credentials.mjs');
            const current = await storage.readJSON(path.join(storage.codexDirectory, 'auth.json')).catch(() => null);
            const names = await fs.readdir(state.auth_directory).catch(() => []);
            for (const name of names.filter(name => name.endsWith('.json'))) {
                const record = await storage.readJSON(storage.accountPath(state, name)).catch(() => null);
                if (current && record && sameIdentity(current, record)) { state.selected_file = name; break; }
            }
            await storage.writeJSON(statePath, state);
        }
        try { await service.localCall(directory, '/health'); externalService = true; }
        catch {
            try { gateway = await service.start(directory, gatewayOptions); }
            catch (error) { await dialog.showMessageBox({ type: 'error', message: 'Local proxy could not start',
                detail: error.code === 'EADDRINUSE' ? `Port ${state.port} is occupied by another process.` : 'Check your account directory and file permissions.' }); }
        }
        ipcMain.handle('proxy-call', async (_event, action, input) => {
            if (networkBusy && action !== 'status') return { ok: false, error: '网络设置正在更新，请稍后重试。' };
            const allowed = { status: '/health', accounts: '/admin/accounts', statistics: '/admin/statistics', requestLogs: '/admin/request-logs', requestLog: '/admin/request-logs', settings: '/admin/settings', usage: '/admin/usage',
                select: '/admin/select', deepseek: '/admin/deepseek', configure: '/admin/configure', custom: '/admin/custom', authFile: '/admin/auth-file', unconfigure: '/admin/unconfigure' };
            if (!Object.hasOwn(allowed, action)) throw new Error('Unsupported action.');
            try {
                const route = action === 'requestLog' ? `${allowed[action]}/${Number(input?.id) || 0}` : allowed[action];
                const result = await service.localCall(directory, route,
                    ['status', 'accounts', 'statistics', 'requestLogs', 'requestLog'].includes(action) && input === undefined ? undefined : action === 'deepseek' || action === 'custom'
                        ? { name: input?.name, base_url: input?.base_url, api_key: input?.api_key, edit: input?.edit === true }
                        : action === 'settings' || action === 'requestLogs' ? input : action === 'requestLog' ? undefined
                        : { name: typeof input?.name === 'string' ? input.name : undefined });
                return { ok: true, result };
            } catch (error) { return { ok: false, error: error.message, code: error.code || 'proxy_unavailable' }; }
        });
        ipcMain.handle('choose-directory', async () => {
            if (networkBusy) throw new Error('网络设置正在更新。');
            const choice = await dialog.showOpenDialog(window, { title: 'Choose authorization backup directory', properties: ['openDirectory'] });
            if (choice.canceled) return false;
            const health = await service.localCall(directory, '/health');
            if (health.in_flight) throw new Error('Wait for running requests to finish before changing directories.');
            if (!gateway) throw new Error('The standalone proxy owns this directory. Change AUTH_SWITCHER_AUTH_DIR there.');
            await gateway.close();
            state = await storage.readJSON(statePath);
            state.auth_directory = choice.filePaths[0];
            delete state.selected_file;
            await storage.writeJSON(statePath, state);
            gateway = await service.createGateway(directory, gatewayOptions);
            return true;
        });
        ipcMain.handle('network-settings', async (_event, input) => {
            if (networkBusy) throw new Error('网络设置正在更新。');
            if (externalService) throw new Error('当前代理由独立进程运行，请从 Electron 启动代理后再修改。');
            const { changeNetwork, validateNetwork } = await import('../proxy/network.mjs');
            const settings = validateNetwork(input);
            networkBusy = true;
            try {
                const current = await storage.readJSON(statePath);
                if (settings.lan_enabled && !current.lan_enabled) {
                    const answer = await dialog.showMessageBox(window, { type: 'warning', buttons: ['取消', '开启局域网'],
                        defaultId: 0, cancelId: 0, message: '允许局域网其他电脑使用代理？',
                        detail: '服务将监听所有 IPv4 网卡，仅接受私有网络地址。持有 Key 的电脑可以消耗当前账号额度；管理接口仍仅限本机。HTTP 不加密，请只在可信局域网使用，不要设置公网端口转发。' });
                    if (answer.response !== 1) return { canceled: true };
                }
                const result = await changeNetwork(directory, settings, {
                    gateway: gateway || { pause: () => {}, close: async () => {} },
                    startGateway: directory => service.createGateway(directory, gatewayOptions) });
                gateway = result.gateway;
                return { ok: true, configChanged: result.configChanged };
            } catch (error) {
                if (error.restoredGateway) gateway = error.restoredGateway;
                await gateway?.notifyError(error);
                throw new Error(error.code === 'EADDRINUSE' ? '端口已被占用，已恢复原网络设置。' :
                    error.message || '网络设置失败，请检查代理状态。');
            } finally { networkBusy = false; }
        });
        ipcMain.handle('curl-command', async (_event, action, target, streaming) => {
            if (!['preview', 'copy'].includes(action)) throw new Error('Unsupported action.');
            const { curlCommand } = await import('../proxy/curl.mjs');
            const { shareHost } = await import('../proxy/network.mjs');
            const current = await storage.readJSON(statePath);
            const health = await service.localCall(directory, '/health');
            const host = shareHost(health, target);
            const stream = streaming === true;
            const curlState = { ...current, selected_provider: health.selected_provider };
            if (action === 'preview') return curlCommand(curlState, '', { masked: true, host, stream });
            clipboard.writeText(curlCommand(curlState, '', { host, stream }));
            return true;
        });
        createWindow();
        tray = installDesktopShell({ app, window, Menu, Tray, nativeImage });
    }).catch(async () => {
        await dialog.showMessageBox({ type: 'error', message: 'Unable to initialize Auth Switcher',
            detail: 'Create your authorization backup directory, then reopen the app.' });
        quitting = true;
        app.quit();
    });
}

app.on('activate', () => { if (window && !window.isDestroyed()) window.show(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    // Repeated quit events share shutdown; finish pending statistics writes before exiting.
    if (shutdownPromise) return;
    shutdownPromise = Promise.resolve().then(() => gateway?.close()).catch(async () => {
        await gateway?.notifyError?.({ code: 'proxy_shutdown_failed' });
    }).finally(() => {
        quitting = true;
        app.quit();
    });
});

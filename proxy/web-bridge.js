/* Adapt the shared desktop renderer to the authenticated remote backend. */
(() => {
    function redirectToLogin(message) {
        if (sessionStorage.getItem('codex-auth-login-redirect')) return false;
        sessionStorage.setItem('codex-auth-login-redirect', '1');
        if (message) sessionStorage.setItem('codex-auth-login-message', message);
        location.replace('/');
        return true;
    }
    const routes = { status: ['status'], accounts: ['accounts'], statistics: ['statistics'], requestLogs: ['requestLogs', true], requestLog: ['requestLogs', true], settings: ['settings', true], priority: ['priority', true], custom: ['custom', true],
        usage: ['usage', true], select: ['select', true], deepseek: ['deepseek', true], configure: ['configure', true],
        authFile: ['auth-file', true], unconfigure: ['unconfigure', true] };
    async function request(route, data) {
        const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Switcher-Web': '1' },
            body: data === undefined ? undefined : JSON.stringify(data) });
        const result = await response.json();
        if (response.status === 401) { redirectToLogin('登录已过期，请重新登录。'); throw Error('登录已过期，请重新登录。'); }
        if (!response.ok) throw Error(result.error || '操作失败');
        return result;
    }
    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true);
        const field = document.createElement('textarea');
        field.value = text; field.setAttribute('aria-label', '复制命令');
        field.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
        document.body.append(field); field.focus(); field.select();
        try { if (!document.execCommand('copy')) throw Error('浏览器未允许复制，请在 HTTPS 环境重试。'); return true; }
        finally { field.remove(); }
    }
    window.authSwitcher = Object.freeze({
        async call(action, input) {
            const route = routes[action];
            if (!route) return { ok: false, error: '不支持的操作' };
            const readSettings = (action === 'priority' || action === 'settings') && input === undefined;
            try { return { ok: true, result: await request(route[0], route[1] && !readSettings ? input || {} : undefined) }; }
            catch (error) { return { ok: false, error: error.message }; }
        },
        async chooseDirectory() {
            return chooseRemoteDirectory();
        },
        async curlCommand(action, target, stream) {
            const { command } = await request('curl', { action, target, stream });
            return action === 'copy' ? copyText(command) : command;
        },
        async networkSettings(input) {
            if (input.lan_enabled && !confirm('Allow LAN computers to use this Linux host proxy? Anyone with the key can consume the current account quota. HTTP is unencrypted; use only on a trusted LAN.')) return { canceled: true };
            return request('network', input);
        },
    });
    let directoryOpen = false;
    async function chooseRemoteDirectory() {
        if (directoryOpen) return false;
        directoryOpen = true;
        const dialog = document.createElement('dialog'); dialog.className = 'web-directory';
        dialog.setAttribute('aria-label', 'Choose remote auth directory');
        dialog.innerHTML = '<h2>Choose remote auth directory</h2><p class="muted">Browse folders on this Linux host. Selecting a directory clears the proxy account selection and keeps existing Codex auth unchanged.</p><form class="web-path"><input aria-label="Remote directory path" required><button>Open</button></form><button class="web-parent">Parent</button><div class="web-folders"></div><p class="muted web-directory-status" role="status"></p><div class="actions"><button class="web-cancel">Cancel</button><button class="primary web-select">Use this directory</button></div>';
        const field = dialog.querySelector('input'), list = dialog.querySelector('.web-folders');
        const info = dialog.querySelector('.web-directory-status'), select = dialog.querySelector('.web-select');
        let current, loaded = false;
        async function load(target = '') {
            loaded = false; select.disabled = true; info.textContent = '读取目录…';
            try {
                current = await request('directories?path=' + encodeURIComponent(target));
                field.value = current.path; list.replaceChildren();
                for (const entry of current.directories) {
                    const button = document.createElement('button'); button.textContent = entry.name;
                    button.onclick = () => load(entry.path); list.append(button);
                }
                info.textContent = current.directories.length ? '选择文件夹进入，或使用当前目录。' : '此目录没有可见子文件夹。';
                loaded = true; select.disabled = false;
            } catch (error) { info.textContent = error.message; }
        }
        document.body.append(dialog); dialog.showModal();
        dialog.querySelector('form').onsubmit = event => { event.preventDefault(); load(field.value); };
        dialog.querySelector('.web-parent').onclick = () => { if (current) load(current.parent); };
        dialog.querySelector('.web-cancel').onclick = () => dialog.close('cancel');
        select.onclick = async () => {
            if (!loaded) return; select.disabled = true;
            try { await request('directory', { path: current.path }); dialog.close('selected'); }
            catch (error) { info.textContent = error.message; select.disabled = false; }
        };
        const result = new Promise(resolve => dialog.addEventListener('close', () => {
            const selected = dialog.returnValue === 'selected'; dialog.remove(); directoryOpen = false; resolve(selected);
        }, { once: true }));
        await load(); return result;
    }
    const actions = document.querySelector('header .actions');
    const upload = document.createElement('button'), logout = document.createElement('button');
    upload.textContent = '导入授权文件'; logout.textContent = '退出登录';
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'; input.multiple = true; input.hidden = true;
    const status = document.createElement('p'); status.className = 'muted web-status'; status.setAttribute('role', 'status');
    actions.append(upload, logout, input); document.querySelector('header').after(status);
    document.querySelector('header .eyebrow').textContent = 'LINUX / LAN ACCOUNT GATEWAY';
    document.querySelector('header .muted').textContent = 'Manage the local proxy and Codex configuration on this Linux host.';
    for (const id of ['directory', 'codex-directory']) document.getElementById(id).textContent = 'Change remote auth directory';
    upload.onclick = () => input.click();
    input.onchange = async () => {
        upload.disabled = true; let imported = 0;
        try {
            for (const file of input.files) {
                if (file.size > 1024 * 1024) throw Error('文件超过 1 MiB：' + file.name);
                await request('import', { name: file.name, auth: await file.text() }); imported++;
            }
            status.textContent = `已导入 ${imported} 个账号。`; document.getElementById('refresh').click();
        } catch (error) { status.textContent = `已导入 ${imported} 个账号；${error.message}`; if (imported) document.getElementById('refresh').click(); }
        finally { upload.disabled = false; input.value = ''; }
    };
    logout.onclick = async () => {
        try { await request('logout', {}); location.replace('/'); }
        catch (error) { status.textContent = error.message; }
    };
})();

/* Adapt the unchanged desktop renderer to the authenticated Surface backend. */
(() => {
    const routes = { status: ['status'], accounts: ['accounts'], statistics: ['statistics'], requestLogs: ['requestLogs', true], requestLog: ['requestLogs', true], settings: ['settings', true], priority: ['priority', true], custom: ['custom', true],
        usage: ['usage', true], select: ['select', true], deepseek: ['deepseek', true], configure: ['configure', true],
        authFile: ['auth-file', true], unconfigure: ['unconfigure', true] };
    async function request(route, data) {
        const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Switcher-Web': '1' },
            body: data === undefined ? undefined : JSON.stringify(data) });
        const result = await response.json();
        if (response.status === 401) { location.replace('/'); throw Error('登录已过期，请重新登录。'); }
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
            try { return { ok: true, result: await request(route[0], route[1] ? input || {} : undefined) }; }
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
            if (input.lan_enabled && !confirm('允许局域网电脑使用 Surface 的代理？持有 Key 的电脑可以消耗当前账号额度。HTTP 不加密，请仅在可信局域网开启。')) return { canceled: true };
            return request('network', input);
        },
    });
    let directoryOpen = false;
    async function chooseRemoteDirectory() {
        if (directoryOpen) return false;
        directoryOpen = true;
        const dialog = document.createElement('dialog'); dialog.className = 'web-directory';
        dialog.setAttribute('aria-label', '选择 Surface 授权目录');
        dialog.innerHTML = '<h2>选择 Surface 授权目录</h2><p class="muted">这里显示 Surface 上的文件夹。选择后代理出口将清空，Codex 现有授权保持不变。</p><form class="web-path"><input aria-label="Surface 目录路径" required><button>前往</button></form><button class="web-parent">上级目录</button><div class="web-folders"></div><p class="muted web-directory-status" role="status"></p><div class="actions"><button class="web-cancel">取消</button><button class="primary web-select">使用此目录</button></div>';
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
    document.querySelector('header .eyebrow').textContent = 'SURFACE / LAN ACCOUNT GATEWAY';
    document.querySelector('header .muted').textContent = '远程管理 Surface 上的本地代理与 Codex 配置。';
    for (const id of ['directory', 'codex-directory']) document.getElementById(id).textContent = '更改 Surface 授权目录';
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

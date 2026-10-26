(() => {
    function redirectToLogin() {
        if (sessionStorage.getItem('codex-auth-login-redirect')) return false;
        sessionStorage.setItem('codex-auth-login-redirect', '1'); location.replace('/'); return true;
    }
    const panel = document.createElement('section'); panel.className = 'card web-runtime'; panel.hidden = true;
    panel.innerHTML = '<h3>Codex / Feishu connection</h3><p class="muted">Restart the Feishu bridge and its Codex child processes after applying key mode or switching an auth file. Proxy account changes take effect on new requests without a restart.</p><p class="muted web-runtime-status" role="status">Loading service status…</p><div class="actions"><button class="web-runtime-restart">Restart Codex / Feishu</button><button class="primary web-runtime-proxy">Apply proxy mode and restart</button></div><p class="muted web-runtime-result" role="status"></p>';
    document.querySelector('.codex-panel').append(panel);
    const state = panel.querySelector('.web-runtime-status'), result = panel.querySelector('.web-runtime-result');
    const buttons = [...panel.querySelectorAll('button')];
    let current, busy = false;
    async function request(route, body) {
        const response = await fetch('/api/runtime' + route, { method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Switcher-Web': '1' },
            body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await response.json();
        if (response.status === 401) { redirectToLogin(); throw Error('登录已过期'); }
        if (!response.ok) throw Error(data.error || '操作失败');
        return data;
    }
    async function refresh() {
        try {
            current = await request(''); panel.hidden = !current.available;
            state.textContent = current.active ? `飞书连接运行中 · PID ${current.pid}` +
                (current.children ? ` · ${current.children} 个子进程正在运行` : '') : '飞书连接未运行';
        } catch (error) { state.textContent = error.message; }
    }
    async function restart(proxy) {
        if (busy) return;
        busy = true; buttons.forEach(button => { button.disabled = true; });
        try {
            if (!await confirmRestart(proxy)) return;
            result.textContent = proxy ? '正在应用代理配置并重启…' : '正在重启…';
            await request(proxy ? '/proxy' : '/restart', { force: true });
            result.textContent = proxy ? '代理模式已接入，飞书连接已重启。之后切换代理出口即可，无需重启。' : '飞书连接已重启，后续 Codex 请求将读取当前配置。';
            document.getElementById('refresh').click();
        } catch (error) { result.textContent = error.message; }
        finally { busy = false; buttons.forEach(button => { button.disabled = false; }); await refresh(); }
    }
    function confirmRestart(proxy) {
        const dialog = document.createElement('dialog'); dialog.className = 'web-directory';
        dialog.setAttribute('aria-label', 'Confirm Codex restart');
        const text = document.createElement('p'); text.textContent =
            (proxy ? 'Connect Codex to the local proxy and restart Feishu.' : 'Restart the Feishu bridge and its Codex child processes.') +
            ' Running Feishu tasks will be interrupted; existing chat history is kept.';
        const actions = document.createElement('div'); actions.className = 'actions';
        const cancel = document.createElement('button'), confirm = document.createElement('button');
        cancel.textContent = '取消'; confirm.textContent = '确认重启'; confirm.className = 'primary';
        cancel.onclick = () => dialog.close('cancel'); confirm.onclick = () => dialog.close('confirm');
        actions.append(cancel, confirm); dialog.append(text, actions); document.body.append(dialog); dialog.showModal();
        return new Promise(resolve => dialog.addEventListener('close', () => {
            const confirmed = dialog.returnValue === 'confirm'; dialog.remove(); resolve(confirmed);
        }, { once: true }));
    }
    panel.querySelector('.web-runtime-restart').onclick = () => restart(false);
    panel.querySelector('.web-runtime-proxy').onclick = () => restart(true);
    refresh(); setInterval(() => { if (!busy) refresh(); }, 10000);
})();

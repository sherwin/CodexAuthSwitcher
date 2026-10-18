(() => {
    const panel = document.createElement('section'); panel.className = 'card web-runtime'; panel.hidden = true;
    panel.innerHTML = '<h3>Surface Codex／飞书连接</h3><p class="muted">应用 Key 模式或切换授权文件后，可在这里重启飞书连接及其 Codex 子进程。代理模式只需首次接入时重启；之后切换代理出口，新请求立即生效。</p><p class="muted web-runtime-status" role="status">读取服务状态…</p><div class="actions"><button class="web-runtime-restart">重启 Codex／飞书连接</button><button class="primary web-runtime-proxy">应用代理模式并重启</button></div><p class="muted web-runtime-result" role="status"></p>';
    document.querySelector('.codex-panel').append(panel);
    const state = panel.querySelector('.web-runtime-status'), result = panel.querySelector('.web-runtime-result');
    const buttons = [...panel.querySelectorAll('button')];
    let current, busy = false;
    async function request(route, body) {
        const response = await fetch('/api/runtime' + route, { method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Switcher-Web': '1' },
            body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await response.json();
        if (response.status === 401) { location.replace('/'); throw Error('登录已过期'); }
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
        dialog.setAttribute('aria-label', '确认重启 Surface Codex');
        const text = document.createElement('p'); text.textContent =
            (proxy ? '将 Surface Codex 接入本地代理，并重启飞书连接。' : '重启 Surface 的飞书连接及其 Codex 子进程。') +
            '正在执行的飞书任务会中断，已有聊天记录保留。';
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

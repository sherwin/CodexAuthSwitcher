const path = require('node:path');

function windowIcon(platform = process.platform) {
    return path.join(__dirname, 'assets', platform === 'win32' ? 'icon.ico' : 'icon.png');
}
function installDesktopShell({ app, window, Menu, Tray, nativeImage, platform = process.platform, warn = console.warn }) {
    const show = () => { window.show(); window.focus(); };
    let tray;
    try {
        const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
        if (icon.isEmpty()) throw Error('Tray image is empty');
        if (platform === 'darwin') icon.setTemplateImage(true);
        tray = new Tray(icon);
        tray.setToolTip('Codex Auth Switcher — local proxy');
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: 'Show Auth Switcher', click: show }, { label: 'Quit Proxy and App', click: () => app.quit() },
        ]));
        tray.on('click', show);
    } catch { warn('System tray unavailable; the desktop window remains usable.'); }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'Auth Switcher', submenu: [{ label: 'Show Window', click: show },
            { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
        { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    return tray;
}
module.exports = { windowIcon, installDesktopShell };

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { installDesktopShell, windowIcon } = require('../electron/desktop-shell.cjs');

test('each desktop uses a real native icon and only macOS uses a template tray', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
        let template = false, imagePath, menu, shown = 0, focused = 0;
        const events = new Map();
        class Tray { setToolTip() {} setContextMenu() {} on(name, action) { events.set(name, action); } }
        installDesktopShell({ platform, app: { quit() {} },
            window: { show() { shown++; }, focus() { focused++; } }, Tray,
            nativeImage: { createFromPath(file) { imagePath = file; return { isEmpty: () => false, setTemplateImage(value) { template = value; } }; } },
            Menu: { buildFromTemplate: value => value, setApplicationMenu(value) { menu = value; } },
        });
        assert.ok(existsSync(windowIcon(platform))); assert.ok(existsSync(imagePath));
        assert.equal(readFileSync(imagePath).subarray(0,8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(template, platform === 'darwin');
        assert.equal(windowIcon(platform).endsWith('.ico'), platform === 'win32');
        events.get('click')(); assert.equal(shown,1); assert.equal(focused,1); assert.ok(menu.length);
    }
});
test('a missing system tray does not prevent the desktop menu or window from working', () => {
    let menu = false, warned = false;
    const tray = installDesktopShell({ app: {}, window: {}, platform: 'linux',
        nativeImage: { createFromPath() { return { isEmpty: () => true }; } },
        Menu: { buildFromTemplate: value => value, setApplicationMenu() { menu = true; } },
        warn() { warned = true; },
    });
    assert.equal(tray,undefined); assert.equal(menu,true); assert.equal(warned,true);
});

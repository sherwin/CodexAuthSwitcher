const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const appPath = path.resolve('dist', 'mac-arm64', 'Codex Auth Switcher.app');
if (process.platform === 'darwin' && !process.env.CI && fs.existsSync(appPath)) {
    try {
        execFileSync('osascript', ['-e', 'tell application "Codex Auth Switcher" to quit'], { stdio: 'ignore' });
    } catch {
        // The app may not be running; opening the newly built bundle can continue.
    }
    execFileSync('open', [appPath], { stdio: 'inherit' });
    console.log(`已打开新安装包：${appPath}`);
} else {
    console.log(`新安装包路径：${appPath}`);
}

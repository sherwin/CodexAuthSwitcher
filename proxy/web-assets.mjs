import { promises as fs } from 'node:fs';

const desktopRoot = new URL('../electron/', import.meta.url);
const assets = new Map([
    ['/style.css', [new URL('style.css', desktopRoot), 'text/css']],
    ['/renderer.js', [new URL('renderer.js', desktopRoot), 'text/javascript']],
    ['/web-bridge.js', [new URL('./web-bridge.js', import.meta.url), 'text/javascript']],
    ['/web.css', [new URL('./web.css', import.meta.url), 'text/css']],
]);
export async function desktopHTML() {
    return (await fs.readFile(new URL('index.html', desktopRoot), 'utf8'))
        .replace("connect-src 'none'", "connect-src 'self'")
        .replace('</head>', '  <link rel="stylesheet" href="web.css">\n</head>')
        .replace('<script src="renderer.js">', '<script src="web-bridge.js"></script>\n  <script src="renderer.js">');
}
export async function webAsset(url) {
    const asset = assets.get(url);
    return asset && { content: await fs.readFile(asset[0]), type: asset[1] + '; charset=utf-8' };
}

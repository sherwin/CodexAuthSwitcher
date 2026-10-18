const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// One source for native window/tray/installer icons; no external rendering tools.
const directory = path.join(__dirname, '../electron/assets');
function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return (value ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
    const type = Buffer.from(name), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
    return Buffer.concat([header, type, bytes, checksum]);
}
function distance(x, y, ax, ay, bx, by) {
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}
function png(size, template = false) {
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
        const x = (col + .5) / size - .5, y = (row + .5) / size - .5;
        const ring = Math.abs(Math.hypot(x, y) - .32) < .038;
        const arrow = Math.min(distance(x,y,-.16,0,.16,0), distance(x,y,0,-.16,.16,0), distance(x,y,.16,0,0,.16)) < .035;
        const inset = .15, radius = .47;
        const background = Math.hypot(Math.max(Math.abs(x) - (radius - inset), 0), Math.max(Math.abs(y) - (radius - inset), 0)) <= inset;
        const offset = row * (size * 4 + 1) + 1 + col * 4;
        const foreground = ring || arrow;
        const rgb = template ? [0,0,0] : foreground ? [233,237,245] : [41,122,193];
        raw[offset] = rgb[0]; raw[offset+1] = rgb[1]; raw[offset+2] = rgb[2];
        raw[offset+3] = template ? (foreground ? 255 : 0) : background ? 255 : 0;
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
fs.mkdirSync(directory, { recursive: true });
for (const [name,size,template] of [['icon.png',256,false],['tray.png',32,false],['trayTemplate.png',32,true]])
    fs.writeFileSync(path.join(directory,name),png(size,template));
const image = png(256), ico = Buffer.alloc(22);
ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4); ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12);
ico.writeUInt32LE(image.length,14); ico.writeUInt32LE(22,18);
fs.writeFileSync(path.join(directory,'icon.ico'),Buffer.concat([ico,image]));
const macChunks = [[128,'ic07'],[256,'ic08'],[512,'ic09'],[1024,'ic10']].map(([size,type]) => {
    const data = png(size), header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(data.length+8,4);
    return Buffer.concat([header,data]);
});
const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8+macChunks.reduce((sum,item)=>sum+item.length,0),4);
fs.writeFileSync(path.join(directory,'icon.icns'),Buffer.concat([header,...macChunks]));

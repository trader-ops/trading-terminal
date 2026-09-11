import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';

const chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9250',
  '--disable-gpu',
  '--no-sandbox',
  '--window-size=1400,1600'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((res) => {
  http.get('http://127.0.0.1:9250/json/list', r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  });
});

const page = versionData[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let reqId = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise(r => {
    const id = reqId++;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d.result);
    pending.delete(d.id);
  }
};

ws.onopen = async () => {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'https://trading-terminal-inky.vercel.app/?v=' + Date.now() });
};

await new Promise(r => setTimeout(r, 5000));

await send('Runtime.evaluate', { expression: 'window.scrollTo(0, 250);' });
await new Promise(r => setTimeout(r, 1000));

const screenshot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/Users/hussainahmed/.gemini/antigravity/brain/8a0862d5-1c35-4487-8325-5dc65a77e6dd/screenshot_pullback_cockpit.png', Buffer.from(screenshot.data, 'base64'));

console.log("Cockpit screenshot saved!");
chromeProcess.kill();
process.exit(0);

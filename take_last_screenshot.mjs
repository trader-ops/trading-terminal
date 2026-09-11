import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';

const chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9229',
  '--disable-gpu',
  '--no-sandbox',
  '--window-size=1400,2000'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((resolve, reject) => {
  http.get('http://127.0.0.1:9229/json/list', (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});

const page = versionData.find(p => p.type === 'page');
const wsUrl = page.webSocketDebuggerUrl;
const ws = new WebSocket(wsUrl);
let id = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve) => {
    const msgId = id++;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.onopen = async () => {
  await send('Page.enable');
  await send('Page.navigate', { url: 'https://trading-terminal-inky.vercel.app/' });
};

await new Promise(r => setTimeout(r, 5000));

await send('Runtime.evaluate', { expression: 'window.scrollTo(0, 6000);' });
await new Promise(r => setTimeout(r, 1000));
const scr1 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/Users/hussainahmed/.gemini/antigravity/brain/8a0862d5-1c35-4487-8325-5dc65a77e6dd/screenshot_journal.png', Buffer.from(scr1.data, 'base64'));

console.log("Journal screenshot saved!");
chromeProcess.kill();
process.exit(0);

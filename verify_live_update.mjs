import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';

const chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9230',
  '--disable-gpu',
  '--no-sandbox',
  '--window-size=1400,2400'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((resolve, reject) => {
  http.get('http://127.0.0.1:9230/json/list', (res) => {
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

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data.result);
    pending.delete(data.id);
  }
};

ws.onopen = async () => {
  await send('Page.enable');
  // Add cache buster query param to ensure fresh fetch
  await send('Page.navigate', { url: 'https://trading-terminal-inky.vercel.app/?v=' + Date.now() });
};

await new Promise(r => setTimeout(r, 8000));

// Capture top/cockpit screenshot showing expanded analysis
const scr1 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/Users/hussainahmed/.gemini/antigravity/brain/8a0862d5-1c35-4487-8325-5dc65a77e6dd/screenshot_verified_top.png', Buffer.from(scr1.data, 'base64'));

// Scroll down to Module 02 & 03
await send('Runtime.evaluate', { expression: 'window.scrollTo(0, 1600);' });
await new Promise(r => setTimeout(r, 2000));
const scr2 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('/Users/hussainahmed/.gemini/antigravity/brain/8a0862d5-1c35-4487-8325-5dc65a77e6dd/screenshot_verified_charts.png', Buffer.from(scr2.data, 'base64'));

const evalData = await send('Runtime.evaluate', {
  expression: `(() => {
    return {
      trcTitle: document.getElementById("trcTradeTitleBadge")?.innerText,
      smcText: document.getElementById("trcSmcText")?.innerText,
      macroText: document.getElementById("trcMacroText")?.innerText,
      liqText: document.getElementById("trcLiqText")?.innerText,
      newsText: document.getElementById("trcNewsText")?.innerText,
      summaryContent: document.getElementById("trcSummaryContent")?.innerText,
      pillarDxy: document.getElementById("pillarDxyState")?.innerText,
      pillarYields: document.getElementById("pillarYieldsState")?.innerText,
      pillarSmc: document.getElementById("pillarSmcState")?.innerText,
      omniFinalTitle: document.getElementById("omniFinalVerdictTitle")?.innerText,
      omni1hBos: document.getElementById("omni1hBos")?.innerText,
      omni1mChoch: document.getElementById("omni1mChoch")?.innerText
    };
  })()`,
  returnByValue: true
});

console.log("EVAL DATA:", JSON.stringify(evalData.result.value, null, 2));

chromeProcess.kill();
process.exit(0);

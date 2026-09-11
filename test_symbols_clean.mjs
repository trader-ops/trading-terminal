import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9260', '--disable-gpu', '--no-sandbox', '--window-size=1000,600'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((res) => {
  http.get('http://127.0.0.1:9260/json/list', r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  });
});

const page = versionData[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise(r => {
    const msgId = id++;
    pending.set(msgId, r);
    ws.send(JSON.stringify({ id: msgId, method, params }));
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
  
  // Test TVC:US10Y
  const url1 = 'https://s.tradingview.com/widgetembed/?symbol=TVC%3AUS10Y&interval=15&theme=dark&style=1&timezone=Etc%2FUTC&hide_top_toolbar=1&hide_legend=0&save_image=0&locale=en';
  await send('Page.navigate', { url: url1 });
  await new Promise(r => setTimeout(r, 4000));
  const scr1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/Users/hussainahmed/.gemini/antigravity/brain/8a0862d5-1c35-4487-8325-5dc65a77e6dd/screenshot_tvc_us10y.png', Buffer.from(scr1.data, 'base64'));

  // Test US10Y
  const url2 = 'https://s.tradingview.com/widgetembed/?symbol=US10Y&interval=15&theme=dark&style=1&timezone=Etc%2FUTC&hide_top_toolbar=1&hide_legend=0&save_image=0&locale=en';
  await send('Page.navigate', { url: url2 });
  await new Promise(r => setTimeout(r, 4000));
  const scr2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/Users/hussainahmed/.gemini/antigravity/brain/8a0862d5-1c35-4487-8325-5dc65a77e6dd/screenshot_us10y_direct.png', Buffer.from(scr2.data, 'base64'));

  console.log("SUCCESS: Both screenshots written!");
  chrome.kill();
  process.exit(0);
};

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9258', '--disable-gpu', '--no-sandbox', '--window-size=800,500'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((res) => {
  http.get('http://127.0.0.1:9258/json/list', r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  });
});

const page = versionData[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise(r => {
    const id = msgId++;
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
  
  // Test TVC:US10Y
  await send('Page.navigate', { url: 'https://s.tradingview.com/widgetembed/?symbol=TVC%3AUS10Y&interval=15&theme=dark&style=3&timezone=Etc%2FUTC&hide_top_toolbar=1&hide_legend=0&save_image=0&locale=en' });
  await new Promise(r => setTimeout(r, 4000));
  const scr1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/Users/hussainahmed/.gemini/antigravity/brain/8a0862d5-1c35-4487-8325-5dc65a77e6dd/test_tvc_us10y.png', Buffer.from(scr1.data, 'base64'));

  // Test US10Y
  await send('Page.navigate', { url: 'https://s.tradingview.com/widgetembed/?symbol=US10Y&interval=15&theme=dark&style=3&timezone=Etc%2FUTC&hide_top_toolbar=1&hide_legend=0&save_image=0&locale=en' });
  await new Promise(r => setTimeout(r, 4000));
  const scr2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/Users/hussainahmed/.gemini/antigravity/brain/8a0862d5-1c35-4487-8325-5dc65a77e6dd/test_us10y_direct.png', Buffer.from(scr2.data, 'base64'));

  console.log("Both screenshots saved!");
  chrome.kill();
  process.exit(0);
};

import { spawn } from 'child_process';
import http from 'http';

const chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9247',
  '--disable-gpu',
  '--no-sandbox',
  '--window-size=1400,2000'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((res) => {
  http.get('http://127.0.0.1:9247/json/list', r => {
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
  await send('Page.navigate', { url: 'file:///Users/hussainahmed/.gemini/antigravity/scratch/trading-terminal/index.html' });
};

await new Promise(r => setTimeout(r, 3000));

// Simulate TP1 hit
const simTpResults = await send('Runtime.evaluate', {
  expression: `(() => {
    const curTrade = DAY_TRADE_PIPELINE[CURRENT_PIPELINE_INDEX];
    curTrade.isFilled = true;
    curTrade.isTp1Done = true;
    syncMasterUnifiedCockpit(ASSETS["XAUUSD"], curTrade.isBear);

    return {
      alertStripTitle: document.getElementById('ceasTitle')?.innerText,
      alertStripSubtitle: document.getElementById('ceasSubtitle')?.innerText,
      macActionTitle: document.getElementById('macActionTitle')?.innerText,
      macActionSub: document.getElementById('macActionSub')?.innerText,
      macStateBadge: document.getElementById('macStateBadge')?.innerText
    };
  })()`,
  returnByValue: true
});

console.log("SIMULATED TP1 HIT VERIFICATION:\n", JSON.stringify(simTpResults?.result?.value, null, 2));

chromeProcess.kill();
process.exit(0);

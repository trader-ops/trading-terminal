import { spawn } from 'child_process';
import http from 'http';

const chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9245',
  '--disable-gpu',
  '--no-sandbox',
  '--window-size=1400,2000'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((res) => {
  http.get('http://127.0.0.1:9245/json/list', r => {
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
  // Load local file directly to test the changes before pushing
  await send('Page.navigate', { url: 'file:///Users/hussainahmed/.gemini/antigravity/scratch/trading-terminal/index.html' });
};

await new Promise(r => setTimeout(r, 4000));

const results = await send('Runtime.evaluate', {
  expression: `(() => {
    return {
      alertStripTitle: document.getElementById('ceasTitle')?.innerText,
      alertStripSubtitle: document.getElementById('ceasSubtitle')?.innerText,
      pullbackPhase: document.getElementById('pbrPhaseBadge')?.innerText,
      pullbackDepth: document.getElementById('pbrDepthBadge')?.innerText,
      swingOrigin: document.getElementById('pbrSwingOrigin')?.innerText,
      retracePips: document.getElementById('pbrRetracePips')?.innerText,
      retestPoi: document.getElementById('pbrRetestPoi')?.innerText,
      distanceToPoi: document.getElementById('pbrDistanceToPoi')?.innerText,
      fibZone: document.getElementById('pbrFibZone')?.innerText,
      directive: document.getElementById('pbrDirectiveBox')?.innerText,
      meterWidth: document.getElementById('pbrMeterFill')?.style?.width,
      voiceBtn: document.getElementById('btnVoiceToggle')?.innerText
    };
  })()`,
  returnByValue: true
});

console.log("PULLBACK & EVENT ALERT ENGINE VERIFICATION RESULT:\n", JSON.stringify(results?.result?.value, null, 2));

chromeProcess.kill();
process.exit(0);

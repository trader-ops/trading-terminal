import { spawn } from 'child_process';
import http from 'http';

const chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9222',
  '--disable-gpu',
  '--no-sandbox',
  '--window-size=1600,1200'
]);

await new Promise(resolve => setTimeout(resolve, 2000));

const versionData = await new Promise((resolve, reject) => {
  http.get('http://127.0.0.1:9222/json/list', (res) => {
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

const consoleLogs = [];
const runtimeExceptions = [];

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data.result);
    pending.delete(data.id);
  }

  if (data.method === 'Runtime.consoleAPICalled') {
    const text = data.params.args.map(a => a.value !== undefined ? a.value : (a.description || JSON.stringify(a))).join(' ');
    consoleLogs.push(`[${data.params.type.toUpperCase()}] ${text}`);
    console.log(`[CONSOLE ${data.params.type.toUpperCase()}] ${text}`);
  }

  if (data.method === 'Runtime.exceptionThrown') {
    const exc = data.params.exceptionDetails;
    const msg = exc.exception ? (exc.exception.description || exc.exception.value) : exc.text;
    runtimeExceptions.push(`[EXCEPTION] ${msg} at line ${exc.lineNumber}:${exc.columnNumber}`);
    console.log(`\x1b[31m[RUNTIME EXCEPTION]\x1b[0m ${msg} at ${exc.url}:${exc.lineNumber}`);
  }
};

ws.onopen = async () => {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');

  console.log('Navigating to live URL...');
  await send('Page.navigate', { url: 'https://trading-terminal-inky.vercel.app/' });
};

// Wait 8 seconds after navigate
await new Promise(r => setTimeout(r, 8000));

const evalRes = await send('Runtime.evaluate', {
  expression: `(() => {
    return {
      title: document.title,
      spotGoldPrice: document.getElementById('cockpitGoldSpotPrice')?.innerText,
      goldSub: document.getElementById('cockpitGoldSub')?.innerText,
      activeTradeAction: document.getElementById('mucActionTitle')?.innerText,
      activeTradeEntry: document.getElementById('mucEntryPrice')?.innerText,
      activeTradeSeq: document.getElementById('trcTradeTitleBadge')?.innerText,
      omniVerdict: document.getElementById('omniQnaAnswer')?.innerText,
      smcText: document.getElementById('trcSmcText')?.innerText,
      macroText: document.getElementById('trcMacroText')?.innerText,
      liqText: document.getElementById('trcLiqText')?.innerText,
      newsText: document.getElementById('trcNewsText')?.innerText,
      dxyVal: document.getElementById('pillarDxyState')?.innerText,
      yieldsVal: document.getElementById('pillarYieldsState')?.innerText,
      journalRows: document.querySelectorAll('#unifiedJournalGrid .uj-row').length,
      clockText: document.getElementById('headerClock')?.innerText
    };
  })()`,
  returnByValue: true
});

console.log("\n--- REAL LIVE DOM STATE ---");
console.log(JSON.stringify(evalRes?.result?.value, null, 2));

console.log("\n--- RUNTIME EXCEPTIONS (" + runtimeExceptions.length + ") ---");
runtimeExceptions.forEach(e => console.log(e));

chromeProcess.kill();
process.exit(0);

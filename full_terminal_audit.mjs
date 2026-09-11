import { spawn } from 'child_process';
import http from 'http';

const chromeProcess = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9234',
  '--disable-gpu',
  '--no-sandbox',
  '--window-size=1400,2400'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((res) => {
  http.get('http://127.0.0.1:9234/json/list', r => {
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
  await send('Page.navigate', { url: 'https://trading-terminal-inky.vercel.app/?audit=' + Date.now() });
};

await new Promise(r => setTimeout(r, 7000));

const auditResults = await send('Runtime.evaluate', {
  expression: `(() => {
    const issues = [];
    
    // 1. Check for old hardcoded $4,400+ numbers in visible elements
    const oldPrices = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length === 0 && el.innerText) {
        const txt = el.innerText.trim();
        if (/\\$4[,.]?4[0-9]{2}/.test(txt)) {
          const inJournal = el.closest('#unifiedTradesGrid');
          if (!inJournal) {
            oldPrices.push({ id: el.id, class: el.className, tag: el.tagName, text: txt.slice(0, 80) });
          }
        }
      }
    });

    // 2. Check Tab 2 (Quick Sideways Scalps) values
    const tab2Audit = {
      rboxHigh: document.getElementById('rboxHighVal')?.innerText,
      rboxLow: document.getElementById('rboxLowVal')?.innerText,
      rboxEq: document.getElementById('rboxEqVal')?.innerText,
      rboxLive: document.getElementById('rboxLivePrice')?.innerText,
      shTicketEntry: document.getElementById('shTicketEntry')?.innerText,
      slTicketEntry: document.getElementById('slTicketEntry')?.innerText,
      rboxStatus: document.getElementById('rboxLiveStatus')?.innerText,
      rboxInsight: document.getElementById('rboxInsightText')?.innerText
    };

    // 3. Check Progress bars & Gauges
    const dtgProgressBar = document.getElementById('dtgProgressBar')?.style?.width;
    const cprMeterFill = document.getElementById('cprMeterFill')?.style?.width;
    const cpiProgressBar = document.getElementById('cpiProgressBar')?.style?.width;

    // 4. Check Module 02 DXY and Yields values
    const mod02 = {
      dxyState: document.getElementById('dxyStatusBadge')?.innerText,
      dxyLive: document.getElementById('dxyLiveStateText')?.innerText,
      us10yState: document.getElementById('us10yStatusBadge')?.innerText,
      us10yLive: document.getElementById('us10yLiveStateText')?.innerText,
    };

    // 5. Check Module 06 Predictor
    const mod06 = {
      predPinpointZone: document.getElementById('predPinpointZone')?.innerText,
      predStopLoss: document.getElementById('predStopLoss')?.innerText,
    };

    // 7. Check Module 07 News wire count
    const newsItems = document.querySelectorAll('.fj-wire-card').length;

    // 7. Check Module 09 Calculator
    const calcResult = document.getElementById('calcLotResult')?.innerText;

    // 8. Check Module 10 Journal stats
    const mod10 = {
      winRate: document.getElementById('statAccuracyRate')?.innerText,
      profit: document.getElementById('statRealizedProfit')?.innerText,
      tradesTotal: document.getElementById('statTotalTradesCalled')?.innerText,
      cardsCount: document.querySelectorAll('#unifiedTradesGrid > *').length
    };

    return {
      oldHardcodedPricesCount: oldPrices.length,
      oldPricesSample: oldPrices,
      tab2Audit,
      progressBars: { dtgProgressBar, cprMeterFill, cpiProgressBar },
      mod02,
      mod06,
      newsItems,
      calcResult,
      mod10
    };
  })()`,
  returnByValue: true
});

console.log("FULL AUDIT REPORT:\n", JSON.stringify(auditResults?.result?.value, null, 2));

chromeProcess.kill();
process.exit(0);

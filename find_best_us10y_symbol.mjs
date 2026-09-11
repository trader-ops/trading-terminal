import { spawn } from 'child_process';
import http from 'http';

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9255', '--disable-gpu', '--no-sandbox'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((res) => {
  http.get('http://127.0.0.1:9255/json/list', r => {
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
  
  const testSymbols = [
    'TVC%3AUS10Y',
    'CBOE%3ATNX',
    'FRED%3ADGS10',
    'US10Y',
    'CURRENCYCOM%3AUS10Y',
    'CBOT%3AZN1!'
  ];

  for (const sym of testSymbols) {
    const url = `https://s.tradingview.com/widgetembed/?symbol=${sym}&interval=15&theme=dark&style=3&timezone=Etc%2FUTC&hide_top_toolbar=1&hide_legend=0&save_image=0&locale=en`;
    await send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 3500));
    const evalRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const text = document.body.innerText || '';
        return {
          symbol: '${sym}',
          doesNotExist: text.includes("This symbol doesn't exist"),
          isRestricted: text.includes('only available on TradingView') || text.includes('Notification'),
          snippet: text.slice(0, 100)
        };
      })()`,
      returnByValue: true
    });
    console.log("RESULT:", evalRes.result.value);
  }
  chrome.kill();
  process.exit(0);
};

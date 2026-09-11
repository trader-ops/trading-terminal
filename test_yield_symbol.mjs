import { spawn } from 'child_process';
import http from 'http';

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=9231', '--disable-gpu', '--no-sandbox'
]);

await new Promise(r => setTimeout(r, 2000));

const versionData = await new Promise((res) => {
  http.get('http://127.0.0.1:9231/json/list', r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b)));
  });
});

const page = versionData[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);

function send(method, params = {}) {
  return new Promise(r => {
    const id = Math.random();
    const handler = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === id) {
        ws.removeEventListener('message', handler);
        r(d.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onopen = async () => {
  await send('Page.enable');
  
  for (const sym of ['CAPITALCOM%3AUS10Y', 'CURRENCYCOM%3AUS10Y', 'TVC%3AUS10Y', 'CBOE%3ATNX']) {
    const url = `https://s.tradingview.com/widgetembed/?symbol=${sym}&interval=15&theme=dark&style=3&timezone=Etc%2FUTC&hide_top_toolbar=1&hide_legend=0&save_image=0&locale=en`;
    await send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 2500));
    const evalRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const text = document.body.innerText;
        return {
          symbol: '${sym}',
          hasRestrictedPopup: text.includes('only available on TradingView') || text.includes('Notification'),
          bodyLength: text.length
        };
      })()`,
      returnByValue: true
    });
    console.log("SYMBOL TEST:", evalRes.result.value);
  }
  chrome.kill();
  process.exit(0);
};

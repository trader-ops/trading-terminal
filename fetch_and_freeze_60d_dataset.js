const fs = require('fs');
const path = require('path');
const https = require('https');

function fetchCandles(symbol, interval, range) {
    return new Promise((resolve, reject) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
        https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.chart || !json.chart.result || !json.chart.result[0]) {
                        return reject(new Error(`Failed for ${symbol}: ${data.slice(0, 150)}`));
                    }
                    const result = json.chart.result[0];
                    const timestamps = result.timestamp || [];
                    const quotes = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
                    const candles = [];
                    for (let i = 0; i < timestamps.length; i++) {
                        if (quotes.open && quotes.open[i] && quotes.high && quotes.high[i] && quotes.low && quotes.low[i] && quotes.close && quotes.close[i]) {
                            candles.push({
                                time: timestamps[i] * 1000,
                                iso: new Date(timestamps[i] * 1000).toISOString(),
                                open: quotes.open[i],
                                high: quotes.high[i],
                                low: quotes.low[i],
                                close: quotes.close[i],
                                volume: quotes.volume ? quotes.volume[i] || 0 : 0
                            });
                        }
                    }
                    resolve(candles);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function freeze60dDataset() {
    console.log('Downloading maximum available 60-day 5M dataset from Yahoo Finance...');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    try {
        console.log('1. Fetching Gold (GC=F) 5-minute candles (range=60d)...');
        const gold5m = await fetchCandles('GC=F', '5m', '60d');
        console.log(`✓ Fetched ${gold5m.length} Gold 5M candles. First: ${gold5m[0].iso}, Last: ${gold5m[gold5m.length - 1].iso}`);

        console.log('2. Fetching US Dollar Index (DX-Y.NYB) 15-minute candles (range=60d)...');
        const dxy15m = await fetchCandles('DX-Y.NYB', '15m', '60d');
        console.log(`✓ Fetched ${dxy15m.length} DXY 15M candles. First: ${dxy15m[0].iso}, Last: ${dxy15m[dxy15m.length - 1].iso}`);

        const payload = {
            metadata: {
                frozenAt: new Date().toISOString(),
                source: "Yahoo Finance Chart API (GC=F, DX-Y.NYB) range=60d",
                timeframeGold: "5m",
                timeframeDxy: "15m",
                totalGoldBars: gold5m.length,
                totalDxyBars: dxy15m.length,
                goldDateRange: {
                    from: gold5m[0].iso,
                    to: gold5m[gold5m.length - 1].iso
                },
                dxyDateRange: {
                    from: dxy15m[0].iso,
                    to: dxy15m[dxy15m.length - 1].iso
                }
            },
            gold5m,
            dxy15m
        };

        const targetFile = path.join(dataDir, 'historical_candles_xauusd_dxy_60d.json');
        fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf8');
        const stats = fs.statSync(targetFile);
        console.log(`\n✅ 60-DAY DATASET FROZEN AND SAVED!`);
        console.log(`File: ${targetFile}`);
        console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
        console.error('Error freezing 60d dataset:', err);
        process.exit(1);
    }
}

freeze60dDataset();

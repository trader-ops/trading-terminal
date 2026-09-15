const https = require('https');

function fetchCandles(symbol, interval, range) {
    return new Promise((resolve, reject) => {
        https.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const result = json.chart.result[0];
                    const timestamps = result.timestamp;
                    const quotes = result.indicators.quote[0];
                    const candles = [];
                    for (let i = 0; i < timestamps.length; i++) {
                        if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
                            candles.push({
                                time: timestamps[i] * 1000,
                                date: new Date(timestamps[i] * 1000),
                                open: quotes.open[i],
                                high: quotes.high[i],
                                low: quotes.low[i],
                                close: quotes.close[i],
                                volume: quotes.volume[i] || 0
                            });
                        }
                    }
                    resolve(candles);
                } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function testRefinedScalps() {
    const goldM5 = await fetchCandles('GC=F', '5m', '1mo');
    let refinedScalpTrades = [];

    // Range Box Sweep & Reversal Scalper
    for (let i = 24; i < goldM5.length - 24; i += 12) {
        let boxHigh = -Infinity;
        let boxLow = Infinity;
        for (let b = i - 24; b < i; b++) {
            if (goldM5[b].high > boxHigh) boxHigh = goldM5[b].high;
            if (goldM5[b].low < boxLow) boxLow = goldM5[b].low;
        }

        const boxWidth = boxHigh - boxLow;
        if (boxWidth < 6 || boxWidth > 16) continue;
        const eq = (boxHigh + boxLow) / 2;
        const subBars = goldM5.slice(i, Math.min(i + 18, goldM5.length));

        for (let j = 0; j < subBars.length - 5; j++) {
            const c = subBars[j];

            // 1. CEILING SWEEP SELL: Price sweeps ABOVE boxHigh, but CLOSES BACK BELOW boxHigh! (Turtle Soup Sweep)
            if (c.high > boxHigh && c.close < boxHigh) {
                const entry = c.close;
                const sl = c.high + 0.8; // Sniper stop above sweep wick
                const risk = sl - entry;
                if (risk >= 1.0 && risk <= 3.5) {
                    const tp = eq; // Midpoint equilibrium
                    const outcome = subBars.slice(j + 1);

                    for (let sc of outcome) {
                        if (sc.high >= sl) { refinedScalpTrades.push({ type: 'SELL', result: 'LOSS', r: -1.0, pips: -Math.round(risk*10) }); break; }
                        if (sc.low <= tp) {
                            const rWin = ((entry - tp) / risk).toFixed(1);
                            refinedScalpTrades.push({ type: 'SELL', result: 'WIN', r: parseFloat(rWin), pips: 25 });
                            break;
                        }
                    }
                    break;
                }
            }

            // 2. FLOOR SWEEP BUY: Price sweeps BELOW boxLow, but CLOSES BACK ABOVE boxLow!
            if (c.low < boxLow && c.close > boxLow) {
                const entry = c.close;
                const sl = c.low - 0.8;
                const risk = entry - sl;
                if (risk >= 1.0 && risk <= 3.5) {
                    const tp = eq;
                    const outcome = subBars.slice(j + 1);

                    for (let sc of outcome) {
                        if (sc.low <= sl) { refinedScalpTrades.push({ type: 'BUY', result: 'LOSS', r: -1.0, pips: -Math.round(risk*10) }); break; }
                        if (sc.high >= tp) {
                            const rWin = ((tp - entry) / risk).toFixed(1);
                            refinedScalpTrades.push({ type: 'BUY', result: 'WIN', r: parseFloat(rWin), pips: 25 });
                            break;
                        }
                    }
                    break;
                }
            }
        }
    }

    const wins = refinedScalpTrades.filter(t => t.r > 0).length;
    const losses = refinedScalpTrades.filter(t => t.r <= 0).length;
    const winRate = ((wins / refinedScalpTrades.length) * 100).toFixed(1);
    const totalR = refinedScalpTrades.reduce((acc, t) => acc + t.r, 0).toFixed(1);
    const grossWinsR = refinedScalpTrades.filter(t => t.r > 0).reduce((acc, t) => acc + t.r, 0);
    const grossLossesR = Math.abs(refinedScalpTrades.filter(t => t.r <= 0).reduce((acc, t) => acc + t.r, 0));
    const profitFactor = grossLossesR > 0 ? (grossWinsR / grossLossesR).toFixed(2) : 'INF';

    console.log('\n====================================================================================================');
    console.log('REFINED RANGE SCALPS AUDIT (LIQUIDITY SWEEP OF RANGE CEILING / FLOOR):');
    console.log('====================================================================================================');
    console.table([{
        strategy: 'Refined Range Box Sweep Scalps (Turtle Soup on Extremes)',
        totalTrades: refinedScalpTrades.length,
        wins,
        losses,
        winRate: winRate + '%',
        totalR: '+' + totalR + 'R',
        profitFactor
    }]);
}

testRefinedScalps();

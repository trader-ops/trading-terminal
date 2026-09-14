const https = require('https');

function fetchCandles(interval, range) {
    return new Promise((resolve, reject) => {
        https.get(`https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=${range}&interval=${interval}`, {
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

function calculateEMA(candles, period) {
    const ema = [];
    const k = 2 / (period + 1);
    let prev = candles[0].close;
    ema.push(prev);
    for (let i = 1; i < candles.length; i++) {
        const val = candles[i].close * k + prev * (1 - k);
        ema.push(val);
        prev = val;
    }
    return ema;
}

// ----------------------------------------------------
// QUANTITATIVE SCALING MODEL:
// 1. Pro-Trend 50 EMA FVG with Rejection Close
// 2. TP1 at 1.3R (50% position closed for guaranteed profit)
// 3. SL moved to Breakeven
// 4. TP2 at 2.8R (remaining 50% runner)
// ----------------------------------------------------
function testScalingTrendFVG(candles, ema50) {
    let trades = [];
    for (let i = 50; i < candles.length - 25; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1];
        const c3 = candles[i];
        const isBullTrend = c3.close > ema50[i];
        const isBearTrend = c3.close < ema50[i];

        if (isBullTrend && c3.low > c1.high + 0.5) {
            const fvgHigh = c3.low;
            const fvgLow = c1.high;

            for (let j = i + 1; j < Math.min(i + 20, candles.length); j++) {
                if (candles[j].low <= fvgHigh && candles[j].close > fvgLow) {
                    const entryPrice = candles[j].close;
                    const initialSl = Math.min(candles[j].low, c2.low) - 0.5;
                    const risk = entryPrice - initialSl;
                    if (risk < 1.0 || risk > 12) break;

                    const tp1Price = entryPrice + (risk * 1.3);
                    const tp2Price = entryPrice + (risk * 2.8);

                    let slPrice = initialSl;
                    let tp1Hit = false;
                    let pnlR = 0;

                    for (let k = j + 1; k < Math.min(j + 40, candles.length); k++) {
                        // Check TP1
                        if (!tp1Hit && candles[k].high >= tp1Price) {
                            tp1Hit = true;
                            pnlR += (1.3 * 0.5); // 50% locked
                            slPrice = entryPrice + 0.1; // Move to BE
                        }

                        // Check Stop
                        if (candles[k].low <= slPrice) {
                            if (tp1Hit) {
                                // TP1 was secured, rest stopped at BE
                                trades.push({ type: 'BUY', result: 'WIN_PARTIAL', r: pnlR, tp1Hit: true });
                            } else {
                                trades.push({ type: 'BUY', result: 'LOSS', r: -1.0, tp1Hit: false });
                            }
                            break;
                        }

                        // Check TP2
                        if (candles[k].high >= tp2Price) {
                            pnlR += (2.8 * 0.5);
                            trades.push({ type: 'BUY', result: 'WIN_FULL', r: pnlR, tp1Hit: true });
                            break;
                        }
                    }
                    break;
                }
            }
        }

        if (isBearTrend && c1.low > c3.high + 0.5) {
            const fvgHigh = c1.low;
            const fvgLow = c3.high;

            for (let j = i + 1; j < Math.min(i + 20, candles.length); j++) {
                if (candles[j].high >= fvgLow && candles[j].close < fvgHigh) {
                    const entryPrice = candles[j].close;
                    const initialSl = Math.max(candles[j].high, c2.high) + 0.5;
                    const risk = initialSl - entryPrice;
                    if (risk < 1.0 || risk > 12) break;

                    const tp1Price = entryPrice - (risk * 1.3);
                    const tp2Price = entryPrice - (risk * 2.8);

                    let slPrice = initialSl;
                    let tp1Hit = false;
                    let pnlR = 0;

                    for (let k = j + 1; k < Math.min(j + 40, candles.length); k++) {
                        if (!tp1Hit && candles[k].low <= tp1Price) {
                            tp1Hit = true;
                            pnlR += (1.3 * 0.5);
                            slPrice = entryPrice - 0.1;
                        }

                        if (candles[k].high >= slPrice) {
                            if (tp1Hit) {
                                trades.push({ type: 'SELL', result: 'WIN_PARTIAL', r: pnlR, tp1Hit: true });
                            } else {
                                trades.push({ type: 'SELL', result: 'LOSS', r: -1.0, tp1Hit: false });
                            }
                            break;
                        }

                        if (candles[k].low <= tp2Price) {
                            pnlR += (2.8 * 0.5);
                            trades.push({ type: 'SELL', result: 'WIN_FULL', r: pnlR, tp1Hit: true });
                            break;
                        }
                    }
                    break;
                }
            }
        }
    }

    const wins = trades.filter(t => t.r > 0).length;
    const losses = trades.filter(t => t.r <= 0).length;
    const totalR = trades.reduce((a, b) => a + b.r, 0).toFixed(1);
    const winRate = ((wins / trades.length) * 100).toFixed(1);
    const grossWinsR = trades.filter(t => t.r > 0).reduce((a, b) => a + b.r, 0);
    const grossLossesR = Math.abs(trades.filter(t => t.r <= 0).reduce((a, b) => a + b.r, 0));
    const profitFactor = (grossWinsR / grossLossesR).toFixed(2);

    return {
        name: 'Trend FVG with TP1 Partial Locking (Institutional Scaling)',
        totalTrades: trades.length,
        wins,
        losses,
        winRate: winRate + '%',
        totalR: '+' + totalR + 'R',
        profitFactor
    };
}

async function main() {
    const candles = await fetchCandles('15m', '1mo');
    const ema50 = calculateEMA(candles, 50);
    const res = testScalingTrendFVG(candles, ema50);
    console.log('\n============================================================');
    console.log('INSTITUTIONAL SCALING (TP1 50% + BE) RESULTS:');
    console.log('============================================================');
    console.table([res]);
}

main();

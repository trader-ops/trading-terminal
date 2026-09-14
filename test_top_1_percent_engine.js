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

// ------------------------------------------------------------------
// THE TRUE TOP 1% INSTITUTIONAL PROTOCOL:
// 1. Session Timing: London Fix / NY Overlap (High liquidity)
// 2. Higher Timeframe 50 EMA Alignment
// 3. FVG / Liquidity Tap with Rejection
// 4. AUTOMATIC BREAK-EVEN PROTECTION AT 1:1 R (+35 Pips)
// 5. Runner to 1:3 R:R
// ------------------------------------------------------------------
function testTopOnePercentEngine(candles, ema50) {
    let trades = [];

    for (let i = 50; i < candles.length - 25; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1];
        const c3 = candles[i];
        const hour = c3.date.getUTCHours();

        // 1. Prime Session Filter (12:00 to 18:00 UTC - London Fix / NY Overlap)
        if (hour < 12 || hour > 18) continue;

        // 2. HTF Trend Bias
        const isBull = c3.close > ema50[i] && ema50[i] >= ema50[i - 3];
        const isBear = c3.close < ema50[i] && ema50[i] <= ema50[i - 3];

        // 3. Setup Trigger (Displacement FVG)
        if (isBull && c3.low > c1.high + 0.8) {
            const fvgLow = c1.high;
            const fvgHigh = c3.low;

            for (let j = i + 1; j < Math.min(i + 12, candles.length); j++) {
                if (candles[j].low <= fvgHigh && candles[j].close > fvgLow && candles[j].close > candles[j].open) {
                    const entryPrice = candles[j].close;
                    const initialSl = Math.min(candles[j].low, c2.low) - 0.8;
                    const risk = entryPrice - initialSl;
                    if (risk < 1.5 || risk > 8) break;

                    const tpPrice = entryPrice + (risk * 2.8); // 1:2.8 RR
                    const beTriggerPrice = entryPrice + (risk * 1.0); // Break-even trigger at 1:1

                    let slPrice = initialSl;
                    let isBeLocked = false;
                    let outcome = null;

                    for (let k = j + 1; k < Math.min(j + 40, candles.length); k++) {
                        // Check if 1:1 reached -> Move SL to BE!
                        if (!isBeLocked && candles[k].high >= beTriggerPrice) {
                            slPrice = entryPrice + 0.2; // Breakeven + spread cover
                            isBeLocked = true;
                        }

                        // Check Stop
                        if (candles[k].low <= slPrice) {
                            if (isBeLocked) {
                                outcome = 'BE';
                                trades.push({ type: 'BUY', result: 'BE', r: 0.1 });
                            } else {
                                outcome = 'LOSS';
                                trades.push({ type: 'BUY', result: 'LOSS', r: -1.0 });
                            }
                            break;
                        }

                        // Check Target
                        if (candles[k].high >= tpPrice) {
                            outcome = 'WIN';
                            trades.push({ type: 'BUY', result: 'WIN', r: 2.8 });
                            break;
                        }
                    }
                    break;
                }
            }
        }

        if (isBear && c1.low > c3.high + 0.8) {
            const fvgHigh = c1.low;
            const fvgLow = c3.high;

            for (let j = i + 1; j < Math.min(i + 12, candles.length); j++) {
                if (candles[j].high >= fvgLow && candles[j].close < fvgHigh && candles[j].close < candles[j].open) {
                    const entryPrice = candles[j].close;
                    const initialSl = Math.max(candles[j].high, c2.high) + 0.8;
                    const risk = initialSl - entryPrice;
                    if (risk < 1.5 || risk > 8) break;

                    const tpPrice = entryPrice - (risk * 2.8);
                    const beTriggerPrice = entryPrice - (risk * 1.0);

                    let slPrice = initialSl;
                    let isBeLocked = false;
                    let outcome = null;

                    for (let k = j + 1; k < Math.min(j + 40, candles.length); k++) {
                        if (!isBeLocked && candles[k].low <= beTriggerPrice) {
                            slPrice = entryPrice - 0.2;
                            isBeLocked = true;
                        }

                        if (candles[k].high >= slPrice) {
                            if (isBeLocked) {
                                outcome = 'BE';
                                trades.push({ type: 'SELL', result: 'BE', r: 0.1 });
                            } else {
                                outcome = 'LOSS';
                                trades.push({ type: 'SELL', result: 'LOSS', r: -1.0 });
                            }
                            break;
                        }

                        if (candles[k].low <= tpPrice) {
                            outcome = 'WIN';
                            trades.push({ type: 'SELL', result: 'WIN', r: 2.8 });
                            break;
                        }
                    }
                    break;
                }
            }
        }
    }

    return evaluateProTrades('Top 1% Protocol (Session + Trend FVG + Auto-BE @ 1:1)', trades);
}

function evaluateProTrades(name, trades) {
    if (!trades.length) return { name, total: 0 };
    const wins = trades.filter(t => t.result === 'WIN').length;
    const bes = trades.filter(t => t.result === 'BE').length;
    const losses = trades.filter(t => t.result === 'LOSS').length;
    const winRate = ((wins / (wins + losses)) * 100).toFixed(1);
    const capitalSavedRate = (((wins + bes) / trades.length) * 100).toFixed(1);
    const totalR = trades.reduce((acc, t) => acc + t.r, 0).toFixed(1);
    const grossWinsR = trades.filter(t => t.r > 0).reduce((acc, t) => acc + t.r, 0);
    const grossLossesR = Math.abs(trades.filter(t => t.r < 0).reduce((acc, t) => acc + t.r, 0));
    const profitFactor = grossLossesR > 0 ? (grossWinsR / grossLossesR).toFixed(2) : 'INF';

    return {
        name,
        totalTrades: trades.length,
        wins,
        breakevens: bes,
        losses,
        winRateVsLosses: winRate + '%',
        capitalPreservationRate: capitalSavedRate + '%',
        totalR: '+' + totalR + 'R',
        profitFactor
    };
}

async function main() {
    const candles = await fetchCandles('15m', '1mo');
    const ema50 = calculateEMA(candles, 50);
    const result = testTopOnePercentEngine(candles, ema50);

    console.log('\n============================================================');
    console.log('TOP 1% INSTITUTIONAL PROTOCOL RESULTS:');
    console.log('============================================================');
    console.table([result]);
}

main();

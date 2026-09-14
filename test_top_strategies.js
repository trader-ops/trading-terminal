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

// ------------------------------------------------------------------
// STRATEGY: PREVIOUS DAY HIGH / LOW (PDH / PDL) LIQUIDITY SWEEP & REVERSAL
// This is the #1 institutional setup on Gold:
// Price hunts yesterday's high or low, traps breakout retail, and expands to daily equilibrium
// ------------------------------------------------------------------
function testPDHLiquiditySweep(candles) {
    let dailyRanges = {};
    candles.forEach(c => {
        const dStr = c.date.toISOString().split('T')[0];
        if (!dailyRanges[dStr]) dailyRanges[dStr] = { high: -Infinity, low: Infinity, candles: [] };
        if (c.high > dailyRanges[dStr].high) dailyRanges[dStr].high = c.high;
        if (c.low < dailyRanges[dStr].low) dailyRanges[dStr].low = c.low;
        dailyRanges[dStr].candles.push(c);
    });

    const days = Object.keys(dailyRanges).sort();
    let trades = [];

    for (let d = 1; d < days.length; d++) {
        const prevDay = dailyRanges[days[d - 1]];
        const currDay = dailyRanges[days[d]];
        const pdh = prevDay.high;
        const pdl = prevDay.low;
        const pdMid = (pdh + pdl) / 2;

        let hasTradedDay = false;

        for (let i = 0; i < currDay.candles.length - 10; i++) {
            if (hasTradedDay) break;
            const c = currDay.candles[i];

            // PDH Sweep: High pokes above PDH, but candle closes back below PDH
            if (c.high > pdh && c.close < pdh) {
                const entry = c.close;
                const sl = c.high + 1.2;
                const risk = sl - entry;
                if (risk >= 1.5 && risk <= 12) {
                    const tp = Math.max(entry - (risk * 3.0), pdMid); // Aim for 1:3 or Daily Equilibrium
                    hasTradedDay = true;

                    // Scan subsequent candles for outcome
                    const subCandles = currDay.candles.slice(i + 1);
                    for (let sc of subCandles) {
                        if (sc.high >= sl) {
                            trades.push({ type: 'SELL', result: 'LOSS', r: -1 });
                            break;
                        }
                        if (sc.low <= tp) {
                            trades.push({ type: 'SELL', result: 'WIN', r: 3.0 });
                            break;
                        }
                    }
                }
            }
            // PDL Sweep: Low pokes below PDL, but candle closes back above PDL
            else if (c.low < pdl && c.close > pdl) {
                const entry = c.close;
                const sl = c.low - 1.2;
                const risk = entry - sl;
                if (risk >= 1.5 && risk <= 12) {
                    const tp = Math.min(entry + (risk * 3.0), pdMid);
                    hasTradedDay = true;

                    const subCandles = currDay.candles.slice(i + 1);
                    for (let sc of subCandles) {
                        if (sc.low <= sl) {
                            trades.push({ type: 'BUY', result: 'LOSS', r: -1 });
                            break;
                        }
                        if (sc.high >= tp) {
                            trades.push({ type: 'BUY', result: 'WIN', r: 3.0 });
                            break;
                        }
                    }
                }
            }
        }
    }

    return evaluateTrades('1. PDH/PDL Sweep & Daily Equilibrium Target', trades);
}

// ------------------------------------------------------------------
// STRATEGY: BREAK OF STRUCTURE (BOS) + FIRST PULLBACK RETEST (PRO-TREND)
// Trend continuation: Never catch falling knives. Wait for confirmed structural break,
// then enter strictly on the 50%-61.8% Fibonacci / Order Block pullback.
// ------------------------------------------------------------------
function testProTrendRetest(candles) {
    let trades = [];
    for (let i = 30; i < candles.length - 20; i++) {
        // Find recent swing high/low over 20 bars
        let highest = -Infinity, lowest = Infinity;
        for (let b = i - 20; b < i; b++) {
            if (candles[b].high > highest) highest = candles[b].high;
            if (candles[b].low < lowest) lowest = candles[b].low;
        }

        const c = candles[i];

        // Bullish Breakout: Candle closes cleanly above recent 20-bar high
        if (c.close > highest + 1.0) {
            const impulseLow = lowest;
            const impulseHigh = c.high;
            const pullbackBuyZone = impulseHigh - (impulseHigh - impulseLow) * 0.50; // 50% discount pullback
            const invalidation = impulseLow;

            // Look for pullback in next 15 candles
            for (let j = i + 1; j < Math.min(i + 15, candles.length); j++) {
                if (candles[j].low <= pullbackBuyZone && candles[j].close > pullbackBuyZone) {
                    const entry = candles[j].close;
                    const sl = candles[j].low - 1.5;
                    const risk = entry - sl;
                    if (risk >= 2.0 && risk <= 10) {
                        const tp = entry + (risk * 2.5);

                        for (let k = j + 1; k < Math.min(j + 30, candles.length); k++) {
                            if (candles[k].low <= sl) {
                                trades.push({ type: 'BUY', result: 'LOSS', r: -1 });
                                break;
                            }
                            if (candles[k].high >= tp) {
                                trades.push({ type: 'BUY', result: 'WIN', r: 2.5 });
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        }

        // Bearish Breakout: Candle closes cleanly below recent 20-bar low
        if (c.close < lowest - 1.0) {
            const impulseHigh = highest;
            const impulseLow = c.low;
            const pullbackSellZone = impulseLow + (impulseHigh - impulseLow) * 0.50;

            for (let j = i + 1; j < Math.min(i + 15, candles.length); j++) {
                if (candles[j].high >= pullbackSellZone && candles[j].close < pullbackSellZone) {
                    const entry = candles[j].close;
                    const sl = candles[j].high + 1.5;
                    const risk = sl - entry;
                    if (risk >= 2.0 && risk <= 10) {
                        const tp = entry - (risk * 2.5);

                        for (let k = j + 1; k < Math.min(j + 30, candles.length); k++) {
                            if (candles[k].high >= sl) {
                                trades.push({ type: 'SELL', result: 'LOSS', r: -1 });
                                break;
                            }
                            if (candles[k].low <= tp) {
                                trades.push({ type: 'SELL', result: 'WIN', r: 2.5 });
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        }
    }
    return evaluateTrades('2. Pro-Trend Structural Break + 50% Pullback Retest', trades);
}

function evaluateTrades(name, trades) {
    if (!trades.length) return { name, totalTrades: 0, winRate: '0%', totalR: '0R', profitFactor: '0', maxDrawdownR: '0R' };
    const wins = trades.filter(t => t.result === 'WIN').length;
    const losses = trades.filter(t => t.result === 'LOSS').length;
    const winRate = ((wins / trades.length) * 100).toFixed(1);
    const totalR = trades.reduce((acc, t) => acc + t.r, 0).toFixed(1);
    const grossWinsR = trades.filter(t => t.r > 0).reduce((acc, t) => acc + t.r, 0);
    const grossLossesR = Math.abs(trades.filter(t => t.r < 0).reduce((acc, t) => acc + t.r, 0));
    const profitFactor = grossLossesR > 0 ? (grossWinsR / grossLossesR).toFixed(2) : 'INF';

    let peak = 0;
    let curr = 0;
    let maxDd = 0;
    trades.forEach(t => {
        curr += t.r;
        if (curr > peak) peak = curr;
        const dd = peak - curr;
        if (dd > maxDd) maxDd = dd;
    });

    return {
        name,
        totalTrades: trades.length,
        wins,
        losses,
        winRate: winRate + '%',
        totalR: (totalR > 0 ? '+' : '') + totalR + 'R',
        profitFactor,
        maxDrawdownR: maxDd.toFixed(1) + 'R'
    };
}

async function main() {
    console.log('Loading 15m and 1h candles...');
    const candles15m = await fetchCandles('15m', '1mo');
    console.log(`Loaded ${candles15m.length} 15M candles.`);

    const resPDH = testPDHLiquiditySweep(candles15m);
    const resTrend = testProTrendRetest(candles15m);

    console.log('\n============================================================');
    console.log('PRO-INSTITUTIONAL STRATEGY BACKTEST AUDIT:');
    console.log('============================================================');
    console.table([resPDH, resTrend]);
}

main();

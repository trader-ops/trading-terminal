const https = require('https');

function fetchGoldCandles() {
    return new Promise((resolve, reject) => {
        https.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1mo&interval=15m', {
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
// MODEL A: London Session Asian High/Low Liquidity Sweep (Judas Swing)
// Asian session: 00:00 - 06:00 UTC.
// London Open: 07:00 - 11:00 UTC sweeps Asian High/Low then reverses
// ----------------------------------------------------
function backtestAsianRangeSweep(candles) {
    let trades = [];
    let currentDay = -1;
    let asianHigh = -Infinity;
    let asianLow = Infinity;
    let hasSweptAsian = false;

    for (let i = 20; i < candles.length - 20; i++) {
        const c = candles[i];
        const d = c.date;
        const day = d.getUTCDate();
        const hour = d.getUTCHours();
        const min = d.getUTCMinutes();

        if (day !== currentDay) {
            currentDay = day;
            asianHigh = -Infinity;
            asianLow = Infinity;
            hasSweptAsian = false;
        }

        // Asian Session: 00:00 to 06:45 UTC
        if (hour >= 0 && hour < 7) {
            if (c.high > asianHigh) asianHigh = c.high;
            if (c.low < asianLow) asianLow = c.low;
        }

        // London Open Window: 07:00 to 11:00 UTC
        if (hour >= 7 && hour <= 11 && !hasSweptAsian && asianHigh !== -Infinity && asianLow !== Infinity) {
            const asianRange = asianHigh - asianLow;
            if (asianRange < 5 || asianRange > 35) continue; // Skip days with abnormal pre-market range

            // Scenario 1: Asian High Sweep (Hunt Buy Stops, Reversal Sell)
            if (c.high > asianHigh && c.close < asianHigh) {
                // Candle swept Asian high but closed back inside Asian range!
                hasSweptAsian = true;
                const entryPrice = c.close;
                const slPrice = c.high + 1.0;
                const risk = slPrice - entryPrice;
                if (risk >= 1.5 && risk <= 8) {
                    const tpPrice = entryPrice - (risk * 2.5); // Target 1:2.5 or Asian Midpoint

                    for (let k = i + 1; k < Math.min(i + 40, candles.length); k++) {
                        if (candles[k].high >= slPrice) {
                            trades.push({ type: 'SELL', result: 'LOSS', r: -1, risk });
                            break;
                        }
                        if (candles[k].low <= tpPrice) {
                            trades.push({ type: 'SELL', result: 'WIN', r: 2.5, risk });
                            break;
                        }
                    }
                }
            }
            // Scenario 2: Asian Low Sweep (Hunt Sell Stops, Reversal Buy)
            else if (c.low < asianLow && c.close > asianLow) {
                hasSweptAsian = true;
                const entryPrice = c.close;
                const slPrice = c.low - 1.0;
                const risk = entryPrice - slPrice;
                if (risk >= 1.5 && risk <= 8) {
                    const tpPrice = entryPrice + (risk * 2.5);

                    for (let k = i + 1; k < Math.min(i + 40, candles.length); k++) {
                        if (candles[k].low <= slPrice) {
                            trades.push({ type: 'BUY', result: 'LOSS', r: -1, risk });
                            break;
                        }
                        if (candles[k].high >= tpPrice) {
                            trades.push({ type: 'BUY', result: 'WIN', r: 2.5, risk });
                            break;
                        }
                    }
                }
            }
        }
    }
    return evaluateTrades('A. Asian Range Liquidity Sweep (London Judas)', trades);
}

// ----------------------------------------------------
// MODEL B: NY Session Momentum Trend Pullback into 20 EMA + 50 EMA
// ----------------------------------------------------
function backtestNYTrendPullback(candles, ema20, ema50) {
    let trades = [];
    for (let i = 50; i < candles.length - 20; i++) {
        const c = candles[i];
        const hour = c.date.getUTCHours();

        // Active London / NY Overlap: 12:00 to 18:00 UTC
        if (hour >= 12 && hour <= 18) {
            const isBull = ema20[i] > ema50[i] && ema50[i] > ema50[i - 5];
            const isBear = ema20[i] < ema50[i] && ema50[i] < ema50[i - 5];

            // Bullish Trend: Price pulls back to 20 EMA or 50 EMA with rejection wick
            if (isBull && c.low <= ema20[i] && c.close > ema20[i] && c.close > c.open) {
                const entryPrice = c.close;
                const slPrice = Math.min(c.low, ema50[i]) - 1.0;
                const risk = entryPrice - slPrice;
                if (risk >= 1.5 && risk <= 9) {
                    const tpPrice = entryPrice + (risk * 2.5);

                    for (let k = i + 1; k < Math.min(i + 35, candles.length); k++) {
                        if (candles[k].low <= slPrice) {
                            trades.push({ type: 'BUY', result: 'LOSS', r: -1, risk });
                            break;
                        }
                        if (candles[k].high >= tpPrice) {
                            trades.push({ type: 'BUY', result: 'WIN', r: 2.5, risk });
                            break;
                        }
                    }
                }
            }
            // Bearish Trend: Price pulls back up to 20 EMA or 50 EMA with upper rejection wick
            else if (isBear && c.high >= ema20[i] && c.close < ema20[i] && c.close < c.open) {
                const entryPrice = c.close;
                const slPrice = Math.max(c.high, ema50[i]) + 1.0;
                const risk = slPrice - entryPrice;
                if (risk >= 1.5 && risk <= 9) {
                    const tpPrice = entryPrice - (risk * 2.5);

                    for (let k = i + 1; k < Math.min(i + 35, candles.length); k++) {
                        if (candles[k].high >= slPrice) {
                            trades.push({ type: 'SELL', result: 'LOSS', r: -1, risk });
                            break;
                        }
                        if (candles[k].low <= tpPrice) {
                            trades.push({ type: 'SELL', result: 'WIN', r: 2.5, risk });
                            break;
                        }
                    }
                }
            }
        }
    }
    return evaluateTrades('B. Session High-Volume Trend Pullback (20/50 EMA)', trades);
}

// ----------------------------------------------------
// MODEL C: FVG with Strict Dynamic Confluence (Only inside Killzone + Trend Alignment)
// ----------------------------------------------------
function backtestSessionFVG(candles, ema50) {
    let trades = [];
    for (let i = 50; i < candles.length - 20; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1];
        const c3 = candles[i];
        const hour = c3.date.getUTCHours();

        // Strictly London & NY sessions: 07:00-11:00 UTC or 13:00-18:00 UTC
        const isKillzone = (hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 18);
        if (!isKillzone) continue;

        const isBull = c3.close > ema50[i];
        const isBear = c3.close < ema50[i];

        // Bullish FVG
        if (isBull && c3.low > c1.high + 1.0) {
            const fvgLow = c1.high;
            const fvgHigh = c3.low;

            for (let j = i + 1; j < Math.min(i + 15, candles.length); j++) {
                // Retest with rejection close
                if (candles[j].low <= fvgHigh && candles[j].close > fvgLow && candles[j].close > candles[j].open) {
                    const entryPrice = candles[j].close;
                    const slPrice = Math.min(candles[j].low, c2.low) - 0.8;
                    const risk = entryPrice - slPrice;
                    if (risk >= 1.5 && risk <= 8) {
                        const tpPrice = entryPrice + (risk * 2.5);

                        for (let k = j + 1; k < Math.min(j + 35, candles.length); k++) {
                            if (candles[k].low <= slPrice) {
                                trades.push({ type: 'BUY', result: 'LOSS', r: -1, risk });
                                break;
                            }
                            if (candles[k].high >= tpPrice) {
                                trades.push({ type: 'BUY', result: 'WIN', r: 2.5, risk });
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        }

        // Bearish FVG
        if (isBear && c1.low > c3.high + 1.0) {
            const fvgHigh = c1.low;
            const fvgLow = c3.high;

            for (let j = i + 1; j < Math.min(i + 15, candles.length); j++) {
                if (candles[j].high >= fvgLow && candles[j].close < fvgHigh && candles[j].close < candles[j].open) {
                    const entryPrice = candles[j].close;
                    const slPrice = Math.max(candles[j].high, c2.high) + 0.8;
                    const risk = slPrice - entryPrice;
                    if (risk >= 1.5 && risk <= 8) {
                        const tpPrice = entryPrice - (risk * 2.5);

                        for (let k = j + 1; k < Math.min(j + 35, candles.length); k++) {
                            if (candles[k].high >= slPrice) {
                                trades.push({ type: 'SELL', result: 'LOSS', r: -1, risk });
                                break;
                            }
                            if (candles[k].low <= tpPrice) {
                                trades.push({ type: 'SELL', result: 'WIN', r: 2.5, risk });
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        }
    }
    return evaluateTrades('C. Killzone FVG + HTF Trend + Rejection Confirmation', trades);
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

async function run() {
    console.log('Fetching real Gold 15M candles from market feed...');
    const candles = await fetchGoldCandles();
    console.log(`Loaded ${candles.length} historical 15M candles spanning last 30 days.`);
    const ema20 = calculateEMA(candles, 20);
    const ema50 = calculateEMA(candles, 50);

    const rA = backtestAsianRangeSweep(candles);
    const rB = backtestNYTrendPullback(candles, ema20, ema50);
    const rC = backtestSessionFVG(candles, ema50);

    console.log('\n============================================================');
    console.log('SESSION & TIMING QUANTITATIVE AUDIT RESULTS:');
    console.log('============================================================');
    console.table([rA, rB, rC]);
}

run();

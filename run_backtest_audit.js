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
// STRATEGY 1: Naive / Blind FVG (Retail SMC)
// ----------------------------------------------------
function backtestNaiveFVG(candles) {
    let trades = [];
    for (let i = 20; i < candles.length - 20; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1];
        const c3 = candles[i];

        // Bullish FVG
        if (c3.low > c1.high + 0.5) {
            const entryPrice = c3.low;
            const slPrice = c2.low - 0.5;
            const risk = entryPrice - slPrice;
            if (risk <= 0 || risk > 15) continue;
            const tpPrice = entryPrice + (risk * 2.0);

            for (let j = i + 1; j < Math.min(i + 30, candles.length); j++) {
                if (candles[j].low <= entryPrice) {
                    for (let k = j; k < Math.min(j + 40, candles.length); k++) {
                        if (candles[k].low <= slPrice) {
                            trades.push({ type: 'BUY', result: 'LOSS', r: -1, risk });
                            break;
                        }
                        if (candles[k].high >= tpPrice) {
                            trades.push({ type: 'BUY', result: 'WIN', r: 2.0, risk });
                            break;
                        }
                    }
                    break;
                }
            }
        }

        // Bearish FVG
        if (c1.low > c3.high + 0.5) {
            const entryPrice = c3.high;
            const slPrice = c2.high + 0.5;
            const risk = slPrice - entryPrice;
            if (risk <= 0 || risk > 15) continue;
            const tpPrice = entryPrice - (risk * 2.0);

            for (let j = i + 1; j < Math.min(i + 30, candles.length); j++) {
                if (candles[j].high >= entryPrice) {
                    for (let k = j; k < Math.min(j + 40, candles.length); k++) {
                        if (candles[k].high >= slPrice) {
                            trades.push({ type: 'SELL', result: 'LOSS', r: -1, risk });
                            break;
                        }
                        if (candles[k].low <= tpPrice) {
                            trades.push({ type: 'SELL', result: 'WIN', r: 2.0, risk });
                            break;
                        }
                    }
                    break;
                }
            }
        }
    }
    return evaluateTrades('1. Naive / Blind FVG (Retail)', trades);
}

// ----------------------------------------------------
// STRATEGY 2: FVG with HTF Trend Filter & Rejection Close
// ----------------------------------------------------
function backtestTrendFilteredFVG(candles, ema50) {
    let trades = [];
    for (let i = 50; i < candles.length - 20; i++) {
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
                    const slPrice = Math.min(candles[j].low, c2.low) - 0.5;
                    const risk = entryPrice - slPrice;
                    if (risk <= 0 || risk > 12) break;
                    const tpPrice = entryPrice + (risk * 2.5);

                    for (let k = j + 1; k < Math.min(j + 40, candles.length); k++) {
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

        if (isBearTrend && c1.low > c3.high + 0.5) {
            const fvgHigh = c1.low;
            const fvgLow = c3.high;

            for (let j = i + 1; j < Math.min(i + 20, candles.length); j++) {
                if (candles[j].high >= fvgLow && candles[j].close < fvgHigh) {
                    const entryPrice = candles[j].close;
                    const slPrice = Math.max(candles[j].high, c2.high) + 0.5;
                    const risk = slPrice - entryPrice;
                    if (risk <= 0 || risk > 12) break;
                    const tpPrice = entryPrice - (risk * 2.5);

                    for (let k = j + 1; k < Math.min(j + 40, candles.length); k++) {
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
    return evaluateTrades('2. FVG + Trend Filter & Rejection Close', trades);
}

// ----------------------------------------------------
// STRATEGY 3: Inversion FVG / Failed FVG Flip
// ----------------------------------------------------
function backtestInversionFVG(candles) {
    let trades = [];
    for (let i = 20; i < candles.length - 30; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1];
        const c3 = candles[i];

        if (c3.low > c1.high + 0.5) {
            const fvgTop = c3.low;
            const fvgBottom = c1.high;

            for (let j = i + 1; j < Math.min(i + 15, candles.length); j++) {
                if (candles[j].close < fvgBottom) {
                    for (let k = j + 1; k < Math.min(j + 25, candles.length); k++) {
                        if (candles[k].high >= fvgBottom && candles[k].close <= fvgTop) {
                            const entryPrice = candles[k].close;
                            const slPrice = fvgTop + 0.8;
                            const risk = slPrice - entryPrice;
                            if (risk <= 0 || risk > 12) break;
                            const tpPrice = entryPrice - (risk * 2.5);

                            for (let m = k + 1; m < Math.min(k + 40, candles.length); m++) {
                                if (candles[m].high >= slPrice) {
                                    trades.push({ type: 'SELL', result: 'LOSS', r: -1, risk });
                                    break;
                                }
                                if (candles[m].low <= tpPrice) {
                                    trades.push({ type: 'SELL', result: 'WIN', r: 2.5, risk });
                                    break;
                                }
                            }
                            break;
                        }
                    }
                    break;
                }
            }
        }

        if (c1.low > c3.high + 0.5) {
            const fvgTop = c1.low;
            const fvgBottom = c3.high;

            for (let j = i + 1; j < Math.min(i + 15, candles.length); j++) {
                if (candles[j].close > fvgTop) {
                    for (let k = j + 1; k < Math.min(j + 25, candles.length); k++) {
                        if (candles[k].low <= fvgTop && candles[k].close >= fvgBottom) {
                            const entryPrice = candles[k].close;
                            const slPrice = fvgBottom - 0.8;
                            const risk = entryPrice - slPrice;
                            if (risk <= 0 || risk > 12) break;
                            const tpPrice = entryPrice + (risk * 2.5);

                            for (let m = k + 1; m < Math.min(k + 40, candles.length); m++) {
                                if (candles[m].low <= slPrice) {
                                    trades.push({ type: 'BUY', result: 'LOSS', r: -1, risk });
                                    break;
                                }
                                if (candles[m].low >= tpPrice) {
                                    trades.push({ type: 'BUY', result: 'WIN', r: 2.5, risk });
                                    break;
                                }
                            }
                            break;
                        }
                    }
                    break;
                }
            }
        }
    }
    return evaluateTrades('3. Inversion FVG / Failed FVG Flip', trades);
}

// ----------------------------------------------------
// STRATEGY 4: Top 1% Institutional Model (Sweep + MSS + Retest)
// ----------------------------------------------------
function backtestInstitutionalSweepMSS(candles) {
    let trades = [];
    for (let i = 25; i < candles.length - 25; i++) {
        let swingHigh = -Infinity;
        let swingLow = Infinity;
        for (let b = i - 15; b < i; b++) {
            if (candles[b].high > swingHigh) swingHigh = candles[b].high;
            if (candles[b].low < swingLow) swingLow = candles[b].low;
        }

        const curr = candles[i];

        // Bearish Sweep
        if (curr.high > swingHigh && curr.close < swingHigh) {
            const next1 = candles[i + 1];
            if (next1 && next1.close < curr.low) {
                const entryPrice = next1.close;
                const slPrice = curr.high + 0.6;
                const risk = slPrice - entryPrice;
                if (risk > 1.2 && risk < 10) {
                    const tpPrice = entryPrice - (risk * 3.0);

                    for (let k = i + 2; k < Math.min(i + 45, candles.length); k++) {
                        if (candles[k].high >= slPrice) {
                            trades.push({ type: 'SELL', result: 'LOSS', r: -1, risk });
                            break;
                        }
                        if (candles[k].low <= tpPrice) {
                            trades.push({ type: 'SELL', result: 'WIN', r: 3.0, risk });
                            break;
                        }
                    }
                }
            }
        }

        // Bullish Sweep
        if (curr.low < swingLow && curr.close > swingLow) {
            const next1 = candles[i + 1];
            if (next1 && next1.close > curr.high) {
                const entryPrice = next1.close;
                const slPrice = curr.low - 0.6;
                const risk = entryPrice - slPrice;
                if (risk > 1.2 && risk < 10) {
                    const tpPrice = entryPrice + (risk * 3.0);

                    for (let k = i + 2; k < Math.min(i + 45, candles.length); k++) {
                        if (candles[k].low <= slPrice) {
                            trades.push({ type: 'BUY', result: 'LOSS', r: -1, risk });
                            break;
                        }
                        if (candles[k].high >= tpPrice) {
                            trades.push({ type: 'BUY', result: 'WIN', r: 3.0, risk });
                            break;
                        }
                    }
                }
            }
        }
    }
    return evaluateTrades('4. Top 1% Institutional (Sweep + MSS + Displacement)', trades);
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
    try {
        console.log('Fetching real Gold 15M candles from market feed...');
        const candles = await fetchGoldCandles();
        console.log(`Loaded ${candles.length} historical 15M candles spanning last 30 days.`);
        const ema50 = calculateEMA(candles, 50);

        const r1 = backtestNaiveFVG(candles);
        const r2 = backtestTrendFilteredFVG(candles, ema50);
        const r3 = backtestInversionFVG(candles);
        const r4 = backtestInstitutionalSweepMSS(candles);

        console.log('\n============================================================');
        console.log('REAL QUANTITATIVE BACKTEST RESULTS (2,400+ 15M Gold Candles):');
        console.log('============================================================');
        console.table([r1, r2, r3, r4]);
    } catch(err) {
        console.error('Backtest error:', err);
    }
}

run();

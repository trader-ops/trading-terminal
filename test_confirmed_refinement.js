const https = require('https');

function fetch5mCandles() {
    return new Promise((resolve, reject) => {
        https.get('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1mo&interval=5m', {
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

function aggregateCandles(m5Candles, countPerBar) {
    const agg = [];
    for (let i = 0; i < m5Candles.length; i += countPerBar) {
        const slice = m5Candles.slice(i, i + countPerBar);
        if (slice.length < countPerBar) break;
        const open = slice[0].open;
        const close = slice[slice.length - 1].close;
        let high = -Infinity;
        let low = Infinity;
        let vol = 0;
        for (let c of slice) {
            if (c.high > high) high = c.high;
            if (c.low < low) low = c.low;
            vol += c.volume;
        }
        agg.push({
            time: slice[0].time,
            date: slice[0].date,
            open,
            high,
            low,
            close,
            volume: vol,
            m5StartIndex: i,
            m5EndIndex: i + slice.length - 1
        });
    }
    return agg;
}

function runRefinementWithConfirmation(m5) {
    const m15 = aggregateCandles(m5, 3);
    const h1  = aggregateCandles(m5, 12);

    let tradesConfirm1_3 = [];
    let tradesConfirm1_4 = [];

    for (let h = 3; h < h1.length - 10; h++) {
        const prev1H = h1[h - 1];
        const curr1H = h1[h];

        // 1. BULLISH 1H OB
        const isBullish1hOB = prev1H.close < prev1H.open && 
                              curr1H.close > prev1H.high + 1.0 && 
                              (curr1H.high - curr1H.low) > 4.0;

        if (isBullish1hOB) {
            const obHigh = Math.max(prev1H.open, prev1H.high);
            const obLow = prev1H.low;
            const obRange = obHigh - obLow;
            if (obRange < 2.0 || obRange > 25.0) continue;

            const m5Start = prev1H.m5StartIndex;
            const m5End = curr1H.m5EndIndex;
            let refinedZone = null;

            // 15M FVG Check inside 1H OB
            const m15InOB = m15.filter(c => c.time >= prev1H.time && c.time <= curr1H.time);
            for (let k = 1; k < m15InOB.length - 1; k++) {
                if (m15InOB[k + 1].low > m15InOB[k - 1].high + 0.5 && m15InOB[k - 1].high >= obLow) {
                    refinedZone = { top: m15InOB[k + 1].low, bottom: m15InOB[k - 1].high, type: '15M_FVG' };
                    break;
                }
            }

            // 5M Fresh FVG check
            const m5InOB = m5.slice(m5Start, m5End + 1);
            for (let k = 1; k < m5InOB.length - 1; k++) {
                if (m5InOB[k + 1].low > m5InOB[k - 1].high + 0.4 && m5InOB[k - 1].high >= obLow) {
                    refinedZone = { top: m5InOB[k + 1].low, bottom: m5InOB[k - 1].high, type: '5M_FRESH_FVG' };
                    break;
                }
            }

            if (!refinedZone) {
                let lowestM5 = null;
                for (let c of m5InOB) {
                    if (c.close < c.open && (!lowestM5 || c.low < lowestM5.low)) lowestM5 = c;
                }
                if (lowestM5) refinedZone = { top: lowestM5.high, bottom: lowestM5.low, type: '5M_REFINED_OB' };
                else refinedZone = { top: obLow + (obRange * 0.5), bottom: obLow, type: '1H_50_PCT' };
            }

            // Monitor future pullback
            const futureM5 = m5.slice(m5End + 1, Math.min(m5End + 288, m5.length));
            let zoneTouched = false;

            for (let m = 1; m < futureM5.length - 20; m++) {
                const fc = futureM5[m];

                if (!zoneTouched && fc.low <= refinedZone.top && fc.close >= refinedZone.bottom) {
                    zoneTouched = true;
                }

                // CONFIRMATION TRIGGER: After touching zone, wait for a 5M BULLISH REJECTION CANDLE (close > open and close > previous high)
                if (zoneTouched && fc.close > fc.open && fc.close > futureM5[m - 1].high) {
                    const entryPrice = fc.close;
                    const slPrice = Math.min(fc.low, futureM5[m - 1].low, refinedZone.bottom) - 0.8;
                    const risk = entryPrice - slPrice;

                    if (risk >= 1.0 && risk <= 8.0) {
                        const outcomeBars = futureM5.slice(m + 1, m + 80);

                        // Test 1:3 RR
                        const tp1_3 = entryPrice + (risk * 3.0);
                        for (let ob of outcomeBars) {
                            if (ob.low <= slPrice) { tradesConfirm1_3.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                            if (ob.high >= tp1_3) { tradesConfirm1_3.push({ type: 'BUY', result: 'WIN', r: 3.0 }); break; }
                        }

                        // Test 1:4 RR
                        const tp1_4 = entryPrice + (risk * 4.0);
                        for (let ob of outcomeBars) {
                            if (ob.low <= slPrice) { tradesConfirm1_4.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                            if (ob.high >= tp1_4) { tradesConfirm1_4.push({ type: 'BUY', result: 'WIN', r: 4.0 }); break; }
                        }
                    }
                    break; // One entry per 1H setup
                }
            }
        }

        // 2. BEARISH 1H OB
        const isBearish1hOB = prev1H.close > prev1H.open && 
                              curr1H.close < prev1H.low - 1.0 && 
                              (curr1H.high - curr1H.low) > 4.0;

        if (isBearish1hOB) {
            const obHigh = prev1H.high;
            const obLow = Math.min(prev1H.open, prev1H.low);
            const obRange = obHigh - obLow;
            if (obRange < 2.0 || obRange > 25.0) continue;

            const m5Start = prev1H.m5StartIndex;
            const m5End = curr1H.m5EndIndex;
            let refinedZone = null;

            const m15InOB = m15.filter(c => c.time >= prev1H.time && c.time <= curr1H.time);
            for (let k = 1; k < m15InOB.length - 1; k++) {
                if (m15InOB[k - 1].low > m15InOB[k + 1].high + 0.5 && m15InOB[k - 1].low <= obHigh) {
                    refinedZone = { top: m15InOB[k - 1].low, bottom: m15InOB[k + 1].high, type: '15M_FVG' };
                    break;
                }
            }

            const m5InOB = m5.slice(m5Start, m5End + 1);
            for (let k = 1; k < m5InOB.length - 1; k++) {
                if (m5InOB[k - 1].low > m5InOB[k + 1].high + 0.4 && m5InOB[k - 1].low <= obHigh) {
                    refinedZone = { top: m5InOB[k - 1].low, bottom: m5InOB[k + 1].high, type: '5M_FRESH_FVG' };
                    break;
                }
            }

            if (!refinedZone) {
                let highestM5 = null;
                for (let c of m5InOB) {
                    if (c.close > c.open && (!highestM5 || c.high > highestM5.high)) highestM5 = c;
                }
                if (highestM5) refinedZone = { top: highestM5.high, bottom: highestM5.low, type: '5M_REFINED_OB' };
                else refinedZone = { top: obHigh, bottom: obHigh - (obRange * 0.5), type: '1H_50_PCT' };
            }

            const futureM5 = m5.slice(m5End + 1, Math.min(m5End + 288, m5.length));
            let zoneTouched = false;

            for (let m = 1; m < futureM5.length - 20; m++) {
                const fc = futureM5[m];

                if (!zoneTouched && fc.high >= refinedZone.bottom && fc.close <= refinedZone.top) {
                    zoneTouched = true;
                }

                if (zoneTouched && fc.close < fc.open && fc.close < futureM5[m - 1].low) {
                    const entryPrice = fc.close;
                    const slPrice = Math.max(fc.high, futureM5[m - 1].high, refinedZone.top) + 0.8;
                    const risk = slPrice - entryPrice;

                    if (risk >= 1.0 && risk <= 8.0) {
                        const outcomeBars = futureM5.slice(m + 1, m + 80);

                        // Test 1:3 RR
                        const tp1_3 = entryPrice - (risk * 3.0);
                        for (let ob of outcomeBars) {
                            if (ob.high >= slPrice) { tradesConfirm1_3.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                            if (ob.low <= tp1_3) { tradesConfirm1_3.push({ type: 'SELL', result: 'WIN', r: 3.0 }); break; }
                        }

                        // Test 1:4 RR
                        const tp1_4 = entryPrice - (risk * 4.0);
                        for (let ob of outcomeBars) {
                            if (ob.high >= slPrice) { tradesConfirm1_4.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                            if (ob.low <= tp1_4) { tradesConfirm1_4.push({ type: 'SELL', result: 'WIN', r: 4.0 }); break; }
                        }
                    }
                    break;
                }
            }
        }
    }

    return {
        confirm1_3: evaluateSummary('1H OB ➔ Refined 5M FVG/OB + 5M Rejection Close (1:3 R:R)', tradesConfirm1_3),
        confirm1_4: evaluateSummary('1H OB ➔ Refined 5M FVG/OB + 5M Rejection Close (1:4 R:R)', tradesConfirm1_4)
    };
}

function evaluateSummary(name, trades) {
    if (!trades.length) return { strategy: name, totalTrades: 0, winRate: '0%', totalR: '0R', profitFactor: '0' };
    const wins = trades.filter(t => t.r > 0).length;
    const losses = trades.filter(t => t.r <= 0).length;
    const winRate = ((wins / trades.length) * 100).toFixed(1);
    const totalR = trades.reduce((acc, t) => acc + t.r, 0).toFixed(1);
    const grossWinsR = trades.filter(t => t.r > 0).reduce((acc, t) => acc + t.r, 0);
    const grossLossesR = Math.abs(trades.filter(t => t.r <= 0).reduce((acc, t) => acc + t.r, 0));
    const profitFactor = grossLossesR > 0 ? (grossWinsR / grossLossesR).toFixed(2) : 'INF';

    return {
        strategy: name,
        totalTrades: trades.length,
        wins,
        losses,
        winRate: winRate + '%',
        totalR: (totalR > 0 ? '+' : '') + totalR + 'R',
        profitFactor
    };
}

async function main() {
    const m5 = await fetch5mCandles();
    const res = runRefinementWithConfirmation(m5);
    console.log('\n========================================================================================');
    console.log('REFINEMENT + 5M REJECTION CONFIRMATION AUDIT RESULTS:');
    console.log('========================================================================================');
    console.table([res.confirm1_3, res.confirm1_4]);
}

main();

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
            volume: vol
        });
    }
    return agg;
}

function testRefinementTo15M(m5) {
    const m15 = aggregateCandles(m5, 3);
    const h1  = aggregateCandles(m5, 12);

    let trades15m_1_3 = [];
    let trades15m_1_25 = [];

    for (let h = 3; h < h1.length - 8; h++) {
        const prev1H = h1[h - 1];
        const curr1H = h1[h];

        // Bullish 1H OB
        if (prev1H.close < prev1H.open && curr1H.close > prev1H.high + 1.0 && (curr1H.high - curr1H.low) > 4.0) {
            const obLow = prev1H.low;
            const obHigh = Math.max(prev1H.open, prev1H.high);
            const obRange = obHigh - obLow;
            if (obRange < 2 || obRange > 25) continue;

            // Refine inside 15M
            const m15InOB = m15.filter(c => c.time >= prev1H.time && c.time <= curr1H.time);
            let refinedZone = null;

            // Check 15M Fresh FVG
            for (let k = 1; k < m15InOB.length - 1; k++) {
                if (m15InOB[k + 1].low > m15InOB[k - 1].high + 0.5 && m15InOB[k - 1].high >= obLow) {
                    refinedZone = { top: m15InOB[k + 1].low, bottom: m15InOB[k - 1].high, type: '15M_FVG' };
                    break;
                }
            }

            // Fallback: 15M OB
            if (!refinedZone) {
                let lowest = null;
                for (let c of m15InOB) {
                    if (c.close < c.open && (!lowest || c.low < lowest.low)) lowest = c;
                }
                if (lowest) refinedZone = { top: lowest.high, bottom: lowest.low, type: '15M_OB' };
                else refinedZone = { top: obLow + (obRange * 0.5), bottom: obLow, type: '1H_50' };
            }

            // Monitor 15M future pullback
            const curr15mIndex = m15.findIndex(c => c.time === curr1H.time);
            if (curr15mIndex === -1) continue;

            const future15 = m15.slice(curr15mIndex + 1, Math.min(curr15mIndex + 96, m15.length));
            for (let j = 0; j < future15.length - 10; j++) {
                const c = future15[j];
                // Tapped refined zone
                if (c.low <= refinedZone.top && c.close >= refinedZone.bottom) {
                    const entry = refinedZone.top;
                    const sl = refinedZone.bottom - 1.2;
                    const risk = entry - sl;
                    if (risk < 1.5 || risk > 12) break;

                    const tp1_3 = entry + (risk * 3.0);
                    const tp1_25 = entry + (risk * 2.5);

                    const sub = future15.slice(j + 1, j + 40);

                    // 1:3 RR
                    for (let sc of sub) {
                        if (sc.low <= sl) { trades15m_1_3.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                        if (sc.high >= tp1_3) { trades15m_1_3.push({ type: 'BUY', result: 'WIN', r: 3.0 }); break; }
                    }

                    // 1:2.5 RR
                    for (let sc of sub) {
                        if (sc.low <= sl) { trades15m_1_25.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                        if (sc.high >= tp1_25) { trades15m_1_25.push({ type: 'BUY', result: 'WIN', r: 2.5 }); break; }
                    }
                    break;
                }
            }
        }

        // Bearish 1H OB
        if (prev1H.close > prev1H.open && curr1H.close < prev1H.low - 1.0 && (curr1H.high - curr1H.low) > 4.0) {
            const obHigh = prev1H.high;
            const obLow = Math.min(prev1H.open, prev1H.low);
            const obRange = obHigh - obLow;
            if (obRange < 2 || obRange > 25) continue;

            const m15InOB = m15.filter(c => c.time >= prev1H.time && c.time <= curr1H.time);
            let refinedZone = null;

            for (let k = 1; k < m15InOB.length - 1; k++) {
                if (m15InOB[k - 1].low > m15InOB[k + 1].high + 0.5 && m15InOB[k - 1].low <= obHigh) {
                    refinedZone = { top: m15InOB[k - 1].low, bottom: m15InOB[k + 1].high, type: '15M_FVG' };
                    break;
                }
            }

            if (!refinedZone) {
                let highest = null;
                for (let c of m15InOB) {
                    if (c.close > c.open && (!highest || c.high > highest.high)) highest = c;
                }
                if (highest) refinedZone = { top: highest.high, bottom: highest.low, type: '15M_OB' };
                else refinedZone = { top: obHigh, bottom: obHigh - (obRange * 0.5), type: '1H_50' };
            }

            const curr15mIndex = m15.findIndex(c => c.time === curr1H.time);
            if (curr15mIndex === -1) continue;

            const future15 = m15.slice(curr15mIndex + 1, Math.min(curr15mIndex + 96, m15.length));
            for (let j = 0; j < future15.length - 10; j++) {
                const c = future15[j];
                if (c.high >= refinedZone.bottom && c.close <= refinedZone.top) {
                    const entry = refinedZone.bottom;
                    const sl = refinedZone.top + 1.2;
                    const risk = sl - entry;
                    if (risk < 1.5 || risk > 12) break;

                    const tp1_3 = entry - (risk * 3.0);
                    const tp1_25 = entry - (risk * 2.5);

                    const sub = future15.slice(j + 1, j + 40);

                    for (let sc of sub) {
                        if (sc.high >= sl) { trades15m_1_3.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                        if (sc.low <= tp1_3) { trades15m_1_3.push({ type: 'SELL', result: 'WIN', r: 3.0 }); break; }
                    }

                    for (let sc of sub) {
                        if (sc.high >= sl) { trades15m_1_25.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                        if (sc.low <= tp1_25) { trades15m_1_25.push({ type: 'SELL', result: 'WIN', r: 2.5 }); break; }
                    }
                    break;
                }
            }
        }
    }

    return {
        res1_3: evaluateSummary('1H OB Refined to 15M Fresh FVG / OB (1:3 R:R)', trades15m_1_3),
        res1_25: evaluateSummary('1H OB Refined to 15M Fresh FVG / OB (1:2.5 R:R)', trades15m_1_25)
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
    const res = testRefinementTo15M(m5);
    console.log('\n========================================================================================');
    console.log('1H OB ➔ 15M FRESH FVG / REFINED OB REFINEMENT AUDIT:');
    console.log('========================================================================================');
    console.table([res.res1_3, res.res1_25]);
}

main();

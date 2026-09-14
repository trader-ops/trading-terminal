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
            endTime: slice[slice.length - 1].time,
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

// Find FVG or OB inside a given parent price zone [zoneLow, zoneHigh] on a specific timeframe array
function findRefinedSubZone(candlesSlice, parentLow, parentHigh, isBullish) {
    // 1. Check for fresh unmitigated FVG inside the parent zone
    for (let k = 1; k < candlesSlice.length - 1; k++) {
        const c1 = candlesSlice[k - 1];
        const c2 = candlesSlice[k];
        const c3 = candlesSlice[k + 1];

        if (isBullish) {
            // Bullish FVG: c3.low > c1.high
            if (c3.low > c1.high + 0.3) {
                const fvgTop = c3.low;
                const fvgBottom = c1.high;
                // Check if overlapping parent zone
                const overlapLow = Math.max(fvgBottom, parentLow);
                const overlapHigh = Math.min(fvgTop, parentHigh);
                if (overlapHigh > overlapLow + 0.3) {
                    return { low: overlapLow, high: overlapHigh, type: 'FVG' };
                }
            }
        } else {
            // Bearish FVG: c1.low > c3.high
            if (c1.low > c3.high + 0.3) {
                const fvgTop = c1.low;
                const fvgBottom = c3.high;
                const overlapLow = Math.max(fvgBottom, parentLow);
                const overlapHigh = Math.min(fvgTop, parentHigh);
                if (overlapHigh > overlapLow + 0.3) {
                    return { low: overlapLow, high: overlapHigh, type: 'FVG' };
                }
            }
        }
    }

    // 2. Check for refined Order Block (extreme candle) inside parent zone
    if (isBullish) {
        let bestOb = null;
        for (let c of candlesSlice) {
            if (c.close < c.open && c.low >= parentLow - 0.5 && c.high <= parentHigh + 0.5) {
                if (!bestOb || c.low < bestOb.low) bestOb = c;
            }
        }
        if (bestOb) {
            return { low: Math.max(bestOb.low, parentLow), high: Math.min(bestOb.high, parentHigh), type: 'OB' };
        }
    } else {
        let bestOb = null;
        for (let c of candlesSlice) {
            if (c.close > c.open && c.high <= parentHigh + 0.5 && c.low >= parentLow - 0.5) {
                if (!bestOb || c.high > bestOb.high) bestOb = c;
            }
        }
        if (bestOb) {
            return { low: Math.max(bestOb.low, parentLow), high: Math.min(bestOb.high, parentHigh), type: 'OB' };
        }
    }

    // Fallback: Discount / Premium 50% half of the parent zone
    const mid = (parentLow + parentHigh) / 2;
    if (isBullish) {
        return { low: parentLow, high: mid, type: '50%_DISCOUNT' };
    } else {
        return { low: mid, high: parentHigh, type: '50%_PREMIUM' };
    }
}

async function runFullStepwiseRefinement() {
    console.log('Downloading 5,400+ real 5M candles...');
    const m5 = await fetch5mCandles();
    console.log(`Downloaded ${m5.length} 5M bars.`);

    const m15 = aggregateCandles(m5, 3);
    const m30 = aggregateCandles(m5, 6);
    const m45 = aggregateCandles(m5, 9);
    const h1  = aggregateCandles(m5, 12);

    console.log(`TF Counts -> 1H: ${h1.length}, 45M: ${m45.length}, 30M: ${m30.length}, 15M: ${m15.length}, 5M: ${m5.length}`);

    let refinementStats = [];
    let tradesSniper1_3 = [];
    let tradesSniper1_5 = [];
    let tradesSniperTo1HTarget = [];

    // Loop through 1H bars to locate genuine 1H Order Blocks
    for (let h = 3; h < h1.length - 8; h++) {
        const prev1H = h1[h - 1];
        const curr1H = h1[h];

        // ----------------------------------------------------
        // BULLISH 1H OB (Down candle before aggressive expansion)
        // ----------------------------------------------------
        if (prev1H.close < prev1H.open && curr1H.close > prev1H.high + 1.0 && (curr1H.high - curr1H.low) > 4.0) {
            const h1Low = prev1H.low;
            const h1High = Math.max(prev1H.open, prev1H.high);
            const h1Target = curr1H.high; // Target opposing 1H swing high!
            const h1Range = h1High - h1Low;
            if (h1Range < 2 || h1Range > 30) continue;

            const startTime = prev1H.time;
            const endTime = curr1H.endTime;

            // STEP 2: REFINE ON 45M
            const slice45m = m45.filter(c => c.time >= startTime && c.time <= endTime);
            const zone45m = findRefinedSubZone(slice45m, h1Low, h1High, true);

            // STEP 3: REFINE ON 30M (inside 45M zone)
            const slice30m = m30.filter(c => c.time >= startTime && c.time <= endTime);
            const zone30m = findRefinedSubZone(slice30m, zone45m.low, zone45m.high, true);

            // STEP 4: REFINE ON 15M (inside 30M zone)
            const slice15m = m15.filter(c => c.time >= startTime && c.time <= endTime);
            const zone15m = findRefinedSubZone(slice15m, zone30m.low, zone30m.high, true);

            // STEP 5: REFINE ON 5M (inside 15M zone -> ultimate sniper POI!)
            const slice5m = m5.filter(c => c.time >= startTime && c.time <= endTime);
            const zone5m = findRefinedSubZone(slice5m, zone15m.low, zone15m.high, true);

            refinementStats.push({
                direction: 'BULLISH',
                h1Size: h1Range.toFixed(2),
                m45Size: (zone45m.high - zone45m.low).toFixed(2),
                m30Size: (zone30m.high - zone30m.low).toFixed(2),
                m15Size: (zone15m.high - zone15m.low).toFixed(2),
                m5Size: (zone5m.high - zone5m.low).toFixed(2),
                m5Type: zone5m.type
            });

            // TEST EXECUTION: Look ahead on future 5M bars for pullback retest into 5M sniper zone!
            const currM5End = curr1H.m5EndIndex;
            const future5m = m5.slice(currM5End + 1, Math.min(currM5End + 288, m5.length));

            for (let m = 0; m < future5m.length - 20; m++) {
                const fc = future5m[m];

                // Retest of 5M refined zone
                if (fc.low <= zone5m.high && fc.close >= zone5m.low) {
                    const entryPrice = zone5m.high;
                    const slPrice = zone5m.low - 0.8;
                    const risk = entryPrice - slPrice;
                    if (risk < 0.8 || risk > 8.0) break;

                    const tp1_3 = entryPrice + (risk * 3.0);
                    const tp1_5 = entryPrice + (risk * 5.0);
                    const tp1H = Math.max(entryPrice + (risk * 3.0), h1Target);

                    const outcome = future5m.slice(m + 1, m + 80);

                    // 1:3 RR
                    for (let c of outcome) {
                        if (c.low <= slPrice) { tradesSniper1_3.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                        if (c.high >= tp1_3) { tradesSniper1_3.push({ type: 'BUY', result: 'WIN', r: 3.0 }); break; }
                    }

                    // 1:5 RR
                    for (let c of outcome) {
                        if (c.low <= slPrice) { tradesSniper1_5.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                        if (c.high >= tp1_5) { tradesSniper1_5.push({ type: 'BUY', result: 'WIN', r: 5.0 }); break; }
                    }

                    // Target 1H Swing High
                    const rMultipleTo1H = ((tp1H - entryPrice) / risk).toFixed(1);
                    for (let c of outcome) {
                        if (c.low <= slPrice) { tradesSniperTo1HTarget.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                        if (c.high >= tp1H) { tradesSniperTo1HTarget.push({ type: 'BUY', result: 'WIN', r: parseFloat(rMultipleTo1H) }); break; }
                    }

                    break;
                }
            }
        }

        // ----------------------------------------------------
        // BEARISH 1H OB (Up candle before aggressive expansion down)
        // ----------------------------------------------------
        if (prev1H.close > prev1H.open && curr1H.close < prev1H.low - 1.0 && (curr1H.high - curr1H.low) > 4.0) {
            const h1High = prev1H.high;
            const h1Low = Math.min(prev1H.open, prev1H.low);
            const h1Target = curr1H.low;
            const h1Range = h1High - h1Low;
            if (h1Range < 2 || h1Range > 30) continue;

            const startTime = prev1H.time;
            const endTime = curr1H.endTime;

            const slice45m = m45.filter(c => c.time >= startTime && c.time <= endTime);
            const zone45m = findRefinedSubZone(slice45m, h1Low, h1High, false);

            const slice30m = m30.filter(c => c.time >= startTime && c.time <= endTime);
            const zone30m = findRefinedSubZone(slice30m, zone45m.low, zone45m.high, false);

            const slice15m = m15.filter(c => c.time >= startTime && c.time <= endTime);
            const zone15m = findRefinedSubZone(slice15m, zone30m.low, zone30m.high, false);

            const slice5m = m5.filter(c => c.time >= startTime && c.time <= endTime);
            const zone5m = findRefinedSubZone(slice5m, zone15m.low, zone15m.high, false);

            refinementStats.push({
                direction: 'BEARISH',
                h1Size: h1Range.toFixed(2),
                m45Size: (zone45m.high - zone45m.low).toFixed(2),
                m30Size: (zone30m.high - zone30m.low).toFixed(2),
                m15Size: (zone15m.high - zone15m.low).toFixed(2),
                m5Size: (zone5m.high - zone5m.low).toFixed(2),
                m5Type: zone5m.type
            });

            const currM5End = curr1H.m5EndIndex;
            const future5m = m5.slice(currM5End + 1, Math.min(currM5End + 288, m5.length));

            for (let m = 0; m < future5m.length - 20; m++) {
                const fc = future5m[m];

                if (fc.high >= zone5m.low && fc.close <= zone5m.high) {
                    const entryPrice = zone5m.low;
                    const slPrice = zone5m.high + 0.8;
                    const risk = slPrice - entryPrice;
                    if (risk < 0.8 || risk > 8.0) break;

                    const tp1_3 = entryPrice - (risk * 3.0);
                    const tp1_5 = entryPrice - (risk * 5.0);
                    const tp1H = Math.min(entryPrice - (risk * 3.0), h1Target);

                    const outcome = future5m.slice(m + 1, m + 80);

                    for (let c of outcome) {
                        if (c.high >= slPrice) { tradesSniper1_3.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                        if (c.low <= tp1_3) { tradesSniper1_3.push({ type: 'SELL', result: 'WIN', r: 3.0 }); break; }
                    }

                    for (let c of outcome) {
                        if (c.high >= slPrice) { tradesSniper1_5.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                        if (c.low <= tp1_5) { tradesSniper1_5.push({ type: 'SELL', result: 'WIN', r: 5.0 }); break; }
                    }

                    const rMultipleTo1H = ((entryPrice - tp1H) / risk).toFixed(1);
                    for (let c of outcome) {
                        if (c.high >= slPrice) { tradesSniperTo1HTarget.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                        if (c.low <= tp1H) { tradesSniperTo1HTarget.push({ type: 'SELL', result: 'WIN', r: parseFloat(rMultipleTo1H) }); break; }
                    }

                    break;
                }
            }
        }
    }

    console.log('\n========================================================================================');
    console.log('CASCADE REFINEMENT: AVERAGE ZONE SIZE REDUCTION ACROSS TIMEFRAMES ($ Risk Size)');
    console.log('========================================================================================');
    const avgH1 = (refinementStats.reduce((a, b) => a + parseFloat(b.h1Size), 0) / refinementStats.length).toFixed(2);
    const avgM45 = (refinementStats.reduce((a, b) => a + parseFloat(b.m45Size), 0) / refinementStats.length).toFixed(2);
    const avgM30 = (refinementStats.reduce((a, b) => a + parseFloat(b.m30Size), 0) / refinementStats.length).toFixed(2);
    const avgM15 = (refinementStats.reduce((a, b) => a + parseFloat(b.m15Size), 0) / refinementStats.length).toFixed(2);
    const avgM5 = (refinementStats.reduce((a, b) => a + parseFloat(b.m5Size), 0) / refinementStats.length).toFixed(2);

    console.log(`1H OB Average Zone:   $${avgH1} (${(parseFloat(avgH1)*10).toFixed(0)} Pips SL)`);
    console.log(`45M Refined Zone:     $${avgM45} (${(parseFloat(avgM45)*10).toFixed(0)} Pips SL)`);
    console.log(`30M Refined Zone:     $${avgM30} (${(parseFloat(avgM30)*10).toFixed(0)} Pips SL)`);
    console.log(`15M Refined Zone:     $${avgM15} (${(parseFloat(avgM15)*10).toFixed(0)} Pips SL)`);
    console.log(`5M Sniper Zone:       $${avgM5} (${(parseFloat(avgM5)*10).toFixed(0)} Pips SL)  <-- ${(100 - (parseFloat(avgM5)/parseFloat(avgH1)*100)).toFixed(0)}% Risk Compression!`);

    console.log('\nSample Cascade Examples (First 5):');
    console.table(refinementStats.slice(0, 5));

    console.log('\n========================================================================================');
    console.log('PERFORMANCE AUDIT ON 5M SNIPER ENTRIES (1H ➔ 45M ➔ 30M ➔ 15M ➔ 5M REFINED POI):');
    console.log('========================================================================================');
    const res1_3 = evaluateSummary('1H ➔ 45M ➔ 30M ➔ 15M ➔ 5M (1:3 R:R)', tradesSniper1_3);
    const res1_5 = evaluateSummary('1H ➔ 45M ➔ 30M ➔ 15M ➔ 5M (1:5 R:R Sniper)', tradesSniper1_5);
    const res1H = evaluateSummary('1H ➔ 45M ➔ 30M ➔ 15M ➔ 5M (Targeting 1H High/Low)', tradesSniperTo1HTarget);
    console.table([res1_3, res1_5, res1H]);
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

runFullStepwiseRefinement();

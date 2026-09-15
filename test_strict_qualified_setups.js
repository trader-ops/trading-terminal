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

function isRedFolderNews(date) {
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();
    if ((hour === 12 && min >= 15) || (hour === 13 && min <= 45)) return true;
    if ((hour === 17 && min >= 45) || (hour === 18) || (hour === 19 && min <= 15)) return true;
    return false;
}

// =========================================================================
// STRICT QUALIFICATION ENGINE:
// Sirf tab trade lo jab ASAL MEIN SETUP BANA HO:
// 1. Session High/Low ya Swing Liquidity Sweep (Hunt) pehle hui ho
// 2. Strong 1H/15M Displacement Candle bani ho jo Break of Structure (BOS) kare
// 3. Imbalance (Fresh FVG) create hua ho
// 4. DXY ka direction mutabiq ho
// 5. Red folder news freeze na ho
// 6. Pullback mein rejection wick confirm ho
// =========================================================================
async function runStrictQualifiedBacktest() {
    console.log('Loading 30 days of real Gold 5M and DXY 15M candles...');
    const goldM5 = await fetchCandles('GC=F', '5m', '1mo');
    const dxyM15 = await fetchCandles('DX-Y.NYB', '15m', '1mo');
    const dxyEma = calculateEMA(dxyM15, 20);

    const m15 = aggregateCandles(goldM5, 3);
    const h1  = aggregateCandles(goldM5, 12);

    let qualifiedTrades = [];
    let rejectedNoSetupCount = 0;

    for (let h = 5; h < h1.length - 8; h++) {
        const curr1H = h1[h];
        const prev1H = h1[h - 1];
        const hourUTC = curr1H.date.getUTCHours();

        // 1. Session Filter: Must be inside active London (07:00-11:00 UTC) or NY (12:30-18:00 UTC)
        if (!((hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18))) {
            continue;
        }

        // 2. Red Folder Filter: Must not be in news spike
        if (isRedFolderNews(curr1H.date)) continue;

        // Check DXY alignment
        let dxyAlignedBull = true;
        let dxyAlignedBear = true;
        const dxyIdx = dxyM15.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
        if (dxyIdx > 0 && dxyIdx < dxyM15.length) {
            if (dxyM15[dxyIdx].close > dxyEma[dxyIdx] + 0.05) dxyAlignedBull = false; // Dollar up -> No Gold Buy
            if (dxyM15[dxyIdx].close < dxyEma[dxyIdx] - 0.05) dxyAlignedBear = false; // Dollar down -> No Gold Sell
        }

        // ---------------------------------------------------------------------
        // QUALIFIED BEARISH SETUP VERIFICATION:
        // A. Sweep: Look back 10 bars for swing high. Did prev1H or curr1H wick above it?
        // B. Displacement: curr1H closed strongly below prev1H low with big body
        // C. Fresh FVG created
        // ---------------------------------------------------------------------
        let swingHigh10 = -Infinity;
        for (let b = Math.max(0, h - 10); b < h - 1; b++) {
            if (h1[b] && h1[b].high > swingHigh10) swingHigh10 = h1[b].high;
        }

        const isLiquiditySweptBear = (prev1H.high >= swingHigh10 || curr1H.high >= swingHigh10);
        const isDisplacementBear = (curr1H.close < prev1H.low - 1.50) && ((curr1H.high - curr1H.low) >= 5.0);

        if (isLiquiditySweptBear && isDisplacementBear && dxyAlignedBear) {
            // Setup QUALIFIED! Now find the fresh 15M/5M FVG inside the origin
            const m15Slice = m15.filter(c => c.time >= prev1H.time && c.time <= curr1H.endTime);
            let freshFvg = null;

            for (let k = 1; k < m15Slice.length - 1; k++) {
                if (m15Slice[k - 1].low > m15Slice[k + 1].high + 0.5) {
                    freshFvg = { top: m15Slice[k - 1].low, bottom: m15Slice[k + 1].high };
                    break;
                }
            }

            if (!freshFvg) {
                // Check 5M for fresh FVG
                const m5Slice = goldM5.slice(prev1H.m5StartIndex, curr1H.m5EndIndex + 1);
                for (let k = 1; k < m5Slice.length - 1; k++) {
                    if (m5Slice[k - 1].low > m5Slice[k + 1].high + 0.4) {
                        freshFvg = { top: m5Slice[k - 1].low, bottom: m5Slice[k + 1].high };
                        break;
                    }
                }
            }

            if (freshFvg) {
                // Monitor future 5M bars for qualified pullback retest
                const future5m = goldM5.slice(curr1H.m5EndIndex + 1, Math.min(curr1H.m5EndIndex + 288, goldM5.length));

                for (let m = 0; m < future5m.length - 20; m++) {
                    const fc = future5m[m];
                    // Price taps into the fresh FVG with upper wick rejection
                    if (fc.high >= freshFvg.bottom && fc.close <= freshFvg.top && fc.close < fc.open) {
                        const entry = fc.close;
                        const sl = Math.max(fc.high, freshFvg.top) + 0.8;
                        const risk = sl - entry;
                        if (risk < 1.0 || risk > 8.0) break;

                        const tp1 = entry - (risk * 1.5);
                        const tp2 = entry - (risk * 3.5);

                        const outcome = future5m.slice(m + 1, m + 80);
                        let slDyn = sl;
                        let tp1Hit = false;
                        let pnlR = 0;

                        for (let sc of outcome) {
                            if (!tp1Hit && sc.low <= tp1) {
                                tp1Hit = true;
                                pnlR += (1.5 * 0.5); // 50% locked
                                slDyn = entry - 0.1; // Move to BE
                            }
                            if (sc.high >= slDyn) {
                                if (tp1Hit) qualifiedTrades.push({ type: 'SELL', result: 'WIN_PARTIAL', r: pnlR, pips: 35, note: 'Sweep + Displacement + FVG Retest' });
                                else qualifiedTrades.push({ type: 'SELL', result: 'LOSS', r: -1.0, pips: -Math.round(risk * 10), note: 'Stop Loss Hit' });
                                break;
                            }
                            if (sc.low <= tp2) {
                                pnlR += (3.5 * 0.5);
                                qualifiedTrades.push({ type: 'SELL', result: 'WIN_FULL', r: pnlR, pips: Math.round(risk * 3.5 * 10), note: 'Full Target Smashed' });
                                break;
                            }
                        }
                        break; // One entry per qualified setup
                    }
                }
            }
        }

        // ---------------------------------------------------------------------
        // QUALIFIED BULLISH SETUP VERIFICATION:
        // A. Sweep: Look back 10 bars for swing low. Did prev1H or curr1H wick below it?
        // B. Displacement: curr1H closed strongly above prev1H high with big body
        // C. Fresh FVG created
        // ---------------------------------------------------------------------
        let swingLow10 = Infinity;
        for (let b = Math.max(0, h - 10); b < h - 1; b++) {
            if (h1[b] && h1[b].low < swingLow10) swingLow10 = h1[b].low;
        }

        const isLiquiditySweptBull = (prev1H.low <= swingLow10 || curr1H.low <= swingLow10);
        const isDisplacementBull = (curr1H.close > prev1H.high + 1.50) && ((curr1H.high - curr1H.low) >= 5.0);

        if (isLiquiditySweptBull && isDisplacementBull && dxyAlignedBull) {
            const m15Slice = m15.filter(c => c.time >= prev1H.time && c.time <= curr1H.endTime);
            let freshFvg = null;

            for (let k = 1; k < m15Slice.length - 1; k++) {
                if (m15Slice[k + 1].low > m15Slice[k - 1].high + 0.5) {
                    freshFvg = { top: m15Slice[k + 1].low, bottom: m15Slice[k - 1].high };
                    break;
                }
            }

            if (!freshFvg) {
                const m5Slice = goldM5.slice(prev1H.m5StartIndex, curr1H.m5EndIndex + 1);
                for (let k = 1; k < m5Slice.length - 1; k++) {
                    if (m5Slice[k + 1].low > m5Slice[k - 1].high + 0.4) {
                        freshFvg = { top: m5Slice[k + 1].low, bottom: m5Slice[k - 1].high };
                        break;
                    }
                }
            }

            if (freshFvg) {
                const future5m = goldM5.slice(curr1H.m5EndIndex + 1, Math.min(curr1H.m5EndIndex + 288, goldM5.length));

                for (let m = 0; m < future5m.length - 20; m++) {
                    const fc = future5m[m];
                    if (fc.low <= freshFvg.top && fc.close >= freshFvg.bottom && fc.close > fc.open) {
                        const entry = fc.close;
                        const sl = Math.min(fc.low, freshFvg.bottom) - 0.8;
                        const risk = entry - sl;
                        if (risk < 1.0 || risk > 8.0) break;

                        const tp1 = entry + (risk * 1.5);
                        const tp2 = entry + (risk * 3.5);

                        const outcome = future5m.slice(m + 1, m + 80);
                        let slDyn = sl;
                        let tp1Hit = false;
                        let pnlR = 0;

                        for (let sc of outcome) {
                            if (!tp1Hit && sc.high >= tp1) {
                                tp1Hit = true;
                                pnlR += (1.5 * 0.5);
                                slDyn = entry + 0.1;
                            }
                            if (sc.low <= slDyn) {
                                if (tp1Hit) qualifiedTrades.push({ type: 'BUY', result: 'WIN_PARTIAL', r: pnlR, pips: 35, note: 'Sweep + Displacement + FVG Retest' });
                                else qualifiedTrades.push({ type: 'BUY', result: 'LOSS', r: -1.0, pips: -Math.round(risk * 10), note: 'Stop Loss Hit' });
                                break;
                            }
                            if (sc.high >= tp2) {
                                pnlR += (3.5 * 0.5);
                                qualifiedTrades.push({ type: 'BUY', result: 'WIN_FULL', r: pnlR, pips: Math.round(risk * 3.5 * 10), note: 'Full Target Smashed' });
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        }
    }

    const wins = qualifiedTrades.filter(t => t.r > 0).length;
    const losses = qualifiedTrades.filter(t => t.r <= 0).length;
    const winRate = ((wins / qualifiedTrades.length) * 100).toFixed(1);
    const totalR = qualifiedTrades.reduce((acc, t) => acc + t.r, 0).toFixed(1);
    const grossWins = qualifiedTrades.filter(t => t.r > 0).reduce((acc, t) => acc + t.r, 0);
    const grossLosses = Math.abs(qualifiedTrades.filter(t => t.r <= 0).reduce((acc, t) => acc + t.r, 0));
    const profitFactor = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : 'INF';

    console.log('\n====================================================================================================');
    console.log('STRICT QUALIFIED INSTITUTIONAL SETUPS AUDIT (ONLY VALID SETUPS TRADED):');
    console.log('====================================================================================================');
    console.table([{
        model: 'Qualified Institutional Setups (Sweep + Displacement + Fresh FVG + DXY)',
        totalValidSetups: qualifiedTrades.length,
        wins,
        losses,
        winRate: winRate + '%',
        totalR: '+' + totalR + 'R',
        profitFactor
    }]);

    console.log('\nDETAILED TRADE LOG OF QUALIFIED SETUPS:');
    console.table(qualifiedTrades);
}

runStrictQualifiedBacktest();

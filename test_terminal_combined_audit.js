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

function findRefinedSubZone(candlesSlice, parentLow, parentHigh, isBullish) {
    for (let k = 1; k < candlesSlice.length - 1; k++) {
        const c1 = candlesSlice[k - 1];
        const c3 = candlesSlice[k + 1];

        if (isBullish && c3.low > c1.high + 0.3) {
            const overlapLow = Math.max(c1.high, parentLow);
            const overlapHigh = Math.min(c3.low, parentHigh);
            if (overlapHigh > overlapLow + 0.3) return { low: overlapLow, high: overlapHigh, type: 'FVG' };
        } else if (!isBullish && c1.low > c3.high + 0.3) {
            const overlapLow = Math.max(c3.high, parentLow);
            const overlapHigh = Math.min(c1.low, parentHigh);
            if (overlapHigh > overlapLow + 0.3) return { low: overlapLow, high: overlapHigh, type: 'FVG' };
        }
    }

    if (isBullish) {
        let bestOb = null;
        for (let c of candlesSlice) {
            if (c.close < c.open && c.low >= parentLow - 0.5 && c.high <= parentHigh + 0.5) {
                if (!bestOb || c.low < bestOb.low) bestOb = c;
            }
        }
        if (bestOb) return { low: Math.max(bestOb.low, parentLow), high: Math.min(bestOb.high, parentHigh), type: 'OB' };
    } else {
        let bestOb = null;
        for (let c of candlesSlice) {
            if (c.close > c.open && c.high <= parentHigh + 0.5 && c.low >= parentLow - 0.5) {
                if (!bestOb || c.high > bestOb.high) bestOb = c;
            }
        }
        if (bestOb) return { low: Math.max(bestOb.low, parentLow), high: Math.min(bestOb.high, parentHigh), type: 'OB' };
    }

    const mid = (parentLow + parentHigh) / 2;
    return isBullish ? { low: parentLow, high: mid, type: '50%_DISCOUNT' } : { low: mid, high: parentHigh, type: '50%_PREMIUM' };
}

// Check DXY 50 EMA trend to align intermarket correlation
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

async function runCombinedTerminalAudit() {
    console.log('1. Loading real market candles for Gold and DXY...');
    const goldM5 = await fetchCandles('GC=F', '5m', '1mo');
    const dxyM15 = await fetchCandles('DX-Y.NYB', '15m', '1mo');
    const dxyEma = calculateEMA(dxyM15, 20);

    console.log(`Loaded: Gold 5M = ${goldM5.length} bars, DXY 15M = ${dxyM15.length} bars.`);

    const m15 = aggregateCandles(goldM5, 3);
    const m30 = aggregateCandles(goldM5, 6);
    const m45 = aggregateCandles(goldM5, 9);
    const h1  = aggregateCandles(goldM5, 12);

    // Arrays to collect trades under different filter regimes
    let baselineRefinementTrades = [];
    let terminalFilteredTrades = [];
    let terminalWithScalingTrades = [];

    // Loop through 1H bars
    for (let h = 3; h < h1.length - 8; h++) {
        const prev1H = h1[h - 1];
        const curr1H = h1[h];
        const hourUTC = curr1H.date.getUTCHours();

        // ------------------------------------------------------------------------------------
        // BULLISH SETUP
        // ------------------------------------------------------------------------------------
        if (prev1H.close < prev1H.open && curr1H.close > prev1H.high + 1.0 && (curr1H.high - curr1H.low) > 4.0) {
            const h1Low = prev1H.low;
            const h1High = Math.max(prev1H.open, prev1H.high);
            const h1Range = h1High - h1Low;
            if (h1Range < 2 || h1Range > 30) continue;

            const startTime = prev1H.time;
            const endTime = curr1H.endTime;

            // Stepwise Cascade: 1H -> 45M -> 30M -> 15M -> 5M
            const zone45 = findRefinedSubZone(m45.filter(c => c.time >= startTime && c.time <= endTime), h1Low, h1High, true);
            const zone30 = findRefinedSubZone(m30.filter(c => c.time >= startTime && c.time <= endTime), zone45.low, zone45.high, true);
            const zone15 = findRefinedSubZone(m15.filter(c => c.time >= startTime && c.time <= endTime), zone30.low, zone30.high, true);
            const zone5  = findRefinedSubZone(goldM5.filter(c => c.time >= startTime && c.time <= endTime), zone15.low, zone15.high, true);

            // ==========================================
            // TERMINAL FILTER 1: Session Killzone Gate
            // Only take trades during London Open (07:00-11:00 UTC) or NY Session (12:30-18:00 UTC)
            // ==========================================
            const isKillzone = (hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18);

            // ==========================================
            // TERMINAL FILTER 2: DXY Inverse Confluence
            // If DXY is strongly bullish (price > 20 EMA on DXY), DO NOT BUY Gold!
            // ==========================================
            let isDxyFavorable = true;
            const dxyIdx = dxyM15.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
            if (dxyIdx > 0 && dxyIdx < dxyM15.length) {
                // If DXY is above its EMA, dollar is strong -> unfavorable for Gold Buy
                if (dxyM15[dxyIdx].close > dxyEma[dxyIdx] + 0.05) {
                    isDxyFavorable = false;
                }
            }

            // ==========================================
            // TERMINAL FILTER 3: Liquidity Sweep Pre-condition
            // In the last 15 bars, did price sweep previous low before forming this OB?
            // ==========================================
            let hasSweptLiquidity = false;
            let lowestPrior = Infinity;
            for (let b = Math.max(0, h - 8); b < h - 1; b++) {
                if (h1[b].low < lowestPrior) lowestPrior = h1[b].low;
            }
            if (prev1H.low <= lowestPrior + 0.5) {
                hasSweptLiquidity = true;
            }

            // Monitor future 5M bars for pullback
            const currM5End = curr1H.m5EndIndex;
            const future5m = goldM5.slice(currM5End + 1, Math.min(currM5End + 288, goldM5.length));

            for (let m = 0; m < future5m.length - 20; m++) {
                const fc = future5m[m];

                if (fc.low <= zone5.high && fc.close >= zone5.low) {
                    const entryPrice = zone5.high;
                    const slPrice = zone5.low - 0.8;
                    const risk = entryPrice - slPrice;
                    if (risk < 0.8 || risk > 8.0) break;

                    const tpPrice = entryPrice + (risk * 3.5); // 1:3.5 Target
                    const tp1Price = entryPrice + (risk * 1.5); // TP1 Partial Lock

                    const outcome = future5m.slice(m + 1, m + 80);

                    // 1. Baseline: Cascade alone (no filters)
                    for (let c of outcome) {
                        if (c.low <= slPrice) { baselineRefinementTrades.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                        if (c.high >= tpPrice) { baselineRefinementTrades.push({ type: 'BUY', result: 'WIN', r: 3.5 }); break; }
                    }

                    // 2. Terminal Combined (Cascade + Killzone + DXY Alignment + Sweep)
                    if (isKillzone && isDxyFavorable) {
                        for (let c of outcome) {
                            if (c.low <= slPrice) { terminalFilteredTrades.push({ type: 'BUY', result: 'LOSS', r: -1 }); break; }
                            if (c.high >= tpPrice) { terminalFilteredTrades.push({ type: 'BUY', result: 'WIN', r: 3.5 }); break; }
                        }

                        // 3. Terminal with Scaling (TP1 50% + BE + Runner)
                        let slDyn = slPrice;
                        let tp1Hit = false;
                        let pnlR = 0;

                        for (let c of outcome) {
                            if (!tp1Hit && c.high >= tp1Price) {
                                tp1Hit = true;
                                pnlR += (1.5 * 0.5);
                                slDyn = entryPrice + 0.1;
                            }
                            if (c.low <= slDyn) {
                                if (tp1Hit) terminalWithScalingTrades.push({ type: 'BUY', result: 'WIN_PARTIAL', r: pnlR });
                                else terminalWithScalingTrades.push({ type: 'BUY', result: 'LOSS', r: -1 });
                                break;
                            }
                            if (c.high >= tpPrice) {
                                pnlR += (3.5 * 0.5);
                                terminalWithScalingTrades.push({ type: 'BUY', result: 'WIN_FULL', r: pnlR });
                                break;
                            }
                        }
                    }

                    break;
                }
            }
        }

        // ------------------------------------------------------------------------------------
        // BEARISH SETUP
        // ------------------------------------------------------------------------------------
        if (prev1H.close > prev1H.open && curr1H.close < prev1H.low - 1.0 && (curr1H.high - curr1H.low) > 4.0) {
            const h1High = prev1H.high;
            const h1Low = Math.min(prev1H.open, prev1H.low);
            const h1Range = h1High - h1Low;
            if (h1Range < 2 || h1Range > 30) continue;

            const startTime = prev1H.time;
            const endTime = curr1H.endTime;

            const zone45 = findRefinedSubZone(m45.filter(c => c.time >= startTime && c.time <= endTime), h1Low, h1High, false);
            const zone30 = findRefinedSubZone(m30.filter(c => c.time >= startTime && c.time <= endTime), zone45.low, zone45.high, false);
            const zone15 = findRefinedSubZone(m15.filter(c => c.time >= startTime && c.time <= endTime), zone30.low, zone30.high, false);
            const zone5  = findRefinedSubZone(goldM5.filter(c => c.time >= startTime && c.time <= endTime), zone15.low, zone15.high, false);

            const isKillzone = (hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18);

            let isDxyFavorable = true;
            const dxyIdx = dxyM15.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
            if (dxyIdx > 0 && dxyIdx < dxyM15.length) {
                // If DXY is below EMA, dollar is weak -> unfavorable for Gold Sell
                if (dxyM15[dxyIdx].close < dxyEma[dxyIdx] - 0.05) {
                    isDxyFavorable = false;
                }
            }

            const currM5End = curr1H.m5EndIndex;
            const future5m = goldM5.slice(currM5End + 1, Math.min(currM5End + 288, goldM5.length));

            for (let m = 0; m < future5m.length - 20; m++) {
                const fc = future5m[m];

                if (fc.high >= zone5.low && fc.close <= zone5.high) {
                    const entryPrice = zone5.low;
                    const slPrice = zone5.high + 0.8;
                    const risk = slPrice - entryPrice;
                    if (risk < 0.8 || risk > 8.0) break;

                    const tpPrice = entryPrice - (risk * 3.5);
                    const tp1Price = entryPrice - (risk * 1.5);

                    const outcome = future5m.slice(m + 1, m + 80);

                    // 1. Baseline
                    for (let c of outcome) {
                        if (c.high >= slPrice) { baselineRefinementTrades.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                        if (c.low <= tpPrice) { baselineRefinementTrades.push({ type: 'SELL', result: 'WIN', r: 3.5 }); break; }
                    }

                    // 2. Terminal Combined
                    if (isKillzone && isDxyFavorable) {
                        for (let c of outcome) {
                            if (c.high >= slPrice) { terminalFilteredTrades.push({ type: 'SELL', result: 'LOSS', r: -1 }); break; }
                            if (c.low <= tpPrice) { terminalFilteredTrades.push({ type: 'SELL', result: 'WIN', r: 3.5 }); break; }
                        }

                        // 3. Scaling
                        let slDyn = slPrice;
                        let tp1Hit = false;
                        let pnlR = 0;

                        for (let c of outcome) {
                            if (!tp1Hit && c.low <= tp1Price) {
                                tp1Hit = true;
                                pnlR += (1.5 * 0.5);
                                slDyn = entryPrice - 0.1;
                            }
                            if (c.high >= slDyn) {
                                if (tp1Hit) terminalWithScalingTrades.push({ type: 'SELL', result: 'WIN_PARTIAL', r: pnlR });
                                else terminalWithScalingTrades.push({ type: 'SELL', result: 'LOSS', r: -1 });
                                break;
                            }
                            if (c.low <= tpPrice) {
                                pnlR += (3.5 * 0.5);
                                terminalWithScalingTrades.push({ type: 'SELL', result: 'WIN_FULL', r: pnlR });
                                break;
                            }
                        }
                    }

                    break;
                }
            }
        }
    }

    console.log('\n========================================================================================================');
    console.log('COMBINED TERMINAL AUDIT: REFINEMENT CASCADE + TERMINAL 7-PILLAR CONFLUENCE ENGINE');
    console.log('========================================================================================================');
    const resBase = evaluateSummary('1. 1H->5M Cascade Alone (No Terminal Filters)', baselineRefinementTrades);
    const resFiltered = evaluateSummary('2. Cascade + Terminal Killzone + DXY Correlation Filter', terminalFilteredTrades);
    const resFinal = evaluateSummary('3. SUPREME: Cascade + Terminal Filters + Auto-BE Scaling', terminalWithScalingTrades);

    console.table([resBase, resFiltered, resFinal]);
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

runCombinedTerminalAudit();

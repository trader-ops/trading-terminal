const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'historical_candles_xauusd_dxy_60d.json');
const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const allGold5m = raw.gold5m;
const allDxy15m = raw.dxy15m;

const startTime = allGold5m[0].time;
const endTime = allGold5m[allGold5m.length - 1].time;
const midTime = startTime + (endTime - startTime) / 2;

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
            iso: slice[0].iso,
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

function calculateATR(candles, period = 14) {
    const atr = [];
    const trList = [];
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (i === 0) {
            trList.push(c.high - c.low);
        } else {
            const prevClose = candles[i - 1].close;
            const tr = Math.max(
                c.high - c.low,
                Math.abs(c.high - prevClose),
                Math.abs(c.low - prevClose)
            );
            trList.push(tr);
        }
    }
    // Initial SMA of TR
    let sum = 0;
    for (let i = 0; i < Math.min(period, trList.length); i++) sum += trList[i];
    let prevAtr = sum / Math.min(period, trList.length);
    for (let i = 0; i < period; i++) atr.push(prevAtr);
    // Wilder / EMA smoothing
    for (let i = period; i < trList.length; i++) {
        prevAtr = (prevAtr * (period - 1) + trList[i]) / period;
        atr.push(prevAtr);
    }
    return atr;
}

function isRedFolderNewsWindow(date) {
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();
    if ((hour === 12 && min >= 15) || (hour === 13 && min <= 45)) return true;
    if ((hour === 17 && min >= 45) || (hour === 18) || (hour === 19 && min <= 15)) return true;
    return false;
}

// Global aggregations
const fullM15 = aggregateCandles(allGold5m, 3);
const fullH1  = aggregateCandles(allGold5m, 12);
const fullH4  = aggregateCandles(allGold5m, 48); // 48 x 5m = 4 Hours
const fullDxyEma = calculateEMA(allDxy15m, 20);
const fullH4Ema  = calculateEMA(fullH4, 20);    // 4H 20 EMA
const fullH1Atr  = calculateATR(fullH1, 14);    // 1H 14 ATR

console.log(`Global Series Built: 4H Bars = ${fullH4.length} | 1H Bars = ${fullH1.length} | 1H ATR Range: min $${Math.min(...fullH1Atr).toFixed(2)}, max $${Math.max(...fullH1Atr).toFixed(2)}, avg $${(fullH1Atr.reduce((a,b)=>a+b,0)/fullH1Atr.length).toFixed(2)}`);

function runSimulation(enableHypothesis1 = false) {
    const supremeTrades = [];
    const scalpTrades = [];
    let supremeActivePositionUntil = 0;
    let scalpActivePositionUntil = 0;

    const spreadDollars = 0.20;
    const slippageDollars = 0.10;
    const commissionUsd = 0.07;
    const fvgGapThreshold = 0.25;
    const slBuffer = 0.70;

    for (let h = 5; h < fullH1.length - 8; h++) {
        const curr1H = fullH1[h];
        const prev1H = fullH1[h - 1];
        const dt = new Date(curr1H.time);
        const hourUTC = dt.getUTCHours();

        if (!((hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18))) continue;
        if (isRedFolderNewsWindow(dt)) continue;

        // DXY Check
        let dxyAlignedBull = true;
        let dxyAlignedBear = true;
        const dxyIdx = allDxy15m.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
        if (dxyIdx >= 0 && dxyIdx < allDxy15m.length) {
            if (allDxy15m[dxyIdx].close > fullDxyEma[dxyIdx] + 0.05) dxyAlignedBull = false;
            if (allDxy15m[dxyIdx].close < fullDxyEma[dxyIdx] - 0.05) dxyAlignedBear = false;
        }

        // HYPOTHESIS 1: 4-Hour Trend Anchor
        let h4TrendBull = true;
        let h4TrendBear = true;
        let displacementMin = 3.50; // default baseline

        if (enableHypothesis1) {
            // Find 4H bar matching this timestamp
            const h4Idx = fullH4.findIndex(c => curr1H.time >= c.time && curr1H.time <= c.endTime);
            if (h4Idx >= 0 && h4Idx < fullH4.length) {
                const h4Candle = fullH4[h4Idx];
                const h4EmaVal = fullH4Ema[h4Idx];
                // Rule: Only allow BUY setups if 4H close > 4H 20 EMA. Only allow SELL if 4H close < 4H 20 EMA.
                h4TrendBull = (h4Candle.close > h4EmaVal);
                h4TrendBear = (h4Candle.close < h4EmaVal);
            }

            // Volatility-adjusted displacement threshold: minimum 50% of 1H 14-ATR, floor at $9.00
            const current1HAtr = fullH1Atr[h] || 12.0;
            displacementMin = Math.max(9.00, 0.50 * current1HAtr);
        }

        // Bearish Supreme Check
        if (curr1H.close < prev1H.low && (curr1H.high - curr1H.low) >= displacementMin && dxyAlignedBear && h4TrendBear) {
            const m5Slice = allGold5m.slice(prev1H.m5StartIndex, curr1H.m5EndIndex + 1);
            let freshFvg = null;
            for (let k = 1; k < m5Slice.length - 1; k++) {
                if (m5Slice[k - 1].low > m5Slice[k + 1].high + fvgGapThreshold) {
                    freshFvg = { top: m5Slice[k - 1].low, bottom: m5Slice[k + 1].high };
                    break;
                }
            }

            if (freshFvg) {
                const futureBars = allGold5m.slice(curr1H.m5EndIndex + 1, Math.min(curr1H.m5EndIndex + 144, allGold5m.length));
                for (let m = 0; m < futureBars.length - 10; m++) {
                    const fc = futureBars[m];
                    if (fc.high >= freshFvg.bottom && fc.close <= freshFvg.top && fc.close < fc.open) {
                        const execBarIndex = m + 1;
                        const execBar = futureBars[execBarIndex];
                        if (!execBar) break;

                        if (execBar.time < supremeActivePositionUntil) continue;

                        const fillEntry = +(execBar.open - slippageDollars).toFixed(2);
                        const slPrice = +(Math.max(fc.high, freshFvg.top) + slBuffer).toFixed(2);
                        const risk = slPrice - fillEntry;
                        const riskPips = Math.round(risk * 10);
                        if (riskPips < 10 || riskPips > 45) break;

                        const tp1Price = +(fillEntry - (risk * 1.5)).toFixed(2);
                        const tp2Price = +(fillEntry - (risk * 3.5)).toFixed(2);

                        const outcome = futureBars.slice(execBarIndex + 1, execBarIndex + 61);
                        let slDyn = slPrice;
                        let tp1Hit = false;
                        let rawPnlR = -1.0;
                        let exitReason = 'SL_HIT';
                        let exitPrice = slPrice;
                        let exitTime = execBar.iso;
                        let exitTimeMs = execBar.time;

                        for (let oc of outcome) {
                            const effectiveAskHigh = +(oc.high + spreadDollars).toFixed(2);
                            const effectiveAskLow = +(oc.low + spreadDollars).toFixed(2);

                            if (!tp1Hit && effectiveAskLow <= tp1Price) {
                                tp1Hit = true;
                                slDyn = fillEntry;
                                rawPnlR = 0.75;
                                exitReason = 'TP1_PARTIAL_BE';
                                exitPrice = tp1Price;
                                exitTime = oc.iso;
                                exitTimeMs = oc.time;
                            }
                            if (effectiveAskHigh >= slDyn) {
                                if (!tp1Hit) {
                                    rawPnlR = -1.0;
                                    exitReason = 'SL_HIT';
                                    exitPrice = slDyn;
                                    exitTime = oc.iso;
                                    exitTimeMs = oc.time;
                                }
                                break;
                            }
                            if (effectiveAskLow <= tp2Price) {
                                rawPnlR = 2.50;
                                exitReason = 'TP2_FULL_TARGET';
                                exitPrice = tp2Price;
                                exitTime = oc.iso;
                                exitTimeMs = oc.time;
                                break;
                            }
                        }

                        supremeActivePositionUntil = exitTimeMs;
                        const dollarRisk = 10.0;
                        const pnlUsd = (rawPnlR * dollarRisk) - commissionUsd;
                        const normalizedNetR = pnlUsd / 10.0;

                        supremeTrades.push({
                            track: 'SUPREME',
                            id: supremeTrades.length + 1,
                            entryTimeMs: execBar.time,
                            time: execBar.iso,
                            side: 'SELL',
                            entry: fillEntry.toFixed(2),
                            sl: slPrice.toFixed(2),
                            tp1: tp1Price.toFixed(2),
                            tp2: tp2Price.toFixed(2),
                            riskPips,
                            exitReason,
                            exitPrice: exitPrice.toFixed(2),
                            exitTime,
                            pnlR: normalizedNetR.toFixed(2),
                            pnlUsd: pnlUsd.toFixed(2),
                            confluence: enableHypothesis1 ? '4H_ANCHOR+ATR_DISPLACEMENT' : 'BASELINE'
                        });
                        break;
                    }
                }
            }
        }

        // Bullish Supreme Check
        if (curr1H.close > prev1H.high && (curr1H.high - curr1H.low) >= displacementMin && dxyAlignedBull && h4TrendBull) {
            const m5Slice = allGold5m.slice(prev1H.m5StartIndex, curr1H.m5EndIndex + 1);
            let freshFvg = null;
            for (let k = 1; k < m5Slice.length - 1; k++) {
                if (m5Slice[k + 1].low > m5Slice[k - 1].high + fvgGapThreshold) {
                    freshFvg = { top: m5Slice[k + 1].low, bottom: m5Slice[k - 1].high };
                    break;
                }
            }

            if (freshFvg) {
                const futureBars = allGold5m.slice(curr1H.m5EndIndex + 1, Math.min(curr1H.m5EndIndex + 144, allGold5m.length));
                for (let m = 0; m < futureBars.length - 10; m++) {
                    const fc = futureBars[m];
                    if (fc.low <= freshFvg.top && fc.close >= freshFvg.bottom && fc.close > fc.open) {
                        const execBarIndex = m + 1;
                        const execBar = futureBars[execBarIndex];
                        if (!execBar) break;

                        if (execBar.time < supremeActivePositionUntil) continue;

                        const fillEntry = +(execBar.open + spreadDollars + slippageDollars).toFixed(2);
                        const slPrice = +(Math.min(fc.low, freshFvg.bottom) - slBuffer).toFixed(2);
                        const risk = fillEntry - slPrice;
                        const riskPips = Math.round(risk * 10);
                        if (riskPips < 10 || riskPips > 45) break;

                        const tp1Price = +(fillEntry + (risk * 1.5)).toFixed(2);
                        const tp2Price = +(fillEntry + (risk * 3.5)).toFixed(2);

                        const outcome = futureBars.slice(execBarIndex + 1, execBarIndex + 61);
                        let slDyn = slPrice;
                        let tp1Hit = false;
                        let rawPnlR = -1.0;
                        let exitReason = 'SL_HIT';
                        let exitPrice = slPrice;
                        let exitTime = execBar.iso;
                        let exitTimeMs = execBar.time;

                        for (let oc of outcome) {
                            if (!tp1Hit && oc.high >= tp1Price) {
                                tp1Hit = true;
                                slDyn = fillEntry;
                                rawPnlR = 0.75;
                                exitReason = 'TP1_PARTIAL_BE';
                                exitPrice = tp1Price;
                                exitTime = oc.iso;
                                exitTimeMs = oc.time;
                            }
                            if (oc.low <= slDyn) {
                                if (!tp1Hit) {
                                    rawPnlR = -1.0;
                                    exitReason = 'SL_HIT';
                                    exitPrice = slDyn;
                                    exitTime = oc.iso;
                                    exitTimeMs = oc.time;
                                }
                                break;
                            }
                            if (oc.high >= tp2Price) {
                                rawPnlR = 2.50;
                                exitReason = 'TP2_FULL_TARGET';
                                exitPrice = tp2Price;
                                exitTime = oc.iso;
                                exitTimeMs = oc.time;
                                break;
                            }
                        }

                        supremeActivePositionUntil = exitTimeMs;
                        const dollarRisk = 10.0;
                        const pnlUsd = (rawPnlR * dollarRisk) - commissionUsd;
                        const normalizedNetR = pnlUsd / 10.0;

                        supremeTrades.push({
                            track: 'SUPREME',
                            id: supremeTrades.length + 1,
                            entryTimeMs: execBar.time,
                            time: execBar.iso,
                            side: 'BUY',
                            entry: fillEntry.toFixed(2),
                            sl: slPrice.toFixed(2),
                            tp1: tp1Price.toFixed(2),
                            tp2: tp2Price.toFixed(2),
                            riskPips,
                            exitReason,
                            exitPrice: exitPrice.toFixed(2),
                            exitTime,
                            pnlR: normalizedNetR.toFixed(2),
                            pnlUsd: pnlUsd.toFixed(2),
                            confluence: enableHypothesis1 ? '4H_ANCHOR+ATR_DISPLACEMENT' : 'BASELINE'
                        });
                        break;
                    }
                }
            }
        }
    }

    // Track 2: Scalps (also filter by 4H Trend Anchor if Hypothesis 1 enabled)
    for (let i = 12; i < fullM15.length - 16; i += 4) {
        const boxSlice = fullM15.slice(i - 12, i);
        let boxHigh = -Infinity;
        let boxLow = Infinity;
        for (let b of boxSlice) {
            if (b.high > boxHigh) boxHigh = b.high;
            if (b.low < boxLow) boxLow = b.low;
        }
        const boxSpan = boxHigh - boxLow;
        if (boxSpan < 4.0 || boxSpan > 14.0) continue;

        const eq = +( (boxHigh + boxLow) / 2 ).toFixed(2);
        const subBars = allGold5m.slice(fullM15[i].m5StartIndex, Math.min(fullM15[i].m5StartIndex + 16, allGold5m.length));

        // 4H check for scalps
        let h4TrendBull = true;
        let h4TrendBear = true;
        if (enableHypothesis1) {
            const h4Idx = fullH4.findIndex(c => fullM15[i].time >= c.time && fullM15[i].time <= c.endTime);
            if (h4Idx >= 0 && h4Idx < fullH4.length) {
                h4TrendBull = (fullH4[h4Idx].close > fullH4Ema[h4Idx]);
                h4TrendBear = (fullH4[h4Idx].close < fullH4Ema[h4Idx]);
            }
        }

        for (let j = 0; j < subBars.length - 4; j++) {
            const bar = subBars[j];
            // Upper Sweep Short
            if (bar.high >= boxHigh - 0.60 && bar.close < bar.open && bar.close < boxHigh - 0.80 && h4TrendBear) {
                const execBarIndex = j + 1;
                const execBar = subBars[execBarIndex];
                if (!execBar) break;

                if (execBar.time < scalpActivePositionUntil) continue;

                const fillEntry = +(execBar.open - slippageDollars).toFixed(2);
                const sl = +(boxHigh + 1.20).toFixed(2);
                const tp = eq;
                const risk = sl - fillEntry;
                const riskPips = Math.round(risk * 10);
                if (riskPips >= 12 && riskPips <= 35) {
                    const outcome = subBars.slice(execBarIndex + 1);
                    let rawPnlR = -1.0;
                    let exitReason = 'SL_HIT';
                    let exitPrice = sl;
                    let exitTime = execBar.iso;
                    let exitTimeMs = execBar.time;

                    for (let sc of outcome) {
                        const effectiveAskHigh = +(sc.high + spreadDollars).toFixed(2);
                        const effectiveAskLow = +(sc.low + spreadDollars).toFixed(2);

                        if (effectiveAskHigh >= sl) {
                            rawPnlR = -1.0;
                            exitReason = 'SL_HIT';
                            exitPrice = sl;
                            exitTime = sc.iso;
                            exitTimeMs = sc.time;
                            break;
                        }
                        if (effectiveAskLow <= tp) {
                            rawPnlR = 1.20;
                            exitReason = 'TP_EQUILIBRIUM';
                            exitPrice = tp;
                            exitTime = sc.iso;
                            exitTimeMs = sc.time;
                            break;
                        }
                    }

                    scalpActivePositionUntil = exitTimeMs;
                    const dollarRisk = 5.0;
                    const pnlUsd = (rawPnlR * dollarRisk) - commissionUsd;
                    const normalizedNetR = pnlUsd / 10.0;

                    scalpTrades.push({
                        track: 'SCALP',
                        id: scalpTrades.length + 1,
                        entryTimeMs: execBar.time,
                        time: execBar.iso,
                        side: 'SELL',
                        entry: fillEntry.toFixed(2),
                        sl: sl.toFixed(2),
                        tp1: tp.toFixed(2),
                        tp2: tp.toFixed(2),
                        riskPips,
                        exitReason,
                        exitPrice: exitPrice.toFixed(2),
                        exitTime,
                        pnlR: normalizedNetR.toFixed(2),
                        pnlUsd: pnlUsd.toFixed(2),
                        confluence: enableHypothesis1 ? '4H_ANCHOR' : 'BASELINE'
                    });
                    break;
                }
            }

            // Lower Sweep Long
            if (bar.low <= boxLow + 0.60 && bar.close > bar.open && bar.close > boxLow + 0.80 && h4TrendBull) {
                const execBarIndex = j + 1;
                const execBar = subBars[execBarIndex];
                if (!execBar) break;

                if (execBar.time < scalpActivePositionUntil) continue;

                const fillEntry = +(execBar.open + spreadDollars + slippageDollars).toFixed(2);
                const sl = +(boxLow - 1.20).toFixed(2);
                const tp = eq;
                const risk = fillEntry - sl;
                const riskPips = Math.round(risk * 10);
                if (riskPips >= 12 && riskPips <= 35) {
                    const outcome = subBars.slice(execBarIndex + 1);
                    let rawPnlR = -1.0;
                    let exitReason = 'SL_HIT';
                    let exitPrice = sl;
                    let exitTime = execBar.iso;
                    let exitTimeMs = execBar.time;

                    for (let sc of outcome) {
                        if (sc.low <= sl) {
                            rawPnlR = -1.0;
                            exitReason = 'SL_HIT';
                            exitPrice = sl;
                            exitTime = sc.iso;
                            exitTimeMs = sc.time;
                            break;
                        }
                        if (sc.high >= tp) {
                            rawPnlR = 1.20;
                            exitReason = 'TP_EQUILIBRIUM';
                            exitPrice = tp;
                            exitTime = sc.iso;
                            exitTimeMs = sc.time;
                            break;
                        }
                    }

                    scalpActivePositionUntil = exitTimeMs;
                    const dollarRisk = 5.0;
                    const pnlUsd = (rawPnlR * dollarRisk) - commissionUsd;
                    const normalizedNetR = pnlUsd / 10.0;

                    scalpTrades.push({
                        track: 'SCALP',
                        id: scalpTrades.length + 1,
                        entryTimeMs: execBar.time,
                        time: execBar.iso,
                        side: 'BUY',
                        entry: fillEntry.toFixed(2),
                        sl: sl.toFixed(2),
                        tp1: tp.toFixed(2),
                        tp2: tp.toFixed(2),
                        riskPips,
                        exitReason,
                        exitPrice: exitPrice.toFixed(2),
                        exitTime,
                        pnlR: normalizedNetR.toFixed(2),
                        pnlUsd: pnlUsd.toFixed(2),
                        confluence: enableHypothesis1 ? '4H_ANCHOR' : 'BASELINE'
                    });
                    break;
                }
            }
        }
    }

    const all = [...supremeTrades, ...scalpTrades].sort((a,b) => a.entryTimeMs - b.entryTimeMs);
    return all;
}

function summarize(name, list) {
    const wins = list.filter(t => parseFloat(t.pnlUsd) > 0);
    const losses = list.filter(t => parseFloat(t.pnlUsd) <= 0);
    const totalR = list.reduce((acc, t) => acc + parseFloat(t.pnlR), 0);
    const totalUsd = list.reduce((acc, t) => acc + parseFloat(t.pnlUsd), 0);
    const grossWinsUsd = wins.reduce((acc, t) => acc + parseFloat(t.pnlUsd), 0);
    const grossLossesUsd = Math.abs(losses.reduce((acc, t) => acc + parseFloat(t.pnlUsd), 0));
    const profitFactor = grossLossesUsd > 0 ? (grossWinsUsd / grossLossesUsd).toFixed(2) : 'INF';
    const winRate = list.length ? ((wins.length / list.length) * 100).toFixed(1) + '%' : '0%';

    return {
        Configuration: name,
        Trades: list.length,
        Wins: wins.length,
        Losses: losses.length,
        WinRate: winRate,
        NormalizedNetR: (totalR >= 0 ? '+' : '') + totalR.toFixed(2) + 'R',
        NetUsd: (totalUsd >= 0 ? '+$' : '-$') + Math.abs(totalUsd).toFixed(2),
        ProfitFactor: profitFactor
    };
}

// 1. Run Baseline on Full Data, then extract Train
const baselineAll = runSimulation(false);
const baselineTrain = baselineAll.filter(t => t.entryTimeMs <= midTime);

// 2. Run Hypothesis 1 on Full Data, then extract Train
const hyp1All = runSimulation(true);
const hyp1Train = hyp1All.filter(t => t.entryTimeMs <= midTime);

console.log(`\n================================================================================`);
console.log(`IN-SAMPLE (TRAIN DATASET) HYPOTHESIS 1 EVALUATION:`);
console.log(`================================================================================`);
console.table([
    summarize('1. Train Baseline (No 4H Filter, $3.50 Fixed Disp)', baselineTrain),
    summarize('2. Train Hypothesis 1 (4H 20-EMA Anchor + Dynamic ATR Disp)', hyp1Train)
]);

console.log('\nTRAIN HYPOTHESIS 1 TRADE LOG:');
console.table(hyp1Train);

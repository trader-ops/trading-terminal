const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'historical_candles_xauusd_dxy_60d.json');
const CSV_TRAIN = path.join(__dirname, 'data', 'trade_audit_ledger_train_clean.csv');
const CSV_TEST = path.join(__dirname, 'data', 'trade_audit_ledger_test_clean.csv');
const CSV_COMBINED = path.join(__dirname, 'data', 'trade_audit_ledger_full_60d_clean.csv');

if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing dataset: ${DATA_FILE}`);
    process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const allGold5m = raw.gold5m;
const allDxy15m = raw.dxy15m;

console.log(`\n================================================================================`);
console.log(`STRICT AUDIT: LOOKAHEAD-FREE 4H TREND ANCHOR + PRIOR-BAR ATR + 60D TRAIN/TEST`);
console.log(`================================================================================`);
console.log(`Total Candles: ${allGold5m.length} Gold 5M bars | ${allDxy15m.length} DXY 15M bars`);
console.log(`Date Range:    ${allGold5m[0].iso}  -->  ${allGold5m[allGold5m.length - 1].iso}`);

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
    let sum = 0;
    for (let i = 0; i < Math.min(period, trList.length); i++) sum += trList[i];
    let prevAtr = sum / Math.min(period, trList.length);
    for (let i = 0; i < period; i++) atr.push(prevAtr);
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

// Global aggregations on full dataset
const fullM15 = aggregateCandles(allGold5m, 3);
const fullH1  = aggregateCandles(allGold5m, 12);
const fullH4  = aggregateCandles(allGold5m, 48); // 48 x 5m = 4 Hours
const fullDxyEma = calculateEMA(allDxy15m, 20);
const fullH4Ema  = calculateEMA(fullH4, 20);
const fullH1Atr  = calculateATR(fullH1, 14);

const startTime = allGold5m[0].time;
const endTime = allGold5m[allGold5m.length - 1].time;
const midTime = startTime + (endTime - startTime) / 2;
const midIso = new Date(midTime).toISOString();

console.log(`Split Point:   ${midIso}`);
console.log(`First Half (In-Sample / Train):   ${allGold5m[0].iso} to ${midIso}`);
console.log(`Second Half (Out-of-Sample/Test):  ${midIso} to ${allGold5m[allGold5m.length - 1].iso}`);

function runCleanSimulation() {
    const supremeTrades = [];
    const scalpTrades = [];
    let supremeActivePositionUntil = 0;
    let scalpActivePositionUntil = 0;

    const spreadDollars = 0.20;
    const slippageDollars = 0.10;
    const commissionUsd = 0.07;
    const fvgGapThreshold = 0.25;
    const slBuffer = 0.70;

    // Track 1: Supreme Cascade Engine
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

        // =========================================================================
        // LOOKAHEAD-FREE 4H TREND ANCHOR (EVALUATES LAST COMPLETED 4H CANDLE ONLY)
        // =========================================================================
        const currentH4Idx = fullH4.findIndex(c => curr1H.time >= c.time && curr1H.time <= c.endTime);
        const completedH4Idx = currentH4Idx - 1; // Strictly previous CLOSED 4H candle
        let h4TrendBull = false;
        let h4TrendBear = false;

        if (completedH4Idx >= 0 && completedH4Idx < fullH4.length) {
            const closedH4 = fullH4[completedH4Idx];
            const closedH4Ema = fullH4Ema[completedH4Idx];
            // Lookahead-free check: only closed prices
            h4TrendBull = (closedH4.close > closedH4Ema);
            h4TrendBear = (closedH4.close < closedH4Ema);
        }

        // =========================================================================
        // LOOKAHEAD-FREE DYNAMIC ATR DISPLACEMENT (USES COMPLETED BAR h-1 ATR)
        // =========================================================================
        const priorClosed1HAtr = fullH1Atr[h - 1] || 12.0;
        const displacementMin = Math.max(9.00, 0.50 * priorClosed1HAtr);

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

                        // Position Lock Check
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
                                slDyn = fillEntry; // True flat BE
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
                            confluence: '4H_CLOSED_ANCHOR+1H_PRIOR_ATR'
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
                                slDyn = fillEntry; // True flat BE
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
                            confluence: '4H_CLOSED_ANCHOR+1H_PRIOR_ATR'
                        });
                        break;
                    }
                }
            }
        }
    }

    // Track 2: Quick Sideways Range Scalps (also filtered by closed 4H candle)
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

        // Lookahead-free 4H trend check for scalps
        const currentH4Idx = fullH4.findIndex(c => fullM15[i].time >= c.time && fullM15[i].time <= c.endTime);
        const completedH4Idx = currentH4Idx - 1;
        let h4TrendBull = false;
        let h4TrendBear = false;

        if (completedH4Idx >= 0 && completedH4Idx < fullH4.length) {
            const closedH4 = fullH4[completedH4Idx];
            const closedH4Ema = fullH4Ema[completedH4Idx];
            h4TrendBull = (closedH4.close > closedH4Ema);
            h4TrendBear = (closedH4.close < closedH4Ema);
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
                        confluence: '4H_CLOSED_ANCHOR'
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
                            break;
                        }
                        if (sc.high >= tp) {
                            rawPnlR = 1.20;
                            exitReason = 'TP_EQUILIBRIUM';
                            exitPrice = tp;
                            exitTime = sc.iso;
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
                        confluence: '4H_CLOSED_ANCHOR'
                    });
                    break;
                }
            }
        }
    }

    const all = [...supremeTrades, ...scalpTrades].sort((a,b) => a.entryTimeMs - b.entryTimeMs);
    return all;
}

function exportCsv(targetFile, trades) {
    const csvHeaders = 'Track,ID,DateTime,Side,Entry,SL,TP1,TP2,RiskPips,ExitReason,ExitPrice,ExitTime,NormalizedNetR,PnlUsd,Confluence\n';
    const csvRows = trades.map(t => `${t.track},${t.id},"${t.time}",${t.side},${t.entry},${t.sl},${t.tp1},${t.tp2},${t.riskPips},${t.exitReason},${t.exitPrice},"${t.exitTime}",${t.pnlR},${t.pnlUsd},"${t.confluence}"`).join('\n');
    fs.writeFileSync(targetFile, csvHeaders + csvRows, 'utf8');
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
        Partition: name,
        Trades: list.length,
        Wins: wins.length,
        Losses: losses.length,
        WinRate: winRate,
        NormalizedNetR: (totalR >= 0 ? '+' : '') + totalR.toFixed(2) + 'R',
        NetUsd: (totalUsd >= 0 ? '+$' : '-$') + Math.abs(totalUsd).toFixed(2),
        ProfitFactor: profitFactor
    };
}

// Run continuous unbroken simulation over full 60 days
const allTradesClean = runCleanSimulation();

// Partition strictly by entry timestamp
const trainTradesClean = allTradesClean.filter(t => t.entryTimeMs <= midTime);
const testTradesClean  = allTradesClean.filter(t => t.entryTimeMs > midTime);

exportCsv(CSV_TRAIN, trainTradesClean);
exportCsv(CSV_TEST, testTradesClean);
exportCsv(CSV_COMBINED, allTradesClean);

console.log(`\n================================================================================`);
console.log(`LOOKAHEAD-FREE 4H ANCHOR TRAIN VS TEST COMPARISON:`);
console.log(`================================================================================`);
console.table([
    summarize('Train (In-Sample: Jul 06 - Aug 10)', trainTradesClean),
    summarize('Test (Out-of-Sample: Aug 10 - Sep 14)', testTradesClean),
    summarize('👑 FULL UNBROKEN 60-DAY RUN (Jul 06 - Sep 14)', allTradesClean)
]);

console.log(`\nDetailed CSV Ledgers Exported:`);
console.log(`- Train Half:      ${CSV_TRAIN}`);
console.log(`- Test Half:       ${CSV_TEST}`);
console.log(`- Full 60D Total:  ${CSV_COMBINED}`);

console.log(`\n================================================================================`);
console.log(`CLEAN OUT-OF-SAMPLE TEST HALF (Aug 10 - Sep 14) TRADE LOG:`);
console.log(`================================================================================`);
console.table(testTradesClean);

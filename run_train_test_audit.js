const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'historical_candles_xauusd_dxy_60d.json');
const CSV_TRAIN = path.join(__dirname, 'data', 'trade_audit_ledger_train_half1.csv');
const CSV_TEST = path.join(__dirname, 'data', 'trade_audit_ledger_test_half2_untouched.csv');
const CSV_COMBINED = path.join(__dirname, 'data', 'trade_audit_ledger_full_60d.csv');

if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing dataset: ${DATA_FILE}`);
    process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const allGold5m = raw.gold5m;
const allDxy15m = raw.dxy15m;

console.log(`\n================================================================================`);
console.log(`STRICT AUDIT ENGINE: GLOBAL INDICATORS + ACTIVE POSITION LOCK + TRAIN/TEST SPLIT`);
console.log(`================================================================================`);
console.log(`Total Dataset: ${allGold5m.length} Gold 5M bars | ${allDxy15m.length} DXY 15M bars`);
console.log(`Date Span:     ${allGold5m[0].iso}  -->  ${allGold5m[allGold5m.length - 1].iso}`);

// -------------------------------------------------------------------------
// DELIVERABLE 2: INDICATORS CALCULATED GLOBALLY BEFORE SPLITTING
// Prevents boundary distortion, modulo shifts, and stripped EMA warm-up.
// -------------------------------------------------------------------------
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

function isRedFolderNewsWindow(date) {
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();
    if ((hour === 12 && min >= 15) || (hour === 13 && min <= 45)) return true;
    if ((hour === 17 && min >= 45) || (hour === 18) || (hour === 19 && min <= 15)) return true;
    return false;
}

// Global, unbroken aggregation across the full 60-day dataset
const fullM15 = aggregateCandles(allGold5m, 3);
const fullH1  = aggregateCandles(allGold5m, 12);
const fullDxyEma = calculateEMA(allDxy15m, 20);

// Midpoint timestamp for train/test partitioning
const startTime = allGold5m[0].time;
const endTime = allGold5m[allGold5m.length - 1].time;
const midTime = startTime + (endTime - startTime) / 2;
const midIso = new Date(midTime).toISOString();

console.log(`Split Point:   ${midIso}`);
console.log(`First Half (In-Sample / Train):  ${allGold5m[0].iso} to ${midIso}`);
console.log(`Second Half (Out-of-Sample/Test): ${midIso} to ${allGold5m[allGold5m.length - 1].iso}`);

// -------------------------------------------------------------------------
// DELIVERABLE 1: ACTIVE POSITION STATE MACHINE (POSITION LOCK)
// Once a trade enters on a track, no new trade may trigger on that track
// until the active trade's exitTime has passed.
// -------------------------------------------------------------------------
function runContinuousAudit(params = {}) {
    const {
        displacementThreshold = 3.50,
        fvgGapThreshold = 0.25,
        slBuffer = 0.70,
        spreadDollars = 0.20,
        slippageDollars = 0.10,
        commissionUsd = 0.07
    } = params;

    const supremeTrades = [];
    const scalpTrades = [];

    // State Machine: Position Lock timestamps (in ms)
    let supremeActivePositionUntil = 0;
    let scalpActivePositionUntil = 0;

    // Track 1: Supreme Cascade Engine
    for (let h = 5; h < fullH1.length - 8; h++) {
        const curr1H = fullH1[h];
        const prev1H = fullH1[h - 1];
        const dt = new Date(curr1H.time);
        const hourUTC = dt.getUTCHours();

        if (!((hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18))) continue;
        if (isRedFolderNewsWindow(dt)) continue;

        let dxyAlignedBull = true;
        let dxyAlignedBear = true;
        const dxyIdx = allDxy15m.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
        if (dxyIdx >= 0 && dxyIdx < allDxy15m.length) {
            if (allDxy15m[dxyIdx].close > fullDxyEma[dxyIdx] + 0.05) dxyAlignedBull = false;
            if (allDxy15m[dxyIdx].close < fullDxyEma[dxyIdx] - 0.05) dxyAlignedBear = false;
        }

        // Bearish Supreme Check
        if (curr1H.close < prev1H.low && (curr1H.high - curr1H.low) >= displacementThreshold && dxyAlignedBear) {
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

                        // POSITION LOCK CHECK: Is there already an active position open?
                        if (execBar.time < supremeActivePositionUntil) {
                            // Cannot enter: track is locked until previous trade has exited!
                            continue;
                        }

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

                        // ENGAGE POSITION LOCK: Lock supreme track until this trade's exit timestamp
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
                            confluence: '4/4 (1H Displacement + 5M FVG + DXY + News Clear)'
                        });
                        break;
                    }
                }
            }
        }

        // Bullish Supreme Check
        if (curr1H.close > prev1H.high && (curr1H.high - curr1H.low) >= displacementThreshold && dxyAlignedBull) {
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

                        // POSITION LOCK CHECK
                        if (execBar.time < supremeActivePositionUntil) {
                            continue;
                        }

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

                        // ENGAGE POSITION LOCK
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
                            confluence: '4/4 (1H Displacement + 5M FVG + DXY + News Clear)'
                        });
                        break;
                    }
                }
            }
        }
    }

    // Track 2: Quick Sideways Range Scalps
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

        for (let j = 0; j < subBars.length - 4; j++) {
            const bar = subBars[j];
            // Upper Sweep Short
            if (bar.high >= boxHigh - 0.60 && bar.close < bar.open && bar.close < boxHigh - 0.80) {
                const execBarIndex = j + 1;
                const execBar = subBars[execBarIndex];
                if (!execBar) break;

                // POSITION LOCK CHECK FOR SCALPS
                if (execBar.time < scalpActivePositionUntil) {
                    continue;
                }

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

                    const dollarRisk = 5.0; // $5 risk on scalps
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
                        confluence: '3/4 (Range Boundary Sweep + 1M Rejection + Mid TP)'
                    });
                    break;
                }
            }

            // Lower Sweep Long
            if (bar.low <= boxLow + 0.60 && bar.close > bar.open && bar.close > boxLow + 0.80) {
                const execBarIndex = j + 1;
                const execBar = subBars[execBarIndex];
                if (!execBar) break;

                // POSITION LOCK CHECK FOR SCALPS
                if (execBar.time < scalpActivePositionUntil) {
                    continue;
                }

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
                        confluence: '3/4 (Range Boundary Sweep + 1M Rejection + Mid TP)'
                    });
                    break;
                }
            }
        }
    }

    const allTrades = [...supremeTrades, ...scalpTrades].sort((a, b) => a.entryTimeMs - b.entryTimeMs);
    return allTrades;
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
        Dataset: name,
        Trades: list.length,
        Wins: wins.length,
        Losses: losses.length,
        WinRate: winRate,
        NormalizedNetR: (totalR >= 0 ? '+' : '') + totalR.toFixed(2) + 'R',
        NetUsd: (totalUsd >= 0 ? '+$' : '-$') + Math.abs(totalUsd).toFixed(2),
        ProfitFactor: profitFactor
    };
}

// -------------------------------------------------------------------------
// EXECUTION: UNBROKEN CONTINUOUS AUDIT ACROSS FULL 60 DAYS
// Partition strictly by entry timestamp (entryTimeMs <= midTime vs > midTime)
// -------------------------------------------------------------------------
const allTrades = runContinuousAudit();

const trainTrades = allTrades.filter(t => t.entryTimeMs <= midTime);
const testTrades  = allTrades.filter(t => t.entryTimeMs > midTime);

exportCsv(CSV_TRAIN, trainTrades);
exportCsv(CSV_TEST, testTrades);
exportCsv(CSV_COMBINED, allTrades);

console.log(`\n================================================================================`);
console.log(`CORRECTED TRAIN VS TEST OUT-OF-SAMPLE AUDIT (POSITION LOCK + CONTINUOUS INDICATORS)`);
console.log(`================================================================================`);
console.table([
    summarize('First Half (Train / In-Sample: Jul 06 - Aug 10)', trainTrades),
    summarize('Second Half (Test / Out-of-Sample: Aug 10 - Sep 14)', testTrades),
    summarize('👑 FULL UNBROKEN 60-DAY RUN (Jul 06 - Sep 14)', allTrades)
]);

console.log(`\nDetailed CSV Ledgers Exported:`);
console.log(`- Train Half:      ${CSV_TRAIN}`);
console.log(`- Test Half:       ${CSV_TEST}`);
console.log(`- Full 60D Total:  ${CSV_COMBINED}`);

console.log(`\n================================================================================`);
console.log(`SECOND HALF (OUT-OF-SAMPLE UNTOUCHED) TRADE LOG:`);
console.log(`================================================================================`);
console.table(testTrades);

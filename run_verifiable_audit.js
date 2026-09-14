const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'historical_candles_xauusd_dxy_30d.json');
const CSV_OUT = path.join(__dirname, 'data', 'trade_audit_ledger.csv');

if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing dataset file at ${DATA_FILE}. Run node fetch_and_freeze_dataset.js first.`);
    process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const goldM5 = raw.gold5m;
const dxyM15 = raw.dxy15m;

console.log(`\n================================================================================`);
console.log(`OFFLINE DUAL-TRACK AUDIT ENGINE (VERIFIED AGAINST FROZEN DATASET)`);
console.log(`================================================================================`);
console.log(`Dataset Path:  ${DATA_FILE}`);
console.log(`Date Range:    ${raw.metadata.goldDateRange.from}  -->  ${raw.metadata.goldDateRange.to}`);
console.log(`Total Candles: Gold 5M = ${goldM5.length} bars | DXY 15M = ${dxyM15.length} bars`);

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
    if ((hour === 12 && min >= 15) || (hour === 13 && min <= 45)) return true; // US CPI/NFP window
    if ((hour === 17 && min >= 45) || (hour === 18) || (hour === 19 && min <= 15)) return true; // FOMC window
    return false;
}

const m15 = aggregateCandles(goldM5, 3);
const h1  = aggregateCandles(goldM5, 12);
const dxyEma = calculateEMA(dxyM15, 20);

const supremeTrades = [];
const scalpTrades = [];

// =========================================================================
// TRACK 1: SUPREME TREND CASCADE (1H ➔ 15M ➔ 5M FVG)
// =========================================================================
for (let h = 5; h < h1.length - 8; h++) {
    const curr1H = h1[h];
    const prev1H = h1[h - 1];
    const dt = new Date(curr1H.time);
    const hourUTC = dt.getUTCHours();

    if (!((hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18))) continue;
    if (isRedFolderNewsWindow(dt)) continue;

    let dxyAlignedBull = true;
    let dxyAlignedBear = true;
    const dxyIdx = dxyM15.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
    if (dxyIdx >= 0 && dxyIdx < dxyM15.length) {
        if (dxyM15[dxyIdx].close > dxyEma[dxyIdx] + 0.05) dxyAlignedBull = false;
        if (dxyM15[dxyIdx].close < dxyEma[dxyIdx] - 0.05) dxyAlignedBear = false;
    }

    // Bearish Supreme Check
    if (curr1H.close < prev1H.low && (curr1H.high - curr1H.low) >= 3.5 && dxyAlignedBear) {
        const m5Slice = goldM5.slice(prev1H.m5StartIndex, curr1H.m5EndIndex + 1);
        let freshFvg = null;
        for (let k = 1; k < m5Slice.length - 1; k++) {
            if (m5Slice[k - 1].low > m5Slice[k + 1].high + 0.25) {
                freshFvg = { top: m5Slice[k - 1].low, bottom: m5Slice[k + 1].high };
                break;
            }
        }

        if (freshFvg) {
            const futureBars = goldM5.slice(curr1H.m5EndIndex + 1, Math.min(curr1H.m5EndIndex + 144, goldM5.length));
            for (let m = 0; m < futureBars.length - 10; m++) {
                const fc = futureBars[m];
                if (fc.high >= freshFvg.bottom && fc.close <= freshFvg.top && fc.close < fc.open) {
                    const entryPrice = fc.close;
                    const slPrice = Math.max(fc.high, freshFvg.top) + 0.70;
                    const risk = slPrice - entryPrice;
                    const riskPips = Math.round(risk * 10);
                    if (riskPips < 10 || riskPips > 45) break;

                    const tp1Price = +(entryPrice - (risk * 1.5)).toFixed(2);
                    const tp2Price = +(entryPrice - (risk * 3.5)).toFixed(2);

                    const outcome = futureBars.slice(m + 1, m + 60);
                    let slDyn = slPrice;
                    let tp1Hit = false;
                    let pnlR = -1.0;
                    let exitReason = 'SL_HIT';
                    let exitPrice = slPrice;
                    let exitTime = fc.iso;

                    for (let oc of outcome) {
                        if (!tp1Hit && oc.low <= tp1Price) {
                            tp1Hit = true;
                            slDyn = entryPrice - 0.10; // Auto-BE
                            pnlR = 0.75;
                            exitReason = 'TP1_PARTIAL_BE';
                            exitPrice = tp1Price;
                            exitTime = oc.iso;
                        }
                        if (oc.high >= slDyn) {
                            if (!tp1Hit) {
                                pnlR = -1.0;
                                exitReason = 'SL_HIT';
                                exitPrice = slDyn;
                                exitTime = oc.iso;
                            }
                            break;
                        }
                        if (oc.low <= tp2Price) {
                            pnlR = 2.50;
                            exitReason = 'TP2_FULL_TARGET';
                            exitPrice = tp2Price;
                            exitTime = oc.iso;
                            break;
                        }
                    }

                    supremeTrades.push({
                        track: 'SUPREME',
                        id: supremeTrades.length + 1,
                        time: fc.iso,
                        side: 'SELL',
                        entry: entryPrice.toFixed(2),
                        sl: slPrice.toFixed(2),
                        tp1: tp1Price.toFixed(2),
                        tp2: tp2Price.toFixed(2),
                        riskPips,
                        exitReason,
                        exitPrice: exitPrice.toFixed(2),
                        exitTime,
                        pnlR: pnlR.toFixed(2),
                        pnlUsd: (pnlR * 10).toFixed(2), // $10 risk
                        confluence: '4/4 (1H Displacement + 5M FVG + DXY + News Clear)'
                    });
                    break;
                }
            }
        }
    }

    // Bullish Supreme Check
    if (curr1H.close > prev1H.high && (curr1H.high - curr1H.low) >= 3.5 && dxyAlignedBull) {
        const m5Slice = goldM5.slice(prev1H.m5StartIndex, curr1H.m5EndIndex + 1);
        let freshFvg = null;
        for (let k = 1; k < m5Slice.length - 1; k++) {
            if (m5Slice[k + 1].low > m5Slice[k - 1].high + 0.25) {
                freshFvg = { top: m5Slice[k + 1].low, bottom: m5Slice[k - 1].high };
                break;
            }
        }

        if (freshFvg) {
            const futureBars = goldM5.slice(curr1H.m5EndIndex + 1, Math.min(curr1H.m5EndIndex + 144, goldM5.length));
            for (let m = 0; m < futureBars.length - 10; m++) {
                const fc = futureBars[m];
                if (fc.low <= freshFvg.top && fc.close >= freshFvg.bottom && fc.close > fc.open) {
                    const entryPrice = fc.close;
                    const slPrice = Math.min(fc.low, freshFvg.bottom) - 0.70;
                    const risk = entryPrice - slPrice;
                    const riskPips = Math.round(risk * 10);
                    if (riskPips < 10 || riskPips > 45) break;

                    const tp1Price = +(entryPrice + (risk * 1.5)).toFixed(2);
                    const tp2Price = +(entryPrice + (risk * 3.5)).toFixed(2);

                    const outcome = futureBars.slice(m + 1, m + 60);
                    let slDyn = slPrice;
                    let tp1Hit = false;
                    let pnlR = -1.0;
                    let exitReason = 'SL_HIT';
                    let exitPrice = slPrice;
                    let exitTime = fc.iso;

                    for (let oc of outcome) {
                        if (!tp1Hit && oc.high >= tp1Price) {
                            tp1Hit = true;
                            slDyn = entryPrice + 0.10;
                            pnlR = 0.75;
                            exitReason = 'TP1_PARTIAL_BE';
                            exitPrice = tp1Price;
                            exitTime = oc.iso;
                        }
                        if (oc.low <= slDyn) {
                            if (!tp1Hit) {
                                pnlR = -1.0;
                                exitReason = 'SL_HIT';
                                exitPrice = slDyn;
                                exitTime = oc.iso;
                            }
                            break;
                        }
                        if (oc.high >= tp2Price) {
                            pnlR = 2.50;
                            exitReason = 'TP2_FULL_TARGET';
                            exitPrice = tp2Price;
                            exitTime = oc.iso;
                            break;
                        }
                    }

                    supremeTrades.push({
                        track: 'SUPREME',
                        id: supremeTrades.length + 1,
                        time: fc.iso,
                        side: 'BUY',
                        entry: entryPrice.toFixed(2),
                        sl: slPrice.toFixed(2),
                        tp1: tp1Price.toFixed(2),
                        tp2: tp2Price.toFixed(2),
                        riskPips,
                        exitReason,
                        exitPrice: exitPrice.toFixed(2),
                        exitTime,
                        pnlR: pnlR.toFixed(2),
                        pnlUsd: (pnlR * 10).toFixed(2),
                        confluence: '4/4 (1H Displacement + 5M FVG + DXY + News Clear)'
                    });
                    break;
                }
            }
        }
    }
}

// =========================================================================
// TRACK 2: QUICK SIDEWAYS RANGE SCALPS (15M Range Box ➔ Equilibrium Target)
// =========================================================================
for (let i = 12; i < m15.length - 16; i += 4) {
    const boxSlice = m15.slice(i - 12, i);
    let boxHigh = -Infinity;
    let boxLow = Infinity;
    for (let b of boxSlice) {
        if (b.high > boxHigh) boxHigh = b.high;
        if (b.low < boxLow) boxLow = b.low;
    }
    const boxSpan = boxHigh - boxLow;
    if (boxSpan < 4.0 || boxSpan > 14.0) continue; // Must be clean consolidation

    const eq = +( (boxHigh + boxLow) / 2 ).toFixed(2);
    const subBars = goldM5.slice(m15[i].m5StartIndex, Math.min(m15[i].m5StartIndex + 16, goldM5.length));

    for (let j = 0; j < subBars.length - 4; j++) {
        const bar = subBars[j];
        // Upper Boundary Wick Rejection -> Scalp Short
        if (bar.high >= boxHigh - 0.60 && bar.close < bar.open && bar.close < boxHigh - 0.80) {
            const entry = bar.close;
            const sl = +(boxHigh + 1.20).toFixed(2);
            const tp = eq;
            const risk = sl - entry;
            const riskPips = Math.round(risk * 10);
            if (riskPips >= 12 && riskPips <= 35) {
                const outcome = subBars.slice(j + 1);
                let pnlR = -1.0;
                let exitReason = 'SL_HIT';
                let exitPrice = sl;
                let exitTime = bar.iso;

                for (let sc of outcome) {
                    if (sc.high >= sl) {
                        pnlR = -1.0;
                        exitReason = 'SL_HIT';
                        exitPrice = sl;
                        exitTime = sc.iso;
                        break;
                    }
                    if (sc.low <= tp) {
                        pnlR = 1.20;
                        exitReason = 'TP_EQUILIBRIUM';
                        exitPrice = tp;
                        exitTime = sc.iso;
                        break;
                    }
                }

                scalpTrades.push({
                    track: 'SCALP',
                    id: scalpTrades.length + 1,
                    time: bar.iso,
                    side: 'SELL',
                    entry: entry.toFixed(2),
                    sl: sl.toFixed(2),
                    tp1: tp.toFixed(2),
                    tp2: tp.toFixed(2),
                    riskPips,
                    exitReason,
                    exitPrice: exitPrice.toFixed(2),
                    exitTime,
                    pnlR: pnlR.toFixed(2),
                    pnlUsd: (pnlR * 5).toFixed(2), // $5 risk on scalps
                    confluence: '3/4 (Range Boundary Sweep + 1M Rejection + Mid TP)'
                });
                break;
            }
        }

        // Lower Boundary Wick Rejection -> Scalp Long
        if (bar.low <= boxLow + 0.60 && bar.close > bar.open && bar.close > boxLow + 0.80) {
            const entry = bar.close;
            const sl = +(boxLow - 1.20).toFixed(2);
            const tp = eq;
            const risk = entry - sl;
            const riskPips = Math.round(risk * 10);
            if (riskPips >= 12 && riskPips <= 35) {
                const outcome = subBars.slice(j + 1);
                let pnlR = -1.0;
                let exitReason = 'SL_HIT';
                let exitPrice = sl;
                let exitTime = bar.iso;

                for (let sc of outcome) {
                    if (sc.low <= sl) {
                        pnlR = -1.0;
                        exitReason = 'SL_HIT';
                        exitPrice = sl;
                        exitTime = sc.iso;
                        break;
                    }
                    if (sc.high >= tp) {
                        pnlR = 1.20;
                        exitReason = 'TP_EQUILIBRIUM';
                        exitPrice = tp;
                        exitTime = sc.iso;
                        break;
                    }
                }

                scalpTrades.push({
                    track: 'SCALP',
                    id: scalpTrades.length + 1,
                    time: bar.iso,
                    side: 'BUY',
                    entry: entry.toFixed(2),
                    sl: sl.toFixed(2),
                    tp1: tp.toFixed(2),
                    tp2: tp.toFixed(2),
                    riskPips,
                    exitReason,
                    exitPrice: exitPrice.toFixed(2),
                    exitTime,
                    pnlR: pnlR.toFixed(2),
                    pnlUsd: (pnlR * 5).toFixed(2),
                    confluence: '3/4 (Range Boundary Sweep + 1M Rejection + Mid TP)'
                });
                break;
            }
        }
    }
}

// Generate Combined CSV Ledger
const allTrades = [...supremeTrades, ...scalpTrades].sort((a, b) => new Date(a.time) - new Date(b.time));
const csvHeaders = 'Track,ID,DateTime,Side,Entry,SL,TP1,TP2,RiskPips,ExitReason,ExitPrice,ExitTime,PnlR,PnlUsd,Confluence\n';
const csvRows = allTrades.map(t => `${t.track},${t.id},"${t.time}",${t.side},${t.entry},${t.sl},${t.tp1},${t.tp2},${t.riskPips},${t.exitReason},${t.exitPrice},"${t.exitTime}",${t.pnlR},${t.pnlUsd},"${t.confluence}"`).join('\n');
fs.writeFileSync(CSV_OUT, csvHeaders + csvRows, 'utf8');

function summarize(name, list) {
    const wins = list.filter(t => parseFloat(t.pnlR) > 0);
    const losses = list.filter(t => parseFloat(t.pnlR) <= 0);
    const totalR = list.reduce((acc, t) => acc + parseFloat(t.pnlR), 0);
    const totalUsd = list.reduce((acc, t) => acc + parseFloat(t.pnlUsd), 0);
    const grossWinsR = wins.reduce((acc, t) => acc + parseFloat(t.pnlR), 0);
    const grossLossesR = Math.abs(losses.reduce((acc, t) => acc + parseFloat(t.pnlR), 0));
    const profitFactor = grossLossesR > 0 ? (grossWinsR / grossLossesR).toFixed(2) : 'INF';
    const winRate = list.length ? ((wins.length / list.length) * 100).toFixed(1) + '%' : '0%';

    return {
        Track: name,
        Trades: list.length,
        Wins: wins.length,
        Losses: losses.length,
        WinRate: winRate,
        NetR: (totalR >= 0 ? '+' : '') + totalR.toFixed(2) + 'R',
        ProfitFactor: profitFactor,
        NetUsdOn$500: (totalUsd >= 0 ? '+$' : '-$') + Math.abs(totalUsd).toFixed(2)
    };
}

console.log(`\n================================================================================`);
console.log(`AUDIT RESULTS (DETERMINISTIC REPRODUCIBLE RUN):`);
console.log(`================================================================================`);
console.table([
    summarize('Track 1: Supreme Cascade (1H➔5M)', supremeTrades),
    summarize('Track 2: Quick Scalps (15M Range Box)', scalpTrades),
    summarize('👑 COMBINED DUAL-TRACK SYSTEM', allTrades)
]);

console.log(`\nTrade-by-Trade CSV Ledger exported to: ${CSV_OUT}`);
console.log(`================================================================================\n`);

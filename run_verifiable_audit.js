const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'historical_candles_xauusd_dxy_30d.json');
const CSV_OUT_BASE = path.join(__dirname, 'data', 'trade_audit_ledger_before_corrections.csv');
const CSV_OUT_STAGE1 = path.join(__dirname, 'data', 'trade_audit_ledger_next_bar_open.csv');
const CSV_OUT_STAGE2 = path.join(__dirname, 'data', 'trade_audit_ledger_realistic_costs.csv');

if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing dataset file at ${DATA_FILE}. Run node fetch_and_freeze_dataset.js first.`);
    process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const goldM5 = raw.gold5m;
const dxyM15 = raw.dxy15m;

console.log(`\n================================================================================`);
console.log(`RIGOROUS AUDIT: LOOK-AHEAD FIX + TRUE BREAKEVEN + SPREAD/SLIPPAGE/COMMISSION`);
console.log(`================================================================================`);
console.log(`Dataset: ${DATA_FILE} (${goldM5.length} Gold 5M bars | ${dxyM15.length} DXY 15M bars)`);

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

const m15 = aggregateCandles(goldM5, 3);
const h1  = aggregateCandles(goldM5, 12);
const dxyEma = calculateEMA(dxyM15, 20);

// Configurable Backtest Engine
function runAuditSimulation(options = {}) {
    const {
        useNextBarOpen = false, // false = old look-ahead on close, true = real next-candle open
        beBuffer = 0.10,        // 0.10 = old buffer, 0.00 = true flat breakeven
        spreadDollars = 0.00,   // 0.20 = 2.0 pips spread
        slippageDollars = 0.00, // 0.10 = 1.0 pip slippage on fill
        commissionRoundTurnUsd = 0.00 // 0.07 = $7/lot for 0.01 lot
    } = options;

    const supremeTrades = [];
    const scalpTrades = [];

    // TRACK 1: SUPREME TREND CASCADE
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
                        // Rejection confirmed at close of fc!
                        const executionBarIndex = useNextBarOpen ? (m + 1) : m;
                        const execBar = futureBars[executionBarIndex];
                        if (!execBar) break;

                        // Base Entry Price
                        const baseEntry = useNextBarOpen ? execBar.open : fc.close;
                        // On Sell: Entry is at Bid - slippage
                        const fillEntry = +(baseEntry - slippageDollars).toFixed(2);

                        const slPrice = +(Math.max(fc.high, freshFvg.top) + 0.70).toFixed(2);
                        const risk = slPrice - fillEntry;
                        const riskPips = Math.round(risk * 10);
                        if (riskPips < 10 || riskPips > 45) break;

                        const tp1Price = +(fillEntry - (risk * 1.5)).toFixed(2);
                        const tp2Price = +(fillEntry - (risk * 3.5)).toFixed(2);

                        const outcome = futureBars.slice(executionBarIndex + 1, executionBarIndex + 61);
                        let slDyn = slPrice;
                        let tp1Hit = false;
                        let pnlR = -1.0;
                        let exitReason = 'SL_HIT';
                        let exitPrice = slPrice;
                        let exitTime = execBar.iso;

                        for (let oc of outcome) {
                            // On Sell, buyback to cover is at Ask = Bid + spread
                            const effectiveAskHigh = +(oc.high + spreadDollars).toFixed(2);
                            const effectiveAskLow = +(oc.low + spreadDollars).toFixed(2);

                            if (!tp1Hit && effectiveAskLow <= tp1Price) {
                                tp1Hit = true;
                                // Move to breakeven (with or without buffer)
                                slDyn = +(fillEntry - beBuffer).toFixed(2);
                                pnlR = 0.75;
                                exitReason = 'TP1_PARTIAL_BE';
                                exitPrice = tp1Price;
                                exitTime = oc.iso;
                            }
                            if (effectiveAskHigh >= slDyn) {
                                if (!tp1Hit) {
                                    pnlR = -1.0;
                                    exitReason = 'SL_HIT';
                                    exitPrice = slDyn;
                                    exitTime = oc.iso;
                                }
                                break;
                            }
                            if (effectiveAskLow <= tp2Price) {
                                pnlR = 2.50;
                                exitReason = 'TP2_FULL_TARGET';
                                exitPrice = tp2Price;
                                exitTime = oc.iso;
                                break;
                            }
                        }

                        // Commission deduction ($10 risk base)
                        const dollarRisk = 10.0;
                        const pnlUsd = (pnlR * dollarRisk) - commissionRoundTurnUsd;
                        const netR = pnlUsd / dollarRisk;

                        supremeTrades.push({
                            track: 'SUPREME',
                            id: supremeTrades.length + 1,
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
                            pnlR: netR.toFixed(2),
                            pnlUsd: pnlUsd.toFixed(2),
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
                        const executionBarIndex = useNextBarOpen ? (m + 1) : m;
                        const execBar = futureBars[executionBarIndex];
                        if (!execBar) break;

                        // On Buy: Entry is at Ask = Open + spread + slippage
                        const baseEntry = useNextBarOpen ? execBar.open : fc.close;
                        const fillEntry = +(baseEntry + spreadDollars + slippageDollars).toFixed(2);

                        const slPrice = +(Math.min(fc.low, freshFvg.bottom) - 0.70).toFixed(2);
                        const risk = fillEntry - slPrice;
                        const riskPips = Math.round(risk * 10);
                        if (riskPips < 10 || riskPips > 45) break;

                        const tp1Price = +(fillEntry + (risk * 1.5)).toFixed(2);
                        const tp2Price = +(fillEntry + (risk * 3.5)).toFixed(2);

                        const outcome = futureBars.slice(executionBarIndex + 1, executionBarIndex + 61);
                        let slDyn = slPrice;
                        let tp1Hit = false;
                        let pnlR = -1.0;
                        let exitReason = 'SL_HIT';
                        let exitPrice = slPrice;
                        let exitTime = execBar.iso;

                        for (let oc of outcome) {
                            // On Buy: Exit is at Bid (chart prices)
                            if (!tp1Hit && oc.high >= tp1Price) {
                                tp1Hit = true;
                                slDyn = +(fillEntry + beBuffer).toFixed(2);
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

                        const dollarRisk = 10.0;
                        const pnlUsd = (pnlR * dollarRisk) - commissionRoundTurnUsd;
                        const netR = pnlUsd / dollarRisk;

                        supremeTrades.push({
                            track: 'SUPREME',
                            id: supremeTrades.length + 1,
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
                            pnlR: netR.toFixed(2),
                            pnlUsd: pnlUsd.toFixed(2),
                            confluence: '4/4 (1H Displacement + 5M FVG + DXY + News Clear)'
                        });
                        break;
                    }
                }
            }
        }
    }

    // TRACK 2: QUICK SIDEWAYS RANGE SCALPS
    for (let i = 12; i < m15.length - 16; i += 4) {
        const boxSlice = m15.slice(i - 12, i);
        let boxHigh = -Infinity;
        let boxLow = Infinity;
        for (let b of boxSlice) {
            if (b.high > boxHigh) boxHigh = b.high;
            if (b.low < boxLow) boxLow = b.low;
        }
        const boxSpan = boxHigh - boxLow;
        if (boxSpan < 4.0 || boxSpan > 14.0) continue;

        const eq = +( (boxHigh + boxLow) / 2 ).toFixed(2);
        const subBars = goldM5.slice(m15[i].m5StartIndex, Math.min(m15[i].m5StartIndex + 16, goldM5.length));

        for (let j = 0; j < subBars.length - 4; j++) {
            const bar = subBars[j];
            // Upper Boundary Wick Rejection -> Scalp Short
            if (bar.high >= boxHigh - 0.60 && bar.close < bar.open && bar.close < boxHigh - 0.80) {
                const execBarIndex = useNextBarOpen ? (j + 1) : j;
                const execBar = subBars[execBarIndex];
                if (!execBar) break;

                const baseEntry = useNextBarOpen ? execBar.open : bar.close;
                const fillEntry = +(baseEntry - slippageDollars).toFixed(2);

                const sl = +(boxHigh + 1.20).toFixed(2);
                const tp = eq;
                const risk = sl - fillEntry;
                const riskPips = Math.round(risk * 10);
                if (riskPips >= 12 && riskPips <= 35) {
                    const outcome = subBars.slice(execBarIndex + 1);
                    let pnlR = -1.0;
                    let exitReason = 'SL_HIT';
                    let exitPrice = sl;
                    let exitTime = execBar.iso;

                    for (let sc of outcome) {
                        const effectiveAskHigh = +(sc.high + spreadDollars).toFixed(2);
                        const effectiveAskLow = +(sc.low + spreadDollars).toFixed(2);

                        if (effectiveAskHigh >= sl) {
                            pnlR = -1.0;
                            exitReason = 'SL_HIT';
                            exitPrice = sl;
                            exitTime = sc.iso;
                            break;
                        }
                        if (effectiveAskLow <= tp) {
                            pnlR = 1.20;
                            exitReason = 'TP_EQUILIBRIUM';
                            exitPrice = tp;
                            exitTime = sc.iso;
                            break;
                        }
                    }

                    const dollarRisk = 5.0; // $5 risk on scalps
                    const pnlUsd = (pnlR * dollarRisk) - commissionRoundTurnUsd;
                    const netR = pnlUsd / dollarRisk;

                    scalpTrades.push({
                        track: 'SCALP',
                        id: scalpTrades.length + 1,
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
                        pnlR: netR.toFixed(2),
                        pnlUsd: pnlUsd.toFixed(2),
                        confluence: '3/4 (Range Boundary Sweep + 1M Rejection + Mid TP)'
                    });
                    break;
                }
            }

            // Lower Boundary Wick Rejection -> Scalp Long
            if (bar.low <= boxLow + 0.60 && bar.close > bar.open && bar.close > boxLow + 0.80) {
                const execBarIndex = useNextBarOpen ? (j + 1) : j;
                const execBar = subBars[execBarIndex];
                if (!execBar) break;

                const baseEntry = useNextBarOpen ? execBar.open : bar.close;
                const fillEntry = +(baseEntry + spreadDollars + slippageDollars).toFixed(2);

                const sl = +(boxLow - 1.20).toFixed(2);
                const tp = eq;
                const risk = fillEntry - sl;
                const riskPips = Math.round(risk * 10);
                if (riskPips >= 12 && riskPips <= 35) {
                    const outcome = subBars.slice(execBarIndex + 1);
                    let pnlR = -1.0;
                    let exitReason = 'SL_HIT';
                    let exitPrice = sl;
                    let exitTime = execBar.iso;

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

                    const dollarRisk = 5.0;
                    const pnlUsd = (pnlR * dollarRisk) - commissionRoundTurnUsd;
                    const netR = pnlUsd / dollarRisk;

                    scalpTrades.push({
                        track: 'SCALP',
                        id: scalpTrades.length + 1,
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
                        pnlR: netR.toFixed(2),
                        pnlUsd: pnlUsd.toFixed(2),
                        confluence: '3/4 (Range Boundary Sweep + 1M Rejection + Mid TP)'
                    });
                    break;
                }
            }
        }
    }

    const allTrades = [...supremeTrades, ...scalpTrades].sort((a, b) => new Date(a.time) - new Date(b.time));
    return { supremeTrades, scalpTrades, allTrades };
}

function exportCsv(targetFile, trades) {
    const csvHeaders = 'Track,ID,DateTime,Side,Entry,SL,TP1,TP2,RiskPips,ExitReason,ExitPrice,ExitTime,PnlR,PnlUsd,Confluence\n';
    const csvRows = trades.map(t => `${t.track},${t.id},"${t.time}",${t.side},${t.entry},${t.sl},${t.tp1},${t.tp2},${t.riskPips},${t.exitReason},${t.exitPrice},"${t.exitTime}",${t.pnlR},${t.pnlUsd},"${t.confluence}"`).join('\n');
    fs.writeFileSync(targetFile, csvHeaders + csvRows, 'utf8');
}

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
        Stage: name,
        Trades: list.length,
        Wins: wins.length,
        Losses: losses.length,
        WinRate: winRate,
        NetR: (totalR >= 0 ? '+' : '') + totalR.toFixed(2) + 'R',
        ProfitFactor: profitFactor,
        NetUsdOn$500: (totalUsd >= 0 ? '+$' : '-$') + Math.abs(totalUsd).toFixed(2)
    };
}

// 1. BASELINE (Old: Look-ahead on Close, 10c BE buffer, Zero Costs)
const runBase = runAuditSimulation({
    useNextBarOpen: false,
    beBuffer: 0.10,
    spreadDollars: 0.00,
    slippageDollars: 0.00,
    commissionRoundTurnUsd: 0.00
});
exportCsv(CSV_OUT_BASE, runBase.allTrades);

// 2. STAGE 1 (Look-Ahead Fixed: Next Bar Open, True Flat Breakeven, Zero Costs)
const runStage1 = runAuditSimulation({
    useNextBarOpen: true,
    beBuffer: 0.00, // True flat Breakeven
    spreadDollars: 0.00,
    slippageDollars: 0.00,
    commissionRoundTurnUsd: 0.00
});
exportCsv(CSV_OUT_STAGE1, runStage1.allTrades);

// 3. STAGE 2 (Realistic Friction: Next Bar Open, Flat BE, 2.0 Pips Spread + 1.0 Pip Slippage + $7/Lot Comm)
const runStage2 = runAuditSimulation({
    useNextBarOpen: true,
    beBuffer: 0.00,
    spreadDollars: 0.20, // 2.0 pips spread on XAUUSD
    slippageDollars: 0.10, // 1.0 pip slippage on entry
    commissionRoundTurnUsd: 0.07 // $0.07 per 0.01 lot round turn ($7/standard lot)
});
exportCsv(CSV_OUT_STAGE2, runStage2.allTrades);

console.log(`\n================================================================================`);
console.log(`COMPARATIVE SUMMARY: PROGRESSION FROM BASELINE TO REAL-WORLD FRICTION`);
console.log(`================================================================================`);
console.table([
    summarize('1. Baseline (Old Close Fill, 10c Buffer, $0 Cost)', runBase.allTrades),
    summarize('2. Stage 1 (Next-Bar Open Fill, Flat BE, $0 Cost)', runStage1.allTrades),
    summarize('3. Stage 2 (Next Open + Flat BE + 2p Spread + 1p Slip + Comm)', runStage2.allTrades)
]);

console.log(`\nDetailed CSV Ledgers Exported:`);
console.log(`- Baseline:  ${CSV_OUT_BASE}`);
console.log(`- Stage 1:   ${CSV_OUT_STAGE1}`);
console.log(`- Stage 2:   ${CSV_OUT_STAGE2}`);

console.log(`\n================================================================================`);
console.log(`STAGE 2 (REAL-WORLD COSTS) TRADE-BY-TRADE LEDGER:`);
console.log(`================================================================================`);
console.table(runStage2.allTrades);

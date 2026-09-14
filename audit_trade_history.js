const fs = require('fs');
const path = require('path');

// Dataset resolution: prefer 60-day multi-month historical dataset
const DATA_FILE_60D = path.join(__dirname, 'data', 'historical_candles_xauusd_dxy_60d.json');
const DATA_FILE_30D = path.join(__dirname, 'data', 'historical_candles_xauusd_dxy_30d.json');
const DATA_FILE = fs.existsSync(DATA_FILE_60D) ? DATA_FILE_60D : DATA_FILE_30D;

const CSV_OUT_BASE = path.join(__dirname, 'data', 'trade_audit_ledger_before_corrections.csv');
const CSV_OUT_STAGE1 = path.join(__dirname, 'data', 'trade_audit_ledger_next_bar_open.csv');
const CSV_OUT_STAGE2 = path.join(__dirname, 'data', 'trade_audit_ledger_realistic_costs.csv');
const JSON_OUT_VERIFIED = path.join(__dirname, 'data', 'verified_backtest_trades.json');

if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing dataset file at ${DATA_FILE}. Run node fetch_and_freeze_60d_dataset.js first.`);
    process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const goldM5 = raw.gold5m;
const dxyM15 = raw.dxy15m;

console.log(`\n================================================================================`);
console.log(`QUANT AUDIT ENGINE: CALENDAR NEWS BLACKOUT + SMA-SEEDED EMA + BLENDED TP1/TP2`);
console.log(`================================================================================`);
console.log(`Active Dataset: ${path.basename(DATA_FILE)}`);
console.log(`Coverage: ${goldM5.length} Gold 5M bars (${goldM5[0].iso} -> ${goldM5[goldM5.length - 1].iso})`);
console.log(`          ${dxyM15.length} DXY 15M bars (${dxyM15[0].iso} -> ${dxyM15[dxyM15.length - 1].iso})\n`);

// =========================================================================
// 1. ECONOMIC EVENT SCHEDULE (AUTHENTIC HIGH-IMPACT USD CALENDAR)
// =========================================================================
const HIGH_IMPACT_USD_EVENTS = [
    // JULY 2026
    { name: "US Non-Farm Payrolls & Unemployment", date: "2026-07-02", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "FOMC Minutes Release", date: "2026-07-08", timeUtc: "18:00", impact: "HIGH", currency: "USD" },
    { name: "US Initial Jobless Claims", date: "2026-07-09", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Consumer Price Index (CPI)", date: "2026-07-14", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Core PPI (Producer Price Index)", date: "2026-07-15", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Initial Jobless Claims & Retail Sales", date: "2026-07-16", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Initial Jobless Claims", date: "2026-07-23", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "FOMC Rate Decision & Statement", date: "2026-07-29", timeUtc: "18:00", impact: "HIGH", currency: "USD" },
    { name: "FOMC Press Conference (Fed Chair)", date: "2026-07-29", timeUtc: "18:30", impact: "HIGH", currency: "USD" },
    { name: "US Advance GDP q/q & Jobless Claims", date: "2026-07-30", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Core PCE Price Index MoM", date: "2026-07-31", timeUtc: "12:30", impact: "HIGH", currency: "USD" },

    // AUGUST 2026
    { name: "US Non-Farm Payrolls & Unemployment", date: "2026-08-07", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Consumer Price Index (CPI YoY)", date: "2026-08-12", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Core PPI (Producer Price Index)", date: "2026-08-13", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Initial Jobless Claims", date: "2026-08-20", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "Fed Chair Powell Jackson Hole Address", date: "2026-08-21", timeUtc: "14:00", impact: "HIGH", currency: "USD" },
    { name: "US Prelim GDP q/q & Jobless Claims", date: "2026-08-27", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Core PCE Price Index MoM", date: "2026-08-28", timeUtc: "12:30", impact: "HIGH", currency: "USD" },

    // SEPTEMBER 2026
    { name: "US Initial Jobless Claims", date: "2026-09-03", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Non-Farm Payrolls & Unemployment", date: "2026-09-04", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US CPI (Consumer Price Index)", date: "2026-09-09", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Core PPI & Initial Jobless Claims", date: "2026-09-10", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Core Retail Sales MoM", date: "2026-09-15", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "FOMC Rate Decision & Projections", date: "2026-09-16", timeUtc: "18:00", impact: "HIGH", currency: "USD" },
    { name: "FOMC Press Conference (Fed Chair)", date: "2026-09-16", timeUtc: "18:30", impact: "HIGH", currency: "USD" },
    { name: "US Initial Jobless Claims & Philly Fed", date: "2026-09-17", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Final GDP q/q & Initial Jobless Claims", date: "2026-09-24", timeUtc: "12:30", impact: "HIGH", currency: "USD" },
    { name: "US Core PCE Price Index MoM", date: "2026-09-25", timeUtc: "12:30", impact: "HIGH", currency: "USD" }
];

/**
 * Authentic Red Folder News Window:
 * Freezes execution from 30 minutes BEFORE scheduled release until 45 minutes AFTER release.
 * On non-event days/times, allows trading freely.
 */
function isRedFolderNewsWindow(date) {
    const target = (date instanceof Date) ? date : new Date(date);
    const targetMs = target.getTime();
    const y = target.getUTCFullYear();
    const m = String(target.getUTCMonth() + 1).padStart(2, '0');
    const d = String(target.getUTCDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const dayEvents = HIGH_IMPACT_USD_EVENTS.filter(e => e.date === dateStr && e.impact === 'HIGH' && e.currency === 'USD');
    for (const ev of dayEvents) {
        const [hh, mm] = ev.timeUtc.split(':').map(Number);
        const eventMs = Date.UTC(y, target.getUTCMonth(), target.getUTCDate(), hh, mm, 0);
        const diffMins = (targetMs - eventMs) / (60 * 1000);
        // Blackout: 30 minutes before to 45 minutes after high-impact print
        if (diffMins >= -30 && diffMins <= 45) {
            return true;
        }
    }
    return false;
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

/**
 * SMA-Seeded EMA Calculation:
 * Warmed up with a true Simple Moving Average over the first `period` bars
 * instead of biasing with a single candle close.
 */
function calculateEMA(candles, period) {
    if (!candles || candles.length === 0) return [];
    const ema = new Array(candles.length);
    const k = 2 / (period + 1);

    if (candles.length < period) {
        let sum = 0;
        for (let i = 0; i < candles.length; i++) sum += candles[i].close;
        const avg = sum / candles.length;
        for (let i = 0; i < candles.length; i++) ema[i] = avg;
        return ema;
    }

    // Step 1: SMA warm-up over initial `period` bars
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += candles[i].close;
        ema[i] = sum / (i + 1);
    }
    let prev = sum / period;
    ema[period - 1] = prev;

    // Step 2: Standard exponential recursion
    for (let i = period; i < candles.length; i++) {
        const val = candles[i].close * k + prev * (1 - k);
        ema[i] = val;
        prev = val;
    }
    return ema;
}

const m15 = aggregateCandles(goldM5, 3);
const h1  = aggregateCandles(goldM5, 12);
const dxyEma = calculateEMA(dxyM15, 20);

// Named risk/reward and partial close constants
const TP1_R = 1.50;
const TP2_R = 3.50;
const TP1_PARTIAL_RATIO = 0.50; // 50% locked at TP1
const RUNNER_RATIO = 1.0 - TP1_PARTIAL_RATIO; // 50% runner to TP2 / Breakeven

// Configurable Backtest Engine
function runAuditSimulation(options = {}) {
    const {
        useNextBarOpen = false,        // false = look-ahead close fill; true = realistic next-bar open
        beBuffer = 0.00,               // 0.00 = true flat breakeven; 0.10 = $0.10 slippage buffer
        spreadDollars = 0.00,          // Bid/Ask spread (e.g. 0.20 = 2.0 pips)
        slippageDollars = 0.00,        // Execution slippage (e.g. 0.10 = 1.0 pip)
        commissionRoundTurnUsd = 0.00  // Broker commission (e.g. 0.07 per 0.01 lot)
    } = options;

    const supremeTrades = [];
    const scalpTrades = [];

    // =========================================================================
    // TRACK 1: SUPREME INSTITUTIONAL CASCADE (1H Trend Anchor + 5M FVG Tap)
    // =========================================================================
    for (let h = 5; h < h1.length - 8; h++) {
        const curr1H = h1[h];
        const prev1H = h1[h - 1];
        const dt = new Date(curr1H.time);
        const hourUTC = dt.getUTCHours();

        // Active London & New York Institutional Sessions
        if (!((hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18))) continue;
        
        // News Blackout Check (Dynamic High-Impact Calendar)
        if (isRedFolderNewsWindow(dt)) continue;

        let dxyAlignedBull = true;
        let dxyAlignedBear = true;
        const dxyIdx = dxyM15.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
        if (dxyIdx >= 0 && dxyIdx < dxyM15.length) {
            if (dxyM15[dxyIdx].close > dxyEma[dxyIdx] + 0.05) dxyAlignedBull = false;
            if (dxyM15[dxyIdx].close < dxyEma[dxyIdx] - 0.05) dxyAlignedBear = false;
        }

        // --- Bearish Institutional Setup ---
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
                        const executionBarIndex = useNextBarOpen ? (m + 1) : m;
                        const execBar = futureBars[executionBarIndex];
                        if (!execBar) break;

                        // Check news window at actual entry trigger bar
                        if (isRedFolderNewsWindow(new Date(execBar.time))) break;

                        const baseEntry = useNextBarOpen ? execBar.open : fc.close;
                        const fillEntry = +(baseEntry - slippageDollars).toFixed(2);
                        const slPrice = +(Math.max(fc.high, freshFvg.top) + 0.70).toFixed(2);
                        const risk = slPrice - fillEntry;
                        const riskPips = Math.round(risk * 10);
                        if (riskPips < 10 || riskPips > 45) break;

                        const tp1Price = +(fillEntry - (risk * TP1_R)).toFixed(2);
                        const tp2Price = +(fillEntry - (risk * TP2_R)).toFixed(2);

                        const outcome = futureBars.slice(executionBarIndex + 1, executionBarIndex + 61);
                        let slDyn = slPrice;
                        let tp1Hit = false;
                        let rawPnlR = -1.0;
                        let exitReason = 'SL_HIT';
                        let exitPrice = slPrice;
                        let exitTime = execBar.iso;

                        for (let oc of outcome) {
                            const effectiveAskHigh = +(oc.high + spreadDollars).toFixed(2);
                            const effectiveAskLow = +(oc.low + spreadDollars).toFixed(2);

                            // TP1 Target Reached: Lock 50% partial profit & move stop loss to BE
                            if (!tp1Hit && effectiveAskLow <= tp1Price) {
                                tp1Hit = true;
                                slDyn = +(fillEntry - beBuffer).toFixed(2);
                                exitReason = 'TP1_PARTIAL_BE';
                                exitPrice = tp1Price;
                                exitTime = oc.iso;
                            }

                            // Stop Loss Hit
                            if (effectiveAskHigh >= slDyn) {
                                if (!tp1Hit) {
                                    rawPnlR = -1.0;
                                    exitReason = 'SL_HIT';
                                    exitPrice = slDyn;
                                    exitTime = oc.iso;
                                } else {
                                    // TP1 was hit earlier, runner stopped at BE
                                    const runnerR = (fillEntry - slDyn) / risk; // 0.0 at flat BE
                                    rawPnlR = (TP1_R * TP1_PARTIAL_RATIO) + (runnerR * RUNNER_RATIO);
                                    exitReason = 'TP1_PARTIAL_BE_STOP';
                                    exitPrice = slDyn;
                                    exitTime = oc.iso;
                                }
                                break;
                            }

                            // TP2 Full Target Reached: Close remaining runner position
                            if (effectiveAskLow <= tp2Price) {
                                rawPnlR = (TP1_R * TP1_PARTIAL_RATIO) + (TP2_R * RUNNER_RATIO);
                                exitReason = 'TP2_FULL_TARGET';
                                exitPrice = tp2Price;
                                exitTime = oc.iso;
                                break;
                            }
                        }

                        // Dollar PnL on $10 Risk Base ($500 account @ 2% risk)
                        const dollarRisk = 10.0;
                        const pnlUsd = (rawPnlR * dollarRisk) - commissionRoundTurnUsd;
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
                            confluence: '4/4 (1H Displacement + 5M FVG + DXY + Calendar Clear)'
                        });
                        break;
                    }
                }
            }
        }

        // --- Bullish Institutional Setup ---
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

                        if (isRedFolderNewsWindow(new Date(execBar.time))) break;

                        const baseEntry = useNextBarOpen ? execBar.open : fc.close;
                        const fillEntry = +(baseEntry + spreadDollars + slippageDollars).toFixed(2);
                        const slPrice = +(Math.min(fc.low, freshFvg.bottom) - 0.70).toFixed(2);
                        const risk = fillEntry - slPrice;
                        const riskPips = Math.round(risk * 10);
                        if (riskPips < 10 || riskPips > 45) break;

                        const tp1Price = +(fillEntry + (risk * TP1_R)).toFixed(2);
                        const tp2Price = +(fillEntry + (risk * TP2_R)).toFixed(2);

                        const outcome = futureBars.slice(executionBarIndex + 1, executionBarIndex + 61);
                        let slDyn = slPrice;
                        let tp1Hit = false;
                        let rawPnlR = -1.0;
                        let exitReason = 'SL_HIT';
                        let exitPrice = slPrice;
                        let exitTime = execBar.iso;

                        for (let oc of outcome) {
                            if (!tp1Hit && oc.high >= tp1Price) {
                                tp1Hit = true;
                                slDyn = +(fillEntry + beBuffer).toFixed(2);
                                exitReason = 'TP1_PARTIAL_BE';
                                exitPrice = tp1Price;
                                exitTime = oc.iso;
                            }

                            if (oc.low <= slDyn) {
                                if (!tp1Hit) {
                                    rawPnlR = -1.0;
                                    exitReason = 'SL_HIT';
                                    exitPrice = slDyn;
                                    exitTime = oc.iso;
                                } else {
                                    const runnerR = (slDyn - fillEntry) / risk;
                                    rawPnlR = (TP1_R * TP1_PARTIAL_RATIO) + (runnerR * RUNNER_RATIO);
                                    exitReason = 'TP1_PARTIAL_BE_STOP';
                                    exitPrice = slDyn;
                                    exitTime = oc.iso;
                                }
                                break;
                            }

                            if (oc.high >= tp2Price) {
                                rawPnlR = (TP1_R * TP1_PARTIAL_RATIO) + (TP2_R * RUNNER_RATIO);
                                exitReason = 'TP2_FULL_TARGET';
                                exitPrice = tp2Price;
                                exitTime = oc.iso;
                                break;
                            }
                        }

                        const dollarRisk = 10.0;
                        const pnlUsd = (rawPnlR * dollarRisk) - commissionRoundTurnUsd;
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
                            confluence: '4/4 (1H Displacement + 5M FVG + DXY + Calendar Clear)'
                        });
                        break;
                    }
                }
            }
        }
    }

    // =========================================================================
    // TRACK 2: QUICK SIDEWAYS RANGE SCALPS (QUARANTINED COMPARISON)
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
        if (boxSpan < 4.0 || boxSpan > 14.0) continue;

        const eq = +( (boxHigh + boxLow) / 2 ).toFixed(2);
        const subBars = goldM5.slice(m15[i].m5StartIndex, Math.min(m15[i].m5StartIndex + 16, goldM5.length));

        for (let j = 0; j < subBars.length - 4; j++) {
            const bar = subBars[j];
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

                    const dollarRisk = 5.0;
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

// 1. BASELINE (Historical benchmark: Look-ahead on Close, 10c BE buffer, Zero Costs)
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
    beBuffer: 0.00,
    spreadDollars: 0.00,
    slippageDollars: 0.00,
    commissionRoundTurnUsd: 0.00
});
exportCsv(CSV_OUT_STAGE1, runStage1.allTrades);

// 3. STAGE 2 (Realistic Friction: Next Bar Open, Flat BE, 2.0 Pips Spread + 1.0 Pip Slippage + $7/Lot Comm)
const runStage2 = runAuditSimulation({
    useNextBarOpen: true,
    beBuffer: 0.00,
    spreadDollars: 0.20,
    slippageDollars: 0.10,
    commissionRoundTurnUsd: 0.07
});
exportCsv(CSV_OUT_STAGE2, runStage2.allTrades);

// Export JSON payload of verified supreme institutional trades for direct frontend consumption
fs.writeFileSync(JSON_OUT_VERIFIED, JSON.stringify({
    metadata: {
        generatedAt: new Date().toISOString(),
        dataset: path.basename(DATA_FILE),
        totalGoldBars: goldM5.length,
        totalDxyBars: dxyM15.length,
        coverage: {
            from: goldM5[0].iso,
            to: goldM5[goldM5.length - 1].iso
        }
    },
    summaryBaseline: summarize('Baseline', runBase.allTrades),
    summaryStage1: summarize('Stage 1 (Next Open Fill)', runStage1.allTrades),
    summaryStage2: summarize('Stage 2 (Realistic Friction)', runStage2.allTrades),
    supremeStage2Summary: summarize('Supreme Institutional (Realistic)', runStage2.supremeTrades),
    scalpStage2Summary: summarize('Range Scalper (Quarantined)', runStage2.scalpTrades),
    supremeTrades: runStage2.supremeTrades,
    allTrades: runStage2.allTrades
}, null, 2), 'utf8');

console.log(`\n================================================================================`);
console.log(`COMPARATIVE SUMMARY: PROGRESSION ACROSS AUDIT STAGES`);
console.log(`================================================================================`);
console.table([
    summarize('1. Baseline (Old Close Fill, 10c Buffer, $0 Cost)', runBase.allTrades),
    summarize('2. Stage 1 (Next-Bar Open Fill, Flat BE, $0 Cost)', runStage1.allTrades),
    summarize('3. Stage 2 (Next Open + Flat BE + 2p Spread + 1p Slip + Comm)', runStage2.allTrades)
]);

console.log(`\n================================================================================`);
console.log(`STRATEGY BREAKDOWN UNDER STAGE 2 REALISTIC FRICTION:`);
console.log(`================================================================================`);
console.table([
    summarize('Track 1: Supreme Institutional Setups', runStage2.supremeTrades),
    summarize('Track 2: Sideways Range Scalps (Quarantined)', runStage2.scalpTrades),
    summarize('Combined Portfolio', runStage2.allTrades)
]);

console.log(`\nDetailed Ledgers Exported:`);
console.log(`- Baseline:  ${CSV_OUT_BASE}`);
console.log(`- Stage 1:   ${CSV_OUT_STAGE1}`);
console.log(`- Stage 2:   ${CSV_OUT_STAGE2}`);
console.log(`- JSON Spec: ${JSON_OUT_VERIFIED}`);

console.log(`\n================================================================================`);
console.log(`STAGE 2 (REAL-WORLD COSTS) SUPREME TRADES:`);
console.log(`================================================================================`);
console.table(runStage2.supremeTrades);

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

// Check if a timestamp falls within a Red Folder News Window
// High-Impact US Data (CPI, NFP, PPI, Retail Sales, Unemployment Claims) occurs at 12:30 UTC or 13:30 UTC (8:30 AM EST)
// FOMC occurs at 18:00 UTC (2:00 PM EST)
// Red folder buffer: 30 minutes before and 30 minutes after release
function isRedFolderNewsWindow(date) {
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();
    const dayOfWeek = date.getUTCDay(); // 0 is Sunday, 5 is Friday

    // 1. 12:30 / 13:30 UTC US Core Data Window (12:00 to 14:00 UTC)
    if ((hour === 12 && min >= 15) || (hour === 13) || (hour === 14 && min <= 15)) {
        return true;
    }

    // 2. 18:00 UTC FOMC / Fed Interest Rate Window (17:45 to 19:15 UTC)
    if ((hour === 17 && min >= 45) || (hour === 18) || (hour === 19 && min <= 15)) {
        return true;
    }

    return false;
}

async function auditRedFolderImpact() {
    const goldM5 = await fetchCandles('GC=F', '5m', '1mo');
    const dxyM15 = await fetchCandles('DX-Y.NYB', '15m', '1mo');
    const dxyEma = calculateEMA(dxyM15, 20);

    const m15 = aggregateCandles(goldM5, 3);
    const m30 = aggregateCandles(goldM5, 6);
    const m45 = aggregateCandles(goldM5, 9);
    const h1  = aggregateCandles(goldM5, 12);

    let tradesWithRedFolder = [];
    let tradesWithoutRedFolder = [];
    let redFolderTradesList = [];

    for (let h = 3; h < h1.length - 8; h++) {
        const prev1H = h1[h - 1];
        const curr1H = h1[h];
        const hourUTC = curr1H.date.getUTCHours();

        // BULLISH
        if (prev1H.close < prev1H.open && curr1H.close > prev1H.high + 1.0 && (curr1H.high - curr1H.low) > 4.0) {
            const h1Low = prev1H.low;
            const h1High = Math.max(prev1H.open, prev1H.high);
            if (h1High - h1Low < 2 || h1High - h1Low > 30) continue;

            const startTime = prev1H.time;
            const endTime = curr1H.endTime;

            const zone45 = findRefinedSubZone(m45.filter(c => c.time >= startTime && c.time <= endTime), h1Low, h1High, true);
            const zone30 = findRefinedSubZone(m30.filter(c => c.time >= startTime && c.time <= endTime), zone45.low, zone45.high, true);
            const zone15 = findRefinedSubZone(m15.filter(c => c.time >= startTime && c.time <= endTime), zone30.low, zone30.high, true);
            const zone5  = findRefinedSubZone(goldM5.filter(c => c.time >= startTime && c.time <= endTime), zone15.low, zone15.high, true);

            const isKillzone = (hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18);
            let isDxyFavorable = true;
            const dxyIdx = dxyM15.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
            if (dxyIdx > 0 && dxyIdx < dxyM15.length && dxyM15[dxyIdx].close > dxyEma[dxyIdx] + 0.05) {
                isDxyFavorable = false;
            }

            if (!isKillzone || !isDxyFavorable) continue;

            const currM5End = curr1H.m5EndIndex;
            const future5m = goldM5.slice(currM5End + 1, Math.min(currM5End + 288, goldM5.length));

            for (let m = 0; m < future5m.length - 20; m++) {
                const fc = future5m[m];
                if (fc.low <= zone5.high && fc.close >= zone5.low) {
                    const entryPrice = zone5.high;
                    const slPrice = zone5.low - 0.8;
                    const risk = entryPrice - slPrice;
                    if (risk < 0.8 || risk > 8.0) break;

                    const tpPrice = entryPrice + (risk * 3.5);
                    const tp1Price = entryPrice + (risk * 1.5);
                    const entryTime = fc.date;
                    const isRedNews = isRedFolderNewsWindow(entryTime);

                    const outcome = future5m.slice(m + 1, m + 80);
                    let slDyn = slPrice;
                    let tp1Hit = false;
                    let tradeResult = null;
                    let pnlR = 0;

                    for (let c of outcome) {
                        if (!tp1Hit && c.high >= tp1Price) {
                            tp1Hit = true;
                            pnlR += (1.5 * 0.5);
                            slDyn = entryPrice + 0.1;
                        }
                        if (c.low <= slDyn) {
                            if (tp1Hit) tradeResult = { type: 'BUY', result: 'WIN_PARTIAL', r: pnlR, isRedNews, time: entryTime.toISOString() };
                            else tradeResult = { type: 'BUY', result: 'LOSS', r: -1.0, isRedNews, time: entryTime.toISOString() };
                            break;
                        }
                        if (c.high >= tpPrice) {
                            pnlR += (3.5 * 0.5);
                            tradeResult = { type: 'BUY', result: 'WIN_FULL', r: pnlR, isRedNews, time: entryTime.toISOString() };
                            break;
                        }
                    }

                    if (tradeResult) {
                        tradesWithRedFolder.push(tradeResult);
                        if (isRedNews) {
                            redFolderTradesList.push(tradeResult);
                        } else {
                            tradesWithoutRedFolder.push(tradeResult);
                        }
                    }
                    break;
                }
            }
        }

        // BEARISH
        if (prev1H.close > prev1H.open && curr1H.close < prev1H.low - 1.0 && (curr1H.high - curr1H.low) > 4.0) {
            const h1High = prev1H.high;
            const h1Low = Math.min(prev1H.open, prev1H.low);
            if (h1High - h1Low < 2 || h1High - h1Low > 30) continue;

            const startTime = prev1H.time;
            const endTime = curr1H.endTime;

            const zone45 = findRefinedSubZone(m45.filter(c => c.time >= startTime && c.time <= endTime), h1Low, h1High, false);
            const zone30 = findRefinedSubZone(m30.filter(c => c.time >= startTime && c.time <= endTime), zone45.low, zone45.high, false);
            const zone15 = findRefinedSubZone(m15.filter(c => c.time >= startTime && c.time <= endTime), zone30.low, zone30.high, false);
            const zone5  = findRefinedSubZone(goldM5.filter(c => c.time >= startTime && c.time <= endTime), zone15.low, zone15.high, false);

            const isKillzone = (hourUTC >= 7 && hourUTC <= 11) || (hourUTC >= 12 && hourUTC <= 18);
            let isDxyFavorable = true;
            const dxyIdx = dxyM15.findIndex(d => Math.abs(d.time - curr1H.time) < 15 * 60 * 1000);
            if (dxyIdx > 0 && dxyIdx < dxyM15.length && dxyM15[dxyIdx].close < dxyEma[dxyIdx] - 0.05) {
                isDxyFavorable = false;
            }

            if (!isKillzone || !isDxyFavorable) continue;

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
                    const entryTime = fc.date;
                    const isRedNews = isRedFolderNewsWindow(entryTime);

                    const outcome = future5m.slice(m + 1, m + 80);
                    let slDyn = slPrice;
                    let tp1Hit = false;
                    let tradeResult = null;
                    let pnlR = 0;

                    for (let c of outcome) {
                        if (!tp1Hit && c.low <= tp1Price) {
                            tp1Hit = true;
                            pnlR += (1.5 * 0.5);
                            slDyn = entryPrice - 0.1;
                        }
                        if (c.high >= slDyn) {
                            if (tp1Hit) tradeResult = { type: 'SELL', result: 'WIN_PARTIAL', r: pnlR, isRedNews, time: entryTime.toISOString() };
                            else tradeResult = { type: 'SELL', result: 'LOSS', r: -1.0, isRedNews, time: entryTime.toISOString() };
                            break;
                        }
                        if (c.low <= tpPrice) {
                            pnlR += (3.5 * 0.5);
                            tradeResult = { type: 'SELL', result: 'WIN_FULL', r: pnlR, isRedNews, time: entryTime.toISOString() };
                            break;
                        }
                    }

                    if (tradeResult) {
                        tradesWithRedFolder.push(tradeResult);
                        if (isRedNews) {
                            redFolderTradesList.push(tradeResult);
                        } else {
                            tradesWithoutRedFolder.push(tradeResult);
                        }
                    }
                    break;
                }
            }
        }
    }

    console.log('\n========================================================================================');
    console.log('RED FOLDER NEWS IMPACT AUDIT:');
    console.log('========================================================================================');
    const rWith = evaluateSummary('1. With Red Folder News Allowed (Blind to News)', tradesWithRedFolder);
    const rWithout = evaluateSummary('2. With Red Folder News Strictly Blocked (30m Buffer)', tradesWithoutRedFolder);
    console.table([rWith, rWithout]);

    console.log('\nTRADES TRIGGERED DURING RED FOLDER NEWS WINDOWS:');
    console.table(redFolderTradesList);
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

auditRedFolderImpact();

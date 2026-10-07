/* AlgoLens analytics engine — computes strategy metrics from a daily cumulative-P&L series.
 * Input: series = [[ 'YYYY-MM-DD', cumulativePnl ], ...] (sorted), capital = number (₹)
 * Works in the browser (window.AlgoLens) and in Node (module.exports). No dependencies. */
(function (root) {
  const TD = 252; // trading days per year

  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
  function stdev(a) { // sample standard deviation (matches Tradetron)
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  }
  const dayMs = 864e5;
  const toDate = (s) => new Date(s + 'T00:00:00Z');
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / dayMs);

  function analyze(series, capital) {
    if (!series || !series.length) return null;
    const dates = series.map((r) => r[0]);
    const cum = series.map((r) => r[1]);
    const daily = cum.map((v, i) => (i ? v - cum[i - 1] : v));
    const rets = daily.map((d) => d / capital);

    // Drawdown (₹, % of capital+peak as Tradetron does, and % of capital)
    let peak = 0, peakDate = dates[0], maxDD = 0, maxDDPct = 0, ddStart = null, ddTrough = null;
    let longestDDDays = 0, curDDStart = null;
    const ddSeries = [];
    const ddPeriods = [];
    for (let i = 0; i < cum.length; i++) {
      if (cum[i] >= peak) {
        if (curDDStart !== null) {
          const len = daysBetween(curDDStart, dates[i]);
          ddPeriods.push({ start: curDDStart, end: dates[i], days: len, depth: ddPeriods._depth || 0 });
          longestDDDays = Math.max(longestDDDays, len);
          curDDStart = null; ddPeriods._depth = 0;
        }
        peak = cum[i]; peakDate = dates[i];
      } else {
        if (curDDStart === null) curDDStart = peakDate;
        ddPeriods._depth = Math.max(ddPeriods._depth || 0, peak - cum[i]);
      }
      const dd = peak - cum[i];
      const ddPct = dd / (capital + peak) * 100;
      ddSeries.push(-ddPct);
      if (dd > maxDD) { maxDD = dd; ddStart = peakDate; ddTrough = dates[i]; }
      maxDDPct = Math.max(maxDDPct, ddPct);
    }
    const inDrawdownNow = curDDStart !== null;
    if (inDrawdownNow) {
      const len = daysBetween(curDDStart, dates[dates.length - 1]);
      longestDDDays = Math.max(longestDDDays, len);
      ddPeriods.push({ start: curDDStart, end: null, days: len, depth: ddPeriods._depth || 0 });
    }
    const currentDD = peak - cum[cum.length - 1];
    // Recovery of the max drawdown
    let maxDDRecovered = null;
    if (ddTrough) {
      const peakVal = cum[dates.indexOf(ddStart)];
      for (let i = dates.indexOf(ddTrough); i < cum.length; i++) if (cum[i] >= peakVal) { maxDDRecovered = dates[i]; break; }
    }

    // Win / loss days (flat days excluded)
    const wins = daily.filter((d) => d > 0), losses = daily.filter((d) => d < 0);
    let streakW = 0, streakL = 0, maxW = 0, maxL = 0;
    for (const d of daily) {
      if (d > 0) { streakW++; streakL = 0; } else if (d < 0) { streakL++; streakW = 0; }
      maxW = Math.max(maxW, streakW); maxL = Math.max(maxL, streakL);
    }
    const grossWin = wins.reduce((s, x) => s + x, 0), grossLoss = -losses.reduce((s, x) => s + x, 0);

    // Risk-adjusted
    const sd = stdev(rets);
    const negRets = rets.filter((r) => r < 0);
    const sharpe = sd ? mean(rets) / sd * Math.sqrt(TD) : 0;
    const sortino = negRets.length > 1 ? mean(rets) / stdev(negRets) * Math.sqrt(TD) : 0;
    const total = cum[cum.length - 1];
    const years = Math.max(daysBetween(dates[0], dates[dates.length - 1]) / 365.25, 1 / 365.25);
    const annualReturnPct = total / capital / years * 100; // simple (non-compounded) annualised ROI on capital
    const maxDDCapPct = maxDD / capital * 100;
    const calmar = maxDDCapPct ? annualReturnPct / maxDDCapPct : 0;

    // Monthly & yearly
    const monthly = {}, yearly = {};
    dates.forEach((d, i) => {
      const m = d.slice(0, 7), y = d.slice(0, 4);
      monthly[m] = (monthly[m] || 0) + daily[i];
      yearly[y] = (yearly[y] || 0) + daily[i];
    });
    const monthVals = Object.values(monthly);
    const posMonths = monthVals.filter((v) => v > 0).length;

    // Day of week
    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow = {};
    dates.forEach((d, i) => {
      const k = dowNames[toDate(d).getUTCDay()];
      const o = dow[k] || (dow[k] = { pnl: 0, days: 0, wins: 0 });
      o.pnl += daily[i]; o.days++; if (daily[i] > 0) o.wins++;
    });

    // Trailing windows
    const last = dates[dates.length - 1];
    function since(daysBack) {
      const cutoff = new Date(toDate(last) - daysBack * dayMs).toISOString().slice(0, 10);
      let base = 0;
      for (let i = 0; i < dates.length; i++) { if (dates[i] > cutoff) break; base = cum[i]; }
      if (dates[0] > cutoff) return null; // not enough history
      return total - base;
    }
    const ytdBase = (() => { let b = 0; const y = last.slice(0, 4); for (let i = 0; i < dates.length; i++) { if (dates[i].slice(0, 4) === y) break; b = cum[i]; } return b; })();

    let bestDay = 0, worstDay = 0, bestDate = null, worstDate = null;
    daily.forEach((d, i) => { if (d > bestDay) { bestDay = d; bestDate = dates[i]; } if (d < worstDay) { worstDay = d; worstDate = dates[i]; } });

    return {
      capital, start: dates[0], end: last, tradingDays: dates.length, years,
      totalPnl: total, roiPct: total / capital * 100, annualReturnPct,
      avgMonthlyPnl: mean(monthVals), avgMonthlyRoiPct: mean(monthVals) / capital * 100,
      maxDD, maxDDPct, maxDDCapPct, maxDDStart: ddStart, maxDDTrough: ddTrough, maxDDRecovered,
      currentDD, currentDDPct: currentDD / (capital + peak) * 100, inDrawdownNow,
      longestDDDays, ddPeriods: ddPeriods.sort((a, b) => b.depth - a.depth).slice(0, 5),
      volAnnPct: sd * Math.sqrt(TD) * 100, sharpe, sortino, calmar,
      winDays: wins.length, lossDays: losses.length, flatDays: daily.length - wins.length - losses.length,
      winRatePct: wins.length / Math.max(1, wins.length + losses.length) * 100,
      avgWin: mean(wins), avgLoss: mean(losses), payoff: losses.length ? mean(wins) / -mean(losses) : 0,
      profitFactor: grossLoss ? grossWin / grossLoss : 0, expectancy: mean(daily),
      bestDay, bestDate, worstDay, worstDate, maxWinStreak: maxW, maxLossStreak: maxL,
      monthsPositivePct: posMonths / Math.max(1, monthVals.length) * 100,
      pnl30: since(30), pnl90: since(90), pnl365: since(365), pnlYtd: total - ytdBase,
      monthly, yearly, dow, daily, cum, dates, ddSeries
    };
  }

  // Combine several strategies into one portfolio (sum of daily P&L on the union of dates)
  function combine(list) {
    const byDate = new Map();
    let capital = 0;
    for (const { series, capital: c, weight = 1 } of list) {
      capital += c * weight;
      series.forEach((r, i) => {
        const d = (i ? r[1] - series[i - 1][1] : r[1]) * weight;
        byDate.set(r[0], (byDate.get(r[0]) || 0) + d);
      });
    }
    const dates = [...byDate.keys()].sort();
    let c = 0;
    return { capital, series: dates.map((d) => [d, (c += byDate.get(d))]) };
  }

  // Pairwise correlation of daily returns on shared dates
  function correlation(a, b) {
    const da = new Map(a.map((r, i) => [r[0], i ? r[1] - a[i - 1][1] : r[1]]));
    const xs = [], ys = [];
    b.forEach((r, i) => { if (da.has(r[0])) { xs.push(da.get(r[0])); ys.push(i ? r[1] - b[i - 1][1] : r[1]); } });
    if (xs.length < 20) return null;
    const mx = mean(xs), my = mean(ys);
    let num = 0, sx = 0, sy = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
    return sx && sy ? num / Math.sqrt(sx * sy) : null;
  }

  const api = { analyze, combine, correlation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AlgoLens = api;
})(typeof window !== 'undefined' ? window : globalThis);

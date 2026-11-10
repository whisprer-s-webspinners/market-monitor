"use strict";

const $ = id => document.getElementById(id);
const colours = ["#79ebbc", "#8bc9fa", "#f8ce86", "#ceaaff", "#ff9a9c", "#e2a9df"];
const groups = [
  ["EVALUATION REFERENCES", ["btc", "spx", "copper"]],
  ["CRYPTO & DOLLAR", ["eth", "crypto", "usd", "gbp"]],
  ["GLOBAL EQUITIES", ["ftse", "nikkei", "world"]],
  ["PRECIOUS METALS", ["gold", "silver"]]
];
const intraday = new Set(["1h", "1d"]);
const state = {
  mode: "chart", asset: "btc", range: "1d", line: false, data: null,
  selected: ["btc", "spx", "copper"], request: 0, lastCheck: 0, renderKey: "", cross: null
};
const names = {
  btc: "Bitcoin", spx: "S&P 500", copper: "Copper", eth: "Ethereum", crypto: "Crypto basket",
  usd: "US Dollar Index", gbp: "GBP/USD", ftse: "FTSE 100", nikkei: "Nikkei 225",
  world: "Global equities", gold: "Gold", silver: "Silver"
};
const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const fullStamp = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
});
const dateLabel = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
});
const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const utcTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC"
});
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function number(value, digits = 2) {
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function pct(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(digits));
  return (rounded > 0 ? "+" : "") + (Object.is(rounded, -0) ? number(0, digits) : number(rounded, digits)) + "%";
}
function dayLabel(day) { return dateLabel.format(Date.parse(day + "T00:00:00Z")); }
function price(value, unit, showUnits = false) {
  if (!Number.isFinite(value)) return "—";
  const decimals = unit === "USD per £" ? 4 : unit === "USD/lb" ? 3 : 2;
  const amount = number(value, decimals);
  if (!showUnits) return (unit.startsWith("USD") ? "$" : "") + amount;
  if (unit === "USD") return "$" + amount;
  return amount + " " + unit;
}
function signed(el, value) {
  el.classList.toggle("pos", value > 0);
  el.classList.toggle("neg", value < 0);
}
function svg(name, attrs = {}, content) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (content !== undefined) node.textContent = content;
  return node;
}
function el(name, cls, value) {
  const node = document.createElement(name);
  if (cls) node.className = cls;
  if (value !== undefined) node.textContent = value;
  return node;
}
function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}
function quoteAge(quote, now) {
  const delta = Math.max(0, Math.floor((now - quote.stamp) / 60));
  if (delta < 1) return "<1m old";
  if (delta < 60) return delta + "m old";
  if (delta < 1440) return Math.floor(delta / 60) + "h old";
  return Math.floor(delta / 1440) + "d old";
}

const watchRows = {};
for (const [group, keys] of groups) {
  $("watchlist").append(el("div", "group-title", group));
  for (const key of keys) {
    const row = el("button", "asset");
    row.type = "button";
    const value = el("span", "asset-price mono", "—");
    const time = el("span", "asset-stamp", "Awaiting feed");
    const change = el("span", "asset-change mono", "—");
    row.append(el("span", "asset-name", names[key]), value, time, change);
    row.addEventListener("click", () => {
      state.asset = key;
      state.mode = "chart";
      changeView();
      if (matchMedia("(max-width: 650px)").matches) $("chart").closest(".market").scrollIntoView({ block: "start" });
    });
    $("watchlist").append(row);
    watchRows[key] = { row, value, time, change };
  }
}
const compareBoxes = {};
for (const key of Object.keys(watchRows)) {
  const label = el("label");
  const input = el("input");
  input.type = "checkbox";
  input.checked = state.selected.includes(key);
  input.addEventListener("change", () => {
    state.selected = Object.keys(compareBoxes).filter(asset => compareBoxes[asset].checked);
    changeView();
  });
  compareBoxes[key] = input;
  label.append(input, document.createTextNode(names[key]));
  $("compare-picker").append(label);
}

function controls() {
  const comparing = state.mode === "compare";
  const dailyOnly = comparing || state.asset === "crypto";
  for (const button of $("modes").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.mode === state.mode);
  }
  for (const button of $("ranges").querySelectorAll("button")) {
    button.disabled = dailyOnly && intraday.has(button.dataset.range);
    button.setAttribute("aria-pressed", button.dataset.range === state.range);
  }
  $("compare-picker").hidden = !comparing;
  $("style-toggle").hidden = dailyOnly;
  $("style-toggle").textContent = state.line ? "Use candles" : "Use line";
  $("style-toggle").setAttribute("aria-pressed", state.line);
  $("scenario-panel").hidden = comparing || state.asset === "crypto";
  for (const [key, items] of Object.entries(watchRows)) {
    items.row.setAttribute("aria-pressed", !comparing && key === state.asset);
  }
  for (const [key, box] of Object.entries(compareBoxes)) {
    const selected = state.selected.includes(key);
    box.disabled = (selected && state.selected.length <= 2) || (!selected && state.selected.length >= 6);
  }
}

function changeView() {
  if ((state.mode === "compare" || state.asset === "crypto") && intraday.has(state.range)) state.range = "1w";
  state.data = null;
  state.renderKey = "";
  state.cross = null;
  controls();
  render();
  refresh();
}
$("modes").addEventListener("click", event => {
  if (event.target.dataset.mode && state.mode !== event.target.dataset.mode) {
    state.mode = event.target.dataset.mode;
    changeView();
  }
});
$("ranges").addEventListener("click", event => {
  if (event.target.dataset.range && state.range !== event.target.dataset.range) {
    state.range = event.target.dataset.range;
    changeView();
  }
});
$("style-toggle").addEventListener("click", () => {
  state.line = !state.line;
  controls();
  renderPlot();
});
$("refresh").addEventListener("click", () => refresh());

async function refresh() {
  const request = ++state.request;
  state.lastCheck = Date.now();
  const query = new URLSearchParams({
    asset: state.asset, range: state.range, view: state.mode, series: state.selected.join(",")
  });
  const refreshButton = $("refresh");
  refreshButton.disabled = true;
  try {
    const response = await fetch("/api/market?" + query, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Market data request failed");
    const data = await response.json();
    if (request !== state.request) return;
    state.data = data;
    render();
  } catch {
    if (request !== state.request) return;
    setText($("feed-status"), "Local dashboard connection unavailable. Check the launcher window.");
    $("feed-dot").classList.add("warn");
    if (!state.data) placeholder("Waiting for the local app.");
  } finally {
    if (request === state.request) refreshButton.disabled = false;
  }
}

function render() {
  const data = state.data;
  const comparing = state.mode === "compare";
  const asset = data?.assets[state.asset];
  $("symbol").textContent = comparing ? "NORMALISED PRICE RETURN" : asset?.symbol || (state.asset === "crypto" ? "5-COIN PROXY" : "");
  $("asset-name").textContent = comparing ? "Compare markets" : names[state.asset];
  $("asset-note").textContent = comparing
    ? "Daily closes rebased to the first date all selected markets share."
    : asset?.note || "";
  $("quote").textContent = comparing ? "%" : price(asset?.quote?.price, asset?.unit, true);
  $("quote-time").textContent = comparing ? "Price returns in native units" : asset?.quote
    ? asset.quote.stamp ? fullStamp.format(asset.quote.stamp * 1000) + " · " + quoteAge(asset.quote, data.now)
      : "Daily bar · " + dayLabel(asset.quote.day)
    : "";
  $("quote").hidden = !comparing && state.asset === "crypto";
  $("quote-time").hidden = !comparing && state.asset === "crypto";
  if (data) {
    $("demo").hidden = !data.demo;
    const quoteCount = Object.values(data.assets).filter(item => item.quote).length;
    const warn = Boolean(data.backoff || data.errors.length);
    const status = data.demo ? "Offline demonstration · no Yahoo requests" :
      data.backoff ? "Yahoo rate limited · retry in about " + Math.ceil(data.backoff / 60) + " min · showing available cached data" :
      data.errors.length ? "Some data unavailable · showing available cached data" :
      data.queued ? "Updating " + data.queued + " series · cached data shown where available" :
      quoteCount ? "Active intraday series checked up to every 60s · watchlist up to every 5 min" :
      "Waiting for Yahoo prices";
    setText($("feed-status"), status);
    $("feed-dot").classList.toggle("warn", warn);
    for (const [key, { value, time, change }] of Object.entries(watchRows)) {
      const item = data.assets[key];
      const quote = item.quote;
      setText(value, key === "crypto" && quote ? "Daily proxy" : price(quote?.price, item.unit));
      setText(time, quote ? quote.stamp ? fullStamp.format(quote.stamp * 1000) + " · " + quoteAge(quote, data.now)
        : "Daily · " + dayLabel(quote.day) : "Awaiting feed");
      setText(change, pct(quote?.change));
      signed(change, quote?.change);
    }
  }
  renderPlot();
  renderModel();
}

function legend(items) {
  $("chart-key").replaceChildren(...items.map(([text, color]) => {
    const node = el("span", "legend-item");
    const sample = svg("svg", { width: 15, height: 8, "aria-hidden": "true" });
    sample.append(svg("path", { d: "M0 4h15", stroke: color, "stroke-width": 2 }));
    node.append(sample, document.createTextNode(text));
    return node;
  }));
}
function placeholder(message) {
  state.cross = null;
  $("chart").replaceChildren(el("div", "placeholder", message));
}
function surface(target, label, height = null) {
  const width = Math.max(240, target.clientWidth);
  height ??= Math.max(140, target.clientHeight);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label });
  target.replaceChildren(root);
  return { root, width, height };
}
function grid(chart, values, percent) {
  const { root, width, height } = chart;
  const top = 15;
  const bottom = height - 28;
  const left = 12;
  const right = width - (width < 420 ? 65 : 78);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = (hi - lo) * .075 || Math.max(Math.abs(hi) * .004, .0001);
  lo -= pad;
  hi += pad;
  const y = value => bottom - (value - lo) / (hi - lo) * (bottom - top);
  for (let i = 0; i <= 4; i++) {
    const tick = lo + (hi - lo) * i / 4;
    const ty = y(tick);
    const digits = Math.abs(hi) < 10 || hi - lo < 1 ? 3 : Math.abs(hi) < 200 ? 2 : 1;
    const label = percent ? pct(tick, 1) : number(tick, digits);
    root.append(svg("line", { x1: left, y1: ty, x2: right, y2: ty, class: "grid" }),
      svg("text", { x: right + 6, y: ty + 3, class: "axis" }, label));
  }
  if (percent && lo < 0 && hi > 0) {
    root.append(svg("line", { x1: left, x2: right, y1: y(0), y2: y(0), stroke: "#536579", "stroke-dasharray": "3 4" }));
  }
  return { root, left, right, top, bottom, y, width };
}
function line(root, points, color, width = 1.5) {
  if (points.length < 2) {
    for (const [cx, cy] of points) root.append(svg("circle", { cx, cy, r: 2.5, fill: color }));
    return;
  }
  root.append(svg("polyline", {
    points: points.map(point => point.map(n => n.toFixed(2)).join(",")).join(" "),
    fill: "none", stroke: color, "stroke-width": width,
    "stroke-linecap": "round", "stroke-linejoin": "round"
  }));
}
function xLabels(area, count, getLabel, getX) {
  const divisions = Math.min(count - 1, area.width < 460 ? 3 : 5);
  for (let i = 0; i <= divisions; i++) {
    const index = divisions ? Math.round(i * (count - 1) / divisions) : 0;
    const anchor = !i ? "start" : i === divisions ? "end" : "middle";
    area.root.append(svg("text", { x: getX(index), y: area.bottom + 18, class: "axis", "text-anchor": anchor }, getLabel(index)));
  }
}
function crosshair(area, max, getX, labels) {
  const { root, top, bottom, left, right, width } = area;
  const group = svg("g", { class: "chart-tooltip", visibility: "hidden" });
  const guide = svg("line", { y1: top, y2: bottom, stroke: "#8298ad", "stroke-dasharray": "3 3" });
  const rect = svg("rect", { rx: 6, fill: "#182838", stroke: "#3a5269" });
  const labelGroup = svg("g");
  group.append(guide, rect, labelGroup);
  root.append(group);
  state.cross = {
    index: null,
    max,
    nearest(clientX) {
      const bounds = root.getBoundingClientRect();
      const cursor = (clientX - bounds.left) * width / bounds.width;
      let best = 0;
      for (let i = 1; i <= max; i++) {
        if (Math.abs(getX(i) - cursor) < Math.abs(getX(best) - cursor)) best = i;
      }
      return best;
    },
    show(index) {
      this.index = index;
      const at = getX(index);
      const rows = labels(index);
      const w = Math.min(width - 15, Math.max(...rows.map(row => row.length)) * 7 + 16);
      const x = Math.max(left, Math.min(at + 9 + w <= right ? at + 9 : at - w - 9, width - w - 4));
      guide.setAttribute("x1", at);
      guide.setAttribute("x2", at);
      rect.setAttribute("x", x);
      rect.setAttribute("y", top + 5);
      rect.setAttribute("width", w);
      rect.setAttribute("height", rows.length * 15 + 9);
      labelGroup.replaceChildren(...rows.map((text, row) => svg("text", { x: x + 8, y: top + 19 + row * 15 }, text)));
      group.setAttribute("visibility", "visible");
      $("chart").setAttribute("aria-label", rows.join(". ") + ". Use arrow keys to inspect.");
    },
    hide() {
      this.index = null;
      group.setAttribute("visibility", "hidden");
      $("chart").setAttribute("aria-label", "Market chart. Use arrow keys to inspect.");
    }
  };
}

function drawCandles(bars, unit, kind, asLine) {
  const values = bars.flatMap(bar => (asLine ? [bar[4], bar[6], bar[7]] : [bar[2], bar[3], bar[6], bar[7]])
    .filter(Number.isFinite));
  const area = grid(surface($("chart"), names[state.asset] + " price history"), values, false);
  const { root, left, right, y } = area;
  const dx = (right - left) / bars.length;
  const x = i => left + (i + .5) * dx;
  if (asLine) {
    line(root, bars.map((bar, i) => [x(i), y(bar[4])]), colours[0], 1.7);
  } else {
    const w = Math.min(11, Math.max(1, dx * .66));
    const wicks = [[], []];
    const bodies = [[], []];
    bars.forEach((bar, i) => {
      const [, opened, high, low, close] = bar;
      const direction = close >= opened ? 0 : 1;
      const at = x(i);
      const top = y(Math.max(opened, close));
      const h = Math.max(1, Math.abs(y(opened) - y(close)));
      wicks[direction].push(`M${at} ${y(high)}V${y(low)}`);
      bodies[direction].push(`M${at - w / 2} ${top}h${w}v${h}h-${w}Z`);
    });
    for (const [index, color] of [colours[0], colours[4]].entries()) {
      root.append(svg("path", { d: wicks[index].join(""), stroke: color, "stroke-width": .9, fill: "none" }),
        svg("path", { d: bodies[index].join(""), fill: color }));
    }
  }
  for (const [index, color] of [[6, colours[1]], [7, colours[2]]]) {
    line(root, bars.flatMap((bar, i) => bar[index] === null ? [] : [[x(i), y(bar[index])]]), color);
  }
  const dates = kind === "daily";
  xLabels(area, bars.length, i => dates ? bars[i][5].slice(5) :
    (intraday.has(state.range) ? hm : shortDate).format(bars[i][0] * 1000), x);
  crosshair(area, bars.length - 1, x, i => {
    const [stamp, opened, high, low, close, day, sma20, sma50] = bars[i];
    const f = value => price(value, unit);
    const date = dates ? dayLabel(day) : fullStamp.format(stamp * 1000);
    const rows = [date, "Close " + f(close)];
    if (!asLine) rows.push("Open " + f(opened), "High " + f(high), "Low  " + f(low));
    if (sma20 !== null) rows.push("SMA20 " + f(sma20));
    if (sma50 !== null) rows.push("SMA50 " + f(sma50));
    return rows;
  });
}

function drawCompare(series) {
  const values = Object.values(series).flatMap(points => points.map(point => point[1]));
  const area = grid(surface($("chart"), "Normalised price return by market"), values, true);
  const dates = [...new Set(Object.values(series).flatMap(points => points.map(point => point[0])))].sort();
  const start = Date.parse(dates[0]);
  const end = Date.parse(dates.at(-1));
  const x = day => area.left + (end === start ? .5 : (Date.parse(day) - start) / (end - start)) * (area.right - area.left);
  const valuesByDay = {};
  state.selected.forEach((key, i) => {
    valuesByDay[key] = new Map(series[key]);
    line(area.root, series[key].map(([day, value]) => [x(day), area.y(value)]), colours[i], 1.7);
  });
  xLabels(area, dates.length, i => dates[i].slice(5), i => x(dates[i]));
  crosshair(area, dates.length - 1, i => x(dates[i]), i => [dayLabel(dates[i]), ...state.selected.map(key =>
    names[key] + "  " + pct(valuesByDay[key].get(dates[i])))]);
}

function renderPlot(force = false) {
  const data = state.data;
  const comparing = state.mode === "compare";
  const basket = state.asset === "crypto";
  const asLine = basket || state.line;
  const compare = data?.compare;
  const bars = data?.chart?.bars;
  const shown = data?.chart?.fetched;
  const currentStatus = data?.chartStatus;
  legend(comparing ? state.selected.map((key, i) => [names[key], colours[i]]) :
    [[asLine ? "Close" : "OHLC candles", colours[0]], ["SMA 20", colours[1]], ["SMA 50", colours[2]]]);
  let note;
  if (comparing) {
    note = "First common date = 0%. Returns use quoted currencies and exclude dividends. The latest daily bar may still be forming.";
    if (Object.keys(compare || {}).length) note += " Baseline " + dayLabel(Object.values(compare)[0][0][0]) + ".";
  } else {
    const step = data?.kind === "daily" ? "Daily bars" : data?.kind === "week" ? "15-minute bars" : "1-minute bars";
    note = data ? step + " · equal spacing per observed bar · averages use 20 and 50 bars." : "";
    if (basket) note += " Fixed five-coin basket rebased to 100 at the start of this view.";
    if (data?.kind === "minute") note += " Ends at the last available bar, including when markets are closed.";
    if (shown) note += " Fetched " + fullStamp.format(shown * 1000) + ".";
    if (data?.backoff || currentStatus?.errors?.length) note += " Provider update unavailable.";
  }
  setText($("chart-foot"), note);
  const key = JSON.stringify([state.asset, state.range, state.mode, asLine, state.selected, shown, compare,
    Boolean(data?.backoff), Boolean(currentStatus?.errors?.length), data?.compareReady, Boolean(data)]);
  if (!force && key === state.renderKey) return;
  state.renderKey = key;
  state.cross = null;
  if (comparing && Object.keys(compare || {}).length) {
    drawCompare(compare);
  } else if (bars?.length) {
    drawCandles(bars, data.assets[state.asset].unit, data.kind, asLine);
  } else if (data?.backoff || currentStatus?.errors?.length || (comparing && data?.errors?.length && !data.compareReady)) {
    placeholder("Yahoo has not supplied this view yet. The app will retry automatically.");
  } else if (comparing && data?.compareReady) {
    placeholder("The selected markets have no shared date in this range. Try a longer range.");
  } else if (bars && !bars.length) {
    placeholder("No candles in this lookback. Try a longer range.");
  } else {
    placeholder("Fetching this view…");
  }
}

$("chart").addEventListener("pointermove", event => {
  if (state.cross) state.cross.show(state.cross.nearest(event.clientX));
});
$("chart").addEventListener("pointerleave", () => state.cross?.hide());
$("chart").addEventListener("blur", () => state.cross?.hide());
$("chart").addEventListener("keydown", event => {
  const cross = state.cross;
  if (!cross || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = cross.index ?? cross.max;
  const target = event.key === "Home" ? 0 : event.key === "End" ? cross.max :
    Math.min(cross.max, Math.max(0, current + (event.key === "ArrowLeft" ? -1 : 1)));
  cross.show(target);
});

let modelKey = "";
function renderModel(force = false) {
  if ($("scenario-panel").hidden) return;
  const model = state.data?.forecast;
  $("scenario-result").hidden = !model;
  const key = JSON.stringify([state.asset, model]);
  if (!model) {
    modelKey = key;
    setText($("scenario-sub"), "This view needs at least 81 completed daily closes. Waiting for available daily history.");
    return;
  }
  if (!force && key === modelKey) return;
  modelKey = key;
  const unit = state.data.assets[state.asset].unit;
  setText($("scenario-sub"), "Anchored to " + dayLabel(model.day) + " close of " + price(model.base, unit, true) +
    ". Scenarios show price change over the next 5 or 20 daily bars.");
  $("scenario-values").replaceChildren(...[5, 20].map(step => {
    const [, low, mid, high] = model.fan[step];
    const box = el("div");
    box.append(el("span", "", step + " bars · median"), el("strong", "", pct(mid)),
      el("span", "", pct(low) + " to " + pct(high)),
      el("span", "", price(model.base * (1 + low / 100), unit) + " to " + price(model.base * (1 + high / 100), unit)));
    return box;
  }));
  const area = grid(surface($("scenario-chart"), "Historical 10th to 90th percentile return band, by horizon"),
    model.fan.flatMap(row => [row[1], row[3]]), true);
  const x = step => area.left + step / 20 * (area.right - area.left);
  const low = model.fan.map(([step, value]) => [x(step), area.y(value)]);
  const high = model.fan.map(([step, , , value]) => [x(step), area.y(value)]).reverse();
  area.root.append(svg("polygon", { points: [...low, ...high].map(point => point.join(",")).join(" "), fill: "#265359" }));
  line(area.root, model.fan.map(([step, , median]) => [x(step), area.y(median)]), colours[0], 1.7);
  xLabels(area, 21, i => i + (i === 20 ? " bars" : ""), x);
  setText($("benchmark"), `${model.days} completed closes · ${model.sample5} overlapping 5-bar samples and ${model.sample20} 20-bar samples. Recent 5-bar test (${model.benchmarkN} forecasts), average absolute error ${number(model.modelMae)} percentage points vs ${number(model.flatMae)} for zero change.`);
}

const SNAPSHOT = "market-monitor-risk-v1";
let snapshot = null;
try {
  const saved = JSON.parse(localStorage.getItem(SNAPSHOT));
  if (saved && [saved.equity, saved.floor, saved.at].every(Number.isFinite) &&
      saved.equity >= 0 && saved.floor >= 0 && saved.at > 0) snapshot = saved;
} catch { /* The app also works in sessions with storage disabled. */ }
if (snapshot) {
  $("equity").value = snapshot.equity;
  $("floor").value = snapshot.floor;
}
let storageFailed = false;
$("risk-form").addEventListener("submit", event => {
  event.preventDefault();
  snapshot = { equity: $("equity").valueAsNumber, floor: $("floor").valueAsNumber, at: Date.now() };
  try { localStorage.setItem(SNAPSHOT, JSON.stringify(snapshot)); storageFailed = false; } catch { storageFailed = true; }
  renderRisk();
});
$("clear-risk").addEventListener("click", () => {
  try { localStorage.removeItem(SNAPSHOT); storageFailed = false; } catch { storageFailed = true; }
  snapshot = null;
  $("risk-form").reset();
  renderRisk();
});
function latestReset(now) {
  const date = new Date(now);
  const reset = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 30);
  return reset > now ? reset - 86400000 : reset;
}
function renderRisk(now = Date.now()) {
  const crossedReset = snapshot && snapshot.at < latestReset(now);
  const stale = snapshot && now - snapshot.at >= 300000;
  const daily = snapshot ? snapshot.equity - snapshot.floor : null;
  const total = snapshot ? snapshot.equity - 4700 : null;
  const status = $("risk-status");
  const display = snapshot && !crossedReset;
  const warning = display && (daily <= 0 || total <= 0);
  for (const [id, value, tone] of [["head-daily", daily, daily], ["head-total", total, total],
    ["head-target", snapshot ? Math.max(0, 5500 - snapshot.equity) : null, null]]) {
    setText($(id), display ? dollars.format(value) : "—");
    signed($(id), display ? tone : null);
    if (display && tone === 0) $(id).classList.add("neg");
  }
  $("clear-risk").hidden = !snapshot;
  status.classList.toggle("stale", Boolean(crossedReset || stale || warning));
  const prefix = snapshot ? "Entered " + utcTime.format(snapshot.at) + " UTC. " : "";
  const next = "Next daily reset " + utcTime.format(latestReset(now) + 86400000) + " UTC.";
  const message = crossedReset ? "Daily reset has passed. Enter a new Kraken snapshot. " : warning ?
    "Entered equity is at or below a floor. Check Kraken for current account status. " : stale ?
    "Snapshot is at least five minutes old. " : "";
  setText(status, prefix + message + next + (storageFailed ? " Browser storage was unavailable." : ""));
}

function updateClock() {
  $("clock").textContent = utcTime.format(Date.now()) + " UTC";
  renderRisk();
}
let resizeTimer;
const resize = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderPlot(true);
    renderModel(true);
  }, 120);
});
resize.observe($("chart"));
resize.observe($("scenario-chart"));
controls();
updateClock();
refresh();
setInterval(updateClock, 15000);
setInterval(() => {
  const interval = state.data?.queued ? 2000 : 10000;
  if (!document.hidden && !$("refresh").disabled && Date.now() - state.lastCheck >= interval) refresh();
}, 2000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

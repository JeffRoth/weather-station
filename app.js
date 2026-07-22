const STATION_LOCATION = { latitude: 35.6870, longitude: -105.9378 };
const API_BASE = (window.WEATHER_API_BASE || '').replace(/\/$/, '');
if (window.ChartZoom) Chart.register(window.ChartZoom);
const state = { daily: [], climate: null, chart: null };
const el = id => document.getElementById(id);
const enabled = id => el(id).getAttribute('aria-pressed') === 'true';
const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function isoDate(value) { return value.toISOString().slice(0, 10); }
function addDays(date, days) { const copy = new Date(date + 'T12:00:00'); copy.setDate(copy.getDate() + days); return isoDate(copy); }
function std(values, mean) { return Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length); }
function column(row, text) { return Object.entries(row).find(([key]) => key.includes(text))?.[1]; }
function numericValue(value) {
  return value == null || String(value).trim() === '' ? NaN : Number(value);
}
function isTemperatureMetric(metric) { return metric !== 'precipitation'; }
function metricTitle(metric) {
  return ({ temperature: 'Daily mean temperature', highAndLow: 'Daily high and low temperature', highTemperature: 'Daily high temperature', lowTemperature: 'Daily low temperature', temperatureSpread: 'Daily temperature spread', feelsLike: 'Daily mean feels-like temperature', precipitation: 'Annual cumulative precipitation' })[metric];
}

async function loadStationHistory() {
  // Cloudflare deployment: read compact daily aggregates from the Worker.
  // Keep the CSV path below as a local-development and migration fallback.
  if (API_BASE) {
    const response = await fetch(`${API_BASE}/daily`);
    if (!response.ok) throw new Error(`Could not load station archive (${response.status}).`);
    const payload = await response.json();
    if (!Array.isArray(payload.daily)) throw new Error('Station archive returned an invalid daily-data response.');
    state.daily = payload.daily.sort((a, b) => a.date.localeCompare(b.date));
    return;
  }
  let files;
  try {
    const response = await fetch('/api/station-files');
    const listing = await response.json();
    if (!response.ok || !listing.files?.length) throw new Error('No station CSV files were found in data/.');
    files = listing.files;
  } catch (error) {
    throw new Error(`Could not list station CSV files. Run the dashboard with python server.py. (${error.message})`);
  }
  const texts = await Promise.all(files.map(async file => {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`Could not load ${file}`);
    return response.text();
  }));
  // Exports overlap. Later filenames are newer exports, so their exact
  // timestamp observations replace earlier copies before daily aggregation.
  const uniqueObservations = new Map();
  texts.forEach(text => Papa.parse(text, { header: true, skipEmptyLines: true }).data
    .forEach(row => { if (row.Date || row['Simple Date']) uniqueObservations.set(row.Date || row['Simple Date'], row); }));
  const byDay = new Map();
  for (const row of uniqueObservations.values()) {
    const rawDate = row.Date || row['Simple Date'];
    if (!rawDate) continue;
    const day = rawDate.slice(0, 10);
    const temperature = numericValue(column(row, 'Outdoor Temperature'));
    const feelsLike = numericValue(column(row, 'Feels Like'));
    const dailyRain = numericValue(column(row, 'Daily Rain'));
    if (!byDay.has(day)) byDay.set(day, { temperatures: [], feelsLike: [], rain: 0 });
    const entry = byDay.get(day);
    if (Number.isFinite(temperature)) entry.temperatures.push(temperature);
    if (Number.isFinite(feelsLike)) entry.feelsLike.push(feelsLike);
    if (Number.isFinite(dailyRain)) entry.rain = Math.max(entry.rain, dailyRain);
  }
  state.daily = [...byDay].map(([date, data]) => {
    const highTemperature = Math.max(...data.temperatures);
    const lowTemperature = Math.min(...data.temperatures);
    return {
      date,
      temperature: data.temperatures.reduce((a, b) => a + b, 0) / data.temperatures.length,
      highTemperature,
      lowTemperature,
      temperatureSpread: highTemperature - lowTemperature,
      feelsLike: data.feelsLike.length ? data.feelsLike.reduce((a, b) => a + b, 0) / data.feelsLike.length : null,
      precipitation: data.rain
    };
  }).filter(d => Number.isFinite(d.temperature)).sort((a, b) => a.date.localeCompare(b.date));
}

function selectedRange() {
  const end = el('end-date').value;
  const metric = el('metric').value;
  const days = Number(el('days').value);
  // A full-year view is a calendar-year comparison, so personal observations
  // from different years share the same month/day position on the x-axis.
  if (metric === 'precipitation' || days === 365) {
    const year = end.slice(0, 4);
    return { end: `${year}-12-31`, start: `${year}-01-01`, days: Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0) ? 366 : 365 };
  }
  return { end, start: addDays(end, -(days - 1)), days };
}

function climatologyForRange(range, metric) {
  if (!state.climate) return null;
  // Each comparison is aligned to the selected period's ending year.  This is
  // important for a 365-day view, which spans two calendar years.
  const endYear = Number(range.end.slice(0, 4));
  const years = Array.from({ length: 10 }, (_, i) => endYear - 10 + i)
    .filter(year => state.climate.has(year));
  const individual = years.map(year => {
    const delta = year - endYear;
    const entries = [];
    for (let i = 0; i < range.days; i++) {
      const target = addDays(range.start, i).replace(/^\d{4}/, String(Number(range.start.slice(0, 4)) + delta));
      const sourceYear = Number(target.slice(0, 4));
      const sourceData = state.climate.get(sourceYear);
      const datum = sourceData?.get(target);
      if (!datum) { entries.push(null); continue; }
      if (metric === 'precipitation') entries.push(annualPrecipitation(sourceData, target));
      else entries.push(datum[metric]);
    }
    return entries;
  });
  return Array.from({ length: range.days }, (_, i) => {
    const values = individual.map(series => series[i]).filter(Number.isFinite);
    if (!values.length) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean, low: mean - std(values, mean), high: mean + std(values, mean), count: values.length };
  });
}

function annualPrecipitation(dailyMap, date) {
  const yearStart = `${date.slice(0, 4)}-01-01`;
  let total = 0;
  for (let day = yearStart; day <= date; day = addDays(day, 1)) total += dailyMap.get(day)?.precipitation || 0;
  return total;
}

function calendarDayAverages(climate, displayYear) {
  const byDay = new Map();
  climate.forEach(dailyMap => dailyMap.forEach((values, date) => {
    const monthDay = date.slice(5);
    if (!byDay.has(monthDay)) byDay.set(monthDay, []);
    byDay.get(monthDay).push(values);
  }));
  return [...byDay].map(([monthDay, values]) => {
    const average = field => {
      const numbers = values.map(value => value[field]).filter(Number.isFinite);
      return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
    };
    return { date: `${displayYear}-${monthDay}`, highTemperature: average('highTemperature'), lowTemperature: average('lowTemperature') };
  });
}

function averageAnnualPrecipitation(climate) {
  const annualTotals = [...climate.values()].map(dailyMap =>
    [...dailyMap.values()].reduce((total, values) => total + (values.precipitation || 0), 0)
  ).filter(Number.isFinite);
  return annualTotals.length ? annualTotals.reduce((sum, total) => sum + total, 0) / annualTotals.length : null;
}

function extrema(records, field, direction) {
  const valid = records.filter(record => Number.isFinite(record[field]));
  if (!valid.length) return null;
  return valid.reduce((best, record) => direction === 'max'
    ? record[field] > best[field] ? record : best
    : record[field] < best[field] ? record : best);
}

function displayDate(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

function displayMonthDay(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

function fact(label, record, field, dateLabel) {
  if (!record) return '';
  return `<article class="fact"><span class="fact-label">${label}</span><strong class="fact-value">${record[field].toFixed(1)} °F</strong><span class="fact-date">${dateLabel || displayDate(record.date)}</span></article>`;
}

function precipitationFact(label, amount, date) {
  if (!Number.isFinite(amount)) return '';
  return `<article class="fact precipitation-fact"><span class="fact-label">${label}</span><strong class="fact-value">${amount.toFixed(2)} in</strong><span class="fact-date">${date ? displayDate(date) : 'calendar-year accumulation'}</span></article>`;
}

function factGroup(title, cards) {
  return `<section class="fact-group"><h3>${title}</h3><div class="fact-grid">${cards.filter(Boolean).join('')}</div></section>`;
}

function renderFacts(range) {
  const selectedYear = Number(range.end.slice(0, 4));
  const current = state.daily.filter(record => Number(record.date.slice(0, 4)) === selectedYear);
  const lastYear = selectedYear - 1;
  const lastYearRecords = state.daily.filter(record => Number(record.date.slice(0, 4)) === lastYear);
  const hottestCards = [
    fact(`${selectedYear} station hottest day`, extrema(current, 'highTemperature', 'max'), 'highTemperature'),
    fact(`${lastYear} station hottest day`, extrema(lastYearRecords, 'highTemperature', 'max'), 'highTemperature')
  ];
  const coldestCards = [
    fact(`${selectedYear} station coldest day`, extrema(current, 'lowTemperature', 'min'), 'lowTemperature'),
    fact(`${lastYear} station coldest day`, extrema(lastYearRecords, 'lowTemperature', 'min'), 'lowTemperature')
  ];
  const precipitationCards = [
    precipitationFact(`${selectedYear} station precipitation`, current.reduce((sum, record) => sum + record.precipitation, 0)),
    precipitationFact(`${lastYear} recorded precipitation`, lastYearRecords.reduce((sum, record) => sum + record.precipitation, 0)),
    (() => { const wettest = extrema(current, 'precipitation', 'max'); return wettest && precipitationFact(`${selectedYear} station wettest day`, wettest.precipitation, wettest.date); })(),
    (() => { const wettest = extrema(lastYearRecords, 'precipitation', 'max'); return wettest && precipitationFact(`${lastYear} station wettest day`, wettest.precipitation, wettest.date); })()
  ];
  if (state.climate) {
    const climateRecords = [];
    for (let year = selectedYear - 10; year < selectedYear; year++) {
      state.climate.get(year)?.forEach((values, date) => climateRecords.push({ date, ...values }));
    }
    hottestCards.push(fact('Long-term historic hottest day', extrema(climateRecords, 'highTemperature', 'max'), 'highTemperature'));
    coldestCards.push(fact('Long-term historic coldest day', extrema(climateRecords, 'lowTemperature', 'min'), 'lowTemperature'));
    const averageDays = calendarDayAverages(state.climate, selectedYear);
    const averageHottest = extrema(averageDays, 'highTemperature', 'max');
    const averageColdest = extrema(averageDays, 'lowTemperature', 'min');
    hottestCards.push(fact('Long-term average hottest day', averageHottest, 'highTemperature', averageHottest && `typically ${displayMonthDay(averageHottest.date)}`));
    coldestCards.push(fact('Long-term average coldest day', averageColdest, 'lowTemperature', averageColdest && `typically ${displayMonthDay(averageColdest.date)}`));
    const wettest = extrema(climateRecords, 'precipitation', 'max');
    if (wettest) precipitationCards.push(precipitationFact('Long-term historic wettest day', wettest.precipitation, wettest.date));
    precipitationCards.push(precipitationFact('Long-term average annual precipitation', averageAnnualPrecipitation(state.climate)));
  } else {
    hottestCards.push('<article class="fact"><span class="fact-label">Long-term historic records</span><strong class="fact-value">Load climate data</strong><span class="fact-date">to reveal the historic record</span></article>');
    coldestCards.push('<article class="fact"><span class="fact-label">Long-term historic records</span><strong class="fact-value">Load climate data</strong><span class="fact-date">to reveal the historic record</span></article>');
  }
  el('facts').innerHTML = `<h2>Seasonal facts</h2>${factGroup('Hottest days', hottestCards)}${factGroup('Coldest days', coldestCards)}${factGroup('Precipitation', precipitationCards)}`;
}

function draw({ preserveZoom = false } = {}) {
  const savedZoom = preserveZoom && state.chart ? {
    x: { min: state.chart.scales.x.min, max: state.chart.scales.x.max },
    y: { min: state.chart.scales.y.min, max: state.chart.scales.y.max }
  } : null;
  const metric = el('metric').value;
  const precipitationMode = metric === 'precipitation';
  const highLowMode = metric === 'highAndLow';
  const calendarYearMode = precipitationMode || Number(el('days').value) === 365;
  el('period-control').classList.toggle('hidden', precipitationMode);
  el('end-date-label').textContent = calendarYearMode ? 'Calendar year' : 'Ending date';
  const range = selectedRange();
  const unit = isTemperatureMetric(metric) ? '°F' : 'in';
  const lookup = new Map(state.daily.map(d => [d.date, d]));
  const dates = Array.from({ length: range.days }, (_, i) => addDays(range.start, i));
  const datasets = [];
  const historicDatasets = [];
  let stationValues = dates.map(date => lookup.get(date)?.[highLowMode ? 'highTemperature' : metric] ?? null);
  const stationLowValues = highLowMode ? dates.map(date => lookup.get(date)?.lowTemperature ?? null) : null;
  const axisValues = [...stationValues];
  if (stationLowValues) axisValues.push(...stationLowValues);
  let annualTotals = null;
  if (metric === 'precipitation') {
    annualTotals = new Map();
    let total = 0, activeYear = '';
    for (const entry of state.daily) {
      const year = entry.date.slice(0, 4);
      if (year !== activeYear) { activeYear = year; total = 0; }
      total += entry.precipitation;
      annualTotals.set(entry.date, total);
    }
    stationValues = dates.map(date => lookup.has(date) ? annualTotals.get(date) : null);
  }
  axisValues.push(...stationValues);
  const selectedYear = range.end.slice(0, 4);
  const historicYears = [...new Set(state.daily.map(entry => entry.date.slice(0, 4)))]
    .filter(year => year < selectedYear);
  const historicColors = ['#f2b84b', '#ca88ef', '#ee7f7f', '#a6c96b'];
  historicYears.forEach((year, index) => {
    const historicalValues = dates.map(date => {
      // Align personal history to the same calendar day as the displayed
      // series. This makes a prior-year observation visible when comparing it
      // with July in the selected year, including a 365-day temperature view.
      const sourceDate = `${year}${date.slice(4)}`;
      return metric === 'precipitation' ? annualTotals.get(sourceDate) ?? null : lookup.get(sourceDate)?.[highLowMode ? 'highTemperature' : metric] ?? null;
    });
    const historicalLowValues = highLowMode ? dates.map(date => lookup.get(`${year}${date.slice(4)}`)?.lowTemperature ?? null) : null;
    axisValues.push(...historicalValues);
    if (historicalLowValues) axisValues.push(...historicalLowValues);
    if (enabled('pws-history-toggle')) {
      historicDatasets.push({ label: `Your station · ${year}`, data: historicalValues, borderColor: historicColors[index % historicColors.length], borderWidth: 1.8, borderDash: [5, 4], pointRadius: 0, spanGaps: true });
      if (historicalLowValues) historicDatasets.push({ label: `Your station low · ${year}`, data: historicalLowValues, borderColor: '#82c9f5', borderWidth: 1.4, borderDash: [3, 4], pointRadius: 0, spanGaps: true });
    }
  });
  const climate = climatologyForRange(range, highLowMode ? 'highTemperature' : metric);
  const lowClimate = highLowMode ? climatologyForRange(range, 'lowTemperature') : null;
  // Always reserve space for the wider ±2σ envelope, so layer and sigma
  // controls never rescale the vertical axis.
  if (climate) climate.forEach(d => {
    if (!d) return;
    axisValues.push(d.mean - (d.mean - d.low) * 2, d.mean + (d.high - d.mean) * 2);
  });
  if (lowClimate) lowClimate.forEach(d => {
    if (!d) return;
    axisValues.push(d.mean - (d.mean - d.low) * 2, d.mean + (d.high - d.mean) * 2);
  });
  if (climate && enabled('long-term-toggle')) {
    const sigma = Number(el('std-toggle').dataset.sigma);
    datasets.push({ label: 'Climate lower range', data: climate.map(d => d?.low ?? null), borderColor: 'transparent', pointRadius: 0, fill: false });
    datasets[datasets.length - 1].data = climate.map(d => d ? d.mean - (d.mean - d.low) * sigma : null);
    datasets.push({ label: `Long-term average ± ${sigma}σ`, data: climate.map(d => d ? d.mean + (d.high - d.mean) * sigma : null), borderColor: 'transparent', backgroundColor: 'rgba(77,183,255,.18)', pointRadius: 0, fill: '-1' });
    datasets.push({ label: 'Long-term average', data: climate.map(d => d?.mean ?? null), borderColor: '#9fb2c1', borderDash: [6, 5], pointRadius: 0, borderWidth: 2 });
    if (lowClimate) {
      datasets.push({ label: 'Climate low range', data: lowClimate.map(d => d ? d.mean - (d.mean - d.low) * sigma : null), borderColor: 'transparent', pointRadius: 0, fill: false });
      datasets.push({ label: `Long-term low average ± ${sigma}σ`, data: lowClimate.map(d => d ? d.mean + (d.high - d.mean) * sigma : null), borderColor: 'transparent', backgroundColor: 'rgba(130,201,245,.14)', pointRadius: 0, fill: '-1' });
      datasets.push({ label: 'Long-term low average', data: lowClimate.map(d => d?.mean ?? null), borderColor: '#82c9f5', borderDash: [6, 5], pointRadius: 0, borderWidth: 2 });
    }
  }
  datasets.push(...historicDatasets);
  if (enabled('pws-current-toggle')) {
    datasets.push({ label: highLowMode ? 'Your station high' : precipitationMode ? `Your station · ${range.end.slice(0, 4)}` : 'Your station', data: stationValues, borderColor: metric === 'temperature' ? '#4db7ff' : highLowMode ? '#ef8c55' : '#50d1a3', backgroundColor: 'transparent', pointRadius: range.days > 90 ? 0 : 2, borderWidth: 2.5, spanGaps: true });
    if (stationLowValues) datasets.push({ label: 'Your station low', data: stationLowValues, borderColor: '#4db7ff', backgroundColor: 'transparent', pointRadius: range.days > 90 ? 0 : 2, borderWidth: 2.5, spanGaps: true });
  }
  const finiteAxisValues = axisValues.filter(Number.isFinite);
  const dataMin = Math.min(...finiteAxisValues), dataMax = Math.max(...finiteAxisValues);
  const axisMin = metric === 'precipitation' ? 0 : Math.floor((dataMin - 3) / 5) * 5;
  const axisMax = metric === 'precipitation' ? Math.ceil((dataMax + Math.max(.1, dataMax * .08)) * 10) / 10 : Math.ceil((dataMax + 3) / 5) * 5;
  if (!preserveZoom || !state.chart) {
  state.chart?.destroy();
  state.chart = new Chart(el('weather-chart'), { type: 'line', data: { labels: dates.map(d => fmt.format(new Date(d + 'T12:00:00'))), datasets }, options: { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { color: '#dce7ef', filter: item => !item.text.includes('lower') } }, tooltip: { callbacks: { label: item => `${item.dataset.label}: ${item.raw == null ? '—' : Number(item.raw).toFixed(isTemperatureMetric(metric) ? 1 : 2)} ${unit}` } }, zoom: { zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'xy' }, pan: { enabled: true, mode: 'xy' } } }, scales: { x: { min: savedZoom?.x.min, max: savedZoom?.x.max, ticks: { color: '#9fb2c1', maxTicksLimit: 9 }, grid: { color: 'rgba(159,178,193,.08)' } }, y: { min: savedZoom?.y.min ?? axisMin, max: savedZoom?.y.max ?? axisMax, title: { display: true, text: `${metricTitle(metric)} (${unit})`, color: '#9fb2c1' }, ticks: { color: '#9fb2c1' }, grid: { color: 'rgba(159,178,193,.12)' } } } } });
  } else {
    // Reuse the existing Chart instance for layer changes. The zoom plugin
    // stores its active viewport on that instance, so update('none') keeps it.
    state.chart.data.labels = dates.map(d => fmt.format(new Date(d + 'T12:00:00')));
    state.chart.data.datasets = datasets;
    state.chart.options.scales.y.title.text = `${metricTitle(metric)} (${unit})`;
    state.chart.options.plugins.tooltip.enabled = enabled('tooltip-toggle');
    state.chart.options.plugins.tooltip.events = ['click'];
    state.chart.update('none');
  }
  // Tooltips respond to a deliberate tap/click only. Applying this after
  // construction also covers metric/date changes that create a new chart.
  state.chart.options.plugins.tooltip.enabled = enabled('tooltip-toggle');
  state.chart.options.plugins.tooltip.events = ['click'];
  // A readout requires a direct hit near a plotted value. A tap on open chart
  // space therefore clears the prior readout instead of selecting a nearest line.
  state.chart.options.plugins.tooltip.mode = 'index';
  state.chart.options.plugins.tooltip.intersect = true;
  state.chart.options.elements = { point: { hitRadius: 12 } };
  state.chart.update('none');
  const last = [...stationValues].reverse().find(Number.isFinite);
  const lastLow = stationLowValues && [...stationLowValues].reverse().find(Number.isFinite);
  const latestSummary = highLowMode ? `high ${last == null ? '—' : last.toFixed(1)} / low ${lastLow == null ? '—' : lastLow.toFixed(1)} °F` : last == null ? '—' : last.toFixed(isTemperatureMetric(metric) ? 1 : 2) + ' ' + unit;
  el('summary').innerHTML = `<div><span>Latest ${metric === 'precipitation' ? 'annual accumulation' : metricTitle(metric).toLowerCase()}</span><strong>${latestSummary}</strong></div><div><span>Displayed station observations</span><strong>${stationValues.filter(Number.isFinite).length} days</strong></div><div><span>Long-term baseline</span><strong>${climate ? `${climate.filter(Boolean)[0]?.count || 0} prior years` : 'Ready for Santa Fe'}</strong></div>`;
  renderFacts(range);
}

async function loadClimate() {
  const { latitude: lat, longitude: lon } = STATION_LOCATION;
  const endYear = Number(el('end-date').value.slice(0, 4));
  // Include an extra edge year so a full selected year can begin in the
  // preceding calendar year while still comparing ten complete periods.
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${endYear - 12}-01-01&end_date=${endYear - 1}-12-31&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,apparent_temperature_mean,precipitation_sum&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto`;
  el('status').textContent = 'Loading 10 years of daily climate history…';
  const result = await (await fetch(url)).json();
  if (!result.daily) throw new Error(result.reason || 'Climate service returned no daily data.');
  state.climate = new Map();
  result.daily.time.forEach((date, i) => { const year = Number(date.slice(0, 4)); if (!state.climate.has(year)) state.climate.set(year, new Map()); const highTemperature = result.daily.temperature_2m_max[i]; const lowTemperature = result.daily.temperature_2m_min[i]; state.climate.get(year).set(date, { temperature: result.daily.temperature_2m_mean[i], highTemperature, lowTemperature, temperatureSpread: highTemperature - lowTemperature, feelsLike: result.daily.apparent_temperature_mean[i], precipitation: result.daily.precipitation_sum[i] || 0 }); });
  el('status').textContent = 'Loaded long-term climate baseline from 10 prior years.'; draw();
}

async function refreshLive() {
  try {
    const live = await (await fetch(API_BASE ? `${API_BASE}/latest` : '/api/cwop?station=GW7633')).json();
    const parts = [live.temperatureF != null && `${live.temperatureF} °F`, live.rain24hIn != null && `${live.rain24hIn} in rain (24 h)`].filter(Boolean);
    el('status').textContent = parts.length ? `Latest station report: ${parts.join(' · ')}.` : 'The latest station report is not available yet.';
  } catch { el('status').textContent = 'Live station data is temporarily unavailable; saved history is still shown.'; }
}

async function init() {
  const latest = state.daily.at(-1)?.date || isoDate(new Date());
  el('end-date').value = latest;
  draw(); el('status').textContent = `Loaded ${state.daily.length} days of station history through ${latest}.`;
  refreshLive();
}
el('metric').addEventListener('change', draw); el('days').addEventListener('change', draw); el('end-date').addEventListener('change', draw);
el('load-climate').addEventListener('click', () => loadClimate().catch(e => el('status').textContent = `Could not load climate: ${e.message}`));
el('refresh').addEventListener('click', refreshLive);
el('reset-zoom').addEventListener('click', () => state.chart?.resetZoom());
el('tooltip-toggle').addEventListener('click', () => {
  const next = !enabled('tooltip-toggle');
  el('tooltip-toggle').setAttribute('aria-pressed', String(next));
  el('tooltip-toggle').classList.toggle('active', next);
  draw({ preserveZoom: true });
});
['long-term-toggle', 'pws-history-toggle', 'pws-current-toggle'].forEach(id => el(id).addEventListener('click', () => {
  const next = !enabled(id);
  el(id).setAttribute('aria-pressed', String(next));
  el(id).classList.toggle('active', next);
  draw({ preserveZoom: true });
}));
el('std-toggle').addEventListener('click', () => {
  const nextSigma = el('std-toggle').dataset.sigma === '1' ? '2' : '1';
  el('std-toggle').dataset.sigma = nextSigma;
  el('std-toggle').textContent = `±${nextSigma}σ`;
  draw({ preserveZoom: true });
});
loadStationHistory().then(init).catch(error => el('status').textContent = error.message);

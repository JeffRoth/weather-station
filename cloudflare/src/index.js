const AMBIENT_API = 'https://api.ambientweather.net/v1';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
// Ambient's dailyrainin counter resets at the station's local midnight, so
// daily rollups must use the station's timezone rather than UTC.
const STATION_TIME_ZONE = 'America/Denver';

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = env.ALLOWED_ORIGIN === '*' || origin === env.ALLOWED_ORIGIN ? origin || env.ALLOWED_ORIGIN : env.ALLOWED_ORIGIN;
  return { ...JSON_HEADERS, 'access-control-allow-origin': allowed, 'access-control-allow-methods': 'GET, OPTIONS', 'vary': 'Origin' };
}

function json(data, request, env, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(request, env) });
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampFor(observation) {
  const value = observation.dateutc ?? observation.date ?? observation.timestamp;
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayFor(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STATION_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function emptyDay(date) {
  return { date, count: 0, temperatureSum: 0, highTemperature: null, lowTemperature: null, feelsLikeSum: 0, feelsLikeCount: 0, precipitation: 0 };
}

function updateDay(day, observation) {
  const temperature = asNumber(observation.tempf);
  const feelsLike = asNumber(observation.feelsLike ?? observation.feelslike);
  const dailyRain = asNumber(observation.dailyrainin);
  if (temperature !== null) {
    day.count += 1;
    day.temperatureSum += temperature;
    day.highTemperature = day.highTemperature === null ? temperature : Math.max(day.highTemperature, temperature);
    day.lowTemperature = day.lowTemperature === null ? temperature : Math.min(day.lowTemperature, temperature);
  }
  if (feelsLike !== null) { day.feelsLikeSum += feelsLike; day.feelsLikeCount += 1; }
  if (dailyRain !== null) day.precipitation = Math.max(day.precipitation, dailyRain);
}

function publicDay(day) {
  return {
    date: day.date,
    temperature: day.count ? day.temperatureSum / day.count : null,
    highTemperature: day.highTemperature,
    lowTemperature: day.lowTemperature,
    temperatureSpread: day.highTemperature === null || day.lowTemperature === null ? null : day.highTemperature - day.lowTemperature,
    feelsLike: day.feelsLikeCount ? day.feelsLikeSum / day.feelsLikeCount : null,
    precipitation: day.precipitation
  };
}

async function readYear(env, year) {
  const object = await env.WEATHER_ARCHIVE.get(`daily/${year}.json`);
  return object ? await object.json() : {};
}

async function writeYear(env, year, days) {
  await env.WEATHER_ARCHIVE.put(`daily/${year}.json`, JSON.stringify(days), { httpMetadata: { contentType: 'application/json' } });
}

async function collect(env) {
  const query = new URLSearchParams({ apiKey: env.AMBIENT_API_KEY, applicationKey: env.AMBIENT_APPLICATION_KEY, limit: '288' });
  const response = await fetch(`${AMBIENT_API}/devices/${encodeURIComponent(env.AMBIENT_MAC)}?${query}`);
  if (!response.ok) throw new Error(`Ambient Weather returned ${response.status}.`);
  const observations = await response.json();
  if (!Array.isArray(observations)) throw new Error('Ambient Weather did not return an observation array.');

  const stateObject = await env.WEATHER_ARCHIVE.get('state.json');
  const state = stateObject ? await stateObject.json() : { lastTimestamp: 0 };
  const fresh = observations.map(observation => ({ observation, timestamp: timestampFor(observation) }))
    .filter(item => item.timestamp && item.timestamp > state.lastTimestamp)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!fresh.length) return { collected: 0, latest: state.lastTimestamp || null };

  const years = new Map();
  for (const { observation, timestamp } of fresh) {
    const date = dayFor(timestamp), year = date.slice(0, 4);
    if (!years.has(year)) years.set(year, await readYear(env, year));
    const days = years.get(year);
    const day = days[date] || emptyDay(date);
    updateDay(day, observation);
    days[date] = day;
    // Immutable raw records make later reprocessing possible.
    await env.WEATHER_ARCHIVE.put(`raw/${date.slice(0, 4)}/${date.slice(5, 7)}/${timestamp}.json`, JSON.stringify(observation), { httpMetadata: { contentType: 'application/json' } });
  }
  for (const [year, days] of years) await writeYear(env, year, days);
  const latest = fresh.at(-1).timestamp;
  const latestObservation = fresh.at(-1).observation;
  await env.WEATHER_ARCHIVE.put('state.json', JSON.stringify({
    lastTimestamp: latest,
    collectedAt: new Date().toISOString(),
    latest: {
      timestamp: latest,
      temperatureF: asNumber(latestObservation.tempf),
      rain24hIn: asNumber(latestObservation.hourlyrainin ?? latestObservation.dailyrainin),
      source: 'Ambient Weather'
    }
  }), { httpMetadata: { contentType: 'application/json' } });
  return { collected: fresh.length, latest };
}

async function dailyResponse(request, env) {
  const url = new URL(request.url);
  const nowYear = new Date().getUTCFullYear();
  const start = url.searchParams.get('start') || `${nowYear - 10}-01-01`;
  const end = url.searchParams.get('end') || `${nowYear}-12-31`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return json({ error: 'Invalid start or end date.' }, request, env, 400);
  const daily = [];
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year++) {
    const days = await readYear(env, year);
    Object.values(days).filter(day => day.date >= start && day.date <= end).forEach(day => daily.push(publicDay(day)));
  }
  return json({ daily: daily.sort((a, b) => a.date.localeCompare(b.date)) }, request, env);
}

function storedDay(day) {
  const temperature = asNumber(day.temperature);
  const highTemperature = asNumber(day.highTemperature);
  const lowTemperature = asNumber(day.lowTemperature);
  const feelsLike = asNumber(day.feelsLike);
  return {
    date: day.date,
    count: temperature === null ? 0 : 1,
    temperatureSum: temperature ?? 0,
    highTemperature,
    lowTemperature,
    feelsLikeCount: feelsLike === null ? 0 : 1,
    feelsLikeSum: feelsLike ?? 0,
    precipitation: asNumber(day.precipitation) ?? 0
  };
}

async function importDaily(request, env) {
  const adminToken = env.ADMIN_TOKEN?.trim();
  if (!adminToken || request.headers.get('authorization') !== `Bearer ${adminToken}`) return new Response('Unauthorized.', { status: 401 });
  const payload = await request.json();
  if (!Array.isArray(payload.daily) || !payload.daily.length) return new Response('Expected a non-empty daily array.', { status: 400 });
  const byYear = new Map();
  for (const day of payload.daily) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date || '')) return new Response('Invalid daily date.', { status: 400 });
    const year = day.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, await readYear(env, year));
    byYear.get(year)[day.date] = storedDay(day);
  }
  for (const [year, days] of byYear) await writeYear(env, year, days);
  return new Response(JSON.stringify({ imported: payload.daily.length }), { headers: JSON_HEADERS });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request, env) });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/daily') return dailyResponse(request, env);
    if (request.method === 'GET' && url.pathname === '/api/latest') {
      const state = await env.WEATHER_ARCHIVE.get('state.json');
      const saved = state ? await state.json() : null;
      return json(saved?.latest || { timestamp: null }, request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/import-daily') return importDaily(request, env);
    return json({ error: 'Not found.' }, request, env, 404);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(collect(env));
  }
};

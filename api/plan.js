const QLOO = "https://hackathon.api.qloo.com";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let pending = Promise.resolve();
let lastCall = 0;

class PlanError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function scheduled(task) {
  const work = pending.catch(() => {}).then(async () => {
    await sleep(Math.max(0, 1800 - (Date.now() - lastCall)));
    lastCall = Date.now();
    return task();
  });
  pending = work.catch(() => {});
  return work;
}

async function qloo(path, params) {
  const url = QLOO + path + "?" + new URLSearchParams(params).toString();
  return scheduled(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, { headers: { "X-Api-Key": process.env.QLOO_API_KEY }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429 && attempt < 2) {
        await r.body?.cancel();
        const retry = Number(r.headers.get('retry-after'));
        await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(10000, retry * 1000) : 3500 * (attempt + 1));
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new PlanError(r.status === 429 ? 'Taste data is busy. Wait a minute and try again.' : 'Taste data could not be loaded. Try again.', r.status === 429 ? 429 : 502);
      }
      const data = await r.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PlanError('Taste data returned an unexpected response.');
      return data;
    }
  });
}

async function findEntity(name) {
  const d = await qloo("/search", { query: name, take: 1 });
  if (!Array.isArray(d.results)) throw new PlanError('Search returned an unexpected response.');
  const e = d.results[0];
  return e ? { id: e.entity_id, name: e.name, type: (e.types || [])[0] } : null;
}

async function insights(type, entityIds, city, take) {
  const p = { "filter.type": type, "signal.interests.entities": entityIds.join(","), take: String(take) };
  if (city && type === "urn:entity:place") {p["filter.location.query"] = city;p['filter.tags']='urn:tag:genre:place:restaurant';}
  const d = await qloo("/v2/insights", p);
  if (!d.results || !Array.isArray(d.results.entities)) throw new PlanError('Recommendations returned an unexpected response.');
  return d.results.entities.filter(e => e && typeof e.entity_id === 'string' && typeof e.name === 'string');
}

function scoreOf(list, id) {
  const i = list.findIndex(e => e.entity_id === id);
  return i < 0 ? 0 : 1 - i / list.length;
}

async function fairPicks(type, people, city, n) {
  const all = people.flatMap(p => p.entities.map(e => e.id));
  const pool = await insights(type, all, city, 40);
  const perPerson = await Promise.all(people.map(p => insights(type, p.entities.map(e => e.id), city, 40)));
  const ranked = pool.map(e => {
    const scores = perPerson.map(list => scoreOf(list, e.entity_id));
    return { name: e.name, id: e.entity_id, scores, fairness: Math.min(...scores), avg: scores.reduce((a, b) => a + b, 0) / scores.length,
             address: e.properties && e.properties.address, tags: (e.tags || []).slice(0, 4).map(t => t.name) };
  }).sort((a, b) => b.fairness - a.fairness || b.avg - a.avg);
  return ranked.slice(0, n);
}

async function explain(people, city, picks) {
  const facts = {
    city,
    friends: people.map(p => ({ name: p.name, favorites: p.entities.map(e => e.name) })),
    dinner: picks.dinner.map(x => ({ name: x.name, tags: x.tags, match_per_friend: x.scores.map(s => Math.round(s * 100)) })),
    artists: picks.music.map(x => ({ name: x.name, match_per_friend: x.scores.map(s => Math.round(s * 100)) })),
    movies: picks.movie.map(x => ({ name: x.name, match_per_friend: x.scores.map(s => Math.round(s * 100)) }))
  };
  const prompt = "Write only the final concise result as JSON with exactly three text fields: dinner, music, movie. " +
    "Use ONLY the following data. In each field name the FIRST candidate from that list and briefly describe the relative-rank scores for each named friend. " +
    "Do not select another candidate or invent hours, cuisine, accessibility, addresses, bookings or personal opinions. " +
    "Zero means absent from that friend's returned shortlist, not a measured dislike. If a score is zero, say the shortlist lacks evidence of shared fit. " +
    "If the candidate list is empty, say no recommendation returned. Each field under 400 characters. No analysis, no Markdown, no extra fields.\n" + JSON.stringify(facts);
  if (!process.env.GEMINI_API_KEY) throw new PlanError('The explanation model is not available.');
  const r = await fetch(GEMINI, {
    method: "POST",
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 3000, temperature: 0.1 } }),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) { await r.body?.cancel(); throw new PlanError('The explanation model is not available.'); }
  const d = await r.json();
  const candidate=d.candidates?.[0];
  if (candidate?.finishReason!=='STOP') throw new PlanError('The explanation model is not available.');
  const text=(candidate.content?.parts||[]).filter(p=>p.thought!==true).map(p=>p.text||'').join('').trim();
  let output;try{output=JSON.parse(text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new PlanError('The explanation model is not available.');}
  if(!output||Object.keys(output).sort().join(',')!=='dinner,movie,music'||Object.values(output).some(x=>typeof x!=='string'||!x.trim()||x.length>400))throw new PlanError('The explanation model is not available.');
  for(const [field,list] of [['dinner',picks.dinner],['music',picks.music],['movie',picks.movie]])if(list.length&&!output[field].includes(list[0].name))throw new PlanError('The explanation model is not available.');
  return ['One evening, considered separately for each friend','Dinner: '+output.dinner,'Soundtrack: '+output.music,'After dinner: '+output.movie].join('\n\n');
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PlanError('Use a JSON object with a city and friends.',400);
  if (typeof body.city !== 'string' || !body.city.trim() || body.city.length > 80) throw new PlanError('Enter a city using 1–80 characters.',400);
  if (!Array.isArray(body.friends) || body.friends.length < 2 || body.friends.length > 5) throw new PlanError('Add between two and five friends.',400);
  const friends = body.friends.map(f => {
    if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name.trim() || f.name.length > 30) throw new PlanError('Give each friend a name using 1–30 characters.',400);
    if (!Array.isArray(f.favorites) || f.favorites.length > 4 || !f.favorites.length) throw new PlanError('Add one to four favorites per friend.',400);
    if (f.favorites.some(x => typeof x !== 'string' || x.length > 100)) throw new PlanError('Use text favorites under 100 characters.',400);
    const favorites = [...new Set(f.favorites.map(x=>x.trim()).filter(Boolean))];
    if (!favorites.length) throw new PlanError('Add at least one favorite per friend.',400);
    return {name:f.name.trim(),favorites};
  });
  return {city:body.city.trim(),friends};
}

function fallbackStory(picks) {
  return ["A plan from the taste rankings", ...[['Dinner',picks.dinner],['Soundtrack',picks.music],['After dinner',picks.movie]].map(([label,list]) => `${label}: ${list.length ? list[0].name : 'No recommendation returned'}.`), 'Rank scores are relative to each returned list. They are not probabilities or measured satisfaction.'].join('\n\n');
}

let activePlans = 0;
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({error:'Use POST to create a plan.'});
  if (activePlans) return res.status(429).json({error:'Another plan is being prepared. Try again shortly.'});
  let admitted = false;
  try {
    if (Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}),'utf8') > 40000) throw new PlanError('The request is too large.',413);
    let body;
    try {body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;} catch {throw new PlanError('Use valid JSON.',400);}
    const {city,friends}=validate(body);
    if (!process.env.QLOO_API_KEY) throw new PlanError('The taste service is not configured.',503);
    activePlans++; admitted=true;
    const people = [];
    for (const f of friends) {
      const favs = (f.favorites || []).filter(Boolean).slice(0, 4);
      const entities = (await Promise.all(favs.map(findEntity))).filter(Boolean);
      if (!entities.length) return res.status(400).json({ error: `Could not recognize any favorites for ${f.name}.` });
      people.push({ name: String(f.name || "Friend").slice(0, 30), entities });
    }
    const [dinner, music, movie] = await Promise.all([
      fairPicks("urn:entity:place", people, city, 3),
      fairPicks("urn:entity:artist", people, null, 5),
      fairPicks("urn:entity:movie", people, null, 3)
    ]);
    const picks = { dinner, music, movie };
    let story, explanationSource='gemma';
    try {story=await explain(people,city,picks);} catch {story=fallbackStory(picks);explanationSource='ranking-template';}
    res.status(200).json({ people, picks, story, explanationSource, scoreMeaning:'relative-rank', city });
  } catch (e) {
    res.status(e instanceof PlanError ? e.status : 502).json({ error: e instanceof PlanError ? e.message : 'The plan could not be completed. Try again.' });
  } finally {
    if (admitted) activePlans--;
  }
};
module.exports.testing={validate,scoreOf,fallbackStory,PlanError};

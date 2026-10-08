const QLOO = "https://hackathon.api.qloo.com";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function qloo(path, params) {
  const url = QLOO + path + "?" + new URLSearchParams(params).toString();
  const r = await fetch(url, { headers: { "X-Api-Key": process.env.QLOO_API_KEY } });
  if (!r.ok) throw new Error(`Qloo ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function findEntity(name) {
  const d = await qloo("/search", { query: name, take: 1 });
  const e = (d.results || [])[0];
  return e ? { id: e.entity_id, name: e.name, type: (e.types || [])[0] } : null;
}

async function insights(type, entityIds, city, take) {
  const p = { "filter.type": type, "signal.interests.entities": entityIds.join(","), take: String(take) };
  if (city && type === "urn:entity:place") p["filter.location.query"] = city;
  const d = await qloo("/v2/insights", p);
  return (d.results && d.results.entities) || [];
}

function scoreOf(list, id) {
  const i = list.findIndex(e => e.entity_id === id);
  return i < 0 ? 0 : 1 - i / list.length;
}

async function fairPicks(type, people, city, n) {
  const all = people.flatMap(p => p.entities.map(e => e.id));
  const pool = await insights(type, all, city, 40);
  const perPerson = await Promise.all(people.map(p => insights(type, p.entities.map(e => e.id), city, 60)));
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
  const prompt = "You plan one evening out for a group of friends with different tastes. Using ONLY the JSON below " +
    "(match_per_friend is each friend's taste match in the same order as friends), write: a one-line plan title, " +
    "then 3 short sections (Dinner, Soundtrack for the ride, After dinner) each naming the top pick and one sentence " +
    "on why it works for EVERY friend by name. Do not invent places or facts.\n" + JSON.stringify(facts);
  const r = await fetch(GEMINI + "?key=" + process.env.GEMINI_API_KEY, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const d = await r.json();
  return (((d.candidates || [])[0] || {}).content || { parts: [{ text: "" }] }).parts.map(p => p.text).join("").trim();
}

module.exports = async (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const city = String(body.city || "").slice(0, 80);
    const friends = (body.friends || []).slice(0, 5);
    if (friends.length < 2) return res.status(400).json({ error: "Add at least two friends." });
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
    const story = await explain(people, city, picks);
    res.status(200).json({ people, picks, story });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

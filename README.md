# Crowd Pleaser

Plan one evening out for friends with very different tastes. Each friend adds a few favorites (an artist, a movie, a restaurant, a book). Crowd Pleaser turns them into Qloo taste signals, scores every candidate dinner spot, artist and movie **separately for each friend**, and picks the option whose least-happy friend is happiest. Gemini then explains, by name, why each pick works for everyone.

## How it works
1. `/search` resolves each favorite to a Qloo entity.
2. `/v2/insights` runs once for the whole group (candidate pool) and once per friend.
3. Each candidate gets a match score per friend from that friend's ranking. Ranking key = minimum score across friends (fairness), then average.
4. Gemini 2.5 Flash writes the plan from those scores only.

## Run
Deploy to Vercel (free) with env vars `QLOO_API_KEY` and `GEMINI_API_KEY`. Static front end in `public/`, serverless function in `api/plan.js`. No dependencies.

## License
MIT

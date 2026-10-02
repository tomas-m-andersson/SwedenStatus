// Kontrollerar alla tjänster i services.json och skriver status.json.
// Kräver Node 18+ (inbyggd fetch). Kör: node check.mjs
import { readFile, writeFile } from "node:fs/promises";

const TIMEOUT_MS = 8000;  // längre än så räknas som "svarar inte"
const SLOW_MS = 2000;     // svarar, men långsammare än så = "långsam"
const KEEP_DAYS = 35;     // så länge sparas historiken

const cfg = JSON.parse(await readFile("services.json", "utf8"));

// Läs tidigare historik så den byggs på mellan körningarna
const prevDays = {};
try {
  const prev = JSON.parse(await readFile("status.json", "utf8"));
  for (const g of prev.groups || []) for (const i of g.items) prevDays[i.name] = i.days || {};
} catch {}

async function ping(url) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "user-agent": "sweden-status-check/1.0", accept: "text/html,*/*" },
    });
    await r.body?.cancel();
    return { code: r.status, ms: Date.now() - t0 };
  } catch {
    return { code: 0, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// "Nere" = inget svar alls eller serverfel (5xx), efter ett nytt försök.
// 4xx (t.ex. 403 från en botspärr) räknas som att servern lever.
async function check(url) {
  let r = await ping(url);
  if (r.code === 0 || r.code >= 500) {
    await new Promise((s) => setTimeout(s, 3000));
    r = await ping(url);
  }
  const state = r.code === 0 || r.code >= 500 ? "bad" : r.ms > SLOW_MS ? "warn" : "ok";
  return { state, ms: r.ms, code: r.code };
}

const today = new Date().toISOString().slice(0, 10);
const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);

const groups = await Promise.all(
  cfg.groups.map(async (g) => ({
    id: g.id,
    title: g.title,
    items: await Promise.all(
      g.items.map(async (s) => {
        const r = await check(s.url);
        const days = { ...(prevDays[s.name] || {}) };
        const c = days[today] || [0, 0, 0]; // [ok, långsam, nere]
        c[{ ok: 0, warn: 1, bad: 2 }[r.state]]++;
        days[today] = c;
        for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
        return { name: s.name, state: r.state, ms: r.ms, code: r.code, days };
      })
    ),
  }))
);

await writeFile("status.json", JSON.stringify({ updated: new Date().toISOString(), groups }));
const all = groups.flatMap((g) => g.items);
console.log(`Klart: ${all.length} tjänster, ${all.filter((i) => i.state === "bad").length} nere, ${all.filter((i) => i.state === "warn").length} långsamma`);

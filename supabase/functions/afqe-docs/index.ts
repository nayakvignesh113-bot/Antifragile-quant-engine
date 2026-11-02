// Document reader. pg_cron calls this every 5 minutes (header x-afqe-token).
// For one queued company (your list first, then scanned companies with transformation signals) it reads the latest
// investor presentation and call transcript, plus the presentation from ~2 years earlier (links from Screener's concalls
// list, served by BSE), extracts transformation inputs with core.parseDocs (rules, no AI) and stores them in afqe.docs.
// Deploy with verify_jwt = false (token checked in Postgres).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { DOMParser } from "npm:linkedom@0.18.5";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import * as core from "https://raw.githubusercontent.com/nayakvignesh113-bot/Antifragile-quant-engine/50200dcbfaa1145e08202f5dd30caa7685c35997/supabase/functions/afqe-parse/core.js";
(globalThis as any).DOMParser = DOMParser;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const mon = (d: string) => { const m = String(d || "").match(/(\w{3}) (\d{4})/); return m ? +m[2] * 12 + MON.indexOf(m[1]) : NaN; };

function pick(links: any[]) {
  const L = (links || []).filter((l) => l && l.d && (l.p || l.t));
  const p0 = L.find((l) => l.p), t0 = L.find((l) => l.t);
  const now: any[] = [];
  if (p0) now.push({ u: p0.p, label: "Presentation " + p0.d, date: p0.d, age: "now" });
  if (t0 && (!p0 || mon(p0.d) - mon(t0.d) <= 6)) now.push({ u: t0.t, label: "Call transcript " + t0.d, date: t0.d, age: "now" });
  const ref = mon((p0 || t0)?.d) - 24; let best: any = null, bd = 99;
  for (const l of L) { const dd = Math.abs(mon(l.d) - ref); if (dd < bd && dd <= 8) { bd = dd; best = l; } }
  const old = best ? [{ u: best.p || best.t, label: (best.p ? "Presentation " : "Call transcript ") + best.d, date: best.d, age: "old" }] : [];
  return { docs: [...now, ...old], latest: L[0] ? (L[0].p || L[0].t) : "" };
}

async function pdfText(u: string): Promise<string> {
  if (!/^https:\/\/(www\.)?bseindia\.com\//.test(u)) throw new Error("only BSE-hosted documents are read");
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 40000);
  const r = await fetch(u, { headers: { "User-Agent": UA, "Referer": "https://www.bseindia.com/" }, signal: ctl.signal }).finally(() => clearTimeout(tm));
  if (!r.ok) throw new Error("HTTP " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > 25e6) throw new Error("document too large");
  const pdf = await getDocumentProxy(buf); const t = await extractText(pdf, { mergePages: true });
  return String(t.text || "").slice(0, 400000);
}

Deno.serve(async (req) => {
  const token = req.headers.get("x-afqe-token") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: queue, error } = await sb.rpc("afqe_docs_queue", { token, lim: 1 });
  if (error) return json({ error: error.message }, 500);
  if (!Array.isArray(queue)) return json(queue, 401);
  const items: any[] = [];
  for (const it of queue) {
    try {
      const { docs, latest } = pick(it.links);
      if (!docs.length) { items.push({ symbol: it.symbol, err: "no documents listed" }); continue; }
      const read: any[] = [];
      for (const d of docs) { try { read.push({ ...d, text: await pdfText(d.u) }); } catch (e) { read.push({ ...d, text: "", err: String((e as Error)?.message || e).slice(0, 120) }); } }
      const res: any = core.parseDocs(read);
      const { auto, ...digest } = res;
      items.push({ symbol: it.symbol, auto, digest: [digest], used: read.every((d) => d.err) ? null : { latest, docs: docs.map((d) => d.u) }, err: read.filter((d) => d.err).map((d) => d.label + ": " + d.err).join("; ") || null });
    } catch (e) { items.push({ symbol: it.symbol, err: String((e as Error)?.message || e).slice(0, 200) }); }
  }
  if (!items.length) return json({ done: 0 });
  const { data: st, error: e2 } = await sb.rpc("afqe_docs_store", { token, items });
  if (e2) return json({ error: e2.message }, 500);
  return json({ done: items.length, stored: st, auto: items.map((x) => ({ s: x.symbol, a: x.auto, err: x.err })) });
});

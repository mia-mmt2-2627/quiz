// Grades one quiz submission (an issue in <login>-progress). Runs in the
// student's progress repo via the reusable workflow .github/workflows/grade.yml.
//
// SAFETY RULES (students can read the logs of this run):
// - never log the key, feedback or the generated file; only neutral counts
// - never copy raw text from the issue into the result or a comment; only text
//   from the key, the login and validated ids
// - the issue is read from GITHUB_EVENT_PATH, never via ${{ }} in a shell line
//
// Generated from student-onboarding (quiz/public-repo/); do not edit in the
// `quiz` repo itself, changes are overwritten on the next publish.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_BODY = 10000;
export const MAX_PARTS = 200;
const QUIZ_RE = /^([a-z0-9-]{1,40})@(\d{1,4})$/;
const PART_RE = /^([a-z0-9-]{1,20}):([a-f]|-)$/;
const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const PROGRESS_SUFFIX = "-progress";

export const MSG = {
  notAllowed: "Dit issue kan niet worden nagekeken.",
  tooLong: "Je inzending is te lang en kon niet worden gelezen. Open de quizlink opnieuw en klik op **Submit** zonder iets aan te passen.",
  unreadable: "Je antwoorden konden niet worden gelezen. Open de quizlink opnieuw en klik op **Submit** zonder iets aan te passen.",
  unknown: "Onbekende quiz. Open de quiz opnieuw via de link van je docent.",
  closed: "Deze quiz is gesloten en wordt niet meer nagekeken.",
};

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------
/** Text of an issue-form section "### <label>" up to the next "### ". */
export function section(body, label) {
  const lines = String(body).replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === `### ${label}`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !/^###\s/.test(lines[i]); i++) out.push(lines[i]);
  return out.join("\n").replace(/^\s*```[a-z]*\s*$/gim, "").trim();
}

export function isQuizIssue(body) {
  return typeof body === "string" && section(body, "Quiz") !== null && section(body, "Antwoorden") !== null;
}

/** { id, version } or null. */
export function parseQuizField(text) {
  const m = String(text ?? "").trim().match(QUIZ_RE);
  return m ? { id: m[1], version: Number(m[2]) } : null;
}

/** Map questionId -> optionId|null, or null when the text is not a valid answer list. */
export function parseAnswers(text) {
  const parts = String(text ?? "").split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.length > MAX_PARTS) return null;
  const map = new Map();
  for (const p of parts) {
    const m = p.match(PART_RE);
    if (!m) return null;
    map.set(m[1], m[2] === "-" ? null : m[2]); // a later duplicate wins
  }
  return map;
}

// ---------------------------------------------------------------------------
// Grading + markdown (pure)
// ---------------------------------------------------------------------------
export function grade(key, answers) {
  return key.questions.map((q, i) => {
    let chosen = answers.has(q.id) ? answers.get(q.id) : null;
    if (chosen && !q.options.some((o) => o.id === chosen)) chosen = null; // e.g. "e" on a 4-option question
    const state = chosen == null ? "open" : chosen === q.correct ? "ok" : "bad";
    const feedback = state === "ok" ? q.feedback.correct : (chosen && q.feedback.byOption?.[chosen]) || q.feedback.wrong;
    return { n: i + 1, q, chosen, state, feedback };
  });
}

export function score(results) {
  const part = (rs) => ({ ok: rs.filter((r) => r.state === "ok").length, n: rs.length });
  return { all: part(results), base: part(results.filter((r) => !r.q.pro)), pro: part(results.filter((r) => r.q.pro)) };
}

const pct = (ok, n) => (n ? Math.round((ok / n) * 100) : 0);

/** Escapes text from the key for use in markdown (outside code blocks). */
export function md(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>|#~])/g, "\\$1")
    .replace(/^(\s*)([-+]|\d+\.)(\s)/gm, "$1\\$2$3")
    .replace(/\n{2,}/g, "\n\n")             // blank line = new paragraph
    .replace(/([^\n])\n(?!\n)/g, "$1  \n"); // single newline = line break
}

/** A fenced code block whose fence is longer than any backtick run inside. */
export function fence(code, lang = "") {
  const longest = Math.max(0, ...(String(code).match(/`+/g) || []).map((s) => s.length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${code}\n${f}`;
}

/** "2026-11-26-1405" and "26 november 2026 om 14:05" in Europe/Amsterdam. */
export function amsterdam(iso) {
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  const nice = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", dateStyle: "long" }).format(d);
  return { stamp: `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}`, nice: `${nice} om ${p.hour}:${p.minute}` };
}

export function scoreLine(s) {
  const main = s.pro.n && s.base.n
    ? `${s.base.ok} van ${s.base.n} (${pct(s.base.ok, s.base.n)}%) · pro-vragen: ${s.pro.ok} van ${s.pro.n}`
    : `${s.all.ok} van ${s.all.n} (${pct(s.all.ok, s.all.n)}%)`;
  return main;
}

export function buildMarkdown({ key, results, attempt, when, isTest, login, submittedVersion }) {
  const s = score(results);
  const L = [];
  L.push(`# ${md(key.title)}`, "");
  L.push("> Oefenquiz: telt niet mee voor je cijfer.", "");
  L.push(`${isTest ? `**Testinzending** van ${md(login)}` : `**Poging ${attempt}**`} · ${when.nice} · versie ${key.version}`, "");
  if (submittedVersion !== key.version) {
    L.push(`> ⚠️ Je maakte een oudere versie van deze quiz (versie ${submittedVersion}). Er is nagekeken met versie ${key.version}; vragen die niet meer bestaan, tellen niet mee.`, "");
  }
  L.push(`## Score: ${scoreLine(s)}`, "");

  const topicRows = (rs) => {
    const topics = [...new Set(rs.map((r) => r.q.topic))];
    const rows = ["| Onderwerp | Goed | |", "|---|--:|--:|"];
    for (const t of topics) {
      const tr = rs.filter((r) => r.q.topic === t), ok = tr.filter((r) => r.state === "ok").length, p = pct(ok, tr.length);
      rows.push(`| ${md(t)} | ${ok}/${tr.length} | ${p < 60 ? `⚠️ **${p}%**` : `${p}%`} |`);
    }
    return rows;
  };
  const base = results.filter((r) => !r.q.pro), pro = results.filter((r) => r.q.pro);
  if (base.length) L.push(...topicRows(base), "");
  if (base.length && results.some((r) => r.state !== "ok")) L.push("⚠️ = minder dan 60% goed: lees de uitleg bij die vragen en de theorie nog eens.", "");
  if (pro.length) {
    const ok = pro.filter((r) => r.state === "ok").length;
    L.push(`**Pro-vragen:** ${ok} van ${pro.length} goed${base.length ? " (telt apart)" : ""}.`, "");
  }

  const card = (r) => {
    const badge = r.state === "ok" ? "✅ goed" : r.state === "bad" ? "❌ fout" : "⚪ niet beantwoord";
    const opt = (id) => r.q.options.find((o) => o.id === id)?.text ?? "";
    const out = [`### ${r.n}. ${md(r.q.topic)} — ${badge}`, "", md(r.q.question), ""];
    if (r.q.code) out.push(fence(r.q.code, r.q.language || key.language || ""), "");
    out.push(`- **Jouw antwoord:** ${r.chosen ? md(opt(r.chosen)) : "_niet beantwoord_"}`);
    if (r.state !== "ok") out.push(`- **Juiste antwoord:** ${md(opt(r.q.correct))}`);
    out.push("", md(r.feedback), "");
    return out;
  };
  if (base.length) { L.push("## Per vraag", ""); for (const r of base) L.push(...card(r)); }
  if (pro.length) {
    L.push("## Voor de pro's", "");
    if (key.bonus?.text) L.push(md(key.bonus.text), "");
    for (const r of pro) L.push(...card(r));
  }
  L.push("---", "", "_Opnieuw proberen mag altijd: elke inzending krijgt een eigen bestand in deze map._", "");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub I/O
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(token) {
  return async function call(pathname, init = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let res;
      try {
        res = await fetch(`https://api.github.com/${pathname}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "quiz-grader",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        });
      } catch {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (res.status >= 500 || res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      return res;
    }
    throw new Error(`API onbereikbaar (${pathname.split("/")[0]})`);
  };
}

async function readEngineJson(engine, org, file) {
  const res = await engine(`repos/${org}/quiz-engine/contents/${file}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`quiz-engine niet leesbaar (HTTP ${res.status})`);
  const body = await res.json();
  try {
    return JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
  } catch {
    throw new Error(`${file} in quiz-engine is geen geldige JSON`); // never quote the content
  }
}

/** Writes a NEW file; never overwrites (adds -2, -3, … when the name exists). */
async function writeNewFile(repo, full, dir, name, content, message) {
  for (let n = 1; n <= 20; n++) {
    const p = `${dir}/${name}${n === 1 ? "" : `-${n}`}.md`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await repo(`repos/${full}/contents/${p}`, { method: "PUT", body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64") }) });
      if (res.ok) return p;
      if (res.status === 422) break; // file exists -> next suffix
      if (res.status === 409) { await sleep(1000 * (attempt + 1)); continue; } // branch moved (other commit), retry
      throw new Error(`resultaat schrijven mislukt (HTTP ${res.status})`);
    }
  }
  throw new Error("geen vrije bestandsnaam gevonden");
}

export async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const issue = event.issue, repoInfo = event.repository;
  const org = repoInfo.owner.login, repoName = repoInfo.name, full = `${org}/${repoName}`;
  const repo = api(process.env.GITHUB_TOKEN);
  const engine = api(process.env.QUIZ_ENGINE_TOKEN);

  const reply = async (text, close = true) => {
    await repo(`repos/${full}/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: text }) });
    if (close) await repo(`repos/${full}/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
  };

  // 1. Is this a quiz issue at all? (e.g. a lecturer's own issue: leave it alone)
  const body = typeof issue.body === "string" ? issue.body : "";
  if (!isQuizIssue(body)) { console.log("Geen quiz-issue; niets gedaan."); return; }

  // 2. Author: the student of this repo, or a lecturer.
  const author = String(issue.user?.login || "");
  const expected = repoName.toLowerCase().endsWith(PROGRESS_SUFFIX) ? repoName.slice(0, -PROGRESS_SUFFIX.length).toLowerCase() : null;
  const teachers = ((await readEngineJson(engine, org, "teachers.json")) || []).map((t) => String(t).toLowerCase());
  const isTeacher = teachers.includes(author.toLowerCase());
  const isStudent = expected !== null && author.toLowerCase() === expected;
  if (!LOGIN_RE.test(author) || (!isStudent && !isTeacher)) {
    console.log("Auteur hoort niet bij deze repo; geweigerd.");
    await reply(MSG.notAllowed);
    return;
  }

  // 3. Parse defensively.
  if (body.length > MAX_BODY) { console.log("Inzending te lang."); await reply(MSG.tooLong); return; }
  const quiz = parseQuizField(section(body, "Quiz"));
  const answers = parseAnswers(section(body, "Antwoorden"));
  if (!quiz || !answers) { console.log("Inzending niet leesbaar."); await reply(MSG.unreadable); return; }

  const key = await readEngineJson(engine, org, `keys/${quiz.id}.json`);
  if (!key) { console.log("Onbekende quiz."); await reply(MSG.unknown); return; }
  if (key.status === "closed" || (key.status === "draft" && !isTeacher)) { console.log(`Quiz niet open (${key.status}).`); await reply(MSG.closed); return; }

  // 4. Grade, 5. build, 6. write.
  const results = grade(key, answers);
  const known = new Set(key.questions.map((q) => q.id));
  console.log(`${[...answers.keys()].filter((id) => known.has(id)).length} antwoorden verwerkt.`);
  const when = amsterdam(issue.created_at || new Date().toISOString());
  const dir = `quiz/${quiz.id}`;
  let attempt = 1;
  const list = await repo(`repos/${full}/contents/${dir}`);
  if (list.ok) {
    const files = await list.json();
    if (Array.isArray(files)) attempt = files.filter((f) => f.type === "file" && f.name.endsWith(".md") && !f.name.startsWith("test-")).length + 1;
  }
  const isTest = isTeacher; // a lecturer always writes a recognisable test file
  const name = isTest ? `test-${author.toLowerCase()}-${when.stamp}` : when.stamp;
  const content = buildMarkdown({ key, results, attempt, when, isTest, login: author, submittedVersion: quiz.version });
  const written = await writeNewFile(repo, full, dir, name, content, `Quiz ${quiz.id} nagekeken (#${issue.number})`);
  console.log("Bestand geschreven.");

  // 7. Comment + close.
  const s = score(results);
  const branch = repoInfo.default_branch || "main";
  const link = `https://github.com/${full}/blob/${encodeURIComponent(branch)}/${written.split("/").map(encodeURIComponent).join("/")}`;
  const lines = [
    `✅ Nagekeken: **${scoreLine(s)}**`,
    "",
    `Je feedback per vraag: [${written}](${link})`,
  ];
  if (quiz.version !== key.version) lines.push("", `⚠️ Je maakte een oudere versie van deze quiz (versie ${quiz.version}); er is nagekeken met versie ${key.version}.`);
  if (isTest) lines.push("", "_Testinzending van een docent._");
  await reply(lines.join("\n"));
  console.log("Klaar.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    // Only the error message (never key content), so the lecturer can see what failed.
    console.log(`::error::Nakijken mislukt: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
    process.exit(1);
  });
}

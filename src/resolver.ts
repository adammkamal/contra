import type { Alias, ExtractedBackCharge, Job, Subcontract } from "./types.ts";

export interface ResolverData {
  jobs: readonly Job[];
  subcontracts: readonly Subcontract[];
  aliases: readonly Alias[];
}

export type Resolution =
  | { kind: "linked"; subcontractId: string; explanation: string[] }
  | { kind: "review"; reasons: string[]; hints: string[] };

const SUFFIXES = new Set(["llc", "inc", "co", "corp", "corporation", "company", "ltd", "lp", "llp"]);

export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join(" ");
}

/**
 * A name is ambiguous for `party` when every word of the normalized name also appears in a
 * different party's legal name ("Ridgeline" vs Ridgeline Glass & Glazing). Returns that other
 * party's legal name, or null. An empty name is ambiguous against any other party.
 */
export function ambiguousWith(name: string, party: string, parties: readonly string[]): string | null {
  const words = normName(name).split(" ").filter(Boolean);
  const self = normName(party);
  for (const p of parties) {
    const np = normName(p);
    if (np === self) continue;
    const toks = new Set(np.split(" "));
    if (words.every((w) => toks.has(w))) return p;
  }
  return null;
}

/** The jobs whose id, name or an alias normalizes to `jobRef`. Exactly one means the job resolved. */
export function matchJobs(jobRef: string, jobs: readonly Job[]): Job[] {
  const jr = normName(jobRef);
  return jobs.filter((j) => [j.id, j.name, ...j.aliases].some((n) => normName(n) === jr));
}

/**
 * Deterministic linkage: job -> subcontracts on that job -> party name or confirmed alias.
 * Inputs are deliberately limited to party names and aliases: remit-to, payee and lockbox
 * names never reach this function (INVARIANT 8).
 */
export function resolve(x: Pick<ExtractedBackCharge, "jobRef" | "vendorNameAsWritten">, data: ResolverData): Resolution {
  const explanation: string[] = [];

  const jobs = matchJobs(x.jobRef, data.jobs);
  if (jobs.length !== 1) {
    return {
      kind: "review",
      reasons: [jobs.length === 0 ? `no job matches "${x.jobRef}"` : `"${x.jobRef}" matches ${jobs.length} jobs`],
      hints: jobs.map((j) => j.id),
    };
  }
  const job = jobs[0]!;
  explanation.push(`job: "${x.jobRef}" -> ${job.id} ${job.name}`);

  const onJob = data.subcontracts.filter((s) => s.jobId === job.id);
  const vn = normName(x.vendorNameAsWritten);

  const direct = onJob.filter((s) => normName(s.partyLegalName) === vn);
  // An alias whose name is ambiguous against another party on this job never links: it may have been
  // learned before that party was added.
  const jobParties = onJob.map((s) => s.partyLegalName);
  const ignored: string[] = [];
  const viaAlias = data.aliases
    .filter((a) => normName(a.alias) === vn)
    .flatMap((a) => onJob.filter((s) => normName(s.partyLegalName) === normName(a.partyLegalName)).map((s) => ({ s, a })))
    .filter(({ a }) => {
      const other = ambiguousWith(a.alias, a.partyLegalName, jobParties);
      if (!other) return true;
      const why = `alias "${a.alias}" -> ${a.partyLegalName} ignored: every word of it also appears in ${other}, another party on ${job.id}`;
      if (!ignored.includes(why)) ignored.push(why);
      return false;
    });

  const ids = new Set([...direct.map((s) => s.id), ...viaAlias.map((v) => v.s.id)]);
  if (ids.size === 1) {
    const id = [...ids][0]!;
    const sc = onJob.find((s) => s.id === id)!;
    if (direct.length) explanation.push(`party: "${x.vendorNameAsWritten}" = legal name ${sc.partyLegalName}`);
    else {
      const a = viaAlias[0]!.a;
      explanation.push(`alias: "${x.vendorNameAsWritten}" -> ${sc.partyLegalName} (${a.source}${a.confirmedBy ? `, ${a.confirmedBy}` : ""})`);
    }
    explanation.push(`subcontract: ${sc.id} (${sc.scope}) on ${job.id}`);
    return { kind: "linked", subcontractId: id, explanation };
  }

  const hints = onJob
    .filter((s) => {
      const toks = new Set(normName(s.partyLegalName).split(" "));
      return vn.split(" ").some((t) => toks.has(t));
    })
    .map((s) => `${s.id} ${s.partyLegalName}`);
  return {
    kind: "review",
    reasons: [
      ids.size === 0
        ? `no party or confirmed alias on ${job.id} matches "${x.vendorNameAsWritten}"`
        : `"${x.vendorNameAsWritten}" matches ${ids.size} subcontracts on ${job.id}`,
      ...ignored,
    ],
    hints,
  };
}

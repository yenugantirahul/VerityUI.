import type { ComparisonSummary } from '../compare/compare.ts';
import type { StructuralEvidence } from '../compare/structure.ts';
import type { DashboardCheck } from '../fixture/assertions.ts';
import type { evaluateIntent } from '../verification/intent.ts';
import type { VisionAnalysis } from '../verification/vision.ts';

export interface ReportResult {
  key: string;
  route?: string;
  viewport?: string;
  comparison?: ComparisonSummary;
  structure?: StructuralEvidence;
  intent?: ReturnType<typeof evaluateIntent>;
  analysis?: VisionAnalysis;
  failure?: string;
  checks: DashboardCheck[];
  evidence: string[];
}

export interface Report {
  version: 1;
  commit: string | null;
  baselineCommit?: string;
  status:
    | 'failed'
    | 'review_required'
    | 'inconclusive'
    | 'reference_created'
    | 'passed';
  variant?: string;
  results: ReportResult[];
}

function escape(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

export function renderReport(report: Report) {
  const sections = report.results.map((result) => {
    const screenshots = result.evidence
      .filter((name) => name.endsWith('.png'))
      .map((name) => {
        const path = escape(name);
        return `<figure><a href="${path}"><img loading="lazy" src="${path}" alt="${path}"></a><figcaption>${path}</figcaption></figure>`;
      });
    const files = result.evidence
      .filter((name) => name.endsWith('.json'))
      .map((name) => `<a href="${escape(name)}">${escape(name)}</a>`);
    const changes =
      result.structure?.changes.map(
        (change) =>
          `<tr><td>${escape(change.component ?? change.element)}${change.source ? `<small>${escape(change.source)} · instrumented location</small>` : ''}</td><td>${escape(change.match)}</td><td>${change.properties
            .map(
              ({ name, before, after }) =>
                `<div><b>${escape(name)}</b> ${escape(before)} → ${escape(after)}</div>`,
            )
            .join('')}</td></tr>`,
      ) ?? [];
    const reasons = result.intent?.reasons
      .map((reason) => `<li>${escape(reason)}</li>`)
      .join('');
    const failedChecks = result.checks.filter(({ passed }) => !passed);
    return `<section>
      <h2>${escape(result.route ?? result.key)}${result.viewport ? ` <small>${escape(result.viewport)}</small>` : ''}</h2>
      <p>${escape(result.failure ?? result.comparison?.message ?? 'Reference capture recorded.')}</p>
      ${reasons ? `<ul>${reasons}</ul>` : ''}
      ${result.analysis?.status === 'classified' ? `<p><b>AI suggestion · ${escape(result.analysis.result.verdict)} · ${escape(result.analysis.result.severity)}</b><br>${escape(result.analysis.result.explanation)}</p>` : result.analysis ? `<p>AI classification unavailable. Evidence is ready for review.</p>` : ''}
      ${failedChecks.length ? `<p>Failed checks · ${escape(failedChecks.map(({ id }) => id).join(', '))}</p>` : ''}
      <div class="evidence">${screenshots.join('')}</div>
      ${changes.length ? `<details open><summary>Element changes (${changes.length})</summary><table><thead><tr><th>Element</th><th>Match</th><th>Changes</th></tr></thead><tbody>${changes.join('')}</tbody></table></details>` : ''}
      ${files.length ? `<div class="files">${files.join('')}</div>` : ''}
    </section>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Verification report · VerityUI</title>
<style>
*{box-sizing:border-box}body{max-width:80rem;margin:auto;padding:clamp(1rem,4vw,3rem);font:1rem/1.55 system-ui,sans-serif;color:#19221e;background:#f3f5f2}header{padding:0 0 1.5rem}h1,h2,p{margin:.35rem 0}h1{font-size:clamp(2rem,5vw,3.4rem);letter-spacing:-.05em}h2 small,td small{font-size:.86rem;font-weight:500;color:#46574e}td small{display:block}section{background:#fff;border:1px solid #d9e2db;border-radius:1rem;padding:clamp(.9rem,3vw,1.6rem);margin:0 0 1rem}a{color:#16583d}strong{color:#16583d}figure{margin:0;min-width:0}img{display:block;width:100%;max-height:25rem;object-fit:contain;object-position:top;background:#eee;border:1px solid #e2e7e3;border-radius:.6rem}figcaption,.files{font-size:.88rem;overflow-wrap:anywhere}.evidence{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));gap:1rem;margin:1rem 0}details{overflow:auto}summary{cursor:pointer;font-weight:650;padding:.4rem 0}table{border-collapse:collapse;text-align:left;min-width:100%;overflow-wrap:anywhere}td,th{border-top:1px solid #d9e2db;padding:.5rem;vertical-align:top}.files{display:flex;flex-wrap:wrap;gap:.8rem;margin-top:1rem}
</style></head>
<body><header><strong>VerityUI</strong><h1>Verification report</h1>
<p>${escape(report.status.replaceAll('_', ' '))}${report.commit ? ` · Commit <code>${escape(report.commit)}</code>` : ''}${report.baselineCommit ? ` · Baseline <code>${escape(report.baselineCommit)}</code>` : ''}</p>
<a href="report.json">Machine-readable report</a></header>
${sections.join('\n')}</body></html>\n`;
}

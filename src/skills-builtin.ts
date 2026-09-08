/**
 * Skills bundled with the binary.
 *
 * Each skill is a Markdown file in `src/skills-md/`, loaded here as a raw-text import.
 * The `.md` file is the single source of truth — frontmatter and body in proper
 * Markdown — so skills are edited and reviewed as Markdown, not as escaped strings
 * inside TypeScript. Bun inlines every text import into the compiled binary, so the
 * folder ships with `bun build --compile` exactly as the old string constants did.
 */
import accessibility from './skills-md/accessibility.md' with { type: 'text' };
import apiDesign from './skills-md/api-design.md' with { type: 'text' };
import ciCd from './skills-md/ci-cd.md' with { type: 'text' };
import commit from './skills-md/commit.md' with { type: 'text' };
import data from './skills-md/data.md' with { type: 'text' };
import db from './skills-md/db.md' with { type: 'text' };
import debug from './skills-md/debug.md' with { type: 'text' };
import deps from './skills-md/deps.md' with { type: 'text' };
import docker from './skills-md/docker.md' with { type: 'text' };
import docs from './skills-md/docs.md' with { type: 'text' };
import frontend from './skills-md/frontend.md' with { type: 'text' };
import gitWorkflow from './skills-md/git-workflow.md' with { type: 'text' };
import i18n from './skills-md/i18n.md' with { type: 'text' };
import incident from './skills-md/incident.md' with { type: 'text' };
import logging from './skills-md/logging.md' with { type: 'text' };
import migrate from './skills-md/migrate.md' with { type: 'text' };
import onboarding from './skills-md/onboarding.md' with { type: 'text' };
import optimizeSql from './skills-md/optimize-sql.md' with { type: 'text' };
import perf from './skills-md/perf.md' with { type: 'text' };
import perfFrontend from './skills-md/perf-frontend.md' with { type: 'text' };
import plan from './skills-md/plan.md' with { type: 'text' };
import readme from './skills-md/readme.md' with { type: 'text' };
import refactor from './skills-md/refactor.md' with { type: 'text' };
import release from './skills-md/release.md' with { type: 'text' };
import review from './skills-md/review.md' with { type: 'text' };
import security from './skills-md/security.md' with { type: 'text' };
import test from './skills-md/test.md' with { type: 'text' };
import uxCopy from './skills-md/ux-copy.md' with { type: 'text' };
import verify from './skills-md/verify.md' with { type: 'text' };

export const BUILTIN_SKILLS: { name: string; source: string }[] = [
  { name: 'accessibility', source: accessibility },
  { name: 'api-design', source: apiDesign },
  { name: 'ci-cd', source: ciCd },
  { name: 'commit', source: commit },
  { name: 'data', source: data },
  { name: 'db', source: db },
  { name: 'debug', source: debug },
  { name: 'deps', source: deps },
  { name: 'docker', source: docker },
  { name: 'docs', source: docs },
  { name: 'frontend', source: frontend },
  { name: 'git-workflow', source: gitWorkflow },
  { name: 'i18n', source: i18n },
  { name: 'incident', source: incident },
  { name: 'logging', source: logging },
  { name: 'migrate', source: migrate },
  { name: 'onboarding', source: onboarding },
  { name: 'optimize-sql', source: optimizeSql },
  { name: 'perf', source: perf },
  { name: 'perf-frontend', source: perfFrontend },
  { name: 'plan', source: plan },
  { name: 'readme', source: readme },
  { name: 'refactor', source: refactor },
  { name: 'release', source: release },
  { name: 'review', source: review },
  { name: 'security', source: security },
  { name: 'test', source: test },
  { name: 'ux-copy', source: uxCopy },
  { name: 'verify', source: verify },
];

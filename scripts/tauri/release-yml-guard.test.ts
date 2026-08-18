import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url));

type WorkflowJob = {
  readonly needs?: string | ReadonlyArray<string>;
  readonly environment?: unknown;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: ReadonlyArray<{
    readonly uses?: string;
    readonly run?: string;
  }>;
  readonly if?: string;
};

type ReleaseWorkflow = {
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
};

const workflow = parse(readFileSync(workflowPath, "utf8")) as ReleaseWorkflow;

const needsOf = (job: WorkflowJob): ReadonlyArray<string> => {
  if (job.needs === undefined) return [];
  return typeof job.needs === "string" ? [job.needs] : job.needs;
};

const transitiveNeeds = (
  jobs: ReleaseWorkflow["jobs"],
  jobName: string,
  result = new Set<string>(),
): ReadonlySet<string> => {
  for (const dependency of needsOf(jobs[jobName]!)) {
    if (result.has(dependency)) continue;
    result.add(dependency);
    transitiveNeeds(jobs, dependency, result);
  }
  return result;
};

const MUTATING_COMMAND =
  /\b(?:git\s+push|npm\s+publish|pnpm\s+publish|gh\s+(?:release|api)|wrangler\s+deploy|curl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE))\b/i;

const assertReadOnly = (jobName: string, job: WorkflowJob) => {
  expect(job.environment, `${jobName} must not select a deployment environment`).toBeUndefined();

  for (const [permission, access] of Object.entries(job.permissions ?? {})) {
    expect(
      access === "read" || access === "none",
      `${jobName} grants ${permission}: ${access}`,
    ).toBe(true);
  }

  for (const step of job.steps ?? []) {
    if (step.uses !== undefined) {
      expect(step.uses, `${jobName} uses a non-read-only action`).toMatch(/^actions\/checkout@/);
    }
    expect(
      step.run ?? "",
      `${jobName} contains a repository or external mutation command`,
    ).not.toMatch(MUTATING_COMMAND);
  }
};

describe("upstream release workflow fork guard", () => {
  it("guards preflight to the upstream repository", () => {
    expect(workflow.jobs.preflight?.if).toContain("github.repository == 'pingdotgg/t3code'");
  });

  it("keeps preflight dependencies read-only", () => {
    const exemptJobs = transitiveNeeds(workflow.jobs, "preflight");
    expect([...exemptJobs]).toEqual(["check_changes"]);

    for (const jobName of exemptJobs) {
      assertReadOnly(jobName, workflow.jobs[jobName]!);
    }
  });

  it("routes every other job transitively through preflight", () => {
    const exemptJobs = transitiveNeeds(workflow.jobs, "preflight");

    for (const jobName of Object.keys(workflow.jobs)) {
      if (jobName === "preflight" || exemptJobs.has(jobName)) continue;
      expect(
        transitiveNeeds(workflow.jobs, jobName).has("preflight"),
        `${jobName} can run without preflight`,
      ).toBe(true);
    }
  });

  it("keeps the workflow under the expected repository root", () => {
    expect(workflowPath.startsWith(repositoryRoot)).toBe(true);
  });
});

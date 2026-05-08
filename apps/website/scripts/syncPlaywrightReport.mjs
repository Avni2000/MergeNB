import {mkdtemp, readFile, rm, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPORT_ARTIFACT_PREFIX = 'playwright-report-';
const WORKFLOW_FILE_NAME = 'all-tests.yml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEBSITE_ROOT = path.resolve(__dirname, '..');
const STATIC_CI_DIR = path.join(WEBSITE_ROOT, 'static', 'ci');
const REPORTS_DIR = path.join(STATIC_CI_DIR, 'reports');
const METADATA_PATH = path.join(STATIC_CI_DIR, 'playwright-report-metadata.json');

async function ensureDirectory(dirPath) {
    await mkdir(dirPath, {recursive: true});
}

async function clearDirectory(dirPath) {
    await rm(dirPath, {recursive: true, force: true});
    await mkdir(dirPath, {recursive: true});
}

async function writeMetadata(metadata) {
    await ensureDirectory(STATIC_CI_DIR);
    await writeFile(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

function sanitizeSegment(value) {
    return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function shortSha(sha) {
    return sha ? sha.slice(0, 7) : null;
}

function getRepoContext() {
    const repository = process.env.GITHUB_REPOSITORY ?? 'Avni2000/MergeNB';
    const [owner, repo] = repository.split('/');

    if (!owner || !repo) {
        throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
    }

    return {owner, repo, repository};
}

function getHeaders() {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

    if (!token) {
        return null;
    }

    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MergeNB-website-sync',
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

async function githubJson(url, headers) {
    const response = await fetch(url, {headers});
    if (!response.ok) {
        throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
    }

    return response.json();
}

async function getRunById(headers, runId) {
    const {owner, repo} = getRepoContext();
    return githubJson(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`, headers);
}

async function listArtifactsForRun(headers, runId) {
    const {owner, repo} = getRepoContext();
    const data = await githubJson(
        `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
        headers,
    );

    return (data.artifacts ?? []).filter((artifact) => {
        return !artifact.expired && artifact.name?.startsWith(REPORT_ARTIFACT_PREFIX);
    });
}

async function findLatestRunWithArtifacts(headers) {
    const {owner, repo} = getRepoContext();
    const data = await githubJson(
        `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE_NAME}/runs?per_page=20`,
        headers,
    );

    for (const run of data.workflow_runs ?? []) {
        if (run.status !== 'completed') {
            continue;
        }

        const artifacts = await listArtifactsForRun(headers, run.id);
        if (artifacts.length > 0) {
            return {run, artifacts};
        }
    }

    return null;
}

async function downloadArtifactZip(artifact, headers, destinationZipPath) {
    const response = await fetch(artifact.archive_download_url, {
        headers,
        redirect: 'follow',
    });

    if (!response.ok) {
        throw new Error(`Artifact download failed (${response.status}) for ${artifact.name}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    await writeFile(destinationZipPath, Buffer.from(arrayBuffer));
}

function unzipArchive(zipPath, outputDir) {
    const unzip = spawnSync('unzip', ['-oq', zipPath, '-d', outputDir], {
        stdio: 'pipe',
        encoding: 'utf8',
    });

    if (unzip.error) {
        throw unzip.error;
    }

    if (unzip.status !== 0) {
        throw new Error(unzip.stderr.trim() || `Unzip failed for ${zipPath}`);
    }
}

async function syncArtifacts(run, artifacts, headers) {
    await clearDirectory(REPORTS_DIR);

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mergenb-playwright-report-'));

    try {
        const syncedReports = [];

        for (const artifact of artifacts) {
            const slugBase = sanitizeSegment(artifact.name);
            const slug = slugBase || `artifact-${artifact.id}`;
            const targetDir = path.join(REPORTS_DIR, slug);
            const zipPath = path.join(tempRoot, `${slug}.zip`);

            await ensureDirectory(targetDir);
            await downloadArtifactZip(artifact, headers, zipPath);
            unzipArchive(zipPath, targetDir);

            syncedReports.push({
                artifactId: artifact.id,
                artifactName: artifact.name,
                sizeInBytes: artifact.size_in_bytes ?? null,
                createdAt: artifact.created_at ?? null,
                updatedAt: artifact.updated_at ?? null,
                slug,
                reportPath: `/ci/reports/${slug}/playwright-report/index.html`,
                rawResultsPath: `/ci/reports/${slug}/playwright-test-results`,
            });
        }

        return syncedReports;
    } finally {
        await rm(tempRoot, {recursive: true, force: true});
    }
}

async function maybeReadWorkflowEventPayload() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
        return null;
    }

    try {
        const payloadText = await readFile(eventPath, 'utf8');
        return JSON.parse(payloadText);
    } catch {
        return null;
    }
}

async function run() {
    const headers = getHeaders();
    if (!headers) {
        await writeMetadata({
            status: 'unavailable',
            reason: 'Missing GITHUB_TOKEN. CI report sync only runs in GitHub Actions.',
            syncedAt: new Date().toISOString(),
            reports: [],
        });
        return;
    }

    const requestedRunId = process.env.MERGENB_SOURCE_RUN_ID;
    let run;
    let artifacts;

    if (requestedRunId) {
        run = await getRunById(headers, requestedRunId);
        artifacts = await listArtifactsForRun(headers, requestedRunId);
    } else {
        const latest = await findLatestRunWithArtifacts(headers);
        if (!latest) {
            await clearDirectory(REPORTS_DIR);
            await writeMetadata({
                status: 'empty',
                reason: `No non-expired ${REPORT_ARTIFACT_PREFIX} artifacts were found for ${WORKFLOW_FILE_NAME}.`,
                syncedAt: new Date().toISOString(),
                reports: [],
            });
            return;
        }

        run = latest.run;
        artifacts = latest.artifacts;
    }

    if (artifacts.length === 0) {
        await clearDirectory(REPORTS_DIR);
        await writeMetadata({
            status: 'empty',
            reason: `Run ${run.id} did not publish any ${REPORT_ARTIFACT_PREFIX} artifacts.`,
            syncedAt: new Date().toISOString(),
            run: {
                id: run.id,
                name: run.name ?? null,
                event: run.event ?? null,
                status: run.status ?? null,
                conclusion: run.conclusion ?? null,
                htmlUrl: run.html_url ?? null,
                branch: run.head_branch ?? null,
                commitSha: run.head_sha ?? null,
                commitShortSha: shortSha(run.head_sha),
                runNumber: run.run_number ?? null,
                runAttempt: run.run_attempt ?? null,
                createdAt: run.created_at ?? null,
                updatedAt: run.updated_at ?? null,
            },
            reports: [],
        });
        return;
    }

    const payload = await maybeReadWorkflowEventPayload();
    const syncedReports = await syncArtifacts(run, artifacts, headers);

    await writeMetadata({
        status: 'ready',
        syncedAt: new Date().toISOString(),
        source: {
            eventName: process.env.GITHUB_EVENT_NAME ?? null,
            workflowTriggeringRunId: requestedRunId || null,
        },
        run: {
            id: run.id,
            name: run.name ?? null,
            event: run.event ?? null,
            status: run.status ?? null,
            conclusion: run.conclusion ?? null,
            htmlUrl: run.html_url ?? null,
            branch: run.head_branch ?? null,
            commitSha: run.head_sha ?? null,
            commitShortSha: shortSha(run.head_sha),
            runNumber: run.run_number ?? null,
            runAttempt: run.run_attempt ?? null,
            createdAt: run.created_at ?? null,
            updatedAt: run.updated_at ?? null,
        },
        pullRequest: payload?.workflow_run?.pull_requests?.[0]
            ? {
                number: payload.workflow_run.pull_requests[0].number ?? null,
                htmlUrl: payload.workflow_run.pull_requests[0].html_url ?? null,
            }
            : null,
        reports: syncedReports,
    });
}

run().catch(async (error) => {
    console.error('[syncPlaywrightReport] Failed to sync CI report:', error);

    try {
        await clearDirectory(REPORTS_DIR);
        await writeMetadata({
            status: 'error',
            reason: error instanceof Error ? error.message : 'Unknown sync error',
            syncedAt: new Date().toISOString(),
            reports: [],
        });
    } catch (metadataError) {
        console.error('[syncPlaywrightReport] Failed to write fallback metadata:', metadataError);
    }

    process.exitCode = 1;
});

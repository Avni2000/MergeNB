import {useEffect, useMemo, useState, type ReactNode} from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './ci-report.module.css';

type ReportEntry = {
    artifactId: number;
    artifactName: string;
    sizeInBytes: number | null;
    createdAt: string | null;
    updatedAt: string | null;
    slug: string;
    reportPath: string;
    rawResultsPath: string | null;
};

type RunMetadata = {
    id: number;
    name: string | null;
    event: string | null;
    status: string | null;
    conclusion: string | null;
    htmlUrl: string | null;
    branch: string | null;
    commitSha: string | null;
    commitShortSha: string | null;
    runNumber: number | null;
    runAttempt: number | null;
    createdAt: string | null;
    updatedAt: string | null;
};

type PullRequestMetadata = {
    number: number | null;
    htmlUrl: string | null;
} | null;

type Manifest = {
    status: 'ready' | 'empty' | 'error' | 'unavailable';
    reason?: string;
    syncedAt: string | null;
    run?: RunMetadata;
    pullRequest?: PullRequestMetadata;
    reports: ReportEntry[];
};

function formatTimestamp(value: string | null | undefined) {
    if (!value) {
        return 'Unavailable';
    }

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(value));
}

function formatBytes(value: number | null) {
    if (!value || value <= 0) {
        return 'Unknown size';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function titleCase(value: string | null | undefined) {
    if (!value) {
        return 'Unknown';
    }

    return value
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function EmptyState({manifest}: {manifest: Manifest | null}): ReactNode {
    const reason = manifest?.reason ?? 'No Playwright report has been synced into the website yet.';

    return (
        <div className={styles.emptyCard}>
            <h2>No synced CI report yet</h2>
            <p className={styles.emptyState}>{reason}</p>
            <p className={styles.viewerHint}>
                The page refreshes from GitHub Actions after the `MergeNB Tests` workflow completes and uploads
                Playwright report artifacts.
            </p>
        </div>
    );
}

function ReportViewer(): ReactNode {
    const manifestUrl = useBaseUrl('/ci/playwright-report-metadata.json');
    const [manifest, setManifest] = useState<Manifest | null>(null);
    const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                const response = await fetch(manifestUrl, {cache: 'no-store'});
                if (!response.ok) {
                    throw new Error(`Unable to load CI report metadata (${response.status})`);
                }

                const nextManifest = (await response.json()) as Manifest;
                if (cancelled) {
                    return;
                }

                setManifest(nextManifest);
                setSelectedSlug((currentSlug) => {
                    if (currentSlug && nextManifest.reports.some((report) => report.slug === currentSlug)) {
                        return currentSlug;
                    }

                    return nextManifest.reports[0]?.slug ?? null;
                });
            } catch (error) {
                if (cancelled) {
                    return;
                }

                const message = error instanceof Error ? error.message : 'Unknown metadata error';
                setErrorMessage(message);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [manifestUrl]);

    const selectedReport = useMemo(() => {
        if (!manifest) {
            return null;
        }

        return manifest.reports.find((report) => report.slug === selectedSlug) ?? manifest.reports[0] ?? null;
    }, [manifest, selectedSlug]);

    if (errorMessage) {
        return <EmptyState manifest={{status: 'error', reason: errorMessage, syncedAt: null, reports: []}} />;
    }

    if (!manifest || manifest.status !== 'ready' || manifest.reports.length === 0 || !selectedReport) {
        return <EmptyState manifest={manifest} />;
    }

    const run = manifest.run;
    const reportUrl = useBaseUrl(selectedReport.reportPath);

    return (
        <div className={styles.shell}>
            <section className={styles.hero}>
                <p className={styles.eyebrow}>Continuous Integration</p>
                <h1>Latest Playwright report from GitHub Actions</h1>
                <p>
                    This page republishes the most recent Playwright HTML artifact that the `MergeNB Tests`
                    workflow uploaded, so we can inspect failures without downloading the zip manually.
                </p>
                <div className={styles.summary}>
                    <span className={styles.pill}>Run #{run?.runNumber ?? 'Unknown'}</span>
                    <span className={styles.pill}>{titleCase(run?.conclusion)}</span>
                    <span className={styles.pill}>{run?.branch ?? 'Unknown branch'}</span>
                    <span className={styles.pill}>{run?.commitShortSha ?? 'Unknown commit'}</span>
                    <span className={styles.pill}>Synced {formatTimestamp(manifest.syncedAt)}</span>
                </div>
                <div className={styles.actions}>
                    {run?.htmlUrl ? (
                        <Link className={styles.primaryAction} href={run.htmlUrl}>
                            Open workflow run
                        </Link>
                    ) : null}
                    <a className={styles.secondaryAction} href={reportUrl} target="_blank" rel="noreferrer">
                        Open report in a new tab
                    </a>
                    {manifest.pullRequest?.htmlUrl ? (
                        <Link className={styles.secondaryAction} href={manifest.pullRequest.htmlUrl}>
                            View pull request #{manifest.pullRequest.number ?? '?'}
                        </Link>
                    ) : null}
                </div>
            </section>

            <div className={styles.grid}>
                <aside className={styles.panel}>
                    <h2>Available report artifacts</h2>
                    <div className={styles.reportList}>
                        {manifest.reports.map((report) => {
                            const isActive = report.slug === selectedReport.slug;

                            return (
                                <button
                                    key={report.slug}
                                    type="button"
                                    onClick={() => setSelectedSlug(report.slug)}
                                    className={`${styles.reportButton} ${isActive ? styles.reportButtonActive : ''}`}
                                >
                                    <span className={styles.reportName}>{report.artifactName}</span>
                                    <span className={styles.reportMeta}>
                                        {formatBytes(report.sizeInBytes)} · updated {formatTimestamp(report.updatedAt)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </aside>

                <section className={styles.viewer}>
                    <div className={styles.viewerHeader}>
                        <div>
                            <h2>{selectedReport.artifactName}</h2>
                            <p className={styles.viewerHint}>
                                The embedded view is the original Playwright HTML report served from this site.
                            </p>
                        </div>
                        <div className={styles.detailsList}>
                            <div className={styles.detailsRow}>
                                <span className={styles.detailsLabel}>Workflow</span>
                                <span>{run?.name ?? 'MergeNB Tests'}</span>
                            </div>
                            <div className={styles.detailsRow}>
                                <span className={styles.detailsLabel}>Event</span>
                                <span>{titleCase(run?.event)}</span>
                            </div>
                            <div className={styles.detailsRow}>
                                <span className={styles.detailsLabel}>Updated</span>
                                <span>{formatTimestamp(run?.updatedAt)}</span>
                            </div>
                        </div>
                    </div>

                    <iframe
                        className={styles.viewerFrame}
                        src={reportUrl}
                        title={`Playwright report for ${selectedReport.artifactName}`}
                    />
                </section>
            </div>
        </div>
    );
}

export default function CiReportPage(): ReactNode {
    return (
        <Layout title="CI Report" description="Latest synced Playwright report from GitHub Actions">
            <main className={styles.page}>
                <div className="container">
                    <BrowserOnly fallback={<EmptyState manifest={null} />}>
                        {() => <ReportViewer />}
                    </BrowserOnly>
                </div>
            </main>
        </Layout>
    );
}

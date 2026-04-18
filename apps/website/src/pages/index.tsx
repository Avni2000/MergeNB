import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';

import styles from './index.module.css';

interface Feature {
  title: string;
  blurb: string;
}

const features: Feature[] = [
  {
    title: 'Cell-aware resolution',
    blurb: 'Resolve notebook merge conflicts visually with intelligent cell-by-cell comparison',
  },
  {
    title: 'Smart reordering detection',
    blurb:
      'Matches cells across versions even when they\'ve moved around',
  },
  {
    title: 'Auto-resolution',
    blurb:
      'Execution counts, outputs, whitespace, and kernel metadata conflicts get handled cleanly when settings allow.',
  },
  {
    title: 'Undo and redo, per action',
    blurb:
      'Every pick, take-all, or hand edit stacks on a bounded history. Undo and redo freely.',
  },
  {
    title: 'Handle all MIME types',
    blurb:
      'Images, HTML, LaTeX, SVG plots, etc.',
  },
  // TODO: this should be removed or changed when we more for non-VS Code users
  {
    title: 'No extra Git plumbing',
    blurb:
      'Just a VS Code extension (for now). No need to set up a custom merge driver or change your workflow.',
  },
];

function Hero(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <section className={styles.hero}>
      <div className={styles.heroInner}>
        <h1 className={styles.title}>{siteConfig.title}</h1>
        <p className={styles.subtitle}>{siteConfig.tagline}</p>
        <div className={styles.heroActions}>
          <Link className={styles.buttonPrimary} to="/playground">
            Open the playground
          </Link>
          <Link className={styles.buttonSecondary} to="/docs/installation">
            Installation
          </Link>
          <Link className={styles.buttonGhost} to="/docs/overview">
            Read the docs
          </Link>
        </div>
      </div>
    </section>
  );
}

function Features(): ReactNode {
  return (
    <section className={styles.features} id="features">
      <div className={styles.sectionInner}>
        <h2 className={styles.sectionTitle}>Features</h2>
        <ul className={styles.featureGrid}>
          {features.map((f) => (
            <li key={f.title} className={styles.featureItem}>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureBlurb}>{f.blurb}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Preview(): ReactNode {
  return (
    <section className={styles.preview}>
      <div className={styles.sectionInner}>
        <div className={styles.previewText}>
          <h2 className={styles.sectionTitle}>Conflict Resolution Panel</h2>
          <p className={styles.previewBlurb}>
            MergeNB presents every conflicted cell cleanly with a diff of what's conflicted. 
            Auto-resolution fires first, so the UI only shows you the conflicts that actually needs human input.
          </p>
          <div className={styles.previewActions}>
            <Link className={styles.buttonPrimary} to="/playground">
              Try it in the browser
            </Link>
          </div>
        </div>
        <div className={styles.previewImage}>
          <img
            src="img/dark-theme.png"
            alt="MergeNB resolver, dark theme"
            loading="lazy"
          />
        </div>
      </div>
    </section>
  );
}

function Layout3(): ReactNode {
  return (
    <section className={styles.layers}>
      <div className={styles.sectionInner}>
        <h2 className={styles.sectionTitle}>How it's built</h2>
        <div className={styles.layerGrid}>
          <div className={styles.layer}>
            <span className={styles.layerTag}>packages/core</span>
            <p>
              Pure TypeScript. Notebook parsing, cell matching, conflict
              detection, auto-resolution. Zero VS Code or DOM imports.
            </p>
            <Link to="/docs/packages/core">Read more →</Link>
          </div>
          <div className={styles.layer}>
            <span className={styles.layerTag}>packages/web</span>
            <p>
              A React resolver (<code>web/client</code>) and the local HTTP +
              WebSocket bridge that hosts it (<code>web/server</code>).
            </p>
            <Link to="/docs/packages/web-client">Read more →</Link>
          </div>
          <div className={styles.layer}>
            <span className={styles.layerTag}>apps/vscode-extension</span>
            <p>
              Commands, status bar, Git integration. Thin orchestration over the
              packages above.
            </p>
            <Link to="/docs/apps/vscode-extension">Read more →</Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description={siteConfig.tagline as string}>
      <Hero />
      <main>
        <Features />
        <Preview />
        <Layout3 />
      </main>
    </Layout>
  );
}

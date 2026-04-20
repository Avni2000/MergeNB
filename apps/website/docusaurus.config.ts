import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'MergeNB',
  tagline: 'MergeNB is a VS Code extension for resolving Jupyter Notebook git merge conflicts.',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: 'https://Avni2000.github.io',
  baseUrl: '/MergeNB/',

  organizationName: 'Avni2000',
  projectName: 'MergeNB',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  plugins: [
    require.resolve('docusaurus-plugin-image-zoom'),
    function ipynbLoader() {
      return {
        name: 'ipynb-loader',
        configureWebpack(existingConfig) {
          const resolveConfig = existingConfig.resolve ?? {};
          const existingAlias = resolveConfig.alias ?? {};
          const existingFallback = resolveConfig.fallback ?? {};

          return {
            module: {
              rules: [{test: /\.ipynb$/, type: 'json'}],
            },
            resolve: {
              ...resolveConfig,
              alias: {
                ...existingAlias,
                json5$: 'json5/lib/index.js',
              },
              fallback: {
                ...existingFallback,
                bufferutil: false,
                'utf-8-validate': false,
              },
            },
          };
        },
      };
    },


    
  ],

  presets: [
    [
      'classic',
      {
        debug: false,
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/Avni2000/MergeNB/edit/main/apps/website/',
          routeBasePath: 'docs',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    zoom: {
      selector: '.markdown :not(em) > img',
      background: {
        light: 'rgb(255, 255, 255)',
        dark: 'rgb(50, 50, 50)'
      },
      config: {
        // medium-zoom options: https://github.com/francoischalifour/medium-zoom#usage
        margin: 24,
        scrollOffset: 40,
      }
    },
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'MergeNB',
      logo: {
        alt: 'MergeNB',
        src: 'img/logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/installation',
          label: 'Installation',
          position: 'left',
        },
        {
          to: '/playground',
          label: 'Playground',
          position: 'left',
        },
        {
          href: 'https://github.com/Avni2000/MergeNB',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Project',
          items: [
            {label: 'Docs', to: '/docs'},
            {label: 'Installation', to: '/docs/installation'},
            {label: 'Playground', to: '/playground'},
          ],
        },
        {
          title: 'Source',
          items: [
            {label: 'GitHub', href: 'https://github.com/Avni2000/MergeNB'},
            {label: 'Releases', href: 'https://github.com/Avni2000/MergeNB/releases'},
            {label: 'Issues', href: 'https://github.com/Avni2000/MergeNB/issues'},
          ],
        },
        {
          title: 'License',
          items: [
            {label: 'GPLv3.0', href: 'https://github.com/Avni2000/MergeNB/blob/main/LICENSE'},
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} MergeNB. Released under GPLv3.0.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
      additionalLanguages: ['bash', 'json', 'typescript', 'tsx'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

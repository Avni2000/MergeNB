import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'overview',
    'installation',
    {
      type: 'category',
      label: 'Packages',
      collapsible: true,
      collapsed: false,
      link: {type: 'doc', id: 'packages/index'},
      items: [
        'packages/core',
        'packages/web-client',
        'packages/web-server',
      ],
    },
    {
      type: 'category',
      label: 'Apps',
      collapsible: true,
      collapsed: false,
      link: {type: 'doc', id: 'apps/index'},
      items: [
        'apps/vscode-extension',
        'apps/website',
      ],
    },
    {
      type: 'category',
      label: 'Testing',
      collapsible: true,
      collapsed: true,
      link: {type: 'doc', id: 'testing/index'},
      items: [
        'testing/playwright',
        'testing/vscode-host',
        'testing/fixtures',
      ],
    },
    'architecture',
    'settings',
  ],
};

export default sidebars;

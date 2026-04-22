import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'overview',
    'installation',
    {
      type: 'category',
      label: 'Testing',
      collapsible: true,
      collapsed: true,
      link: {type: 'doc', id: 'testing/index'},
      items: [
        'testing/playwright',
        'testing/vscode-host',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      collapsible: true,
      collapsed: true,
      link: {type: 'doc', id: 'architecture/index'},
      items: [
        'architecture/merge-lifecycle',
        'architecture/state-management-and-ipc',
        'architecture/design-philosophy',
      ],
    },
    'settings',
  ],
};

export default sidebars;

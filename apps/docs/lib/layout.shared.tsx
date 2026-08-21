import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
      transparentMode: 'top',
    },
    links: [
      { text: 'Changelog', url: '/docs/changelog' },
      { text: 'Download', url: 'https://github.com/milind-soni/openmausbot-releases/releases/latest', external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}

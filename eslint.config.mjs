import agentic from 'eslint-config-agentic';

export default [
  ...agentic({ allowAsAssertions: true }),
  {
    ignores: [
      'node_modules/',
      '.worktree/',
      '.pi/',
      '.tmp/',
      'openspec/',
      'src/types/',
    ],
  },
];

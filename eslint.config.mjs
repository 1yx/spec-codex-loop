import agentic from 'eslint-config-agentic';

export default [
  ...agentic(),
  {
    ignores: [
      'node_modules/',
      '.worktree/',
      '.pi/',
      '.tmp/',
      'openspec/',
    ],
  },
];

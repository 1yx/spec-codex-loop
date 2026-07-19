import agentic from 'eslint-config-agentic';

export default [
  ...agentic({ allowAsAssertions: ["JSON.parse"] }),
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

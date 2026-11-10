import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['node_modules/**', '.claude/**'],
    // 構築の提案のテストは数秒かかり、CI ではさらに遅いことがある
    testTimeout: 30000,
  },
});

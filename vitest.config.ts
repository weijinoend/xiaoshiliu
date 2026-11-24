import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    __API_ORIGIN__: JSON.stringify('https://api.deepseek.com'),
    __DEV_PROXY__: 'false',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})

/**
 * Дефолт лишається `node`: більшість тестів — чиста логіка в `app/lib`, без
 * jsdom і бібліотек рендерингу (правила на кшталт ідентичності запиту в
 * `resource-state.ts` навмисно винесені у функції без React).
 *
 * Компонентні тести (Етап 7d) оголошують `/** @jest-environment jsdom *\/` у
 * своєму файлі — так важкий jsdom вантажиться лише там, де справді потрібен
 * рендер, а не глобально для всього пакета.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '.*\\.spec\\.tsx?$',
  // jest-haste-map crawls the whole rootDir to build its module map before any
  // test file is even selected — testPathIgnorePatterns runs too late to help.
  // Without this, a concurrent `next build` writing to apps/web/.next races the
  // crawler's read of .next/package.json and throws ENOENT.
  modulePathIgnorePatterns: ['<rootDir>/\\.next/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    // `server-only` resolves to a module that THROWS unless the bundler asks
    // for it under React's `react-server` condition — which is exactly its
    // job, and exactly what Jest cannot provide. The stub is the same empty
    // module Next resolves on the server, so importing the marker keeps
    // meaning "server code" without making that code untestable.
    '^server-only$': '<rootDir>/test/server-only.stub.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
}

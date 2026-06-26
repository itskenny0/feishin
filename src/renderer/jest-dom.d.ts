// @testing-library/jest-dom matchers (toBeInTheDocument, toHaveTextContent, …)
// augment vitest's `Assertion` type for the renderer test suite. The runtime
// registration lives in src/test/setup.ts (vitest `setupFiles`), which is NOT
// in this project's tsconfig `include`, so the TYPE augmentation needs a home
// that IS included — here. Previously it was supplied incidentally by a single
// test file's `import '@testing-library/jest-dom/vitest'`; deleting that file
// dropped the matchers from every other *.test.tsx, so anchor it explicitly.
import '@testing-library/jest-dom/vitest';

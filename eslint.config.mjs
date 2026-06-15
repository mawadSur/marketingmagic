// Flat config. `next lint` was removed in Next 16, so we invoke eslint directly
// (see package.json `lint`). eslint-config-next 16+ ships native flat configs;
// importing them through FlatCompat triggers a circular-structure error, so
// import each one directly and spread.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "services/mpt-worker/**",
    ],
  },
];

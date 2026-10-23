module.exports = {
  ignorePatterns: [".eslintrc.cjs"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "2022",
    sourceType: "module",
  },
  overrides: [
    {
      files: ["*.ts"],
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname,
      },
    },
  ],
  plugins: ["@typescript-eslint"],
  extends: [],
  rules: {
    "no-var": "error",
    "prefer-const": "error",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": "error",
    eqeqeq: "error",
    "no-eval": "error",
  },
};

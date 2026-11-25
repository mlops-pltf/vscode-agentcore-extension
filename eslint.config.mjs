import globals from "globals";

const rules = {
    "no-const-assign": "warn",
    "no-this-before-super": "warn",
    "no-undef": "warn",
    "no-unreachable": "warn",
    "no-unused-vars": "warn",
    "constructor-super": "warn",
    "valid-typeof": "warn",
};

export default [
    {
        ignores: ["**/node_modules/**", "**/.venv/**"],
    },
    {
        // Extension host and tests (node:test): Node (CommonJS)
        files: ["**/*.js"],
        languageOptions: {
            globals: {
                ...globals.commonjs,
                ...globals.node,
            },
            ecmaVersion: 2022,
            sourceType: "commonjs",
        },
        rules,
    },
    {
        // The chat panel: classic browser scripts inside a VS Code webview
        files: ["media/webview/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.browser,
                acquireVsCodeApi: "readonly",
            },
            ecmaVersion: 2022,
            sourceType: "script",
        },
        rules,
    },
];

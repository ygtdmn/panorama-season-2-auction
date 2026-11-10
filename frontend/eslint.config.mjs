import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  // vinext and Cloudflare build output and generated types.
  { ignores: ["dist/**", ".cloudflare/**", ".vinext/**", ".wrangler/**"] },
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      // Matches the main frontend: mounted-flag / modal-sync effects are accepted here.
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;

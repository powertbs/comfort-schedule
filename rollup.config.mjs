import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

const dev = process.env.ROLLUP_WATCH === "true";

// The built card is committed inside the integration so HACS installs both together.
export default {
  input: "src/comfort-schedule-card.ts",
  output: {
    file: "custom_components/comfort_schedule/frontend/comfort-schedule-card.js",
    format: "es",
    sourcemap: dev,
  },
  plugins: [
    resolve(),
    typescript({ tsconfig: "./tsconfig.json", include: ["src/**/*.ts"] }),
    !dev && terser({ format: { comments: false } }),
  ],
};

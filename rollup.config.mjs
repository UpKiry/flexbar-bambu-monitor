import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import path from "node:path";
import url from "node:url";
import json from "@rollup/plugin-json";
import { glob } from "glob";

const isWatching = !!process.env.ROLLUP_WATCH;
const flexPlugin = "com.upkiry.bambumonitor.plugin";

const backend = {
  input: "src/plugin.js",
  output: {
    file: `${flexPlugin}/backend/plugin.cjs`,
    format: "cjs",
    sourcemap: isWatching,
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
      return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
    },
  },
  plugins: [
    json(),
    {
      name: "watch-externals",
      buildStart: function () {
        this.addWatchFile(`${flexPlugin}/manifest.json`);
        const vueFiles = glob.sync(`${flexPlugin}/ui/*.vue`);
        vueFiles.forEach((file) => {
          this.addWatchFile(file);
        });
      },
    },
    nodeResolve({
      browser: false,
      exportConditions: ["node"],
      preferBuiltins: true,
    }),
    commonjs(),
    !isWatching && terser(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      },
    },
  ],
  external: (id) => id === "@napi-rs/canvas" || id.endsWith(".node"),
};

const adminClient = {
  input: "src/admin/client/main.js",
  output: {
    file: `${flexPlugin}/resources/admin/app.js`,
    format: "iife",
    name: "BambuAdmin",
    sourcemap: false,
  },
  plugins: [
    nodeResolve({ browser: true }),
    commonjs(),
    !isWatching && terser(),
  ],
};

export default [backend, adminClient];

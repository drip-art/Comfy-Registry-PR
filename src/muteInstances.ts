#!/usr/bin/env bun
import { readFile, writeFile } from "fs/promises";
import pMap from "p-map";
import {globby} from "globby";
if (import.meta.main) {
  const files = await globby("node_modules/**/*instance*.js");
  await pMap(files, async (file) => {
    const x = await readFile(file, "utf8");
    const y = x.replace(/console.warn/, ";");
    if (x !== y) {
      await writeFile(file, y);
      console.log("muted: " + file);
    }
  });
  console.log("done");
}

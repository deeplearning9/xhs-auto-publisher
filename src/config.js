import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

const DEFAULTS = {
  loginUrl: "https://creator.xiaohongshu.com/",
  creatorUrl: "https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch",
  profileDir: "./data/browser-profile",
  artifactsDir: "./data/artifacts",
  assetsDir: "./assets",
  postsDir: "./posts",
  webPort: 3210,
  pollSeconds: 30,
  loginTimeoutMinutes: 10,
  navigationTimeoutSeconds: 60
};

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(projectRoot, explicitPath) {
  const candidate = explicitPath
    ? path.resolve(process.cwd(), explicitPath)
    : path.join(projectRoot, "config.json");
  let custom = {};

  if (await exists(candidate)) {
    custom = JSON.parse(await readFile(candidate, "utf8"));
  }

  const merged = { ...DEFAULTS, ...custom };
  for (const key of ["profileDir", "artifactsDir", "assetsDir", "postsDir"]) {
    merged[key] = path.resolve(projectRoot, merged[key]);
  }
  return merged;
}

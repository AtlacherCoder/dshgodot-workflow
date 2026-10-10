#!/usr/bin/env node
/**
 * dsh-godot-workflow 自检脚本。
 *
 * 用途：安装/改动后跑一次，确认真正生效所依赖的每一环都在位。
 * 只读，不修改任何文件。任一项失败即以非零码退出。
 *
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --against /home/atlaslinux/.dsh/AGENTS.md   # 额外做正文漂移比对
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_FILE = join(ROOT, ".dsh", "prompt", "core.md");
const SKILL_DIR = join(ROOT, ".dsh", "skills", "godot-workflow");
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const ENTRY_FILE = join(ROOT, "lib", "index.js");
const PATCH_FILE = join(ROOT, "cordis.patch.yml");
const PKG_FILE = join(ROOT, "package.json");

/** 常驻核心的字节上限：超过就说明"精简版"名不副实。 */
const CORE_MAX_BYTES = 4096;

let failures = 0;
let checks = 0;

/**
 * 记录一条检查结果。
 * @param ok - 是否通过。
 * @param label - 检查项名称。
 * @param detail - 附加读数。
 */
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
}

/** @returns 文件内容，读不到返回 undefined。 */
function readIfPresent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

console.log("dsh-godot-workflow 自检\n");

// ── 1. 文件在位 ─────────────────────────────────────────────────────
console.log("文件:");
for (const [label, file] of [
  ["入口 lib/index.js", ENTRY_FILE],
  ["补丁 cordis.patch.yml", PATCH_FILE],
  ["清单 package.json", PKG_FILE],
  ["常驻核心 .dsh/prompt/core.md", CORE_FILE],
  ["技能全文 .dsh/skills/godot-workflow/SKILL.md", SKILL_FILE]
]) {
  const ok = existsSync(file) && statSync(file).size > 0;
  check(ok, label, ok ? `${statSync(file).size} bytes` : "缺失或为空");
}

// ── 2. 常驻核心体量 ─────────────────────────────────────────────────
console.log("\n常驻核心:");
const core = readIfPresent(CORE_FILE) ?? "";
const coreBytes = Buffer.byteLength(core, "utf8");
check(coreBytes > 0, "非空", `${coreBytes} bytes`);
check(
  coreBytes <= CORE_MAX_BYTES,
  `不超过 ${CORE_MAX_BYTES} bytes`,
  coreBytes <= CORE_MAX_BYTES ? "在预算内" : `超 ${coreBytes - CORE_MAX_BYTES} bytes`
);
for (const token of ["先问后做", "一轮一主题", "看得见才算完", "回退", "红就说红"]) {
  check(core.includes(token), `含铁律关键词「${token}」`);
}
check(core.includes("godot-workflow"), "指向完整版技能 godot-workflow");

// ── 3. 技能 frontmatter ─────────────────────────────────────────────
console.log("\n技能:");
const skillRaw = readIfPresent(SKILL_FILE) ?? "";
const fenced = skillRaw.startsWith("---\n");
check(fenced, "有 YAML frontmatter");
const header = fenced ? skillRaw.slice(4, skillRaw.indexOf("\n---", 4)) : "";
const field = (key) => (header.match(new RegExp(`^${key}:\\s*(.+)$`, "m")) ?? [])[1]?.trim() ?? "";
check(field("name") === "godot-workflow", "name 为 godot-workflow", field("name") || "(空)");
check(field("description").length > 20, "description 有实质内容", `${field("description").length} 字符`);
check(field("whenToUse").length > 10, "whenToUse 有实质内容", `${field("whenToUse").length} 字符`);
const body = fenced ? skillRaw.slice(skillRaw.indexOf("\n---", 4) + 4).trim() : skillRaw;
check(body.includes("五条铁律"), "正文含「五条铁律」");
check(body.includes("三层验证"), "正文含「三层验证」");
check(body.includes("交活前自查清单"), "正文含「交活前自查清单」");

// ── 4. 入口可加载且导出齐全 ─────────────────────────────────────────
console.log("\n入口:");
try {
  const mod = await import(new URL(`file://${ENTRY_FILE}`).href);
  check(mod.name === "dsh-godot-workflow", "导出 name", String(mod.name));
  check(Array.isArray(mod.inject), "导出 inject 数组", JSON.stringify(mod.inject));
  check(mod.inject?.includes("systemPrompt"), "inject 含 systemPrompt（常驻注入依赖）");
  check(mod.inject?.includes("skills"), "inject 含 skills（技能注册依赖）");
  check(typeof mod.apply === "function", "导出 apply 函数");
} catch (error) {
  check(false, "入口模块可加载", error instanceof Error ? error.message : String(error));
}

// ── 5. 补丁与清单一致性 ─────────────────────────────────────────────
console.log("\n接线:");
const patch = readIfPresent(PATCH_FILE) ?? "";
const pkg = JSON.parse(readIfPresent(PKG_FILE) ?? "{}");
check(patch.includes("dsh-godot-workflow"), "补丁 insert 指向 dsh-godot-workflow");
check(pkg.name === "dsh-godot-workflow", "package.json name 一致");
check(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch 指向补丁");
check(pkg.type === "module", "package.json type=module（入口用了 import）");

// ── 6. 可选：与源 AGENTS.md 的正文漂移比对 ──────────────────────────
const againstIndex = process.argv.indexOf("--against");
if (againstIndex !== -1) {
  console.log("\n漂移比对:");
  const source = process.argv[againstIndex + 1];
  const orig = source ? readIfPresent(source) : undefined;
  if (orig === undefined) {
    check(false, `读不到对照文件 ${source ?? "(未给路径)"}`);
  } else {
    // 挂点段落会被改写；末尾换行在读取时被 trim 掉。
    // 因此两侧都先 trimEnd 再比行数，避免把"末尾换行"误报成内容漂移。
    const oLines = orig.trimEnd().split("\n").length;
    const bLines = body.trimEnd().split("\n").length;
    check(oLines === bLines, "正文行数与源文件一致（trimEnd 归一化后）", `源 ${oLines} 行 / 技能 ${bLines} 行`);
    check(
      Math.abs(orig.length - body.length) < 400,
      "正文字符数与源文件接近（仅挂点段被改写）",
      `源 ${orig.length} / 技能 ${body.length}，差 ${Math.abs(orig.length - body.length)}`
    );
  }
}

console.log(`\n${failures === 0 ? "✅ 全部通过" : `❌ ${failures} 项失败`}（共 ${checks} 项检查）`);
process.exit(failures === 0 ? 0 : 1);

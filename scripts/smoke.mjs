#!/usr/bin/env node
/**
 * dsh-godot-workflow 契约冒烟测试。
 *
 * 用 mock ctx 真跑一次 `apply()`，断言它确实：
 *   - 注册了常驻段落（名字/order/text 内容都对）
 *   - 注册了技能（名字/正文/元数据都对）
 *   - 两处都通过 ctx.effect 挂上了生命周期
 *   - 在文件缺失时**不抛错**而是降级（DSH 启动是全有全无，这条是安全底线）
 *
 * 不启动 DSH、不写任何文件。退出码非零即失败。
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "lib", "index.js");

let failures = 0;
let checks = 0;
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
}

/** 造一个记录调用的假 ctx。 */
function makeCtx({ withSystemPrompt = true, withSkills = true } = {}) {
  const record = { sections: [], skills: [], effects: [], logs: [] };
  const ctx = {
    logger: () => ({
      info: (m) => record.logs.push(["info", m]),
      error: (m) => record.logs.push(["error", m])
    }),
    effect: (fn, label) => {
      record.effects.push(label);
      const disposer = typeof fn === "function" ? fn() : fn;
      return typeof disposer === "function" ? disposer : () => {};
    }
  };
  if (withSystemPrompt) {
    ctx.systemPrompt = {
      getSectionOrder: (n) => (n === "PLAN_POLICY" ? 500 : undefined),
      section: (s) => {
        record.sections.push(s);
        return () => {};
      }
    };
  }
  if (withSkills) {
    ctx.skills = {
      register: (s) => {
        record.skills.push(s);
        return () => {};
      }
    };
  }
  return { ctx, record };
}

const mod = await import(new URL(`file://${ENTRY}`).href);

// ── 1. 正常路径 ─────────────────────────────────────────────────────
console.log("正常路径:");
{
  const { ctx, record } = makeCtx();
  let threw = null;
  try {
    mod.apply(ctx);
  } catch (error) {
    threw = error;
  }
  check(threw === null, "apply 不抛错", threw ? String(threw) : "");

  check(record.sections.length === 1, "注册了恰好 1 个段落", `实际 ${record.sections.length}`);
  const s = record.sections[0] ?? {};
  check(s.name === "godot:workflow", "段落名 godot:workflow", String(s.name));
  check(Number.isFinite(s.order), "order 是有限数", String(s.order));
  check(s.order === 510, "order 取 PLAN_POLICY(500)+10", `实际 ${s.order}`);
  const text = typeof s.text === "function" ? s.text() : s.text;
  check(typeof text === "string" && text.includes("五条铁律"), "段落文本含「五条铁律」", `${text?.length ?? 0} 字符`);

  check(record.skills.length === 1, "注册了恰好 1 个技能", `实际 ${record.skills.length}`);
  const k = record.skills[0] ?? {};
  check(k.name === "godot-workflow", "技能名 godot-workflow", String(k.name));
  check(typeof k.content === "string" && k.content.includes("交活前自查清单"), "技能正文含「交活前自查清单」");
  check(!k.content.startsWith("---"), "技能正文已剥离 frontmatter");
  check(k.source === "dsh-godot-workflow", "技能带 source 标记", String(k.source));
  check(k.resourceBase?.kind === "directory", "技能带 resourceBase");

  check(record.effects.length === 2, "两处注册都挂了 ctx.effect 生命周期", record.effects.join(" | "));
}

// ── 2. 宿主缺服务时不崩（inject 未满足的近似情形）──────────────────
console.log("\n降级路径:");
{
  const { ctx, record } = makeCtx({ withSystemPrompt: false });
  let threw = null;
  try {
    mod.apply(ctx);
  } catch (error) {
    threw = error;
  }
  check(threw === null, "缺 systemPrompt 不抛错", threw ? String(threw) : "");
  check(record.sections.length === 0, "未注册段落");
  check(record.skills.length === 1, "技能仍正常注册", `实际 ${record.skills.length}`);
  check(record.logs.some(([lvl]) => lvl === "error"), "记录了 error 日志", JSON.stringify(record.logs));
}
{
  const { ctx, record } = makeCtx({ withSkills: false });
  let threw = null;
  try {
    mod.apply(ctx);
  } catch (error) {
    threw = error;
  }
  check(threw === null, "缺 skills 不抛错", threw ? String(threw) : "");
  check(record.sections.length === 1, "段落仍正常注册", `实际 ${record.sections.length}`);
}

// ── 3. 源文件缺失时降级而非崩溃（安全底线）────────────────────────
console.log("\n坏文件容错:");
{
  // 拷贝插件骨架到临时目录，但故意不拷 .dsh/ 内容
  const sandbox = mkdtempSync(join(tmpdir(), "dsh-gw-smoke-"));
  try {
    mkdirSync(join(sandbox, "lib"), { recursive: true });
    const src = await import("node:fs").then((fs) => fs.readFileSync(ENTRY, "utf8"));
    writeFileSync(join(sandbox, "lib", "index.js"), src);
    const broken = await import(new URL(`file://${join(sandbox, "lib", "index.js")}`).href);
    const { ctx, record } = makeCtx();
    let threw = null;
    try {
      broken.apply(ctx);
    } catch (error) {
      threw = error;
    }
    check(threw === null, "两个 .md 都缺失时 apply 仍不抛错", threw ? String(threw) : "");
    check(record.sections.length === 0 && record.skills.length === 0, "什么都没注册（干净降级）");
    check(
      record.logs.filter(([lvl]) => lvl === "error").length === 2,
      "两条 error 日志（核心 + 技能各一条）",
      JSON.stringify(record.logs.map(([l]) => l))
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? "✅ 全部通过" : `❌ ${failures} 项失败`}（共 ${checks} 项检查）`);
process.exit(failures === 0 ? 0 : 1);

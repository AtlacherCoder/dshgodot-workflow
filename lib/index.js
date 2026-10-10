/**
 * dsh-godot-workflow — DeepSeek Harness (DSH) host plugin.
 *
 * 把 Godot 工程开发工作流从 `$DSH_HOME/AGENTS.md` 里搬出来，做成插件，从而：
 *
 * 1. **常驻注入** —— 精简核心（`.dsh/prompt/core.md`）经 `ctx.systemPrompt.section()`
 *    注入每个会话的系统提示。它**不占用** AGENTS.md 的 65536 字节预算，因此不会
 *    因为项目链变胖而被"丢弃最宽泛文件"的规则挤掉。
 * 2. **按需全文** —— 完整版（`.dsh/skills/godot-workflow/SKILL.md`）注册为技能，
 *    agent 用 `skill` 工具加载，细节不常驻、省 token。
 *
 * 设计与 `dsh-godot-skill` / `dsh-gitmanager` 保持一致：零 npm 依赖，只用 Node
 * 内置模块与宿主注入的服务。
 *
 * ⚠️ DSH 启动是全有全无：本插件在任何异常下都**不抛错**，只记录日志并降级，
 *    避免一个坏文件把整个 harness 拖死。文件完整性由 `scripts/verify.mjs` 在
 *    安装/开发阶段把关。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-godot-workflow";

/** 宿主服务：系统提示段落 + 技能注册表。fiber 会挂起直到它们就绪。 */
export const inject = ["systemPrompt", "skills"];

const SOURCE = "dsh-godot-workflow";
const SECTION_NAME = "godot:workflow";
const SKILL_NAME = "godot-workflow";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_FILE = join(ROOT, ".dsh", "prompt", "core.md");
const SKILL_DIR = join(ROOT, ".dsh", "skills", SKILL_NAME);
const SKILL_FILE = join(SKILL_DIR, "SKILL.md");

/**
 * 段落排序兜底值：排在 `PLAN_POLICY`(500) 之后、`TEAM_POLICY`(600) 之前。
 * 正常路径会从宿主取 PLAN_POLICY 锚点再偏移，只有取不到时才用它。
 */
const FALLBACK_ORDER = 550;
/** 相对 PLAN_POLICY 的偏移，保证与宿主既有段落不撞 order。 */
const ORDER_OFFSET = 10;

/**
 * 读取一个文本文件并去掉首尾空白。
 * @param file - 绝对路径。
 * @param label - 出错信息里用的中文说明。
 * @returns 文件内容；读不到时返回 undefined（调用方负责降级，不抛错）。
 */
function readText(file, label, log) {
  try {
    const text = readFileSync(file, "utf8").trim();
    if (text === "") {
      log("error", `${label} 是空文件，已跳过：${file}`);
      return undefined;
    }
    return text;
  } catch (error) {
    log("error", `${label} 读取失败，已跳过：${file} — ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * 极简 YAML frontmatter 解析（只取技能注册表认识的三个标量）。
 * 与 `dsh-godot-skill` 的同名函数保持行为一致。
 * @param text - SKILL.md 全文。
 * @returns `{ data, body }`，body 为去掉 frontmatter 后的正文。
 */
function parseFrontmatter(text) {
  const firstLineEnd = text.indexOf("\n");
  const isFenced = firstLineEnd >= 0 && text.slice(0, firstLineEnd).replace(/\r$/, "") === "---";
  if (!isFenced) return { data: {}, body: text.trim() };
  const end = text.indexOf("\n---", firstLineEnd + 1);
  const body = end === -1 ? "" : text.slice(end + 4).trim();
  const header = text.slice(firstLineEnd + 1, end === -1 ? text.length : end);
  const data = {};
  for (const rawLine of header.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "name" || key === "description" || key === "whenToUse") data[key] = value;
  }
  return { data, body };
}

/**
 * 解析段落排序：优先用宿主公布的 PLAN_POLICY 锚点，取不到则用兜底值。
 * @param ctx - 插件上下文。
 * @returns 一个有限数值。
 */
function resolveSectionOrder(ctx) {
  try {
    const anchor = ctx.systemPrompt?.getSectionOrder?.("PLAN_POLICY");
    if (Number.isFinite(anchor)) return anchor + ORDER_OFFSET;
  } catch {
    /* 宿主版本差异，落兜底 */
  }
  return FALLBACK_ORDER;
}

/**
 * 插件入口。注册常驻提示段落 + 按需技能。
 * @param ctx - Cordis 插件上下文。
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      ctx.logger?.(name)?.[level]?.(message);
    } catch {
      /* 日志通道不可用也不能影响启动 */
    }
  };

  // ── 1. 常驻核心段落 ───────────────────────────────────────────────
  const core = readText(CORE_FILE, "常驻核心 core.md", log);
  if (core !== undefined) {
    try {
      const disposer = ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: resolveSectionOrder(ctx),
        // 函数形态是宿主支持的签名；内容在激活时读定，会话中途不改动。
        text: () => core
      });
      ctx.effect(() => disposer, `${name}: section ${SECTION_NAME}`);
      log("info", `已注入常驻核心段落 ${SECTION_NAME}（${Buffer.byteLength(core, "utf8")} bytes）`);
    } catch (error) {
      log("error", `常驻段落注册失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 2. 按需加载的完整版技能 ───────────────────────────────────────
  const raw = readText(SKILL_FILE, "技能全文 SKILL.md", log);
  if (raw !== undefined) {
    try {
      const { data, body } = parseFrontmatter(raw);
      const skill = {
        name: data.name?.trim() || SKILL_NAME,
        description:
          data.description?.trim() ||
          "Godot 工程开发工作流的完整版（AI 工作守则）：铁律、固定流程、环境硬约束与模板。",
        ...(data.whenToUse?.trim() ? { whenToUse: data.whenToUse.trim() } : {}),
        // 文件系统技能带的是去掉 frontmatter 的正文，这里保持一致。
        content: body,
        source: SOURCE,
        metadata: {
          version: "1.0.0",
          role: "godot-workflow-full",
          coreSection: SECTION_NAME
        },
        resourceBase: { kind: "directory", path: SKILL_DIR }
      };
      const disposer = ctx.skills.register(skill);
      ctx.effect(() => disposer, `${name}: skill ${skill.name}`);
      log("info", `已注册技能 ${skill.name}（${Buffer.byteLength(body, "utf8")} bytes）`);
    } catch (error) {
      log("error", `技能注册失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

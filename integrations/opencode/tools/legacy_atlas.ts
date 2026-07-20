import { existsSync } from "node:fs"
import path from "node:path"

type AtlasContext = { worktree: string; abort: AbortSignal }
type QueryArgs = { query: string }

function queryArg(description: string) {
  return { type: "string", minLength: 1, description }
}

function resolveCli(): string[] {
  const node = Bun.which("node")
  if (!node) throw new Error("找不到 node.exe。请安装 Node.js 20+ 并重新启动 OpenCode。")

  const home = Bun.env.USERPROFILE ?? Bun.env.HOME
  if (!home) throw new Error("找不到当前用户目录。请重新运行 install.ps1。")

  const installed = path.join(home, ".legacy-code-atlas", "bin", "legacy-code-atlas.mjs")
  if (existsSync(installed)) return [node, installed]

  throw new Error(
    "找不到 Legacy Code Atlas。请重新运行 install.ps1，并完全重启 OpenCode。",
  )
}

async function runAtlas(
  command: "analyze" | "overview" | "trace-feature" | "trace-url" | "trace-statement" | "trace-procedure" | "trace-table",
  query: string | undefined,
  context: AtlasContext,
): Promise<string> {
  const argv = [...resolveCli(), command, context.worktree]
  if (query) argv.push(query)
  const process = Bun.spawn(argv, {
    cwd: context.worktree,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stop = () => process.kill()
  context.abort.addEventListener("abort", stop, { once: true })

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])

    if (exitCode !== 0 && exitCode !== 3) {
      throw new Error(stderr.trim() || `legacy-code-atlas 退出码：${exitCode}`)
    }
    return stdout.trim() || stderr.trim() || "未找到匹配结果。"
  } finally {
    context.abort.removeEventListener("abort", stop)
  }
}

export const analyze = {
  description: "建立或刷新当前老项目的 Legacy Code Atlas 索引，并返回项目结构概览",
  args: {},
  async execute(_args: Record<string, never>, context: AtlasContext) {
    await runAtlas("analyze", undefined, context)
    return runAtlas("overview", undefined, context)
  },
}

export const trace_feature = {
  description: "追踪旧式 JSP/Java/iBATIS 项目中的业务功能，并返回带源码证据的完整调用链",
  args: {
    query: queryArg("业务词、页面文字或功能名称"),
  },
  async execute(args: QueryArgs, context: AtlasContext) {
    return runAtlas("trace-feature", args.query, context)
  },
}

export const trace_table = {
  description: "从数据库表反查 iBATIS SQL、DAO、Service、Action/Servlet、URL 和 JSP",
  args: {
    query: queryArg("表名，可包含 schema"),
  },
  async execute(args: QueryArgs, context: AtlasContext) {
    return runAtlas("trace-table", args.query, context)
  },
}

export const trace_url = {
  description: "从请求 URL 追踪 Servlet/Struts/Spring 映射、Java 调用、iBATIS SQL 和数据库表",
  args: {
    query: queryArg("请求 URL，例如 /order/audit.do"),
  },
  async execute(args: QueryArgs, context: AtlasContext) {
    return runAtlas("trace-url", args.query, context)
  },
}

export const trace_statement = {
  description: "从 iBATIS statement ID 双向追踪调用它的 Java 代码和它访问的数据库表",
  args: {
    query: queryArg("iBATIS statement ID，例如 order.updateStatus"),
  },
  async execute(args: QueryArgs, context: AtlasContext) {
    return runAtlas("trace-statement", args.query, context)
  },
}

export const trace_procedure = {
  description: "从 SQL Server procedure 双向追踪 iBATIS/Java 调用者、嵌套 procedure 和读写表",
  args: {
    query: queryArg("SQL Server procedure 名称，可包含 schema，例如 dbo.usp_OrderAudit"),
  },
  async execute(args: QueryArgs, context: AtlasContext) {
    return runAtlas("trace-procedure", args.query, context)
  },
}

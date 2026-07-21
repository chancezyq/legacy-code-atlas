import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

function queryArg(description) {
  return { type: "string", minLength: 1, description }
}

function resolveCli() {
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) throw new Error("找不到当前用户目录。请重新运行 install.ps1。")

  const installed = path.join(home, ".legacy-code-atlas", "bin", "legacy-code-atlas.mjs")
  if (existsSync(installed)) return ["node", installed]

  throw new Error(
    "找不到 Legacy Code Atlas。请重新运行 install.ps1，并完全重启 OpenCode。",
  )
}

async function readOutput(stream) {
  if (!stream) return ""

  const decoder = new TextDecoder()
  let output = ""
  for await (const chunk of stream) {
    output += typeof chunk === "string"
      ? chunk
      : decoder.decode(chunk, { stream: true })
  }
  return output + decoder.decode()
}

async function runAtlas(command, query, context) {
  const argv = [...resolveCli(), command, context.worktree]
  if (query) argv.push(query)

  const child = spawn(argv[0], argv.slice(1), {
    cwd: context.worktree,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

  const stop = () => child.kill()
  context.abort.addEventListener("abort", stop, { once: true })

  try {
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve(code ?? 1))
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      readOutput(child.stdout),
      readOutput(child.stderr),
      exit,
    ])

    if (exitCode !== 0 && exitCode !== 3) {
      throw new Error(stderr.trim() || `legacy-code-atlas 退出码：${exitCode}`)
    }
    return stdout.trim() || stderr.trim() || "未找到匹配结果。"
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("找不到 node.exe。请安装 Node.js 20+ 并重新启动 OpenCode。")
    }
    throw error
  } finally {
    context.abort.removeEventListener("abort", stop)
  }
}

export const analyze = {
  description: "建立或刷新当前老项目的 Legacy Code Atlas 索引，并返回项目结构概览",
  args: {},
  async execute(_args, context) {
    await runAtlas("analyze", undefined, context)
    return runAtlas("overview", undefined, context)
  },
}

export const trace_feature = {
  description: "追踪旧式 JSP/Java/iBATIS 项目中的业务功能，并返回带源码证据的完整调用链",
  args: {
    query: queryArg("业务词、页面文字或功能名称"),
  },
  async execute(args, context) {
    return runAtlas("trace-feature", args.query, context)
  },
}

export const trace_table = {
  description: "从数据库表反查 iBATIS SQL、DAO、Service、Action/Servlet、URL 和 JSP",
  args: {
    query: queryArg("表名，可包含 schema"),
  },
  async execute(args, context) {
    return runAtlas("trace-table", args.query, context)
  },
}

export const trace_url = {
  description: "从请求 URL 追踪 Servlet/Struts/Spring 映射、Java 调用、iBATIS SQL 和数据库表",
  args: {
    query: queryArg("请求 URL，例如 /order/audit.do"),
  },
  async execute(args, context) {
    return runAtlas("trace-url", args.query, context)
  },
}

export const trace_statement = {
  description: "从 iBATIS statement ID 双向追踪调用它的 Java 代码和它访问的数据库表",
  args: {
    query: queryArg("iBATIS statement ID，例如 order.updateStatus"),
  },
  async execute(args, context) {
    return runAtlas("trace-statement", args.query, context)
  },
}

export const trace_procedure = {
  description: "从 SQL Server procedure 双向追踪 iBATIS/Java 调用者、嵌套 procedure 和读写表",
  args: {
    query: queryArg("SQL Server procedure 名称，可包含 schema，例如 dbo.usp_OrderAudit"),
  },
  async execute(args, context) {
    return runAtlas("trace-procedure", args.query, context)
  },
}

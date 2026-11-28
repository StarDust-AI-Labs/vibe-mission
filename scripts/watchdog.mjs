// VibeMission watchdog — "系统盯着系统，异常才找人"（docs/watchdog.md）。
// 独立巡检脚本：检查任务会话停摆（宿主 JSONL 日志）与 PR/CI 状态（gh），
// 输出发现报告到 stdout。只报可验证事实，不做推断；脚本本身不联网告警，
// 飞书推送由值守会话调 channels/feishu/notify.mjs 的 notifyWatchdog 完成。
//
// Usage:
//   node scripts/watchdog.mjs --config <config.json> [--format md|json]
//
// Config:
//   {
//     "sessions": [{ "name": "#39 支付对账", "sessionId": "sess_0a4e5a6a" }],
//     "logsDir": "C:/Users/24424/.zcode/cli/log",
//     "stallThresholdMinutes": 10,
//     "repos": [{ "owner": "StarDust-AI-Labs", "name": "vibe-mission", "branches": ["feat/x"] }],
//     "ghPath": "C:/Users/24424/tools/gh/bin/gh.exe"          // 可选；默认 PATH 上的 gh
//   }
//
// Exit codes: 0 = 无发现；1 = 有发现；2 = 配置错误。
// sessionId 支持完整 id 或前缀（宿主日志 sessionId 为 sess_<uuid>，前缀匹配与
// offices 原型 watchdog.sh 的 grep 行为一致），按精确相等或 startsWith 匹配。

import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const SEVERITY = {
  session_stall: 'immediate',
  pr_changes_requested: 'immediate',
  ci_failed: 'immediate',
  log_missing: 'daily',
  session_unseen: 'daily',
};

const SUGGESTED_ACTION = {
  session_stall: '值守会话先看报告原文，向被盯任务会话催办一次；同一发现连续 2 轮仍停摆 → 通知 owner，由 owner 决定 blocked 或重派',
  pr_changes_requested: '把评审意见原文转回该 PR 的任务会话返修；值守不代答、不改码',
  ci_failed: '打开证据中的失败 check 链接，把失败原因转回对应任务会话返修重跑',
  log_missing: '检查 config 的 logsDir 与宿主是否运行——日志文件是停摆判据的证据源，缺失期间停摆检查不可用',
  session_unseen: '核对 config 里 sessionId 是否正确、该任务是否已闭环；已闭环的从监控清单移除（值守只盯活跃任务）',
};

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (flag) => argv.includes(flag);
  return {
    config: get('--config'),
    format: get('--format') ?? 'md',
    help: has('--help') || has('-h'),
  };
}

/** 严格校验 config；返回 {config} 或 {error}（配置错误 → exit 2）。 */
export function parseConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'config 必须是 JSON 对象' };
  }
  const { sessions, repos, logsDir, stallThresholdMinutes, ghPath } = raw;
  if (sessions !== undefined && (!Array.isArray(sessions) || sessions.some((s) => !s || typeof s.name !== 'string' || typeof s.sessionId !== 'string'))) {
    return { error: 'sessions 必须是 [{name, sessionId}] 数组' };
  }
  if (repos !== undefined && (!Array.isArray(repos) || repos.some((r) => !r || typeof r.owner !== 'string' || typeof r.name !== 'string'))) {
    return { error: 'repos 必须是 [{owner, name, branches?}] 数组' };
  }
  if ((!Array.isArray(sessions) || sessions.length === 0) && (!Array.isArray(repos) || repos.length === 0)) {
    return { error: 'config 至少要有 sessions[] 或 repos[] 之一' };
  }
  if (logsDir !== undefined && (typeof logsDir !== 'string' || logsDir.length === 0)) {
    return { error: 'logsDir 必须是非空字符串' };
  }
  if (stallThresholdMinutes !== undefined && !(Number.isFinite(stallThresholdMinutes) && stallThresholdMinutes > 0)) {
    return { error: 'stallThresholdMinutes 必须是正数' };
  }
  const normalizedRepos = (repos ?? []).map((r) => ({
    owner: r.owner,
    name: r.name,
    branches: Array.isArray(r.branches) ? r.branches : [],
  }));
  return {
    config: {
      sessions: (sessions ?? []).map((s) => ({ name: s.name, sessionId: s.sessionId })),
      logsDir: logsDir ?? null,
      stallThresholdMinutes: stallThresholdMinutes ?? 10,
      repos: normalizedRepos,
      ghPath: typeof ghPath === 'string' && ghPath.length > 0 ? ghPath : (process.env.WATCHDOG_GH ?? 'gh'),
    },
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区日期串，与宿主日志文件名（zcode-YYYY-MM-DD.jsonl）的滚动口径一致。 */
export function localDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function logFilePaths(logsDir, now) {
  const today = localDateStr(now);
  const yesterday = localDateStr(new Date(now.getTime() - 86_400_000));
  return [join(logsDir, `zcode-${today}.jsonl`), join(logsDir, `zcode-${yesterday}.jsonl`)];
}

function matchesSession(lineSessionId, target) {
  return lineSessionId === target || (target.length > 0 && lineSessionId.startsWith(target));
}

/**
 * 在单个日志文件里找每个目标会话的最后一条事件（流式读取，容忍坏行）。
 * @returns {Promise<Map<string, {event: string, timestamp: string, line: number}>>}
 */
async function scanLogFile(filePath, targets) {
  const last = new Map();
  if (!existsSync(filePath)) return last;
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line.includes('sess_')) continue; // 快速剪枝：会话行必含 sess_
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 坏行不作为证据
    }
    const sid = obj?.sessionId;
    if (typeof sid !== 'string' || typeof obj.event !== 'string' || typeof obj.timestamp !== 'string') continue;
    for (const t of targets) {
      if (matchesSession(sid, t.sessionId)) last.set(t.sessionId, { event: obj.event, timestamp: obj.timestamp, line: lineNo });
    }
  }
  return last;
}

function finding(type, object, evidence) {
  return { type, object, severity: SEVERITY[type], evidence, suggestedAction: SUGGESTED_ACTION[type] };
}

/**
 * 会话停摆检查。发现类型：
 *  - log_missing   今日与昨日日志文件都不存在（检查不可用）
 *  - session_unseen 两份日志里都没有该 sessionId（配置疑错或任务已闭环）
 *  - session_stall 最后一条事件为 turn.failed 且距今超过阈值
 */
export async function collectSessionFindings({ sessions, logsDir, stallThresholdMinutes, now = new Date() }) {
  const findings = [];
  if (sessions.length === 0) return findings;
  if (!logsDir) {
    findings.push(finding('log_missing', '(logsDir 未配置)', 'config 缺少 logsDir，无法读取宿主日志'));
    return findings;
  }
  const paths = logFilePaths(logsDir, now);
  if (!paths.some((p) => existsSync(p))) {
    findings.push(finding('log_missing', logsDir, `未找到宿主日志：${paths.join(' 与 ')} 均不存在`));
    return findings;
  }
  const seen = new Map(); // 今日优先，昨日只补今日没有的会话
  for (const p of paths) {
    const last = await scanLogFile(p, sessions);
    for (const [sid, ev] of last) if (!seen.has(sid)) seen.set(sid, { ...ev, file: p });
  }
  const thresholdMs = stallThresholdMinutes * 60_000;
  for (const s of sessions) {
    const ev = seen.get(s.sessionId);
    if (!ev) {
      findings.push(finding('session_unseen', `${s.name}（${s.sessionId}）`, `今日与昨日日志中均无该 sessionId：${paths.join(' , ')}`));
      continue;
    }
    if (ev.event !== 'turn.failed') continue;
    const ts = Date.parse(ev.timestamp);
    if (!Number.isFinite(ts)) continue;
    const ageMin = Math.floor((now.getTime() - ts) / 60_000);
    if (now.getTime() - ts > thresholdMs) {
      findings.push(
        finding('session_stall', `${s.name}（${s.sessionId}）`, `最后一条事件 turn.failed @ ${ev.timestamp}（距今 ${ageMin} 分钟，阈值 ${stallThresholdMinutes} 分钟），sessionId ${s.sessionId}，出自 ${ev.file}:${ev.line}`),
      );
    }
  }
  return findings;
}

/** 从 gh statusCheckRollup 归纳 CI 结论：failed / pending / success / none。 */
export function deriveCiConclusion(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const failed = rollup.some((c) =>
    (c.conclusion && ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'CANCELLED'].includes(c.conclusion)) ||
    c.state === 'FAILURE' || c.state === 'ERROR');
  if (failed) return 'failed';
  const pending = rollup.some((c) =>
    (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED');
  return pending ? 'pending' : 'success';
}

function failingCheckUrl(rollup) {
  const bad = (rollup ?? []).find((c) =>
    (c.conclusion && ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'CANCELLED'].includes(c.conclusion)) ||
    c.state === 'FAILURE' || c.state === 'ERROR');
  return bad?.detailsUrl ?? bad?.targetUrl ?? null;
}

/**
 * PR/CI 检查（gh 不存在或未登录时跳过并注明，不算发现）。
 * @param {Function} [run] spawnSync 同形函数（(cmd,args,opts)=>{status,stdout,stderr,error}），测试注入用
 * @returns {{findings: Array, observed: Array, skipped: Array}}
 */
export function collectRepoFindings({ repos, ghPath, run = (cmd, args, opts) => spawnSync(cmd, args, opts) }) {
  const findings = [];
  const observed = [];
  const skipped = [];
  if (repos.length === 0) return { findings, observed, skipped };

  const ghProbe = run(ghPath, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (ghProbe.error || ghProbe.status !== 0) {
    skipped.push({
      object: repos.map((r) => `${r.owner}/${r.name}`).join(', '),
      reason: 'gh_unavailable',
      detail: ghProbe.error ? String(ghProbe.error.code ?? ghProbe.error.message) : `exit ${ghProbe.status}`,
    });
    return { findings, observed, skipped };
  }

  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    for (const branch of repo.branches) {
      const object = `${slug}#${branch}`;
      const r = run(
        ghPath,
        ['pr', 'list', '--repo', slug, '--head', branch, '--state', 'all', '--limit', '5',
          '--json', 'number,title,state,url,reviewDecision,statusCheckRollup,updatedAt'],
        { encoding: 'utf8', timeout: 30_000 },
      );
      if (r.error) {
        skipped.push({ object, reason: 'gh_unavailable', detail: String(r.error.code ?? r.error.message) });
        continue;
      }
      if (r.status !== 0) {
        const err = (r.stderr || '').slice(0, 200);
        skipped.push({ object, reason: /auth|login/i.test(err) ? 'gh_auth_failed' : 'gh_error', detail: err });
        continue;
      }
      let prs;
      try {
        prs = JSON.parse(r.stdout);
      } catch {
        skipped.push({ object, reason: 'gh_error', detail: 'unparseable output' });
        continue;
      }
      const open = prs.filter((p) => p.state === 'OPEN');
      if (open.length === 0) {
        const closed = prs[0]; // 最新一条（可能 MERGED/CLOSED）
        observed.push(closed
          ? { object, pr: `#${closed.number} ${closed.title}`, state: closed.state, ci: null, url: closed.url }
          : { object, state: 'no_open_pr' });
        continue;
      }
      for (const pr of open) {
        const ci = deriveCiConclusion(pr.statusCheckRollup);
        observed.push({ object, pr: `#${pr.number} ${pr.title}`, state: pr.state, review: pr.reviewDecision, ci, url: pr.url });
        if (pr.reviewDecision === 'CHANGES_REQUESTED') {
          findings.push(finding('pr_changes_requested', object, `PR #${pr.number} ${pr.title} reviewDecision=CHANGES_REQUESTED，${pr.url}`));
        }
        if (ci === 'failed') {
          const url = failingCheckUrl(pr.statusCheckRollup);
          findings.push(finding('ci_failed', object, `PR #${pr.number} ${pr.title} CI 失败${url ? `，失败 check：${url}` : ''}，${pr.url}`));
        }
      }
    }
  }
  return { findings, observed, skipped };
}

/** 组装报告对象（渲染前的单一事实源）。 */
export function buildReport({ findings, observed = [], skipped = [], configPath = null, now = new Date() }) {
  return {
    generatedAt: now.toISOString(),
    config: configPath,
    summary: {
      findings: findings.length,
      immediate: findings.filter((f) => f.severity === 'immediate').length,
    },
    findings,
    observed,
    skipped,
  };
}

export function renderMd(report) {
  const { generatedAt, summary, findings, observed, skipped } = report;
  const lines = [`# VibeMission 看门狗报告 — ${generatedAt}`, ''];
  lines.push(`发现 ${summary.findings} 条（需立即处理 ${summary.immediate} 条）`);
  if (findings.length === 0) lines.push('', '本轮无发现：被盯会话无停摆，PR/CI 无异常。');
  for (const f of findings) {
    const mark = f.severity === 'immediate' ? '⛔' : '•';
    lines.push('', `- ${mark} **[${f.type}]** ${f.object}`, `  - 证据：${f.evidence}`, `  - 建议：${f.suggestedAction}`);
  }
  if (observed.length) {
    lines.push('', '## 观察到（事实，非发现）');
    for (const o of observed) {
      const detail = o.pr ? ` ${o.pr} · state=${o.state}${o.review ? ` · review=${o.review}` : ''}${o.ci ? ` · ci=${o.ci}` : ''}${o.url ? ` · ${o.url}` : ''}` : ` ${o.state ?? ''}`;
      lines.push(`- ${o.object}${detail.trimEnd()}`);
    }
  }
  if (skipped.length) {
    lines.push('', '## 跳过（本轮无法检查）');
    for (const s of skipped) lines.push(`- ${s.object}：${s.reason}${s.detail ? `（${s.detail}）` : ''}`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.config) {
    console.error('用法：node scripts/watchdog.mjs --config <config.json> [--format md|json]');
    process.exit(opts.help ? 0 : 2);
  }
  if (!['md', 'json'].includes(opts.format)) {
    console.error(`未知格式：--format ${opts.format}（可选 md|json）`);
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(opts.config, 'utf8'));
  } catch (e) {
    console.error(`配置读取/解析失败：${e.message}`);
    process.exit(2);
  }
  const { config, error } = parseConfig(raw);
  if (error) {
    console.error(`配置错误：${error}`);
    process.exit(2);
  }

  const sessionFindings = await collectSessionFindings(config);
  const { findings: repoFindings, observed, skipped } = collectRepoFindings(config);
  const report = buildReport({ findings: [...sessionFindings, ...repoFindings], observed, skipped, configPath: opts.config });

  console.log(opts.format === 'json' ? JSON.stringify(report, null, 2) : renderMd(report));
  process.exit(report.findings.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

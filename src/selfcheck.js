/**
 * 宿主接口自检。
 *
 * 背景：插件完全依赖 DSH 的若干内部接口（`session/event`、`llm/stream`、
 * `sessionPersistence`、`webServer`）。DSH 升级时这些接口可能改名或改签名，
 * 而**失效往往是静默的** —— 插件照常启动、页面照常打开，只是数据不再增长，
 * 用户要过很久才会发现「统计停了」。
 *
 * 这里在启动后做一次契约体检，把结果暴露给页面：正常时不打扰，异常时明确
 * 告诉用户「哪一项失效了、可能是什么原因」。
 *
 * 设计原则：
 *   · 只读本地状态，不发网络请求、不写盘；
 *   · 检查项各自独立，单项失败不影响其他项判定；
 *   · 不阻塞启动（由调用方用定时器延迟执行）。
 */

/** 单条检查结果的严重程度。 */
const LEVEL = { ok: 'ok', warn: 'warn', fail: 'fail' }

/**
 * 观察型检查需要「一段时间内有没有新数据」。窗口太短会误报（用户可能
 * 只是在看页面没发请求），太长则发现得晚。10 分钟是折中。
 */
const ACTIVITY_WINDOW_MS = 10 * 60_000

/**
 * 跑一次接口自检。
 *
 * @param {object} input
 * @param {object} input.env - 环境事实，由调用方收集
 * @param {boolean} input.env.hasSessionPersistence  是否成功取到 sessionPersistence
 * @param {string}  input.env.persistenceSource      来源（inject / poll / disk）
 * @param {number}  input.env.startedAt              插件启动时刻
 * @param {object}  input.env.store                  当前存储（读 byDay / performance）
 * @param {number}  [input.env.now]                  当前时刻（测试注入）
 * @returns {{ok: boolean, checkedAt: number, items: Array<object>}}
 */
export function runSelfCheck(input) {
  // 调用方按 `{ env: {...} }` 传入（便于将来追加其他顶层字段），
  // 这里解开 env；直接传裸对象也兼容。
  const env = (input && input.env !== undefined ? input.env : input) ?? {}
  const now = env.now ?? Date.now()
  const items = []

  /** 统一登记一条结果。 */
  const add = (id, level, title, detail) => {
    items.push({ id, level, title, detail })
  }

  // —— 1. sessionPersistence：回扫与历史数据的基础 ——
  //
  // 三种情况要分开看待，不能一律报警：
  //   · 服务可取到        → ok，最理想
  //   · 服务不可用但磁盘兜底成功 → ok，这是设计内的正常工作方式
  //     （DSH 某些组合下该服务就是拿不到，磁盘直读本来就该顶上）
  //   · 既没服务也没兜底   → warn，回扫能力真的受限
  if (env.hasSessionPersistence === true) {
    add('sessionPersistence', LEVEL.ok, '历史会话服务可用',
      `通过 ${env.persistenceSource ?? '未知'} 取得，关机后重开也能回扫历史`)
  } else if (env.persistenceSource === 'disk-fallback') {
    add('sessionPersistence', LEVEL.ok, '历史回扫已用磁盘直读',
      '当前未取到历史会话服务，已改用磁盘直读，功能不受影响')
  } else {
    add('sessionPersistence', LEVEL.warn, '历史会话服务不可用',
      '也未确认磁盘兜底是否生效；若 DSH 升级后出现此提示，可能是该服务改名了')
  }

  // —— 2. session/event：实时采集 ——
  // 判定依据：启动后是否记录到过调用。若长时间零调用，可能事件失效，
  // 也可能用户确实没在用——用「是否曾有过调用」区分这两种情况。
  const calls = env.store?.total?.calls ?? 0
  if (calls > 0) {
    add('session/event', LEVEL.ok, '实时用量采集正常',
      `累计已记录 ${calls.toLocaleString()} 次调用`)
  } else {
    const ageMs = env.startedAt === undefined ? 0 : now - env.startedAt
    add('session/event', ageMs > ACTIVITY_WINDOW_MS ? LEVEL.warn : LEVEL.ok,
      '实时用量采集',
      ageMs > ACTIVITY_WINDOW_MS
        ? '插件已运行超过 10 分钟但没有记录到任何调用；若你确实在用模型，可能是该事件失效'
        : '尚未记录到调用（刚启动，属正常）')
  }

  // —— 3. llm/stream：首字延迟与输出速度的来源 ——
  const samples = env.store?.performance?.total?.ttftCount ?? 0
  if (samples > 0) {
    add('llm/stream', LEVEL.ok, '首字延迟采集正常', `${samples.toLocaleString()} 个采样`)
  } else {
    const ageMs = env.startedAt === undefined ? 0 : now - env.startedAt
    // 首字延迟只对新调用生效，历史无法回填；刚启动时为空是正常的
    add('llm/stream', ageMs > ACTIVITY_WINDOW_MS ? LEVEL.warn : LEVEL.ok,
      '首字延迟采集',
      ageMs > ACTIVITY_WINDOW_MS
        ? '运行超过 10 分钟仍无采样；若你确实在用模型，可能是该接口签名变了'
        : '暂无采样（首字延迟不回溯历史，刚启动时为空属正常）')
  }

  // —— 4. 数据自洽：calls 与去重键数是否一致 ——
  // 不一致说明累加逻辑与去重脱节，统计会偏大。
  const seenSize = env.store?.seen === undefined ? undefined : Object.keys(env.store.seen).length
  if (seenSize !== undefined) {
    if (seenSize === calls) {
      add('integrity', LEVEL.ok, '数据一致', `调用数与去重键数一致（${calls.toLocaleString()}）`)
    } else {
      add('integrity', LEVEL.fail, '数据不一致',
        `记录 ${calls.toLocaleString()} 次调用，但有 ${seenSize.toLocaleString()} 个去重键；统计可能重复计数`)
    }
  }

  // —— 5. 模型能力目录：只影响「自动填能力」这项便利功能 ——
  // 目录不存在不算故障（用户可手填），但要如实说明，免得以为插件坏了。
  if (env.catalogAvailable === false) {
    add('model-catalog', LEVEL.ok, '模型能力目录不可用',
      env.catalogReason ?? '无法读取模型能力目录，可手动填写上下文与输出上限')
  } else if (env.catalogAvailable === true) {
    add('model-catalog', LEVEL.ok, '模型能力目录可用', '勾选模型时可自动填好上下文与输出上限')
  }

  const failed = items.filter((item) => item.level === LEVEL.fail).length
  const warned = items.filter((item) => item.level === LEVEL.warn).length
  return { ok: failed === 0, checkedAt: now, items, failed, warned }
}

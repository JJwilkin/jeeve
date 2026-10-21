// Two replays for brain/architecture/stateful-system-1.md, offline over recorded bench traces:
//   --exp needs:   recorded states edited to be hungry / starving / fed. Does Jev look after needs, and does a
//                  needs block or a needs line in the guidance help?
//   --exp objects: doubtful states with the block list replaced by objects (stable ids, beyond 8 blocks, last seen),
//                  egocentric or compass directions. Does doubt drop and agreement with 2A's label hold?
// Usage: node --env-file=../judgment/.env.jeeve scripts/replay-world.ts --exp needs|objects [--n 40|200] [--dry]
import { writeFileSync } from 'node:fs'
import { ago, arg, askBoth, compass, direction, distanceBucket, labelledDoubts, loadSessions, optionTarget, pool, score, seeded, stratified, type Cell, type Row } from './replay-lib.ts'

const EXP = arg('exp', 'objects')
const DRY = process.argv.includes('--dry')
const sessions = loadSessions()
const pickBy = (r: Row, k: string) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== k))
const report: Record<string, unknown> = {}

if (EXP === 'needs') {
  const N = Number(arg('n', '40'))
  const ESCALATE = { type: 'noul', instructions: 'Is this a situation the directive and the available behaviors cannot handle, so a slower planner should take over?' }
  const EAT = 'Eat bread from the inventory (about 2 s; uses the hands)'
  const NEEDS_GUIDANCE = ' When there is no instruction, look after the bot\'s needs: if it is hungry and has food, eat. If a need cannot be met with the behaviors offered, answer yes to escalate. During a task, stop to eat only when starving.'
  // Arm D: C, plus the idle state and the hands question no longer contradict the need ("stay safe and wait";
  // hands "(attacking)"), plus gathering when nothing is needed.
  const GATHER = ' If every need is met and there is no instruction, gather resources in view.'
  const IDLE_DIRECTIVE = 'no instruction: look after your needs'
  const HANDS = 'Which behavior should the hands (attacking, eating) run now?'
  // Arm E: what shipped in DEFAULT_PROGRAM: D with "walk around and look around" in place of gathering, and the
  // wander (legs) and glance (aim) behaviors offered.
  const WALK = ' If every need is met and there is no instruction, walk around nearby and look around.'
  const all = sessions.flatMap(s => s.rows.filter(r => r.kind === 'decide').map(d => ({ scenario: s.scenario, d })))
  const idle = stratified(all.filter(x => typeof x.d.input.state.directive === 'string'), x => x.scenario, N, seeded(11))
  const busy = stratified(all.filter(x => typeof x.d.input.state.directive !== 'string' && /\(running\)/.test(x.d.input.state.channels?.legs ?? '') && x.d.input.questions.hands), x => x.scenario, N, seeded(13))

  // food: the encoder's bucket; bread: whether the inventory has some. The needs block says the same as facts.
  type Case = { name: string, base: typeof idle, food: string, bread: boolean, needs: string, want: string }
  const CASES: Case[] = [
    { name: 'idle_hungry_bread', base: idle, food: 'low', bread: true, needs: 'hunger: you are hungry (food is low). You have bread; eating it fixes this.', want: 'eat' },
    { name: 'idle_fed_bread', base: idle, food: 'full', bread: true, needs: 'all needs met: not hungry, not hurt.', want: 'no eat, no escalate' },
    { name: 'idle_starving_none', base: idle, food: 'critical', bread: false, needs: 'hunger: you are starving (food is critical) and you have no food to eat.', want: 'escalate' },
    { name: 'busy_hungry_bread', base: busy, food: 'low', bread: true, needs: 'hunger: you are hungry (food is low). You have bread; eating it fixes this.', want: '(open: keep the task?)' },
    { name: 'busy_starving_bread', base: busy, food: 'critical', bread: true, needs: 'hunger: you are starving (food is critical). You have bread; eating it fixes this.', want: 'eat' }
  ]
  const jobs = CASES.flatMap(c => c.base.map(({ scenario, d }) => {
    const st = d.input.state
    const inventory = (st.self.inventory as string[]).filter(i => !i.startsWith('bread')).concat(c.bread ? ['bread (a few)'] : [])
    const state = { ...st, self: { ...st.self, food: c.food, inventory } }
    const hands = { ...d.input.questions.hands, criteria: { ...d.input.questions.hands.criteria, ...(c.bread ? { 'eat:bread': EAT } : {}) } }
    const questions: Record<string, Row> = { hands, escalate: ESCALATE }
    // Idle: the body may also collect what's in view (the recorded call had no goal, so nothing was offered).
    if (c.base === idle) {
      const collect = Object.fromEntries((st.blocks as Row[]).filter(b => /\d/.test(b.count)).map(b => { const n = Number(b.count.match(/\d+/)[0]); return [`collect:${b.name}(${n})`, `Collect ${n} ${b.name} (${b.count}, nearest ${b.nearest}) (walks, digs and picks up; uses the whole body)`] }))
      questions.body = { ...d.input.questions.body, criteria: { ...d.input.questions.body.criteria, ...collect } }
    }
    const D = { ...state, needs: c.needs, guidance: state.guidance + NEEDS_GUIDANCE + GATHER, ...(c.base === idle ? { directive: IDLE_DIRECTIVE } : {}) }
    const E = { ...D, guidance: state.guidance + NEEDS_GUIDANCE + WALK }
    const questionsD = { ...questions, hands: { ...hands, instructions: HANDS } }
    const add = (q: Row, k: string, desc: string) => q && { ...q, criteria: { ...q.criteria, [k]: desc } }
    const questionsE = { ...questionsD, legs: add(d.input.questions.legs, 'wander', 'Walk around nearby, a few blocks at a time, pausing between walks'), aim: add(d.input.questions.aim, 'glance', 'Look around at what is nearby, now and then') }
    return { c, scenario, arms: { A: state, B: { ...state, needs: c.needs }, C: { ...state, needs: c.needs, guidance: state.guidance + NEEDS_GUIDANCE }, D, E }, questions, questionsD, questionsE }
  }))
  console.log(`needs: ${idle.length} idle and ${busy.length} busy base states → ${jobs.length} variants × 3 arms × 2 orders`)
  if (DRY) { console.log(JSON.stringify(jobs[0].arms.C, null, 1).slice(0, 1500), Object.keys(jobs[0].questions)); process.exit(0) }
  const answers = await pool(jobs, async j => ({ A: await askBoth(j.arms.A, j.questions), B: await askBoth(j.arms.B, j.questions), C: await askBoth(j.arms.C, j.questions), D: await askBoth(j.arms.D, j.questionsD), E: await askBoth(j.arms.E, j.questionsE) }))
  const mean = (xs: number[]) => xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null
  for (const c of CASES) {
    const rows = jobs.map((j, i) => ({ j, a: answers[i] })).filter(x => x.j.c === c)
    report[c.name] = Object.fromEntries((['A', 'B', 'C', 'D', 'E'] as const).map(arm => {
      const both = (f: (a: Row) => number) => mean(rows.flatMap(x => [f(x.a[arm].fwd), f(x.a[arm].rev)]))
      return [arm, {
        want: c.want,
        n: rows.length,
        eat_chosen: both(a => a.hands.choice === 'eat:bread' ? 1 : 0),
        p_eat: both(a => a.hands.probabilities['eat:bread'] ?? 0),
        hands_doubt: both(a => a.hands.confidence < 0.5 ? 1 : 0),
        escalate_yes: both(a => a.escalate.noul > 0.5 ? 1 : 0),
        escalate_noul: both(a => a.escalate.noul),
        body_collect: c.base === idle ? both(a => a.body.choice.startsWith('collect:') ? 1 : 0) : undefined,
        legs_wander: arm === 'E' ? both(a => a.legs?.choice === 'wander' ? 1 : 0) : undefined,
        aim_glance: arm === 'E' ? both(a => a.aim?.choice === 'glance' ? 1 : 0) : undefined,
        collect_offered: c.base === idle ? mean(rows.map(x => Object.keys(x.j.questions.body.criteria).some(k => k.startsWith('collect:')) ? 1 : 0)) : undefined
      }]
    }))
  }
  console.log(JSON.stringify(report, null, 1))
  writeFileSync(arg('out', 'bench/replay-needs.json'), JSON.stringify({ report, samples: jobs.map((j, i) => ({ case: j.c.name, scenario: j.scenario, answers: answers[i] })) }, null, 1))
}

if (EXP === 'objects') {
  const N = Number(arg('n', '200'))
  const FAR = 16 // compass beyond this, egocentric within (arm C)
  const CAP = 10
  const doubts = labelledDoubts(sessions).filter(x => x.scenario !== 'guard') // guard has no blocks that matter
  const ids = sessions.map(() => new Map<string, string>()) // per session: cluster key → T#, stable across calls
  const count = (n: number) => n === 1 ? 'one' : n <= 9 ? `${n}` : 'many'

  // Objects at a decide: the clusters on 2A's last map (it covers 32+ blocks; Jev's list stops at 8) plus any
  // notable type in view that the map didn't have yet. Distances and directions from where the bot is now.
  function objectsAt (sess: number, i: number, targets: Set<string>, compassFar: boolean) {
    const rows = sessions[sess].rows
    const d = rows[i]
    const raw = JSON.parse(d.attrs['jeeve.decide.raw_state'])
    const [x, y, z] = raw.self.pos
    const yaw = raw.self.yaw
    const map = rows.slice(0, i).findLast(r => r.kind === 'system2' && r.input?.seen_map)
    const clusters: Array<{ names: Record<string, number>, min: number[], max: number[], seen: number }> =
      (map?.input.seen_map ?? []).map((c: Row) => ({ names: c.names, min: c.min, max: c.max, seen: map!.t }))
    const inBox = (p: number[], c: { min: number[], max: number[] }) => p.every((v, k) => v >= c.min[k] - 1 && v <= c.max[k] + 1)
    for (const [name, ps] of Object.entries(raw.blocks as Record<string, number[][]>)) {
      if (ps.some(p => clusters.some(c => c.names[name] && inBox(p, c)))) continue
      clusters.push({ names: { [name]: ps.length }, min: [0, 1, 2].map(k => Math.min(...ps.map(p => p[k]))), max: [0, 1, 2].map(k => Math.max(...ps.map(p => p[k]))), seen: d.t })
    }
    const objs = clusters.map(c => {
      const near = [0, 1, 2].map(k => Math.min(Math.max([x, y, z][k], c.min[k] + 0.5), c.max[k] + 0.5))
      const dist = Math.hypot(near[0] - x, near[1] - y, near[2] - z)
      const inView = Object.entries(raw.blocks as Record<string, number[][]>).some(([n, ps]) => c.names[n] && ps.some(p => inBox(p, c)))
      const key = `${Object.keys(c.names).sort().join('+')}@${c.min.join(',')}`
      if (!ids[sess].has(key)) ids[sess].set(key, `T${ids[sess].size}`)
      const lo = Math.round(c.min[1] - Math.floor(y)); const hi = Math.round(c.max[1] - Math.floor(y))
      const height = hi <= 1 && lo >= -1 ? '' : lo === hi ? `, ${lo > 0 ? `~${lo} up` : `~${-lo} down`}` : `, from ${lo >= 0 ? `${lo} up` : `${-lo} down`} to ${hi >= 0 ? `${hi} up` : `${-hi} down`}`
      const dir = compassFar && dist >= FAR ? compass(near[0] - x, near[2] - z) : direction(near[0] - x, near[2] - z, yaw)
      return {
        dist, relevant: Object.keys(c.names).some(n => targets.has(n)),
        o: { id: ids[sess].get(key)!, what: Object.entries(c.names).map(([n, k]) => `${n} (${count(k)})`).join(', '), where: `${distanceBucket(dist)}, ${dir}${height}`, seen: inView ? 'in view now' : `remembered, last looked ${ago(d.t - c.seen)}` }
      }
    })
    return objs.sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.dist - b.dist).slice(0, CAP).map(o => o.o)
  }

  const sample = stratified(doubts, x => `${x.scenario}/${x.q}`, N)
  const jobs = sample.map(s => {
    const targets = new Set(Object.keys(s.question.criteria).map(k => optionTarget(k).split(':')[1]).filter(Boolean))
    const without = pickBy(s.state, 'blocks')
    // D: today's block list stays (the options are worded against it); only what's beyond it is added, as remembered.
    const beyond = objectsAt(s.sess, s.i, targets, false).filter(o => /^(medium|far)/.test(o.where))
    return { s, arms: { A: s.state, B: { ...without, objects: objectsAt(s.sess, s.i, targets, false) }, C: { ...without, objects: objectsAt(s.sess, s.i, targets, true) }, D: { ...s.state, remembered: beyond } } }
  })
  console.log(`objects: ${doubts.length} labelled doubtful questions (no guard), sampled ${jobs.length}`)
  if (DRY) { for (const j of jobs.filter((_, i) => i % 60 === 5)) console.log(j.s.scenario, j.s.q, j.s.label, JSON.stringify(j.arms.C.objects, null, 1)); process.exit(0) }
  const answers = await pool(jobs, async j => {
    const qs = { [j.s.q]: j.s.question }
    return { A: await askBoth(j.arms.A, qs), B: await askBoth(j.arms.B, qs), C: await askBoth(j.arms.C, qs), D: await askBoth(j.arms.D, qs) }
  })
  const slices: Record<string, number[]> = { all: jobs.map((_, i) => i) }
  jobs.forEach((j, i) => { for (const k of [j.s.scenario, `q:${j.s.q}`, j.s.label === 'keep_current' ? 'label:keep' : 'label:change']) (slices[k] ??= []).push(i) })
  for (const [k, idx] of Object.entries(slices)) {
    const labels = idx.map(i => jobs[i].s.label)
    report[k] = Object.fromEntries((['A', 'B', 'C', 'D'] as const).map(arm => [arm, score(idx.map(i => answers[i][arm] as Cell), i => jobs[idx[i]].s.q, labels)]))
  }
  const tokens = (o: unknown) => Math.round(JSON.stringify(o).length / 4)
  report.state_tokens_est = Object.fromEntries((['A', 'B', 'C', 'D'] as const).map(arm => [arm, Math.round(jobs.reduce((a, j) => a + tokens(j.arms[arm]), 0) / jobs.length)]))
  console.log(JSON.stringify(report, null, 1))
  writeFileSync(arg('out', 'bench/replay-objects.json'), JSON.stringify({ report, samples: jobs.map((j, i) => ({ scenario: j.s.scenario, q: j.s.q, label: j.s.label, objects: j.arms.C.objects, answers: answers[i] })) }, null, 1))
}

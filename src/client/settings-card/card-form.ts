import { readAtPath, hasAtPath, type FieldSpec } from './fields.ts'

export type PathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

export interface CompassScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value?: Record<string, unknown>
  base?: unknown
  user?: unknown
  revision?: number
  writable: boolean
  mode: 'host' | 'memory'
}

export interface CompassScopeLike {
  getSnapshot(): CompassScopeSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<void>
}

export interface FieldDraftState {
  /** 文本控件的草稿文本（boolean 控件为 ''）。 */
  text: string
  /** boolean 控件的草稿勾选态（仅 kind==='boolean' 使用）。 */
  checked: boolean
  overridden: boolean
  invalid: boolean
  /** 字段级错误文案；undefined 表示无错误。 */
  error?: string
}

export interface CompassShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

type StagedEdit =
  | { kind: 'text'; text: string }
  | { kind: 'bool'; checked: boolean }
  | { kind: 'clear' }

function formatValue(kind: FieldSpec['kind'], value: unknown): string {
  if (value === undefined || value === null) return ''
  switch (kind) {
    case 'strings':
      return Array.isArray(value) ? value.join(', ') : ''
    case 'boolean':
      return ''
    default:
      return String(value)
  }
}

function parseText(kind: FieldSpec['kind'], text: string): { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined {
  const trimmed = text.trim()
  switch (kind) {
    case 'number': {
      if (trimmed === '') return { kind: 'clear' }
      const n = Number(trimmed)
      return Number.isFinite(n) ? { kind: 'set', value: n } : undefined
    }
    case 'select': {
      if (trimmed === '') return { kind: 'clear' }
      return { kind: 'set', value: trimmed }
    }
    case 'strings': {
      if (trimmed === '') return { kind: 'clear' }
      return { kind: 'set', value: trimmed.split(',').map(s => s.trim()).filter(Boolean) }
    }
    case 'string': {
      if (trimmed === '') return { kind: 'clear' }
      return { kind: 'set', value: trimmed }
    }
    case 'boolean':
      throw new Error('boolean fields go through the checked channel, not parseText')
  }
}

function parseField(spec: FieldSpec, text: string): { kind: 'set'; value: unknown } | { kind: 'clear' } | { kind: 'invalid'; message: string } {
  const write = parseText(spec.kind, text)
  if (write === undefined) return { kind: 'invalid', message: '请输入有效值' }
  if (write.kind === 'clear') return write
  if (spec.kind === 'number') {
    const n = write.value as number
    if (spec.min0max1 !== true && !Number.isInteger(n)) {
      return { kind: 'invalid', message: '请输入整数' }
    }
    if (n < 0) {
      return { kind: 'invalid', message: spec.min0max1 === true ? '请输入 0-1 之间的比例值' : '请输入大于等于 0 的值' }
    }
    if (spec.min0max1 === true && n > 1) {
      return { kind: 'invalid', message: '请输入 0-1 之间的比例值' }
    }
  }
  if (spec.kind === 'select' && !spec.options?.some(o => o.value === write.value)) {
    return { kind: 'invalid', message: '请选择有效选项' }
  }
  return write
}

function deepEqualValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
  }
  return a === b
}

export class CompassCardForm {
  private readonly scope: CompassScopeLike
  private readonly specByKey = new Map<string, FieldSpec>()
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private readonly bindDisposers: Array<() => void> = []
  private readonly disposeScope: () => void
  private saving = false
  private failed = false
  private disposed = false

  constructor(scope: CompassScopeLike, specs: readonly FieldSpec[]) {
    this.scope = scope
    for (const spec of specs) this.specByKey.set(spec.path.join('.'), spec)
    this.disposeScope = scope.subscribe(() => this.publish())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeScope()
    for (const off of this.bindDisposers) off()
    this.listeners.clear()
  }

  private snapshot(): CompassScopeSnapshot {
    return this.scope.getSnapshot()
  }

  private spec(key: string): FieldSpec {
    const s = this.specByKey.get(key)
    if (s === undefined) throw new Error(`compass card has no field ${key}`)
    return s
  }

  private sectionValue(spec: FieldSpec): unknown {
    return readAtPath(this.snapshot().value, spec.path)
  }

  private baseValue(spec: FieldSpec): unknown {
    return readAtPath(this.snapshot().base, spec.path)
  }

  private stored(spec: FieldSpec): boolean {
    return hasAtPath(this.snapshot().user, spec.path)
  }

  private effectiveValue(spec: FieldSpec): unknown {
    return this.sectionValue(spec)
  }

  private thresholdError(key: string, value: unknown): string | undefined {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return undefined
    const midKey = ['thresholds', 'windowMid'].join('.')
    const highKey = ['thresholds', 'windowHigh'].join('.')
    const criticalKey = ['thresholds', 'windowCritical'].join('.')
    if (key !== midKey && key !== highKey && key !== criticalKey) return undefined
    const mid = this.toNumber(this.effectiveValue(this.spec(midKey)), key === midKey ? num : undefined)
    const high = this.toNumber(this.effectiveValue(this.spec(highKey)), key === highKey ? num : undefined)
    const critical = this.toNumber(this.effectiveValue(this.spec(criticalKey)), key === criticalKey ? num : undefined)
    if (mid === undefined || high === undefined || critical === undefined) return undefined
    if (!(mid < high && high < critical)) {
      return `阈值阶梯无效：需要 ${midKey} < ${highKey} < ${criticalKey}`
    }
    return undefined
  }

  private toNumber(value: unknown, override: unknown): number | undefined {
    const raw = override ?? value
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(n) ? n : undefined
  }

  shell(): CompassShell {
    const snap = this.snapshot()
    return {
      available: snap.status === 'ready',
      writable: snap.writable,
      dirty: this.dirtyKeys().length > 0,
      invalid: this.invalidKeys().length > 0,
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(key: string): FieldDraftState {
    const spec = this.spec(key)
    const staged = this.staged.get(key)
    if (staged === undefined) {
      if (spec.kind === 'boolean') {
        return {
          text: '',
          checked: this.effectiveValue(spec) === true,
          overridden: this.stored(spec),
          invalid: false,
        }
      }
      return {
        text: formatValue(spec.kind, this.sectionValue(spec)),
        checked: false,
        overridden: this.stored(spec),
        invalid: false,
      }
    }
    if (staged.kind === 'clear') {
      if (spec.kind === 'boolean') {
        return { text: '', checked: this.baseValue(spec) === true, overridden: false, invalid: false }
      }
      return { text: formatValue(spec.kind, this.baseValue(spec)), checked: false, overridden: false, invalid: false }
    }
    if (staged.kind === 'bool') {
      return { text: '', checked: staged.checked, overridden: true, invalid: false }
    }
    if (spec.kind === 'boolean') {
      return { text: '', checked: this.effectiveValue(spec) === true, overridden: this.stored(spec), invalid: false }
    }
    const write = parseField(spec, staged.text)
    if (write.kind === 'invalid') {
      return { text: staged.text, checked: false, overridden: false, invalid: true, error: write.message }
    }
    const candidateValue = write.kind === 'set' ? write.value : this.effectiveValue(spec)
    const thresholdError = this.thresholdError(key, candidateValue)
    return {
      text: staged.text,
      checked: false,
      overridden: write.kind === 'set',
      invalid: thresholdError !== undefined,
      error: thresholdError,
    }
  }

  currentValue(key: string): unknown {
    return this.sectionValue(this.spec(key))
  }

  bind<T>(project: () => T): { getSnapshot(): T; subscribe(l: () => void): () => void } {
    let current = project()
    const subs = new Set<() => void>()
    const listener = () => {
      current = project()
      for (const l of [...subs]) l()
    }
    this.listeners.add(listener)
    this.bindDisposers.push(() => {
      this.listeners.delete(listener)
    })
    return {
      getSnapshot: () => current,
      subscribe: (l: () => void) => {
        subs.add(l)
        return () => {
          subs.delete(l)
        }
      },
    }
  }

  private stage(key: string, edit: StagedEdit): void {
    this.staged.set(key, edit)
    this.failed = false
    this.publish()
  }

  private pendingOps(): { ops: PathOp[]; dirty: string[]; invalid: string[] } {
    const ops: PathOp[] = []
    const dirty: string[] = []
    const invalid: string[] = []
    for (const [key, staged] of this.staged) {
      const spec = this.spec(key)
      if (staged.kind === 'clear') {
        if (this.stored(spec)) {
          ops.push({ op: 'unset', path: [...spec.path] })
          dirty.push(key)
        } else {
          this.staged.delete(key)
        }
        continue
      }
      if (spec.kind === 'boolean') {
        const current = this.effectiveValue(spec) === true
        const target = staged.kind === 'bool' ? staged.checked : current
        if (target === current && !this.stored(spec)) {
          this.staged.delete(key)
          continue
        }
        ops.push({ op: 'set', path: [...spec.path], value: target })
        dirty.push(key)
        continue
      }
      if (staged.kind === 'bool') continue
      const write = parseField(spec, staged.text)
      if (write.kind === 'invalid') {
        invalid.push(key)
        continue
      }
      if (write.kind === 'clear') {
        if (this.stored(spec)) {
          ops.push({ op: 'unset', path: [...spec.path] })
          dirty.push(key)
        }
      } else if (!deepEqualValue(write.value, this.sectionValue(spec))) {
        ops.push({ op: 'set', path: [...spec.path], value: write.value })
        dirty.push(key)
      }
    }
    return { ops, dirty, invalid }
  }

  private dirtyKeys(): string[] {
    return this.pendingOps().dirty
  }

  private invalidKeys(): string[] {
    return this.pendingOps().invalid
  }

  async save(): Promise<void> {
    if (this.saving) return
    const snap0 = this.snapshot()
    if (snap0.status !== 'ready' || !snap0.writable) return
    const { ops, dirty, invalid } = this.pendingOps()
    if (ops.length === 0 || invalid.length > 0) return
    const submitted = new Map(dirty.map(key => [key, this.staged.get(key)]))
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const snap = this.snapshot()
      let landed = true
      await this.scope.mutate(ops, snap.revision)
      const after = this.scope.getSnapshot()
      for (const op of ops) {
        const present = hasAtPath(after.user, op.path)
        if (op.op === 'set' ? !present : present) {
          landed = false
          break
        }
      }
      if (landed) {
        for (const [key, captured] of submitted) {
          if (this.staged.get(key) === captured) this.staged.delete(key)
        }
      }
      this.failed = !landed
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  actions() {
    return {
      editText: (key: string, text: string) => this.stage(key, { kind: 'text', text }),
      toggle: (key: string, checked: boolean) => this.stage(key, { kind: 'bool', checked }),
      resetField: (key: string) => this.stage(key, { kind: 'clear' }),
      save: () => {
        void this.save()
      },
      discard: () => {
        if (this.saving) return
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  private publish(): void {
    for (const l of [...this.listeners]) l()
  }
}

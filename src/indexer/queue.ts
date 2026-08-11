/**
 * Очередь путей с дедупом, дебаунсом и backpressure.
 *
 * Три свойства, каждое из которых закрывает конкретную проблему:
 *
 * 1. **Дедуп.** Сборщики трогают один файл по многу раз за секунду. Без Set
 *    очередь распухает на порядок, а работа выполняется одна и та же.
 * 2. **Дебаунс.** Сохранение файла в редакторе — это несколько событий подряд
 *    (write, rename, chmod). Обрабатывать надо по затиханию, а не по первому.
 * 3. **Backpressure.** `git checkout` другой ветки меняет тысячи файлов.
 *    Поштучная обработка тут дороже, чем один полный диф, поэтому при
 *    переполнении очередь честно сообщает: пора делать полный проход.
 */
export interface QueueOptions {
  debounceMs: number
  /** Выше этого порога поштучная обработка дороже полного дифа. */
  maxPaths: number
  onFlush: (paths: string[], reason: 'debounce' | 'overflow') => Promise<void>
}

export class PathQueue {
  private pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private running = false
  /** Пришло во время обработки: сбрасывать нельзя, иначе правка потеряется. */
  private rerun = false

  constructor(private readonly opts: QueueOptions) {}

  add(path: string): void {
    this.pending.add(path)

    if (this.pending.size >= this.opts.maxPaths) {
      void this.flush('overflow')
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush('debounce'), this.opts.debounceMs)
  }

  /** Немедленный сброс — используется для событий git, где ждать нечего. */
  async flushNow(): Promise<void> {
    await this.flush('debounce')
  }

  private async flush(reason: 'debounce' | 'overflow'): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Пока идёт обработка, новые события копятся; по её окончании — ещё проход.
    if (this.running) {
      this.rerun = true
      return
    }
    const paths = [...this.pending]
    this.pending.clear()
    if (!paths.length) return

    this.running = true
    try {
      await this.opts.onFlush(paths, reason)
    } finally {
      this.running = false
      if (this.rerun) {
        this.rerun = false
        void this.flush('debounce')
      }
    }
  }

  get size(): number {
    return this.pending.size
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

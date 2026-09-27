/**
 * Columnar OHLCV storage.
 *
 * WHY COLUMNAR
 * v39 held bars as `{t,o,h,l,c,v}` objects. At 50k bars that is 50k heap
 * objects the GC must trace, ~6 pointer chases per bar per frame, and no cache
 * locality — which is why bar counts had to stay small to keep pan smooth.
 * Six parallel Float64Arrays make a full pass a linear walk over contiguous
 * memory, and let the renderer scan min/max across a viewport without touching
 * the heap at all.
 *
 * Capacity grows geometrically and in place; the arrays are never reallocated
 * per append, so a live feed appending a bar a second does zero allocation in
 * steady state.
 */

export interface BarView {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

export class Series {
  /** Epoch milliseconds, ascending, strictly increasing. */
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;

  private _len = 0;
  private _cap: number;

  /** Bumped on every mutation, so renderers can cache against it. */
  revision = 0;

  constructor(capacity = 4096) {
    this._cap = Math.max(16, capacity);
    this.t = new Float64Array(this._cap);
    this.o = new Float64Array(this._cap);
    this.h = new Float64Array(this._cap);
    this.l = new Float64Array(this._cap);
    this.c = new Float64Array(this._cap);
    this.v = new Float64Array(this._cap);
  }

  get length(): number {
    return this._len;
  }
  get capacity(): number {
    return this._cap;
  }

  private grow(needed: number): void {
    if (needed <= this._cap) return;
    let cap = this._cap;
    while (cap < needed) cap *= 2;
    const copy = (src: Float64Array): Float64Array => {
      const dst = new Float64Array(cap);
      dst.set(src.subarray(0, this._len));
      return dst;
    };
    this.t = copy(this.t);
    this.o = copy(this.o);
    this.h = copy(this.h);
    this.l = copy(this.l);
    this.c = copy(this.c);
    this.v = copy(this.v);
    this._cap = cap;
  }

  /**
   * Append or update the newest bar.
   *
   * A live feed republishes the forming bar many times before it closes. If the
   * timestamp matches the current last bar we UPDATE in place rather than
   * appending — this is the invariant that keeps the forming bar from being
   * duplicated, and it is enforced here, once, instead of at every call site.
   */
  push(t: number, o: number, h: number, l: number, c: number, v = 0): void {
    const n = this._len;
    if (n > 0) {
      const lastT = this.t[n - 1] as number;
      if (t === lastT) {
        this.o[n - 1] = o;
        this.h[n - 1] = h;
        this.l[n - 1] = l;
        this.c[n - 1] = c;
        this.v[n - 1] = v;
        this.revision++;
        return;
      }
      // Out-of-order bars are a feed bug, not something to silently interleave.
      if (t < lastT) return;
    }
    this.grow(n + 1);
    this.t[n] = t;
    this.o[n] = o;
    this.h[n] = h;
    this.l[n] = l;
    this.c[n] = c;
    this.v[n] = v;
    this._len = n + 1;
    this.revision++;
  }

  /** Replace all contents from an array of bar-like records. */
  reset(bars: readonly BarView[]): void {
    this.grow(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i] as BarView;
      this.t[i] = b.t;
      this.o[i] = b.o;
      this.h[i] = b.h;
      this.l[i] = b.l;
      this.c[i] = b.c;
      this.v[i] = b.v;
    }
    this._len = bars.length;
    this.revision++;
  }

  at(i: number): BarView | null {
    if (i < 0 || i >= this._len) return null;
    return {
      t: this.t[i] as number,
      o: this.o[i] as number,
      h: this.h[i] as number,
      l: this.l[i] as number,
      c: this.c[i] as number,
      v: this.v[i] as number,
    };
  }

  /**
   * Min/max high-low over [from, to). Single linear pass, no allocation —
   * this runs every frame while panning, so it must stay allocation-free.
   */
  extent(from: number, to: number): { min: number; max: number } {
    const lo = Math.max(0, from);
    const hi = Math.min(this._len, to);
    let min = Infinity;
    let max = -Infinity;
    for (let i = lo; i < hi; i++) {
      const l = this.l[i] as number;
      const h = this.h[i] as number;
      if (l < min) min = l;
      if (h > max) max = h;
    }
    if (min === Infinity) return { min: 0, max: 1 };
    return { min, max };
  }

  /** Max volume over [from, to). */
  volumeMax(from: number, to: number): number {
    const lo = Math.max(0, from);
    const hi = Math.min(this._len, to);
    let max = 0;
    for (let i = lo; i < hi; i++) {
      const v = this.v[i] as number;
      if (v > max) max = v;
    }
    return max;
  }

  /** Index of the last bar at or before `time`. Binary search. */
  indexAtTime(time: number): number {
    let lo = 0;
    let hi = this._len - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.t[mid] as number) <= time) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /**
   * Measured spacing between bars, in ms — the MEDIAN of the last `sample`
   * gaps, not the nominal timeframe.
   *
   * The old build derived gap/quality checks from the UI timeframe, which lies:
   * weekends, holidays and vendor outages all produce gaps a 1H label knows
   * nothing about. Measuring, and taking the median so a single weekend gap
   * cannot skew it, is the honest answer.
   */
  spacingMs(sample = 64): number {
    const n = this._len;
    if (n < 2) return 0;
    const count = Math.min(sample, n - 1);
    const gaps = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const idx = n - 1 - i;
      gaps[i] = (this.t[idx] as number) - (this.t[idx - 1] as number);
    }
    gaps.sort();
    return gaps[count >> 1] as number;
  }
}

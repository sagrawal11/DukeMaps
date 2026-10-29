// editor/overlay.ts — a 2D <canvas> over the map for transient, gesture-scoped feedback: the
// rubber-band edge while drawing, the node-drag ghost, the snap ring. Canvas drawing is
// synchronous so the feedback appears immediately under the cursor (the lesson from the bbox
// picker, which failed when it relied on MapLibre's async render for live feedback). It is only
// drawn during an active drag (with dragPan disabled), so it never desyncs during pan/zoom.
import type * as maplibregl from 'maplibre-gl'

export class Overlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private map: maplibregl.Map

  constructor(map: maplibregl.Map) {
    this.map = map
    const c = document.createElement('canvas')
    c.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
    map.getCanvasContainer().appendChild(c)
    this.canvas = c
    this.ctx = c.getContext('2d')!
    this.size()
    map.on('resize', () => this.size())
  }

  size(): void {
    const el = this.map.getCanvasContainer()
    this.canvas.width = el.clientWidth
    this.canvas.height = el.clientHeight
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  line(a: [number, number], b: [number, number], color: string, width = 2, dashed = false): void {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    if (dashed) ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.stroke()
    ctx.restore()
  }

  dot(p: [number, number], r: number, color: string): void {
    const ctx = this.ctx
    ctx.save()
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  ring(p: [number, number], r: number, color: string): void {
    const ctx = this.ctx
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}

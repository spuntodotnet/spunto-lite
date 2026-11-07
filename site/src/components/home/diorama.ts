import * as THREE from "three"
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js"

/* ─── The diorama ──────────────────────────────────────────────────────────
   The home page's one picture, and the product in one gesture: a laptop on a
   sheet of paper, and the workspaces it runs as toy boxes around it, each
   wired to it by its own cable. Click the button (or the paper) and a box
   drops in; click a box and it hops off the table. One of them has a small
   robot sitting on it, typing — that's an agent at work.

   Deliberately toy-like rather than "tech": matte colours, soft shadow on the
   page's own paper, an orthographic camera so it reads like a drawing.
   Everything is procedural (no model files), so the page stays one request
   lighter and the shapes stay editable here. */

export type DioramaPalette = {
  ink: string
  sky: string
  paper: string
  marker: string
  cream: string
}

export type DioramaOptions = {
  canvas: HTMLCanvasElement
  labels: HTMLElement
  palette: DioramaPalette
  reducedMotion: boolean
  onCountChange?: (count: number) => void
}

type Box = {
  group: THREE.Group
  body: THREE.Mesh
  slot: number
  name: string
  label: HTMLDivElement
  cable: THREE.Mesh
  cableLength: number
  cableProgress: number
  y: number
  vy: number
  squash: number
  state: "falling" | "idle" | "leaving"
  leaveT: number
  hover: number
  agent?: THREE.Group
  screen?: THREE.Mesh
}

/* Where boxes may land, around the laptop at the origin (x, z). */
const SLOTS: [number, number][] = [
  [-3.1, -1.4],
  [3.2, -1.2],
  [-2.6, 1.9],
  [2.9, 1.8],
  [0.2, -3.2],
  [-4.6, 0.4],
  [4.7, 0.3],
  [0.4, 3.3],
  [-1.6, -3.6],
  [2.0, -3.7],
]

const GRAVITY = -38
const BOX = 1.15

function hexName(): string {
  return Math.random().toString(16).slice(2, 6)
}

/** A canvas painted like a screen full of code — shared by every box screen. */
function codeTexture(ink: string, sky: string, marker: string): THREE.CanvasTexture {
  const c = document.createElement("canvas")
  c.width = 128
  c.height = 256
  const g = c.getContext("2d")!
  g.fillStyle = ink
  g.fillRect(0, 0, c.width, c.height)
  const colors = [sky, "#e8f6ff", sky, marker, "#9fb4d6"]
  let y = 8
  while (y < c.height - 6) {
    let x = 8 + Math.floor(Math.random() * 3) * 10
    const words = 1 + Math.floor(Math.random() * 4)
    for (let i = 0; i < words && x < c.width - 12; i++) {
      const w = 8 + Math.random() * 30
      g.fillStyle = colors[Math.floor(Math.random() * colors.length)]
      g.globalAlpha = 0.85
      g.fillRect(x, y, Math.min(w, c.width - 8 - x), 5)
      x += w + 5
    }
    y += 11
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(1, 0.5)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** The laptop's screen: a tiny Lite dashboard, workers listed as rows. */
function dashboardTexture(p: DioramaPalette): THREE.CanvasTexture {
  const c = document.createElement("canvas")
  c.width = 320
  c.height = 200
  const g = c.getContext("2d")!
  g.fillStyle = "#f7f9fc"
  g.fillRect(0, 0, 320, 200)
  g.fillStyle = p.ink
  g.fillRect(0, 0, 70, 200)
  g.fillStyle = p.sky
  g.fillRect(12, 14, 18, 18)
  for (let i = 0; i < 5; i++) {
    g.fillStyle = i === 1 ? p.sky : "#3d5480"
    g.fillRect(12, 48 + i * 18, 44, 6)
  }
  g.fillStyle = p.ink
  g.fillRect(86, 16, 120, 12)
  g.fillStyle = p.sky
  g.fillRect(248, 12, 58, 20)
  for (let i = 0; i < 5; i++) {
    const y = 48 + i * 28
    g.fillStyle = "#ffffff"
    g.fillRect(86, y, 220, 22)
    g.strokeStyle = "#dfe5ef"
    g.strokeRect(86, y, 220, 22)
    g.fillStyle = i === 2 ? p.marker : "#2fbf71"
    g.beginPath()
    g.arc(98, y + 11, 4, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = "#93a3be"
    g.fillRect(110, y + 8, 70 + ((i * 37) % 50), 6)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

export class Diorama {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.OrthographicCamera
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2(9, 9)
  private parallax = new THREE.Vector2()
  private boxes: Box[] = []
  private clock = new THREE.Clock()
  private codeTex: THREE.CanvasTexture[]
  private puffs: { mesh: THREE.Mesh; v: THREE.Vector3; life: number }[] = []
  private running = true
  private visible = true
  private raf = 0
  private hovered: Box | null = null
  private materials: Record<string, THREE.Material>
  private laptopScreen: THREE.Mesh
  private cameraTarget = new THREE.Vector3(0, 0.4, 0)
  private pins: { el: HTMLElement; at: THREE.Vector3 }[] = []

  constructor(private o: DioramaOptions) {
    const { canvas, palette: p } = o
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    this.camera.position.set(9, 9.5, 11)
    this.camera.lookAt(this.cameraTarget)

    // Light: a soft sky, and one sun for the shadows on the paper.
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#c9c2b0", 1.6))
    const sun = new THREE.DirectionalLight("#fff6e8", 2.2)
    sun.position.set(-6, 14, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -10
    sun.shadow.camera.right = 10
    sun.shadow.camera.top = 10
    sun.shadow.camera.bottom = -10
    sun.shadow.radius = 6
    sun.shadow.bias = -0.0006
    this.scene.add(sun)

    // The paper: invisible, it only catches shadows, so the page's own
    // background is the table.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.16 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)

    const mat = (color: string, rough = 0.85) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 })
    this.materials = {
      ink: mat(p.ink),
      sky: mat(p.sky),
      cream: mat(p.cream),
      marker: mat(p.marker),
      cable: mat(p.ink, 0.6),
      white: mat("#ffffff"),
      dark: mat("#0b1730", 0.4),
    }
    this.codeTex = [0, 1, 2].map(() => codeTexture("#0f213f", p.sky, p.marker))

    this.laptopScreen = this.buildLaptop()

    this.resize()
    window.addEventListener("resize", this.resize)
    canvas.addEventListener("pointermove", this.onPointerMove)
    canvas.addEventListener("pointerleave", this.onPointerLeave)
    canvas.addEventListener("click", this.onClick)
    document.addEventListener("visibilitychange", this.onVisibility)
    new IntersectionObserver(([e]) => (this.visible = e.isIntersecting)).observe(canvas)

    this.loop()
  }

  /* ─── Building ──────────────────────────────────────────────────────── */

  private buildLaptop(): THREE.Mesh {
    const g = new THREE.Group()
    const base = new THREE.Mesh(new RoundedBoxGeometry(3.2, 0.16, 2.2, 4, 0.08), this.materials.cream)
    base.position.y = 0.08
    base.castShadow = base.receiveShadow = true
    g.add(base)

    // Keyboard: a field of tiny keys, and a trackpad.
    const keyGeo = new THREE.BoxGeometry(0.17, 0.04, 0.17)
    const keys = new THREE.InstancedMesh(keyGeo, this.materials.ink, 12 * 4)
    const m = new THREE.Matrix4()
    let k = 0
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 12; c++) {
        m.makeTranslation(-1.21 + c * 0.22, 0.18, -0.55 + r * 0.22)
        keys.setMatrixAt(k++, m)
      }
    keys.castShadow = true
    g.add(keys)
    const pad = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.02, 0.5, 2, 0.04), mat2("#e2dccd"))
    pad.position.set(0, 0.17, 0.7)
    g.add(pad)

    // Lid, hinged at the back, opened a bit past vertical.
    const hinge = new THREE.Group()
    hinge.position.set(0, 0.16, -1.08)
    hinge.rotation.x = -0.22
    const lid = new THREE.Mesh(new RoundedBoxGeometry(3.2, 2.05, 0.12, 4, 0.06), this.materials.cream)
    lid.position.set(0, 1.02, 0)
    lid.castShadow = true
    hinge.add(lid)
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(2.9, 1.8),
      new THREE.MeshBasicMaterial({ map: dashboardTexture(this.o.palette) }),
    )
    screen.position.set(0, 1.04, 0.065)
    hinge.add(screen)
    g.add(hinge)

    // A sticker on the lid's back — the only branding in the scene.
    const sticker = new THREE.Mesh(new THREE.CircleGeometry(0.28, 32), this.materials.sky)
    sticker.position.set(0.9, 1.4, -0.065)
    sticker.rotation.y = Math.PI
    hinge.add(sticker)

    this.scene.add(g)
    return screen

    function mat2(color: string) {
      return new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
    }
  }

  private buildRobot(): THREE.Group {
    const r = new THREE.Group()
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.2, 6, 12), this.materials.white)
    body.position.y = 0.28
    body.castShadow = true
    r.add(body)
    const head = new THREE.Group()
    head.position.y = 0.66
    const skull = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.32, 0.34, 4, 0.1), this.materials.white)
    skull.castShadow = true
    head.add(skull)
    const visor = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.18, 0.04, 2, 0.04), this.materials.dark)
    visor.position.set(0, 0, 0.17)
    head.add(visor)
    for (const x of [-0.07, 0.07]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 12), new THREE.MeshBasicMaterial({ color: this.o.palette.sky }))
      eye.position.set(x, 0.01, 0.195)
      eye.name = "eye"
      head.add(eye)
    }
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16), this.materials.ink)
    antenna.position.y = 0.24
    head.add(antenna)
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 12), this.materials.marker)
    bulb.position.y = 0.33
    head.add(bulb)
    head.name = "head"
    r.add(head)
    // Two arms reaching down to an invisible keyboard, so it reads as typing.
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.2, 4, 8), this.materials.white)
      arm.position.set(side * 0.2, 0.3, 0.1)
      arm.rotation.x = -1.1
      arm.name = side < 0 ? "armL" : "armR"
      arm.castShadow = true
      r.add(arm)
    }
    // A little laptop of its own.
    const lap = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.04, 0.32, 2, 0.02), this.materials.ink)
    lap.position.set(0, 0.04, 0.36)
    r.add(lap)
    const lapLid = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.32, 0.03, 2, 0.015), this.materials.ink)
    lapLid.position.set(0, 0.2, 0.22)
    lapLid.rotation.x = 0.25
    r.add(lapLid)
    r.scale.setScalar(1.15)
    return r
  }

  private buildCable(x: number, z: number): { mesh: THREE.Mesh; length: number } {
    // From the back of the laptop, along the paper, to the box — with a lazy
    // sag sideways so cables don't read as straight vectors.
    const start = new THREE.Vector3(Math.sign(x) * 1.2, 0.05, -1.0)
    const end = new THREE.Vector3(x - Math.sign(x || 1) * 0.3, 0.05, z)
    const mid = start.clone().lerp(end, 0.5)
    mid.x += (Math.random() - 0.5) * 1.6
    mid.z += (Math.random() - 0.5) * 1.6
    const curve = new THREE.CatmullRomCurve3([start, mid, end])
    const geo = new THREE.TubeGeometry(curve, 60, 0.045, 6, false)
    const mesh = new THREE.Mesh(geo, this.materials.cable)
    mesh.castShadow = true
    geo.setDrawRange(0, 0)
    this.scene.add(mesh)
    return { mesh, length: geo.index!.count }
  }

  /* ─── Public ────────────────────────────────────────────────────────── */

  get count(): number {
    return this.boxes.filter((b) => b.state !== "leaving").length
  }

  /** Drop a new box on a free spot. `agent` sits a robot on it. */
  spawn(opts: { agent?: boolean; color?: "ink" | "sky" | "cream" | "marker"; name?: string; slot?: number } = {}): void {
    const taken = new Set(this.boxes.filter((b) => b.state !== "leaving").map((b) => b.slot))
    let free = SLOTS.map((_, i) => i).filter((i) => !taken.has(i))
    if (free.length === 0) {
      // Full table: the oldest box leaves to make room.
      const oldest = this.boxes.find((b) => b.state !== "leaving" && !b.agent)
      if (!oldest) return
      this.remove(oldest)
      free = [oldest.slot]
    }
    const slot =
      opts.slot !== undefined && free.includes(opts.slot) ? opts.slot : free[Math.floor(Math.random() * Math.min(free.length, 3))]
    const [x, z] = SLOTS[slot]

    const colors = ["ink", "sky", "cream"] as const
    const color = opts.color ?? colors[Math.floor(Math.random() * colors.length)]
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    group.rotation.y = (Math.random() - 0.5) * 0.7

    const body = new THREE.Mesh(new RoundedBoxGeometry(BOX, BOX * 0.82, BOX, 4, 0.1), this.materials[color])
    body.position.y = (BOX * 0.82) / 2
    body.castShadow = body.receiveShadow = true
    body.userData.box = true
    group.add(body)

    // The lid, a size up: it reads as a box rather than a cube.
    const lid = new THREE.Mesh(
      new RoundedBoxGeometry(BOX * 1.08, 0.14, BOX * 1.08, 3, 0.05),
      color === "ink" ? this.materials.sky : this.materials.ink,
    )
    lid.position.y = BOX * 0.82 + 0.05
    lid.castShadow = true
    group.add(lid)

    // A screen on the front, scrolling code.
    const tex = this.codeTex[Math.floor(Math.random() * this.codeTex.length)]
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(BOX * 0.62, BOX * 0.42),
      new THREE.MeshBasicMaterial({ map: tex }),
    )
    screen.position.set(0, BOX * 0.42, BOX / 2 + 0.006)
    group.add(screen)
    // Its status light.
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 12, 12),
      new THREE.MeshBasicMaterial({ color: opts.agent ? this.o.palette.marker : "#2fbf71" }),
    )
    led.position.set(BOX * 0.36, BOX * 0.12, BOX / 2 + 0.02)
    group.add(led)

    let agent: THREE.Group | undefined
    if (opts.agent) {
      agent = this.buildRobot()
      agent.position.y = BOX * 0.82 + 0.12
      agent.rotation.y = 0.5
      group.add(agent)
    }

    this.scene.add(group)
    const { mesh: cable, length } = this.buildCable(x, z)

    const name = opts.name ?? `worker-${hexName()}`
    const label = document.createElement("div")
    label.className = "diorama-label"
    label.textContent = opts.agent ? `${name} · agent` : `${name}.localhost`
    this.o.labels.appendChild(label)

    const box: Box = {
      group,
      body,
      slot,
      name,
      label,
      cable,
      cableLength: length,
      cableProgress: 0,
      y: this.o.reducedMotion ? 0 : 7 + Math.random() * 2,
      vy: 0,
      squash: 0,
      state: this.o.reducedMotion ? "idle" : "falling",
      leaveT: 0,
      hover: 0,
      agent,
      screen,
    }
    if (this.o.reducedMotion) box.cableProgress = 1
    group.position.y = box.y
    this.boxes.push(box)
    this.o.onCountChange?.(this.count)
  }

  /** Keep an HTML element (a handwritten note) stuck to a point of the scene. */
  pin(el: HTMLElement, at: [number, number, number]): void {
    this.pins.push({ el, at: new THREE.Vector3(...at) })
  }

  remove(box: Box): void {
    if (box.state === "leaving") return
    box.state = "leaving"
    box.leaveT = 0
    box.vy = 9
    box.label.classList.add("is-leaving")
    this.o.onCountChange?.(this.count)
  }

  dispose(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    window.removeEventListener("resize", this.resize)
    document.removeEventListener("visibilitychange", this.onVisibility)
    this.renderer.dispose()
  }

  /* ─── Events ────────────────────────────────────────────────────────── */

  private resize = () => {
    const { canvas } = this.o
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    this.renderer.setSize(w, h, false)
    const aspect = w / h
    // Keep the whole table in view: fit width on narrow screens, height on wide ones.
    const half = aspect < 1 ? 4.7 / aspect : Math.max(5.6, 9.4 / aspect)
    // On a wide screen the headline owns the left: slide the table right.
    const shift = aspect > 1.15 ? half * aspect * 0.34 : 0
    this.camera.left = -half * aspect - shift
    this.camera.right = half * aspect - shift
    // On a phone the table sits under the copy: lift it towards it.
    const lift = aspect < 1 ? half * 0.14 : 0
    this.camera.top = half - lift
    this.camera.bottom = -half - lift
    this.camera.updateProjectionMatrix()
  }

  private onPointerMove = (e: PointerEvent) => {
    const r = this.o.canvas.getBoundingClientRect()
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }

  private onPointerLeave = () => this.pointer.set(9, 9)

  private onClick = () => {
    if (this.hovered) this.remove(this.hovered)
    else this.spawn()
  }

  private onVisibility = () => {
    if (!document.hidden) this.clock.getDelta()
  }

  /* ─── Frame ─────────────────────────────────────────────────────────── */

  private loop = () => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)
    if (!this.visible || document.hidden) return
    const dt = Math.min(this.clock.getDelta(), 1 / 30)
    const t = this.clock.elapsedTime
    this.update(dt, t)
    this.renderer.render(this.scene, this.camera)
    this.placeLabels()
  }

  private update(dt: number, t: number) {
    // Camera: a slow breath, and a little parallax under the pointer.
    if (!this.o.reducedMotion) {
      const px = this.pointer.x > 2 ? 0 : this.pointer.x
      const py = this.pointer.y > 2 ? 0 : this.pointer.y
      this.parallax.x += (px - this.parallax.x) * 0.04
      this.parallax.y += (py - this.parallax.y) * 0.04
      const a = Math.atan2(11, 9) + this.parallax.x * 0.12 + Math.sin(t * 0.15) * 0.04
      this.camera.position.set(Math.cos(a) * 14.2, 9.5 + this.parallax.y * 0.8, Math.sin(a) * 14.2)
      this.camera.lookAt(this.cameraTarget)
    }

    // Hover.
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(
      this.boxes.filter((b) => b.state === "idle").map((b) => b.group),
      true,
    )
    const hit = hits[0] ? this.boxes.find((b) => b.group === rootOf(hits[0].object, this.scene)) ?? null : null
    if (hit !== this.hovered) {
      this.hovered?.label.classList.remove("is-hover")
      hit?.label.classList.add("is-hover")
      this.hovered = hit
      this.o.canvas.style.cursor = hit ? "pointer" : "copy"
    }

    for (const tex of this.codeTex) tex.offset.y = (tex.offset.y + dt * 0.08) % 1

    for (const b of [...this.boxes]) {
      if (b.state === "falling") {
        b.vy += GRAVITY * dt
        b.y += b.vy * dt
        if (b.y <= 0) {
          b.y = 0
          if (Math.abs(b.vy) > 4) {
            b.squash = Math.min(0.35, Math.abs(b.vy) * 0.018)
            if (Math.abs(b.vy) > 10) this.puff(b.group.position)
            b.vy = -b.vy * 0.32
          } else {
            b.vy = 0
            b.state = "idle"
          }
        }
      } else if (b.state === "leaving") {
        b.leaveT += dt
        b.vy += GRAVITY * 0.6 * dt
        b.y += b.vy * dt
        b.group.rotation.y += dt * 9
        const s = Math.max(0, 1 - b.leaveT * 1.6)
        b.group.scale.setScalar(s)
        b.cableProgress = Math.max(0, b.cableProgress - dt * 2.5)
        if (s === 0) {
          this.scene.remove(b.group, b.cable)
          b.cable.geometry.dispose()
          b.label.remove()
          this.boxes.splice(this.boxes.indexOf(b), 1)
          continue
        }
      }

      if (b.state !== "leaving") {
        // Squash and stretch, settling.
        b.squash *= Math.pow(0.0008, dt)
        const sq = b.state === "falling" && b.vy < -6 ? -0.08 : b.squash
        const hoverTarget = b === this.hovered ? 1 : 0
        b.hover += (hoverTarget - b.hover) * Math.min(1, dt * 12)
        b.group.scale.set(1 + sq * 0.6 + b.hover * 0.04, 1 - sq + b.hover * 0.04, 1 + sq * 0.6 + b.hover * 0.04)
        if (b.state === "idle" || b.y < 0.5) b.cableProgress = Math.min(1, b.cableProgress + dt * 1.6)
      }
      b.group.position.y = b.y + b.hover * 0.18
      b.cable.geometry.setDrawRange(0, Math.floor(b.cableLength * easeOut(b.cableProgress) / 3) * 3)

      // The agent types: head bob, arms alternating, a blink now and then.
      if (b.agent) {
        const head = b.agent.getObjectByName("head")!
        head.rotation.x = 0.25 + Math.sin(t * 6) * 0.05
        head.rotation.z = Math.sin(t * 1.3) * 0.08
        b.agent.getObjectByName("armL")!.rotation.x = -1.1 + Math.sin(t * 18) * 0.18
        b.agent.getObjectByName("armR")!.rotation.x = -1.1 + Math.sin(t * 18 + Math.PI) * 0.18
        const blink = Math.sin(t * 1.7) > 0.985 ? 0.1 : 1
        head.children.filter((c) => c.name === "eye").forEach((e) => (e.scale.y = blink))
      }
    }

    for (const p of [...this.puffs]) {
      p.life -= dt
      p.mesh.position.addScaledVector(p.v, dt)
      p.v.multiplyScalar(Math.pow(0.05, dt))
      p.mesh.scale.setScalar(Math.max(0.001, p.life * 1.6))
      if (p.life <= 0) {
        this.scene.remove(p.mesh)
        this.puffs.splice(this.puffs.indexOf(p), 1)
      }
    }

    // The laptop screen breathes a little, as if something updated.
    ;(this.laptopScreen.material as THREE.MeshBasicMaterial).color.setScalar(0.96 + Math.sin(t * 2) * 0.04)
  }

  private puff(at: THREE.Vector3) {
    const geo = new THREE.SphereGeometry(0.09, 8, 8)
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2
      const mesh = new THREE.Mesh(geo, this.materials.cream)
      mesh.position.set(at.x + Math.cos(a) * 0.6, 0.08, at.z + Math.sin(a) * 0.6)
      this.scene.add(mesh)
      this.puffs.push({ mesh, v: new THREE.Vector3(Math.cos(a) * 2.4, 0.6 + Math.random(), Math.sin(a) * 2.4), life: 0.55 })
    }
  }

  private v = new THREE.Vector3()
  private placeLabels() {
    const { canvas } = this.o
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    for (const b of this.boxes) {
      this.v.set(b.group.position.x, b.group.position.y + (b.agent ? 2.4 : 1.55), b.group.position.z)
      this.v.project(this.camera)
      b.label.style.transform = `translate(-50%, -100%) translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px)`
      b.label.style.opacity = b.state === "falling" && b.y > 1 ? "0" : ""
    }
    for (const p of this.pins) {
      this.v.copy(p.at).project(this.camera)
      p.el.style.transform = `translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px)`
    }
  }
}

function rootOf(o: THREE.Object3D, scene: THREE.Scene): THREE.Object3D {
  while (o.parent && o.parent !== scene) o = o.parent
  return o
}

function easeOut(x: number): number {
  return 1 - Math.pow(1 - x, 3)
}

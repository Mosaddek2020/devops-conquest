// The world map: the curriculum drawn as the DevOps infinity loop in 3D. Realms are stations
// on the loop; each realm's lessons arc between the previous station and its own. The
// loop's phases float around it, an AI core glows where the loop crosses itself, and a
// marker hovers over your current lesson.

import { h, clear, ring, toast, cssVar } from '../ui/dom.js';
import { curriculum } from '../curriculum.js';
import { isMastered, isUnlocked, realmProgress, realmUnlocked, currentLessonId, getState } from '../store.js';

export function renderHub() {
  const root = h('div', { class: 'hub' });
  const stage = h('div', { class: 'hub-stage' });
  const labels = h('div', { class: 'hub-labels' });
  const panel = h('aside', { class: 'hub-panel', 'aria-label': 'Your journey' });
  root.append(stage, panel);
  let focusRealm = null;
  let world = null;

  const drawPanel = () => {
    clear(panel);
    const cur = currentLessonId();
    const st = getState();
    const mastered = curriculum.order.filter(isMastered).length;
    panel.append(
      h('p', { class: 'eyebrow', style: { margin: 0 } }, 'Zero to hero · DevOps in the age of AI'),
      h('h1', {}, 'Run the whole loop, from first command to production.'),
      h('p', { class: 'lede', style: { margin: 0 } }, 'Each lesson teaches one idea from several angles, drills it on simulated servers, pipelines, containers and clusters, then makes you prove it. Master it and the next station on the loop lights up.'));
    if (cur) {
      const l = curriculum.byId[cur];
      const r = curriculum.realmOf[cur];
      panel.append(h('div', { class: 'continue-card' },
        h('span', { class: 'eyebrow' }, mastered ? 'Continue where you left off' : 'Start here'),
        h('h2', {}, l.title),
        h('span', { style: { color: 'var(--muted)', fontSize: '.9rem' } }, `Realm ${r.n} · ${r.title} · lesson ${l.index + 1} of ${r.lessons.length}`),
        h('a', { class: 'btn btn-primary', href: `#/lesson/${cur}`, style: { justifySelf: 'start' } }, mastered ? 'Continue →' : 'Begin the first lesson →')));
    } else {
      panel.append(h('div', { class: 'continue-card' }, h('span', { class: 'eyebrow' }, 'Path complete'), h('h2', {}, 'You conquered every realm.'), h('a', { class: 'btn btn-primary', href: '#/profile', style: { justifySelf: 'start' } }, 'See your profile')));
    }
    panel.append(h('div', { class: 'stat-row' },
      h('div', { class: 'stat' }, h('div', { class: 'v' }, `${mastered}/${curriculum.order.length}`), h('div', { class: 'k' }, 'lessons mastered')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, String(st.xp)), h('div', { class: 'k' }, 'XP'))));
    const list = h('ol', { class: 'realm-list', 'aria-label': 'Realms' });
    for (const r of curriculum.realms) {
      const p = realmProgress(r);
      const unlocked = realmUnlocked(r);
      const row = h('a', {
        class: 'realm-row' + (unlocked ? '' : ' is-locked') + (focusRealm === r.id ? ' is-focus' : ''),
        href: `#/realm/${r.id}`,
        onmouseenter: () => world?.focus(r.id, false),
      }, ring(p.fraction, `${p.done}`), h('span', {}, h('span', { class: 't' }, r.title), h('br'), h('span', { class: 's' }, `${r.n}. ${r.tagline}`)), h('span', { class: 'num' }, unlocked ? `${p.done}/${p.total}` : 'locked'));
      list.append(h('li', {}, row));
    }
    panel.append(h('div', {}, h('p', { class: 'eyebrow', style: { margin: '0 0 6px' } }, 'Realms'), list));
  };
  drawPanel();

  if (typeof THREE === 'undefined') {
    stage.append(h('div', { class: 'graph-empty', style: { padding: '80px 24px' } }, 'The 3D map could not load (WebGL or the three.js library is unavailable). Use the realm list to navigate.'));
    return { el: root, destroy() {} };
  }
  try {
    world = new World3D(stage, labels, {
      onRealm: (id) => { focusRealm = id; drawPanel(); },
      onLesson: (id) => {
        if (isUnlocked(id)) location.hash = `#/lesson/${id}`;
        else toast('Locked', { sub: 'Master the lessons before it first.' });
      },
    });
    stage.append(labels,
      h('div', { class: 'hub-legend', 'aria-hidden': 'true' },
        h('span', {}, h('i', { style: { background: 'var(--accent)' } }), 'mastered'),
        h('span', {}, h('i', { style: { background: 'var(--main)' } }), 'open'),
        h('span', {}, h('i', { style: { background: 'var(--line-strong)' } }), 'locked'),
        h('span', {}, h('i', { style: { background: 'var(--remote)' } }), 'AI core')),
      h('div', { class: 'hub-hint', 'aria-hidden': 'true' }, 'drag to orbit · scroll to zoom · click a realm'));
  } catch (e) {
    console.error(e);
    stage.append(h('div', { class: 'graph-empty', style: { padding: '80px 24px' } }, 'The 3D map could not start on this device. Use the realm list to navigate.'));
  }
  return { el: root, destroy() { world?.destroy(); } };
}

class World3D {
  constructor(stage, labelLayer, { onRealm, onLesson }) {
    this.stage = stage;
    this.labelLayer = labelLayer;
    this.onRealm = onRealm;
    this.onLesson = onLesson;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer = renderer;
    stage.append(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D map of the curriculum');
    renderer.domElement.setAttribute('role', 'img');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    this.target = new THREE.Vector3(0, 0, 0);
    this.goalTarget = this.target.clone();
    this.sph = { theta: -0.3, phi: 0.95, r: 58 };
    this.goalR = 58;
    this.nodes = [];
    this.labels = [];
    this.build();
    this.bind();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(stage);
    const cur = currentLessonId();
    if (cur) this.focus(curriculum.realmOf[cur].id, false, 30);
    this.running = true;
    this.t0 = performance.now();
    const loop = () => { if (!this.running) return; this.frame(); this.raf = requestAnimationFrame(loop); };
    loop();
    this.themeObs = new MutationObserver(() => this.retheme());
    this.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.mq = window.matchMedia('(prefers-color-scheme: dark)');
    this.mqFn = () => this.retheme();
    this.mq.addEventListener?.('change', this.mqFn);
  }

  colors() {
    const c = n => new THREE.Color(cssVar(n) || '#888');
    return { bg: c('--bg'), main: c('--main'), feat: c('--feat'), accent: c('--accent'), line: c('--line-strong'), muted: c('--muted'), remote: c('--remote'), text: c('--text') };
  }

  build() {
    const C = this.colors();
    this.C = C;
    this.scene.background = C.bg;
    this.scene.fog = new THREE.Fog(C.bg, 70, 160);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const dl = new THREE.DirectionalLight(0xffffff, 0.7);
    dl.position.set(10, 20, 15);
    this.scene.add(dl);

    // stars
    const starGeo = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < 900; i++) {
      const r = 70 + Math.random() * 60, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
      pts.push(r * Math.sin(p) * Math.cos(t), r * Math.cos(p), r * Math.sin(p) * Math.sin(t));
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: C.muted, size: 0.35, transparent: true, opacity: 0.7 }));
    this.scene.add(this.stars);

    // the DevOps loop: a lemniscate (∞) with a gentle wave
    const N = curriculum.realms.length;
    const A = 26;
    const loopAt = (u) => { const t = u * Math.PI * 2; const d = 1 + Math.sin(t) ** 2; return new THREE.Vector3(A * Math.cos(t) / d, Math.sin(t * 2) * 1.6, A * Math.sin(t) * Math.cos(t) / d * 1.25); };
    const realmU = curriculum.realms.map((r, i) => 0.02 + (i / N));
    const realmPos = realmU.map(loopAt);
    const origin = loopAt(0.02 - 0.5 / N);
    this.realmPos = realmPos;
    this.origin = origin;

    const cur = currentLessonId();
    const tube = (points, color, radius, opacity = 1, closed = false) => {
      const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
      const geo = new THREE.TubeGeometry(curve, Math.max(8, points.length * 10), radius, 8, closed);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.6, transparent: opacity < 1, opacity }));
      this.scene.add(m);
      return m;
    };
    // the full loop, faint, then the travelled part bright
    const loopPts = Array.from({ length: 160 }, (_, k) => loopAt(k / 160));
    tube(loopPts, C.line, 0.07, 0.45, true);
    let reached = 0;
    curriculum.realms.forEach((r, i) => { if (r.lessons.every(l => isMastered(l.id))) reached = i + 1; });
    if (reached > 0) {
      const endU = realmU[reached - 1];
      const startU = 0.02 - 0.5 / N;
      const pts = Array.from({ length: 80 }, (_, k) => loopAt(startU + (endU - startU) * k / 79));
      tube(pts, C.accent, 0.16, 1);
    }
    // phases of the loop floating around it
    ['PLAN', 'CODE', 'BUILD', 'TEST', 'RELEASE', 'DEPLOY', 'OPERATE', 'MONITOR'].forEach((ph, k) => {
      const p = loopAt(0.06 + k / 8).multiplyScalar(1.22).add(new THREE.Vector3(0, 4.2, 0));
      this.addLabel({ text: ph, pos: p, kind: 'phase' });
    });
    // AI core at the crossing
    const coreColor = C.remote;
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 1), new THREE.MeshStandardMaterial({ color: coreColor, emissive: coreColor, emissiveIntensity: 0.55, roughness: 0.3, flatShading: true, transparent: true, opacity: 0.85 }));
    core.position.set(0, 0, 0);
    core.userData.core = true;
    this.scene.add(core);
    const coreRing = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.03, 8, 64), new THREE.MeshBasicMaterial({ color: coreColor, transparent: true, opacity: 0.5 }));
    coreRing.userData.spin = true;
    coreRing.rotation.x = Math.PI / 2.4;
    this.scene.add(coreRing);
    this.addLabel({ text: 'AI · assists every phase', pos: new THREE.Vector3(0, -2.6, 0), kind: 'root' });
    // start node
    const rootMesh = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), new THREE.MeshStandardMaterial({ color: C.main, emissive: C.main, emissiveIntensity: 0.4 }));
    rootMesh.position.copy(origin);
    this.scene.add(rootMesh);
    this.addLabel({ text: 'start', pos: origin, kind: 'root' });

    curriculum.realms.forEach((realm, ri) => {
      const fromU = ri === 0 ? 0.02 - 0.5 / N : realmU[ri - 1];
      const toU = realmU[ri];
      const to = realmPos[ri];
      const unlocked = realmUnlocked(realm);
      const allDone = realm.lessons.every(l => isMastered(l.id));
      const n = realm.lessons.length;
      const lift = new THREE.Vector3(0, 3.0 + (ri % 3) * 0.5, 0);
      const lessonPts = realm.lessons.map((l, li) => {
        const t = (li + 1) / (n + 1);
        return loopAt(fromU + (toU - fromU) * t).add(lift.clone().multiplyScalar(Math.sin(Math.PI * t) * 1.0));
      });
      tube([loopAt(fromU), ...lessonPts, to], unlocked ? (allDone ? C.accent : C.feat) : C.line, 0.05, unlocked ? 0.9 : 0.3);
      realm.lessons.forEach((l, li) => {
        const mastered = isMastered(l.id);
        const open = isUnlocked(l.id);
        const color = mastered ? C.accent : open ? C.main : C.line;
        const geo = l.boss ? new THREE.OctahedronGeometry(0.42) : new THREE.SphereGeometry(0.3, 18, 12);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: mastered ? 0.6 : open ? 0.35 : 0.05, roughness: 0.4 }));
        mesh.position.copy(lessonPts[li]);
        mesh.userData = { kind: 'lesson', id: l.id, realm: realm.id, state: mastered ? 'done' : open ? 'open' : 'locked' };
        this.scene.add(mesh);
        this.nodes.push(mesh);
        this.addLabel({ text: l.title, pos: lessonPts[li], kind: 'lesson', realm: realm.id, id: l.id, state: mesh.userData.state, current: l.id === cur });
        if (l.id === cur) this.headPos = lessonPts[li].clone();
      });
      const color = allDone ? C.accent : unlocked ? C.main : C.line;
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 1), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: allDone ? 0.55 : unlocked ? 0.3 : 0.05, roughness: 0.35, flatShading: true }));
      mesh.position.copy(to);
      mesh.userData = { kind: 'realm', id: realm.id, state: allDone ? 'done' : unlocked ? 'open' : 'locked' };
      this.scene.add(mesh);
      this.nodes.push(mesh);
      const ringM = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.04, 8, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: unlocked ? 0.7 : 0.25 }));
      ringM.position.copy(to);
      ringM.rotation.x = Math.PI / 2;
      ringM.userData.spin = true;
      this.scene.add(ringM);
      this.addLabel({ text: `${realm.n}. ${realm.title}`, pos: to, kind: 'realm', id: realm.id, state: mesh.userData.state });
    });

    // HEAD marker
    if (this.headPos) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.8, 16), new THREE.MeshStandardMaterial({ color: C.accent, emissive: C.accent, emissiveIntensity: 0.7 }));
      cone.rotation.x = Math.PI;
      this.head = cone;
      this.scene.add(cone);
    }
  }

  addLabel({ text, pos, kind, id = null, realm = null, state = 'open', current = false }) {
    const el = h('button', {
      class: `hub-label is-${kind}` + (state === 'locked' ? ' is-locked' : state === 'done' ? ' is-done' : '') + (current ? ' is-current' : ''),
      type: 'button', tabindex: kind === 'lesson' ? '-1' : '0',
      onclick: () => {
        if (kind === 'realm') { this.focus(id, true); }
        else if (kind === 'lesson') this.onLesson(id);
      },
    }, current ? `YOU → ${text}` : text);
    this.labelLayer.append(el);
    this.labels.push({ el, pos: pos.clone(), kind, realm, id });
  }

  focus(realmId, announce = true, r = 24) {
    const i = curriculum.realms.findIndex(x => x.id === realmId);
    if (i < 0) return;
    this.focused = realmId;
    const p = this.realmPos[i].clone();
    const prev = i > 0 ? this.realmPos[i - 1] : this.origin;
    this.goalTarget = p.clone().lerp(prev, 0.45).add(new THREE.Vector3(0, 1.5, 0));
    this.goalR = r;
    if (announce) this.onRealm?.(realmId);
  }

  bind() {
    const el = this.renderer.domElement;
    let down = null, moved = false;
    const pointers = new Map();
    let pinch = null;
    this.onDown = (e) => {
      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = { x: e.clientX, y: e.clientY, theta: this.sph.theta, phi: this.sph.phi };
      moved = false;
      this.lastInteract = performance.now();
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), r: this.goalR }; }
    };
    this.onMove = (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.goalR = Math.max(8, Math.min(80, pinch.r * pinch.d / Math.max(1, d)));
        moved = true;
        return;
      }
      if (!down) { this.hover(e); return; }
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      this.sph.theta = down.theta - dx * 0.006;
      this.sph.phi = Math.max(0.25, Math.min(1.45, down.phi - dy * 0.005));
      this.lastInteract = performance.now();
    };
    this.onUp = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (down && !moved) this.click(e);
      down = null;
    };
    this.onWheel = (e) => {
      e.preventDefault();
      this.goalR = Math.max(8, Math.min(80, this.goalR * (1 + Math.sign(e.deltaY) * 0.1)));
      this.lastInteract = performance.now();
    };
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';
  }

  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(v, this.camera);
    const hit = rc.intersectObjects(this.nodes)[0];
    return hit?.object || null;
  }

  hover(e) {
    const o = this.pick(e);
    this.renderer.domElement.style.cursor = o ? 'pointer' : 'grab';
  }

  click(e) {
    const o = this.pick(e);
    if (!o) return;
    if (o.userData.kind === 'realm') this.focus(o.userData.id, true);
    else if (o.userData.kind === 'lesson') this.onLesson(o.userData.id);
  }

  resize() {
    const w = this.stage.clientWidth || 600, hgt = this.stage.clientHeight || 400;
    this.renderer.setSize(w, hgt, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = hgt + 'px';
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const t = (performance.now() - this.t0) / 1000;
    const idle = !this.lastInteract || performance.now() - this.lastInteract > 4000;
    if (idle && !this.reduced) this.sph.theta += 0.0007;
    this.target.lerp(this.goalTarget, 0.06);
    this.sph.r += (this.goalR - this.sph.r) * 0.08;
    const { theta, phi, r } = this.sph;
    this.camera.position.set(this.target.x + r * Math.sin(phi) * Math.sin(theta), this.target.y + r * Math.cos(phi), this.target.z + r * Math.sin(phi) * Math.cos(theta));
    this.camera.lookAt(this.target);
    if (this.head && this.headPos) { this.head.position.set(this.headPos.x, this.headPos.y + 1.1 + (this.reduced ? 0 : Math.sin(t * 2.2) * 0.15), this.headPos.z); this.head.rotation.y = t; }
    this.scene.traverse(o => { if (o.userData?.spin && !this.reduced) o.rotation.z = t * 0.3; if (o.userData?.core && !this.reduced) { o.rotation.y = t * 0.4; o.rotation.x = t * 0.15; } });
    this.renderer.render(this.scene, this.camera);
    // labels
    const w = this.stage.clientWidth, hgt = this.stage.clientHeight;
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      v.copy(l.pos).project(this.camera);
      const visible = v.z < 1 && (l.kind !== 'lesson' || l.realm === this.focused || l.el.classList.contains('is-current'));
      if (l.kind === 'phase') { l.el.style.pointerEvents = 'none'; }
      const dist = this.camera.position.distanceTo(l.pos);
      if (!visible || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { l.el.style.display = 'none'; continue; }
      if (l.kind === 'lesson' && dist > 34 && !l.el.classList.contains('is-current')) { l.el.style.display = 'none'; continue; }
      l.el.style.display = '';
      l.el.style.left = `${(v.x + 1) / 2 * w}px`;
      l.el.style.top = `${(1 - v.y) / 2 * hgt}px`;
      l.el.style.opacity = String(Math.max(0.35, Math.min(1, 1.6 - dist / 60)));
      l.el.style.zIndex = String(Math.round(1000 - dist * 10));
    }
  }

  retheme() {
    // rebuild the scene with the new palette
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
    this.labels.forEach(l => l.el.remove());
    this.labels = []; this.nodes = [];
    this.build();
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.themeObs?.disconnect();
    this.mq?.removeEventListener?.('change', this.mqFn);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.renderer.dispose();
  }
}

// Lab helpers and checks for the Containers realm.

import { registerLabExtension } from '../labext.js';
import { engineOf, findContainer, createContainer, startContainer } from './docker.js';
import { installPkg } from './packages.js';
import { parseRef, dockerBuild, shortId } from './docker-images.js';

registerLabExtension({
  helpers: (uni, sh, H) => ({
    // install Docker on a machine and let a user use it without sudo
    docker(on = 'laptop', user) {
      const host = typeof on === 'string' ? uni.host(on) : on;
      installPkg(host, uni, 'docker.io', []);
      host.addToGroup(user || host.defaultUser, 'docker');
      return engineOf(host, uni);
    },
    pull(on, ...refs) { const eng = engineOf(uni.host(on), uni); for (const r of refs) if (!eng.findImage(r)) eng.pullImage(r, { quiet: true }); },
    // run a container during setup: H.container('laptop', 'nginx', { name, ports: [{host, container}] })
    container(on, ref, opts = {}) {
      const eng = engineOf(uni.host(on), uni);
      const img = eng.findImage(ref) || eng.pullImage(ref, { quiet: true });
      const c = createContainer(eng, img, opts);
      startContainer(eng, c);
      return c;
    },
    // build an image off-screen and put it in the registry, as if a team had pushed it
    publishImage(ref, files, { private: priv = false } = {}) {
      let b = uni.host('image-builder');
      if (!b) { b = uni.addHost('image-builder', { kind: 'vm' }); b.hidden = true; }
      const eng = engineOf(b, uni);
      const dir = '/build/' + parseRef(ref).repo.replace(/\W/g, '_') + '_' + parseRef(ref).tag.replace(/\W/g, '_');
      b.mkdirMeta(dir, 'root');
      for (const [p, t] of Object.entries(files)) { b.mkdirMeta(dir + '/' + p.split('/').slice(0, -1).join('/'), 'root'); b.writeFile(dir + '/' + p, t, 'root'); }
      const r = dockerBuild(eng, { contextDir: dir, tags: [ref] });
      if (!r.ok) throw new Error(`publishImage ${ref}: ${r.error}\n${r.log.join('\n')}`);
      uni.registry.set(parseRef(ref).short, { image: { ...r.image, tags: undefined }, digest: 'sha256:' + shortId(), private: priv, pushed: uni.time });
      return r.image;
    },
    registryCreds(server, user, password) { uni.registryAuth = { ...(uni.registryAuth || {}), [server]: { user, password } }; },
  }),
  checks: (uni, sh, api) => {
    const eng = on => { const hh = api.host(on); return hh.docker || null; };
    return {
      engine: eng,
      container: (on, ref) => { const e = eng(on); return e ? findContainer(e, ref) : null; },
      containers: (on, pred = () => true) => { const e = eng(on); return e ? [...e.containers.values()].filter(pred) : []; },
      running: (on, pred = () => true) => { const e = eng(on); return e ? [...e.containers.values()].filter(c => c.status === 'running' && pred(c)) : []; },
      image: (on, ref) => eng(on)?.findImage(ref) || null,
      images: on => { const e = eng(on); return e ? [...e.images.values()] : []; },
      volume: (on, name) => eng(on)?.volumes.get(name) || null,
      network: (on, name) => eng(on)?.networks.get(name) || null,
      pushed: ref => uni.registry.lookup(parseRef(ref)),
      // run a command inside a running container, quietly
      inContainer(on, ref, cmd) {
        const c = findContainer(eng(on), ref);
        if (!c || c.status !== 'running') return { code: 1, out: '' };
        return api.exec(c.h, cmd, { user: 'root' });
      },
    };
  },
});
